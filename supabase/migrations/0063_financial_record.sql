-- 0063 — financial_record: finanční záznamy se zdrojem, měnou, obdobím
-- a stavem (kap. 10 plánu přestavby, část 2).
--
-- PROČ: Cockpit dosud znal jen částku obchodu (deal.amount_one_time)
-- a MRR předplatného. Plán (docs/PROVOZ.md, kap. 10) chce
-- „finanční záznamy se zdrojem, měnou, obdobím a stavem" a trvá na tom, že
-- potenciál, nasmlouváno, vyfakturováno a přijato se NIKDY nesčítají do
-- jednoho „obratu". Faktura ani úhrada se neodvozují z pošty. „Hotovo když:
-- přijatý milník vytvoří návrh fakturačních podkladů."
--
-- ROZHODNUTÍ VLASTNÍKA 28. 9. 2026 (ROZHODNUTI.md 10.1): účetnictví zůstává
-- v iDokladu, integrace je odložená. Záznamy se proto zatím zapisují ručně
-- a nesou external_ref (číslo dokladu v účetnictví) — až se napojení
-- postaví, spáruje se podle něj a nic se nebude přepisovat.
--
-- TVAR
--   kind          potential / contracted / invoiced / received — čtyři
--                 oddělené druhy. Text + CHECK, ne enum (vzor 0042): přidání
--                 druhu je výměna CHECKu. Seznam drží ručně synchronně
--                 domain/finance/records.ts (FINANCIAL_KINDS, test hlídá).
--                 Součty dělá TS vždy po druhu A měně — funkce, která by
--                 vrátila jedno číslo přes víc druhů, neexistuje.
--   amount        numeric(14,2) > 0 (stejná přesnost jako deal).
--   currency      typ deal_currency z 0016 (CZK/EUR). Měny se nepřevádějí;
--                 kurz by byl odhad, ne záznam.
--   period_month  první den měsíce, ke kterému částka patří (CHECK).
--   status        draft (návrh) / confirmed (potvrzeno) / cancelled
--                 (zrušeno). Přechody: návrh → potvrzeno | zrušeno,
--                 potvrzeno → zrušeno; zrušený je konečný (trigger níže,
--                 zrcadlo transitionFinancialRecord v TS). Záznam se NEMAŽE
--                 — pro tým neexistuje DELETE politika; oprava = zrušit
--                 a založit nový (historie zůstává).
--   source        rucne / nabidka / milnik / ucetnictvi. Pošta mezi zdroji
--                 záměrně NENÍ (faktura ani úhrada se z pošty neodvozují).
--                 'ucetnictvi' = přepsáno z účetního systému (iDoklad; název
--                 systému je konfigurace firmy v config/, ne SQL). 'milnik'
--                 vzniká jen z přijatého milníku a musí na něj odkazovat.
--   external_ref  číslo dokladu v účetnictví. Potvrzená faktura nebo úhrada
--                 ho mít MUSÍ (CHECK) — tím se „vyfakturováno" a „přijato"
--                 opírá o účetní doklad, ne o odhad nebo e-mail.
--   evidence_id   doklad (0038). U podkladu z milníku je to evidence
--                 akceptace milníku (acceptance_evidence_id).
--   account_id / deal_id / engagement_id / milestone_id: vazby. Trigger
--                 hlídá, že obchod i dodávka patří ke stejné firmě a milník
--                 k dodávce (FK to neumí). Všechny FK jsou ON DELETE
--                 RESTRICT: peníze nesmí potichu ztratit, k čemu patří,
--                 a SET NULL by v kaskádě (smazání dodávky → milníky) narazil
--                 na pravidlo „milník jen s dodávkou". Firmu, druh, zdroj
--                 ani milník už uložený záznam nemění — to by přepisovalo
--                 původ; zrušit a založit nový.
--   created_by    DEFAULT auth.uid(), trigger vynutí přihlášeného autora
--                 a zakáže ho přepsat (vzor 0053 L2); service_role vyjmutá.
--
-- IDEMPOTENCE PODKLADU Z MILNÍKU: nejvýš jeden nezrušený záznam
-- kind = 'invoiced' na milník (částečný UNIQUE index). Tlačítko
-- „Vytvořit podklad k fakturaci" při 23505 vrací „už existuje". Stejně tak
-- nejvýš jeden nezrušený 'invoiced' záznam na číslo dokladu (jedna vystavená
-- faktura = jeden záznam, jinak by se „vyfakturováno" počítalo dvakrát).
--
-- VIDITELNOST: peníze vidí jen obchodní role (rozhodnutí vlastníka, vzor
-- 0058): RESTRICTIVE sales_only s can_see_sales() + RESTRICTIVE AAL2 vedle
-- permisivních politik pro člena týmu. service_role (joby) RLS obchází.
--
-- CHYBY: porušení pravidel = SQLSTATE 23514 (check_violation) s českou
-- větou; TS vše kontroluje dřív (domain/finance/records.ts), DB je pojistka.
--
-- ZÁVISLOSTI: 0001 (account, deal, engagement), 0002 (team_member,
-- is_team_member), 0006 (set_updated_at), 0016 (deal_currency), 0020
-- (can_see_sales), 0026 (schema_migration), 0038 (evidence), 0042
-- (engagement_milestone). Guard níže skončí srozumitelnou chybou.
-- Idempotentní (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS,
-- ON CONFLICT). NEAPLIKOVÁNO — kód je tolerantní k chybějící tabulce.

DO $$
BEGIN
  IF to_regclass('public.account') IS NULL
     OR to_regclass('public.deal') IS NULL
     OR to_regclass('public.engagement') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje tabulky account, deal a engagement — nejdřív aplikujte 0001_base_schema.sql';
  END IF;
  IF to_regclass('public.team_member') IS NULL
     OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje team_member a is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje funkci set_updated_at() — nejdřív aplikujte 0006_tasks_and_calendar.sql';
  END IF;
  IF to_regtype('public.deal_currency') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje typ deal_currency — nejdřív aplikujte 0016_deal_currency.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje tabulku evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regclass('public.engagement_milestone') IS NULL THEN
    RAISE EXCEPTION '0063 vyžaduje tabulku engagement_milestone — nejdřív aplikujte 0042_engagement_milestone.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS financial_record (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  deal_id        bigint REFERENCES deal(id) ON DELETE RESTRICT,
  engagement_id  bigint REFERENCES engagement(id) ON DELETE RESTRICT,
  milestone_id   bigint REFERENCES engagement_milestone(id) ON DELETE RESTRICT,
  kind           text NOT NULL,
  amount         numeric(14,2) NOT NULL,
  currency       deal_currency NOT NULL DEFAULT 'CZK',
  period_month   date NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
  source         text NOT NULL,
  evidence_id    bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  external_ref   text,
  note           text,
  created_by     uuid DEFAULT auth.uid() REFERENCES team_member(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_record_kind_check
    CHECK (kind IN ('potential', 'contracted', 'invoiced', 'received')),
  CONSTRAINT financial_record_amount_check
    CHECK (amount > 0),
  CONSTRAINT financial_record_period_check
    CHECK (EXTRACT(DAY FROM period_month) = 1),
  CONSTRAINT financial_record_status_check
    CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  CONSTRAINT financial_record_source_check
    CHECK (source IN ('rucne', 'nabidka', 'milnik', 'ucetnictvi')),
  -- Podklad z milníku odkazuje na milník a je to faktura (vyfakturováno).
  CONSTRAINT financial_record_milestone_source_check
    CHECK (source <> 'milnik' OR (milestone_id IS NOT NULL AND kind = 'invoiced')),
  -- Milník jen spolu s dodávkou, ke které patří (shodu hlídá trigger).
  CONSTRAINT financial_record_milestone_engagement_check
    CHECK (milestone_id IS NULL OR engagement_id IS NOT NULL),
  -- Potvrzená faktura/úhrada = doklad v účetnictví, ne odhad ani e-mail.
  CONSTRAINT financial_record_confirmed_ref_check
    CHECK (status <> 'confirmed' OR kind NOT IN ('invoiced', 'received') OR external_ref IS NOT NULL),
  CONSTRAINT financial_record_external_ref_check
    CHECK (external_ref IS NULL OR char_length(btrim(external_ref)) BETWEEN 1 AND 200),
  CONSTRAINT financial_record_note_check
    CHECK (note IS NULL OR char_length(note) <= 2000)
);

CREATE INDEX IF NOT EXISTS financial_record_period_idx
  ON financial_record(period_month, kind) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS financial_record_account_idx
  ON financial_record(account_id, period_month);
CREATE INDEX IF NOT EXISTS financial_record_deal_idx
  ON financial_record(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS financial_record_engagement_idx
  ON financial_record(engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS financial_record_evidence_idx
  ON financial_record(evidence_id) WHERE evidence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS financial_record_external_ref_idx
  ON financial_record(external_ref) WHERE external_ref IS NOT NULL;

-- Jeden nezrušený podklad k fakturaci na milník (idempotence tlačítka).
CREATE UNIQUE INDEX IF NOT EXISTS financial_record_milestone_invoiced_uidx
  ON financial_record(milestone_id)
  WHERE milestone_id IS NOT NULL AND kind = 'invoiced' AND status <> 'cancelled';

-- Jedna vystavená faktura (číslo dokladu) = jeden nezrušený záznam.
CREATE UNIQUE INDEX IF NOT EXISTS financial_record_invoice_ref_uidx
  ON financial_record(external_ref)
  WHERE external_ref IS NOT NULL AND kind = 'invoiced' AND status <> 'cancelled';

COMMENT ON TABLE financial_record IS
  'Finanční záznamy (kap. 10): čtyři oddělené druhy (potenciál, nasmlouváno, vyfakturováno, přijato), nikdy se nesčítají do jednoho obratu. Jen obchodní role (sales_only).';
COMMENT ON COLUMN financial_record.period_month IS
  'První den měsíce, ke kterému částka patří.';
COMMENT ON COLUMN financial_record.external_ref IS
  'Číslo dokladu v účetnictví (dnes iDoklad, zapsané ručně; integrace odložena). Povinné u potvrzené faktury a úhrady.';
COMMENT ON COLUMN financial_record.source IS
  'Odkud částka je: rucne / nabidka / milnik / ucetnictvi. Pošta záměrně není zdrojem faktury ani úhrady.';

-- set_updated_at() existuje od 0006.
DROP TRIGGER IF EXISTS financial_record_set_updated_at ON financial_record;
CREATE TRIGGER financial_record_set_updated_at BEFORE UPDATE ON financial_record
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Strážce: autor, neměnný původ, přechody stavu a shoda vazeb.
--
-- SECURITY INVOKER: čte engagement, engagement_milestone a deal pod RLS
-- volajícího. Zapisovat smí jen obchodní role s AAL2 (politiky níže), která
-- všechny tři tabulky vidí; neviditelný řádek = chyba (selhání zavřené).
-- Přechody stavu MUSÍ zůstat shodné s FINANCIAL_STATUS_TRANSITIONS
-- v domain/finance/records.ts (test/finance-0063.test.ts je porovnává).
CREATE OR REPLACE FUNCTION financial_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account    bigint;
  v_ms_eng     bigint;
  v_ms_status  text;
  v_ms_evid    bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- service_role / migrace nemají auth.uid() → vyjmuté.
    IF auth.uid() IS NOT NULL AND NEW.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'created_by musí být přihlášený uživatel' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'cancelled' THEN
      RAISE EXCEPTION 'Nový finanční záznam nemůže být rovnou zrušený' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- Vynulování autora (ON DELETE SET NULL po odchodu člověka) projde,
    -- přepsat ho na někoho jiného ne.
    IF auth.uid() IS NOT NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by
       AND NEW.created_by IS NOT NULL THEN
      RAISE EXCEPTION 'created_by nelze změnit' USING ERRCODE = '42501';
    END IF;
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.milestone_id IS DISTINCT FROM OLD.milestone_id
       OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id THEN
      RAISE EXCEPTION 'Firmu, druh, zdroj, milník ani doklad finančního záznamu nelze změnit — zrušte ho a založte nový'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'cancelled'
       AND (NEW.status, NEW.amount, NEW.currency, NEW.period_month, NEW.deal_id,
            NEW.engagement_id, NEW.evidence_id, NEW.external_ref, NEW.note)
           IS DISTINCT FROM
           (OLD.status, OLD.amount, OLD.currency, OLD.period_month, OLD.deal_id,
            OLD.engagement_id, OLD.evidence_id, OLD.external_ref, OLD.note) THEN
      RAISE EXCEPTION 'Zrušený finanční záznam se už nemění' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('confirmed', 'cancelled'))
      OR (OLD.status = 'confirmed' AND NEW.status = 'cancelled')
    ) THEN
      RAISE EXCEPTION 'Nepovolený přechod stavu finančního záznamu % → %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Vazby: jen nové nebo změněné (nulování se nekontroluje).
  IF NEW.deal_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.deal_id IS DISTINCT FROM OLD.deal_id) THEN
    SELECT d.account_id INTO v_account FROM deal d WHERE d.id = NEW.deal_id;
    IF v_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'obchod % nepatří k firmě %', NEW.deal_id, NEW.account_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.engagement_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id) THEN
    SELECT e.account_id INTO v_account FROM engagement e WHERE e.id = NEW.engagement_id;
    IF v_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'dodávka % nepatří k firmě %', NEW.engagement_id, NEW.account_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.milestone_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id) THEN
    SELECT m.engagement_id, m.status, m.acceptance_evidence_id INTO v_ms_eng, v_ms_status, v_ms_evid
      FROM engagement_milestone m WHERE m.id = NEW.milestone_id;
    IF v_ms_eng IS NULL OR v_ms_eng IS DISTINCT FROM NEW.engagement_id THEN
      RAISE EXCEPTION 'milník % nepatří k dodávce %', NEW.milestone_id, NEW.engagement_id
        USING ERRCODE = 'check_violation';
    END IF;
    -- „Odesláno ≠ přijato": podklad k fakturaci jen z přijatého milníku.
    IF TG_OP = 'INSERT' AND NEW.source = 'milnik' AND v_ms_status NOT IN ('prijato', 'uzavreno') THEN
      RAISE EXCEPTION 'Podklad k fakturaci vzniká jen z přijatého milníku'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Doklad: jinak by záznam firmy A mohl citovat akceptaci firmy B. Jediný
  -- legitimní doklad je akceptace vlastního milníku; po založení je neměnný
  -- (hlídá blok UPDATE výše).
  IF TG_OP = 'INSERT' AND NEW.evidence_id IS NOT NULL
     AND (NEW.milestone_id IS NULL OR NEW.evidence_id IS DISTINCT FROM v_ms_evid) THEN
    RAISE EXCEPTION 'doklad % není akceptací milníku tohoto záznamu', NEW.evidence_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS financial_record_guard ON financial_record;
CREATE TRIGGER financial_record_guard
  BEFORE INSERT OR UPDATE ON financial_record
  FOR EACH ROW EXECUTE FUNCTION financial_record_guard();

-- ---------------------------------------------------------------------------
-- RLS: tým čte/zakládá/upravuje, nikdo nemaže; navíc AAL2 a jen obchodní role.
--
-- Volání v politikách jsou zabalená do (SELECT …) — vyhodnotí se jednou za
-- dotaz (initPlan), vzor 0058.

ALTER TABLE financial_record ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS financial_record_select ON financial_record;
CREATE POLICY financial_record_select ON financial_record FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS financial_record_insert ON financial_record;
CREATE POLICY financial_record_insert ON financial_record FOR INSERT
  WITH CHECK ((SELECT is_team_member()));

DROP POLICY IF EXISTS financial_record_update ON financial_record;
CREATE POLICY financial_record_update ON financial_record FOR UPDATE
  USING ((SELECT is_team_member()))
  WITH CHECK ((SELECT is_team_member()));

-- DELETE politika záměrně NENÍ (default-deny): zrušení = status 'cancelled'.

DROP POLICY IF EXISTS require_aal2 ON financial_record;
CREATE POLICY require_aal2 ON financial_record
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS sales_only ON financial_record;
CREATE POLICY sales_only ON financial_record
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

REVOKE ALL ON financial_record FROM anon;
REVOKE DELETE, TRUNCATE ON financial_record FROM authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0063', 'financial_record - financni zaznamy (potencial/nasmlouvano/vyfakturovano/prijato, nikdy jeden obrat), mena, obdobi, stav, zdroj, external_ref pro iDoklad; jen can_see_sales (RESTRICTIVE)')
ON CONFLICT (version) DO NOTHING;
