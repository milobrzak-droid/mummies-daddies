-- 0074 — unikátní account.ico (žádné dvě firmy se stejným IČO).
--
-- PROČ: duplicitu IČO dnes hlídá jen aplikační kód (domain/crm/aresEnrich.ts
-- findTakenIcos — dávkový automat, a assignIco/backfillAccount, které se
-- ptají "onlyIfBlank" na stejný řádek). Ruční editace klienta
-- (domain/crm/actions/accounts.ts, updateAccount/createAccount) žádnou
-- takovou kontrolu nemá a v DB pro ni není žádná opora — dva formuláře
-- otevřené najednou (nebo prostý překlep) mohou založit dvě firmy se
-- stejným IČO a nic to nezastaví. Částečný unikátní index to zastaví
-- v DB; aplikace na 23505 může vrátit srozumitelnou chybu (zatím nevrací —
-- ponecháno na product rozhodnutí, jak přesně formulář zareaguje).
--
-- Číslo 0064 je rezervované souběžnou větví (viz test/migrations-lint.test.ts).
--
-- POZOR PŘED APLIKACÍ: pokud v produkčních datech už nějaká duplicita IČO
-- vznikla (např. ručním importem mimo scripts/import-radar, který duplicity
-- nehlídá), tahle migrace spadne na CREATE UNIQUE INDEX — guard níže to
-- ohlásí srozumitelně předem. Spusť napřed ruční kontrolu:
--   SELECT ico, count(*) FROM account WHERE ico IS NOT NULL AND ico <> ''
--   GROUP BY ico HAVING count(*) > 1;
-- a nalezené duplicity slouč (nebo jednu z dvojice zbav IČO), než se 0074
-- aplikuje. Migraci nikdy neediťuj poté, co ji cokoliv aplikovalo — nová
-- oprava jde jako další číslo.
--
-- Prázdný řetězec se v praxi neukládá (accountSchema.optText mění '' na
-- NULL), index ho přesto vylučuje pro jistotu (stejná podmínka jako
-- v_account_list_facets.missing_ico z 0068).
-- Opakovaný běh je bezpečný (IF NOT EXISTS).

DO $$
BEGIN
  IF to_regclass('public.account') IS NULL THEN
    RAISE EXCEPTION '0074: chybí tabulka account — nejdřív aplikuj starší migrace.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'ico'
  ) THEN
    RAISE EXCEPTION '0074: chybí sloupec account.ico (migrace 0011_account_rich.sql).';
  END IF;
  -- Duplicity se neslučují automaticky (mohou nést různé úpravy, různé
  -- kontakty) — člověk je musí vyřešit ručně, jinak index nejde založit.
  IF EXISTS (
    SELECT 1 FROM account WHERE ico IS NOT NULL AND ico <> ''
    GROUP BY ico HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0074: v account existují duplicitní ico — nejdřív je ručně sluč (SELECT ico, count(*) FROM account WHERE ico IS NOT NULL AND ico <> '''' GROUP BY ico HAVING count(*) > 1).';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS account_ico_uniq
  ON account (ico)
  WHERE ico IS NOT NULL AND ico <> '';

INSERT INTO schema_migration (version, note)
VALUES ('0074', 'unikátní account.ico (částečný index, jen když je IČO vyplněné) — DB opora vedle aplikační kontroly v aresEnrich.ts')
ON CONFLICT (version) DO NOTHING;
