-- 0070 — jeden obchod na jedno PDF nabídky (unikátní deal.source_pdf_path).
--
-- PROČ: potvrzení návrhu nabídky (domain/crm/actions/offers.ts) nejdřív
-- hledá obchod se stejnou source_pdf_path a teprve pak zakládá nový. Bez
-- opory v databázi dvě souběžná potvrzení (dvojklik, dvě záložky) projdou
-- kontrolou obě a vzniknou dva obchody — nafouknutá pipeline i tržby.
-- Částečný unikátní index to zastaví v DB; aplikace na 23505 dohledá
-- existující obchod a vrátí „už importováno".
--
-- Čísla 0060–0065 jsou rezervovaná paralelními větvemi.
-- Opakovaný běh je bezpečný (IF NOT EXISTS).

DO $$
BEGIN
  IF to_regclass('public.deal') IS NULL THEN
    RAISE EXCEPTION '0070: chybí tabulka deal — nejdřív aplikuj starší migrace.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'deal' AND column_name = 'source_pdf_path'
  ) THEN
    RAISE EXCEPTION '0070: chybí sloupec deal.source_pdf_path (migrace 0015).';
  END IF;
  -- Duplicity se neslučují automaticky (mohou nést různé úpravy) — člověk
  -- je musí vyřešit ručně, jinak index nejde založit.
  IF EXISTS (
    SELECT 1 FROM deal WHERE source_pdf_path IS NOT NULL
    GROUP BY source_pdf_path HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0070: v deal existují duplicitní source_pdf_path — nejdřív je ručně sluč.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS deal_source_pdf_path_uniq
  ON deal (source_pdf_path)
  WHERE source_pdf_path IS NOT NULL;

INSERT INTO schema_migration (version, note)
VALUES ('0070', 'unikátní deal.source_pdf_path (jeden obchod na jedno PDF nabídky)')
ON CONFLICT (version) DO NOTHING;
