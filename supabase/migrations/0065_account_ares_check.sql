-- 0065 — account.ares_checked_at / ares_status: kdy a s jakým výsledkem se
-- klient ověřoval v ARESu.
--
-- PROČ: po importu 629 prospektů nemá IČO 640 firem. Stránka
-- /clients/doplnit-ico dosud při KAŽDÉM zobrazení poslala do ARESu dotaz za
-- všechny najednou (640 požadavků → limit ARESu, timeout Vercelu). Nově je
-- seznam stránkovaný a IČO doplňuje automat po dávkách
-- (domain/crm/aresEnrich.ts; ruční tlačítko pro admina a denní cron
-- /api/cron/ares-enrich). Aby se automat neptal pořád dokola na tytéž
-- firmy a stránka mohla skrýt ty, u kterých ARES nic nezná, musí si DB
-- pamatovat, co už bylo ověřené:
--
--   ares_checked_at  kdy proběhlo poslední ověření v ARESu — i neúspěšné
--                    (ARES neodpověděl) a i pouhé doplnění sídla u klienta,
--                    který IČO už má.
--   ares_status      výsledek párování JMÉNA na IČO (jen klienti bez IČO):
--                    prirazeno      přesná shoda jména, IČO doplnil automat
--                    nejednoznacne  ARES něco vrátil, ale ne jednoznačně
--                                   (jediný výsledek, víc shod, IČO už má
--                                   jiný klient…) — rozhodne člověk
--                    nenalezeno     ARES pod tím jménem nic nezná; stránka
--                                   je bez ?vse=1 skryje
--                    NULL           ještě neověřeno, nebo ARES neodpověděl
--                                   (automat to zkusí znovu)
--
-- Automat přiřazuje JEN přesnou shodu jména (pickAresMatch) a nikdy IČO,
-- které už má jiný klient; „jediný výsledek" zůstává návrhem — cizí IČO
-- je v CRM horší než prázdné pole (komentář u pickAresMatch). Hodnoty
-- ares_status MUSÍ sedět s ARES_STATUSES v domain/crm/aresEnrich.ts
-- (test/ares-enrich.test.ts je porovnává).
--
-- RLS: žádná nová politika. Jde jen o sloupce tabulky account, na kterou
-- už platí biz_all (0003, člen týmu) a RESTRICTIVE require_aal2 (0007) —
-- nové sloupce je dědí. Automat zapisuje přes service roli; ruční spuštění
-- smí jen admin (server akce ověřuje AAL2 + team_member.is_admin z DB),
-- cron chrání CRON_SECRET. Nevzniká tabulka ani funkce, takže není co
-- REVOKEovat. Guard níže ověří, že account RLS opravdu má.
--
-- Idempotentní: ADD COLUMN IF NOT EXISTS, CHECK přes DROP … IF EXISTS
-- + ADD, index IF NOT EXISTS. Opakovaný běh je bezpečný.

DO $$
BEGIN
  IF to_regclass('public.account') IS NULL THEN
    RAISE EXCEPTION '0065 vyžaduje tabulku account — nejdřív aplikujte 0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'ico'
  ) THEN
    RAISE EXCEPTION '0065 vyžaduje account.ico — nejdřív aplikujte 0011_account_rich.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.account'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION '0065: account nemá zapnuté RLS — nejdřív aplikujte 0003_rls.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'account' AND policyname = 'require_aal2'
  ) THEN
    -- Stejná tolerance jako 0020: některá prostředí 0007 odkládají, dokud
    -- nemají všichni MFA. Nová politika tu nevzniká, jen upozornění.
    RAISE NOTICE '0065: account zatím nemá RESTRICTIVE require_aal2 (0007) — nové sloupce se řídí stejnými politikami jako zbytek tabulky';
  END IF;
END $$;

ALTER TABLE account ADD COLUMN IF NOT EXISTS ares_checked_at timestamptz;
ALTER TABLE account ADD COLUMN IF NOT EXISTS ares_status text;

ALTER TABLE account DROP CONSTRAINT IF EXISTS account_ares_status_check;
ALTER TABLE account ADD CONSTRAINT account_ares_status_check
  CHECK (ares_status IS NULL OR ares_status IN ('prirazeno', 'nejednoznacne', 'nenalezeno'));

-- Fronta automatu: klienti bez IČO a bez výsledku, nikdy neověření první
-- (pak ti, u kterých ARES naposledy neodpověděl), v rámci toho podle jména.
CREATE INDEX IF NOT EXISTS account_ares_queue_idx
  ON account (ares_checked_at NULLS FIRST, name, id)
  WHERE ico IS NULL AND ares_status IS NULL;

INSERT INTO schema_migration (version, note)
VALUES ('0065', 'account.ares_checked_at + ares_status (prirazeno/nejednoznacne/nenalezeno) — dávkové doplňování IČO z ARESu, bez nových politik')
ON CONFLICT (version) DO NOTHING;
