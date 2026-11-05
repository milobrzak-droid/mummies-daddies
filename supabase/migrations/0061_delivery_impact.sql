-- 0061 — dokončení kapitoly 6: dopad dodávky (baseline vs. skutečnost),
-- reference jen s doloženým souhlasem a vlastnictví dodávky jménem se
-- zástupcem.
--
-- Kapitola 6 plánu přestavby (docs/PROVOZ.md) končí třemi body, které
-- v DB zatím neměly kde žít:
--   „Po dokončení: baseline vs. skutečnost (metric_observation);
--    reference jen s doloženým souhlasem."
--   „Vlastnictví jménem a se zástupcem — vzdělávací tým (strategie, adopce)
--    a realizační tým (realizace, provoz)."
-- NEAPLIKOVÁNO na živou DB. Kód je tolerantní k nenasazené migraci
-- (42P01/PGRST205 u tabulky, 42703/PGRST204 u sloupce → klidná hláška).
--
-- 1) metric_observation — naměřený dopad dodávky.
--    PROČ TABULKA: engagement má z 0001 pevné sloupce (adopce, vyškolení,
--    ušetřené minuty…), které pokrývají jen Copilot adopci. Každá dodávka ale
--    slibuje jinou metriku (procesní mapa → doba zpracování, agent → počet
--    tiketů…). Řádek = jedna metrika: výchozí hodnota (baseline), skutečnost
--    po dodávce (actual), kdy se měřilo a čím je to doložené (evidence z 0038,
--    nepovinná — měření se zapisuje, i když doklad teprve vzniká). Delta se
--    NEUKLÁDÁ: počítá se při čtení (domain/delivery/impact.ts), takže oprava
--    hodnoty nikdy nerozjede uložený rozdíl.
--    Aspoň jedna z hodnot musí být vyplněná (baseline se může zapsat při
--    předání a skutečnost až po měření — pak jako další řádek).
--
--    PENÍZE SEM NEPATŘÍ (rozhodnutí majitele 2026-09-28: obchody, částky
--    a jakékoli peníze vidí jen obchodní role, can_see_sales()). Tabulka je
--    viditelná celému týmu, proto jednotka ani název metriky nesmí být měna
--    (CZK, Kč, EUR, €, USD, $ …). CHECK metric_observation_no_currency_check
--    to vynucuje; peněžní dopad patří do finančních záznamů (deal,
--    subscription), které hlídá RESTRICTIVE sales_only z 0058. Vzor je znak
--    po znaku shodný s CURRENCY_PATTERN v domain/delivery/impact.ts (hlídá
--    test/delivery-impact.test.ts). TS kontroluje dřív a s lepší hláškou;
--    CHECK je pojistka i pro service-role a přímé PostgREST zápisy.
--
--    created_by = auth.uid() (DEFAULT + trigger, vzor 0053 L2): autora nejde
--    podvrhnout z klienta. service_role (bez auth.uid()) je vyjmutá.
--
-- 2) reference_card: consent_evidence_id + consent_at.
--    reference_card.approved_public („klient dal souhlas", 0001) byl dosud
--    jen zaškrtávátko bez dokladu. Nově: schválená (použitelná, veřejná)
--    reference MUSÍ mít evidenci souhlasu a datum — CHECK
--    reference_card_consent_check platí pro INSERT i UPDATE a nejde obejít
--    ani service-role klientem. Evidence je trvalý ukazatel bez osobních
--    údajů (0038), ON DELETE RESTRICT: doklad souhlasu nejde tiše ztratit.
--    Stažení souhlasu = approved_public false; evidence zůstává jako historie.
--
--    STÁVAJÍCÍ DATA: karta se schválením, ale bez dokladu by CHECK porušila.
--    Podle rozhodnutí „reference jen s doloženým souhlasem" nedoložený souhlas
--    není souhlas → taková karta se před přidáním CHECKu přepne na
--    neschválenou. Každá změna se zapíše do audit_event (actor 'system',
--    'migration:0061'), počet vypíše RAISE NOTICE. Seed (supabase/seed.sql)
--    má všechny karty neschválené, takže se ho to netýká. Souhlas se pak
--    doloží v UI (sekce Referenční karty na stránce dodávky).
--
-- 3) engagement: owner_id, deputy_id, delivery_team.
--    Vlastník a zástupce jménem (team_member, ON DELETE SET NULL — odchod
--    člověka nesmaže dodávku; vzor engagement_milestone z 0042). Zástupce
--    není tentýž člověk jako vlastník (CHECK). „Zástupce bez vlastníka"
--    hlídá jen zod: CHECK by po ON DELETE SET NULL vlastníka zablokoval
--    výmaz člena týmu (stejná úvaha jako u sponzora v 0054).
--    delivery_team = realizační tým, stejný číselník jako deal.delivery_team
--    (0010). Hodnoty jsou konfigurace firmy (COMPANY.deliveryTeams
--    v config/mummiesDaddies.ts); SQL je kopie a v hlavičce config/mummiesDaddies.ts je
--    zapsaná (test/delivery-impact.test.ts hlídá shodu).
--
-- RLS: metric_observation má domácí styl — permisivní pro člena týmu
-- + RESTRICTIVE AAL2, REVOKE pro anon. reference_card a engagement už RLS
-- mají (0003/0007), nové sloupce je dědí.
--
-- Zámky: ALTER TABLE engagement/reference_card ADD COLUMN bez DEFAULT je jen
-- změna katalogu; ADD CONSTRAINT CHECK projde malé tabulky pod ACCESS
-- EXCLUSIVE zlomek sekundy.
--
-- Idempotentní: IF NOT EXISTS, DROP … IF EXISTS + ADD, CREATE OR REPLACE,
-- ON CONFLICT DO NOTHING. Opakovaný běh nic nezmění (karty bez dokladu už
-- jsou po prvním běhu neschválené).

DO $$
BEGIN
  IF to_regclass('public.engagement') IS NULL OR to_regclass('public.reference_card') IS NULL THEN
    RAISE EXCEPTION '0061 vyžaduje tabulky engagement a reference_card — nejdřív aplikujte 0001_base_schema.sql';
  END IF;
  IF to_regclass('public.team_member') IS NULL OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0061 vyžaduje team_member a is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regclass('public.audit_event') IS NULL THEN
    RAISE EXCEPTION '0061 vyžaduje tabulku public.audit_event — nejdřív aplikujte 0028_audit_event.sql';
  END IF;
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0061 vyžaduje tabulku public.evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regclass('public.engagement_document') IS NULL THEN
    RAISE EXCEPTION '0061 vyžaduje tabulku public.engagement_document — nejdřív aplikujte 0051';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0061 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) metric_observation
-- ===========================================================================

CREATE TABLE IF NOT EXISTS metric_observation (
  id             bigserial PRIMARY KEY,
  engagement_id  bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  metric         text NOT NULL,
  unit           text,
  baseline       numeric,
  actual         numeric,
  observed_on    date NOT NULL,
  evidence_id    bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  note           text,
  created_by     uuid DEFAULT auth.uid() REFERENCES team_member(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_observation_metric_check
    CHECK (char_length(btrim(metric)) BETWEEN 1 AND 100),
  CONSTRAINT metric_observation_unit_check
    CHECK (unit IS NULL OR char_length(btrim(unit)) BETWEEN 1 AND 30),
  CONSTRAINT metric_observation_note_check
    CHECK (note IS NULL OR char_length(note) <= 1000),
  -- Prázdné měření nic nedokládá.
  CONSTRAINT metric_observation_value_check
    CHECK (baseline IS NOT NULL OR actual IS NOT NULL),
  -- Peníze vidí jen obchodní role (0058) → měna tu nesmí být ani v jednotce,
  -- ani v názvu metriky. Vzor = CURRENCY_PATTERN v domain/delivery/impact.ts.
  CONSTRAINT metric_observation_no_currency_check
    CHECK (
      lower(coalesce(unit, '')) !~ '[€$£]|(^|[^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž])(czk|kč|kc|eur|euro|eura|usd|gbp|chf|pln|korun|koruna|koruny)([^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž]|$)'
      AND lower(metric) !~ '[€$£]|(^|[^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž])(czk|kč|kc|eur|euro|eura|usd|gbp|chf|pln|korun|koruna|koruny)([^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž]|$)'
    )
);

CREATE INDEX IF NOT EXISTS metric_observation_engagement_idx
  ON metric_observation(engagement_id, observed_on);
CREATE INDEX IF NOT EXISTS metric_observation_evidence_idx
  ON metric_observation(evidence_id) WHERE evidence_id IS NOT NULL;

COMMENT ON TABLE metric_observation IS
  'Dopad dodávky: výchozí hodnota vs. skutečnost jedné metriky (kap. 6). Bez peněz — měnu zakazuje CHECK, peníze žijí ve finančních záznamech (sales_only).';

-- Autor = přihlášený uživatel (vzor engagement_document_enforce_created_by z 0053).
CREATE OR REPLACE FUNCTION metric_observation_enforce_created_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- service_role / migrace nemají auth.uid() → vyjmuté.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'created_by musí být přihlášený uživatel' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL THEN
    -- Vynulování (ON DELETE SET NULL po odchodu člověka) projde; přepsat
    -- autora na někoho jiného ne.
    RAISE EXCEPTION 'created_by nelze změnit' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION metric_observation_enforce_created_by() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS metric_observation_created_by ON metric_observation;
CREATE TRIGGER metric_observation_created_by
  BEFORE INSERT OR UPDATE ON metric_observation
  FOR EACH ROW EXECUTE FUNCTION metric_observation_enforce_created_by();

ALTER TABLE metric_observation ENABLE ROW LEVEL SECURITY;

-- Domácí styl (0003 + 0007): permisivní pro člena týmu + RESTRICTIVE AAL2.
-- Funkce zabalené do (SELECT …) — vyhodnotí se jednou za dotaz (vzor 0058).
DROP POLICY IF EXISTS biz_all ON metric_observation;
CREATE POLICY biz_all ON metric_observation
  FOR ALL USING ((SELECT is_team_member())) WITH CHECK ((SELECT is_team_member()));

DROP POLICY IF EXISTS require_aal2 ON metric_observation;
CREATE POLICY require_aal2 ON metric_observation
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON metric_observation FROM anon;

-- ===========================================================================
-- 2) reference_card — souhlas klienta s dokladem
-- ===========================================================================

ALTER TABLE reference_card
  ADD COLUMN IF NOT EXISTS consent_evidence_id bigint REFERENCES evidence(id) ON DELETE RESTRICT;
ALTER TABLE reference_card ADD COLUMN IF NOT EXISTS consent_at timestamptz;

-- Nedoložený souhlas není souhlas (viz hlavička): audit + přepnutí na
-- neschválenou, teprve pak CHECK.
DO $$
DECLARE
  v_reset integer;
BEGIN
  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
  SELECT 'system', 'migration:0061', 'reference_card.consent_missing', 'reference_card', rc.id,
         jsonb_build_object('approved_public', true),
         jsonb_build_object('approved_public', false)
  FROM reference_card rc
  WHERE rc.approved_public AND (rc.consent_evidence_id IS NULL OR rc.consent_at IS NULL);

  UPDATE reference_card
  SET approved_public = false
  WHERE approved_public AND (consent_evidence_id IS NULL OR consent_at IS NULL);
  GET DIAGNOSTICS v_reset = ROW_COUNT;
  IF v_reset > 0 THEN
    RAISE NOTICE '0061: % referencnich karet bez dolozeneho souhlasu prepnuto na neschvalene', v_reset;
  END IF;
END $$;

ALTER TABLE reference_card DROP CONSTRAINT IF EXISTS reference_card_consent_check;
ALTER TABLE reference_card ADD CONSTRAINT reference_card_consent_check
  CHECK (NOT approved_public OR (consent_evidence_id IS NOT NULL AND consent_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS reference_card_consent_evidence_idx
  ON reference_card(consent_evidence_id) WHERE consent_evidence_id IS NOT NULL;

COMMENT ON COLUMN reference_card.approved_public IS
  'Reference smí ven (klient souhlasil). Jen s doloženým souhlasem: consent_evidence_id + consent_at (CHECK reference_card_consent_check, 0061).';
COMMENT ON COLUMN reference_card.consent_evidence_id IS
  'Doklad souhlasu klienta s referencí (evidence, 0038). Po stažení souhlasu zůstává jako historie.';

-- ===========================================================================
-- 2b) Doklad musí patřit ke stejné dodávce
-- ===========================================================================
-- PROČ: CHECK hlídá jen, že doklad je vyplněný. RLS reference_card
-- a metric_observation pustí člena týmu zapsat do consent_evidence_id /
-- evidence_id libovolné id evidence přímo přes PostgREST — třeba akceptaci
-- milníku jiného klienta — a reference by byla „schválená" s cizím dokladem.
-- Trigger proto vyžaduje evidence se source_id 'engagement_document:<id>',
-- jejíž dokument patří ke stejné dodávce jako řádek. SECURITY DEFINER, aby
-- kontrola neviděla jen řádky, které pustí RLS volajícího.
CREATE OR REPLACE FUNCTION evidence_belongs_to_engagement(p_evidence_id bigint, p_engagement_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM evidence e
    JOIN engagement_document d
      ON e.source_id = 'engagement_document:' || d.id::text
    WHERE e.id = p_evidence_id
      AND d.engagement_id = p_engagement_id
  )
$$;

REVOKE ALL ON FUNCTION evidence_belongs_to_engagement(bigint, bigint) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION enforce_evidence_same_engagement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new bigint;
  v_old bigint;
BEGIN
  IF TG_TABLE_NAME = 'reference_card' THEN
    v_new := NEW.consent_evidence_id;
    v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.consent_evidence_id END;
  ELSE
    v_new := NEW.evidence_id;
    v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.evidence_id END;
  END IF;
  IF v_new IS NULL THEN
    RETURN NEW;
  END IF;
  -- Beze změny dokladu i dodávky není co kontrolovat (stažení souhlasu
  -- nechává historický doklad na místě).
  IF TG_OP = 'UPDATE' AND v_new IS NOT DISTINCT FROM v_old
     AND NEW.engagement_id IS NOT DISTINCT FROM OLD.engagement_id THEN
    RETURN NEW;
  END IF;
  IF NOT evidence_belongs_to_engagement(v_new, NEW.engagement_id) THEN
    RAISE EXCEPTION 'Doklad musí být dokument této dodávky' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION enforce_evidence_same_engagement() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS reference_card_consent_evidence_engagement ON reference_card;
CREATE TRIGGER reference_card_consent_evidence_engagement
  BEFORE INSERT OR UPDATE ON reference_card
  FOR EACH ROW EXECUTE FUNCTION enforce_evidence_same_engagement();

DROP TRIGGER IF EXISTS metric_observation_evidence_engagement ON metric_observation;
CREATE TRIGGER metric_observation_evidence_engagement
  BEFORE INSERT OR UPDATE ON metric_observation
  FOR EACH ROW EXECUTE FUNCTION enforce_evidence_same_engagement();

-- ===========================================================================
-- 3) engagement — vlastník, zástupce, realizační tým
-- ===========================================================================

ALTER TABLE engagement ADD COLUMN IF NOT EXISTS owner_id uuid
  REFERENCES team_member(id) ON DELETE SET NULL;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS deputy_id uuid
  REFERENCES team_member(id) ON DELETE SET NULL;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS delivery_team text;

-- Zástupce není tentýž člověk jako vlastník (zastupitelnost, kap. 6).
ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_deputy_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_deputy_check
  CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id);

-- Kopie COMPANY.deliveryTeams (config/mummiesDaddies.ts) — stejný seznam jako
-- deal.delivery_team v 0010_project_pillars.sql.
ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_delivery_team_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_delivery_team_check
  CHECK (delivery_team IS NULL OR delivery_team IN ('kuchyne', 'cukrarna', 'obsluha', 'logistika', 'externi'));

CREATE INDEX IF NOT EXISTS engagement_owner_idx
  ON engagement(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS engagement_deputy_idx
  ON engagement(deputy_id) WHERE deputy_id IS NOT NULL;

COMMENT ON COLUMN engagement.owner_id IS 'Vlastník dodávky jménem (kap. 6). ON DELETE SET NULL.';
COMMENT ON COLUMN engagement.deputy_id IS 'Zástupce vlastníka dodávky; nikdy tentýž člověk (engagement_deputy_check).';
COMMENT ON COLUMN engagement.delivery_team IS 'Realizační tým — klíč z COMPANY.deliveryTeams (config/mummiesDaddies.ts).';

INSERT INTO schema_migration (version, note)
VALUES ('0061', 'metric_observation (dopad bez penez), reference_card souhlas s dokladem, engagement vlastnik/zastupce/realizacni tym')
ON CONFLICT (version) DO NOTHING;
