-- 0053 — bezpečnostní zpevnění po review: pravomoc schvalování v SQL (H1),
-- trvalý a atomický záznam odeslaného přehledu (L1), autor dokumentu
-- engagementu z auth.uid() (L2) a zúžení odkazu dokumentu na firemní
-- SharePoint (L4).
--
-- PROČ TADY A NE V 0039/0051: ty migrace už mohou běžet v produkci (vlastník
-- je dostal k aplikaci). Upravovat aplikovaný soubor nejde — změna by se na
-- produkci nikdy neprojevila a čistá DB by se od produkce rozešla. Všechno je
-- proto tady jako CREATE OR REPLACE / idempotentní ALTER; opakovaný běh je
-- bezpečný.
--
-- H1 — RPC z 0039 kontrolovala AAL2, členství, stav, expiraci a čtyři oči,
-- ale NE roli: kterýkoli člen týmu mohl schválit L4 požadavek a žadatel si
-- mohl sám určit nízkou úroveň (request_approval ukládal p_requested_level
-- bez ohledu na authority_policy). Nově:
--   * decide_approval po zamčení řádku (FOR UPDATE) odvodí roli schvalovatele
--     V SQL (loop_approver_role) a porovná ji s maximem role
--     (loop_role_max_level). Nestačí-li → SQLSTATE 42501
--     'Nemáš oprávnění schválit tuto úroveň'. Platí pro schválení
--     i zamítnutí (obojí je rozhodnutí; stejně jako decideApproval v TS).
--   * Role: vlastník uzlu případu → node_owner, zástupce uzlu → node_deputy,
--     team_member.role = 'vedeni' → vedeni, jinak member. Pořadí přesně jako
--     nodeRoleFor v core/authority.ts. Požadavek bez případu (case_id NULL,
--     nebo případ už neexistuje) = neznámý uzel → rozhodovat smí JEN vedeni
--     (ostatní nedostanou žádnou roli).
--   * Maxima rolí (vedeni/node_owner L4, node_deputy L2, member L1, system
--     a cokoli jiného nic) MUSÍ zůstat synchronní s APPROVER_ROLES
--     a canActorApprove v core/authority.ts — test/security-0053.test.ts
--     porovnává CASE tabulku v loop_role_max_level s TS konstantou.
--   * request_approval ukládá úroveň = max(požadovaná, aktivní
--     authority_policy pro action_kind; bez politiky výchozí L2). Nikdy
--     nesnižuje. Víc aktivních politik (DB je nedovolí) → bere se nejnižší,
--     stejně jako requiredLevel v TS.
--   * resolve_decision a record_decision (s p_chosen) smí jen vlastník nebo
--     zástupce případu (work_case.lead_owner_id / deputy_id), vlastník nebo
--     zástupce uzlu případu (loop_node) nebo vedeni.
--   Signatury, SECURITY DEFINER, search_path i granty zůstávají jako v 0039.
--
-- L1 — digest_send_log(prague_day, kind): marker „dnes už odešlo". Cron ho
-- vkládá PŘED odesláním (INSERT … ON CONFLICT DO NOTHING); když řádek už
-- existoval, nic neposílá. Při selhání odeslání marker smaže, ať to další
-- běh zkusí znovu. Tabulka je jen pro service_role (RLS bez permisivních
-- politik + REVOKE klientům; RESTRICTIVE AAL2 jen kvůli domácímu stylu
-- a migrations-lint).
--
-- L2 — engagement_document.created_by: DEFAULT auth.uid() a trigger, který
-- pro přihlášeného uživatele (auth.uid() není NULL) vynutí created_by =
-- auth.uid() při INSERT a zakáže ho přepsat na někoho jiného při UPDATE
-- (vynulování přes ON DELETE SET NULL projde). service_role (bez auth.uid())
-- je vyjmutá.
--
-- L4 — engagement_document.url: délka ≤ 2000 a host jen
-- mummiesdaddies.sharepoint.com nebo mummiesdaddies-my.sharepoint.com (OneDrive for
-- Business). Regex MUSÍ být shodný se SHAREPOINT_URL_RE v
-- domain/delivery/documents.ts (test to hlídá). Constrainty se přidají
-- NOT VALID (hned platí pro nové zápisy) a pak se validují; když stávající
-- řádky pravidlo porušují, validace se přeskočí s NOTICE — data se neničí,
-- správce je opraví ručně a spustí VALIDATE CONSTRAINT sám.
--
-- ZÁVISLOSTI: 0039 (loop core), 0051 (engagement_document). Guard níže
-- skončí srozumitelnou chybou s názvem chybějící migrace.

DO $$
BEGIN
  IF to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0053 vyžaduje tabulku public.team_member — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regclass('public.work_case') IS NULL
     OR to_regclass('public.decision') IS NULL
     OR to_regclass('public.approval_request') IS NULL
     OR to_regclass('public.authority_policy') IS NULL
     OR to_regclass('public.loop_node') IS NULL
     OR to_regprocedure('public.loop_actor()') IS NULL THEN
    RAISE EXCEPTION '0053 vyžaduje Loop Core (work_case, decision, approval_request, authority_policy, loop_node, loop_actor) — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
  IF to_regclass('public.engagement_document') IS NULL THEN
    RAISE EXCEPTION '0053 vyžaduje tabulku public.engagement_document — nejdřív aplikujte 0051_engagement_document.sql';
  END IF;
END $$;

-- ===========================================================================
-- H1 — pravomoc schvalování a rozhodování v SQL
-- ===========================================================================

-- Pořadí úrovně: 'L1' → 1 … 'L4' → 4; cokoli jiného NULL.
CREATE OR REPLACE FUNCTION loop_level_rank(p_level text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_level IN ('L1', 'L2', 'L3', 'L4') THEN substring(p_level FROM 2)::integer END
$$;

-- Nejvyšší úroveň, kterou role smí schválit. TS a SQL MUSÍ zůstat synchronní:
-- core/authority.ts (APPROVER_ROLES + MAX_APPROVABLE / canActorApprove).
-- test/security-0053.test.ts tuhle CASE tabulku čte a porovnává.
-- system a neznámá role → NULL (nic).
CREATE OR REPLACE FUNCTION loop_role_max_level(p_role text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_role
    WHEN 'vedeni' THEN 'L4'
    WHEN 'node_owner' THEN 'L4'
    WHEN 'node_deputy' THEN 'L2'
    WHEN 'member' THEN 'L1'
    ELSE NULL
  END
$$;

-- Role člena týmu pro případ (zrcadlo nodeRoleFor v core/authority.ts):
-- vlastník uzlu → node_owner, zástupce uzlu → node_deputy, team role
-- 'vedeni' → vedeni, jinak member. Neznámý uzel (case NULL / případ
-- neexistuje) → jen vedeni, ostatní NULL (žádná role). Nečlen → NULL.
-- Volá se jen zevnitř SECURITY DEFINER RPC níže (běží tedy s právy vlastníka);
-- klientům EXECUTE odebrán.
CREATE OR REPLACE FUNCTION loop_approver_role(p_member uuid, p_case_id bigint)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_team_role text;
  v_node      text;
BEGIN
  IF p_member IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT tm.role::text INTO v_team_role FROM team_member tm WHERE tm.id = p_member;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF p_case_id IS NOT NULL THEN
    SELECT wc.node INTO v_node FROM work_case wc WHERE wc.id = p_case_id;
  END IF;
  IF v_node IS NULL THEN
    RETURN CASE WHEN v_team_role = 'vedeni' THEN 'vedeni' END;
  END IF;
  IF EXISTS (SELECT 1 FROM loop_node ln WHERE ln.node = v_node AND ln.owner_id = p_member) THEN
    RETURN 'node_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM loop_node ln WHERE ln.node = v_node AND ln.deputy_id = p_member) THEN
    RETURN 'node_deputy';
  END IF;
  IF v_team_role = 'vedeni' THEN
    RETURN 'vedeni';
  END IF;
  RETURN 'member';
END $$;

-- Smí člen rozhodnout (resolve/record s volbou) v daném případu? Vlastník
-- nebo zástupce případu, vlastník nebo zástupce uzlu případu, nebo vedeni.
CREATE OR REPLACE FUNCTION loop_can_resolve_case(p_member uuid, p_case_id bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case work_case%ROWTYPE;
BEGIN
  IF p_member IS NULL THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = p_member AND tm.role::text = 'vedeni') THEN
    RETURN true;
  END IF;
  SELECT * INTO v_case FROM work_case WHERE id = p_case_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_case.lead_owner_id = p_member OR v_case.deputy_id = p_member THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM loop_node ln
     WHERE ln.node = v_case.node
       AND (ln.owner_id = p_member OR ln.deputy_id = p_member)
  );
END $$;

REVOKE ALL ON FUNCTION loop_level_rank(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION loop_role_max_level(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION loop_approver_role(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION loop_can_resolve_case(uuid, bigint) FROM PUBLIC, anon, authenticated;

-- Úroveň = max(požadovaná, politika činnosti | výchozí L2). Nikdy nesnižuje.
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
  v_actor   text := loop_actor();
  v_policy  text;
  v_level   text;
  v_id      bigint;
BEGIN
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Platnost požadavku musí končit v budoucnu' USING ERRCODE = '22023';
  END IF;
  IF p_requested_level IS NOT NULL AND loop_level_rank(p_requested_level) IS NULL THEN
    RAISE EXCEPTION 'Neplatná úroveň (povoleno L1–L4)' USING ERRCODE = '22023';
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
  INSERT INTO approval_request (case_id, action_kind, requested_level, status, requested_by, expires_at)
  VALUES (p_case_id, p_action_kind, v_level, 'pending', v_actor, p_expires_at)
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
  -- Pravomoc: role odvozená v SQL, ne z klienta.
  v_role := loop_approver_role(auth.uid(), v_req.case_id);
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

-- Založí rozhodnutí; s p_chosen rovnou rozhodnuté (decided_by = volající)
-- — to ale smí jen ten, kdo smí případ rozhodovat (loop_can_resolve_case).
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
  IF p_chosen IS NOT NULL AND NOT loop_can_resolve_case(auth.uid(), p_case_id) THEN
    RAISE EXCEPTION 'Nemáš oprávnění rozhodnout v tomto případu' USING ERRCODE = '42501';
  END IF;
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
-- názoru = nové rozhodnutí (stopa zůstává). Rozhodovat smí jen vlastník/
-- zástupce případu, vlastník/zástupce uzlu nebo vedeni.
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
  v_dec   decision%ROWTYPE;
BEGIN
  IF p_chosen IS NULL OR btrim(p_chosen) = '' THEN
    RAISE EXCEPTION 'Chybí zvolená možnost' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_dec FROM decision WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_dec.decided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Rozhodnutí % neexistuje nebo už je rozhodnuté', p_decision_id USING ERRCODE = '22023';
  END IF;
  IF NOT loop_can_resolve_case(auth.uid(), v_dec.case_id) THEN
    RAISE EXCEPTION 'Nemáš oprávnění rozhodnout v tomto případu' USING ERRCODE = '42501';
  END IF;
  UPDATE decision
     SET chosen = p_chosen, decided_by = v_actor, decided_at = now(),
         evidence_id = coalesce(p_evidence_id, evidence_id)
   WHERE id = p_decision_id AND decided_at IS NULL;
END $$;

-- Granty stejně jako 0039 (CREATE OR REPLACE je zachová, zopakování je
-- pojistka pro prostředí, kde se mezitím ručně měnily).
REVOKE ALL ON FUNCTION request_approval(text, text, bigint, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION decide_approval(bigint, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION record_decision(bigint, text, jsonb, text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION resolve_decision(bigint, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_approval(text, text, bigint, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION decide_approval(bigint, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION record_decision(bigint, text, jsonb, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION resolve_decision(bigint, text, bigint) TO authenticated;

-- ===========================================================================
-- L1 — trvalý marker odeslaného přehledu
-- ===========================================================================

CREATE TABLE IF NOT EXISTS digest_send_log (
  prague_day  date NOT NULL,
  kind        text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (prague_day, kind),
  CONSTRAINT digest_send_log_kind_check CHECK (kind IN ('weekly', 'daily'))
);

ALTER TABLE digest_send_log ENABLE ROW LEVEL SECURITY;

-- Žádná permisivní politika = klient nic nečte ani nepíše (default-deny).
-- RESTRICTIVE AAL2 jen pro konzistenci s domácím stylem.
DROP POLICY IF EXISTS require_aal2 ON digest_send_log;
CREATE POLICY require_aal2 ON digest_send_log
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON digest_send_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON digest_send_log TO service_role;

-- ===========================================================================
-- L2 — engagement_document.created_by = auth.uid()
-- ===========================================================================

ALTER TABLE engagement_document ALTER COLUMN created_by SET DEFAULT auth.uid();

CREATE OR REPLACE FUNCTION engagement_document_enforce_created_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- service_role / migrace nemají auth.uid() → vyjmuté.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'created_by musí být přihlášený uživatel' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL THEN
    -- Vynulování (ON DELETE SET NULL po odchodu člověka) projde; přepsat
    -- autora na někoho jiného ne.
    RAISE EXCEPTION 'created_by nelze změnit' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS engagement_document_created_by ON engagement_document;
CREATE TRIGGER engagement_document_created_by
  BEFORE INSERT OR UPDATE ON engagement_document
  FOR EACH ROW EXECUTE FUNCTION engagement_document_enforce_created_by();

-- ===========================================================================
-- L4 — engagement_document.url: délka a firemní SharePoint host
-- ===========================================================================

-- Regex shodný se SHAREPOINT_URL_RE v domain/delivery/documents.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.engagement_document'::regclass
                    AND conname = 'engagement_document_url_length_check') THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_url_length_check
      CHECK (char_length(url) <= 2000) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.engagement_document'::regclass
                    AND conname = 'engagement_document_url_host_check') THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_url_host_check
      CHECK (url ~ '^https://(mummiesdaddies|mummiesdaddies-my)\.sharepoint\.com/') NOT VALID;
  END IF;
END $$;

-- Validace stávajících řádků: porušení = NOTICE a přeskočit (data se
-- neničí); nové zápisy constraint hlídá i ve stavu NOT VALID.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM engagement_document WHERE char_length(url) > 2000) THEN
    RAISE NOTICE '0053: engagement_document má odkazy delší než 2000 znaků — engagement_document_url_length_check zůstává NOT VALID; po opravě spusťte ALTER TABLE engagement_document VALIDATE CONSTRAINT engagement_document_url_length_check.';
  ELSE
    ALTER TABLE engagement_document VALIDATE CONSTRAINT engagement_document_url_length_check;
  END IF;
  IF EXISTS (SELECT 1 FROM engagement_document
              WHERE url !~ '^https://(mummiesdaddies|mummiesdaddies-my)\.sharepoint\.com/') THEN
    RAISE NOTICE '0053: engagement_document má odkazy mimo mummiesdaddies(-my).sharepoint.com — engagement_document_url_host_check zůstává NOT VALID; po opravě spusťte ALTER TABLE engagement_document VALIDATE CONSTRAINT engagement_document_url_host_check.';
  ELSE
    ALTER TABLE engagement_document VALIDATE CONSTRAINT engagement_document_url_host_check;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0053', 'security hardening: pravomoc schvalovani v SQL (decide/request_approval, resolve/record_decision), digest_send_log, engagement_document created_by = auth.uid() a URL jen mummiesdaddies SharePoint')
ON CONFLICT (version) DO NOTHING;
