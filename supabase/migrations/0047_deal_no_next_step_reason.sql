-- 0047 — deal.no_next_step_reason: výslovný důvod, proč otevřený obchod nemá
-- další krok s termínem.
--
-- Invariant (plán, kap. 5, č. 1): aktivní obchod má vlastníka a další krok
-- s termínem, nebo výslovný důvod, proč žádný není. Kontrolu dělá čistá
-- funkce checkDealInvariant (domain/crm/dealInvariant.ts); uložení se zatím
-- NEBLOKUJE, jen se porušení ukazuje v UI (formulář, pipeline).
--
-- Kód je tolerantní k nenasazené migraci: čte přes select('*') (sloupec pak
-- chybí = null) a při zápisu na 42703 / PGRST204 zopakuje zápis bez sloupce.

ALTER TABLE deal ADD COLUMN IF NOT EXISTS no_next_step_reason text;

ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_no_next_step_reason_len;
ALTER TABLE deal ADD CONSTRAINT deal_no_next_step_reason_len
  CHECK (no_next_step_reason IS NULL OR char_length(no_next_step_reason) <= 500);

INSERT INTO schema_migration (version, note)
VALUES ('0047', 'deal.no_next_step_reason (invariant: další krok nebo důvod)')
ON CONFLICT (version) DO NOTHING;
