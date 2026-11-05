-- 0090 — financial_record.due_on: splatnost vyfakturovaného záznamu.
--
-- PROČ: Finance ukazují čtyři oddělené druhy peněz (0063), ale u faktury
-- nebylo datum splatnosti, takže „nezaplaceno po splatnosti" nešlo spočítat.
-- Stránka Finance (jediná karta se sytou barvou) a provozní přehled (sekce
-- Riziko) chtějí vědět, které vystavené faktury čekají na platbu déle, než
-- měly.
--
-- TVAR
--   due_on   date, volitelné. Smí být jen u druhu 'invoiced' (CHECK) a v
--            rozumném rozsahu 2000-01-01 až 2100-12-31 (překlep v roce by
--            jinak dal fakturu „po splatnosti" o tisíc let). Bez data se
--            splatnost nehlídá.
--
-- CO SE POČÍTÁ JAKO „PO SPLATNOSTI" (drží kód, domain/finance/records.ts):
--   potvrzená (status 'confirmed', tedy s číslem dokladu) vyfakturovaná
--   položka, jejíž due_on je před dneškem (pražským) a ke které neexistuje
--   potvrzený záznam 'received' od stejné firmy se stejným číslem dokladu.
--   Zrušená ani rozepsaná (návrh) faktura se po splatnosti nehlídá.
--
-- ZÁMEK PO ZRUŠENÍ: 0063 zakazuje měnit zrušený záznam, ale tabulka
-- hlídaných sloupců (financial_record_guard) o due_on nevěděla. Zrušenému
-- záznamu se splatnost nemění ani teď — samostatný malý trigger, ať se
-- nepřepisuje celá funkce z 0063.
--
-- AUDIT: due_on je datum, ne osobní údaj — do allow-listu měkkého triggeru
-- (0082) přibývá s hodnotou (po DROP + CREATE; ostatní sloupce beze změny).
--
-- OPRÁVNĚNÍ: beze změny — RLS a RESTRICTIVE AAL2 + sales_only z 0063 platí
-- na celou tabulku, tedy i na nový sloupec. Nová tabulka nevzniká.
--
-- KÓD JE TOLERANTNÍ K NENASAZENÉ MIGRACI: bez 0090 se záznamy čtou a zapisují
-- jako dřív, karta po splatnosti řekne „čeká na migraci 0090" a zápis
-- splatnosti vrátí srozumitelnou chybu.
--
-- ZÁVISLOSTI: 0063 (financial_record), 0082 (audit_row_change_soft), 0026
-- (ledger). Guard níže skončí srozumitelnou chybou.
-- Idempotentní: ADD COLUMN IF NOT EXISTS, CHECK jen když chybí, CREATE INDEX
-- IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS + CREATE, ON CONFLICT.
-- Zámky: ADD COLUMN bez výchozí hodnoty je metadata (krátký ACCESS EXCLUSIVE),
-- CHECK a index nad malou tabulkou; data se nepřepisují.

DO $$
BEGIN
  IF to_regclass('public.financial_record') IS NULL THEN
    RAISE EXCEPTION '0090 vyžaduje tabulku financial_record — nejdřív aplikujte 0063_financial_record.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0090 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0090 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

ALTER TABLE financial_record ADD COLUMN IF NOT EXISTS due_on date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'financial_record_due_on_check'
      AND conrelid = 'public.financial_record'::regclass
  ) THEN
    ALTER TABLE financial_record ADD CONSTRAINT financial_record_due_on_check
      CHECK (due_on IS NULL OR (kind = 'invoiced' AND due_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'));
  END IF;
END $$;

-- Nezaplacené potvrzené faktury s termínem splatnosti (karta a přehled Riziko).
CREATE INDEX IF NOT EXISTS financial_record_due_idx
  ON financial_record(due_on)
  WHERE kind = 'invoiced' AND status = 'confirmed' AND due_on IS NOT NULL;

COMMENT ON COLUMN financial_record.due_on IS
  'Splatnost vyfakturovaného záznamu (jen kind = invoiced). Potvrzená faktura po splatnosti bez potvrzeného záznamu Přijato se stejným číslem dokladu = nezaplaceno po splatnosti.';

-- Zrušenému záznamu se splatnost nemění (vzor financial_record_guard z 0063).
CREATE OR REPLACE FUNCTION financial_record_due_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'cancelled' AND NEW.due_on IS DISTINCT FROM OLD.due_on THEN
    RAISE EXCEPTION 'Zrušený finanční záznam se už nemění' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS financial_record_due_guard ON financial_record;
CREATE TRIGGER financial_record_due_guard
  BEFORE UPDATE ON financial_record
  FOR EACH ROW
  WHEN (OLD.due_on IS DISTINCT FROM NEW.due_on)
  EXECUTE FUNCTION financial_record_due_guard();

-- Audit (měkký, 0082): stejný allow-list jako dřív + due_on. Číslo dokladu
-- a poznámka zůstávají jen názvem sloupce.
DROP TRIGGER IF EXISTS audit_row_change_soft ON financial_record;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON financial_record
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,amount,created_by,currency,deal_id,due_on,engagement_id,evidence_id,kind,milestone_id,period_month,source,status',
    '',
    'evidence_id',
    '');

INSERT INTO schema_migration (version, note)
VALUES ('0090', 'financial_record.due_on - splatnost vyfakturovaneho zaznamu (jen kind invoiced, rozsah roku), zamek po zruseni, index pro nezaplacene po splatnosti, due_on v auditu (soft trigger 0082)')
ON CONFLICT (version) DO NOTHING;
