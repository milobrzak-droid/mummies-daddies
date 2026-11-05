-- 0057 — zpevnění Loop Core po druhém security review: vlastnictví případu
-- a uzel jen pro oprávněné (H1), uzel schvalovacího požadavku zmrazený
-- v okamžiku žádosti (H2), auditní stopa přežije smazání případu a mazat
-- smí jen vedení (M3), přechody stavů případu a kroku v DB (M7), žádost
-- o schválení jen pro otevřený případ (L8) a autor případu z auth.uid() (L9).
--
-- PROČ TADY A NE V 0039/0053: 0039 už běží v produkci a 0053 se právě
-- aplikuje. Aplikovaný soubor se nemění (na produkci by se změna nikdy
-- neprojevila). Všechno je CREATE OR REPLACE / idempotentní ALTER / DROP …
-- IF EXISTS; opakovaný běh je bezpečný.
--
-- POŘADÍ: 0057 MUSÍ běžet PO 0053. Přepisuje request_approval
-- a decide_approval z 0053 (zachovává jejich sémantiku: podlaha úrovně
-- z authority_policy, SECURITY DEFINER, search_path, granty) a ruší
-- loop_approver_role(uuid, bigint). Kdyby se 0053 po 0057 spustila znovu,
-- vrátila by staré verze funkcí — pak je nutné pustit znovu i 0057.
--
-- H1 — work_case je pro tým zapisovatelný přímo (RLS), takže kdokoli mohl
-- PATCHnout lead_owner_id / deputy_id na sebe a projít loop_can_resolve_case.
-- Trigger work_case_guard nově dovolí změnit lead_owner_id, deputy_id nebo
-- node jen: vedeni (team_member.role), současnému vlastníkovi případu
-- (OLD.lead_owner_id) nebo vlastníkovi uzlu případu (loop_node.owner_id pro
-- OLD.node). Vyhodnocuje se z auth.uid(); service_role (bez auth.uid()) je
-- vyjmutá. Výjimka: vynulování vlastníka/zástupce, jehož team_member už
-- neexistuje (ON DELETE SET NULL po odchodu člověka), projde vždy.
--
-- H2 — loop_approver_role četla work_case.node až při rozhodnutí; vlastník
-- uzlu tak mohl případ přesunout do svého uzlu a schválit si ho.
-- approval_request.node je snímek uzlu z okamžiku žádosti (request_approval
-- ho bere z případu). decide_approval určuje roli přes
-- loop_approver_role_for_node(auth.uid(), approval_request.node). Požadavek
-- bez uzlu (bez případu) = rozhoduje jen vedeni, stejně jako v 0053.
-- Stávající řádky se doplní z jejich případu.
--
-- M3 — approval_request.case_id a decision.case_id měly ON DELETE CASCADE:
-- smazání případu smazalo i auditní stopu schvalování a rozhodnutí. Nově
-- ON DELETE RESTRICT. Mazat work_case smí přes RLS jen vedeni (politika
-- FOR ALL se rozpadá na SELECT/INSERT/UPDATE pro tým + DELETE pro vedení;
-- RESTRICTIVE AAL2 zůstává). case_step dál kaskáduje (kroky nejsou audit).
--
-- M7 — přechody stavů hlídaly jen čisté funkce v core/workCase.ts. Nově
-- i triggery. Tabulky přechodů v loop_case_transition_ok /
-- loop_step_transition_ok MUSÍ zůstat shodné s CASE_TRANSITIONS
-- a STEP_TRANSITIONS v core/workCase.ts (test/loop-hardening.test.ts je
-- porovnává). Uzavření případu (→ done) jako caseCloseIssues: všechny
-- kroky done/skipped a — má-li případ kroky — aspoň jeden done. Konečný
-- stav (done/cancelled) se nemění; kroky uzavřeného případu se nepřidávají,
-- nemění ani nemažou. Přechody platí pro všechny včetně service_role
-- (oprava dat = vědomé ALTER TABLE … DISABLE TRIGGER).
--
-- CHYBY (stabilní SQLSTATE, TS je mapuje v core/loopQueries.ts
-- loopGuardErrorMessage):
--   LP001  nepovolený přechod stavu případu / nový případ mimo 'open'
--   LP002  nepovolený přechod stavu kroku / nový krok mimo 'todo'
--   LP003  případ nejde uzavřít (kroky)
--   LP004  případ je uzavřený (kroky, žádost o schválení)
--   LP005  změna vlastníka/zástupce/uzlu bez oprávnění
--   LP006  created_by musí být přihlášený aktér a nejde změnit
--   LP007  krok nelze přesunout do jiného případu
--
-- L8 — request_approval odmítne neexistující (P0002) a uzavřený (LP004)
-- případ.
--
-- L9 — work_case.created_by: DEFAULT loop_actor() a trigger, který pro
-- přihlášeného uživatele vynutí created_by = 'user:<auth.uid()>' při INSERT
-- a zakáže ho měnit při UPDATE. TS ho už neposílá. service_role vkládá
-- created_by výslovně ('system:<job>'); bez něj DEFAULT loop_actor() skončí
-- chybou „Nepřihlášený uživatel" — systémový zápis se musí podepsat.
--
-- ZÁVISLOSTI: 0039 (Loop Core) a 0053 (loop_level_rank, loop_role_max_level,
-- loop_can_resolve_case). Guard níže skončí srozumitelnou chybou.

DO $$
BEGIN
  IF to_regclass('public.work_case') IS NULL
     OR to_regclass('public.case_step') IS NULL
     OR to_regclass('public.decision') IS NULL
     OR to_regclass('public.approval_request') IS NULL
     OR to_regclass('public.loop_node') IS NULL
     OR to_regprocedure('public.loop_actor()') IS NULL THEN
    RAISE EXCEPTION '0057 vyžaduje Loop Core (work_case, case_step, decision, approval_request, loop_node, loop_actor) — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
  IF to_regprocedure('public.loop_level_rank(text)') IS NULL
     OR to_regprocedure('public.loop_role_max_level(text)') IS NULL
     OR to_regprocedure('public.loop_can_resolve_case(uuid, bigint)') IS NULL THEN
    RAISE EXCEPTION '0057 vyžaduje pravomoc schvalování v SQL (loop_level_rank, loop_role_max_level, loop_can_resolve_case) — nejdřív aplikujte 0053_security_hardening.sql';
  END IF;
END $$;

-- ===========================================================================
-- Pomocník: je přihlášený uživatel vedení? (RLS DELETE politika, triggery)
-- ===========================================================================

CREATE OR REPLACE FUNCTION loop_is_vedeni(p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_member IS NOT NULL
     AND EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = p_member AND tm.role::text = 'vedeni')
$$;

REVOKE ALL ON FUNCTION loop_is_vedeni(uuid) FROM PUBLIC, anon;
-- RLS politika se vyhodnocuje s právy volajícího → authenticated EXECUTE
-- potřebuje. Prozradí jen, zda má člen roli vedeni (team_member tým čte).
GRANT EXECUTE ON FUNCTION loop_is_vedeni(uuid) TO authenticated;

-- ===========================================================================
-- M7 — tabulky přechodů (shodné s core/workCase.ts)
-- ===========================================================================

CREATE OR REPLACE FUNCTION loop_case_transition_ok(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT (p_from, p_to) IN (VALUES
    ('open', 'in_progress'), ('open', 'waiting'), ('open', 'cancelled'),
    ('in_progress', 'waiting'), ('in_progress', 'done'), ('in_progress', 'cancelled'),
    ('waiting', 'in_progress'), ('waiting', 'cancelled')
  )
$$;

CREATE OR REPLACE FUNCTION loop_step_transition_ok(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT (p_from, p_to) IN (VALUES
    ('todo', 'doing'), ('todo', 'blocked'), ('todo', 'skipped'),
    ('doing', 'todo'), ('doing', 'blocked'), ('doing', 'done'),
    ('blocked', 'doing'), ('blocked', 'skipped')
  )
$$;

REVOKE ALL ON FUNCTION loop_case_transition_ok(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION loop_step_transition_ok(text, text) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- H1 + M7 + L9 — strážce work_case
-- ===========================================================================

-- SECURITY DEFINER: čte case_step, loop_node a team_member bez ohledu na RLS
-- volajícího (výsledek kontroly nesmí záviset na tom, co volající vidí).
CREATE OR REPLACE FUNCTION work_case_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_fk_cleanup  boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- L9: autor = přihlášený aktér (service_role vyjmutá, podepisuje se sama).
    IF v_uid IS NOT NULL AND NEW.created_by IS DISTINCT FROM ('user:' || v_uid::text) THEN
      RAISE EXCEPTION 'Autor případu musí být přihlášený uživatel' USING ERRCODE = 'LP006';
    END IF;
    IF v_uid IS NOT NULL AND NEW.status <> 'open' THEN
      RAISE EXCEPTION 'Nový případ musí začínat ve stavu open' USING ERRCODE = 'LP001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE ---------------------------------------------------------------

  -- M7: stav případu.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT loop_case_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Nepovolený přechod případu: % → %', OLD.status, NEW.status USING ERRCODE = 'LP001';
    END IF;
    IF NEW.status = 'done' THEN
      IF EXISTS (SELECT 1 FROM case_step cs WHERE cs.case_id = NEW.id AND cs.status NOT IN ('done', 'skipped')) THEN
        RAISE EXCEPTION 'Případ nejde uzavřít: nedokončené kroky' USING ERRCODE = 'LP003';
      END IF;
      IF EXISTS (SELECT 1 FROM case_step cs WHERE cs.case_id = NEW.id)
         AND NOT EXISTS (SELECT 1 FROM case_step cs WHERE cs.case_id = NEW.id AND cs.status = 'done') THEN
        RAISE EXCEPTION 'Případ nejde uzavřít: žádný krok není done' USING ERRCODE = 'LP003';
      END IF;
    END IF;
  END IF;

  -- service_role / migrace (bez auth.uid()) dál jen přechody výše.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- L9: autora nejde přepsat.
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Autora případu nelze změnit' USING ERRCODE = 'LP006';
  END IF;

  -- H1: vlastník, zástupce, uzel.
  IF NEW.lead_owner_id IS DISTINCT FROM OLD.lead_owner_id
     OR NEW.deputy_id IS DISTINCT FROM OLD.deputy_id
     OR NEW.node IS DISTINCT FROM OLD.node THEN
    -- ON DELETE SET NULL po odchodu člověka: vynulování neexistujícího
    -- člena projde (jinak by smazání team_member selhalo).
    v_fk_cleanup := NEW.node IS NOT DISTINCT FROM OLD.node
      AND (NEW.lead_owner_id IS NOT DISTINCT FROM OLD.lead_owner_id
           OR (NEW.lead_owner_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = OLD.lead_owner_id)))
      AND (NEW.deputy_id IS NOT DISTINCT FROM OLD.deputy_id
           OR (NEW.deputy_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = OLD.deputy_id)));
    IF NOT v_fk_cleanup
       AND NOT loop_is_vedeni(v_uid)
       AND OLD.lead_owner_id IS DISTINCT FROM v_uid
       AND NOT EXISTS (SELECT 1 FROM loop_node ln WHERE ln.node = OLD.node AND ln.owner_id = v_uid) THEN
      RAISE EXCEPTION 'Vlastníka, zástupce nebo uzel případu smí změnit jen vedení, vlastník případu nebo vlastník uzlu'
        USING ERRCODE = 'LP005';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION work_case_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS work_case_guard ON work_case;
CREATE TRIGGER work_case_guard
  BEFORE INSERT OR UPDATE ON work_case
  FOR EACH ROW EXECUTE FUNCTION work_case_guard();

-- L9: výchozí autor = aktér z auth.uid().
ALTER TABLE work_case ALTER COLUMN created_by SET DEFAULT loop_actor();

-- ===========================================================================
-- M7 — strážce case_step
-- ===========================================================================

CREATE OR REPLACE FUNCTION case_step_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case_id      bigint;
  v_case_status  text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.case_id IS DISTINCT FROM OLD.case_id THEN
    RAISE EXCEPTION 'Krok nelze přesunout do jiného případu' USING ERRCODE = 'LP007';
  END IF;
  v_case_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.case_id ELSE NEW.case_id END;

  -- FOR SHARE: souběžné uzavření případu počká (a naopak), takže krok
  -- nevklouzne do případu, který se právě uzavírá.
  SELECT wc.status INTO v_case_status FROM work_case wc WHERE wc.id = v_case_id FOR SHARE;
  -- Nenalezeno = kaskádové mazání případu (vedení) nebo FK chyba, kterou
  -- nahlásí sám constraint.
  IF v_case_status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'Případ je uzavřený — kroky se už nemění' USING ERRCODE = 'LP004';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND NEW.status <> 'todo' THEN
      RAISE EXCEPTION 'Nový krok musí začínat ve stavu todo' USING ERRCODE = 'LP002';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT loop_step_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'Nepovolený přechod kroku: % → %', OLD.status, NEW.status USING ERRCODE = 'LP002';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION case_step_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS case_step_guard ON case_step;
CREATE TRIGGER case_step_guard
  BEFORE INSERT OR UPDATE OR DELETE ON case_step
  FOR EACH ROW EXECUTE FUNCTION case_step_guard();

-- ===========================================================================
-- M3 — auditní stopa přežije případ; mazat případ smí jen vedení
-- ===========================================================================

-- FK approval_request.case_id a decision.case_id → ON DELETE RESTRICT.
-- Najde stávající FK na work_case podle katalogu (ne podle jména), zahodí
-- ho, když není RESTRICT, a založí pojmenovaný. Opakovaný běh nic nemění.
DO $$
DECLARE
  t     text;
  c     record;
  cname text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_request', 'decision']
  LOOP
    cname := t || '_case_id_fkey';
    FOR c IN
      SELECT con.conname, con.confdeltype
        FROM pg_constraint con
       WHERE con.conrelid = format('public.%I', t)::regclass
         AND con.confrelid = 'public.work_case'::regclass
         AND con.contype = 'f'
    LOOP
      IF c.confdeltype <> 'r' OR c.conname <> cname THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c.conname);
      END IF;
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
       WHERE con.conrelid = format('public.%I', t)::regclass
         AND con.conname = cname
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (case_id) REFERENCES work_case(id) ON DELETE RESTRICT',
        t, cname);
    END IF;
  END LOOP;
END $$;

-- RLS work_case: FOR ALL → SELECT/INSERT/UPDATE pro tým, DELETE jen vedení.
ALTER TABLE work_case ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_case_all ON work_case;
DROP POLICY IF EXISTS work_case_select ON work_case;
DROP POLICY IF EXISTS work_case_insert ON work_case;
DROP POLICY IF EXISTS work_case_update ON work_case;
DROP POLICY IF EXISTS work_case_delete ON work_case;
CREATE POLICY work_case_select ON work_case
  FOR SELECT USING (is_team_member());
CREATE POLICY work_case_insert ON work_case
  FOR INSERT WITH CHECK (is_team_member());
CREATE POLICY work_case_update ON work_case
  FOR UPDATE USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY work_case_delete ON work_case
  FOR DELETE USING (is_team_member() AND loop_is_vedeni(auth.uid()));
DROP POLICY IF EXISTS require_aal2 ON work_case;
CREATE POLICY require_aal2 ON work_case
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

-- ===========================================================================
-- H2 — snímek uzlu na schvalovacím požadavku
-- ===========================================================================

ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS node text;

-- Doplnění stávajících řádků z jejich případu (jen kde ještě chybí).
UPDATE approval_request ar
   SET node = wc.node
  FROM work_case wc
 WHERE ar.case_id = wc.id
   AND ar.node IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.approval_request'::regclass
                    AND conname = 'approval_request_node_check') THEN
    ALTER TABLE approval_request
      ADD CONSTRAINT approval_request_node_check
      CHECK (node IS NULL OR node IN ('obchod', 'eventy', 'vedeni'));
  END IF;
  -- Požadavek k případu nese uzel vždy (request_approval ho doplní).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.approval_request'::regclass
                    AND conname = 'approval_request_case_has_node') THEN
    ALTER TABLE approval_request
      ADD CONSTRAINT approval_request_case_has_node
      CHECK (case_id IS NULL OR node IS NOT NULL);
  END IF;
END $$;

-- Role člena týmu pro uzel (zrcadlo nodeRoleFor v core/authority.ts):
-- vlastník uzlu → node_owner, zástupce uzlu → node_deputy, team role
-- 'vedeni' → vedeni, jinak member. Bez uzlu → jen vedeni, ostatní NULL.
-- Nečlen → NULL. Nahrazuje loop_approver_role(uuid, bigint) z 0053, která
-- četla uzel z případu až v okamžiku rozhodnutí.
CREATE OR REPLACE FUNCTION loop_approver_role_for_node(p_member uuid, p_node text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_team_role text;
BEGIN
  IF p_member IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT tm.role::text INTO v_team_role FROM team_member tm WHERE tm.id = p_member;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF p_node IS NULL THEN
    RETURN CASE WHEN v_team_role = 'vedeni' THEN 'vedeni' END;
  END IF;
  IF EXISTS (SELECT 1 FROM loop_node ln WHERE ln.node = p_node AND ln.owner_id = p_member) THEN
    RETURN 'node_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM loop_node ln WHERE ln.node = p_node AND ln.deputy_id = p_member) THEN
    RETURN 'node_deputy';
  END IF;
  IF v_team_role = 'vedeni' THEN
    RETURN 'vedeni';
  END IF;
  RETURN 'member';
END $$;

REVOKE ALL ON FUNCTION loop_approver_role_for_node(uuid, text) FROM PUBLIC, anon, authenticated;

-- Stará varianta podle case_id už nemá volajícího; zrušit, ať ji nikdo
-- omylem nepoužije (uzel případu se mohl od žádosti změnit).
DROP FUNCTION IF EXISTS loop_approver_role(uuid, bigint);

-- Úroveň = max(požadovaná, politika činnosti | výchozí L2). Nikdy nesnižuje.
-- Nově: případ musí existovat a být otevřený (L8) a uzel se zmrazí (H2).
CREATE OR REPLACE FUNCTION request_approval(
  p_action_kind      text,
  p_requested_level  text,
  p_case_id          bigint DEFAULT NULL,
  p_expires_at       timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        text := loop_actor();
  v_policy       text;
  v_level        text;
  v_case_status  text;
  v_node         text;
  v_id           bigint;
BEGIN
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Platnost požadavku musí končit v budoucnu' USING ERRCODE = '22023';
  END IF;
  IF p_requested_level IS NOT NULL AND loop_level_rank(p_requested_level) IS NULL THEN
    RAISE EXCEPTION 'Neplatná úroveň (povoleno L1–L4)' USING ERRCODE = '22023';
  END IF;
  IF p_case_id IS NOT NULL THEN
    -- FOR SHARE: případ se během žádosti neuzavře ani nepřesune.
    SELECT wc.status, wc.node INTO v_case_status, v_node
      FROM work_case wc WHERE wc.id = p_case_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Případ % neexistuje', p_case_id USING ERRCODE = 'P0002';
    END IF;
    IF v_case_status IN ('done', 'cancelled') THEN
      RAISE EXCEPTION 'Případ je uzavřený — schválení už nejde žádat' USING ERRCODE = 'LP004';
    END IF;
  END IF;
  -- Nejnižší aktivní politika (víc aktivních DB nedovolí; kdyby přesto,
  -- stejně jako requiredLevel v TS). Bez politiky výchozí L2.
  SELECT ap.level INTO v_policy
    FROM authority_policy ap
   WHERE ap.action_kind = p_action_kind AND ap.active AND loop_level_rank(ap.level) IS NOT NULL
   ORDER BY loop_level_rank(ap.level) ASC
   LIMIT 1;
  v_policy := coalesce(v_policy, 'L2');
  v_level := CASE
    WHEN p_requested_level IS NULL THEN v_policy
    WHEN loop_level_rank(p_requested_level) >= loop_level_rank(v_policy) THEN p_requested_level
    ELSE v_policy
  END;
  -- action_kind hlídá CHECK tabulky.
  INSERT INTO approval_request (case_id, node, action_kind, requested_level, status, requested_by, expires_at)
  VALUES (p_case_id, v_node, p_action_kind, v_level, 'pending', v_actor, p_expires_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION decide_approval(
  p_request_id  bigint,
  p_approve     boolean,
  p_note        text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := loop_actor();
  v_req   approval_request%ROWTYPE;
  v_role  text;
  v_max   text;
  v_new   text;
BEGIN
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Chybí rozhodnutí (approve true/false)' USING ERRCODE = '22023';
  END IF;
  -- FOR UPDATE: dvě souběžná rozhodnutí nad týmž požadavkem se seřadí.
  SELECT * INTO v_req FROM approval_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Požadavek % neexistuje', p_request_id USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Požadavek už není čekající (stav %)', v_req.status USING ERRCODE = '22023';
  END IF;
  IF v_req.expires_at IS NOT NULL AND v_req.expires_at <= now() THEN
    RAISE EXCEPTION 'Požadavek vypršel' USING ERRCODE = '22023';
  END IF;
  -- Čtyři oči: explicitně (srozumitelná chyba), CHECK to jistí i v tabulce.
  IF v_req.requested_by = v_actor THEN
    RAISE EXCEPTION 'Vlastní požadavek nelze schválit ani zamítnout' USING ERRCODE = '42501';
  END IF;
  -- Pravomoc: role odvozená v SQL ze SNÍMKU uzlu (approval_request.node),
  -- ne z aktuálního uzlu případu a ne z klienta.
  v_role := loop_approver_role_for_node(auth.uid(), v_req.node);
  v_max := loop_role_max_level(v_role);
  IF v_max IS NULL
     OR loop_level_rank(v_req.requested_level) IS NULL
     OR loop_level_rank(v_req.requested_level) > loop_level_rank(v_max) THEN
    RAISE EXCEPTION 'Nemáš oprávnění schválit tuto úroveň' USING ERRCODE = '42501';
  END IF;
  v_new := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE approval_request
     SET status = v_new, decided_by = v_actor, decided_at = now(), decision_note = p_note
   WHERE id = p_request_id;
  RETURN v_new;
END $$;

-- Granty stejně jako 0039/0053.
REVOKE ALL ON FUNCTION request_approval(text, text, bigint, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION decide_approval(bigint, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_approval(text, text, bigint, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION decide_approval(bigint, boolean, text) TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0057', 'loop core hardening: vlastnik/uzel pripadu jen opravneni, snimek uzlu na approval_request, audit FK RESTRICT + DELETE jen vedeni, prechody stavu v DB, request_approval jen pro otevreny pripad, created_by z auth.uid()')
ON CONFLICT (version) DO NOTHING;
