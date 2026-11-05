-- 0078 — meeting_note_intake: příjem zápisů schůzek z diktátu (Wispr Flow).
--
-- PROČ: Wispr Flow nemá veřejné API (rozhodnutí vlastníka 28. 9. 2026: zdroje
-- Cockpitu jsou jen Outlook a Wispr Flow). Zápis se do Cockpitu dostane
-- POSTem na /api/ingest/meeting-notes (klíč s rozsahem 'intake', 0079) —
-- z iOS/macOS zkratky, z curlu nebo z webhooku. Endpoint přijme text
-- diktátu, zkusí ho spárovat na klienta (IČO, doména, alias, název) a:
--   * spárovaný → aktivita druhu schůzka (sales_activity) + případně NÁVRH
--     kroků (case_proposal, 0067) ke schválení člověkem,
--   * nespárovaný → čeká v tomhle řádku ve frontě „Nespárované zápisy"
--     (/schuzky/nesparovane), kde ho člověk přiřadí ručně, nebo zahodí.
-- Řádek vzniká pro KAŽDÝ přijatý zápis (i spárovaný) — slouží zároveň jako
-- idempotence (opakované odeslání téhož zápisu nic nezdvojí) a jako zdroj
-- čísel pro „Stav zdrojů" (počet zápisů, čas posledního).
--
-- SOUKROMÍ: text diktátu drží řádek jen dokud čeká na ruční přiřazení.
-- Po přiřazení (text je už v sales_activity.body) i po zahození se title,
-- body, client_hint a actions vynulují — CHECK meeting_note_intake_state_consistent
-- to vynucuje v DB, ne jen aplikace. Trvale zůstávají jen metadata (stav,
-- čas, firma, aktivita, návrh, způsob spárování) a hash klíče idempotence.
-- Zahozený zápis tedy po sobě nenechá žádný text.
--
-- VIDITELNOST: zápis ze schůzky je obchodní data (jako sales_activity,
-- 0020/0058) — vidí ho jen can_see_sales() (vedení, obchodník). RLS:
-- permisivní SELECT pro tým + RESTRICTIVE sales_only (can_see_sales) +
-- RESTRICTIVE require_aal2, stejný vzor jako deal (0058). Zapisuje jen
-- servisní klíč ze serveru (API endpoint, server akce po requireUser
-- AAL2 + kontrole obchodní role); authenticated má jen SELECT.
--
-- AUDIT: obecný trigger audit_row_change() (0064) — jen id, stavy, čas
-- a způsob spárování; text, název a nápověda klienta nikdy (nejsou v
-- allow-listu, do auditu jde nanejvýš název sloupce). Musí sedět s
-- DB_AUDITED_TABLES v core/auditCoverage.ts (test/audit-coverage-0064.test.ts).
--
-- IDEMPOTENCE MIGRACE: IF NOT EXISTS, DROP … IF EXISTS + CREATE, ON CONFLICT.
-- Jen nová tabulka; žádný zásah do existujících dat.
--
-- ZÁVISLOSTI: 0020 (sales_activity, can_see_sales), 0067 (case_proposal),
-- 0064 (audit_row_change), 0026 (ledger). Guard níže skončí srozumitelnou chybou.

DO $$
BEGIN
  IF to_regclass('public.account') IS NULL
     OR to_regclass('public.sales_activity') IS NULL
     OR to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0078 vyžaduje tabulky account, sales_activity a team_member — nejdřív aplikujte starší migrace';
  END IF;
  IF to_regclass('public.case_proposal') IS NULL THEN
    RAISE EXCEPTION '0078 vyžaduje tabulku public.case_proposal — nejdřív aplikujte 0067_case_proposal.sql';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0078 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0078 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change()') IS NULL THEN
    RAISE EXCEPTION '0078 vyžaduje funkci audit_row_change() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0078 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS meeting_note_intake (
  id           bigserial PRIMARY KEY,
  -- Odkud zápis přišel; dnes jediná hodnota 'wispr_flow'.
  source       text NOT NULL DEFAULT 'wispr_flow',
  -- unmatched = čeká na ruční přiřazení, assigned = má firmu a aktivitu,
  -- discarded = člověk zahodil.
  status       text NOT NULL DEFAULT 'unmatched',
  -- Klíč idempotence: 'ext:<zdroj>:<id od odesílatele>' nebo 'sha256:<hash textu>'.
  dedupe_key   text NOT NULL,
  title        text,
  body         text,
  client_hint  text,
  -- Úkoly, které odesílatel poslal vedle textu (volitelné); čeká-li zápis
  -- na ruční přiřazení, nesmí se ztratit. Po vyřízení prázdné pole.
  actions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  match_method text,
  account_id   bigint REFERENCES account(id) ON DELETE CASCADE,
  activity_id  bigint REFERENCES sales_activity(id) ON DELETE SET NULL,
  proposal_id  bigint REFERENCES case_proposal(id) ON DELETE SET NULL,
  -- Vlastník API klíče, kterým zápis přišel (NULL = člověk odešel / ruční vstup).
  created_by   uuid REFERENCES team_member(id) ON DELETE SET NULL,
  decided_by   text,
  decided_at   timestamptz,
  CONSTRAINT meeting_note_intake_source_check CHECK (source ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT meeting_note_intake_status_check CHECK (status IN ('unmatched', 'assigned', 'discarded')),
  CONSTRAINT meeting_note_intake_dedupe_check CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT meeting_note_intake_title_check CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT meeting_note_intake_body_check CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 50000),
  CONSTRAINT meeting_note_intake_hint_check CHECK (client_hint IS NULL OR char_length(client_hint) BETWEEN 1 AND 200),
  CONSTRAINT meeting_note_intake_actions_check
    CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 10),
  CONSTRAINT meeting_note_intake_method_check
    CHECK (match_method IS NULL OR match_method IN ('ico', 'domain', 'alias', 'name', 'text_name', 'manual')),
  -- Text drží jen řádek, který čeká; přiřazený i zahozený je bez textu.
  CONSTRAINT meeting_note_intake_state_consistent CHECK (
    (status = 'unmatched'
       AND body IS NOT NULL AND account_id IS NULL AND match_method IS NULL
       AND decided_at IS NULL AND decided_by IS NULL)
    OR (status = 'assigned'
       AND account_id IS NOT NULL AND match_method IS NOT NULL
       AND body IS NULL AND title IS NULL AND client_hint IS NULL AND actions = '[]'::jsonb
       AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
    OR (status = 'discarded'
       AND account_id IS NULL AND match_method IS NULL
       AND body IS NULL AND title IS NULL AND client_hint IS NULL AND actions = '[]'::jsonb
       AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT meeting_note_intake_dedupe_unique UNIQUE (dedupe_key)
);

-- Fronta „Nespárované zápisy" = čekající, nejstarší nahoře.
CREATE INDEX IF NOT EXISTS meeting_note_intake_unmatched_idx
  ON meeting_note_intake (received_at) WHERE status = 'unmatched';
-- „Stav zdrojů": počet za posledních 30 dní a čas posledního zápisu.
CREATE INDEX IF NOT EXISTS meeting_note_intake_received_idx
  ON meeting_note_intake (received_at DESC);
-- Cizí klíče s ON DELETE (výmaz aktivity/návrhu/firmy nesmí skenovat tabulku).
CREATE INDEX IF NOT EXISTS meeting_note_intake_account_idx
  ON meeting_note_intake (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_note_intake_activity_idx
  ON meeting_note_intake (activity_id) WHERE activity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_note_intake_proposal_idx
  ON meeting_note_intake (proposal_id) WHERE proposal_id IS NOT NULL;

ALTER TABLE meeting_note_intake ENABLE ROW LEVEL SECURITY;

-- Čtení pro tým; žádná INSERT/UPDATE/DELETE politika → klient nezapíše nic.
DROP POLICY IF EXISTS meeting_note_intake_read ON meeting_note_intake;
CREATE POLICY meeting_note_intake_read ON meeting_note_intake
  FOR SELECT USING ((SELECT is_team_member()));

-- Zápis ze schůzky = obchodní data (jako sales_activity, 0058): jen obchodní role.
DROP POLICY IF EXISTS sales_only ON meeting_note_intake;
CREATE POLICY sales_only ON meeting_note_intake
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

DROP POLICY IF EXISTS require_aal2 ON meeting_note_intake;
CREATE POLICY require_aal2 ON meeting_note_intake
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON meeting_note_intake FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON meeting_note_intake FROM authenticated;
GRANT SELECT ON meeting_note_intake TO authenticated;
GRANT ALL ON meeting_note_intake TO service_role;
GRANT USAGE ON SEQUENCE meeting_note_intake_id_seq TO service_role;

-- Audit (0064): jen id, stavy, čas a způsob spárování; title/body/client_hint
-- a dedupe_key nejsou v allow-listu (do auditu jen názvem sloupce).
-- MUSÍ sedět s DB_AUDITED_TABLES.meeting_note_intake v core/auditCoverage.ts.
DROP TRIGGER IF EXISTS audit_row_change ON meeting_note_intake;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON meeting_note_intake
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,activity_id,created_by,decided_at,decided_by,match_method,occurred_at,proposal_id,source,status',
    '',
    '');

INSERT INTO schema_migration (version, note)
VALUES ('0078', 'meeting_note_intake: prijem zapisu schuzek z diktatu (Wispr Flow) - fronta nesparovanych, idempotence, jen obchodni role (can_see_sales), text jen dokud ceka, audit trigger')
ON CONFLICT (version) DO NOTHING;
