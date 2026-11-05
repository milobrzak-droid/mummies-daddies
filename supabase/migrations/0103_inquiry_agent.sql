-- 0103 — inquiry_agent: příchozí poptávky (e-mail přes Gmail a webový
-- formulář) → fronta agenta → zápis leadu do CRM → odpověď přes odchozí
-- frontu (P3) nebo eskalace obchodu. Balík P2.
--
-- PROČ: poptávka nesmí zapadnout ani se zdvojit. E-mail, který přijde do
-- schránky vedení nebo obchodu (i přes sdílenou adresu info@ / poptavky@),
-- se zachytí jako řádek fronty inquiry_agent_run (jen identifikátory, nikdy
-- obsah). Úloha inquiry-agent (domain/crm/inquiryAgentService.ts) si řádek
-- vezme, tělo zprávy přečte z Gmailu JEN v paměti, model vytěží parametry,
-- kód spočítá nabídku z mapy a výsledek zapíše jedinou transakcí
-- inquiry_agent_found: klient, kontakt, obchod ve fázi 'poptavka', aktivita,
-- úkol (u eskalace) a koncept verze nabídky. Poptávka z webu (web_inquiry,
-- 0102) jde stejnou funkcí, jen bez modelu.
--
-- CO JE V MIGRACI
--   1) contact.is_vip — kontakt, kterému agent nikdy sám neodpoví.
--   2) deal.source — odkud lead přišel ('email', 'web', …) kvůli reportingu.
--   3) inquiry_agent_run — fronta, ledger a idempotence (UNIQUE Message-ID).
--      Stavy pending → processing → decided | enqueued | failed | skipped.
--      reply_draft drží vygenerovanou odpověď jen do zápisu do odchozí
--      fronty (P3); pak se maže. Retence 90 dní (inquiry_agent_purge).
--   4) RPC (EXECUTE jen service_role):
--        inquiry_agent_enqueue(p)     → {run_id, duplicate}
--        inquiry_agent_claim(limit)   → řádky k zpracování (FOR UPDATE SKIP LOCKED)
--        inquiry_agent_finish(p)      → zapíše rozhodnutí / opakování
--        inquiry_agent_found(p)       → CRM zápis v jedné transakci
--        web_inquiry_claim(limit)     → webové poptávky 'new' → 'processing'
--        web_inquiry_finish(p)        → rozhodnutí u web_inquiry
--        inquiry_agent_purge(days)    → retence fronty
--
-- OSOBNÍ ÚDAJE: fronta nenese adresu zákazníka, jméno, předmět ani tělo
-- zprávy. Jméno a e-mail zákazníka se zapíšou jen do contact (jako by je
-- opsal člověk). Audit fronty nese jen id, stavy, data a počty.
--
-- VIDITELNOST: RLS jako auto_intake (0081): čte tým s obchodní rolí a AAL2,
-- zapisuje jen service_role přes RPC.

DO $$
BEGIN
  IF to_regclass('public.web_inquiry') IS NULL THEN
    RAISE EXCEPTION '0103 vyžaduje tabulku web_inquiry — nejdřív aplikujte 0102_web_intake.sql';
  END IF;
  IF to_regclass('public.case_proposal') IS NULL OR to_regclass('public.deal_scope_version') IS NULL THEN
    RAISE EXCEPTION '0103 vyžaduje case_proposal (0067) a deal_scope_version (0072)';
  END IF;
  IF to_regprocedure('public.audit_row_change()') IS NULL THEN
    RAISE EXCEPTION '0103 vyžaduje audit_row_change() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0103 vyžaduje can_see_sales() a is_team_member() — nejdřív aplikujte 0020 a 0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'contact' AND column_name = 'do_not_contact') THEN
    RAISE EXCEPTION '0103 vyžaduje contact.do_not_contact — nejdřív aplikujte 0087_contact_opt_out.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) VIP kontakt a zdroj obchodu
-- ===========================================================================

ALTER TABLE contact ADD COLUMN IF NOT EXISTS is_vip boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN contact.is_vip IS
  'Citlivý / VIP kontakt (0103): agent mu nikdy sám neodpoví, poptávka jde vždy na posouzení obchodu.';

ALTER TABLE deal ADD COLUMN IF NOT EXISTS source text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_source_check') THEN
    ALTER TABLE deal ADD CONSTRAINT deal_source_check CHECK (source IS NULL OR source ~ '^[a-z][a-z0-9_]{0,39}$');
  END IF;
END $$;
COMMENT ON COLUMN deal.source IS 'Odkud lead přišel (0103): email, web, … NULL = založeno ručně nebo dřív.';

-- ===========================================================================
-- 2) Fronta agenta
-- ===========================================================================

CREATE TABLE IF NOT EXISTS inquiry_agent_run (
  id                   bigserial PRIMARY KEY,
  -- RFC 5322 Message-ID: klíč idempotence (stejná zpráva ve dvou schránkách = jeden řádek).
  internet_message_id  text NOT NULL,
  -- Id zprávy v poštovním systému schránky (Gmail message id). Název sloupce je z kontraktu.
  graph_message_id     text NOT NULL,
  thread_id            text,
  -- Schránka, ze které se zpráva čte (firemní adresa, ne zákazník).
  mailbox              text NOT NULL,
  -- Člen týmu, kterému schránka patří (u sdílené schránky vlastník leadu).
  mailbox_member_id    uuid REFERENCES team_member(id) ON DELETE SET NULL,
  received_at          timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'pending',
  decision_kind        text,
  reason_codes         text[] NOT NULL DEFAULT '{}',
  segment              text,
  account_id           bigint REFERENCES account(id) ON DELETE SET NULL,
  contact_id           bigint REFERENCES contact(id) ON DELETE SET NULL,
  deal_id              bigint REFERENCES deal(id) ON DELETE SET NULL,
  scope_version_id     bigint REFERENCES deal_scope_version(id) ON DELETE SET NULL,
  quote_total          numeric(14, 2),
  price_map_version    text,
  decided_at           timestamptz,
  attempts             integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at           timestamptz,
  model_calls          integer NOT NULL DEFAULT 0,
  model_called_at      timestamptz,
  error_code           text,
  -- Vygenerovaná odpověď (OutboxEnqueue bez identifikátorů), dokud ji nepřijme
  -- agent_outbox_enqueue (P3). Po zápisu do fronty NULL.
  reply_draft          jsonb,
  -- Id řádku odchozí fronty (P3) po úspěšném agent_outbox_enqueue.
  outbox_id            bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inquiry_agent_run_message_key UNIQUE (internet_message_id),
  CONSTRAINT inquiry_agent_run_status_check
    CHECK (status IN ('pending', 'processing', 'decided', 'enqueued', 'failed', 'skipped')),
  CONSTRAINT inquiry_agent_run_decision_check
    CHECK (decision_kind IS NULL OR decision_kind IN ('send_offer', 'ask_info', 'escalate', 'not_inquiry')),
  CONSTRAINT inquiry_agent_run_len_check CHECK (
    char_length(internet_message_id) BETWEEN 1 AND 700
    AND char_length(graph_message_id) BETWEEN 1 AND 128
    AND (thread_id IS NULL OR char_length(thread_id) <= 128)
    AND char_length(mailbox) BETWEEN 3 AND 254
    AND (segment IS NULL OR char_length(segment) <= 40)
    AND (price_map_version IS NULL OR char_length(price_map_version) <= 60)
    AND (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$')
    AND cardinality(reason_codes) <= 30
  ),
  CONSTRAINT inquiry_agent_run_counts_check CHECK (attempts >= 0 AND model_calls >= 0),
  CONSTRAINT inquiry_agent_run_reply_draft_check
    CHECK (reply_draft IS NULL OR (jsonb_typeof(reply_draft) = 'object' AND pg_column_size(reply_draft) <= 32768))
);

CREATE INDEX IF NOT EXISTS inquiry_agent_run_queue_idx ON inquiry_agent_run (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS inquiry_agent_run_gmail_idx ON inquiry_agent_run (mailbox, graph_message_id);
CREATE INDEX IF NOT EXISTS inquiry_agent_run_model_idx ON inquiry_agent_run (model_called_at) WHERE model_called_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiry_agent_run_account_idx ON inquiry_agent_run (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiry_agent_run_contact_idx ON inquiry_agent_run (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiry_agent_run_deal_idx ON inquiry_agent_run (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiry_agent_run_scope_idx ON inquiry_agent_run (scope_version_id) WHERE scope_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiry_agent_run_member_idx ON inquiry_agent_run (mailbox_member_id) WHERE mailbox_member_id IS NOT NULL;

COMMENT ON TABLE inquiry_agent_run IS
  'Fronta agenta příchozích poptávek (0103): jen identifikátory zprávy a rozhodnutí, nikdy obsah e-mailu. Zapisuje jen service_role přes RPC.';

DROP TRIGGER IF EXISTS inquiry_agent_run_set_updated_at ON inquiry_agent_run;
CREATE TRIGGER inquiry_agent_run_set_updated_at BEFORE UPDATE ON inquiry_agent_run
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE inquiry_agent_run ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inquiry_agent_run_read ON inquiry_agent_run;
CREATE POLICY inquiry_agent_run_read ON inquiry_agent_run
  FOR SELECT USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS sales_only ON inquiry_agent_run;
CREATE POLICY sales_only ON inquiry_agent_run
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

DROP POLICY IF EXISTS require_aal2 ON inquiry_agent_run;
CREATE POLICY require_aal2 ON inquiry_agent_run
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON inquiry_agent_run FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON inquiry_agent_run FROM authenticated;
GRANT SELECT ON inquiry_agent_run TO authenticated;
GRANT ALL ON inquiry_agent_run TO service_role;
GRANT USAGE ON SEQUENCE inquiry_agent_run_id_seq TO service_role;

-- Audit (0064): jen id, stavy, data a počty. MUSÍ sedět s core/auditCoverage.agent.ts.
DROP TRIGGER IF EXISTS audit_row_change ON inquiry_agent_run;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON inquiry_agent_run
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,attempts,contact_id,deal_id,decided_at,decision_kind,mailbox_member_id,model_calls,outbox_id,received_at,scope_version_id,status',
    'claimed_at,model_called_at,next_attempt_at',
    '');

-- ===========================================================================
-- 3) Fronta: zařazení, převzetí, dokončení, retence
-- ===========================================================================

CREATE OR REPLACE FUNCTION inquiry_agent_enqueue(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mid  text := left(nullif(btrim(p ->> 'internet_message_id'), ''), 700);
  v_gid  text := nullif(btrim(p ->> 'graph_message_id'), '');
  v_id   bigint;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'inquiry_agent_enqueue: jen service_role' USING ERRCODE = '42501';
  END IF;
  IF v_mid IS NULL OR v_gid IS NULL OR nullif(btrim(p ->> 'mailbox'), '') IS NULL OR p ->> 'received_at' IS NULL THEN
    RAISE EXCEPTION 'inquiry_agent_enqueue: chybí internet_message_id, graph_message_id, mailbox nebo received_at' USING ERRCODE = '22023';
  END IF;

  INSERT INTO inquiry_agent_run (internet_message_id, graph_message_id, thread_id, mailbox, mailbox_member_id, received_at)
  VALUES (
    v_mid, left(v_gid, 128), left(nullif(btrim(p ->> 'thread_id'), ''), 128),
    lower(btrim(p ->> 'mailbox')), (p ->> 'mailbox_member_id')::uuid, (p ->> 'received_at')::timestamptz
  )
  ON CONFLICT (internet_message_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM inquiry_agent_run WHERE internet_message_id = v_mid;
    RETURN jsonb_build_object('run_id', v_id, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('run_id', v_id, 'duplicate', false);
END $$;

-- Převezme nejvýš p_limit řádků k zpracování. Řádek, který visí ve stavu
-- 'processing' déle než p_stale_minutes (spadlý běh), se vrátí do fronty:
-- všechny kroky po něm jsou idempotentní (CRM podle Message-ID, odchozí
-- fronta podle source_ref). Vrací i řádky 'decided' s nevyřízenou odpovědí
-- (reply_draft) — čekají, až bude odchozí fronta (P3) k dispozici.
CREATE OR REPLACE FUNCTION inquiry_agent_claim(p_limit integer, p_stale_minutes integer DEFAULT 15)
RETURNS SETOF inquiry_agent_run
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'inquiry_agent_claim: jen service_role' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'inquiry_agent_claim: limit 1–200' USING ERRCODE = '22023';
  END IF;

  UPDATE inquiry_agent_run
     SET status = 'pending', claimed_at = NULL
   WHERE status = 'processing' AND claimed_at < now() - make_interval(mins => greatest(p_stale_minutes, 1));

  RETURN QUERY
  UPDATE inquiry_agent_run r
     SET status = CASE WHEN r.status = 'pending' THEN 'processing' ELSE r.status END,
         claimed_at = now(),
         attempts = CASE WHEN r.status = 'pending' THEN r.attempts + 1 ELSE r.attempts END
   WHERE r.id IN (
     SELECT q.id FROM inquiry_agent_run q
      WHERE q.next_attempt_at <= now()
        AND (q.status = 'pending' OR (q.status = 'decided' AND q.reply_draft IS NOT NULL))
      ORDER BY q.received_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING r.*;
END $$;

-- Zapíše výsledek zpracování. p: run_id, status, decision_kind, reason_codes,
-- segment, quote_total, price_map_version, scope_version_id, error_code,
-- retry_after_seconds, model_called (bool), reply_draft (objekt | null), outbox_id.
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

  UPDATE inquiry_agent_run
     SET status = v_status,
         decision_kind = coalesce(p ->> 'decision_kind', decision_kind),
         reason_codes = CASE WHEN p ? 'reason_codes' THEN v_codes ELSE reason_codes END,
         segment = CASE WHEN p ? 'segment' THEN nullif(p ->> 'segment', '') ELSE segment END,
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

-- Retence: hotové řádky fronty po p_days dnech pryč (CRM zápisy zůstávají).
-- Nevyřízená odpověď (reply_draft) nesmí ležet věčně: po stejné lhůtě se zahodí.
CREATE OR REPLACE FUNCTION inquiry_agent_purge(p_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'inquiry_agent_purge: jen service_role' USING ERRCODE = '42501';
  END IF;
  UPDATE inquiry_agent_run SET reply_draft = NULL, error_code = 'reply_expired'
   WHERE reply_draft IS NOT NULL AND updated_at < now() - make_interval(days => greatest(p_days, 30));
  DELETE FROM inquiry_agent_run
   WHERE status IN ('enqueued', 'failed', 'skipped', 'decided')
     AND reply_draft IS NULL
     AND coalesce(decided_at, updated_at) < now() - make_interval(days => greatest(p_days, 30));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ===========================================================================
-- 4) Webové poptávky (0102): převzetí a rozhodnutí
-- ===========================================================================

CREATE OR REPLACE FUNCTION web_inquiry_claim(p_limit integer, p_stale_minutes integer DEFAULT 15)
RETURNS SETOF web_inquiry
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'web_inquiry_claim: jen service_role' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'web_inquiry_claim: limit 1–200' USING ERRCODE = '22023';
  END IF;

  UPDATE web_inquiry SET status = 'new'
   WHERE status = 'processing' AND updated_at < now() - make_interval(mins => greatest(p_stale_minutes, 1));

  RETURN QUERY
  UPDATE web_inquiry w
     SET status = 'processing', attempts = w.attempts + 1
   WHERE w.id IN (
     SELECT q.id FROM web_inquiry q
      WHERE q.status = 'new'
      ORDER BY q.received_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING w.*;
END $$;

-- p: web_inquiry_id, status ('decided' | 'failed' | 'spam' | 'new' = zkusit znovu),
-- decision_kind, reason_codes, quote_total, price_map_version, error_code.
CREATE OR REPLACE FUNCTION web_inquiry_finish(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id     bigint := (p ->> 'web_inquiry_id')::bigint;
  v_status text := p ->> 'status';
  v_codes  text[] := '{}';
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'web_inquiry_finish: jen service_role' USING ERRCODE = '42501';
  END IF;
  IF v_id IS NULL OR v_status IS NULL THEN
    RAISE EXCEPTION 'web_inquiry_finish: chybí web_inquiry_id nebo status' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p -> 'reason_codes') = 'array' THEN
    SELECT coalesce(array_agg(left(c, 60)), '{}') INTO v_codes FROM jsonb_array_elements_text(p -> 'reason_codes') AS c;
  END IF;
  UPDATE web_inquiry
     SET status = v_status,
         decision_kind = coalesce(p ->> 'decision_kind', decision_kind),
         reason_codes = CASE WHEN p ? 'reason_codes' THEN v_codes ELSE reason_codes END,
         quote_total = CASE WHEN p ? 'quote_total' THEN (p ->> 'quote_total')::numeric ELSE quote_total END,
         price_map_version = CASE WHEN p ? 'price_map_version' THEN p ->> 'price_map_version' ELSE price_map_version END,
         decided_at = CASE WHEN v_status = 'decided' THEN coalesce(decided_at, now()) ELSE decided_at END,
         error_code = CASE WHEN p ? 'error_code' THEN left(nullif(p ->> 'error_code', ''), 64) ELSE error_code END
   WHERE id = v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'web_inquiry_finish: poptávka % neexistuje', v_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- ===========================================================================
-- 5) Zápis leadu do CRM (jedna transakce)
-- ===========================================================================
--
-- Vstup p (texty skládá aplikace, tady se ověří tvar a vloží):
--   source            'email' | 'web'
--   source_key        Message-ID (e-mail) nebo 'web:<id>' — idempotence
--                     přes sales_activity (source 'agent:inquiry', external_id)
--   run_id | web_inquiry_id   řádek, kterému se doplní vazby
--   occurred_at, owner_id (vlastník leadu), dedup_days (0–60)
--   email, person_name                       kontakt (povinné)
--   company {name, domain, ico} | null        firma (B2B); null = soukromá osoba
--   deal {title, pillar, revenue_line, revenue_category, next_step, next_step_due, note, amount}
--   activity {subject}
--   task {title, due_on, priority} | null      úkol vlastníkovi (eskalace)
--   scope {amount, text} | null                koncept verze nabídky
-- Výstup {status, account_id, contact_id, deal_id, activity_id, task_id, scope_version_id}:
--   created     nový obchod (u nového nebo existujícího klienta)
--   reused      kontakt má otevřenou poptávku z posledních dedup_days dní →
--               jen aktivita (a úkol) u ní; volající neodpovídá sám a eskaluje
--   duplicate   tuhle zprávu už jsme zapsali (nic nového)
--   ambiguous   firma vede na víc klientů → nic se nezapíše, rozhodne člověk

CREATE OR REPLACE FUNCTION inquiry_agent_found(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source    text := p ->> 'source';
  v_key       text := nullif(btrim(p ->> 'source_key'), '');
  v_run       bigint := (p ->> 'run_id')::bigint;
  v_web       bigint := (p ->> 'web_inquiry_id')::bigint;
  v_owner     uuid;
  v_occurred  timestamptz;
  v_days      integer := coalesce((p ->> 'dedup_days')::integer, 14);
  v_email     text := lower(nullif(btrim(p ->> 'email'), ''));
  v_person    text := nullif(btrim(p ->> 'person_name'), '');
  v_company   jsonb := CASE WHEN jsonb_typeof(p -> 'company') = 'object' THEN p -> 'company' END;
  v_cname     text;
  v_domain    text;
  v_ico       text;
  v_deal      jsonb := p -> 'deal';
  v_act       jsonb := p -> 'activity';
  v_task      jsonb := CASE WHEN jsonb_typeof(p -> 'task') = 'object' THEN p -> 'task' END;
  v_scope     jsonb := CASE WHEN jsonb_typeof(p -> 'scope') = 'object' THEN p -> 'scope' END;
  v_existing  sales_activity%ROWTYPE;
  v_accs      bigint[];
  v_account   bigint;
  v_contact   bigint;
  v_dealid    bigint;
  v_reused    boolean := false;
  v_taskid    bigint;
  v_activity  bigint;
  v_scopeid   bigint;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'inquiry_agent_found: jen service_role' USING ERRCODE = '42501';
  END IF;

  -- ---- tvar vstupu (chyba = nic se nezapíše)
  IF v_source IS NULL OR v_source NOT IN ('email', 'web') OR v_key IS NULL OR char_length(v_key) > 700 THEN
    RAISE EXCEPTION 'inquiry_agent_found: neplatné source nebo source_key' USING ERRCODE = '22023';
  END IF;
  IF (v_source = 'email' AND v_run IS NULL) OR (v_source = 'web' AND v_web IS NULL) THEN
    RAISE EXCEPTION 'inquiry_agent_found: chybí run_id / web_inquiry_id' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_owner := (p ->> 'owner_id')::uuid;
    v_occurred := (p ->> 'occurred_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'inquiry_agent_found: neplatné owner_id nebo occurred_at' USING ERRCODE = '22023';
  END;
  IF v_owner IS NULL OR v_occurred IS NULL OR v_days < 0 OR v_days > 60 THEN
    RAISE EXCEPTION 'inquiry_agent_found: chybí owner_id, occurred_at nebo dedup_days mimo 0–60' USING ERRCODE = '22023';
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' OR char_length(v_email) > 254
     OR v_person IS NULL THEN
    RAISE EXCEPTION 'inquiry_agent_found: chybí platný email nebo person_name' USING ERRCODE = '22023';
  END IF;
  IF v_deal IS NULL OR nullif(btrim(v_deal ->> 'title'), '') IS NULL OR v_act IS NULL OR nullif(btrim(v_act ->> 'subject'), '') IS NULL THEN
    RAISE EXCEPTION 'inquiry_agent_found: chybí deal.title nebo activity.subject' USING ERRCODE = '22023';
  END IF;
  IF v_company IS NOT NULL THEN
    v_cname := nullif(btrim(v_company ->> 'name'), '');
    v_domain := lower(nullif(btrim(v_company ->> 'domain'), ''));
    v_ico := nullif(regexp_replace(coalesce(v_company ->> 'ico', ''), '\s', '', 'g'), '');
    IF v_cname IS NULL THEN
      RAISE EXCEPTION 'inquiry_agent_found: firma bez názvu' USING ERRCODE = '22023';
    END IF;
    IF v_domain IS NOT NULL AND v_domain !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$' THEN
      RAISE EXCEPTION 'inquiry_agent_found: neplatná doména' USING ERRCODE = '22023';
    END IF;
    IF v_ico IS NOT NULL AND v_ico !~ '^[0-9]{8}$' THEN
      v_ico := NULL;
    END IF;
  END IF;

  -- ---- souběh dvou běhů (cron + ruční): jeden zápis naráz
  PERFORM pg_advisory_xact_lock(hashtextextended('inquiry_agent_found', 0));

  -- ---- idempotence: tuhle zprávu / poptávku už jsme zapsali
  SELECT * INTO v_existing FROM sales_activity WHERE source = 'agent:inquiry' AND external_id = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'account_id', v_existing.account_id, 'contact_id', v_existing.contact_id,
      'deal_id', v_existing.deal_id, 'activity_id', v_existing.id,
      'scope_version_id', (SELECT max(id) FROM deal_scope_version WHERE deal_id = v_existing.deal_id AND status = 'draft'));
  END IF;

  -- ---- kontakt podle e-mailu (nejstarší s klientem)
  SELECT c.id, c.account_id INTO v_contact, v_account
    FROM contact c WHERE lower(c.email) = v_email AND c.account_id IS NOT NULL ORDER BY c.id LIMIT 1;

  IF v_contact IS NOT NULL THEN
    -- Otevřená poptávka téhož kontaktu z posledních dní = stejný lead (přeposlání, web i e-mail).
    SELECT d.id INTO v_dealid FROM deal d
     WHERE d.account_id = v_account AND d.primary_contact_id = v_contact
       AND coalesce(d.phase, 'poptavka') IN ('poptavka', 'nabidka')
       AND d.stage::text NOT IN ('vyhráno', 'prohráno', 'odloženo')
       AND d.created_at > now() - make_interval(days => v_days)
     ORDER BY d.created_at DESC LIMIT 1;
    v_reused := v_dealid IS NOT NULL;
  ELSE
    -- ---- klient: B2B podle IČO, domény (alias, kontakty, web), jinak přesného názvu
    IF v_company IS NOT NULL THEN
      SELECT coalesce(array_agg(DISTINCT k.id), '{}') INTO v_accs FROM (
        SELECT a.id FROM account a WHERE v_ico IS NOT NULL AND a.ico = v_ico
        UNION
        SELECT ca.account_id FROM company_alias ca
         WHERE v_domain IS NOT NULL AND ca.alias_domain IS NOT NULL AND regexp_replace(lower(ca.alias_domain), '^@', '') = v_domain
        UNION
        SELECT c.account_id FROM contact c
         WHERE v_domain IS NOT NULL AND c.account_id IS NOT NULL AND c.email IS NOT NULL AND lower(split_part(c.email, '@', 2)) = v_domain
        UNION
        SELECT a.id FROM account a
         WHERE v_domain IS NOT NULL AND a.web IS NOT NULL
           AND lower(substring(a.web FROM '^(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?(?:www\.)?([^/:?#[:space:]]+)')) = v_domain
      ) k;
      IF cardinality(v_accs) = 0 THEN
        SELECT coalesce(array_agg(a.id), '{}') INTO v_accs FROM account a WHERE lower(btrim(a.name)) = lower(v_cname);
      END IF;
      IF cardinality(v_accs) > 1 THEN
        RETURN jsonb_build_object('status', 'ambiguous', 'account_ids', to_jsonb(v_accs));
      END IF;
      v_account := v_accs[1];
    END IF;

    IF v_account IS NULL THEN
      INSERT INTO account (name, owner_id, ico, notes)
      VALUES (
        left(coalesce(v_cname, v_person), 300), v_owner, v_ico,
        CASE WHEN v_company IS NULL THEN 'Soukromá osoba — založil agent poptávek.' ELSE 'Založil agent poptávek.' END
      ) RETURNING id INTO v_account;
      IF v_domain IS NOT NULL THEN
        INSERT INTO company_alias (account_id, alias_domain) VALUES (v_account, v_domain);
      END IF;
    END IF;

    INSERT INTO contact (account_id, full_name, email)
    VALUES (v_account, left(v_person, 200), left(v_email, 254))
    RETURNING id INTO v_contact;
  END IF;

  -- ---- obchod (nový, nebo navázání na otevřenou poptávku)
  IF NOT v_reused THEN
    INSERT INTO deal (
      account_id, title, revenue_line, revenue_category, stage, pillar, phase, owner_id, primary_contact_id,
      next_step, next_step_due, note, amount_one_time, source
    ) VALUES (
      v_account,
      left(btrim(v_deal ->> 'title'), 300),
      (v_deal ->> 'revenue_line')::revenue_line,
      (v_deal ->> 'revenue_category')::revenue_category,
      'kvalifikace',
      nullif(v_deal ->> 'pillar', ''),
      'poptavka',
      v_owner,
      v_contact,
      nullif(left(v_deal ->> 'next_step', 300), ''),
      (v_deal ->> 'next_step_due')::date,
      nullif(left(v_deal ->> 'note', 2000), ''),
      greatest(coalesce((v_deal ->> 'amount')::numeric, 0), 0),
      v_source
    ) RETURNING id INTO v_dealid;
  END IF;

  INSERT INTO sales_activity (
    account_id, deal_id, contact_id, kind, outcome, subject, occurred_at, follow_up_on, source, external_id
  ) VALUES (
    v_account, v_dealid, v_contact, (CASE WHEN v_source = 'email' THEN 'email' ELSE 'note' END)::sales_activity_kind,
    'completed', left(v_act ->> 'subject', 300), v_occurred, (v_deal ->> 'next_step_due')::date, 'agent:inquiry', v_key
  ) RETURNING id INTO v_activity;

  IF v_task IS NOT NULL AND nullif(btrim(v_task ->> 'title'), '') IS NOT NULL THEN
    INSERT INTO task (title, priority, assignee_id, due_on, account_id, deal_id)
    VALUES (
      left(btrim(v_task ->> 'title'), 300),
      coalesce(nullif(v_task ->> 'priority', ''), 'normal')::task_priority,
      v_owner, (v_task ->> 'due_on')::date, v_account, v_dealid
    ) RETURNING id INTO v_taskid;
  END IF;

  IF v_scope IS NOT NULL AND NOT v_reused THEN
    INSERT INTO deal_scope_version (deal_id, version, scope, amount_one_time, status, created_by)
    VALUES (
      v_dealid,
      coalesce((SELECT max(version) FROM deal_scope_version WHERE deal_id = v_dealid), 0) + 1,
      nullif(left(v_scope ->> 'text', 4000), ''),
      greatest(coalesce((v_scope ->> 'amount')::numeric, 0), 0),
      'draft',
      NULL
    ) RETURNING id INTO v_scopeid;
  END IF;

  IF v_run IS NOT NULL THEN
    UPDATE inquiry_agent_run
       SET account_id = v_account, contact_id = v_contact, deal_id = v_dealid,
           scope_version_id = coalesce(v_scopeid, scope_version_id)
     WHERE id = v_run;
  END IF;
  IF v_web IS NOT NULL THEN
    UPDATE web_inquiry SET account_id = v_account, contact_id = v_contact, deal_id = v_dealid WHERE id = v_web;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_reused THEN 'reused' ELSE 'created' END,
    'account_id', v_account, 'contact_id', v_contact, 'deal_id', v_dealid,
    'activity_id', v_activity, 'task_id', v_taskid, 'scope_version_id', v_scopeid
  );
END $$;

REVOKE ALL ON FUNCTION inquiry_agent_enqueue(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inquiry_agent_claim(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inquiry_agent_finish(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inquiry_agent_purge(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION web_inquiry_claim(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION web_inquiry_finish(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inquiry_agent_found(jsonb) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION inquiry_agent_enqueue(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION inquiry_agent_claim(integer, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION inquiry_agent_finish(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION inquiry_agent_purge(integer) TO service_role;
    GRANT EXECUTE ON FUNCTION web_inquiry_claim(integer, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION web_inquiry_finish(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION inquiry_agent_found(jsonb) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0103', 'inquiry_agent: fronta inquiry_agent_run, contact.is_vip, deal.source, RPC enqueue/claim/finish/found/purge a web_inquiry_claim/finish (jen service_role)')
ON CONFLICT (version) DO NOTHING;
