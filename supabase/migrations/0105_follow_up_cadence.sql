-- 0105 — follow_up_cadence (balík P4): připomínky neodpovězených nabídek.
--
-- PROČ: lead, který na nabídku neodpověděl, dostane podle nastavení firmy
-- (capabilities.followUpCadence v config/) připomínky v pracovních dnech.
-- Rozhoduje čistá funkce domain/crm/followUpCadence.ts, zapisuje úloha
-- 'follow-up-send' (cron /api/cron/follow-ups, za FOLLOWUP_CADENCE_ENABLED).
-- E-mail sám neposílá: zařadí ho do odchozí fronty přes RPC
-- agent_outbox_enqueue (balík P3, source_ref 'followup:<deal_id>:<pořadí>').
--
-- CO ZAKLÁDÁ:
--   follow_up_attempt — jeden řádek na (obchod, pořadí připomínky):
--     planned   = rozhodnuto odeslat, fronta zatím nepřijala (chybí RPC P3,
--                 nebo selhalo volání) — další běh to zkusí znovu se stejným
--                 source_ref (idempotentní),
--     enqueued  = ve frontě agent_outbox (outbox_source_ref, outbox_id),
--     stopped   = cadence u obchodu skončila stop pravidlem (stop_reason),
--     exhausted = vyčerpané pokusy (maxAttempts); řádek s pořadím
--                 maxAttempts + 1 je jen značka „konec cadence".
--   follow_up_facts(deal_ids) — fakta pro stop pravidla bez textu zpráv:
--     poslední příchozí mail_event od firmy nebo kontaktu, poslední ruční
--     aktivita (sales_activity.created_by není null; automatické zápisy agenta
--     jsou bez autora), poslední odeslaná verze nabídky, nesouhlas s oslovením
--     a datum akce z webové poptávky.
--
-- RLS: čte tým s AAL2 a obchodní rolí (can_see_sales), zapisuje jen
-- service_role. Audit měkký (0082): jen id, stavy, data a pořadí — žádný
-- text, e-mail ani jméno. MUSÍ sedět s core/auditCoverage.followup.ts.
--
-- Opakovaný běh je bezpečný (IF NOT EXISTS, DROP … IF EXISTS, OR REPLACE).

DO $$
BEGIN
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0105 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0105 vyžaduje can_see_sales() a is_team_member() — nejdřív aplikujte 0020 a 0082';
  END IF;
  IF to_regclass('public.web_inquiry') IS NULL THEN
    RAISE EXCEPTION '0105 vyžaduje web_inquiry — nejdřív aplikujte 0102_web_intake.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) Pokusy o připomínku
-- ===========================================================================

CREATE TABLE IF NOT EXISTS follow_up_attempt (
  id                bigserial PRIMARY KEY,
  deal_id           bigint NOT NULL REFERENCES deal(id) ON DELETE CASCADE,
  attempt           integer NOT NULL,
  planned_on        date NOT NULL,
  status            text NOT NULL DEFAULT 'planned',
  stop_reason       text,
  template          text,
  -- Bez FK: agent_outbox zakládá balík P3 (0104) a fronta může mít vlastní retenci.
  outbox_id         bigint,
  outbox_source_ref text,
  enqueued_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_attempt_deal_attempt_key UNIQUE (deal_id, attempt),
  CONSTRAINT follow_up_attempt_attempt_check CHECK (attempt BETWEEN 1 AND 100),
  CONSTRAINT follow_up_attempt_status_check CHECK (status IN ('planned', 'enqueued', 'stopped', 'exhausted')),
  -- Kód důvodu, nikdy volný text.
  CONSTRAINT follow_up_attempt_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason ~ '^[a-z_]{1,40}$'),
  CONSTRAINT follow_up_attempt_stop_reason_required CHECK (status NOT IN ('stopped', 'exhausted') OR stop_reason IS NOT NULL),
  CONSTRAINT follow_up_attempt_template_check CHECK (template IS NULL OR template ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT follow_up_attempt_source_ref_check
    CHECK (outbox_source_ref IS NULL OR outbox_source_ref = 'followup:' || deal_id || ':' || attempt),
  CONSTRAINT follow_up_attempt_enqueued_check
    CHECK (status <> 'enqueued' OR (outbox_source_ref IS NOT NULL AND enqueued_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS follow_up_attempt_status_idx ON follow_up_attempt (status, planned_on);
CREATE INDEX IF NOT EXISTS follow_up_attempt_enqueued_idx ON follow_up_attempt (enqueued_at) WHERE status = 'enqueued';

COMMENT ON TABLE follow_up_attempt IS
  'Připomínky neodpovězených nabídek (0105, balík P4). Zapisuje jen úloha follow-up-send (service_role); e-mail jde přes agent_outbox (P3).';

DROP TRIGGER IF EXISTS follow_up_attempt_set_updated_at ON follow_up_attempt;
CREATE TRIGGER follow_up_attempt_set_updated_at BEFORE UPDATE ON follow_up_attempt
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE follow_up_attempt ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS follow_up_attempt_select ON follow_up_attempt;
CREATE POLICY follow_up_attempt_select ON follow_up_attempt FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS require_aal2 ON follow_up_attempt;
CREATE POLICY require_aal2 ON follow_up_attempt
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS sales_only ON follow_up_attempt;
CREATE POLICY sales_only ON follow_up_attempt
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

REVOKE ALL ON follow_up_attempt FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON follow_up_attempt FROM authenticated;
REVOKE ALL ON SEQUENCE follow_up_attempt_id_seq FROM anon, authenticated;

-- Audit (MUSÍ sedět s core/auditCoverage.followup.ts): šablona a source_ref jen názvem.
DROP TRIGGER IF EXISTS audit_row_change_soft ON follow_up_attempt;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON follow_up_attempt
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'attempt,deal_id,enqueued_at,outbox_id,planned_on,status,stop_reason',
    '',
    '',
    '');

-- ===========================================================================
-- 2) Fakta pro stop pravidla (jen časy, příznaky a počty — žádný text)
-- ===========================================================================

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
    (SELECT max(m.occurred_at) FROM mail_event m
      WHERE m.direction = 'inbound'
        AND ((d.account_id IS NOT NULL AND m.account_id = d.account_id)
          OR (d.primary_contact_id IS NOT NULL AND m.contact_id = d.primary_contact_id))),
    (SELECT max(m.occurred_at) FROM mail_event m
      WHERE m.direction = 'outbound'
        AND ((d.account_id IS NOT NULL AND m.account_id = d.account_id)
          OR (d.primary_contact_id IS NOT NULL AND m.contact_id = d.primary_contact_id))),
    -- Ruční zásah = aktivita s autorem; zápis zpětně (occurred_at v minulosti)
    -- se počítá od okamžiku zápisu.
    (SELECT max(GREATEST(a.occurred_at, a.created_at)) FROM sales_activity a
      WHERE a.deal_id = d.id AND a.created_by IS NOT NULL),
    (SELECT max(v.sent_at) FROM deal_scope_version v WHERE v.deal_id = d.id),
    (SELECT c.do_not_contact FROM contact c WHERE c.id = d.primary_contact_id),
    (SELECT count(*)::int FROM contact c WHERE d.account_id IS NOT NULL AND c.account_id = d.account_id),
    (SELECT count(*)::int FROM contact c WHERE d.account_id IS NOT NULL AND c.account_id = d.account_id AND c.do_not_contact),
    (SELECT w.event_date FROM web_inquiry w
      WHERE w.deal_id = d.id AND w.event_date IS NOT NULL
      ORDER BY w.received_at DESC LIMIT 1)
  FROM deal d
  WHERE d.id = ANY (p_deal_ids);
$$;

COMMENT ON FUNCTION follow_up_facts(bigint[]) IS
  'Fakta pro stop pravidla follow-up cadence (0105): časy poslední příchozí/odchozí pošty, ruční aktivity a odeslané nabídky, nesouhlas s oslovením, datum akce. Jen service_role.';

REVOKE ALL ON FUNCTION follow_up_facts(bigint[]) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION follow_up_facts(bigint[]) TO service_role;
    GRANT SELECT, INSERT, UPDATE ON follow_up_attempt TO service_role;
    GRANT USAGE ON SEQUENCE follow_up_attempt_id_seq TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0105', 'follow_up_cadence: follow_up_attempt (planned|enqueued|stopped|exhausted, UNIQUE deal+pořadí, zápis jen service_role, RLS AAL2 + can_see_sales, měkký audit) a follow_up_facts')
ON CONFLICT (version) DO NOTHING;
