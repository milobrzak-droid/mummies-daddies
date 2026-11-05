-- 0101 — návrhy zakázek z konektoru (Claude v claude.ai / Coworku): důvod zamítnutí.
--
-- PROČ: konektor (/api/mcp) obchod nezakládá. propose_deal / propose_deals /
-- propose_deal_update uloží NÁVRH do fronty mail_content_intake (0091) jako
-- čekající řádek s návrhem zakázky (wait_reason 'offer_draft', offer_draft z 0099)
-- a se zdrojem source = 'mcp_connector'. Obchod vznikne až po schválení vedením /
-- adminem na /rozhodnuti (domain/crm/connectorProposalService.ts). Fronta a její
-- pravidla (RLS jen obchodní role + AAL2, zápis jen server, měkký audit, retence
-- 30 dní, idempotence dedupe_key) jsou beze změny — tahle migrace jen přidává:
--
--   * decision_note — krátký důvod zamítnutí (≤ 500 znaků), aby se ho Claude
--     dozvěděl přes get_proposals. Volný text: do auditu jen názvem (měkký
--     trigger 0082 má allow-list sloupců; decision_note v něm není a je
--     v NEVER_SAFE_COLUMNS v core/auditCoverage.ts).
--   * index na frontu konektoru (source, created_by, created_at) pro get_proposals
--     a přehled na /rozhodnuti.
--
-- BEZ TÉTO MIGRACE kód funguje: návrhy vznikají i se schvalují (stačí 0091 + 0099),
-- jen zamítnutí neuloží důvod a get_proposals vrátí reason_unavailable.
--
-- IDEMPOTENCE: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD,
-- CREATE INDEX IF NOT EXISTS, ON CONFLICT. Žádný zásah do existujících dat;
-- sloupec bez výchozí hodnoty je jen změna katalogu. Bez BEGIN/COMMIT.
--
-- ZÁVISLOSTI: 0091 (mail_content_intake), 0099 (offer_draft), 0026 (ledger).

DO $$
BEGIN
  IF to_regclass('public.mail_content_intake') IS NULL THEN
    RAISE EXCEPTION '0101 vyžaduje tabulku mail_content_intake — nejdřív aplikujte 0091_mail_content_intake.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mail_content_intake' AND column_name = 'offer_draft'
  ) THEN
    RAISE EXCEPTION '0101 vyžaduje sloupec mail_content_intake.offer_draft — nejdřív aplikujte 0099_mail_offer_attachment.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0101 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

ALTER TABLE mail_content_intake
  ADD COLUMN IF NOT EXISTS decision_note text;

ALTER TABLE mail_content_intake DROP CONSTRAINT IF EXISTS mail_content_intake_decision_note_check;
ALTER TABLE mail_content_intake ADD CONSTRAINT mail_content_intake_decision_note_check
  CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500);

CREATE INDEX IF NOT EXISTS mail_content_intake_connector_idx
  ON mail_content_intake (created_by, created_at DESC) WHERE source = 'mcp_connector';

INSERT INTO schema_migration (version, note)
VALUES ('0101', 'mail_content_intake: navrhy zakazek z konektoru (source mcp_connector) - decision_note (duvod zamitnuti) + index fronty konektoru')
ON CONFLICT (version) DO NOTHING;
