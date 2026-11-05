-- 0067 — case_proposal: NÁVRH pracovního případu od schopnosti Loop Core.
--
-- PROČ: kapitola 11 plánu přestavby („Hotovo když: jedna konkrétní schopnost,
-- např. ‚příchozí e-mail vytvoří doložený návrh pracovního případu', běží
-- v jiné firmě"). Schopnost (core/agents/mailToCase.ts, šablona
-- core/agents/template.ts) po Outlook syncu navrhne případ; založí ho až
-- člověk tlačítkem Přijmout na /pripady. Tahle migrace dává návrhu místo
-- a dvě RPC pro rozhodnutí člověka.
--
-- PROČ TABULKA A NE NOVÝ STAV work_case ('navrh'):
--   * stavový automat případu (0057: loop_case_transition_ok, work_case_guard,
--     test/loop-hardening.test.ts) zůstává beze změny — návrh nemá kroky,
--     rozhodnutí ani schvalování a nesmí je dostat;
--   * zamítnutý návrh nezaplevelí seznam případů (zrušený případ by tam
--     zůstal navždy — mazat smí jen vedení a rozhodnutí mazání blokují);
--   * návrh je údaj ve stavu 'ai_suggestion' (0038) s vlastním původem
--     (evidence, metoda rule/llm); případ vzniká až lidským potvrzením.
--
-- IDEMPOTENCE: UNIQUE (capability, source_key). source_key je klíč
-- normalizované události (core/connectors/contract.ts eventKey:
-- '<konektor>|<typ>|<external_id>'), u pošty tedy jeden návrh na jeden
-- mail_event (Message-ID + směr). Cron zapisuje INSERT … ON CONFLICT DO
-- NOTHING, opakovaný běh nic nezdvojí. Navíc nejvýš JEDEN čekající návrh
-- na (schopnost, firma, uzel) — částečný UNIQUE index; druhý pokus je
-- 23505 a sink ho bere jako „už se řeší".
--
-- UZEL: FK na loop_node(node), NE CHECK s výčtem uzlů. Výčet je hodnota
-- konkrétní firmy (config/mummiesDaddies.ts); tady ho DB bere z dat (loop_node),
-- takže tahle migrace je stejná pro každou firmu (kapitola 11).
--
-- DOLOŽENÍ: evidence_id NOT NULL → evidence (0038), ON DELETE RESTRICT
-- (stejně jako decision.evidence_id). Bez odkazu na zdroj návrh nevznikne.
-- Tabulka nenese předmět ani tělo zprávy — jen název ze šablony firmy
-- (jméno firmy z CRM) a zdůvodnění z pravidel.
--
-- OBCHOD: návrh nenese deal_id ani částky, can_see_sales() (0058) se ho
-- netýká. account_id ON DELETE CASCADE jako u mail_event (0041): návrh
-- bez firmy nemá účel a výmaz firmy (GDPR) ho má vzít s sebou.
--
-- ZÁPIS: INSERT jen service_role (cron, core/agents/caseProposal.ts). Tým
-- smí SELECT (+ RESTRICTIVE AAL2). Rozhodnutí jen přes SECURITY DEFINER RPC
-- s aktérem z loop_actor() (0039: přihlášený člen týmu s AAL2):
--   accept_case_proposal(id) — atomicky založí work_case ('open', autor =
--     aktér, vlastník = vlastník uzlu z loop_node), kroky z návrhu,
--     rozhodnutí „Založit pracovní případ z návrhu?" = „přijmout"
--     s evidence_id návrhu (případ je tak doložený) a návrh označí
--     accepted + work_case_id. Triggery 0057 běží normálně (autor
--     'user:<auth.uid()>', nový případ 'open', kroky 'todo').
--   reject_case_proposal(id, poznámka) — jen označí rejected.
-- Obě odmítnou už rozhodnutý návrh ('Návrh už byl rozhodnut', 22023)
-- a neexistující (P0002); FOR UPDATE seřadí souběžná rozhodnutí.
--
-- BEZPEČNOST PRO DATA: jen nová tabulka a funkce, žádný zásah do
-- existujících dat. Idempotentní (IF NOT EXISTS, DROP … IF EXISTS,
-- CREATE OR REPLACE, ON CONFLICT).
--
-- ZÁVISLOSTI: 0038 (evidence), 0039 (work_case, case_step, decision,
-- loop_node, loop_actor). Na produkci běží i 0057 (autor případu z aktéra),
-- RPC s ní počítají, ale nevyžadují ji.

DO $$
BEGIN
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0067 vyžaduje tabulku public.evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regclass('public.work_case') IS NULL
     OR to_regclass('public.case_step') IS NULL
     OR to_regclass('public.decision') IS NULL
     OR to_regclass('public.loop_node') IS NULL
     OR to_regprocedure('public.loop_actor()') IS NULL THEN
    RAISE EXCEPTION '0067 vyžaduje Loop Core (work_case, case_step, decision, loop_node, loop_actor) — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS case_proposal (
  id             bigserial PRIMARY KEY,
  capability     text NOT NULL,
  source_key     text NOT NULL,
  occurred_at    timestamptz NOT NULL,
  node           text NOT NULL REFERENCES loop_node(node),
  account_id     bigint REFERENCES account(id) ON DELETE CASCADE,
  title          text NOT NULL,
  rationale      text NOT NULL,
  steps          jsonb NOT NULL DEFAULT '[]'::jsonb,
  method         text NOT NULL,
  info_state     text NOT NULL DEFAULT 'ai_suggestion',
  evidence_id    bigint NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'pending',
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text,
  work_case_id   bigint REFERENCES work_case(id) ON DELETE SET NULL,
  CONSTRAINT case_proposal_capability_check CHECK (capability ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT case_proposal_source_key_check CHECK (char_length(source_key) BETWEEN 1 AND 700),
  CONSTRAINT case_proposal_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT case_proposal_rationale_check CHECK (char_length(btrim(rationale)) BETWEEN 1 AND 1000),
  CONSTRAINT case_proposal_steps_check
    CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 10),
  CONSTRAINT case_proposal_method_check CHECK (method IN ('rule', 'llm')),
  -- Návrh stroje je vždy jen návrh (core/informationState.ts); potvrzení
  -- člověka je nový údaj (případ + audit 'human_confirmed'), ne přepis.
  CONSTRAINT case_proposal_info_state_check CHECK (info_state = 'ai_suggestion'),
  CONSTRAINT case_proposal_status_check CHECK (status IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT case_proposal_note_check
    CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  -- Čekající nemá rozhodovatele ani případ; rozhodnutý má kdo a kdy.
  -- Přijatý nese případ, dokud ho někdo nesmaže (ON DELETE SET NULL).
  CONSTRAINT case_proposal_decided_consistent CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND work_case_id IS NULL)
    OR (status = 'accepted' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND work_case_id IS NULL)
  ),
  CONSTRAINT case_proposal_source_unique UNIQUE (capability, source_key)
);

-- Nejvýš jeden čekající návrh na firmu a uzel (viz hlavička, IDEMPOTENCE).
CREATE UNIQUE INDEX IF NOT EXISTS case_proposal_one_pending_uidx
  ON case_proposal (capability, account_id, node)
  WHERE status = 'pending' AND account_id IS NOT NULL;
-- Seznam „Návrhy" na /pripady = čekající, nejnovější nahoře.
CREATE INDEX IF NOT EXISTS case_proposal_pending_idx
  ON case_proposal (created_at DESC) WHERE status = 'pending';
-- Kontext schopnosti: čekající / zamítnuté návrhy firmy v uzlu.
CREATE INDEX IF NOT EXISTS case_proposal_account_node_idx
  ON case_proposal (account_id, node, status) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS case_proposal_work_case_idx
  ON case_proposal (work_case_id) WHERE work_case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS case_proposal_evidence_idx
  ON case_proposal (evidence_id);

ALTER TABLE case_proposal ENABLE ROW LEVEL SECURITY;

-- Čtení pro tým; žádná INSERT/UPDATE/DELETE politika → klient nezapíše nic.
DROP POLICY IF EXISTS case_proposal_read ON case_proposal;
CREATE POLICY case_proposal_read ON case_proposal
  FOR SELECT USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS require_aal2 ON case_proposal;
CREATE POLICY require_aal2 ON case_proposal
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON case_proposal FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON case_proposal FROM authenticated;
GRANT SELECT ON case_proposal TO authenticated;
GRANT ALL ON case_proposal TO service_role;
GRANT USAGE ON SEQUENCE case_proposal_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- Rozhodnutí člověka. SECURITY DEFINER (tým má jen SELECT), search_path
-- zafixovaný, aktér VŽDY z loop_actor() (auth.uid() + AAL2 + člen týmu),
-- nikdy z parametru.

CREATE OR REPLACE FUNCTION accept_case_proposal(p_proposal_id bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  text := loop_actor();
  v_p      case_proposal%ROWTYPE;
  v_owner  uuid;
  v_case   bigint;
BEGIN
  -- FOR UPDATE: dvě souběžná rozhodnutí nad týmž návrhem se seřadí.
  SELECT * INTO v_p FROM case_proposal WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Návrh % neexistuje', p_proposal_id USING ERRCODE = 'P0002';
  END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'Návrh už byl rozhodnut (stav %)', v_p.status USING ERRCODE = '22023';
  END IF;

  -- Výchozí vlastník = vlastník uzlu (stejně jako nový případ z formuláře).
  SELECT ln.owner_id INTO v_owner FROM loop_node ln WHERE ln.node = v_p.node;

  INSERT INTO work_case (title, node, status, account_id, lead_owner_id, created_by)
  VALUES (v_p.title, v_p.node, 'open', v_p.account_id, v_owner, v_actor)
  RETURNING id INTO v_case;

  INSERT INTO case_step (case_id, position, title, status)
  SELECT v_case, s.ord::integer, s.title, 'todo'
    FROM jsonb_array_elements_text(v_p.steps) WITH ORDINALITY AS s(title, ord);

  -- Doložení případu: rozhodnutí člověka s odkazem na zdroj návrhu.
  INSERT INTO decision (case_id, question, options, chosen, decided_by, decided_at, evidence_id)
  VALUES (
    v_case, 'Založit pracovní případ z návrhu?', '["přijmout", "zamítnout"]'::jsonb,
    'přijmout', v_actor, now(), v_p.evidence_id
  );

  UPDATE case_proposal
     SET status = 'accepted', decided_by = v_actor, decided_at = now(), work_case_id = v_case
   WHERE id = p_proposal_id;
  RETURN v_case;
END $$;

CREATE OR REPLACE FUNCTION reject_case_proposal(p_proposal_id bigint, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   text := loop_actor();
  v_status  text;
BEGIN
  SELECT cp.status INTO v_status FROM case_proposal cp WHERE cp.id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Návrh % neexistuje', p_proposal_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Návrh už byl rozhodnut (stav %)', v_status USING ERRCODE = '22023';
  END IF;
  UPDATE case_proposal
     SET status = 'rejected', decided_by = v_actor, decided_at = now(),
         decision_note = nullif(btrim(p_note), '')
   WHERE id = p_proposal_id;
END $$;

-- EXECUTE jen authenticated (anon ani PUBLIC ne); brána je loop_actor().
REVOKE ALL ON FUNCTION accept_case_proposal(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION reject_case_proposal(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_case_proposal(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION reject_case_proposal(bigint, text) TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0067', 'case_proposal: navrh pracovniho pripadu od schopnosti Loop Core (doklad evidence, idempotence capability+source_key, uzel FK na loop_node) + RPC accept_case_proposal / reject_case_proposal')
ON CONFLICT (version) DO NOTHING;
