-- 0108: follow-up cadence (P4) vidí odpověď zákazníka a datum akce i v Gmailu.
--
-- Nález integračního testu celého toku (test/integration-flow-pglite.test.ts):
--   1) follow_up_facts.last_inbound_at četla jen mail_event. Ten plní jen
--      synchronizace Outlooku (MS_GRAPH_ENABLED); pošta klienta je ale Gmail,
--      takže odpověď zákazníka na nabídku cadence nikdy neviděla a připomínka
--      by odešla i člověku, který už odpověděl.
--   2) follow_up_facts.event_date četla jen web_inquiry. U poptávky z e-mailu
--      datum akce nebylo nikde uložené, šablona připomínky ({datum}) se nedala
--      vyplnit a e-mailové obchody připomínku nedostaly nikdy (a nefungovalo
--      ani pravidlo „akce už proběhla").
--
-- Oprava:
--   - inquiry_agent_run.event_date (datum akce z vytěžení; jen datum, žádný
--     osobní údaj) a inquiry_agent_finish ho zapisuje (p.event_date);
--   - follow_up_facts: příchozí zpráva = i řádek fronty agenta poptávek
--     navázaný na obchod (zákazník napsal znovu) NEBO ve vlákně, kterým
--     odešla zpráva odchozí fronty k obchodu (stejná schránka) — tedy i
--     odpověď, kterou model vyhodnotil jako „ne-poptávku"; navíc nová webová
--     poptávka k obchodu. Datum akce: web, jinak e-mail (agent poptávek).
--
-- Opakovaný běh je bezpečný (IF NOT EXISTS, OR REPLACE se stejným podpisem).

DO $$
BEGIN
  IF to_regclass('public.inquiry_agent_run') IS NULL OR to_regclass('public.agent_outbox') IS NULL
     OR to_regprocedure('public.follow_up_facts(bigint[])') IS NULL THEN
    RAISE EXCEPTION '0108 vyžaduje 0103 (inquiry_agent_run), 0104 (agent_outbox) a 0105 (follow_up_facts)';
  END IF;
END $$;

ALTER TABLE inquiry_agent_run ADD COLUMN IF NOT EXISTS event_date date;
COMMENT ON COLUMN inquiry_agent_run.event_date IS
  'Datum akce z vytěžení e-mailu (0108). Pro šablonu a stop pravidla follow-up cadence (follow_up_facts).';

CREATE INDEX IF NOT EXISTS inquiry_agent_run_thread_idx ON inquiry_agent_run (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_outbox_sent_thread_idx ON agent_outbox (deal_id, sent_thread_id) WHERE sent_thread_id IS NOT NULL;

-- Stejné jako 0103 + event_date.
CREATE OR REPLACE FUNCTION inquiry_agent_finish(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id      bigint := (p ->> 'run_id')::bigint;
  v_status  text := p ->> 'status';
  v_model   boolean := coalesce((p ->> 'model_called')::boolean, false);
  v_codes   text[] := '{}';
  v_date    date;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'inquiry_agent_finish: jen service_role' USING ERRCODE = '42501';
  END IF;
  IF v_id IS NULL OR v_status IS NULL THEN
    RAISE EXCEPTION 'inquiry_agent_finish: chybí run_id nebo status' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p -> 'reason_codes') = 'array' THEN
    SELECT coalesce(array_agg(left(c, 60)), '{}') INTO v_codes FROM jsonb_array_elements_text(p -> 'reason_codes') AS c;
  END IF;
  -- Datum akce: jen platné YYYY-MM-DD, jinak NULL (výstup modelu se nehádá).
  IF coalesce(p ->> 'event_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN
    BEGIN
      v_date := (p ->> 'event_date')::date;
    EXCEPTION WHEN others THEN
      v_date := NULL;
    END;
  END IF;

  UPDATE inquiry_agent_run
     SET status = v_status,
         decision_kind = coalesce(p ->> 'decision_kind', decision_kind),
         reason_codes = CASE WHEN p ? 'reason_codes' THEN v_codes ELSE reason_codes END,
         segment = CASE WHEN p ? 'segment' THEN nullif(p ->> 'segment', '') ELSE segment END,
         event_date = CASE WHEN p ? 'event_date' THEN v_date ELSE event_date END,
         quote_total = CASE WHEN p ? 'quote_total' THEN (p ->> 'quote_total')::numeric ELSE quote_total END,
         price_map_version = CASE WHEN p ? 'price_map_version' THEN p ->> 'price_map_version' ELSE price_map_version END,
         scope_version_id = CASE WHEN p ? 'scope_version_id' THEN (p ->> 'scope_version_id')::bigint ELSE scope_version_id END,
         decided_at = CASE WHEN v_status IN ('decided', 'enqueued', 'skipped') THEN coalesce(decided_at, now()) ELSE decided_at END,
         error_code = CASE WHEN p ? 'error_code' THEN nullif(p ->> 'error_code', '') ELSE error_code END,
         next_attempt_at = CASE
           WHEN p ? 'retry_after_seconds' THEN now() + make_interval(secs => greatest((p ->> 'retry_after_seconds')::integer, 0))
           ELSE next_attempt_at END,
         model_calls = model_calls + CASE WHEN v_model THEN 1 ELSE 0 END,
         model_called_at = CASE WHEN v_model THEN now() ELSE model_called_at END,
         reply_draft = CASE WHEN jsonb_typeof(p -> 'reply_draft') = 'object' THEN p -> 'reply_draft'
                            WHEN p ? 'reply_draft' THEN NULL ELSE reply_draft END,
         outbox_id = CASE WHEN p ? 'outbox_id' THEN (p ->> 'outbox_id')::bigint ELSE outbox_id END,
         claimed_at = NULL
   WHERE id = v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inquiry_agent_finish: běh % neexistuje', v_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Stejný podpis jako 0105; mění se jen last_inbound_at a event_date.
CREATE OR REPLACE FUNCTION follow_up_facts(p_deal_ids bigint[])
RETURNS TABLE (
  deal_id                 bigint,
  last_inbound_at         timestamptz,
  last_outbound_at        timestamptz,
  last_human_activity_at  timestamptz,
  offer_sent_at           timestamptz,
  contact_do_not_contact  boolean,
  account_contacts        integer,
  account_opted_out       integer,
  event_date              date
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    d.id,
    GREATEST(
      -- Outlook (MS Graph) synchronizace pošty.
      (SELECT max(m.occurred_at) FROM mail_event m
        WHERE m.direction = 'inbound'
          AND ((d.account_id IS NOT NULL AND m.account_id = d.account_id)
            OR (d.primary_contact_id IS NOT NULL AND m.contact_id = d.primary_contact_id))),
      -- Gmail: zpráva zákazníka ve frontě agenta poptávek navázaná na obchod.
      (SELECT max(r.received_at) FROM inquiry_agent_run r WHERE r.deal_id = d.id),
      -- Gmail: odpověď ve vlákně, kterým odešla zpráva k obchodu (stejná schránka),
      -- i když ji model nevyhodnotil jako poptávku.
      (SELECT max(r.received_at)
         FROM agent_outbox o
         JOIN team_member tm ON tm.id = o.mailbox_member_id
         JOIN inquiry_agent_run r ON r.thread_id = o.sent_thread_id AND lower(r.mailbox) = lower(tm.email)
        WHERE o.deal_id = d.id AND o.sent_thread_id IS NOT NULL),
      -- Nová webová poptávka k témuž obchodu.
      (SELECT max(w.received_at) FROM web_inquiry w WHERE w.deal_id = d.id)
    ),
    (SELECT max(m.occurred_at) FROM mail_event m
      WHERE m.direction = 'outbound'
        AND ((d.account_id IS NOT NULL AND m.account_id = d.account_id)
          OR (d.primary_contact_id IS NOT NULL AND m.contact_id = d.primary_contact_id))),
    (SELECT max(GREATEST(a.occurred_at, a.created_at)) FROM sales_activity a
      WHERE a.deal_id = d.id AND a.created_by IS NOT NULL),
    (SELECT max(v.sent_at) FROM deal_scope_version v WHERE v.deal_id = d.id),
    (SELECT c.do_not_contact FROM contact c WHERE c.id = d.primary_contact_id),
    (SELECT count(*)::int FROM contact c WHERE d.account_id IS NOT NULL AND c.account_id = d.account_id),
    (SELECT count(*)::int FROM contact c WHERE d.account_id IS NOT NULL AND c.account_id = d.account_id AND c.do_not_contact),
    coalesce(
      (SELECT w.event_date FROM web_inquiry w
        WHERE w.deal_id = d.id AND w.event_date IS NOT NULL
        ORDER BY w.received_at DESC LIMIT 1),
      (SELECT r.event_date FROM inquiry_agent_run r
        WHERE r.deal_id = d.id AND r.event_date IS NOT NULL
        ORDER BY r.received_at DESC LIMIT 1)
    )
  FROM deal d
  WHERE d.id = ANY (p_deal_ids);
$$;

COMMENT ON FUNCTION follow_up_facts(bigint[]) IS
  'Fakta pro stop pravidla follow-up cadence (0105, 0108): poslední příchozí pošta (Outlook mail_event i Gmail přes frontu agenta poptávek a vlákna odchozí fronty), odchozí pošta, ruční aktivita, odeslaná nabídka, nesouhlas s oslovením, datum akce (web i e-mail). Jen service_role.';

REVOKE ALL ON FUNCTION inquiry_agent_finish(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION follow_up_facts(bigint[]) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION inquiry_agent_finish(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION follow_up_facts(bigint[]) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0108', 'follow_up_facts: odpověď zákazníka a datum akce i z Gmailu (inquiry_agent_run.event_date, vlákna agent_outbox); inquiry_agent_finish zapisuje event_date')
ON CONFLICT (version) DO NOTHING;
