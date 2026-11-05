-- 0075 — changes_view: kdy si který člověk naposledy prohlédl obrazovku
-- „Dnes“, aby ranní přehled „Co se změnilo“ uměl říct „od tvé poslední
-- návštěvy“ (ne od pevné hodiny a ne od přihlášení, které Supabase Auth
-- neuchovává po jednotlivých návštěvách).
--
-- PROČ TABULKA, NE SLOUPEC V team_member: zápis do team_member je od 0062
-- a 0073 zúžený na hlídané cesty (uživatel si nesmí přepsat roli ani
-- is_admin). Přidat sem sloupec „naposledy viděl“ by znamenalo znovu otevírat
-- ten strážní seznam kvůli údaji, který nic nechrání. Vlastní malá tabulka
-- s vlastním pravidlem je bezpečnější a nezasahuje do cizí migrace.
--
-- TVAR (jeden řádek na člena týmu)
--   last_open_at  kdy člověk obrazovku naposledy otevřel (každé otevření).
--   baseline_at   začátek okna „Co se změnilo“ pro aktuální návštěvu = čas
--                 posledního otevření z PŘEDCHOZÍ návštěvy. NULL = první
--                 návštěva (aplikace pak ukáže posledních 7 dní).
--   Návštěva = série otevření s mezerami kratšími než 240 minut. Otevře-li
--   člověk obrazovku po delší pauze (druhý den ráno), baseline_at se posune
--   na last_open_at z minula. Obnovení stránky uvnitř návštěvy okno nemění,
--   takže se seznam změn po F5 nevyprázdní. Číslo 240 drží ručně synchronně
--   domain/crm/changes.ts (CHANGES_VISIT_GAP_MINUTES); test/changes-0075.test.ts
--   je porovnává. Aplikace okno počítá stejným pravidlem už při čtení, takže
--   se zobrazí totéž před zápisem i po něm.
--
-- ZÁPIS: jen přes RPC touch_changes_view() (SECURITY DEFINER, aktér z
-- auth.uid(), vynucené AAL2). Přímý INSERT/UPDATE/DELETE klient nemá (grant
-- odebrán, politika neexistuje): nikdo nemůže zapsat čas za jiného člověka.
-- ČTENÍ: každý vidí jen svůj řádek (politika + RESTRICTIVE AAL2).
--
-- Do auditu se tabulka NEpřidává (provozní stav zobrazení, ne obchodní data;
-- stejně jako mfa_failure nebo digest_send_log v docs/PROVOZ.md).
--
-- ZÁVISLOSTI: 0002 (team_member, is_team_member), 0026 (schema_migration).
-- Idempotentní (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS,
-- ON CONFLICT). Nic nemění na existujících tabulkách ani datech.

DO $$
BEGIN
  IF to_regclass('public.team_member') IS NULL
     OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0075 vyžaduje team_member a is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0075 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS changes_view (
  member_id     uuid PRIMARY KEY REFERENCES team_member(id) ON DELETE CASCADE,
  baseline_at   timestamptz,
  last_open_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT changes_view_order_check
    CHECK (baseline_at IS NULL OR baseline_at <= last_open_at)
);

COMMENT ON TABLE changes_view IS
  'Kdy člen týmu naposledy otevřel obrazovku Dnes (okno „Co se změnilo“). Zápis jen přes touch_changes_view().';
COMMENT ON COLUMN changes_view.baseline_at IS
  'Začátek okna změn pro aktuální návštěvu (poslední otevření z předchozí návštěvy); NULL = první návštěva.';
COMMENT ON COLUMN changes_view.last_open_at IS
  'Poslední otevření obrazovky Dnes.';

ALTER TABLE changes_view ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS changes_view_own_select ON changes_view;
CREATE POLICY changes_view_own_select ON changes_view FOR SELECT
  USING (member_id = (SELECT auth.uid()) AND (SELECT is_team_member()));

-- Bez INSERT/UPDATE/DELETE politik (default-deny): zápis jen přes RPC níže.

DROP POLICY IF EXISTS require_aal2 ON changes_view;
CREATE POLICY require_aal2 ON changes_view
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON changes_view FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON changes_view FROM authenticated;
GRANT SELECT ON changes_view TO authenticated;

-- Zaznamená otevření obrazovky a vrátí platný začátek okna. Volá ji aplikace
-- z prohlížeče po vykreslení Dnes (server akce touchChangesView).
-- SECURITY DEFINER: klient nemá právo zápisu; funkce zapisuje výhradně řádek
-- volajícího (auth.uid()), takže cizí řádek nejde ovlivnit. Vlastní kontrola
-- AAL2 a členství v týmu je druhá pojistka vedle RESTRICTIVE politiky, kterou
-- SECURITY DEFINER obchází.
CREATE OR REPLACE FUNCTION touch_changes_view()
RETURNS TABLE (seen_baseline timestamptz, seen_last_open timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'touch_changes_view: chybí přihlášený uživatel' USING ERRCODE = '42501';
  END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'touch_changes_view: vyžaduje AAL2 (dvoufázové ověření)' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = v_uid) THEN
    RAISE EXCEPTION 'touch_changes_view: jen člen týmu' USING ERRCODE = '42501';
  END IF;

  -- Pravidlo návštěvy (240 minut) — viz hlavička. Na pravé straně SET jsou
  -- hodnoty starého řádku (cv.*), takže baseline dostane PŘEDCHOZÍ otevření.
  RETURN QUERY
  INSERT INTO changes_view AS cv (member_id, baseline_at, last_open_at)
  VALUES (v_uid, NULL, now())
  ON CONFLICT (member_id) DO UPDATE SET
    baseline_at = CASE
      WHEN now() - cv.last_open_at > interval '240 minutes' THEN cv.last_open_at
      ELSE cv.baseline_at
    END,
    last_open_at = now()
  RETURNING cv.baseline_at, cv.last_open_at;
END $$;

REVOKE ALL ON FUNCTION touch_changes_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION touch_changes_view() TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0075', 'changes_view - cas posledniho zobrazeni obrazovky Dnes per clen tymu (okno Co se zmenilo), zapis jen pres touch_changes_view() (SECURITY DEFINER, AAL2), cteni jen vlastniho radku')
ON CONFLICT (version) DO NOTHING;
