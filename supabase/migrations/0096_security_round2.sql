-- 0096 — druhé kolo oprav z bezpečnostní revize 30. 9. 2026
-- (nálezy D2, D3 zbytek, D5, D6, D7, D8 část, N1, N7).
--
-- PROČ (stručně; čísla nálezů jsou z revize větve review/security-30-9)
--   D2  Měkký audit (audit_row_change_soft z 0082) selhává otevřeně: když se
--       zápis do audit_event nepovede, změna projde bez stopy. U změn oprávnění
--       (role, is_admin, manažer, deaktivace v team_member) a obsazení uzlů
--       Loop Core (kdo schvaluje) je to nepřijatelné — „radši neprovedená změna
--       než změna bez původu" (rozhodnutí 0064). Finance a ostatní tabulky
--       z 0082 zůstávají měkké (viz níž).
--   D3  auto_intake_dismiss (0086/0095) po zúžení v 0095 pořád (a) zavřel
--       úkol, který už někdo řeší, a (b) odložil o rok celou firmu, i když u ní
--       byl jiný obchod nebo dodávka (tedy skutečný klient).
--   D5  idoklad_discrepancy_guard (0092): NULL v podmínce nechal uzavřít rozdíl
--       bez rozhodnutí (resolution) a dovolil dvojice status/resolution, které
--       si odporují (resolved + dismissed).
--   D6  touch_changes_view (0075) ověřoval jen existenci řádku v team_member:
--       Partner nebo deaktivovaný člen prošel. Dokumentace slibuje
--       is_team_member().
--   D7  Hygiena práv: vnitřní pomocné a triggerové funkce a interní tabulky
--       nebyly konzistentně uzamčené pro authenticated / anon (v Supabase mají
--       role přímý výchozí grant; REVOKE ... FROM PUBLIC, anon ho nechalo
--       authenticated).
--   D8  storage.objects (0089): nepředpokládá, že na bucket `nabidky` neexistuje
--       starší permisivní politika. RESTRICTIVE politika pro čtení tohoto
--       bucketu jen s obchodní rolí to zavře bez ohledu na cokoli staršího;
--       migrace navíc jen ohlásí (NOTICE) cizí politiky na storage.objects.
--   N1  Limit API klíčů (lib/apiKeyAuth.ts) četl počet a až potom zapisoval
--       (závod), při chybě dotazu povolil. RPC api_request_hit zamkne klíč,
--       spočítá a zapíše v jedné transakci; retence 90 dní se řeší při
--       zápisu (žádný nový cron).
--   N7  Registraci OAuth klientů (/api/oauth/register) šlo zaplavit: limit byl
--       jen v paměti jedné instance. Klient dostává approved_at (nastaví ho
--       souhlas admina) a RPC oauth_client_register odmítne registraci nad
--       stropem neschválených klientů; neschválené starší než 3 dny maže.
--
-- CO SE MĚNÍ
--   1) audit_row_change_soft() (CREATE OR REPLACE, stejný podpis, SECURITY
--      DEFINER, search_path, práva): pro tabulky team_member a loop_node už
--      chybu zápisu auditu nezachytí do WARNING — změnu ZRUŠÍ (výjimka SQLSTATE
--      AU001 s textem bez dat řádku). Ostatní měkké tabulky se chovají jako v
--      0082. Seznam „tvrdých" tabulek je v tělu funkce (v_strict) a zrcadlí
--      ho AUDIT_FAIL_CLOSED_TABLES v core/auditCoverage.ts (hlídá test).
--      Triggery se nemění (stejný název, stejné argumenty), takže registr
--      DB_AUDITED_TABLES ani test triggerů se nemění.
--      financial_record, deal_scope_version, approval_execution,
--      mail_content_intake a idoklad_discrepancy zůstávají měkké: zapisuje je
--      dávková synchronizace (iDoklad, pošta) a výpadek audit_event by jinak
--      zastavil práci; rozhodnutí o jejich přechodu na tvrdý režim je věc
--      majitele (docs/PROVOZ.md, „Tři režimy").
--   2) idoklad_discrepancy_guard() (CREATE OR REPLACE, stejný podpis a trigger
--      z 0092): člověk smí uzavřít rozdíl jen dvojicí resolved + applied nebo
--      dismissed + dismissed; NULL už neprojde.
--   3) touch_changes_view() (CREATE OR REPLACE, stejný podpis, návratový tvar a
--      práva z 0075): vnitřní kontrola členství je is_team_member().
--   4) auto_intake_dismiss(bigint) (CREATE OR REPLACE, stejný podpis, práva a
--      návratový tvar z 0095): úkol se zavře jen ve stavu todo (jinak zůstane
--      a v odpovědi je task = 'kept'); firma se odloží o rok jen tehdy, když u ní
--      není jiný než tento obchod (kromě prohraných) ani žádná dodávka
--      (jinak snooze_until zůstane beze změny, v odpovědi null).
--   5) REVOKE u vnitřních funkcí a tabulek (jen ty, které existují).
--   6) storage.objects: RESTRICTIVE nabidky_sales_only (čtení jen s obchodní
--      rolí, nad libovolnými staršími politikami). Nezávažné selhání (chybí
--      oprávnění) skončí varováním, ne pádem migrace.
--   7) api_request_hit(bigint, text, integer) + index api_request(at).
--   8) oauth_client.approved_at (+ zpětné doplnění u klientů, kteří už mají
--      token) a oauth_client_register(...).
--
-- KÓD BEZ MIGRACE: aplikace běží i před aplikací téhle migrace. Bez
-- api_request_hit se použije původní count-then-insert (nově s odmítnutím při
-- chybě DB); bez oauth_client_register a approved_at registrace funguje jako
-- dřív bez stropu neschválených.
--
-- POŘADÍ NASAZENÍ: po 0095. Číslo 0096 je souvislé s 0095, do
-- test/migrations-lint.test.ts se žádná mezera nepřidává.
--
-- AUDIT: žádná nová tabulka ani trigger; audit_row_change_soft na team_member a
-- loop_node zůstává napojený stejně jako v 0082.
--
-- IDEMPOTENCE: CREATE OR REPLACE FUNCTION, DROP POLICY IF EXISTS + CREATE,
-- ADD COLUMN IF NOT EXISTS, UPDATE jen řádků bez approved_at, REVOKE, ON
-- CONFLICT. Zámky: ALTER oauth_client (ADD COLUMN bez defaultu) krátký;
-- CREATE INDEX na api_request a oauth_client nad malými tabulkami; výměna funkcí
-- a politik jen na okamžik.
--
-- ZÁVISLOSTI: 0082 (audit_row_change_soft, audit_row_record, is_team_member,
-- team_member, loop_node), 0075 (touch_changes_view), 0092
-- (idoklad_discrepancy_guard), 0086/0095 (auto_intake_dismiss), 0039
-- (loop_actor), 0024 (api_request), 0018/0083 (oauth_client,
-- oauth_refresh_token, api_key), 0026 (ledger). Guard níže skončí srozumitelnou
-- chybou.

DO $$
BEGIN
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL
     OR to_regprocedure('public.audit_row_record(text, text, jsonb, jsonb, text[], text[], text, text[])') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje audit_row_change_soft() a audit_row_record() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regclass('public.team_member') IS NULL OR to_regclass('public.loop_node') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje tabulky team_member a loop_node — nejdřív aplikujte 0002 a 0039';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL OR to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje is_team_member() a can_see_sales() — nejdřív aplikujte 0082 a 0020';
  END IF;
  IF to_regprocedure('public.touch_changes_view()') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje touch_changes_view() — nejdřív aplikujte 0075_changes_view.sql';
  END IF;
  IF to_regprocedure('public.idoklad_discrepancy_guard()') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje idoklad_discrepancy_guard() — nejdřív aplikujte 0092_idoklad_sync.sql';
  END IF;
  IF to_regprocedure('public.auto_intake_dismiss(bigint)') IS NULL
     OR to_regprocedure('public.loop_actor()') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje auto_intake_dismiss() a loop_actor() — nejdřív aplikujte 0086 (a 0095) a 0039';
  END IF;
  IF to_regclass('public.api_request') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje tabulku api_request — nejdřív aplikujte 0024_security_gaps.sql';
  END IF;
  IF to_regclass('public.oauth_client') IS NULL
     OR to_regclass('public.oauth_refresh_token') IS NULL
     OR to_regclass('public.api_key') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje tabulky oauth_client, oauth_refresh_token a api_key — nejdřív aplikujte 0018 a 0083';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'task' AND column_name = 'status')
           OR (table_name = 'account' AND column_name IN ('snooze_until'))
           OR (table_name = 'deal' AND column_name IN ('stage', 'amount_one_time', 'lost_reason', 'closed_at', 'forecast_category', 'probability_pct', 'next_step', 'next_step_due'))
           OR (table_name = 'engagement' AND column_name = 'account_id'))) <> 11 THEN
    RAISE EXCEPTION '0096 vyžaduje sloupce obchodu, úkolu, klienta a dodávky ze starších migrací — nejdřív aplikujte 0001, 0020, 0021 a 0030';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0096 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  -- Ledger: 0095 (a tím i všechny starší) je aplikovaná. Pořadí jinak hlídá běhač.
  IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE version = '0095') THEN
    RAISE EXCEPTION '0096 se aplikuje po 0095_security_review_hardening.sql (chybí v ledgeru schema_migration)';
  END IF;
END $$;

-- ===========================================================================
-- 1) D2: audit oprávnění a obsazení uzlů je tvrdý (fail-closed)
-- ===========================================================================

-- Trigger (AFTER … FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(a, b, c, d)):
-- argumenty a chování jako v 0082. Rozdíl: tabulky v v_strict změnu při selhání
-- auditu zruší (AFTER trigger vyhodí výjimku → celý příkaz se vrátí). Text
-- výjimky nese jen operaci, tabulku a SQLSTATE původní chyby; hodnoty řádku
-- z původní chyby (DETAIL „Failing row contains …") se nepřebírají.
CREATE OR REPLACE FUNCTION audit_row_change_soft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old    jsonb;
  v_new    jsonb;
  -- Tabulky, kde změna bez auditního řádku nesmí projít (oprávnění a obsazení
  -- uzlů). MUSÍ sedět s AUDIT_FAIL_CLOSED_TABLES v core/auditCoverage.ts.
  v_strict boolean := TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = ANY (ARRAY['team_member', 'loop_node']);
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
    IF v_strict THEN
      -- Jen SQLSTATE, tabulka a operace: text původní výjimky může nést hodnoty řádku.
      RAISE EXCEPTION '0096: audit % na % selhal (SQLSTATE %), změna se ruší, protože by zůstala bez stopy',
        TG_OP, TG_TABLE_NAME, SQLSTATE USING ERRCODE = 'AU001';
    END IF;
    RAISE WARNING '0082: audit % na % selhal (SQLSTATE %), zápis pokračuje bez stopy v audit_event',
      TG_OP, TG_TABLE_NAME, SQLSTATE;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION audit_row_change_soft() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_row_change_soft() FROM anon, authenticated;

-- Trigger na obou tvrdých tabulkách musí existovat a být zapnutý; jinak by
-- tvrdý režim byl jen na papíře. Ohlásí se výjimkou, ne tichým přeskočením.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['team_member', 'loop_node'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = ('public.' || v_table)::regclass
         AND t.tgname = 'audit_row_change_soft'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
    ) THEN
      RAISE EXCEPTION '0096: na tabulce % chybí (nebo je vypnutý) trigger audit_row_change_soft z 0082', v_table;
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- 2) D5: idoklad_discrepancy_guard — uzavření jen platnou dvojicí
-- ===========================================================================

-- Tělo je 0092 beze změny kromě kontroly uzavření: resolution nesmí být NULL a
-- musí odpovídat stavu (resolved ↔ applied, dismissed ↔ dismissed). Servisní zápis
-- úlohy (bez auth.uid()) nemá omezení, jako dřív.
CREATE OR REPLACE FUNCTION idoklad_discrepancy_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.idoklad_kind, NEW.idoklad_id, NEW.document_number, NEW.account_id, NEW.record_id,
      NEW.currency, NEW.idoklad_amount, NEW.record_amount, NEW.reason, NEW.fingerprint, NEW.first_seen_at, NEW.last_seen_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.idoklad_kind, OLD.idoklad_id, OLD.document_number, OLD.account_id, OLD.record_id,
      OLD.currency, OLD.idoklad_amount, OLD.record_amount, OLD.reason, OLD.fingerprint, OLD.first_seen_at, OLD.last_seen_at) THEN
    RAISE EXCEPTION 'Rozdíl z iDokladu lze jen uzavřít, ne přepsat'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'Uzavřený rozdíl už člověk znovu neotevírá'
        USING ERRCODE = 'check_violation';
    END IF;
    -- NULL resolution nebo dvojice, které si odporují, se odmítnou (0096, D5).
    IF NEW.status IS NULL OR NEW.resolution IS NULL
       OR NEW.status NOT IN ('resolved', 'dismissed')
       OR NEW.resolution NOT IN ('applied', 'dismissed')
       OR (NEW.status = 'resolved') IS DISTINCT FROM (NEW.resolution = 'applied') THEN
      RAISE EXCEPTION 'Rozdíl lze uzavřít jako vyřešený (applied) nebo odložený (dismissed)'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.resolved_by := auth.uid();
    NEW.resolved_at := now();
  ELSIF (NEW.resolution, NEW.resolution_note, NEW.resolved_at, NEW.resolved_by)
        IS DISTINCT FROM (OLD.resolution, OLD.resolution_note, OLD.resolved_at, OLD.resolved_by) THEN
    RAISE EXCEPTION 'Rozhodnutí o rozdílu se po uzavření nemění'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION idoklad_discrepancy_guard() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 3) D6: touch_changes_view — aktivní člen interní role (is_team_member())
-- ===========================================================================

-- Tělo je 0075 beze změny kromě členství. Volající je SECURITY DEFINER, proto
-- is_team_member() vyhodnotí auth.uid() volajícího (allowlist rolí, deaktivace).
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
  IF NOT is_team_member() THEN
    RAISE EXCEPTION 'touch_changes_view: jen aktivní člen týmu' USING ERRCODE = '42501';
  END IF;

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

-- ===========================================================================
-- 4) D3 (zbytek): auto_intake_dismiss nesahá na rozpracovaný úkol a na firmu s jinou prací
-- ===========================================================================

-- Výjimky jako v 0095: P0002 záznam neexistuje, 22023 už vráceno / už uzavřeno,
-- 42501 bez oprávnění, AI002 obchod je vyhraný, AI003 s obchodem se už pracuje.
-- Návratový tvar se jen rozšiřuje: task může být nově 'kept' (úkol už někdo
-- řeší), snooze_until je null, když se firma neodkládá, a přibývá klíč account
-- ('snoozed' | 'kept' | 'none').
CREATE OR REPLACE FUNCTION auto_intake_dismiss(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  text := loop_actor();
  v_row    auto_intake%ROWTYPE;
  v_today  date := (now() AT TIME ZONE 'Europe/Prague')::date;
  v_stage  text;
  v_amount numeric;
  v_deal   text := 'none';
  v_task   text := 'none';
  v_until  date;
  v_cnt    integer;
  v_other  boolean;
  v_acct   text := 'none';
BEGIN
  IF NOT can_see_sales() THEN
    RAISE EXCEPTION 'Poptávky smí uzavírat jen obchodní role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM auto_intake WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automatické založení % neexistuje', p_id USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status = 'undone' THEN
    RAISE EXCEPTION 'Už bylo vráceno' USING ERRCODE = '22023';
  END IF;
  IF v_row.status = 'dismissed' THEN
    RAISE EXCEPTION 'Už je uzavřeno jako Není poptávka' USING ERRCODE = '22023';
  END IF;

  IF v_row.deal_id IS NOT NULL THEN
    SELECT stage::text, coalesce(amount_one_time, 0) INTO v_stage, v_amount
      FROM deal WHERE id = v_row.deal_id FOR UPDATE;
    IF FOUND THEN
      IF v_stage = 'vyhráno' THEN
        RAISE EXCEPTION 'Obchod je vyhraný — poptávka to byla' USING ERRCODE = 'AI002';
      ELSIF v_stage = 'prohráno' THEN
        v_deal := 'already_lost';
      ELSIF v_stage <> 'kvalifikace' OR v_amount <> 0 THEN
        RAISE EXCEPTION 'S obchodem se už pracuje — jako Není poptávka ho nejde uzavřít' USING ERRCODE = 'AI003', DETAIL = 'deal_moved';
      ELSE
        UPDATE deal
           SET stage = 'prohráno', lost_reason = 'Nebyla to poptávka', closed_at = v_today,
               forecast_category = 'closed', probability_pct = 0, next_step = NULL, next_step_due = NULL
         WHERE id = v_row.deal_id;
        v_deal := 'lost';
      END IF;
    END IF;
  END IF;

  -- Úkol: zavře se jen nedotčený (todo). Rozpracovaný nebo zablokovaný úkol je
  -- práce člověka a zůstává (stejná hranice jako u Zpět v 0086).
  IF v_row.task_id IS NOT NULL THEN
    UPDATE task SET status = 'done' WHERE id = v_row.task_id AND status::text = 'todo';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt > 0 THEN
      v_task := 'done';
    ELSIF EXISTS (SELECT 1 FROM task WHERE id = v_row.task_id AND status::text NOT IN ('todo', 'done')) THEN
      v_task := 'kept';
    END IF;
  END IF;

  -- Firma: odložení o rok jen u firmy, která je celá z téhle poptávky. Jiný než
  -- tento obchod (kromě prohraných) nebo jakákoli dodávka = skutečný klient,
  -- kterému se follow-up nesmí vypnout.
  IF v_row.account_id IS NOT NULL THEN
    SELECT EXISTS (
             SELECT 1 FROM deal d
              WHERE d.account_id = v_row.account_id
                AND d.id IS DISTINCT FROM v_row.deal_id
                AND d.stage::text <> 'prohráno')
        OR EXISTS (SELECT 1 FROM engagement e WHERE e.account_id = v_row.account_id)
      INTO v_other;
    IF v_other THEN
      v_until := NULL;
      v_acct := 'kept';
    ELSE
      UPDATE account
         SET snooze_until = GREATEST(coalesce(snooze_until, v_today), v_today + 365)
       WHERE id = v_row.account_id
      RETURNING snooze_until INTO v_until;
      v_acct := 'snoozed';
    END IF;
  END IF;

  UPDATE auto_intake SET status = 'dismissed', decided_by = v_actor, decided_at = now() WHERE id = p_id;

  RETURN jsonb_build_object('status', 'dismissed', 'id', p_id, 'deal', v_deal, 'task', v_task,
                            'snooze_until', v_until, 'account', v_acct);
END $$;

REVOKE ALL ON FUNCTION auto_intake_dismiss(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auto_intake_dismiss(bigint) TO authenticated;

-- ===========================================================================
-- 5) D7: hygiena práv vnitřních funkcí a tabulek
-- ===========================================================================

-- Pomocné a triggerové funkce nemají mít EXECUTE pro klientské role (PostgREST
-- funkce vracející trigger nevystavuje, ale zbytečné právo je zbytečné právo).
-- Trigger se při spuštění právo EXECUTE nekontroluje, jen při CREATE TRIGGER.
-- Jen to, co existuje; chybějící funkce (starší schéma) se přeskočí.
DO $$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.auto_delivery_template_key(text, text)',
    'public.auto_delivery_milestones(text)',
    'public.auto_delivery_engagement_kind(text)',
    'public.auto_delivery_phase(text, text, text)',
    'public.auto_delivery_add_working_days(date, integer)',
    'public.engagement_impact_unmeasurable_stamp()',
    'public.financial_record_due_guard()',
    'public.financial_record_idoklad_guard()',
    'public.idoklad_discrepancy_guard()'
  ] LOOP
    IF to_regprocedure(v_sig) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    END IF;
  END LOOP;
END $$;

-- Interní tabulky: anon k nim nemá mít žádné právo (chrání je RLS, ale právo
-- navíc vystavuje i schéma v OpenAPI). authenticated se nemění: jeho čtení a
-- zápis řídí politiky a sloupcové GRANTy z migrací tabulek.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'approval_execution', 'idoklad_discrepancy', 'engagement_document_version',
    'engagement_document_finding', 'engagement_document', 'changes_view',
    'meeting_note_intake', 'auto_intake', 'mail_content_intake'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_table);
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- 6) D8: bucket nabidky se čte jen s obchodní rolí, i kdyby existovala starší politika
-- ===========================================================================

DO $$
DECLARE
  v_extra text;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '0096: schéma storage (tabulka storage.objects) neexistuje — politika nabidky_sales_only přeskočena (mimo Supabase je to v pořádku).';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS nabidky_sales_only ON storage.objects';
  EXECUTE 'CREATE POLICY nabidky_sales_only ON storage.objects
    AS RESTRICTIVE FOR SELECT TO anon, authenticated
    USING (bucket_id <> ''nabidky'' OR (SELECT public.can_see_sales()))';

  -- Cizí politiky na storage.objects: jen oznámení, nic se neodstraňuje.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_extra
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname NOT IN ('nabidky_sales_read', 'nabidky_sales_only', 'nabidky_no_client_insert',
                            'nabidky_no_client_update', 'nabidky_no_client_delete', 'storage_team_aal2');
  IF v_extra IS NOT NULL THEN
    RAISE NOTICE '0096: na storage.objects jsou další politiky (%): ověřte v Supabase → Storage → Policies, že nedávají přístup k jiným bucketům, než mají. Bucket nabidky je nově chráněn restriktivní politikou nabidky_sales_only.', v_extra;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING '0096: chybí oprávnění zakládat politiky na storage.objects (%). Politiku nabidky_sales_only založte ručně v Supabase → Storage → Policies (RESTRICTIVE, SELECT, bucket_id <> ''nabidky'' OR can_see_sales()).', SQLERRM;
END $$;

-- ===========================================================================
-- 7) N1: limit API klíčů jedním atomickým krokem
-- ===========================================================================

CREATE INDEX IF NOT EXISTS api_request_at_idx ON api_request(at);

-- Zamkne klíč (advisory zámek na dobu transakce), spočítá volání za poslední
-- minutu a bez překročení limitu zapíše nové. true = povoleno a zapsáno,
-- false = limit (nic se nezapisuje). Retence stopy 90 dní: při zhruba každém
-- dvousetném volání se smažou starší řádky (žádný cron). Volá jen aplikace se
-- servisním klíčem.
CREATE OR REPLACE FUNCTION api_request_hit(p_key_id bigint, p_path text, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_key_id IS NULL OR p_path IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'api_request_hit: neplatné argumenty' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('api_request_hit:' || p_key_id::text, 0));

  SELECT count(*) INTO v_n
    FROM api_request
   WHERE key_id = p_key_id AND at >= now() - interval '60 seconds';
  IF v_n >= p_limit THEN
    RETURN false;
  END IF;

  INSERT INTO api_request (key_id, path) VALUES (p_key_id, left(p_path, 200));

  IF random() < 0.005 THEN
    DELETE FROM api_request WHERE at < now() - interval '90 days';
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION api_request_hit(bigint, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api_request_hit(bigint, text, integer) TO service_role;

-- ===========================================================================
-- 8) N7: strop neschválených OAuth klientů
-- ===========================================================================

ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN oauth_client.approved_at IS
  'Kdy admin poprvé schválil přístup tohoto klienta na souhlasné obrazovce (0096). NULL = jen zaregistrován: takový klient se po 3 dnech maže a počet takových klientů má strop (oauth_client_register).';

-- Zpětně: klient, který už má refresh token nebo klíč konektoru (název nese
-- posledních 6 znaků client_id, viz connectorKeyName), byl schválen.
UPDATE oauth_client c
   SET approved_at = c.created_at
 WHERE c.approved_at IS NULL
   AND (EXISTS (SELECT 1 FROM oauth_refresh_token r WHERE r.client_id = c.client_id)
     OR EXISTS (SELECT 1 FROM api_key k
                 WHERE k.name LIKE 'OAuth%'
                   AND right(k.name, 8) = '(' || right(c.client_id, 6) || ')'));

CREATE INDEX IF NOT EXISTS oauth_client_unapproved_idx ON oauth_client(created_at) WHERE approved_at IS NULL;

-- Zaregistruje klienta, pokud počet neschválených nepřekračuje strop. Před
-- počítáním smaže neschválené starší než p_ttl_days dní (kaskáda odnese jejich
-- kódy). Zámek zajistí, že souběžné registrace strop nepřeskočí.
-- true = zaregistrováno, false = strop.
CREATE OR REPLACE FUNCTION oauth_client_register(
  p_client_id text,
  p_client_name text,
  p_redirect_uris text[],
  p_max_unapproved integer,
  p_ttl_days integer DEFAULT 3
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_client_id IS NULL OR p_client_id !~ '^cockpit-client_[A-Za-z0-9_-]{8,100}$' THEN
    RAISE EXCEPTION 'oauth_client_register: neplatné client_id' USING ERRCODE = '22023';
  END IF;
  IF p_redirect_uris IS NULL OR cardinality(p_redirect_uris) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'oauth_client_register: redirect_uris musí mít 1 až 10 položek' USING ERRCODE = '22023';
  END IF;
  IF p_max_unapproved IS NULL OR p_max_unapproved < 1 OR p_ttl_days IS NULL OR p_ttl_days < 1 THEN
    RAISE EXCEPTION 'oauth_client_register: neplatný strop nebo doba platnosti' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('oauth_client_register', 0));

  DELETE FROM oauth_client
   WHERE approved_at IS NULL AND created_at < now() - make_interval(days => p_ttl_days);

  SELECT count(*) INTO v_n FROM oauth_client WHERE approved_at IS NULL;
  IF v_n >= p_max_unapproved THEN
    RETURN false;
  END IF;

  INSERT INTO oauth_client (client_id, client_name, redirect_uris)
  VALUES (p_client_id, left(p_client_name, 100), p_redirect_uris);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION oauth_client_register(text, text, text[], integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION oauth_client_register(text, text, text[], integer, integer) TO service_role;

INSERT INTO schema_migration (version, note)
VALUES ('0096', 'druhe kolo bezpecnostnich oprav: audit team_member a loop_node fail-closed (AU001), idoklad guard bez NULL, touch_changes_view is_team_member, auto_intake_dismiss nezavre rozpracovany ukol ani neodlozi skutecneho klienta, REVOKE vnitrnich funkci a tabulek, storage nabidky_sales_only, api_request_hit (atomicky limit), oauth_client.approved_at + oauth_client_register (strop neschvalenych)')
ON CONFLICT (version) DO NOTHING;
