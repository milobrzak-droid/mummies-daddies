-- 0072 — nabídka jako verze rozsahu (kapitola 5 plánu přestavby,
-- docs/PROVOZ.md: „Nabídka jako verze rozsahu.").
--
-- PROČ: dnes je nabídka jen řádek `deal` (import PDF v
-- domain/crm/actions/offers.ts zakládá rovnou obchod) a každá další úprava
-- rozsahu nebo ceny přepíše částku obchodu bez stopy, CO klient dostal
-- a CO přijal. Pipeline tak neumí odpovědět na „kterou verzi nabídky klient
-- schválil a za kolik". Tabulka deal_scope_version drží každou verzi rozsahu
-- s cenou jako samostatný, po odeslání neměnný záznam; obchod nese jen
-- částky PŘIJATÉ verze.
--
-- CO SE MĚNÍ
--
-- 1) Tabulka deal_scope_version: deal_id (FK, kaskáda se smazáním obchodu),
--    version (1, 2, 3 … unikátní v rámci obchodu), scope (text rozsahu),
--    amount_one_time + expected_mrr v měně verze (currency = typ
--    deal_currency z 0016 — částky jsou TAK, JAK BYLY KLIENTOVI NABÍDNUTÉ,
--    ne přepočtené), status, sent_at, decided_at, evidence_id (zdroj verze,
--    např. PDF nabídky; FK na evidence z 0038), created_by (DEFAULT
--    auth.uid()) a created_at.
--
--    Stavy: draft (koncept) → sent (odesláno klientovi) → accepted
--    (přijato) | rejected (odmítnuto); superseded (nahrazeno) dostane
--    koncept nebo odeslaná verze, když klient přijme jinou verzi, a dříve
--    přijatá verze, když klient přijme novější (změnový požadavek).
--    rejected a superseded jsou koncové. Tabulka přechodů
--    deal_scope_version_transition_ok MUSÍ zůstat shodná se
--    SCOPE_VERSION_TRANSITIONS v domain/crm/scopeVersion.ts
--    (test/scope-version.test.ts je porovnává).
--
-- 2) Nejvýš jedna přijatá verze na obchod — částečný unikátní index
--    (deal_id) WHERE status = 'accepted'.
--
-- 3) Strážce deal_scope_version_guard (BEFORE INSERT OR UPDATE):
--    * přihlášený uživatel zakládá jen koncept (draft) a jen sám za sebe
--      (created_by = auth.uid(), vzor L2 z 0053); service_role (import PDF)
--      smí založit rovnou odeslanou verzi a podepisuje ji created_by;
--    * přechody stavu jen podle tabulky (platí i pro service_role);
--    * obsah (scope, částky, měna, evidence) jde měnit jen u konceptu —
--      odeslaná nabídka je fakt, oprava = nová verze;
--    * deal_id, version, created_at se nemění nikdy, created_by jen na NULL
--      (ON DELETE SET NULL po odchodu člověka);
--    * sent_at a decided_at razítkuje databáze (now()), ne klient.
--    Chyby mají stabilní SQLSTATE (TS je překládá v SCOPE_VERSION_DB_CODES,
--    domain/crm/scopeVersion.ts):
--      SV001  nepovolený přechod stavu / nová verze v nepovoleném stavu
--      SV002  odeslanou (ne-koncept) verzi nejde měnit
--      SV003  neměnný sloupec (obchod, číslo verze, autor, vznik)
--      SV004  přijetí verze v EUR bez kurzu
--      SV005  verze nepatří k obchodu
--    Třída 'SV' nekoliduje s žádnou standardní třídou SQLSTATE (vzor CR
--    z 0052, LP z 0057).
--
-- 4) Přijetí verze = RPC accept_deal_scope_version(p_deal_id, p_version_id,
--    p_fx_rate). PROČ RPC: přijetí jsou tři zápisy, které musí projít
--    SPOLU — ostatní otevřené verze (a dříve přijatá) → superseded, verze →
--    accepted, částky obchodu ← verze. PostgREST neumí víc příkazů v jedné
--    transakci (viz 0034), funkce ano. Funkce je SECURITY INVOKER: běží
--    s právy a RLS volajícího (tým + AAL2 + obchodní role), takže nic
--    neobchází. Částky obchodu nastavuje obyčejným UPDATE deal jako
--    přihlášený uživatel — audit trigger z 0034/0035 (deal.amount_changed,
--    deal.money_changed) je tedy zapíše s aktérem auth.uid(), stejně jako
--    úpravu formulářem. Částky bere z verze, zvenku jen kurz: u verze v EUR
--    je amount_one_time_original = částka verze, fx_rate = p_fx_rate
--    a amount_one_time / expected_mrr = zaokrouhlený přepočet na Kč (deal
--    drží částky kanonicky v Kč, 0016). Kurz vybírá aplikace (živý ČNB,
--    nebo zmrazený kurz uzavřeného obchodu — shouldFreezeRate v
--    domain/finance/fx.ts). Fázi obchodu přijetí NEMĚNÍ (přechody fáze mají
--    vlastní pravidla, 0052). Audit přijetí s původem human_confirmed
--    zapisuje aplikace (recordAudit, deal.scope_version_accepted).
--
-- 5) RLS: tým čte/zakládá/upravuje (is_team_member), mazat jde jen koncept;
--    RESTRICTIVE AAL2 (0007) a RESTRICTIVE sales_only s can_see_sales()
--    (rozhodnutí majitele 2026-09-28, vzor 0058: obchody a částky vidí jen
--    vedeni a obchodnik). service_role (import PDF) RLS obchází.
--    Kaskádové smazání s obchodem běží jako vlastník tabulky — politika
--    „mazat jen koncept" ho neblokuje.
--
-- Kód je tolerantní k nenasazené migraci: čtení vrací stav „čeká na
-- migraci" (42P01 / PGRST205), akce hlásí klidnou českou větu, import PDF
-- verzi 1 bez tabulky jen přeskočí.
--
-- ZÁVISLOSTI: 0001 (deal), 0002 (is_team_member, team_member), 0016
-- (deal_currency), 0020 (can_see_sales), 0026 (schema_migration), 0038
-- (evidence). Guard níže skončí srozumitelnou chybou.
-- Idempotentní: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, DROP … IF EXISTS + CREATE, ON CONFLICT DO NOTHING.

DO $$
BEGIN
  IF to_regclass('public.deal') IS NULL OR to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0072 vyžaduje tabulky deal a team_member — nejdřív aplikujte 0001_base_schema.sql a 0002_auth_and_team.sql';
  END IF;
  IF to_regtype('public.deal_currency') IS NULL THEN
    RAISE EXCEPTION '0072 vyžaduje typ deal_currency — nejdřív aplikujte 0016_deal_currency.sql';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0072 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0072 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0072 vyžaduje tabulku evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0072 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) Tabulka
-- ===========================================================================

CREATE TABLE IF NOT EXISTS deal_scope_version (
  id               bigserial PRIMARY KEY,
  deal_id          bigint NOT NULL REFERENCES deal(id) ON DELETE CASCADE,
  version          integer NOT NULL,
  scope            text,
  amount_one_time  numeric(14,2) NOT NULL DEFAULT 0,
  expected_mrr     numeric(12,2) NOT NULL DEFAULT 0,
  currency         deal_currency NOT NULL DEFAULT 'CZK',
  status           text NOT NULL DEFAULT 'draft',
  sent_at          timestamptz,
  decided_at       timestamptz,
  evidence_id      bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  created_by       uuid DEFAULT auth.uid() REFERENCES team_member(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_scope_version_deal_version_key UNIQUE (deal_id, version),
  CONSTRAINT deal_scope_version_version_check CHECK (version >= 1),
  CONSTRAINT deal_scope_version_status_check
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'superseded')),
  CONSTRAINT deal_scope_version_scope_len CHECK (scope IS NULL OR char_length(scope) <= 4000),
  CONSTRAINT deal_scope_version_amount_check CHECK (amount_one_time >= 0),
  CONSTRAINT deal_scope_version_mrr_check CHECK (expected_mrr >= 0),
  -- Odeslaná, přijatá i odmítnutá verze byla klientovi odeslaná.
  CONSTRAINT deal_scope_version_sent_at_check
    CHECK (status NOT IN ('sent', 'accepted', 'rejected') OR sent_at IS NOT NULL),
  -- Rozhodnutí klienta nese čas; koncept ani odeslaná verze rozhodnutí nemá.
  CONSTRAINT deal_scope_version_decided_at_check
    CHECK (status NOT IN ('accepted', 'rejected') OR decided_at IS NOT NULL),
  CONSTRAINT deal_scope_version_undecided_check
    CHECK (status NOT IN ('draft', 'sent') OR decided_at IS NULL),
  CONSTRAINT deal_scope_version_draft_check
    CHECK (status <> 'draft' OR sent_at IS NULL)
);

COMMENT ON TABLE deal_scope_version IS
  'Verze rozsahu nabídky k obchodu (kap. 5). Částky v měně verze, jak byly nabídnuté; obchod nese částky přijaté verze (přepočtené na Kč).';
COMMENT ON COLUMN deal_scope_version.evidence_id IS
  'Zdroj verze (např. importované PDF nabídky) — ukazatel do evidence (0038), ne obsah.';

-- 2) Nejvýš jedna přijatá verze na obchod.
CREATE UNIQUE INDEX IF NOT EXISTS deal_scope_version_one_accepted_idx
  ON deal_scope_version (deal_id) WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS deal_scope_version_evidence_idx
  ON deal_scope_version (evidence_id) WHERE evidence_id IS NOT NULL;

-- ===========================================================================
-- 3) Přechody stavů a strážce
-- ===========================================================================

-- Tabulka přechodů (shodná se SCOPE_VERSION_TRANSITIONS v TS).
CREATE OR REPLACE FUNCTION deal_scope_version_transition_ok(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT (p_from, p_to) IN (VALUES
    ('draft', 'sent'), ('draft', 'superseded'),
    ('sent', 'accepted'), ('sent', 'rejected'), ('sent', 'superseded'),
    ('accepted', 'superseded')
  )
$$;

-- Volá ji strážce, který běží s právy zapisujícího (authenticated přes
-- appku, service_role při importu) — proto EXECUTE pro obě role. Je čistá,
-- nic neprozradí.
REVOKE ALL ON FUNCTION deal_scope_version_transition_ok(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION deal_scope_version_transition_ok(text, text) TO authenticated, service_role;

-- SECURITY INVOKER (výchozí): čte jen NEW/OLD a auth.uid(), žádnou tabulku.
CREATE OR REPLACE FUNCTION deal_scope_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_uid IS NOT NULL THEN
      -- Autor = přihlášený uživatel (vzor L2 z 0053).
      IF NEW.created_by IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'Autor verze nabídky musí být přihlášený uživatel' USING ERRCODE = '42501';
      END IF;
      -- Uživatel zakládá jen koncept; odeslání je samostatný krok.
      IF NEW.status <> 'draft' THEN
        RAISE EXCEPTION 'Nová verze nabídky musí začínat jako koncept' USING ERRCODE = 'SV001';
      END IF;
    ELSIF NEW.status NOT IN ('draft', 'sent') THEN
      -- service_role (import PDF) smí rovnou odeslanou verzi, přijatou ne:
      -- přijetí musí projít accept_deal_scope_version (částky obchodu).
      RAISE EXCEPTION 'Nová verze nabídky může být jen koncept nebo odeslaná' USING ERRCODE = 'SV001';
    END IF;
    NEW.decided_at := NULL;
    NEW.sent_at := CASE WHEN NEW.status = 'sent' THEN coalesce(NEW.sent_at, now()) ELSE NULL END;
    RETURN NEW;
  END IF;

  -- UPDATE ------------------------------------------------------------------

  IF NEW.deal_id IS DISTINCT FROM OLD.deal_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Obchod, číslo ani vznik verze nabídky nejde změnit' USING ERRCODE = 'SV003';
  END IF;
  -- Vynulování autora (ON DELETE SET NULL po odchodu člověka) projde,
  -- přepsat autora na někoho jiného ne.
  IF NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL THEN
    RAISE EXCEPTION 'Autora verze nabídky nejde změnit' USING ERRCODE = 'SV003';
  END IF;

  IF OLD.status <> 'draft'
     AND (NEW.scope IS DISTINCT FROM OLD.scope
          OR NEW.amount_one_time IS DISTINCT FROM OLD.amount_one_time
          OR NEW.expected_mrr IS DISTINCT FROM OLD.expected_mrr
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id) THEN
    RAISE EXCEPTION 'Odeslanou verzi nabídky nejde měnit — založ novou verzi' USING ERRCODE = 'SV002';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT deal_scope_version_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'Nepovolený přechod verze nabídky: % → %', OLD.status, NEW.status USING ERRCODE = 'SV001';
  END IF;

  -- Přijetí (a nahrazení přijaté verze) jen přes accept_deal_scope_version:
  -- jinak by přímý PATCH přes PostgREST přijal verzi bez přepsání částek
  -- obchodu, bez nahrazení ostatních verzí a bez auditu. RPC si nastaví
  -- transakčně lokální příznak s id obchodu; nikdo jiný ho nemá.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'accepted' OR OLD.status = 'accepted')
     AND coalesce(current_setting('app.scope_version_accept', true), '') <> NEW.deal_id::text THEN
    RAISE EXCEPTION 'Verzi nabídky lze přijmout (nebo přijatou nahradit) jen přes přijetí verze' USING ERRCODE = 'SV001';
  END IF;

  -- Časy razítkuje databáze, klient je nepřepíše.
  NEW.sent_at := CASE
    WHEN OLD.status = 'draft' AND NEW.status = 'sent' THEN now()
    ELSE OLD.sent_at
  END;
  NEW.decided_at := CASE
    WHEN OLD.status = 'sent' AND NEW.status IN ('accepted', 'rejected') THEN now()
    ELSE OLD.decided_at
  END;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION deal_scope_version_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS deal_scope_version_guard ON deal_scope_version;
CREATE TRIGGER deal_scope_version_guard
  BEFORE INSERT OR UPDATE ON deal_scope_version
  FOR EACH ROW EXECUTE FUNCTION deal_scope_version_guard();

-- ===========================================================================
-- 4) Přijetí verze — jedna transakce, práva volajícího
-- ===========================================================================

CREATE OR REPLACE FUNCTION accept_deal_scope_version(
  p_deal_id     bigint,
  p_version_id  bigint,
  p_fx_rate     numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ver         deal_scope_version%ROWTYPE;
  v_deal        record;
  v_amount      numeric(14,2);
  v_original    numeric(14,2);
  v_rate        numeric(10,4);
  v_mrr         numeric(12,2);
  v_superseded  integer[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nepřihlášený uživatel' USING ERRCODE = '42501';
  END IF;
  -- RLS by ne-obchodní roli verzi stejně nevrátila; tady srozumitelná chyba.
  IF NOT (SELECT can_see_sales()) THEN
    RAISE EXCEPTION 'Verze nabídky přijímá jen obchodní role' USING ERRCODE = '42501';
  END IF;

  -- FOR UPDATE: dvě souběžná přijetí téže verze (nebo dvou verzí téhož
  -- obchodu přes zámek obchodu níže) se seřadí.
  SELECT * INTO v_ver FROM deal_scope_version WHERE id = p_version_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verze nabídky % neexistuje', p_version_id USING ERRCODE = 'P0002';
  END IF;
  IF v_ver.deal_id IS DISTINCT FROM p_deal_id THEN
    RAISE EXCEPTION 'Verze nabídky nepatří k tomuto obchodu' USING ERRCODE = 'SV005';
  END IF;
  IF v_ver.status <> 'sent' THEN
    RAISE EXCEPTION 'Přijmout lze jen odeslanou verzi nabídky (stav %)', v_ver.status USING ERRCODE = 'SV001';
  END IF;

  SELECT d.id, d.currency, d.amount_one_time, d.amount_one_time_original, d.fx_rate, d.expected_mrr
    INTO v_deal
    FROM deal d
   WHERE d.id = v_ver.deal_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Obchod % neexistuje', v_ver.deal_id USING ERRCODE = 'P0002';
  END IF;

  IF v_ver.currency::text = 'EUR' THEN
    IF p_fx_rate IS NULL OR p_fx_rate <= 0 THEN
      RAISE EXCEPTION 'U verze v EUR chybí kurz pro přepočet na Kč' USING ERRCODE = 'SV004';
    END IF;
    v_rate     := p_fx_rate;
    v_original := v_ver.amount_one_time;
    v_amount   := round(v_ver.amount_one_time * p_fx_rate);
    v_mrr      := round(v_ver.expected_mrr * p_fx_rate);
  ELSE
    v_rate     := NULL;
    v_original := NULL;
    v_amount   := v_ver.amount_one_time;
    v_mrr      := v_ver.expected_mrr;
  END IF;

  -- Příznak pro strážce: tato transakce smí přijímat/nahrazovat přijatou
  -- verzi jen u tohoto obchodu (is_local = true → zmizí s transakcí).
  PERFORM set_config('app.scope_version_accept', v_ver.deal_id::text, true);

  -- Nejdřív ostatní otevřené verze a dříve přijatou → superseded, ať
  -- unikátní index „jedna přijatá" pustí přijetí této.
  WITH s AS (
    UPDATE deal_scope_version
       SET status = 'superseded'
     WHERE deal_id = v_ver.deal_id
       AND id <> v_ver.id
       AND status IN ('draft', 'sent', 'accepted')
    RETURNING version
  )
  SELECT coalesce(array_agg(version ORDER BY version), ARRAY[]::integer[]) INTO v_superseded FROM s;

  UPDATE deal_scope_version SET status = 'accepted' WHERE id = v_ver.id;

  -- Běžný UPDATE obchodu jako přihlášený uživatel → audit trigger 0034/0035
  -- zapíše deal.amount_changed / deal.money_changed s aktérem auth.uid().
  UPDATE deal
     SET currency = v_ver.currency,
         amount_one_time = v_amount,
         amount_one_time_original = v_original,
         fx_rate = v_rate,
         expected_mrr = v_mrr
   WHERE id = v_ver.deal_id;

  PERFORM set_config('app.scope_version_accept', '', true);

  RETURN jsonb_build_object(
    'deal_id', v_ver.deal_id,
    'version', v_ver.version,
    'evidence_id', v_ver.evidence_id,
    'superseded_versions', to_jsonb(v_superseded),
    'before', jsonb_build_object(
      'currency', v_deal.currency,
      'amount_one_time', v_deal.amount_one_time,
      'amount_one_time_original', v_deal.amount_one_time_original,
      'fx_rate', v_deal.fx_rate,
      'expected_mrr', v_deal.expected_mrr
    ),
    'after', jsonb_build_object(
      'currency', v_ver.currency,
      'amount_one_time', v_amount,
      'amount_one_time_original', v_original,
      'fx_rate', v_rate,
      'expected_mrr', v_mrr
    )
  );
END $$;

REVOKE ALL ON FUNCTION accept_deal_scope_version(bigint, bigint, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_deal_scope_version(bigint, bigint, numeric) TO authenticated;

-- ===========================================================================
-- 5) RLS
-- ===========================================================================

ALTER TABLE deal_scope_version ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_version_select ON deal_scope_version;
CREATE POLICY scope_version_select ON deal_scope_version FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS scope_version_insert ON deal_scope_version;
CREATE POLICY scope_version_insert ON deal_scope_version FOR INSERT
  WITH CHECK ((SELECT is_team_member()));

DROP POLICY IF EXISTS scope_version_update ON deal_scope_version;
CREATE POLICY scope_version_update ON deal_scope_version FOR UPDATE
  USING ((SELECT is_team_member()))
  WITH CHECK ((SELECT is_team_member()));

-- Mazat jde jen koncept — odeslaná nabídka je záznam o tom, co klient dostal.
DROP POLICY IF EXISTS scope_version_delete_draft ON deal_scope_version;
CREATE POLICY scope_version_delete_draft ON deal_scope_version FOR DELETE
  USING ((SELECT is_team_member()) AND status = 'draft');

DROP POLICY IF EXISTS require_aal2 ON deal_scope_version;
CREATE POLICY require_aal2 ON deal_scope_version
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

-- Částky nabídky vidí jen obchodní role (rozhodnutí majitele 2026-09-28, 0058).
DROP POLICY IF EXISTS sales_only ON deal_scope_version;
CREATE POLICY sales_only ON deal_scope_version
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

REVOKE ALL ON deal_scope_version FROM anon;

INSERT INTO schema_migration (version, note)
VALUES ('0072', 'deal_scope_version: verze rozsahu nabidky (draft/sent/accepted/rejected/superseded), jedna prijata na obchod, strazce prechodu, RPC accept_deal_scope_version, RLS tym + AAL2 + sales_only')
ON CONFLICT (version) DO NOTHING;
