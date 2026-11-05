-- 0068 — indexy a pomocné objekty pro stránkovaný seznam klientů (/clients)
-- a hledání firmy ve formulářích.
--
-- PROČ: po importu Obchodního radaru (28. 9. 2026) má produkce ~663 firem
-- (3 aktivní klienti, zbytek prospekty). /clients dosud natáhl všechny řádky
-- i s embedy a filtroval v JS; výběry firmy ve formulářích (úkol, aktivita,
-- případ, schůzka, cílový seznam, vztah firem, nový obchod) posílaly do
-- prohlížeče celý seznam. Aplikace teď stránkuje po 50 a filtruje/řadí
-- v databázi (domain/crm/queries/accountList.ts) a výběr firmy hledá
-- serverově po 20 (components/AccountPicker.tsx). Tabulka je malá, takže
-- indexy nejsou otázkou přežití — ale dotazy se tím nezmění ani při
-- desetinásobku firem.
--
-- CO SE PŘIDÁVÁ
--
-- 1) last_contact_at(account) — „počítaný sloupec" PostgRESTu pro řazení
--    podle poslední aktivity: GREATEST(last_inbound_at, last_outbound_at)
--    (data korespondence z 0030/0041; NULL se v GREATEST ignoruje).
--    PostgREST ho umí v order=… i select=… (funkce nad řádkovým typem).
--    LANGUAGE sql IMMUTABLE BEZ vlastního SET search_path — záměrně: jen tak
--    ji planner inlinuje a index z bodu 4 se dá použít. Tělo nepřeklápí
--    žádné jméno přes search_path (GREATEST je syntaxe, $1.sloupec je pole
--    argumentu), takže podvržený objekt v search_path nemá čím zneužít.
--    SECURITY INVOKER (výchozí) — RLS tabulky account platí dál.
--    Bez 0068 aplikace řadí podle last_outbound_at, last_inbound_at
--    (index z 0030) a ukáže klidnou poznámku.
--
-- 2) v_account_list_facets — hodnoty pro filtry a počty do hlavičky jedním
--    dotazem místo načtení všech firem: obor (prefix před „ – ", stejně jako
--    industryPrefix v domain/crm/accountList.ts), region, celkový počet
--    a počet firem bez IČO (NULL nebo ''). security_invoker = on (vzor
--    0004/0046): RLS (člen týmu + RESTRICTIVE AAL2 z 0007) platí i přes
--    pohled. Bez 0068 aplikace spočítá totéž v JS z úzkého výběru
--    (industry, region, ico).
--
-- 3) B-tree indexy pro filtry a řazení seznamu:
--      account_name_id_idx          ORDER BY name, id (výchozí řazení,
--                                   stabilní stránkování) + výběr firmy
--      account_industry_pattern_idx industry = 'X' OR industry LIKE 'X – %'
--                                   (text_pattern_ops umí = i LIKE prefix)
--      account_region_idx           region = …
--      account_owner_id_idx         owner_id = … / IS NULL (a FK ON DELETE
--                                   SET NULL z team_member)
--      account_client_since_idx     stav „klient" (client_since IS NOT NULL),
--                                   částečný — klientů je pár
--
-- 4) account_last_contact_idx — výraz GREATEST(…) DESC NULLS LAST pro
--    řazení podle poslední aktivity (bod 1).
--
-- 5) Trigramové GIN indexy na name a ico (hledání ILIKE '%…%'), JEN když je
--    rozšíření pg_trgm nainstalované. Tahle migrace ho sama NEZAPÍNÁ
--    (rozšíření je rozhodnutí správce databáze, ne vedlejší efekt migrace).
--    Proč ne lower(name) text_pattern_ops: hledání je podřetězec
--    („%acme%"), B-tree pomůže jen prefixu („acme%") — pro ILIKE uprostřed
--    textu umí index jen trigramy. Bez pg_trgm se hledá sekvenčním čtením,
--    což je u stovek řádků pod milisekundu. Po zapnutí rozšíření
--    (Dashboard → Database → Extensions → pg_trgm) stačí tenhle soubor
--    spustit znovu ručně — je idempotentní.
--
-- CONCURRENTLY: nejde uvnitř transakce (scripts/migrate.mjs obaluje každý
-- soubor transakcí). Tabulka má stovky řádků, obyčejný CREATE INDEX drží
-- zámek zlomek sekundy.
--
-- ZÁVISLOSTI: 0001 (account), 0011 (region, ico, owner_id, client_since),
-- 0030 (last_inbound_at, last_outbound_at), 0026 (schema_migration).
-- Guard níže skončí srozumitelnou chybou.
-- Idempotentní: CREATE OR REPLACE, CREATE INDEX IF NOT EXISTS,
-- ALTER VIEW … SET, ON CONFLICT DO NOTHING.

DO $$
BEGIN
  IF to_regclass('public.account') IS NULL THEN
    RAISE EXCEPTION '0068 vyžaduje tabulku account — nejdřív aplikujte 0001_base_schema.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account'
      AND column_name IN ('region', 'ico', 'owner_id', 'client_since')
    HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION '0068 vyžaduje sloupce account.region/ico/owner_id/client_since — nejdřív aplikujte 0011_account_rich.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'account'
      AND column_name IN ('last_inbound_at', 'last_outbound_at')
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION '0068 vyžaduje sloupce account.last_inbound_at/last_outbound_at — nejdřív aplikujte 0030_relationship_state.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0068 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) last_contact_at(account): poslední kontakt v korespondenci

CREATE OR REPLACE FUNCTION public.last_contact_at(a public.account)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT GREATEST(a.last_inbound_at, a.last_outbound_at)
$$;

REVOKE ALL ON FUNCTION public.last_contact_at(public.account) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.last_contact_at(public.account) FROM anon;
GRANT EXECUTE ON FUNCTION public.last_contact_at(public.account) TO authenticated;
GRANT EXECUTE ON FUNCTION public.last_contact_at(public.account) TO service_role;

-- ---------------------------------------------------------------------------
-- 2) v_account_list_facets: hodnoty filtrů + počty do hlavičky

CREATE OR REPLACE VIEW v_account_list_facets
WITH (security_invoker = on) AS
SELECT 'industry'::text AS kind, f.value, count(*)::bigint AS n
FROM (
  SELECT split_part(a.industry, ' – ', 1) AS value
  FROM account a
  WHERE a.industry IS NOT NULL AND a.industry <> ''
) f
WHERE f.value <> ''
GROUP BY f.value
UNION ALL
SELECT 'region'::text, a.region, count(*)::bigint
FROM account a
WHERE a.region IS NOT NULL AND a.region <> ''
GROUP BY a.region
UNION ALL
SELECT 'total'::text, NULL::text, count(*)::bigint
FROM account
UNION ALL
SELECT 'missing_ico'::text, NULL::text, count(*)::bigint
FROM account
WHERE ico IS NULL OR ico = '';

-- CREATE OR REPLACE nemusí zachovat reloptions u existujícího pohledu (0058).
ALTER VIEW v_account_list_facets SET (security_invoker = on);

REVOKE ALL ON v_account_list_facets FROM anon;
GRANT SELECT ON v_account_list_facets TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) B-tree indexy pro filtry a řazení

CREATE INDEX IF NOT EXISTS account_name_id_idx ON account (name, id);
CREATE INDEX IF NOT EXISTS account_industry_pattern_idx ON account (industry text_pattern_ops);
CREATE INDEX IF NOT EXISTS account_region_idx ON account (region);
CREATE INDEX IF NOT EXISTS account_owner_id_idx ON account (owner_id);
CREATE INDEX IF NOT EXISTS account_client_since_idx ON account (client_since)
  WHERE client_since IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) Řazení podle poslední aktivity (výraz z last_contact_at)

CREATE INDEX IF NOT EXISTS account_last_contact_idx
  ON account ((GREATEST(last_inbound_at, last_outbound_at)) DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- 5) Trigramy pro hledání podřetězce — jen s nainstalovaným pg_trgm

DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';

  IF v_schema IS NULL THEN
    RAISE NOTICE '0068: rozšíření pg_trgm není nainstalované — trigramové indexy přeskakuji. Hledání funguje i bez nich; po zapnutí pg_trgm stačí 0068 spustit znovu.';
    RETURN;
  END IF;

  -- Třída operátorů leží ve schématu rozšíření (na Supabase „extensions"),
  -- proto kvalifikovaně přes format(%I).
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS account_name_trgm_idx ON public.account USING gin (name %I.gin_trgm_ops)',
    v_schema);
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS account_ico_trgm_idx ON public.account USING gin (ico %I.gin_trgm_ops)',
    v_schema);
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0068', 'account: indexy pro stránkovaný seznam, last_contact_at(account), v_account_list_facets, trigramy jen s pg_trgm')
ON CONFLICT (version) DO NOTHING;
