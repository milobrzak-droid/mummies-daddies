-- 0039 — Loop Core: pracovní případ, krok, rozhodnutí, schvalovací požadavek,
-- pravomoc per činnost (L1–L4) jako data a obsazení uzlů (loop_node).
--
-- PROČ: kapitola 7 cílové architektury (docs/PROVOZ.md) chce
-- jednotné jádro Loop Core — každý případ má JEDEN vedoucí uzel, vlastníka,
-- stav; pravomoc je přiřazená ke konkrétní činnosti a vlastník kompetence ji
-- musí umět stáhnout BEZ nasazení nové verze.
--
-- ROZHODNUTÍ:
--   * Uzly firmy: obchod, eventy, vedeni (config/mummiesDaddies.ts). Obsazení
--     je data v tabulce loop_node (uzel → owner_id, deputy_id); migrace
--     zakládá uzly bez vlastníka, vlastníky nastaví správce po založení
--     prvních uživatelů (UPDATE přes service_role, postup v docs/PROVOZ.md).
--   * Model rolí pro schvalování (vedeni a node_owner do L4, node_deputy
--     do L2, member L1, system nic) — v TS (core/authority.ts), role aktéra
--     pro uzel se odvozuje z loop_node + team_member.role.
--   * external_commitment zůstává výchozí L2.
--
-- LOOP_NODE SEED: uzly vznikají s owner_id NULL (žádný e-mail v migraci).

DO $$
BEGIN
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0039 vyžaduje tabulku public.evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS work_case (
  id             bigserial PRIMARY KEY,
  title          text NOT NULL,
  node           text NOT NULL,
  lead_owner_id  uuid REFERENCES team_member(id) ON DELETE SET NULL,
  deputy_id      uuid REFERENCES team_member(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'open',
  account_id     bigint REFERENCES account(id) ON DELETE SET NULL,
  deal_id        bigint REFERENCES deal(id) ON DELETE SET NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_case_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT work_case_node_check
    CHECK (node IN ('obchod', 'eventy', 'vedeni')),
  CONSTRAINT work_case_status_check
    CHECK (status IN ('open', 'in_progress', 'waiting', 'done', 'cancelled')),
  -- Zástupce nesmí být tatáž osoba jako vlastník (pak by zástup neexistoval).
  CONSTRAINT work_case_deputy_differs
    CHECK (deputy_id IS NULL OR lead_owner_id IS NULL OR deputy_id <> lead_owner_id)
);

CREATE INDEX IF NOT EXISTS work_case_node_status_idx ON work_case (node, status);
CREATE INDEX IF NOT EXISTS work_case_account_idx ON work_case (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_case_deal_idx ON work_case (deal_id) WHERE deal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS case_step (
  id           bigserial PRIMARY KEY,
  case_id      bigint NOT NULL REFERENCES work_case(id) ON DELETE CASCADE,
  position     integer NOT NULL DEFAULT 0,
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'todo',
  due_at       timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_step_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT case_step_status_check
    CHECK (status IN ('todo', 'doing', 'blocked', 'done', 'skipped'))
);

CREATE INDEX IF NOT EXISTS case_step_case_idx ON case_step (case_id, position);

CREATE TABLE IF NOT EXISTS decision (
  id           bigserial PRIMARY KEY,
  case_id      bigint NOT NULL REFERENCES work_case(id) ON DELETE CASCADE,
  question     text NOT NULL,
  options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  chosen       text,
  decided_by   text,
  decided_at   timestamptz,
  evidence_id  bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_question_check CHECK (char_length(btrim(question)) BETWEEN 1 AND 1000),
  CONSTRAINT decision_options_array CHECK (jsonb_typeof(options) = 'array'),
  -- Rozhodnuto = volba + kdo + kdy, všechno najednou; nerozhodnuto = nic z toho.
  CONSTRAINT decision_decided_consistent CHECK (
    (chosen IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR (chosen IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS decision_case_idx ON decision (case_id);
CREATE INDEX IF NOT EXISTS decision_open_idx ON decision (created_at) WHERE decided_at IS NULL;

CREATE TABLE IF NOT EXISTS approval_request (
  id               bigserial PRIMARY KEY,
  case_id          bigint REFERENCES work_case(id) ON DELETE CASCADE,
  action_kind      text NOT NULL,
  requested_level  text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  requested_by     text NOT NULL,
  decided_by       text,
  decided_at       timestamptz,
  expires_at       timestamptz,
  decision_note    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_request_note_check
    CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  CONSTRAINT approval_request_action_kind_check
    CHECK (action_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT approval_request_level_check
    CHECK (requested_level IN ('L1', 'L2', 'L3', 'L4')),
  CONSTRAINT approval_request_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  -- Schváleno/zamítnuto nese kdo a kdy; pending nic. expired nemá lidského
  -- rozhodovatele (vyprší čas), decided_by tedy smí být NULL.
  CONSTRAINT approval_request_decided_consistent CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'expired' AND decided_at IS NOT NULL)
  ),
  -- Čtyři oči: kdo žádá, ten si sám neschvaluje.
  CONSTRAINT approval_request_no_self_approval
    CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

-- Rozhodovací inbox = čekající požadavky.
CREATE INDEX IF NOT EXISTS approval_request_pending_idx
  ON approval_request (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approval_request_case_idx
  ON approval_request (case_id) WHERE case_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS authority_policy (
  id           bigserial PRIMARY KEY,
  action_kind  text NOT NULL,
  level        text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  note         text,
  updated_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authority_policy_action_kind_check
    CHECK (action_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT authority_policy_level_check
    CHECK (level IN ('L1', 'L2', 'L3', 'L4'))
);

CREATE UNIQUE INDEX IF NOT EXISTS authority_policy_active_uidx
  ON authority_policy (action_kind) WHERE active;

-- Obsazení uzlů: kdo uzel vlastní a kdo ho zastupuje. Hodnoty uzlů shodně
-- s work_case_node_check a core/workCase.ts (NODES); test to hlídá.
CREATE TABLE IF NOT EXISTS loop_node (
  node        text PRIMARY KEY,
  owner_id    uuid REFERENCES team_member(id) ON DELETE SET NULL,
  deputy_id   uuid REFERENCES team_member(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_node_node_check
    CHECK (node IN ('obchod', 'eventy', 'vedeni')),
  CONSTRAINT loop_node_deputy_differs
    CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id)
);

-- set_updated_at() existuje od 0006.
DROP TRIGGER IF EXISTS work_case_set_updated_at ON work_case;
CREATE TRIGGER work_case_set_updated_at BEFORE UPDATE ON work_case
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS case_step_set_updated_at ON case_step;
CREATE TRIGGER case_step_set_updated_at BEFORE UPDATE ON case_step
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS authority_policy_set_updated_at ON authority_policy;
CREATE TRIGGER authority_policy_set_updated_at BEFORE UPDATE ON authority_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS loop_node_set_updated_at ON loop_node;
CREATE TRIGGER loop_node_set_updated_at BEFORE UPDATE ON loop_node
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed pravidla: externí závazek = L2.
INSERT INTO authority_policy (action_kind, level, active, note, updated_by)
SELECT 'external_commitment', 'L2', true,
       'Externi zavazek ma vychozi rezim L2 (CILOVA-ARCHITEKTURA kap. 7)', 'system:migration_0039'
WHERE NOT EXISTS (
  SELECT 1 FROM authority_policy WHERE action_kind = 'external_commitment' AND active
);

-- Seed uzlů firmy bez vlastníka; vlastníky doplní správce (service_role).
-- (VALUES, ne ARRAY[...]: migrations-lint hledá RLS smyčku podle prvního ARRAY.)
INSERT INTO loop_node (node, owner_id, deputy_id)
SELECT n.node, NULL, NULL
FROM (VALUES ('obchod'), ('eventy'), ('vedeni')) AS n(node)
ON CONFLICT (node) DO NOTHING;

-- RLS: domácí styl (0033/0038). Zapisovatelné pro tým jen work_case a
-- case_step; ostatní jen SELECT (viz hlavička, BEZPEČNOST).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_case', 'case_step', 'decision', 'approval_request', 'authority_policy', 'loop_node']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_read', t);
    IF t IN ('work_case', 'case_step') THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (is_team_member()) WITH CHECK (is_team_member())',
        t || '_all', t);
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT USING (is_team_member())',
        t || '_read', t);
      -- Obrana do hloubky: i kdyby někdo omylem přidal zápisovou politiku,
      -- chybějící GRANT zápis zastaví.
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM PUBLIC, anon, authenticated', t);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS require_aal2 ON %I', t);
    EXECUTE format(
      'CREATE POLICY require_aal2 ON %I AS RESTRICTIVE FOR ALL '
      || 'USING ((SELECT auth.jwt() ->> ''aal'') = ''aal2'') '
      || 'WITH CHECK ((SELECT auth.jwt() ->> ''aal'') = ''aal2'')', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RPC pro zápis schvalování a rozhodnutí. Všechny: SECURITY DEFINER (RLS pro
-- authenticated je SELECT-only), search_path zafixovaný na public, pg_temp
-- (žádné podvržení funkcí přes vlastní schéma), aktér VŽDY z auth.uid(),
-- nikdy z parametru. Kontroly členství a AAL2 dělá funkce sama, protože
-- SECURITY DEFINER obchází RLS včetně RESTRICTIVE AAL2 politiky.
-- ---------------------------------------------------------------------------

-- Společná brána: přihlášený člen týmu s AAL2. Vrací aktéra 'user:<uuid>'.
CREATE OR REPLACE FUNCTION loop_actor()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  RETURN 'user:' || auth.uid()::text;
END $$;

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
  v_actor text := loop_actor();
  v_id    bigint;
BEGIN
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Platnost požadavku musí končit v budoucnu' USING ERRCODE = '22023';
  END IF;
  -- action_kind a level hlídají CHECKy tabulky.
  INSERT INTO approval_request (case_id, action_kind, requested_level, status, requested_by, expires_at)
  VALUES (p_case_id, p_action_kind, p_requested_level, 'pending', v_actor, p_expires_at)
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
  v_new := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE approval_request
     SET status = v_new, decided_by = v_actor, decided_at = now(), decision_note = p_note
   WHERE id = p_request_id;
  RETURN v_new;
END $$;

-- Založí rozhodnutí; s p_chosen rovnou rozhodnuté (decided_by = volající).
CREATE OR REPLACE FUNCTION record_decision(
  p_case_id      bigint,
  p_question     text,
  p_options      jsonb DEFAULT '[]'::jsonb,
  p_chosen       text DEFAULT NULL,
  p_evidence_id  bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := loop_actor();
  v_id    bigint;
BEGIN
  INSERT INTO decision (case_id, question, options, chosen, decided_by, decided_at, evidence_id)
  VALUES (
    p_case_id, p_question, coalesce(p_options, '[]'::jsonb), p_chosen,
    CASE WHEN p_chosen IS NULL THEN NULL ELSE v_actor END,
    CASE WHEN p_chosen IS NULL THEN NULL ELSE now() END,
    p_evidence_id
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Rozhodne dosud otevřené rozhodnutí. Rozhodnuté se nepřepisuje — změna
-- názoru = nové rozhodnutí (stopa zůstává).
CREATE OR REPLACE FUNCTION resolve_decision(
  p_decision_id  bigint,
  p_chosen       text,
  p_evidence_id  bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := loop_actor();
BEGIN
  IF p_chosen IS NULL OR btrim(p_chosen) = '' THEN
    RAISE EXCEPTION 'Chybí zvolená možnost' USING ERRCODE = '22023';
  END IF;
  UPDATE decision
     SET chosen = p_chosen, decided_by = v_actor, decided_at = now(),
         evidence_id = coalesce(p_evidence_id, evidence_id)
   WHERE id = p_decision_id AND decided_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rozhodnutí % neexistuje nebo už je rozhodnuté', p_decision_id USING ERRCODE = '22023';
  END IF;
END $$;

-- EXECUTE jen authenticated (anon ani PUBLIC ne). loop_actor je interní
-- pomocník, ale volat ho smí stejně — nic nevrací mimo vlastní identitu.
REVOKE ALL ON FUNCTION loop_actor() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION request_approval(text, text, bigint, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION decide_approval(bigint, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION record_decision(bigint, text, jsonb, text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION resolve_decision(bigint, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION loop_actor() TO authenticated;
GRANT EXECUTE ON FUNCTION request_approval(text, text, bigint, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION decide_approval(bigint, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION record_decision(bigint, text, jsonb, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION resolve_decision(bigint, text, bigint) TO authenticated;

-- authority_policy a loop_node: žádná zápisová cesta pro authenticated.
-- Změna pravidla (UPDATE level / active=false) i přeobsazení uzlu je admin
-- úkon přes service_role; RPC s kontrolou role (node_owner/vedeni) může
-- přibýt později.

INSERT INTO schema_migration (version, note)
VALUES ('0039', 'loop core: work_case, case_step, decision, approval_request, authority_policy (seed external_commitment=L2), loop_node (seed uzlu obchod, eventy, vedeni bez vlastnika)')
ON CONFLICT (version) DO NOTHING;
