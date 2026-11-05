-- 0054 — předávací balíček obchod → realizace na `engagement` (kap. 6).
--
-- Rozhodnutí vlastníka 2026-09-28: Delivery Standard je schválený, předávací
-- balíček je povinný přechod do realizace. Z deseti položek (HANDOFF_ITEMS
-- v domain/delivery/milestone.ts) jich pět už v DB je:
--   schválená nabídka  engagement.deal_id
--   termíny            engagement.started_on + due_on
--   výchozí metrika    engagement.baseline_adoption_pct
--   podklady           engagement_document (0051)
--   vlastník           engagement_milestone.owner_id (0042)
-- Tahle migrace přidává zbylých pět + záznam o předání:
--   goal                       cíl dodávky
--   scope                      rozsah (co JE a co NENÍ součástí)
--   client_sponsor_contact_id  klientský sponzor → contact, ON DELETE SET NULL
--                              (GDPR výmaz kontaktu nesmí blokovat dodávka;
--                              předání zůstává doložené handoff_completed_at)
--   financial_frame            finanční rámec (text: rozpočet, fakturace)
--   risks                      nevyřešená rizika, text[]:
--                              NULL = nevyplněno, '{}' = vědomě žádná
--                              (proto BEZ výchozí hodnoty)
--   handoff_completed_at       kdy bylo předáno do realizace
--   handoff_by                 kdo předal → team_member, ON DELETE SET NULL
--
-- Úplnost balíčku hlídá validateHandoff v TS (skládá i položky z jiných
-- tabulek). DB drží jen tvrdý invariant nad vlastními sloupci: předaná
-- dodávka má vyplněný cíl, rozsah, finanční rámec a rizika (i prázdná).
-- Sponzor v CHECKu záměrně NENÍ — jeho ON DELETE SET NULL by jinak narazil
-- na CHECK a GDPR výmaz kontaktu by selhal.
--
-- Vše nullable, bez výchozích hodnot → ADD COLUMN je jen katalogová změna;
-- stávající dodávky mají handoff_completed_at NULL, takže CHECK projde.
-- Kód je tolerantní k nenasazené migraci (42703 / PGRST204 → klidná hláška).
-- Idempotentní (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS,
-- ON CONFLICT). NEAPLIKOVÁNO.

ALTER TABLE engagement ADD COLUMN IF NOT EXISTS goal text;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS scope text;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS client_sponsor_contact_id bigint
  REFERENCES contact(id) ON DELETE SET NULL;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS financial_frame text;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS risks text[];
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS handoff_completed_at timestamptz;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS handoff_by uuid
  REFERENCES team_member(id) ON DELETE SET NULL;

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_goal_len;
ALTER TABLE engagement ADD CONSTRAINT engagement_goal_len
  CHECK (goal IS NULL OR char_length(goal) <= 2000);

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_scope_len;
ALTER TABLE engagement ADD CONSTRAINT engagement_scope_len
  CHECK (scope IS NULL OR char_length(scope) <= 4000);

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_financial_frame_len;
ALTER TABLE engagement ADD CONSTRAINT engagement_financial_frame_len
  CHECK (financial_frame IS NULL OR char_length(financial_frame) <= 2000);

-- Nejvýš 30 rizik; délku jednotlivých hlídá zod (CHECK nesmí obsahovat poddotaz).
ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_risks_len;
ALTER TABLE engagement ADD CONSTRAINT engagement_risks_len
  CHECK (risks IS NULL OR cardinality(risks) <= 30);

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_handoff_complete_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_handoff_complete_check
  CHECK (handoff_completed_at IS NULL OR (
    goal IS NOT NULL AND char_length(btrim(goal)) > 0
    AND scope IS NOT NULL AND char_length(btrim(scope)) > 0
    AND financial_frame IS NOT NULL AND char_length(btrim(financial_frame)) > 0
    AND risks IS NOT NULL
  ));

CREATE INDEX IF NOT EXISTS engagement_client_sponsor_idx
  ON engagement(client_sponsor_contact_id) WHERE client_sponsor_contact_id IS NOT NULL;

COMMENT ON COLUMN engagement.risks IS
  'Nevyřešená rizika při předání. NULL = nevyplněno, prázdné pole = vědomě žádná.';
COMMENT ON COLUMN engagement.handoff_completed_at IS
  'Předáno do realizace (kap. 6). Nastavuje jen completeHandoff po validateHandoff.';

INSERT INTO schema_migration (version, note)
VALUES ('0054', 'engagement - predavaci balicek (cil, rozsah, sponzor, financni ramec, rizika, predani)')
ON CONFLICT (version) DO NOTHING;
