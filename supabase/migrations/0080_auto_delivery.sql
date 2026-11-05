-- 0080 — automatické založení dodávky po vyhrání obchodu.
--
-- PROČ: dnes se dodávka (engagement) po přechodu obchodu do fáze Vyhráno
-- zakládá ručně (formulář „+ Nová dodávka" na kartě klienta). Firma
-- nesmí dělat věci ručně a vyhraný obchod bez dodávky je přesně ten případ,
-- kdy se práce ztratí mezi obchodem a realizací (cílová architektura,
-- kap. 3 „Zakázka a převzetí týmem": předání není přeposlání e-mailu, do
-- dodávky se přenesou cíl, rozsah, vlastník a termíny). Migrace zavádí, že
-- Cockpit sám a ve stejné transakci s přechodem fáze založí:
--   * dodávku (engagement): klient, odkaz na obchod, vlastník = vlastník
--     obchodu, zástup z obsazení uzlů Loop Core, druh a první fáze podle
--     obchodu, cíl z „očekávaný výsledek", rozsah z PŘIJATÉ verze nabídky
--     (deal_scope_version, 0072), realizační tým z obchodu, začátek dnes,
--   * výchozí milníky podle šablony (níž),
--   * úkol „Naplánovat realizaci akce" na vlastníka, termín do 2
--     pracovních dnů,
--   * záznam do aktivit klienta (sales_activity),
--   * významovou auditní událost deal.delivery_auto_created.
--
-- ROZHODNUTÍ: DB TRIGGER, ne server akce. Fáze obchodu se dnes mění nejméně
-- na pěti místech (přetažení v pipeline updateDealStage, formulář updateDeal,
-- createDeal rovnou jako vyhraný, plus REST/MCP, cron, servisní klíč a SQL
-- editor). Server akce, kterou by musela volat každá z nich, by obešla
-- kterýkoli zápis mimo ni — přesně stejný důvod, kvůli kterému 0034 přesunula
-- audit fáze z appky do triggeru. Trigger je jediné místo, chytí každou cestu
-- a je atomický s přechodem fáze (nemůže vzniknout „vyhráno bez dodávky, i
-- když přechod prošel"). Cena: logika a šablona milníků žijí v SQL. Šablona
-- má proto kopii v config/mummiesDaddies.ts (autoDelivery) a test
-- test/auto-delivery-migration.test.ts hlídá, že se neliší (vzor kap. 11).
--
-- SECURITY DEFINER: funkce zapisuje do engagement, milníků, úkolů, aktivit
-- a audit_event (ten nemá INSERT politiku, 0028). Běží jako vlastník a RLS
-- obchází, ale dělá jen deterministické odvození z jednoho řádku obchodu:
--   * trigger funkce se dá spustit jen přechodem fáze na vyhráno (WHEN),
--   * jádro auto_delivery_create() nemá klientské EXECUTE (REVOKE),
--   * veřejné je jen RPC ensure_deal_delivery() — se stejnou bránou jako
--     0058/0062 (přihlášený + AAL2 + člen týmu + obchodní role), které navíc
--     zakládá jen z obchodu, který JE vyhraný.
-- Práva volajícího tu nic nerozšiřují: přechod fáze smí jen obchodní role
-- (RLS deal, 0058) a to je jediný spouštěč.
--
-- IDEMPOTENCE (jedna dodávka na jeden vyhraný obchod):
--   * nový sloupec engagement.origin ('manual' výchozí | 'auto_deal_won') a
--     částečný UNIKÁTNÍ index (deal_id) WHERE origin = 'auto_deal_won' — DB
--     nepustí druhou automatickou dodávku téhož obchodu ani při souběhu;
--   * jádro před založením zamkne řádek obchodu (FOR UPDATE) a když k obchodu
--     už JAKÁKOLI dodávka existuje (i ruční), nezakládá nic. Ruční doplňkové
--     dodávky téhož obchodu (workshop + pilot, kap. 3) tím zůstávají možné —
--     unikátní je jen automatické založení;
--   * opakované přepnutí fáze (Vyhráno → Rozhodování → Vyhráno) druhou
--     dodávku nezaloží; návrat z Vyhráno nic nemaže (trigger reaguje jen na
--     vstup do Vyhráno, na DELETE nesahá);
--   * aktivita má klíč (source 'auto_delivery', external_id
--     'engagement:<id>') na existujícím unikátním indexu z 0021.
--
-- SELHÁNÍ NESMÍ BLOKOVAT VÝHRU: vyhrání obchodu je lidské rozhodnutí, které
-- nesmí zablokovat pomocná automatika. Trigger proto obalí jádro do bloku
-- s výjimkou (podtransakce: částečný zápis se vrátí celý), zapíše
-- WARNING a auditní událost deal.delivery_auto_failed (jen SQLSTATE, žádný
-- text) a přechod fáze nechá projít. Detail obchodu pak ukáže „dodávka
-- chybí" se záložním tlačítkem, které zavolá stejné jádro přes RPC a chybu
-- ukáže člověku. Auditní INSERT podobně nesmí shodit přechod.
--
-- PŮVOD DODÁVKY: nový sloupec origin drží strážce engagement_origin_guard:
-- 'auto_deal_won' smí založit jen jádro (transakčně lokální příznak
-- app.auto_delivery s id obchodu, vzor app.scope_version_accept z 0072),
-- původ se po vzniku nemění. Klient si tak nemůže označit ruční dodávku za
-- automatickou ani ji „vyřadit" z unikátního indexu.
--
-- ŠABLONA MILNÍKŮ podle typu obchodu (deal.deal_kind, 0052; když chybí,
-- podle produktové linky obchodu). Kopie v config/mummiesDaddies.ts → autoDelivery:
--   workshop      Workshop → Procesní mapa → Rozhodnutí o technické analýze
--                 (první schválený provozní případ, cílová architektura §14)
--   implementace  Zahájení a vstupy od klienta → Pilot → Vyhodnocení pilotu
--                 → Předání a akceptace
--   provoz        Převzetí provozu → Provoz a měření → Vyhodnocení a další krok
--   jine          Workshop → Procesní mapa → Pilot → Vyhodnocení (výchozí)
-- Milníky vznikají ve stavu „připraveno", vlastník a zástup z dodávky, BEZ
-- termínu — termíny domluví vlastník při plánování zahájení (úkol výše).
--
-- CO SE ZÁMĚRNĚ NEPŘENÁŠÍ:
--   * částky obchodu (financial_frame zůstane prázdné): dodávku vidí celý
--     tým, částky jen obchodní role (0058); rámec doplní člověk;
--   * klientský sponzor a rizika (NULL = nevyplněno, kap. 6): obchod je
--     nezná, hlavní kontakt obchodu není nutně sponzor; předávací kontrolní
--     seznam je ukáže jako chybějící;
--   * scope z ODESLANÉ, ale nepřijaté verze („odesláno ≠ přijato"): bez
--     přijaté verze zůstane rozsah prázdný a aktivita to řekne.
--
-- VLASTNÍK A ZÁSTUP: vlastník = deal.owner_id; když chybí, vlastník klienta
-- (account.owner_id), a když ani ten, vlastník uzlu eventy
-- (loop_node). Zástup = zástupce uzlu Loop Core, který vlastník vlastní
-- (loop_node.deputy_id; přednost eventy, pak vedeni,
-- pak jakýkoli jiný uzel) — je to jediné místo, kde je „zástup vlastníka"
-- dnes nastavený. Není-li zástup nastavený (dnes je Viktor vlastníkem všech
-- čtyř uzlů bez zástupců, ROZHODNUTI 7.1), zůstane prázdný a dodávka ho
-- ukáže jako „nepřiřazen". Zástup se nikdy nerovná vlastníkovi.
--
-- ODVOZENÍ DRUHU A FÁZE: druh dodávky (edu | it | platform) z produktové
-- linky obchodu; první fáze z fáze obchodu (legacy deal.phase + pilíř,
-- config.wonPhases), jinak analyza pro IT a sm_diagnostika ostatní.
--
-- AUDIT (konvence 0064): každý řádek zapsaný jádrem (engagement, milestone,
-- task, sales_activity) zaznamená obecný trigger audit_row_change() s aktérem
-- z auth.uid(); u servisního zápisu z hlavičky, jinak db-trigger:<role>.
-- Navíc jedna významová událost deal.delivery_auto_created (entity_table
-- 'deal' — vidí ji jen obchodní role, audit_event_sales_only) s id
-- vytvořených záznamů, počtem milníků, šablonou a cestou (trigger | rpc |
-- backfill); žádný volný text ani jméno. Není to řádková změna kryté
-- tabulky (0064 pro deal kryje jen UPDATE ostatních sloupců), proto
-- nedochází k dvojímu zápisu. Backfill zapisuje aktéra system /
-- migration:0080.
--
-- BACKFILL: na konci migrace se pro každý už vyhraný obchod BEZ jakékoli
-- dodávky zavolá jádro (via 'backfill'). Začátek dodávky je u backfillu
-- datum vyhrání (won_at, jinak closed_at, nejvýš dnes) — dodávka nemohla
-- začít dřív než výhra a „dnes" by u obchodu vyhraného před měsíci lhalo;
-- úkol a jeho termín se počítají od dneška. Počet založených dodávek se
-- zapíše do poznámky řádku 0080 v schema_migration a do NOTICE. Opakovaný
-- běh nic nezaloží (obchod už dodávku má).
--
-- KÓD JE TOLERANTNÍ K NENASAZENÉ MIGRACI: detail obchodu bez 0080 ukáže
-- jako dřív odkaz na ruční založení; „Co se změnilo" druh „Nové dodávky"
-- přeskočí (chybí sloupec origin); záložní tlačítko hlásí „čeká na 0080".
--
-- ZÁVISLOSTI: 0001 (deal, engagement, account), 0002 (team_member,
-- is_team_member), 0006 (task), 0010 (deal.pillar/phase/delivery_team), 0020
-- (sales_activity, can_see_sales, deal.owner_id), 0021 (unikátní index
-- aktivity), 0026 (ledger), 0028+0038 (audit_event), 0039 (loop_node), 0042
-- (engagement_milestone), 0052 (deal.deal_kind, expected_outcome), 0054
-- (engagement.goal/scope), 0061 (engagement.owner_id/deputy_id/
-- delivery_team), 0064 (audit_request_context), 0072 (deal_scope_version).
-- Guard níže skončí srozumitelnou chybou.
-- Idempotentní: ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS + CREATE,
-- CREATE OR REPLACE, ON CONFLICT DO NOTHING. Zámky: ADD COLUMN s výchozí
-- hodnotou je od PG 11 jen katalogová změna; CREATE TRIGGER bere krátký
-- SHARE ROW EXCLUSIVE na deal a engagement.

DO $$
DECLARE
  v_req text[];
BEGIN
  FOREACH v_req SLICE 1 IN ARRAY ARRAY[
    ['account', '0001_base_schema.sql'],
    ['deal', '0001_base_schema.sql'],
    ['engagement', '0001_base_schema.sql'],
    ['team_member', '0002_auth_and_team.sql'],
    ['task', '0006_tasks_and_calendar.sql'],
    ['sales_activity', '0020_core_sales_crm.sql'],
    ['audit_event', '0028_audit_event.sql'],
    ['loop_node', '0039_loop_core.sql'],
    ['engagement_milestone', '0042_engagement_milestone.sql'],
    ['deal_scope_version', '0072_deal_scope_version.sql'],
    ['schema_migration', '0026_migration_ledger.sql']
  ] LOOP
    IF to_regclass('public.' || v_req[1]) IS NULL THEN
      RAISE EXCEPTION '0080 vyžaduje tabulku public.% — nejdřív aplikujte %', v_req[1], v_req[2];
    END IF;
  END LOOP;

  FOREACH v_req SLICE 1 IN ARRAY ARRAY[
    ['deal', 'owner_id', '0020_core_sales_crm.sql'],
    ['deal', 'pillar', '0010_project_pillars.sql'],
    ['deal', 'phase', '0010_project_pillars.sql'],
    ['deal', 'delivery_team', '0010_project_pillars.sql'],
    ['deal', 'deal_kind', '0052_deal_opportunity.sql'],
    ['deal', 'expected_outcome', '0052_deal_opportunity.sql'],
    ['account', 'owner_id', '0011_account_rich.sql'],
    ['engagement', 'goal', '0054_handoff_package.sql'],
    ['engagement', 'scope', '0054_handoff_package.sql'],
    ['engagement', 'owner_id', '0061_delivery_impact.sql'],
    ['engagement', 'deputy_id', '0061_delivery_impact.sql'],
    ['engagement', 'delivery_team', '0061_delivery_impact.sql'],
    ['audit_event', 'info_state', '0038_evidence.sql'],
    ['sales_activity', 'external_id', '0021_activity_partner.sql']
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_req[1] AND column_name = v_req[2]
    ) THEN
      RAISE EXCEPTION '0080 vyžaduje sloupec %.% — nejdřív aplikujte %', v_req[1], v_req[2], v_req[3];
    END IF;
  END LOOP;

  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0080 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0080 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regprocedure('public.audit_request_context()') IS NULL THEN
    RAISE EXCEPTION '0080 vyžaduje funkci audit_request_context() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) engagement.origin + unikátní vazba „jedna automatická dodávka na obchod"
-- ===========================================================================

ALTER TABLE engagement ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_origin_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_origin_check
  CHECK (origin IN ('manual', 'auto_deal_won'));

-- Ruční dodávek k jednomu obchodu smí být víc (kap. 3), automatická jen jedna.
CREATE UNIQUE INDEX IF NOT EXISTS engagement_auto_deal_uidx
  ON engagement (deal_id) WHERE origin = 'auto_deal_won';

COMMENT ON COLUMN engagement.origin IS
  'Odkud dodávka vznikla: manual (formulář) | auto_deal_won (Cockpit ji založil po vyhrání obchodu, 0080). Po vzniku se nemění.';

-- Strážce původu. SECURITY INVOKER: čte jen NEW/OLD a transakční příznak.
CREATE OR REPLACE FUNCTION engagement_origin_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin = 'auto_deal_won'
       AND coalesce(current_setting('app.auto_delivery', true), '') IS DISTINCT FROM coalesce(NEW.deal_id::text, '') THEN
      RAISE EXCEPTION 'Dodávku označenou jako automaticky založenou zakládá jen Cockpit po vyhrání obchodu'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'Původ dodávky nejde změnit' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION engagement_origin_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS engagement_origin_guard ON engagement;
CREATE TRIGGER engagement_origin_guard
  BEFORE INSERT OR UPDATE OF origin ON engagement
  FOR EACH ROW EXECUTE FUNCTION engagement_origin_guard();

-- ===========================================================================
-- 2) Čisté pomocné funkce (šablona, odvození druhu a fáze, pracovní dny)
-- ===========================================================================

-- Klíč šablony milníků: výslovný typ obchodu, jinak podle produktové linky.
CREATE OR REPLACE FUNCTION auto_delivery_template_key(p_deal_kind text, p_revenue_line text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_deal_kind IN ('workshop', 'implementace', 'provoz') THEN p_deal_kind
    WHEN coalesce(p_deal_kind, '') <> '' THEN 'jine'
    WHEN p_revenue_line = 'firemni_pravidelny' THEN 'provoz'
    WHEN p_revenue_line IN ('catering_firemni', 'oslava_soukroma', 'svatebni_hostina', 'cheesecaky_eshop', 'pronajem_prostor') THEN 'implementace'
    ELSE 'jine'
  END
$$;

-- Milníky šablony (MUSÍ zůstat shodné s COMPANY.autoDelivery.milestoneTemplates
-- v config/mummiesDaddies.ts; test/auto-delivery-migration.test.ts je porovnává).
CREATE OR REPLACE FUNCTION auto_delivery_milestones(p_template text)
RETURNS TABLE (pos integer, title text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.pos, t.title
  FROM (VALUES
    ('workshop', 1, 'Degustace'),
    ('workshop', 2, 'Potvrzení menu'),
    ('workshop', 3, 'Realizace akce'),
    ('implementace', 1, 'Potvrzení menu a počtu hostů'),
    ('implementace', 2, 'Personál a inventář'),
    ('implementace', 3, 'Realizace akce'),
    ('implementace', 4, 'Vyúčtování a zpětná vazba'),
    ('provoz', 1, 'Nastavení pravidelných dodávek'),
    ('provoz', 2, 'První dodávka'),
    ('provoz', 3, 'Vyhodnocení po měsíci'),
    ('jine', 1, 'Potvrzení detailů'),
    ('jine', 2, 'Realizace akce'),
    ('jine', 3, 'Vyúčtování')
  ) AS t(template, pos, title)
  WHERE t.template = CASE WHEN p_template IN ('workshop', 'implementace', 'provoz') THEN p_template ELSE 'jine' END
  ORDER BY t.pos
$$;

-- Druh dodávky (engagement.kind) z produktové linky obchodu.
CREATE OR REPLACE FUNCTION auto_delivery_engagement_kind(p_revenue_line text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_revenue_line IN ('catering_firemni', 'oslava_soukroma') THEN 'edu'
    WHEN p_revenue_line IN ('firemni_pravidelny', 'provize') THEN 'platform'
    ELSE 'it'
  END
$$;

-- První fáze dodávky (enum delivery_phase): z fáze, kterou obchod nese od
-- 0010 (pilíř + phase, viz config.wonPhases — projekt „vyhráno" reálně
-- běží), jinak analyza pro IT a sm_diagnostika ostatním.
CREATE OR REPLACE FUNCTION auto_delivery_phase(p_engagement_kind text, p_pillar text, p_deal_phase text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_pillar IN ('b2b_akce', 'b2c_oslavy', 'cheesecaky') AND p_deal_phase = 'realizovano' THEN 'implementace'
    WHEN p_pillar IN ('b2b_akce', 'b2c_oslavy', 'cheesecaky') AND p_deal_phase = 'potvrzeno' THEN 'analyza'
    WHEN p_engagement_kind = 'platform' THEN 'podpora'
    ELSE 'sm_diagnostika'
  END
$$;

-- Datum o N pracovních dní později (Po–Pá). Státní svátky se NEPOČÍTAJÍ —
-- termín úkolu je orientační, ne smluvní.
CREATE OR REPLACE FUNCTION auto_delivery_add_working_days(p_from date, p_days integer)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day  date := p_from;
  v_left integer := greatest(coalesce(p_days, 0), 0);
BEGIN
  WHILE v_left > 0 LOOP
    v_day := v_day + 1;
    IF extract(isodow FROM v_day) < 6 THEN
      v_left := v_left - 1;
    END IF;
  END LOOP;
  RETURN v_day;
END $$;

REVOKE ALL ON FUNCTION auto_delivery_template_key(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION auto_delivery_milestones(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION auto_delivery_engagement_kind(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION auto_delivery_phase(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION auto_delivery_add_working_days(date, integer) FROM PUBLIC, anon;

-- ===========================================================================
-- 3) Jádro: založí dodávku k vyhranému obchodu (idempotentně)
-- ===========================================================================

-- Volá ho trigger, backfill a RPC ensure_deal_delivery. Bez vlastní brány,
-- proto klientům EXECUTE odebráno (0064 vzor). p_via: trigger | rpc | backfill.
-- p_actor (jen backfill): aktér auditní události, např. 'migration:0080'.
CREATE OR REPLACE FUNCTION auto_delivery_create(
  p_deal_id     bigint,
  p_started_on  date DEFAULT NULL,
  p_via         text DEFAULT 'trigger',
  p_actor       text DEFAULT NULL,
  OUT out_engagement_id bigint,
  OUT out_created       boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deal      deal%ROWTYPE;
  v_today     date := (now() AT TIME ZONE 'Europe/Prague')::date;
  v_started   date;
  v_existing  bigint;
  v_owner     uuid;
  v_deputy    uuid;
  v_kind      text;
  v_template  text;
  v_phase     text;
  v_scope     text;
  v_ver_id    bigint;
  v_ver_no    integer;
  v_due       date;
  v_ms        integer;
  v_task      bigint;
  v_act       bigint;
  v_ctx       record;
  v_actor_t   text;
  v_actor_id  text;
  v_state     text;
  v_deal_name text;
BEGIN
  -- Zámek obchodu: souběžné volání (dvojklik, dvě záložky, trigger + RPC)
  -- se seřadí a druhé uvidí dodávku prvního.
  SELECT * INTO v_deal FROM deal WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Obchod % neexistuje', p_deal_id USING ERRCODE = 'P0002';
  END IF;
  IF v_deal.stage::text <> 'vyhráno' THEN
    RAISE EXCEPTION 'Dodávku jde automaticky založit jen z vyhraného obchodu' USING ERRCODE = 'AD001';
  END IF;

  -- Jakákoli dodávka k obchodu (i ruční) = hotovo, nic dalšího nezakládat.
  SELECT e.id INTO v_existing
    FROM engagement e
   WHERE e.deal_id = p_deal_id
   ORDER BY (e.origin = 'auto_deal_won') DESC, e.id
   LIMIT 1;
  IF FOUND THEN
    out_engagement_id := v_existing;
    out_created := false;
    RETURN;
  END IF;

  v_started := least(coalesce(p_started_on, v_today), v_today);
  v_deal_name := left(btrim(v_deal.title), 120);

  -- Vlastník: obchod → klient → uzel eventy.
  v_owner := coalesce(
    v_deal.owner_id,
    (SELECT a.owner_id FROM account a WHERE a.id = v_deal.account_id),
    (SELECT n.owner_id FROM loop_node n WHERE n.node = 'eventy')
  );
  -- Zástup: zástupce uzlu, který vlastník vlastní (přednost realizace, pak
  -- strategie, pak cokoli). Nikdy ne vlastník sám.
  IF v_owner IS NOT NULL THEN
    SELECT n.deputy_id INTO v_deputy
      FROM loop_node n
     WHERE n.owner_id = v_owner
       AND n.deputy_id IS NOT NULL
       AND n.deputy_id <> v_owner
     ORDER BY array_position(ARRAY['eventy', 'vedeni'], n.node) NULLS LAST, n.node
     LIMIT 1;
  END IF;

  v_kind := auto_delivery_engagement_kind(v_deal.revenue_line::text);
  v_template := auto_delivery_template_key(v_deal.deal_kind, v_deal.revenue_line::text);
  v_phase := auto_delivery_phase(v_kind, v_deal.pillar, v_deal.phase);

  -- Rozsah jen z PŘIJATÉ verze nabídky (odesláno ≠ přijato).
  SELECT v.id, v.version, nullif(btrim(v.scope), '')
    INTO v_ver_id, v_ver_no, v_scope
    FROM deal_scope_version v
   WHERE v.deal_id = p_deal_id AND v.status = 'accepted'
   LIMIT 1;

  -- Příznak pro strážce původu (transakčně lokální, viz engagement_origin_guard).
  PERFORM set_config('app.auto_delivery', p_deal_id::text, true);

  INSERT INTO engagement (
    account_id, deal_id, kind, phase, started_on, goal, scope,
    owner_id, deputy_id, delivery_team, origin
  ) VALUES (
    v_deal.account_id, p_deal_id, v_kind, v_phase::delivery_phase, v_started,
    nullif(btrim(v_deal.expected_outcome), ''), v_scope,
    v_owner, v_deputy, v_deal.delivery_team, 'auto_deal_won'
  )
  ON CONFLICT (deal_id) WHERE origin = 'auto_deal_won' DO NOTHING
  RETURNING id INTO out_engagement_id;

  PERFORM set_config('app.auto_delivery', '', true);

  IF out_engagement_id IS NULL THEN
    -- Souběh, který zámek obchodu nezachytil (jiná transakce už commitla).
    SELECT e.id INTO out_engagement_id
      FROM engagement e
     WHERE e.deal_id = p_deal_id AND e.origin = 'auto_deal_won';
    out_created := false;
    RETURN;
  END IF;

  INSERT INTO engagement_milestone (engagement_id, title, owner_id, deputy_id, status)
  SELECT out_engagement_id, m.title, v_owner, v_deputy, 'pripraveno'
    FROM auto_delivery_milestones(v_template) m
   ORDER BY m.pos;
  GET DIAGNOSTICS v_ms = ROW_COUNT;

  -- Úkol „Naplánovat realizaci akce" (config.autoDelivery.startTask) na
  -- vlastníka. created_by NULL = založil systém, ne člověk (proto se ukáže
  -- i vlastníkovi v „Co se změnilo").
  v_due := auto_delivery_add_working_days(v_today, 2);
  INSERT INTO task (title, description, status, priority, assignee_id, created_by, due_on, account_id, deal_id, engagement_id)
  VALUES (
    'Naplánovat realizaci akce',
    'Obchod „' || v_deal_name || '" je vyhraný a Cockpit sám založil dodávku (vlastník, rozsah a milníky jsou předvyplněné). '
      || 'Domluv s klientem termín zahájení, doplň termíny milníků a klientského sponzora.'
      || CASE WHEN v_scope IS NULL
              THEN ' U obchodu chybí přijatá verze nabídky, proto je rozsah dodávky prázdný — doplň ho.'
              ELSE '' END,
    'todo', 'normal', v_owner, NULL, v_due, v_deal.account_id, p_deal_id, out_engagement_id
  )
  RETURNING id INTO v_task;

  -- Záznam do aktivit klienta. Bez jmen a částek; unikátní klíč z 0021.
  INSERT INTO sales_activity (
    account_id, deal_id, kind, outcome, subject, body, occurred_at, created_by, source, external_id
  ) VALUES (
    v_deal.account_id, p_deal_id, 'note', 'completed',
    'Dodávka založena automaticky po vyhrání obchodu „' || left(v_deal_name, 100) || '"',
    'Cockpit po vyhrání obchodu sám založil dodávku a předvyplnil ji z obchodu: vlastník'
      || CASE WHEN v_deputy IS NOT NULL THEN ' a zástupce' ELSE '' END
      || ', ' || CASE WHEN v_ver_no IS NOT NULL
                      THEN 'rozsah z přijaté verze nabídky v' || v_ver_no
                      ELSE 'rozsah nevyplněn (chybí přijatá verze nabídky)' END
      || ', ' || v_ms || ' milníků podle šablony. Úkol „Naplánovat realizaci akce" čeká na vlastníka do '
      || to_char(v_due, 'FMDD. FMMM. YYYY') || '.',
    now(), NULL, 'auto_delivery', 'engagement:' || out_engagement_id
  )
  ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_act;

  -- Významová auditní událost (řádkové změny zapíše trigger 0064 sám).
  IF p_actor IS NOT NULL THEN
    v_actor_t := 'system';
    v_actor_id := p_actor;
    v_state := NULL;
  ELSE
    SELECT * INTO v_ctx FROM audit_request_context();
    v_actor_t := v_ctx.actor_type;
    v_actor_id := v_ctx.actor_id;
    v_state := v_ctx.info_state;
  END IF;
  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after, evidence_id, info_state)
  VALUES (
    v_actor_t, v_actor_id, 'deal.delivery_auto_created', 'deal', p_deal_id, NULL,
    jsonb_build_object(
      'engagement_id', out_engagement_id,
      'milestones', v_ms,
      'task_id', v_task,
      'activity_id', v_act,
      'owner_id', v_owner,
      'deputy_id', v_deputy,
      'scope_version_id', v_ver_id,
      'template', v_template,
      'via', p_via
    ),
    NULL, v_state
  );

  out_created := true;
END $$;

REVOKE ALL ON FUNCTION auto_delivery_create(bigint, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auto_delivery_create(bigint, date, text, text) FROM anon, authenticated;

-- ===========================================================================
-- 4) Trigger: vstup obchodu do fáze Vyhráno
-- ===========================================================================

-- Fail-soft (viz hlavička): výjimka jádra vrátí jen podtransakci, přechod
-- fáze projde. RETURN NULL — AFTER trigger, návratová hodnota se ignoruje.
CREATE OR REPLACE FUNCTION auto_delivery_on_deal_won() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ctx record;
BEGIN
  BEGIN
    PERFORM auto_delivery_create(NEW.id, NULL, 'trigger', NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_delivery: dodávku k obchodu % se nepodařilo založit (SQLSTATE %)', NEW.id, SQLSTATE;
    BEGIN
      SELECT * INTO v_ctx FROM audit_request_context();
      INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after, evidence_id, info_state)
      VALUES (
        v_ctx.actor_type, v_ctx.actor_id, 'deal.delivery_auto_failed', 'deal', NEW.id, NULL,
        jsonb_build_object('sqlstate', SQLSTATE, 'via', 'trigger'), NULL, v_ctx.info_state
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION auto_delivery_on_deal_won() FROM PUBLIC;
REVOKE ALL ON FUNCTION auto_delivery_on_deal_won() FROM anon, authenticated;

-- Dva triggery: WHEN u INSERT nesmí číst OLD.
DROP TRIGGER IF EXISTS deal_auto_delivery_insert ON deal;
CREATE TRIGGER deal_auto_delivery_insert
  AFTER INSERT ON deal
  FOR EACH ROW
  WHEN (NEW.stage::text = 'vyhráno')
  EXECUTE FUNCTION auto_delivery_on_deal_won();

DROP TRIGGER IF EXISTS deal_auto_delivery_update ON deal;
CREATE TRIGGER deal_auto_delivery_update
  AFTER UPDATE OF stage ON deal
  FOR EACH ROW
  WHEN (NEW.stage::text = 'vyhráno' AND OLD.stage IS DISTINCT FROM NEW.stage)
  EXECUTE FUNCTION auto_delivery_on_deal_won();

-- ===========================================================================
-- 5) RPC pro záložní tlačítko „Založit dodávku" na detailu obchodu
-- ===========================================================================

-- SECURITY DEFINER obchází RLS včetně RESTRICTIVE AAL2 → brána tady (vzor
-- set_weekly_capacity z 0062 a deal_public z 0058). Zakládá jen z obchodu,
-- který je vyhraný, a jen když k němu ještě žádná dodávka není.
CREATE OR REPLACE FUNCTION ensure_deal_delivery(p_deal_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nepřihlášený uživatel' USING ERRCODE = '42501';
  END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'Vyžadováno dvoufázové ověření (AAL2)' USING ERRCODE = '42501';
  END IF;
  IF NOT is_team_member() THEN
    RAISE EXCEPTION 'Jen pro člena týmu' USING ERRCODE = '42501';
  END IF;
  IF NOT can_see_sales() THEN
    RAISE EXCEPTION 'Dodávku z obchodu zakládá jen obchodní role' USING ERRCODE = '42501';
  END IF;
  IF p_deal_id IS NULL THEN
    RAISE EXCEPTION 'Chybí obchod' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_res FROM auto_delivery_create(p_deal_id, NULL, 'rpc', NULL);
  RETURN jsonb_build_object('engagement_id', v_res.out_engagement_id, 'created', v_res.out_created);
END $$;

REVOKE ALL ON FUNCTION ensure_deal_delivery(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ensure_deal_delivery(bigint) TO authenticated;

-- ===========================================================================
-- 6) Backfill: vyhrané obchody bez jakékoli dodávky
-- ===========================================================================

DO $$
DECLARE
  r         record;
  v_res     record;
  v_created integer := 0;
BEGIN
  FOR r IN
    SELECT d.id, coalesce(d.won_at, d.closed_at) AS started_on
      FROM deal d
     WHERE d.stage::text = 'vyhráno'
       AND NOT EXISTS (SELECT 1 FROM engagement e WHERE e.deal_id = d.id)
     ORDER BY d.id
  LOOP
    SELECT * INTO v_res FROM auto_delivery_create(r.id, r.started_on, 'backfill', 'migration:0080');
    IF v_res.out_created THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0080 backfill: založeno % dodávek pro vyhrané obchody bez dodávky', v_created;
  PERFORM set_config('app.auto_delivery_backfill', v_created::text, true);
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0080', 'auto_delivery: dodavka se zaklada sama po vyhrani obchodu (trigger deal_auto_delivery_*, engagement.origin + unikatni vazba, sablona milniku, ukol, aktivita, audit) - backfill zalozil '
  || coalesce(current_setting('app.auto_delivery_backfill', true), '0') || ' dodavek')
ON CONFLICT (version) DO NOTHING;
