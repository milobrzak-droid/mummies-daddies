-- 0082 — audit zbylých tabulek (nikdy neblokuje zápis) + role Partner bez čtení
-- interní evidence.
--
-- Dvě samostatné věci v jedné migraci, protože obě patří k „před prvním
-- externím účtem" (P0.4 z revize stavu) a obě sahají na stejné místo —
-- viditelnost audit_event a helper is_team_member().
--
-- ===========================================================================
-- A) AUDIT TABULEK, KTERÉ 0064 NEPOKRYLA
-- ===========================================================================
--
-- Nově kryté: financial_record, allocation, metric_observation,
-- case_proposal, deal_scope_version, deal_partner, loop_node a team_member
-- (změny role, is_admin, manažera a deaktivace, vznik a smazání člena).
-- authority_policy už kryje 0064 (trigger audit_row_change), tady se nemění.
--
-- KONVENCE = 0064: jen NÁZVY změněných sloupců (`_columns`) a HODNOTY sloupců
-- z allow-listu triggeru (id, cizí klíče, stavy, data, booleany, čísla).
-- Nikdy jméno, e-mail, telefon, volný text, číslo dokladu ani odkaz — audit_event
-- nemá retenci ani výmaz. E-mail člena týmu se v auditu neobjeví nikdy ani
-- jako hodnota (změna e-mailu je vidět jen jako název sloupce `email`).
-- Nový sloupec, který nikdo do allow-listu nepřidá, se zapíše jen názvem.
--
-- AUDIT NESMÍ BLOKOVAT ZÁPIS (rozdíl proti 0064!). Trigger 0064
-- audit_row_change() záměrně nechytá výjimky („radši neprovedená změna než
-- změna bez původu") — chyba audit_event tam shodí i obchodní transakci.
-- Tahle migrace pro NOVÉ tabulky zavádí opačné pravidlo, jak požaduje
-- zadání: trigger audit_row_change_soft() obalí zápis do audit_event
-- vnořeným blokem s EXCEPTION. Chyba (špatná hodnota, chybějící evidence,
-- plný disk, zamčená tabulka…) se jen ohlásí varováním (WARNING v logu
-- Postgresu, bez dat řádku — jen SQLSTATE, tabulka a operace) a původní
-- změna projde bez stopy. Cena: vnořená transakce na každý řádek (tabulky
-- jsou malé) a možnost změny bez záznamu — proto se varování nesmí
-- ztratit z logu. Stávajících 21 tabulek z 0064 zůstává fail-closed; jestli
-- je sjednotit, je rozhodnutí majitele (docs/PROVOZ.md, „Dva režimy").
-- Logika výběru hodnot je stejná jako v 0064 (kopie audit_row_change v
-- audit_row_record, protože trigger funkci nejde volat z jiné funkce);
-- audit_request_context() a audit_pick() se používají z 0064 beze změny.
--
-- KLÍČE JINÉHO TVARU než bigint id: audit_event.entity_id je bigint NOT NULL
-- (0028), proto 0064 vynechala deal_partner (složený klíč), team_member
-- (uuid) a loop_node (text). Tady: nový sloupec audit_event.entity_ref text,
-- entity_id se smí být NULL a CHECK audit_event_entity_check hlídá, že je
-- vyplněné aspoň jedno z nich. Tabulky s klíčem mimo bigint id mají
-- entity_id NULL a entity_ref = hodnoty klíče spojené dvojtečkou
-- (`deal_id:partner_id:program`, uuid člena, kód uzlu). Čtenáři audit_event
-- v aplikaci vždy filtrují entity_table/action a čtou řádky s entity_id,
-- takže řádky s entity_ref jim nepřijdou do cesty.
--
-- AKTÉR: jako v 0064 (audit_request_context). Zápisy do team_member z aplikace
-- jdou přes servisní klíč (lib/actions/team.ts) — od téhle změny přes
-- admin klienta s hlavičkou aktéra `x-cockpit-audit-actor` (lokální `adminActingAs`, protože lib/ nesmí importovat core/), takže řádek nese admina, který
-- roli změnil; bez hlavičky by byl aktér `system` / `db-trigger:service_role`.
-- RPC set_team_member_admin běží pod přihlášeným adminem (auth.uid()).
-- Guard team_member_guard_privileged (0069/0073) je BEFORE UPDATE a audit je
-- AFTER trigger SECURITY DEFINER — nezasahují do sebe a oprávnění zápisu do
-- team_member se tu nemění (authenticated dál nezapisuje vůbec).
--
-- VIDITELNOST: audit_event čte tým s AAL2 (0028). Řádky entit deal,
-- deal_partner a subscription vidí jen obchodní role (0064/0069). Tady se
-- k nim přidává financial_record a deal_scope_version (částky, rozsah
-- nabídky) — nová RESTRICTIVE politika audit_event_sales_only_fin.
--
-- ===========================================================================
-- B) ROLE PARTNER NESMÍ ČÍST INTERNÍ EVIDENCI
-- ===========================================================================
--
-- PROBLÉM: is_team_member() (0002/0069) vracela true pro KAŽDÉHO člena
-- team_member, tedy i pro roli 'partner'. Na is_team_member() stojí čtecí
-- (a většinou i zápisové) politiky všech tabulek, takže Partner měl stejný
-- rozsah jako Projekťák: všechny firmy, kontakty, dodávky, úkoly, případy,
-- kapacity, cílové seznamy… Obchody a peníze mu bránilo jen can_see_sales()
-- (0058), interní evidenci nic.
--
-- ŘEŠENÍ NA JEDNOM MÍSTĚ: is_team_member() dál platí jen pro interní role
-- (vedeni, obchodnik, projektak, lektor) a aktivní členy. Allowlist, ne
-- výčet zakázaných: nová role v enumu team_role je bez úpravy téhle funkce
-- vyloučená (fail closed). Dopad bez další změny politik:
--   * RLS všech tabulek s is_team_member() (account, contact, engagement,
--     task, work_case, allocation, audit_event, team_member…) Partnerovi
--     nevrací nic a zápis odmítne;
--   * funkce s bránou is_team_member() (loop_actor → celý Loop Core,
--     deal_public, set_weekly_capacity, touch_changes_view, …) skončí
--     SQLSTATE 42501;
--   * team_member.team_read (jména a role kolegů) Partnerovi nic neukáže; vlastní
--     řádek čte přes team_self_read (níže).
-- is_admin() dostává stejnou podmínku roli — admin příznak u externího účtu
-- nemá nic dávat. can_see_sales() už Partnera vylučuje (vedeni, obchodnik).
--
-- CO ZŮSTÁVÁ: přihlášení, MFA a změna vlastního hesla (Supabase Auth, ne
-- tabulky); vlastní řádek calendar_token (politika member_id = auth.uid()).
-- Aplikace Partnera po přihlášení pošle na obrazovku „bez přístupu"
-- (app/(app)/layout.tsx) a server akce ho odmítne v requireUser.
--
-- ROZŠÍŘENÍ o výslovné sdílení konkrétní firmy/projektu se tu NEDĚLÁ (bez
-- testovací databáze by to byl složitý nový model); návrh je v
-- docs/PROVOZ.md.
--
-- PŘED APLIKACÍ (ručně v produkci): každý člen s role = 'partner' po téhle
-- migraci ztratí přístup ke všemu. Migrace jich napočítá a ohlásí NOTICE;
-- dotaz: SELECT id, email FROM team_member
--        WHERE role::text = 'partner' AND deactivated_at IS NULL;
-- Kdo z nich má pracovat s interní evidencí, přeřaďte na /tym na skutečnou
-- roli PŘED nasazením. Nový člen od 0056 dostává výchozí roli 'partner' —
-- do přeřazení adminem tedy nic nevidí (to je záměr).
--
-- Pohledy: kontrola na konci jen VAROVÁNÍM ohlásí veřejný pohled bez
-- security_invoker (takový by RLS obešel a Partnerovi něco vydal).
--
-- ZÁVISLOSTI: 0028, 0038 (audit_event, evidence_id/info_state), 0064
-- (audit_row_change, audit_request_context, audit_pick), 0069
-- (team_member.deactivated_at), 0020 (can_see_sales), 0005 (is_admin), 0026
-- (ledger) a tabulky z 0001, 0039, 0061, 0062, 0063, 0067, 0072. Guard níže
-- skončí srozumitelnou chybou. Idempotentní: ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE, DROP … IF EXISTS + CREATE, ON CONFLICT.
-- Zámky: ALTER audit_event (ADD COLUMN, DROP NOT NULL, CHECK nad malou
-- tabulkou) krátký ACCESS EXCLUSIVE; CREATE TRIGGER krátký SHARE ROW
-- EXCLUSIVE na každé tabulce; data se nepřepisují.

DO $$
DECLARE
  v_req text[];
  v_partners integer;
BEGIN
  IF to_regclass('public.audit_event') IS NULL THEN
    RAISE EXCEPTION '0082 vyžaduje tabulku public.audit_event — nejdřív aplikujte 0028_audit_event.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'audit_event' AND column_name = 'evidence_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'audit_event' AND column_name = 'info_state') THEN
    RAISE EXCEPTION '0082 vyžaduje audit_event.evidence_id/info_state — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change()') IS NULL
     OR to_regprocedure('public.audit_request_context()') IS NULL
     OR to_regprocedure('public.audit_pick(jsonb, text[], text[])') IS NULL THEN
    RAISE EXCEPTION '0082 vyžaduje audit_row_change(), audit_request_context() a audit_pick() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regclass('public.team_member') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'team_member' AND column_name = 'deactivated_at') THEN
    RAISE EXCEPTION '0082 vyžaduje team_member.deactivated_at — nejdřív aplikujte 0069_security_fixes.sql';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0082 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION '0082 vyžaduje funkci is_admin() — nejdřív aplikujte 0005_admin_flag.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0082 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0082 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  FOREACH v_req SLICE 1 IN ARRAY ARRAY[
    ['deal_partner', '0001_base_schema.sql'],
    ['loop_node', '0039_loop_core.sql'],
    ['metric_observation', '0061_delivery_impact.sql'],
    ['allocation', '0062_capacity.sql'],
    ['financial_record', '0063_financial_record.sql'],
    ['case_proposal', '0067_case_proposal.sql'],
    ['deal_scope_version', '0072_deal_scope_version.sql']
  ] LOOP
    IF to_regclass('public.' || v_req[1]) IS NULL THEN
      RAISE EXCEPTION '0082 vyžaduje tabulku public.% — nejdřív aplikujte %', v_req[1], v_req[2];
    END IF;
  END LOOP;

  SELECT count(*) INTO v_partners FROM team_member
   WHERE role::text = 'partner' AND deactivated_at IS NULL;
  IF v_partners > 0 THEN
    RAISE NOTICE '0082: % aktivních členů s rolí partner po téhle migraci ztratí přístup k interní evidenci — zkontrolujte SELECT id, email FROM team_member WHERE role::text = ''partner'' AND deactivated_at IS NULL', v_partners;
  END IF;
END $$;

-- ===========================================================================
-- 1) audit_event: klíč jiného tvaru než bigint id
-- ===========================================================================

ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS entity_ref text;
ALTER TABLE audit_event ALTER COLUMN entity_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.audit_event'::regclass AND conname = 'audit_event_entity_check') THEN
    ALTER TABLE audit_event
      ADD CONSTRAINT audit_event_entity_check
      CHECK ((entity_id IS NOT NULL OR entity_ref IS NOT NULL)
             AND (entity_ref IS NULL OR char_length(entity_ref) BETWEEN 1 AND 200));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audit_event_entity_ref_idx
  ON audit_event(entity_table, entity_ref, occurred_at DESC) WHERE entity_ref IS NOT NULL;

COMMENT ON COLUMN audit_event.entity_ref IS
  'Klíč entity, která nemá bigint id (uuid člena, kód uzlu, složený klíč deal_partner jako deal_id:partner_id:program). Pak je entity_id NULL.';

-- ===========================================================================
-- 2) Zápis auditní události (logika jako audit_row_change z 0064) + trigger,
--    který chybu zápisu nikdy nepustí ven
-- ===========================================================================

-- Argumenty:
--   p_safe    allow-list sloupců, jejichž HODNOTY smí do auditu
--   p_ignore  sloupce, jejichž samotná změna není auditní událost (updated_at vždy)
--   p_evcol   sloupec s id evidence (nebo NULL)
--   p_key     sloupce klíče, když entita nemá bigint id (NULL = sloupec id)
-- Volá se jen z audit_row_change_soft(); SECURITY DEFINER, protože
-- audit_event nemá INSERT politiku (0028) a vlastník funkce RLS obchází.
CREATE OR REPLACE FUNCTION audit_row_record(
  p_table  text,
  p_op     text,
  p_old    jsonb,
  p_new    jsonb,
  p_safe   text[],
  p_ignore text[],
  p_evcol  text,
  p_key    text[]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_safe     text[] := coalesce(p_safe, '{}');
  v_ignore   text[] := ARRAY['updated_at'] || coalesce(p_ignore, '{}');
  v_row      jsonb;
  v_cols     text[];
  v_before   jsonb;
  v_after    jsonb;
  v_verb     text;
  v_ctx      record;
  v_evidence bigint;
  v_id       bigint;
  v_ref      text;
BEGIN
  IF p_op = 'UPDATE' THEN
    v_row := p_new;
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}') INTO v_cols
    FROM jsonb_each(v_row) AS n
    WHERE n.value IS DISTINCT FROM (p_old -> n.key)
      AND n.key <> ALL (v_ignore);
    IF cardinality(v_cols) = 0 THEN
      RETURN;
    END IF;
    v_before := audit_pick(p_old, v_cols, v_safe);
    v_after  := audit_pick(v_row, v_cols, v_safe) || jsonb_build_object('_columns', to_jsonb(v_cols));
    v_verb   := 'updated';
  ELSE
    v_row := CASE WHEN p_op = 'INSERT' THEN p_new ELSE p_old END;
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}') INTO v_cols
    FROM jsonb_each(v_row) AS n
    WHERE n.value <> 'null'::jsonb
      AND n.key <> ALL (ARRAY['id', 'created_at', 'updated_at']);
    IF p_op = 'INSERT' THEN
      v_after := audit_pick(v_row, v_cols, v_safe) || jsonb_build_object('_columns', to_jsonb(v_cols));
      v_verb  := 'created';
    ELSE
      v_before := audit_pick(v_row, v_cols, v_safe) || jsonb_build_object('_columns', to_jsonb(v_cols));
      v_verb   := 'deleted';
    END IF;
  END IF;

  IF p_key IS NULL OR cardinality(p_key) = 0 THEN
    v_id := (v_row ->> 'id')::bigint;
  ELSE
    SELECT string_agg(coalesce(v_row ->> t.k, ''), ':' ORDER BY t.ord) INTO v_ref
    FROM unnest(p_key) WITH ORDINALITY AS t(k, ord);
  END IF;

  SELECT * INTO v_ctx FROM audit_request_context();
  v_evidence := v_ctx.evidence_id;
  IF v_evidence IS NULL AND p_evcol IS NOT NULL AND p_op <> 'DELETE' AND p_evcol = ANY (v_cols) THEN
    v_evidence := (v_row ->> p_evcol)::bigint;
  END IF;

  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, entity_ref, before, after, evidence_id, info_state)
  VALUES (
    v_ctx.actor_type, v_ctx.actor_id, p_table || '.' || v_verb, p_table,
    v_id, v_ref, v_before, v_after, v_evidence, v_ctx.info_state
  );
END $$;

REVOKE ALL ON FUNCTION audit_row_record(text, text, jsonb, jsonb, text[], text[], text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_row_record(text, text, jsonb, jsonb, text[], text[], text, text[]) FROM anon, authenticated;

-- Trigger (AFTER … FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(a, b, c, d)):
--   a  allow-list sloupců, jejichž HODNOTY smí do auditu (čárkami, bez mezer)
--   b  ignorované sloupce (jejich samotná změna není událost; updated_at vždy)
--   c  sloupec s id evidence (nebo '')
--   d  sloupce klíče entity bez bigint id (nebo '')
-- Chyba zápisu auditu se zachytí a změna projde (viz hlavička, sekce A).
CREATE OR REPLACE FUNCTION audit_row_change_soft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new := to_jsonb(NEW); END IF;
  BEGIN
    PERFORM audit_row_record(
      TG_TABLE_NAME, TG_OP, v_old, v_new,
      string_to_array(nullif(TG_ARGV[0], ''), ','),
      string_to_array(nullif(TG_ARGV[1], ''), ','),
      nullif(TG_ARGV[2], ''),
      string_to_array(nullif(TG_ARGV[3], ''), ','));
  EXCEPTION WHEN OTHERS THEN
    -- Jen SQLSTATE, tabulka a operace: text výjimky může nést hodnoty řádku.
    RAISE WARNING '0082: audit % na % selhal (SQLSTATE %), zápis pokračuje bez stopy v audit_event',
      TG_OP, TG_TABLE_NAME, SQLSTATE;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION audit_row_change_soft() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_row_change_soft() FROM anon, authenticated;

-- ===========================================================================
-- 3) Napojení tabulek (MUSÍ sedět s DB_AUDITED_TABLES v core/auditCoverage.ts,
--    položky se `soft: true`)
-- ===========================================================================

-- allocation: kdo kolik hodin na čem; poznámka je volný text → jen názvem.
DROP TRIGGER IF EXISTS audit_row_change_soft ON allocation;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON allocation
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'created_by,ends_on,engagement_id,hours_per_week,member_id,starts_on,substitute_id,work_case_id',
    '',
    '',
    '');

-- case_proposal: název, zdůvodnění, kroky, poznámka rozhodnutí a klíč zdroje
-- (může nést identifikátor zprávy) jen názvem. Doklad = evidence_id.
DROP TRIGGER IF EXISTS audit_row_change_soft ON case_proposal;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON case_proposal
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,capability,created_by,decided_at,decided_by,evidence_id,info_state,method,node,occurred_at,status,work_case_id',
    '',
    'evidence_id',
    '');

-- deal_partner: složený klíč → entity_ref `deal_id:partner_id:program`.
DROP TRIGGER IF EXISTS audit_row_change_soft ON deal_partner;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON deal_partner
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'attribution_pct,deal_id,is_sourcing,nnpsa_target,partner_id,program',
    '',
    '',
    'deal_id,partner_id,program');

-- deal_scope_version: rozsah (text) jen názvem, částky a stav s hodnotou;
-- řádky auditu vidí jen obchodní role (audit_event_sales_only_fin).
DROP TRIGGER IF EXISTS audit_row_change_soft ON deal_scope_version;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON deal_scope_version
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'amount_one_time,created_by,currency,deal_id,decided_at,evidence_id,expected_mrr,sent_at,status,version',
    '',
    'evidence_id',
    '');

-- financial_record: číslo dokladu (external_ref) a poznámka jen názvem,
-- částka, druh, stav a období s hodnotou; jen obchodní role.
DROP TRIGGER IF EXISTS audit_row_change_soft ON financial_record;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON financial_record
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,amount,created_by,currency,deal_id,engagement_id,evidence_id,kind,milestone_id,period_month,source,status',
    '',
    'evidence_id',
    '');

-- loop_node: obsazení uzlů (kdo uzel vlastní a zastupuje); klíč = kód uzlu.
DROP TRIGGER IF EXISTS audit_row_change_soft ON loop_node;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON loop_node
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'deputy_id,node,owner_id',
    '',
    '',
    'node');

-- metric_observation: název metriky, jednotka a poznámka jsou text → jen
-- názvem; naměřené hodnoty (bez peněz, CHECK 0061) s hodnotou.
DROP TRIGGER IF EXISTS audit_row_change_soft ON metric_observation;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON metric_observation
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'actual,baseline,created_by,engagement_id,evidence_id,observed_on',
    '',
    'evidence_id',
    '');

-- team_member: role, is_admin, manažer a deaktivace s hodnotou (to jsou
-- oprávnění). Jméno a kapacita jsou ignorované (změna nic neoprávňuje);
-- e-mail se neignoruje, ale není v allow-listu → vidět jen název `email`.
-- Klíč = uuid člena. Zápisy jdou jen přes servisní klíč, RPC a migrace (0069).
DROP TRIGGER IF EXISTS audit_row_change_soft ON team_member;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON team_member
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'deactivated_at,is_admin,manager_id,role',
    'full_name,weekly_capacity_hours',
    '',
    'id');

-- Kontrola konfigurace proti skutečnému schématu (jako u 0064): sloupec
-- v argumentech, který v tabulce není, by se tiše nikdy nezapsal. Jen ohlásí.
DO $$
DECLARE
  v_problem text;
BEGIN
  FOR v_problem IN
    SELECT format('%s.%s', c.relname, col.name)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
    CROSS JOIN LATERAL unnest(string_to_array(encode(t.tgargs, 'escape'), '\000')) AS arg(value)
    CROSS JOIN LATERAL unnest(string_to_array(arg.value, ',')) AS col(name)
    WHERE t.tgname = 'audit_row_change_soft' AND NOT t.tgisinternal AND col.name <> ''
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute att
        WHERE att.attrelid = c.oid AND att.attname = col.name AND att.attnum > 0 AND NOT att.attisdropped
      )
  LOOP
    RAISE WARNING '0082: audit_row_change_soft odkazuje na neexistující sloupec %', v_problem;
  END LOOP;
END $$;

-- ===========================================================================
-- 4) Historie peněz a nabídek jen pro obchodní role
-- ===========================================================================

-- RESTRICTIVE se spojuje přes AND s audit_event_read, require_aal2 (0028)
-- i s audit_event_sales_only / audit_sales_only (0064/0069) — jen zužuje.
DROP POLICY IF EXISTS audit_event_sales_only_fin ON audit_event;
CREATE POLICY audit_event_sales_only_fin ON audit_event
  AS RESTRICTIVE FOR SELECT
  USING (entity_table NOT IN ('deal_scope_version', 'financial_record') OR (SELECT can_see_sales()));

-- ===========================================================================
-- 5) Role Partner: žádné čtení interní evidence (jedno místo)
-- ===========================================================================

-- Allowlist interních rolí. Seznam MUSÍ sedět s INTERNAL_ROLES v lib/domain.ts
-- (test/hardening-0082.test.ts). Nová role v enumu do něj nepatří, dokud ji
-- někdo výslovně nepřidá.
CREATE OR REPLACE FUNCTION is_team_member() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member
    WHERE id = auth.uid()
      AND deactivated_at IS NULL
      AND role::text IN ('vedeni', 'obchodnik', 'projektak', 'lektor')
  );
$$;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member
    WHERE id = auth.uid()
      AND is_admin = true
      AND deactivated_at IS NULL
      AND role::text IN ('vedeni', 'obchodnik', 'projektak', 'lektor')
  );
$$;

-- Vlastní řádek team_member si člověk přečte vždy (id = auth.uid()): aplikace
-- z něj pozná roli a Partnerovi ukáže „bez přístupu“ místo prázdné chyby a
-- requireUser podle něj odmítne server akce. Cizí řádky Partner dál nevidí
-- (team_read stojí na is_team_member()). Jen SELECT — zápis do team_member
-- klientské role nemají (0069/0073) a tady se to nemění.
DROP POLICY IF EXISTS team_self_read ON team_member;
CREATE POLICY team_self_read ON team_member FOR SELECT USING (id = auth.uid());

-- can_see_sales() se nemění: vedeni + obchodnik už Partnera vylučují.

-- Kontrola pohledů: pohled bez security_invoker běží s právy vlastníka a RLS
-- obchází. Jen varování (pohled může být záměrně veřejný, tady žádný není).
DO $$
DECLARE
  v_view text;
BEGIN
  FOR v_view IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
    WHERE c.relkind = 'v'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(c.reloptions, '{}'::text[])) AS o
        WHERE o ~ '^security_invoker=(on|true)$'
      )
  LOOP
    RAISE WARNING '0082: pohled public.% nemá security_invoker = on — obchází RLS a Partnerovi by mohl vydat interní data', v_view;
  END LOOP;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0082', 'audit bez blokace zapisu (audit_row_change_soft) pro financial_record, allocation, metric_observation, case_proposal, deal_scope_version, deal_partner, loop_node, team_member (audit_event.entity_ref); is_team_member/is_admin jen interni role (partner bez cteni)')
ON CONFLICT (version) DO NOTHING;
