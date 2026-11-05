-- 0058 — Obchody a částky vidí jen obchodní role (rozhodnutí majitele
-- 2026-09-28) + mazání kontaktů jen pro admina.
--
-- ROZHODNUTÍ: lidé bez obchodní role (projektak, lektor, partner) NESMÍ vidět
-- obchody (deal) ani jejich částky. Vidí je jen 'vedeni' a 'obchodnik' —
-- tedy přesně can_see_sales() z 0020. Dosud to hlídalo jen UI (redirecty
-- a seesByznys v lib/domain.ts); tabulka deal měla od 0003 permisivní
-- politiku pro kohokoli z týmu, takže projekťák si částky mohl přečíst
-- přímo přes PostgREST. Tady se to vynucuje v DATABÁZI.
--
-- CO SE MĚNÍ
--
-- 1) deal a deal_partner (a v 1b subscription): nová RESTRICTIVE politika sales_only FOR ALL
--    (SELECT/INSERT/UPDATE/DELETE) s can_see_sales(). Přidává se VEDLE
--    stávajících politik — permisivní biz_all (0003, is_team_member) i
--    RESTRICTIVE require_aal2 (0007) zůstávají beze změny. Výsledek:
--    člen týmu AND AAL2 AND obchodní role.
--    service_role (cron, digest, API v1 přes admin klienta) RLS obchází —
--    beze změny. FK kontroly a kaskády (engagement.deal_id, task.deal_id,
--    work_case.deal_id, smazání účtu) běží jako vlastník tabulky, takže
--    nejsou RLS dotčené.
--
-- 1b) subscription: stejná RESTRICTIVE sales_only (předplatné nese MRR,
--    počet licencí a obnovy — obchodní čísla). Detail klienta sekci
--    předplatného ne-obchodním rolím už skrývá, úprava předplatného je
--    přesměruje; tady se to vynucuje v DB. v_account_rollup a v_mrr_health
--    (security_invoker, bod 3) pak ne-obchodním rolím dávají nuly.
--    Samostatná tabulka nabídek (offer) NEEXISTUJE — importovaná nabídka
--    (domain/crm/actions/offers.ts) se ukládá jako řádek deal, takže ji
--    pokrývá bod 1; PDF leží v storage bucketu nabidky (jen service role).
--
-- 2) deal_public(p_account_id): úzké okno pro dodávkové role. Dodávka
--    (engagement, milníky, předávací balíček, případy Loop Core) potřebuje
--    znát název navázaného obchodu a jestli je „vyhráno" — nic víc.
--    PROČ FUNKCE A NE POHLED: pohled bez security_invoker by obcházel RLS
--    celé tabulky a AAL2 by se v něm hlídal jen WHERE podmínkou, kterou
--    snadno rozbije budoucí CREATE OR REPLACE VIEW (viz bod 3 — přesně to se
--    stalo v_account_rollup). SECURITY DEFINER funkce má explicitní bránu
--    na začátku (přihlášený + AAL2 + člen týmu, vzor loop_actor z 0039),
--    pevný search_path a vrací JEN sloupce id, account_id, title, is_won.
--    Žádné částky, pravděpodobnost, fáze, další kroky ani vlastník.
--    p_account_id NULL = všechny firmy (výběr obchodu u nového případu).
--    Volání: supabase.rpc('deal_public', { p_account_id: 12 }).
--
-- 3) Pohledy nad deal znovu security_invoker = on. 0004 je přepnula, ale
--    CREATE OR REPLACE VIEW bez WITH (…) v 0025 a 0027 nahradil volby
--    pohledu prázdným seznamem → v_account_rollup od té doby běží s právy
--    vlastníka, obchází RLS a prozrazuje contracted_one_time komukoli
--    z týmu. Tady se volba znovu nastaví všem pohledům z 0001/0046
--    (ALTER VIEW … SET je idempotentní; chybějící pohled se přeskočí).
--
-- 4) contact: permisivní FOR ALL (biz_all z 0003) se rozdělí na SELECT,
--    INSERT, UPDATE pro tým (is_team_member) a DELETE jen pro admina
--    (is_admin, 0005). RESTRICTIVE require_aal2 z 0007 zůstává. Server
--    akce deleteContact/deletePartnerContact už admina kontrolují v TS;
--    tohle je pojistka v DB. Samostatná tabulka partner_contact neexistuje
--    (partnerský kontakt = contact s partner_id, 0019), pravidlo tedy
--    pokrývá i partnerské kontakty.
--
-- DOPAD NA NEOBCHODNÍ ROLE (méně řádků, žádné chyby — PostgREST vrací
-- prázdnou množinu, embed deal:… vrací null):
--   * / (Projekty tab) → ne-obchodní role dostanou přehled z dodávek
--     (getDeliveryProjects), getAllProjects čtou jen obchodní role.
--   * /clients, /clients/[id], /tasks, /hledat → UI sekce obchodů skrývá
--     (canCurrentUserSeeSales), nic prázdného se nevykresluje.
--   * /pripady/nova nenabídne obchod (připojit ho smí jen obchodní role).
--   * vytvoření úkolu s deal_id neprojde kontrolou firmy; předplatné
--     (1b) ne-obchodní role nečte ani nezapisuje (akce to hlásí předem).
--   * předání do realizace, výběr obchodu u dodávky, dashboard Projekty
--     a název obchodu u případu jedou přes deal_public (TS padá na přímé
--     čtení deal, dokud tahle migrace neběží).
--   * v_account_rollup, v_pipeline_by_line, v_partner_attribution,
--     v_contracted_over_time, v_mrr_health → nuly/prázdno (jen /pipeline,
--     která je obchodním rolím).
--
-- ZÁVISLOSTI: 0003 (RLS), 0005 (is_admin), 0007 (AAL2), 0020
-- (can_see_sales). Guard níže skončí srozumitelnou chybou.
-- Idempotentní: DROP POLICY IF EXISTS + CREATE, CREATE OR REPLACE,
-- ALTER VIEW … SET, ON CONFLICT DO NOTHING.

DO $$
BEGIN
  IF to_regclass('public.deal') IS NULL
     OR to_regclass('public.deal_partner') IS NULL
     OR to_regclass('public.subscription') IS NULL
     OR to_regclass('public.contact') IS NULL THEN
    RAISE EXCEPTION '0058 vyžaduje tabulky deal, deal_partner, subscription a contact — nejdřív aplikujte 0001_base_schema.sql';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0058 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION '0058 vyžaduje funkci is_admin() — nejdřív aplikujte 0005_admin_flag.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0058 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0058 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) deal + deal_partner: jen obchodní role
--
-- Volání v politikách jsou zabalená do (SELECT …): Postgres je pak vyhodnotí
-- jednou za dotaz (initPlan), ne pro každý řádek. Funkce nemají argumenty
-- z řádku, takže výsledek je stejný.

DROP POLICY IF EXISTS sales_only ON deal;
CREATE POLICY sales_only ON deal AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

DROP POLICY IF EXISTS sales_only ON deal_partner;
CREATE POLICY sales_only ON deal_partner AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

-- 1b) subscription (MRR): jen obchodní role
DROP POLICY IF EXISTS sales_only ON subscription;
CREATE POLICY sales_only ON subscription AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

-- ---------------------------------------------------------------------------
-- 2) deal_public: název + „vyhráno" pro dodávku, bez částek

CREATE OR REPLACE FUNCTION deal_public(p_account_id bigint DEFAULT NULL)
RETURNS TABLE (id bigint, account_id bigint, title text, is_won boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- SECURITY DEFINER obchází RLS včetně RESTRICTIVE AAL2 → brána tady.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nepřihlášený uživatel' USING ERRCODE = '42501';
  END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'Vyžadováno dvoufázové ověření (AAL2)' USING ERRCODE = '42501';
  END IF;
  IF NOT is_team_member() THEN
    RAISE EXCEPTION 'Jen pro člena týmu' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT d.id, d.account_id, d.title, (d.stage::text = 'vyhráno') AS is_won
  FROM deal d
  WHERE p_account_id IS NULL OR d.account_id = p_account_id
  ORDER BY d.title, d.id;
END $$;

REVOKE ALL ON FUNCTION deal_public(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION deal_public(bigint) FROM anon;
GRANT EXECUTE ON FUNCTION deal_public(bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) Pohledy nad deal zpět na security_invoker (RLS dotazujícího)

DO $$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'v_account_rollup', 'v_pipeline_by_line', 'v_partner_attribution',
    'v_mrr_health', 'v_delivery_health', 'v_reference_pipeline',
    'v_contracted_over_time', 'v_impact_summary'
  ] LOOP
    IF to_regclass('public.' || v) IS NOT NULL THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = on)', v);
    ELSE
      RAISE NOTICE '0058: pohled % neexistuje, přeskakuji', v;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4) contact: tým čte/zakládá/upravuje, maže jen admin

DROP POLICY IF EXISTS biz_all ON contact;
DROP POLICY IF EXISTS contact_select ON contact;
DROP POLICY IF EXISTS contact_insert ON contact;
DROP POLICY IF EXISTS contact_update ON contact;
DROP POLICY IF EXISTS contact_delete_admin ON contact;

CREATE POLICY contact_select ON contact FOR SELECT
  USING ((SELECT is_team_member()));
CREATE POLICY contact_insert ON contact FOR INSERT
  WITH CHECK ((SELECT is_team_member()));
CREATE POLICY contact_update ON contact FOR UPDATE
  USING ((SELECT is_team_member()))
  WITH CHECK ((SELECT is_team_member()));
CREATE POLICY contact_delete_admin ON contact FOR DELETE
  USING ((SELECT is_team_member()) AND (SELECT is_admin()));

-- require_aal2 (RESTRICTIVE, 0007) na contact zůstává. Kdyby prostředí 0007
-- ještě nemělo (MFA odložené), nic se tu nepřidává — stejné chování jako
-- zbytek tabulek z 0003.

INSERT INTO schema_migration (version, note)
VALUES ('0058', 'deal/deal_partner/subscription jen can_see_sales (RESTRICTIVE), deal_public RPC, pohledy security_invoker, contact DELETE jen admin')
ON CONFLICT (version) DO NOTHING;
