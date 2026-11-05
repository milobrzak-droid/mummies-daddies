-- 0098 — hromadný import běžících zakázek (dávky, položky, „vrátit import“).
--
-- PROČ: Cockpit dosud uměl založit jednu nabídku z PDF. Viktor potřebuje nahrát
-- všechny aktuálně BĚŽÍCÍ zakázky i s naší cenou a nechce je zapisovat ručně.
-- Aplikace (docs/PROVOZ.md) proto přijme víc PDF najednou nebo tabulku
-- CSV, každý řádek ukáže ke kontrole a po potvrzení ho zapíše. Tahle migrace
-- dává tomu zápisu tři věci, které aplikace sama zaručit nemůže:
--
--   1) ATOMICKÝ ZÁPIS ŘÁDKU. Klient (nebo nový klient), obchod, verze nabídky,
--      dodávka a finanční záznamy jedné zakázky vznikají v JEDNÉ transakci
--      (funkce import_apply_row). PostgREST víc příkazů v transakci neumí
--      (viz 0034), funkce ano. Chyba kdekoli = nevznikne nic.
--
--   2) IDEMPOTENCE. Každá zakázka nese klíče (otisk PDF, nebo klíč klient +
--      název + cena + měna). Klíč je v import_batch_item pod UNIKÁTNÍM indexem,
--      takže stejný soubor či řádek podruhé duplicitu nezaloží, ani když se
--      potvrdí dvakrát naráz (poradí je advisory zámek na prvním klíči).
--
--   3) VRÁCENÍ DÁVKY. Funkce import_revert_batch smaže jen záznamy, které
--      dávka vytvořila, a jen tam, kde se od importu nic nezměnilo. Kdo se
--      zakázky dotkl (audit_event po importu, úkol, aktivita, dokument,
--      alokace, cokoli s odkazem na obchod nebo dodávku), ta zůstane a
--      výsledek to řekne. Klient se maže, jen když ho založila dávka a nic
--      na něj dál neodkazuje.
--
-- HISTORICKÉ ZAKÁZKY A DODÁVKA (0080). Vyhraná zakázka z importu musí mít
-- dodávku (proto se vyhráno zapisuje přes existující trigger deal_auto_delivery_*
-- a jádro auto_delivery_create), ale NESMÍ spustit falešné úkoly „Naplánovat
-- zahájení dodávky“ ani záznam „dodávka založena automaticky“: zahájení už
-- proběhlo a 30 úkolů najednou by zaplavilo frontu vlastníků. Řešení:
-- obchod nese deal.import_batch_id (píše ho jen import_apply_row, strážce
-- deal_import_guard) a jádro auto_delivery_create (CREATE OR REPLACE níže,
-- zbytek těla beze změny z 0080) považuje obchod za historický jen tehdy,
-- když import_batch_id sedí s transakčním příznakem app.bulk_import, tedy
-- když výhru zapisuje samotný import. U takové zakázky jádro
--   * úkol a aktivitu nezakládá,
--   * začátek dodávky bere z příznaku app.bulk_import_started_on (skutečný
--     začátek zakázky z importu), jinak z data výhry,
--   * do auditní události přidá 'imported': true.
-- Milníky podle šablony a vlastník vznikají jako u každé vyhrané zakázky.
-- Obchod importovaný jako „nabídka odeslána“ nebo „rozjednáno“, který člověk
-- později posune do Vyhráno, se chová normálně (úkol vznikne): příznak
-- app.bulk_import tehdy není nastavený.
--
-- FINANČNÍ ZÁZNAMY. Zdroj 'import' (rozšíření CHECKu z 0092) smí založit jen
-- import_apply_row (strážce financial_record_import_guard). U výhry vzniká
-- „Nasmlouváno“ v ceně zakázky (potvrzeno). „Vyfakturováno“ a „Přijato“ vznikají
-- jen když je v importu uvedená částka, a to jako NÁVRH (draft): potvrzená
-- faktura a úhrada se podle 0063 musí opírat o číslo dokladu, které import
-- nezná, a potvrzený záznam bez dokladu by denní čtení z iDokladu (0092)
-- zdvojilo (vlastní záznam + záznam z faktury). Návrh iDoklad spáruje podle
-- přesné částky a člověk ho po doplnění dokladu potvrdí. Součty přes druhy
-- se nikde nedělají (0063).
--
-- OPRÁVNĚNÍ. Všechny tři funkce volá jen service_role (aplikace:
-- domain/crm/actions/bulkImport.ts, admin klient s hlavičkou aktéra), vzor
-- 0088/0093. Oprávnění ověří aplikace (přihlášený, AAL2, obchodní role) a
-- znovu funkce: aktér (p_actor) musí být aktivní člen s obchodní rolí, jinak
-- IM003. Tabulky import_batch a import_batch_item čte tým s AAL2 a obchodní
-- rolí (RESTRICTIVE), zapisovat do nich klient nemůže vůbec.
--
-- CHYBY (stabilní SQLSTATE, aplikace je překládá v domain/crm/bulkImport.ts):
--   IM001 neplatná vstupní data      IM002 neplatný druh dávky
--   IM003 aktér nemá obchodní roli   IM004 dávka neexistuje
--   IM005 dávka není otevřená        IM006 dávka patří jinému člověku
--   IM007 klient neexistuje          IM008 vlastník není aktivní člen
--   IM009 dodávku se nepodařilo založit (řádek se vrátí celý)
--   IM010 vrátit dávku smí jen ten, kdo ji nahrál, nebo správce
--   IM011 import_batch_id / zdroj 'import' smí zapsat jen import
--
-- AUDIT: řádkové změny zapisují triggery existujících tabulek (0064/0082) s
-- aktérem z hlavičky x-cockpit-audit-actor. Navíc import_batch má měkký audit
-- (0082 vzor) a funkce zapisují významové události deal.bulk_imported (jedna
-- za zakázku, human_confirmed, jen id a počty, žádný text ani částka) a
-- import.batch_reverted.
--
-- KÓD JE TOLERANTNÍ K NENASAZENÉ MIGRACI: stránka importu řekne „čeká na
-- migraci 0098“ a nic nezapisuje.
--
-- ZÁVISLOSTI: 0001 (account, deal, engagement), 0002 (team_member), 0063
-- (financial_record), 0072 (deal_scope_version), 0080 (auto_delivery_create),
-- 0082 (audit_row_change_soft), 0064 (audit_request_context), 0026 (ledger),
-- 0038 (evidence), 0020 (can_see_sales). Guard níže skončí srozumitelnou chybou.
-- Idempotentní: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE, DROP … IF EXISTS + CREATE, ON CONFLICT DO NOTHING.
-- Zámky: ADD COLUMN bez výchozí hodnoty je katalogová změna, CHECK zdroje
-- finančních záznamů projde malou tabulku, ostatní jsou nové objekty.

DO $$
DECLARE
  v_req text[];
BEGIN
  FOREACH v_req SLICE 1 IN ARRAY ARRAY[
    ['account', '0001_base_schema.sql'],
    ['deal', '0001_base_schema.sql'],
    ['engagement', '0001_base_schema.sql'],
    ['team_member', '0002_auth_and_team.sql'],
    ['financial_record', '0063_financial_record.sql'],
    ['deal_scope_version', '0072_deal_scope_version.sql'],
    ['audit_event', '0028_audit_event.sql'],
    ['schema_migration', '0026_migration_ledger.sql']
  ] LOOP
    IF to_regclass('public.' || v_req[1]) IS NULL THEN
      RAISE EXCEPTION '0098 vyžaduje tabulku public.% — nejdřív aplikujte %', v_req[1], v_req[2];
    END IF;
  END LOOP;

  IF to_regprocedure('public.auto_delivery_create(bigint, date, text, text)') IS NULL THEN
    RAISE EXCEPTION '0098 vyžaduje funkci auto_delivery_create — nejdřív aplikujte 0080_auto_delivery.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0098 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regprocedure('public.audit_request_context()') IS NULL THEN
    RAISE EXCEPTION '0098 vyžaduje audit_request_context() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0098 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'engagement' AND column_name = 'origin'
  ) THEN
    RAISE EXCEPTION '0098 vyžaduje sloupec engagement.origin — nejdřív aplikujte 0080_auto_delivery.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) Dávky a položky
-- ===========================================================================

CREATE TABLE IF NOT EXISTS import_batch (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  label        text,
  status       text NOT NULL DEFAULT 'open',
  created_by   uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reverted_at  timestamptz,
  reverted_by  uuid REFERENCES team_member(id) ON DELETE SET NULL,
  CONSTRAINT import_batch_kind_check CHECK (kind IN ('pdf', 'csv')),
  CONSTRAINT import_batch_status_check CHECK (status IN ('open', 'partial', 'reverted')),
  CONSTRAINT import_batch_label_check CHECK (label IS NULL OR char_length(label) <= 200)
);

COMMENT ON TABLE import_batch IS
  'Dávka hromadného importu běžících zakázek (0098): jedno nahrání PDF nebo CSV. Píše jen import_open_batch a import_revert_batch (service_role).';
COMMENT ON COLUMN import_batch.status IS
  'open = zapsané záznamy platí | partial = vrácení proběhlo jen částečně (někde už je lidská práce) | reverted = vráceno celé.';

-- Co dávka vytvořila. Jeden obchod má řádek pro každý klíč idempotence
-- (import_key), ostatní záznamy jeden řádek bez klíče.
CREATE TABLE IF NOT EXISTS import_batch_item (
  id           bigserial PRIMARY KEY,
  batch_id     bigint NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  entity_table text NOT NULL,
  entity_id    bigint NOT NULL,
  import_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batch_item_table_check
    CHECK (entity_table IN ('account', 'deal', 'engagement', 'financial_record', 'deal_scope_version')),
  CONSTRAINT import_batch_item_key_check
    CHECK (import_key IS NULL OR char_length(import_key) BETWEEN 1 AND 200),
  -- Klíč idempotence má smysl jen u obchodu.
  CONSTRAINT import_batch_item_key_deal_check
    CHECK (import_key IS NULL OR entity_table = 'deal')
);

-- Stejný klíč podruhé = duplicita (i při souběhu dvou potvrzení).
CREATE UNIQUE INDEX IF NOT EXISTS import_batch_item_key_uidx
  ON import_batch_item(import_key) WHERE import_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS import_batch_item_entity_uidx
  ON import_batch_item(entity_table, entity_id, coalesce(import_key, ''));
CREATE INDEX IF NOT EXISTS import_batch_item_batch_idx
  ON import_batch_item(batch_id, entity_table);

COMMENT ON TABLE import_batch_item IS
  'Záznamy vytvořené dávkou importu (klient, obchod, dodávka, verze nabídky, finanční záznam) a klíče idempotence obchodů (0098).';

-- Původ obchodu: dávka, která ho založila. NULL = obchod nevznikl importem.
ALTER TABLE deal ADD COLUMN IF NOT EXISTS import_batch_id bigint REFERENCES import_batch(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS deal_import_batch_idx ON deal(import_batch_id) WHERE import_batch_id IS NOT NULL;
COMMENT ON COLUMN deal.import_batch_id IS
  'Dávka hromadného importu (0098), která obchod založila. Zapisuje ji jen import_apply_row; po založení se nemění. U takového obchodu jádro 0080 nezakládá úkol „Naplánovat realizaci akce“.';

-- Zdroj finančního záznamu 'import' (0092 měl rucne/nabidka/milnik/ucetnictvi/idoklad).
ALTER TABLE financial_record DROP CONSTRAINT IF EXISTS financial_record_source_check;
ALTER TABLE financial_record ADD CONSTRAINT financial_record_source_check
  CHECK (source IN ('rucne', 'nabidka', 'milnik', 'ucetnictvi', 'idoklad', 'import'));

COMMENT ON COLUMN financial_record.source IS
  'Odkud částka je: rucne / nabidka / milnik / ucetnictvi / idoklad / import (hromadný import zakázek, 0098). Pošta záměrně není zdrojem faktury ani úhrady.';

-- ===========================================================================
-- 2) Strážci: kdo smí zapsat původ obchodu a zdroj 'import'
-- ===========================================================================

-- SECURITY INVOKER: čte jen NEW/OLD a transakční příznak (vzor 0080).
CREATE OR REPLACE FUNCTION deal_import_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.import_batch_id IS NOT NULL
       AND coalesce(current_setting('app.bulk_import', true), '') IS DISTINCT FROM NEW.import_batch_id::text THEN
      RAISE EXCEPTION 'Původ obchodu z importu zapisuje jen hromadný import' USING ERRCODE = 'IM011';
    END IF;
  ELSIF NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
    RAISE EXCEPTION 'Původ obchodu z importu nejde změnit' USING ERRCODE = 'IM011';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION deal_import_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS deal_import_guard ON deal;
CREATE TRIGGER deal_import_guard
  BEFORE INSERT OR UPDATE OF import_batch_id ON deal
  FOR EACH ROW EXECUTE FUNCTION deal_import_guard();

CREATE OR REPLACE FUNCTION financial_record_import_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source = 'import' AND coalesce(current_setting('app.bulk_import', true), '') = '' THEN
    RAISE EXCEPTION 'Záznam se zdrojem import zapisuje jen hromadný import' USING ERRCODE = 'IM011';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION financial_record_import_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS financial_record_import_guard ON financial_record;
CREATE TRIGGER financial_record_import_guard
  BEFORE INSERT ON financial_record
  FOR EACH ROW EXECUTE FUNCTION financial_record_import_guard();

-- ===========================================================================
-- 3) RLS: tým s AAL2 a obchodní rolí čte, nikdo z klienta nezapisuje
-- ===========================================================================

ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch_item ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_batch_select ON import_batch;
CREATE POLICY import_batch_select ON import_batch FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS import_batch_item_select ON import_batch_item;
CREATE POLICY import_batch_item_select ON import_batch_item FOR SELECT
  USING ((SELECT is_team_member()));

-- INSERT, UPDATE ani DELETE politika záměrně NENÍ (default-deny): zapisuje jen
-- servisní klíč přes funkce níže.

DROP POLICY IF EXISTS require_aal2 ON import_batch;
CREATE POLICY require_aal2 ON import_batch
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS require_aal2 ON import_batch_item;
CREATE POLICY require_aal2 ON import_batch_item
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS sales_only ON import_batch;
CREATE POLICY sales_only ON import_batch
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

DROP POLICY IF EXISTS sales_only ON import_batch_item;
CREATE POLICY sales_only ON import_batch_item
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

REVOKE ALL ON import_batch, import_batch_item FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON import_batch, import_batch_item FROM authenticated;

-- ===========================================================================
-- 4) Audit dávky (MUSÍ sedět s DB_AUDITED_TABLES v core/auditCoverage.ts)
-- ===========================================================================

-- Popisek dávky (název souboru) je volný text → jen názvem v `_columns`.
DROP TRIGGER IF EXISTS audit_row_change_soft ON import_batch;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON import_batch
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'created_by,kind,reverted_at,reverted_by,status',
    '',
    '',
    '');

-- ===========================================================================
-- 5) Jádro dodávky: historická zakázka z importu nedostane úkol (0080)
-- ===========================================================================

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
  v_imported  boolean;
  v_start_txt text;
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

  -- Zakázku vyhrává hromadný import (0098): historická zakázka, která už běží.
  v_imported := v_deal.import_batch_id IS NOT NULL
    AND coalesce(current_setting('app.bulk_import', true), '') = v_deal.import_batch_id::text;

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

  IF v_imported THEN
    -- Import: skutečný začátek zakázky (i budoucí plánovaný), jinak datum výhry.
    v_start_txt := nullif(current_setting('app.bulk_import_started_on', true), '');
    v_started := coalesce(p_started_on, v_start_txt::date, v_deal.won_at, v_today);
  ELSE
    v_started := least(coalesce(p_started_on, v_today), v_today);
  END IF;
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

  -- Historická zakázka (import) nedostane úkol „Naplánovat realizaci" ani záznam
  -- „dodávka založena automaticky": zahájení už proběhlo, falešný úkol by
  -- vlastníkovi zaplevelil frontu (proč: docs/PROVOZ.md).
  IF NOT v_imported THEN
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
  END IF;

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
      'via', p_via,
      'imported', v_imported
    ),
    NULL, v_state
  );

  out_created := true;
END $$;


REVOKE ALL ON FUNCTION auto_delivery_create(bigint, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auto_delivery_create(bigint, date, text, text) FROM anon, authenticated;

-- ===========================================================================
-- 6) Pomocné funkce
-- ===========================================================================

-- Aktér smí importovat: aktivní člen s obchodní rolí. Seznam rolí MUSÍ sedět
-- s can_see_sales() (test/bulk-import-migration.test.ts to porovnává se SALES_ROLES).
CREATE OR REPLACE FUNCTION import_actor_ok(p_actor uuid) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member tm
     WHERE tm.id = p_actor AND tm.deactivated_at IS NULL AND tm.role::text IN ('vedeni', 'obchodnik')
  )
$$;

REVOKE ALL ON FUNCTION import_actor_ok(uuid) FROM PUBLIC, anon, authenticated;

-- Kolik řádků v jiných tabulkách odkazuje (jednosloupcovým cizím klíčem) na
-- záznam. Obecně přes katalog, ať vrácení dávky nezapomene na tabulku, která
-- vznikne později: ON DELETE SET NULL / CASCADE by cizí práci smazalo nebo
-- odpojilo potichu. p_skip = tabulky, které volající kontroluje zvlášť.
CREATE OR REPLACE FUNCTION import_fk_refs(p_table regclass, p_id bigint, p_skip text[] DEFAULT ARRAY[]::text[])
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  r   record;
  v_n bigint := 0;
  v_c bigint;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS rel, c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = p_table
       AND array_length(c.conkey, 1) = 1
  LOOP
    CONTINUE WHEN r.tbl = ANY (p_skip);
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.rel, r.col) USING p_id INTO v_c;
    v_n := v_n + v_c;
  END LOOP;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION import_fk_refs(regclass, bigint, text[]) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 7) Otevření dávky
-- ===========================================================================

CREATE OR REPLACE FUNCTION import_open_batch(p_actor uuid, p_kind text, p_label text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'Chybí aktér importu' USING ERRCODE = 'IM001';
  END IF;
  IF NOT import_actor_ok(p_actor) THEN
    RAISE EXCEPTION 'Import smí jen aktivní člen s obchodní rolí' USING ERRCODE = 'IM003';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('pdf', 'csv') THEN
    RAISE EXCEPTION 'Neznámý druh dávky' USING ERRCODE = 'IM002';
  END IF;
  INSERT INTO import_batch (kind, label, created_by)
  VALUES (p_kind, left(nullif(btrim(p_label), ''), 200), p_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION import_open_batch(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION import_open_batch(uuid, text, text) TO service_role;

-- ===========================================================================
-- 8) Zápis jednoho řádku (jedna zakázka = jedna transakce)
-- ===========================================================================

-- p_row (jsonb):
--   import_keys     text[]  1–3 klíče idempotence (např. 'pdf:<sha256>', 'row:<sha256>')
--   account_id      bigint  existující klient, NEBO
--   new_account     {name, ico, industry, region}  nový klient (IČO už v Cockpitu = použije se ten)
--   title, revenue_line, revenue_category, pillar, phase
--   stage           'vyhráno' | 'rozsah_nabidka' | 'diagnostika'
--   probability_pct 0–100
--   currency        'CZK' | 'EUR'; amount (v měně), fx_rate (u EUR povinný), cogs
--   owner_id        uuid (aktivní člen) | null
--   started_on, due_on, expected_close  date
--   invoiced, received   částky v měně zakázky (jen u vyhráno)
--   estimate_md, scope, note, source_pdf_path, evidence_id
-- Vrací {status: 'created'|'duplicate', deal_id, account_id, account_created,
--        engagement_id, records}.
CREATE OR REPLACE FUNCTION import_apply_row(p_actor uuid, p_batch_id bigint, p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch      import_batch%ROWTYPE;
  v_keys       text[];
  v_key        text;
  v_dup        bigint;
  v_today      date := (now() AT TIME ZONE 'Europe/Prague')::date;
  v_title      text := btrim(p_row ->> 'title');
  v_stage      text := p_row ->> 'stage';
  v_currency   text := p_row ->> 'currency';
  v_amount     numeric;
  v_cogs       numeric;
  v_fx         numeric;
  v_invoiced   numeric;
  v_received   numeric;
  v_owner      uuid;
  v_started    date;
  v_due        date;
  v_close      date;
  v_prob       integer;
  v_md         integer;
  v_evidence   bigint;
  v_account    bigint;
  v_acc_new    boolean := false;
  v_ico        text;
  v_acc_name   text;
  v_deal       bigint;
  v_ver        bigint;
  v_eng        bigint;
  v_won        date;
  v_period     date;
  v_rec        bigint;
  v_records    integer := 0;
  v_amount_czk numeric;
  v_orig       numeric;
  v_ctx        record;
BEGIN
  IF p_actor IS NULL OR p_batch_id IS NULL OR p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'Chybí vstup importu' USING ERRCODE = 'IM001';
  END IF;
  IF NOT import_actor_ok(p_actor) THEN
    RAISE EXCEPTION 'Import smí jen aktivní člen s obchodní rolí' USING ERRCODE = 'IM003';
  END IF;

  SELECT * INTO v_batch FROM import_batch WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dávka importu neexistuje' USING ERRCODE = 'IM004';
  END IF;
  IF v_batch.status <> 'open' THEN
    RAISE EXCEPTION 'Dávka importu už není otevřená' USING ERRCODE = 'IM005';
  END IF;
  IF v_batch.created_by IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'Dávka patří jinému člověku' USING ERRCODE = 'IM006';
  END IF;

  -- Vstup -------------------------------------------------------------------
  v_keys := ARRAY(SELECT jsonb_array_elements_text(p_row -> 'import_keys'));
  IF coalesce(cardinality(v_keys), 0) NOT BETWEEN 1 AND 3
     OR EXISTS (SELECT 1 FROM unnest(v_keys) k WHERE k IS NULL OR char_length(k) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'Zakázka nemá platné klíče importu' USING ERRCODE = 'IM001';
  END IF;
  IF v_title IS NULL OR char_length(v_title) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Název zakázky je povinný (nejvýš 300 znaků)' USING ERRCODE = 'IM001';
  END IF;
  IF v_stage IS NULL OR v_stage NOT IN ('vyhráno', 'rozsah_nabidka', 'diagnostika') THEN
    RAISE EXCEPTION 'Import zakládá jen fáze vyhráno, rozsah/nabídka a diagnostika' USING ERRCODE = 'IM001';
  END IF;
  IF v_currency IS NULL OR v_currency NOT IN ('CZK', 'EUR') THEN
    RAISE EXCEPTION 'Měna musí být CZK nebo EUR' USING ERRCODE = 'IM001';
  END IF;

  v_amount   := (p_row ->> 'amount')::numeric;
  v_cogs     := coalesce((p_row ->> 'cogs')::numeric, 0);
  v_fx       := (p_row ->> 'fx_rate')::numeric;
  v_invoiced := (p_row ->> 'invoiced')::numeric;
  v_received := (p_row ->> 'received')::numeric;
  v_prob     := coalesce((p_row ->> 'probability_pct')::integer, 0);
  v_md       := (p_row ->> 'estimate_md')::integer;
  v_owner    := (p_row ->> 'owner_id')::uuid;
  v_started  := (p_row ->> 'started_on')::date;
  v_due      := (p_row ->> 'due_on')::date;
  v_close    := (p_row ->> 'expected_close')::date;
  v_evidence := (p_row ->> 'evidence_id')::bigint;

  IF v_amount IS NULL OR v_amount < 0 OR v_amount > 1000000000
     OR v_cogs < 0 OR v_cogs > 1000000000 THEN
    RAISE EXCEPTION 'Částka je mimo rozumný rozsah' USING ERRCODE = 'IM001';
  END IF;
  IF v_currency = 'EUR' AND (v_fx IS NULL OR v_fx <= 0) THEN
    RAISE EXCEPTION 'U měny EUR chybí kurz pro přepočet na Kč' USING ERRCODE = 'IM001';
  END IF;
  IF v_prob NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Pravděpodobnost musí být 0 až 100' USING ERRCODE = 'IM001';
  END IF;
  IF v_due IS NOT NULL AND v_started IS NOT NULL AND v_due < v_started THEN
    RAISE EXCEPTION 'Termín je dřív než začátek' USING ERRCODE = 'IM001';
  END IF;
  IF (v_invoiced IS NOT NULL OR v_received IS NOT NULL) AND v_stage <> 'vyhráno' THEN
    RAISE EXCEPTION 'Fakturováno a přijato jde uvést jen u vyhrané zakázky' USING ERRCODE = 'IM001';
  END IF;
  IF coalesce(v_invoiced, 0) < 0 OR coalesce(v_received, 0) < 0
     OR coalesce(v_invoiced, 0) > 1000000000 OR coalesce(v_received, 0) > 1000000000
     OR (v_invoiced IS NOT NULL AND v_received IS NOT NULL AND v_received > v_invoiced) THEN
    RAISE EXCEPTION 'Fakturováno a přijato: neplatné částky (přijato nesmí přesáhnout fakturováno)' USING ERRCODE = 'IM001';
  END IF;
  IF v_owner IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_member tm
     WHERE tm.id = v_owner AND tm.deactivated_at IS NULL
       AND tm.role::text IN ('vedeni', 'obchodnik', 'projektak', 'lektor')
  ) THEN
    RAISE EXCEPTION 'Vlastník zakázky musí být aktivní člen týmu' USING ERRCODE = 'IM008';
  END IF;

  -- Idempotence: stejný klíč = stejná zakázka; souběžné potvrzení počká ------
  PERFORM pg_advisory_xact_lock(hashtextextended(v_keys[1], 0));
  SELECT i.entity_id INTO v_dup
    FROM import_batch_item i
   WHERE i.entity_table = 'deal' AND i.import_key = ANY (v_keys)
   ORDER BY i.id LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'duplicate', 'deal_id', v_dup,
      'account_id', (SELECT d.account_id FROM deal d WHERE d.id = v_dup));
  END IF;

  -- Příznak „píše import“ (strážci deal_import_guard a financial_record_import_guard)
  PERFORM set_config('app.bulk_import', p_batch_id::text, true);

  -- Klient ------------------------------------------------------------------
  IF jsonb_typeof(p_row -> 'account_id') = 'number' THEN
    v_account := (p_row ->> 'account_id')::bigint;
    IF NOT EXISTS (SELECT 1 FROM account WHERE id = v_account) THEN
      RAISE EXCEPTION 'Klient neexistuje' USING ERRCODE = 'IM007';
    END IF;
  ELSIF jsonb_typeof(p_row -> 'new_account') = 'object' THEN
    v_acc_name := btrim(p_row #>> '{new_account,name}');
    v_ico := nullif(btrim(p_row #>> '{new_account,ico}'), '');
    IF v_acc_name IS NULL OR char_length(v_acc_name) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'Název nového klienta je povinný (nejvýš 200 znaků)' USING ERRCODE = 'IM001';
    END IF;
    IF v_ico IS NOT NULL THEN
      SELECT a.id INTO v_account FROM account a WHERE a.ico = v_ico;
    END IF;
    IF v_account IS NULL THEN
      -- Stejného nového klienta z dřívějšího řádku téže dávky použij znovu.
      SELECT a.id INTO v_account
        FROM account a
        JOIN import_batch_item i ON i.entity_table = 'account' AND i.entity_id = a.id AND i.batch_id = p_batch_id
       WHERE lower(btrim(a.name)) = lower(v_acc_name)
       ORDER BY a.id LIMIT 1;
    END IF;
    IF v_account IS NULL THEN
      INSERT INTO account (name, ico, industry, region)
      VALUES (v_acc_name, v_ico, left(nullif(btrim(p_row #>> '{new_account,industry}'), ''), 200),
              left(nullif(btrim(p_row #>> '{new_account,region}'), ''), 200))
      RETURNING id INTO v_account;
      v_acc_new := true;
      INSERT INTO import_batch_item (batch_id, entity_table, entity_id) VALUES (p_batch_id, 'account', v_account);
    END IF;
  ELSE
    RAISE EXCEPTION 'Zakázka nemá klienta' USING ERRCODE = 'IM001';
  END IF;

  -- Částky: obchod drží Kč, původní hodnotu a kurz jen u EUR (0016) -----------
  IF v_currency = 'EUR' THEN
    v_orig := v_amount;
    v_amount_czk := round(v_amount * v_fx);
    v_cogs := round(v_cogs * v_fx);
  ELSE
    v_orig := NULL;
    v_amount_czk := v_amount;
    v_fx := NULL;
  END IF;

  -- Obchod: vyhraný se zakládá jako otevřený a do Vyhráno se posune až po
  -- přijaté verzi nabídky, aby dodávka (0080) dostala rozsah z ní.
  INSERT INTO deal (
    account_id, title, revenue_line, revenue_category, stage, probability_pct, pillar, phase,
    currency, amount_one_time, amount_one_time_original, fx_rate, cogs_one_time, estimate_md,
    expected_close, owner_id, subsidy_program, subsidy_pct, source_pdf_path, note, import_batch_id
  ) VALUES (
    v_account, v_title, (p_row ->> 'revenue_line')::revenue_line, (p_row ->> 'revenue_category')::revenue_category,
    CASE WHEN v_stage = 'vyhráno' THEN 'rozsah_nabidka' ELSE v_stage END::deal_stage,
    v_prob, nullif(btrim(p_row ->> 'pillar'), ''), nullif(btrim(p_row ->> 'phase'), ''),
    v_currency::deal_currency, v_amount_czk, v_orig, v_fx, v_cogs, v_md,
    v_close, v_owner, 'none', 0,
    nullif(btrim(p_row ->> 'source_pdf_path'), ''), left(nullif(btrim(p_row ->> 'note'), ''), 2000), p_batch_id
  )
  RETURNING id INTO v_deal;

  FOREACH v_key IN ARRAY v_keys LOOP
    INSERT INTO import_batch_item (batch_id, entity_table, entity_id, import_key)
    VALUES (p_batch_id, 'deal', v_deal, v_key);
  END LOOP;

  -- Verze nabídky (0072): vyhráno = přijatá, nabídka odeslána = odeslaná ------
  IF v_stage IN ('vyhráno', 'rozsah_nabidka') THEN
    INSERT INTO deal_scope_version (deal_id, version, scope, amount_one_time, expected_mrr, currency, status, evidence_id, created_by)
    VALUES (v_deal, 1, left(nullif(btrim(p_row ->> 'scope'), ''), 4000), v_amount, 0, v_currency::deal_currency, 'sent', v_evidence, p_actor)
    RETURNING id INTO v_ver;
    INSERT INTO import_batch_item (batch_id, entity_table, entity_id) VALUES (p_batch_id, 'deal_scope_version', v_ver);
  END IF;

  IF v_stage = 'vyhráno' THEN
    -- Přijetí verze jen s příznakem, který zná strážce z 0072.
    PERFORM set_config('app.scope_version_accept', v_deal::text, true);
    UPDATE deal_scope_version SET status = 'accepted' WHERE id = v_ver;
    PERFORM set_config('app.scope_version_accept', '', true);

    v_won := least(coalesce(v_started, v_today), v_today);
    -- Skutečný začátek zakázky pro dodávku; jádro 0080 ho u importu přečte.
    PERFORM set_config('app.bulk_import_started_on', coalesce(v_started::text, ''), true);
    UPDATE deal
       SET stage = 'vyhráno', won_at = v_won, closed_at = v_won, forecast_category = 'closed', probability_pct = 100
     WHERE id = v_deal;
    PERFORM set_config('app.bulk_import_started_on', '', true);

    SELECT e.id INTO v_eng FROM engagement e WHERE e.deal_id = v_deal ORDER BY e.id LIMIT 1;
    IF v_eng IS NULL THEN
      -- Trigger 0080 je záměrně měkký (výhra nesmí spadnout). Tady chceme
      -- opak: bez dodávky by zakázka nebyla „běžící“, řádek se proto vrátí celý.
      RAISE EXCEPTION 'Dodávku k zakázce se nepodařilo založit' USING ERRCODE = 'IM009';
    END IF;
    INSERT INTO import_batch_item (batch_id, entity_table, entity_id) VALUES (p_batch_id, 'engagement', v_eng);
    IF v_due IS NOT NULL THEN
      UPDATE engagement SET due_on = v_due WHERE id = v_eng;
    END IF;

    -- Finanční záznamy: Nasmlouváno potvrzeno, Vyfakturováno a Přijato jako návrh.
    v_period := date_trunc('month', coalesce(v_started, v_today))::date;
    IF v_amount > 0 THEN
      INSERT INTO financial_record (account_id, deal_id, engagement_id, kind, amount, currency, period_month, status, source, note, created_by)
      VALUES (v_account, v_deal, v_eng, 'contracted', v_amount, v_currency::deal_currency, v_period, 'confirmed', 'import',
              'Import zakázek: cena zakázky.', p_actor)
      RETURNING id INTO v_rec;
      INSERT INTO import_batch_item (batch_id, entity_table, entity_id) VALUES (p_batch_id, 'financial_record', v_rec);
      v_records := v_records + 1;
    END IF;
    v_period := date_trunc('month', v_today)::date;
    IF coalesce(v_invoiced, 0) > 0 THEN
      INSERT INTO financial_record (account_id, deal_id, engagement_id, kind, amount, currency, period_month, status, source, note, created_by)
      VALUES (v_account, v_deal, v_eng, 'invoiced', v_invoiced, v_currency::deal_currency, v_period, 'draft', 'import',
              'Import zakázek: souhrn k datu importu. Doplň číslo dokladu a datum, pak potvrď.', p_actor)
      RETURNING id INTO v_rec;
      INSERT INTO import_batch_item (batch_id, entity_table, entity_id) VALUES (p_batch_id, 'financial_record', v_rec);
      v_records := v_records + 1;
    END IF;
    IF coalesce(v_received, 0) > 0 THEN
      INSERT INTO financial_record (account_id, deal_id, engagement_id, kind, amount, currency, period_month, status, source, note, created_by)
      VALUES (v_account, v_deal, v_eng, 'received', v_received, v_currency::deal_currency, v_period, 'draft', 'import',
              'Import zakázek: souhrn k datu importu. Doplň číslo dokladu a datum, pak potvrď.', p_actor)
      RETURNING id INTO v_rec;
      INSERT INTO import_batch_item (batch_id, entity_table, entity_id) VALUES (p_batch_id, 'financial_record', v_rec);
      v_records := v_records + 1;
    END IF;
  END IF;

  -- Významová událost: jen id a počty, žádný text ani částka.
  SELECT * INTO v_ctx FROM audit_request_context();
  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after, evidence_id, info_state)
  VALUES (
    v_ctx.actor_type, v_ctx.actor_id, 'deal.bulk_imported', 'deal', v_deal, NULL,
    jsonb_build_object(
      'batch_id', p_batch_id,
      'source', v_batch.kind,
      'stage', v_stage,
      'account_created', v_acc_new,
      'engagement_id', v_eng,
      'scope_version_id', v_ver,
      'financial_records', v_records
    ),
    v_evidence, 'human_confirmed'
  );

  PERFORM set_config('app.bulk_import', '', true);

  RETURN jsonb_build_object(
    'status', 'created', 'deal_id', v_deal, 'account_id', v_account, 'account_created', v_acc_new,
    'engagement_id', v_eng, 'records', v_records);
END $$;

REVOKE ALL ON FUNCTION import_apply_row(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION import_apply_row(uuid, bigint, jsonb) TO service_role;

-- ===========================================================================
-- 9) Vrácení dávky
-- ===========================================================================

-- Vrátí dávku po zakázkách. Zakázku smaže jen když se od importu nic nezměnilo:
--   * žádný auditní záznam nad obchodem, dodávkou, jejími milníky, verzí
--     nabídky ani finančním záznamem novější než import,
--   * žádný milník přidaný nebo změněný po importu,
--   * žádný jiný řádek s odkazem na obchod nebo dodávku (úkol, aktivita,
--     dokument, alokace, případ, pošta …), zjištěno z katalogu cizích klíčů,
--   * žádný finanční záznam, který import nevytvořil, ani takový, který se
--     po importu změnil (např. návrh faktury potvrzený s dokladem).
-- Zakázka s lidskou prací zůstane celá. Klient, kterého dávka založila, se
-- smaže, až když na něj nic neodkazuje a nikdo ho po importu neupravil.
-- Vrací {deals_reverted, deals_kept:[{deal_id, reason}], accounts_deleted,
--        accounts_kept, records_deleted, status}. Volat jde opakovaně
-- (dávka ve stavu partial se dokončí, až překážka zmizí).
CREATE OR REPLACE FUNCTION import_revert_batch(p_actor uuid, p_batch_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch      import_batch%ROWTYPE;
  v_deal       bigint;
  v_at         timestamptz;
  v_engs       bigint[];
  v_recs       bigint[];
  v_vers       bigint[];
  v_mss        bigint[];
  v_reason     text;
  v_reverted   integer := 0;
  v_kept       jsonb := '[]'::jsonb;
  v_rec_del    integer := 0;
  v_n          integer;
  v_acc        bigint;
  v_acc_del    integer := 0;
  v_acc_kept   integer := 0;
  v_left       integer;
  v_status     text;
  v_ctx        record;
BEGIN
  IF p_actor IS NULL OR p_batch_id IS NULL THEN
    RAISE EXCEPTION 'Chybí vstup importu' USING ERRCODE = 'IM001';
  END IF;
  IF NOT import_actor_ok(p_actor) THEN
    RAISE EXCEPTION 'Import smí jen aktivní člen s obchodní rolí' USING ERRCODE = 'IM003';
  END IF;

  SELECT * INTO v_batch FROM import_batch WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dávka importu neexistuje' USING ERRCODE = 'IM004';
  END IF;
  IF v_batch.status = 'reverted' THEN
    RAISE EXCEPTION 'Dávka už je vrácená' USING ERRCODE = 'IM005';
  END IF;
  IF v_batch.created_by IS DISTINCT FROM p_actor AND NOT EXISTS (
    SELECT 1 FROM team_member tm WHERE tm.id = p_actor AND tm.is_admin AND tm.deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Dávku smí vrátit jen ten, kdo ji nahrál, nebo správce týmu' USING ERRCODE = 'IM010';
  END IF;

  PERFORM set_config('app.bulk_import', p_batch_id::text, true);

  FOR v_deal IN
    SELECT DISTINCT i.entity_id FROM import_batch_item i
     WHERE i.batch_id = p_batch_id AND i.entity_table = 'deal' ORDER BY i.entity_id
  LOOP
    v_reason := NULL;
    SELECT min(i.created_at) INTO v_at FROM import_batch_item i
     WHERE i.batch_id = p_batch_id AND i.entity_table = 'deal' AND i.entity_id = v_deal;

    v_engs := ARRAY(SELECT i.entity_id FROM import_batch_item i
                     WHERE i.batch_id = p_batch_id AND i.entity_table = 'engagement'
                       AND i.entity_id IN (SELECT e.id FROM engagement e WHERE e.deal_id = v_deal));
    v_recs := ARRAY(SELECT i.entity_id FROM import_batch_item i
                     WHERE i.batch_id = p_batch_id AND i.entity_table = 'financial_record'
                       AND i.entity_id IN (SELECT f.id FROM financial_record f WHERE f.deal_id = v_deal));
    v_vers := ARRAY(SELECT i.entity_id FROM import_batch_item i
                     WHERE i.batch_id = p_batch_id AND i.entity_table = 'deal_scope_version'
                       AND i.entity_id IN (SELECT s.id FROM deal_scope_version s WHERE s.deal_id = v_deal));
    v_mss := ARRAY(SELECT m.id FROM engagement_milestone m WHERE m.engagement_id = ANY (v_engs));

    IF NOT EXISTS (SELECT 1 FROM deal d WHERE d.id = v_deal) THEN
      -- Obchod už neexistuje (smazal ho člověk): zbývá uklidit položky.
      DELETE FROM import_batch_item WHERE batch_id = p_batch_id AND entity_table = 'deal' AND entity_id = v_deal;
      CONTINUE;
    END IF;

    -- 1) Změna po importu (audit) --------------------------------------------
    IF EXISTS (
      SELECT 1 FROM audit_event a
       WHERE a.occurred_at > v_at
         AND ((a.entity_table = 'deal' AND a.entity_id = v_deal)
           OR (a.entity_table = 'engagement' AND a.entity_id = ANY (v_engs))
           OR (a.entity_table = 'engagement_milestone' AND a.entity_id = ANY (v_mss))
           OR (a.entity_table = 'financial_record' AND a.entity_id = ANY (v_recs))
           OR (a.entity_table = 'deal_scope_version' AND a.entity_id = ANY (v_vers)))
    ) THEN
      v_reason := 'changed';
    -- 2) Něco jiného než import na zakázce visí --------------------------------
    ELSIF import_fk_refs('deal'::regclass, v_deal, ARRAY['engagement', 'deal_scope_version', 'financial_record']) > 0 THEN
      v_reason := 'linked_work';
    ELSIF EXISTS (SELECT 1 FROM engagement e WHERE e.deal_id = v_deal AND NOT (e.id = ANY (v_engs))) THEN
      v_reason := 'other_delivery';
    ELSIF EXISTS (SELECT 1 FROM deal_scope_version s WHERE s.deal_id = v_deal AND NOT (s.id = ANY (v_vers))) THEN
      v_reason := 'other_offer_version';
    ELSIF EXISTS (
      SELECT 1 FROM engagement e WHERE e.id = ANY (v_engs)
        AND import_fk_refs('engagement'::regclass, e.id, ARRAY['engagement_milestone', 'financial_record']) > 0
    ) THEN
      v_reason := 'linked_work';
    ELSIF EXISTS (
      SELECT 1 FROM engagement_milestone m
       WHERE m.engagement_id = ANY (v_engs) AND (m.created_at > v_at OR m.updated_at > m.created_at)
    ) THEN
      v_reason := 'changed';
    ELSIF EXISTS (
      SELECT 1 FROM financial_record f
       WHERE (f.deal_id = v_deal OR f.engagement_id = ANY (v_engs))
         AND (NOT (f.id = ANY (v_recs)) OR f.updated_at > f.created_at)
    ) THEN
      v_reason := 'finance_changed';
    END IF;

    IF v_reason IS NOT NULL THEN
      v_kept := v_kept || jsonb_build_object('deal_id', v_deal, 'reason', v_reason);
      CONTINUE;
    END IF;

    -- Smazání v pořadí závislostí (cizí klíče finančních záznamů jsou RESTRICT)
    DELETE FROM financial_record WHERE id = ANY (v_recs);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_rec_del := v_rec_del + v_n;
    DELETE FROM engagement WHERE id = ANY (v_engs);
    DELETE FROM deal WHERE id = v_deal;
    DELETE FROM import_batch_item
     WHERE batch_id = p_batch_id
       AND ((entity_table = 'deal' AND entity_id = v_deal)
         OR (entity_table = 'engagement' AND entity_id = ANY (v_engs))
         OR (entity_table = 'financial_record' AND entity_id = ANY (v_recs))
         OR (entity_table = 'deal_scope_version' AND entity_id = ANY (v_vers)));
    v_reverted := v_reverted + 1;
  END LOOP;

  -- Klienti, které dávka založila -------------------------------------------
  FOR v_acc IN
    SELECT i.entity_id FROM import_batch_item i
     WHERE i.batch_id = p_batch_id AND i.entity_table = 'account' ORDER BY i.entity_id
  LOOP
    SELECT i.created_at INTO v_at FROM import_batch_item i
     WHERE i.batch_id = p_batch_id AND i.entity_table = 'account' AND i.entity_id = v_acc;
    IF NOT EXISTS (SELECT 1 FROM account a WHERE a.id = v_acc) THEN
      DELETE FROM import_batch_item WHERE batch_id = p_batch_id AND entity_table = 'account' AND entity_id = v_acc;
    ELSIF import_fk_refs('account'::regclass, v_acc) = 0
       AND NOT EXISTS (
         SELECT 1 FROM audit_event a
          WHERE a.entity_table = 'account' AND a.entity_id = v_acc
            AND a.occurred_at > v_at AND a.actor_type = 'user')
    THEN
      DELETE FROM account WHERE id = v_acc;
      DELETE FROM import_batch_item WHERE batch_id = p_batch_id AND entity_table = 'account' AND entity_id = v_acc;
      v_acc_del := v_acc_del + 1;
    ELSE
      v_acc_kept := v_acc_kept + 1;
    END IF;
  END LOOP;

  SELECT count(DISTINCT i.entity_id) INTO v_left FROM import_batch_item i
   WHERE i.batch_id = p_batch_id AND i.entity_table = 'deal';
  v_status := CASE WHEN v_left = 0 THEN 'reverted' ELSE 'partial' END;
  UPDATE import_batch
     SET status = v_status,
         reverted_at = CASE WHEN v_status = 'reverted' THEN now() ELSE reverted_at END,
         reverted_by = CASE WHEN v_status = 'reverted' THEN p_actor ELSE reverted_by END
   WHERE id = p_batch_id;

  SELECT * INTO v_ctx FROM audit_request_context();
  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after, evidence_id, info_state)
  VALUES (
    v_ctx.actor_type, v_ctx.actor_id, 'import.batch_reverted', 'import_batch', p_batch_id, NULL,
    jsonb_build_object(
      'deals_reverted', v_reverted, 'deals_kept', jsonb_array_length(v_kept),
      'accounts_deleted', v_acc_del, 'accounts_kept', v_acc_kept, 'records_deleted', v_rec_del, 'status', v_status
    ),
    NULL, 'human_confirmed'
  );

  PERFORM set_config('app.bulk_import', '', true);

  RETURN jsonb_build_object(
    'deals_reverted', v_reverted, 'deals_kept', v_kept, 'accounts_deleted', v_acc_del,
    'accounts_kept', v_acc_kept, 'records_deleted', v_rec_del, 'status', v_status);
END $$;

REVOKE ALL ON FUNCTION import_revert_batch(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION import_revert_batch(uuid, bigint) TO service_role;

INSERT INTO schema_migration (version, note)
VALUES ('0098', 'bulk_import: hromadny import bezicich zakazek (import_batch, import_batch_item, deal.import_batch_id, import_apply_row atomicky, idempotence pres klice, import_revert_batch, zdroj import u financnich zaznamu, historicka zakazka bez ukolu Naplanovat zahajeni)')
ON CONFLICT (version) DO NOTHING;
