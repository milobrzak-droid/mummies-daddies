-- 0104 — agent_outbox: odchozí fronta agenta (balík P3).
--
-- PROČ: agent smí zákazníkovi poslat standardní nabídku, doptání chybějících
-- údajů a připomínku (follow-up). Každé takové odeslání musí jít JEDINOU
-- cestou, která zaručí, že zpráva neodejde dvakrát, že platí denní limity,
-- že bez všech bran pravomoci nic neodejde bez člověka a že po odeslání
-- zůstane auditní stopa. Tou cestou je tabulka agent_outbox a RPC níže.
--
-- TOK (claim–send–confirm):
--   1) P2 (poptávka) a P4 (follow-up) zařadí zprávu RPC agent_outbox_enqueue
--      (idempotentní podle source_ref). Text je vygenerovaný z mapy nebo
--      šablony, nikdy text příchozí zprávy.
--   2) Úloha agent-outbox (P3, servisní klíč) u každé zprávy ve stavu queued
--      vyhodnotí brány a stop pravidla (core/agents/outboxPolicy.ts):
--        - stop pravidlo → agent_outbox_finish 'blocked' (úkol vlastníkovi),
--        - chybí brána pravomoci → u nabídky typovaná žádost send_offer
--          (agent_outbox_request_offer_approval, uzel z approval_action_settings),
--          u ostatních druhů blocked/approval_required a úkol; uvolní je
--          člověk RPC agent_outbox_release,
--        - vše splněno → agent_outbox_claim (rezervace: advisory zámek na
--          pražský den, denní limit, limit na příjemce a den, vlastní
--          Message-ID). Teprve potom volá Gmail.
--   3) Gmail přijal zprávu (vrátil id) → agent_outbox_confirm: stav sent,
--      u nabídky verze draft → sent (strážce SV006 pustí jen tuto cestu)
--      a fáze obchodu 'nabidka', záznam do aktivit a významová událost do
--      auditu. Gmail zprávu odmítl → agent_outbox_finish 'failed' (úkol).
--      Výsledek nejistý (výpadek sítě, 5xx) → 'needs_attention'. Rezervace
--      visící déle než N minut → agent_outbox_mark_stale (needs_attention).
--      Zprávu ve stavu claimed / needs_attention fronta SAMA NIKDY NEPOŠLE
--      znovu: úloha jen dohledá v Odeslané poště podle vlastního Message-ID
--      (agent_outbox_confirm smí i z needs_attention), jinak rozhodne člověk.
--
-- BRÁNY PRAVOMOCI (samostatné odeslání bez člověka):
--   env AGENT_AUTOSEND_ENABLED, authority_policy pro druh zprávy = 'L4'
--   (send_standard_offer / send_info_request / send_follow_up; seed L2),
--   verze mapy nezačíná 'ilustracni', druh je v autoSendKinds a částka
--   nabídky je do autoSendMaxTotal. SQL znovu ověří úroveň L4 v claimu,
--   kdyby TS bránu vynechal. Odeslání po schválení člověkem (send_offer
--   v Ke schválení, nebo agent_outbox_release) brány pravomoci nepotřebuje,
--   stop pravidla a limity ale platí vždy.
--
-- STRÁŽCE NABÍDKY (deal_scope_version_send_guard z 0084, předefinován):
--   * koncept → odesláno bez schválené žádosti projde navíc JEN uvnitř
--     agent_outbox_confirm (transakčně lokální app.agent_send = id verze
--     a řádek fronty k verzi je 'sent' a samostatný),
--   * INSERT rovnou se stavem 'sent' bez autora (created_by NULL — zápis
--     automatu servisním klíčem) skončí SV006. Import PDF člověkem
--     (created_by = importující) zůstává beze změny.
--
-- SCHVÁLENÍ (approval_exec_send_offer z 0084, předefinován): když ke
-- schvalované verzi čeká zpráva ve frontě (blocked/approval_required), po
-- schválení se fronta vrátí do queued a odešle ji agent při dalším běhu —
-- úkol „pošli sám" se nezakládá (hrozilo by dvojí odeslání). Bez fronty
-- se executor chová přesně jako v 0084.
--
-- OSOBNÍ ÚDAJE: předmět, text a adresa příjemce jsou jen v agent_outbox
-- (RLS: tým s AAL2 a obchodní rolí, zápis jen servisní klíč). Po retenci
-- (agent_outbox_purge_text) a při výmazu podle adresy (agent_outbox_erase_address)
-- se smažou, řádek s id, stavy a časy zůstává. Audit (tvrdý trigger 0064 +
-- významové události z RPC) nese jen id, stavy, kódy a časy.
--
-- ZÁVISLOSTI: 0039 (authority_policy, approval_request), 0064 (audit),
-- 0072 + 0084 (deal_scope_version, executor), 0006 (task), 0020/0021
-- (sales_activity), 0026 (ledger). Guard níže skončí srozumitelnou chybou.
-- Idempotentní: CREATE … IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS
-- + CREATE, seed jen bez aktivního pravidla, ON CONFLICT DO NOTHING.

DO $$
BEGIN
  IF to_regprocedure('public.audit_row_change()') IS NULL THEN
    RAISE EXCEPTION '0104 vyžaduje funkci audit_row_change() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regprocedure('public.approval_exec_send_offer(approval_request)') IS NULL
     OR to_regprocedure('public.deal_scope_version_send_guard()') IS NULL THEN
    RAISE EXCEPTION '0104 vyžaduje executor schválení — nejdřív aplikujte 0084_approval_executor.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0104 vyžaduje can_see_sales() a is_team_member() — nejdřív aplikujte 0020 a 0082';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0104 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) Tabulka
-- ===========================================================================

CREATE TABLE IF NOT EXISTS agent_outbox (
  id                     bigserial PRIMARY KEY,
  kind                   text NOT NULL,
  source_ref             text NOT NULL,
  deal_id                bigint NOT NULL REFERENCES deal(id) ON DELETE CASCADE,
  scope_version_id       bigint REFERENCES deal_scope_version(id) ON DELETE SET NULL,
  mailbox_member_id      uuid REFERENCES team_member(id) ON DELETE SET NULL,
  mode                   text NOT NULL,
  -- Režim 'reply': id příchozí zprávy v Gmailu (vlákno, Message-ID a From
  -- se dohledají při odeslání). Režim 'to': adresa příjemce.
  in_reply_to_message_id text,
  to_email               text,
  -- Skutečný příjemce (From původní zprávy nebo to_email), doplní claim.
  recipient              text,
  subject                text,
  body                   text,
  price_map_version      text,
  quote_total            numeric(14, 2),
  status                 text NOT NULL DEFAULT 'queued',
  stop_reason            text,
  error_code             text,
  -- Odeslání bez člověka (všechny brány pravomoci splněné) — nastaví claim.
  autonomous             boolean NOT NULL DEFAULT false,
  approval_request_id    bigint REFERENCES approval_request(id) ON DELETE SET NULL,
  approved_at            timestamptz,
  approved_by            text,
  attempts               integer NOT NULL DEFAULT 0,
  claimed_at             timestamptz,
  rfc_message_id         text,
  sent_message_id        text,
  sent_thread_id         text,
  sent_body_sha256       text,
  sent_at                timestamptz,
  prague_day             date,
  task_id                bigint REFERENCES task(id) ON DELETE SET NULL,
  body_purged_at         timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_outbox_source_ref_key UNIQUE (source_ref),
  CONSTRAINT agent_outbox_scope_version_key UNIQUE (scope_version_id),
  CONSTRAINT agent_outbox_rfc_message_id_key UNIQUE (rfc_message_id),
  CONSTRAINT agent_outbox_kind_check CHECK (kind IN ('offer', 'info_request', 'follow_up')),
  CONSTRAINT agent_outbox_source_ref_check CHECK (source_ref ~ '^(inquiry|web|followup):[0-9]+(:[0-9]+)?$'),
  CONSTRAINT agent_outbox_status_check
    CHECK (status IN ('queued', 'claimed', 'sent', 'failed', 'needs_attention', 'blocked')),
  CONSTRAINT agent_outbox_mode_check CHECK (
    (mode = 'reply' AND in_reply_to_message_id IS NOT NULL)
    OR (mode = 'to' AND (to_email IS NOT NULL OR body_purged_at IS NOT NULL))
  ),
  CONSTRAINT agent_outbox_offer_version_check CHECK (kind <> 'offer' OR scope_version_id IS NOT NULL OR status <> 'queued'),
  CONSTRAINT agent_outbox_text_check CHECK (
    body_purged_at IS NOT NULL
    OR (subject IS NOT NULL AND body IS NOT NULL
        AND char_length(subject) BETWEEN 1 AND 300 AND char_length(body) BETWEEN 1 AND 20000)
  ),
  CONSTRAINT agent_outbox_codes_check CHECK (
    (stop_reason IS NULL OR stop_reason ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$')
    AND (price_map_version IS NULL OR char_length(price_map_version) <= 64)
    AND (in_reply_to_message_id IS NULL OR in_reply_to_message_id ~ '^[A-Za-z0-9_-]{1,128}$')
    AND (to_email IS NULL OR char_length(to_email) BETWEEN 3 AND 254)
    AND (recipient IS NULL OR char_length(recipient) BETWEEN 3 AND 254)
    AND (rfc_message_id IS NULL OR char_length(rfc_message_id) <= 200)
    AND (sent_message_id IS NULL OR sent_message_id ~ '^[A-Za-z0-9_-]{1,128}$')
    AND (sent_thread_id IS NULL OR sent_thread_id ~ '^[A-Za-z0-9_-]{1,128}$')
    AND (sent_body_sha256 IS NULL OR sent_body_sha256 ~ '^[0-9a-f]{64}$')
    AND (approved_by IS NULL OR char_length(approved_by) <= 80)
  ),
  CONSTRAINT agent_outbox_sent_check CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND sent_message_id IS NOT NULL)),
  CONSTRAINT agent_outbox_claim_check
    CHECK (status NOT IN ('claimed', 'sent') OR (claimed_at IS NOT NULL AND rfc_message_id IS NOT NULL AND prague_day IS NOT NULL)),
  CONSTRAINT agent_outbox_quote_check CHECK (quote_total IS NULL OR quote_total >= 0)
);

-- Na jednu příchozí zprávu nejvýš jedna odpověď daného druhu.
CREATE UNIQUE INDEX IF NOT EXISTS agent_outbox_reply_kind_key
  ON agent_outbox (in_reply_to_message_id, kind) WHERE in_reply_to_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_outbox_status_idx ON agent_outbox (status, created_at);
CREATE INDEX IF NOT EXISTS agent_outbox_day_idx ON agent_outbox (prague_day, kind) WHERE prague_day IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_outbox_deal_idx ON agent_outbox (deal_id);

COMMENT ON TABLE agent_outbox IS
  'Odchozí fronta agenta (0104): jediná cesta, kudy systém posílá e-mail zákazníkovi. Zápis jen RPC agent_outbox_* (service_role).';
COMMENT ON COLUMN agent_outbox.rfc_message_id IS
  'Vlastní hlavička Message-ID odchozí zprávy (doplní claim). Podle ní se dohledá zpráva v Odeslané poště, když je výsledek odeslání nejistý.';

DROP TRIGGER IF EXISTS agent_outbox_set_updated_at ON agent_outbox;
CREATE TRIGGER agent_outbox_set_updated_at BEFORE UPDATE ON agent_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- 2) RLS: čte tým s AAL2 a obchodní rolí, z klienta nikdo nezapisuje
-- ===========================================================================

ALTER TABLE agent_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_outbox_select ON agent_outbox;
CREATE POLICY agent_outbox_select ON agent_outbox FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS require_aal2 ON agent_outbox;
CREATE POLICY require_aal2 ON agent_outbox
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS sales_only ON agent_outbox;
CREATE POLICY sales_only ON agent_outbox
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

REVOKE ALL ON agent_outbox FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON agent_outbox FROM authenticated;

-- ===========================================================================
-- 3) Audit (MUSÍ sedět s core/auditCoverage.outbox.ts) — jen id, stavy, kódy a časy
-- ===========================================================================

DROP TRIGGER IF EXISTS audit_row_change ON agent_outbox;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON agent_outbox
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'approval_request_id,approved_at,attempts,autonomous,body_purged_at,claimed_at,deal_id,error_code,kind,mailbox_member_id,mode,prague_day,price_map_version,scope_version_id,sent_at,status,stop_reason,task_id',
    'updated_at',
    '');

-- ===========================================================================
-- 4) Pomocné funkce
-- ===========================================================================

-- Pražský den (limity se počítají po kalendářních dnech firmy).
CREATE OR REPLACE FUNCTION agent_outbox_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (now() AT TIME ZONE 'Europe/Prague')::date
$$;

-- Druh zprávy → činnost v authority_policy (úroveň L4 = smí bez člověka).
CREATE OR REPLACE FUNCTION agent_outbox_action_kind(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_kind
    WHEN 'offer' THEN 'send_standard_offer'
    WHEN 'info_request' THEN 'send_info_request'
    WHEN 'follow_up' THEN 'send_follow_up'
  END
$$;

-- Platí pro druh zprávy aktivní pravidlo L4?
CREATE OR REPLACE FUNCTION agent_outbox_autonomy_granted(p_kind text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM authority_policy ap
     WHERE ap.action_kind = agent_outbox_action_kind(p_kind) AND ap.active AND ap.level = 'L4'
  )
$$;

-- Úkol pro člověka k řádku fronty (nejvýš jeden otevřený na řádek).
CREATE OR REPLACE FUNCTION agent_outbox_task(p_row agent_outbox, p_title text, p_description text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account bigint;
  v_owner   uuid;
  v_task    bigint;
BEGIN
  IF p_row.task_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM task t WHERE t.id = p_row.task_id AND t.status <> 'done') THEN
    RETURN p_row.task_id;
  END IF;
  SELECT d.account_id,
         approval_first_active_member(ARRAY[
           d.owner_id,
           p_row.mailbox_member_id,
           (SELECT ln.owner_id FROM loop_node ln WHERE ln.node = (approval_action_settings() #>> '{send_offer,node}'))
         ])
    INTO v_account, v_owner
    FROM deal d WHERE d.id = p_row.deal_id;
  INSERT INTO task (title, description, status, priority, assignee_id, created_by, due_on, account_id, deal_id)
  VALUES (left(p_title, 300), left(p_description, 2000), 'todo', 'high', v_owner, NULL,
          approval_add_working_days(approval_today(), 1), v_account, p_row.deal_id)
  RETURNING id INTO v_task;
  RETURN v_task;
END $$;

CREATE OR REPLACE FUNCTION agent_outbox_kind_label(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_kind
    WHEN 'offer' THEN 'nabídka'
    WHEN 'info_request' THEN 'doptání údajů'
    ELSE 'připomínka'
  END
$$;

-- ===========================================================================
-- 5) Zařazení do fronty (P2, P4)
-- ===========================================================================

CREATE OR REPLACE FUNCTION agent_outbox_enqueue(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind     text;
  v_ref      text;
  v_deal     bigint;
  v_version  bigint;
  v_member   uuid;
  v_reply    text;
  v_to       text;
  v_subject  text;
  v_text     text;
  v_ver      deal_scope_version%ROWTYPE;
  v_total    numeric;
  v_id       bigint;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'AO000: chybí data zprávy' USING ERRCODE = 'check_violation';
  END IF;
  v_kind := p ->> 'kind';
  v_ref := p ->> 'source_ref';
  IF v_kind IS NULL OR v_kind NOT IN ('offer', 'info_request', 'follow_up') THEN
    RAISE EXCEPTION 'AO001: neznámý druh zprávy' USING ERRCODE = 'check_violation';
  END IF;
  IF v_ref IS NULL OR v_ref !~ '^(inquiry|web|followup):[0-9]+(:[0-9]+)?$' THEN
    RAISE EXCEPTION 'AO001: neplatný source_ref' USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotence: stejný zdroj = stejný řádek (žádná druhá zpráva).
  SELECT id INTO v_id FROM agent_outbox WHERE source_ref = v_ref;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('outbox_id', v_id, 'duplicate', true);
  END IF;

  BEGIN
    v_deal := (p ->> 'deal_id')::bigint;
    v_version := nullif(p ->> 'scope_version_id', '')::bigint;
    v_member := (p ->> 'mailbox_member_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'AO001: neplatné id obchodu, verze nebo schránky' USING ERRCODE = 'check_violation';
  END;
  IF v_deal IS NULL OR NOT EXISTS (SELECT 1 FROM deal WHERE id = v_deal) THEN
    RAISE EXCEPTION 'AO002: obchod neexistuje' USING ERRCODE = 'check_violation';
  END IF;
  IF v_member IS NULL OR approval_first_active_member(ARRAY[v_member]) IS NULL THEN
    RAISE EXCEPTION 'AO002: schránka musí patřit aktivnímu členovi týmu' USING ERRCODE = 'check_violation';
  END IF;

  v_reply := nullif(btrim(p #>> '{mode,reply}'), '');
  v_to := lower(nullif(btrim(p #>> '{mode,to}'), ''));
  IF (v_reply IS NULL) = (v_to IS NULL) THEN
    RAISE EXCEPTION 'AO001: režim musí být buď odpověď, nebo nová zpráva' USING ERRCODE = 'check_violation';
  END IF;
  IF v_reply IS NOT NULL AND v_reply !~ '^[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'AO001: neplatné id příchozí zprávy' USING ERRCODE = 'check_violation';
  END IF;
  IF v_to IS NOT NULL AND (v_to !~ '^[^@[:space:]<>,;]+@[^@[:space:]<>,;]+\.[^@[:space:]<>,;]+$' OR char_length(v_to) > 254) THEN
    RAISE EXCEPTION 'AO001: neplatná adresa příjemce' USING ERRCODE = 'check_violation';
  END IF;

  v_subject := btrim(coalesce(p ->> 'subject', ''));
  v_text := coalesce(p ->> 'text', '');
  IF char_length(v_subject) NOT BETWEEN 1 AND 300 OR char_length(btrim(v_text)) = 0 OR char_length(v_text) > 20000 THEN
    RAISE EXCEPTION 'AO001: předmět 1–300 a text 1–20 000 znaků' USING ERRCODE = 'check_violation';
  END IF;

  IF v_kind = 'offer' THEN
    IF v_version IS NULL THEN
      RAISE EXCEPTION 'AO003: nabídka musí mít verzi rozsahu' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_ver FROM deal_scope_version WHERE id = v_version FOR SHARE;
    IF NOT FOUND OR v_ver.deal_id <> v_deal THEN
      RAISE EXCEPTION 'AO003: verze nabídky nepatří k obchodu' USING ERRCODE = 'check_violation';
    END IF;
    IF v_ver.status <> 'draft' THEN
      RAISE EXCEPTION 'AO003: odeslat jde jen koncept nabídky' USING ERRCODE = 'check_violation';
    END IF;
    v_total := v_ver.amount_one_time + 12 * v_ver.expected_mrr;
  ELSIF v_version IS NOT NULL THEN
    RAISE EXCEPTION 'AO003: verzi rozsahu nese jen nabídka' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO agent_outbox (
    kind, source_ref, deal_id, scope_version_id, mailbox_member_id, mode, in_reply_to_message_id,
    to_email, subject, body, price_map_version, quote_total
  ) VALUES (
    v_kind, v_ref, v_deal, v_version, v_member,
    CASE WHEN v_reply IS NOT NULL THEN 'reply' ELSE 'to' END,
    v_reply, v_to, v_subject, v_text,
    left(nullif(btrim(p ->> 'price_map_version'), ''), 64),
    v_total
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Souběh, nebo jiný zdroj se stejnou odpovědí / verzí: vrátit existující řádek.
    SELECT id INTO v_id FROM agent_outbox
     WHERE source_ref = v_ref
        OR (v_version IS NOT NULL AND scope_version_id = v_version)
        OR (v_reply IS NOT NULL AND in_reply_to_message_id = v_reply AND kind = v_kind)
     ORDER BY id LIMIT 1;
    RETURN jsonb_build_object('outbox_id', v_id, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('outbox_id', v_id, 'duplicate', false);
END $$;

-- ===========================================================================
-- 6) Rezervace odeslání (claim)
-- ===========================================================================

-- Vrací {ok, reason}. reason: not_found | not_queued | not_authorized |
-- not_approved | daily_limit | recipient_limit | invalid. Bez ok se nic
-- nemění a zpráva zůstává ve frontě (limit = zkusí se další den).
CREATE OR REPLACE FUNCTION agent_outbox_claim(
  p_id                   bigint,
  p_recipient            text,
  p_rfc_message_id       text,
  p_autonomous           boolean,
  p_daily_limit          integer,
  p_limit_kinds          text[],
  p_per_recipient_limit  integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row       agent_outbox%ROWTYPE;
  v_day       date := agent_outbox_today();
  v_recipient text := lower(btrim(coalesce(p_recipient, '')));
  v_count     integer;
  v_approved  boolean;
BEGIN
  IF v_recipient !~ '^[^@[:space:]<>,;]+@[^@[:space:]<>,;]+\.[^@[:space:]<>,;]+$' OR char_length(v_recipient) > 254
     OR p_rfc_message_id IS NULL OR p_rfc_message_id !~ '^<[A-Za-z0-9._-]{1,120}@[A-Za-z0-9.-]{1,70}>$'
     OR p_daily_limit IS NULL OR p_daily_limit < 0 OR p_per_recipient_limit IS NULL OR p_per_recipient_limit < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  -- Jeden claim po druhém v rámci pražského dne: počty limitů jsou přesné
  -- i při dvou souběžných bězích.
  PERFORM pg_advisory_xact_lock(hashtext('agent_outbox:' || v_day::text));

  SELECT * INTO v_row FROM agent_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_row.status <> 'queued' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_queued');
  END IF;

  IF coalesce(p_autonomous, false) THEN
    -- Druhá pojistka za TS: bez pravidla L4 se samostatně neposílá.
    IF NOT agent_outbox_autonomy_granted(v_row.kind) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
  ELSE
    -- Nabídka po schválení = verze schválená k odeslání (0084), jinak by
    -- potvrzení po odeslání narazilo na strážce SV006. Ostatní druhy
    -- uvolňuje člověk (agent_outbox_release → approved_at).
    IF v_row.kind = 'offer' THEN
      v_approved := EXISTS (SELECT 1 FROM deal_scope_version v
                             WHERE v.id = v_row.scope_version_id AND v.status = 'draft' AND v.send_approved_at IS NOT NULL);
    ELSE
      v_approved := v_row.approved_at IS NOT NULL;
    END IF;
    IF NOT v_approved THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_approved');
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM agent_outbox
   WHERE prague_day = v_day AND kind = ANY (coalesce(p_limit_kinds, ARRAY[v_row.kind]))
     AND status IN ('claimed', 'sent', 'needs_attention');
  IF v_count >= p_daily_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'daily_limit');
  END IF;

  SELECT count(*) INTO v_count FROM agent_outbox
   WHERE prague_day = v_day AND lower(recipient) = v_recipient
     AND status IN ('claimed', 'sent', 'needs_attention');
  IF v_count >= p_per_recipient_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'recipient_limit');
  END IF;

  UPDATE agent_outbox
     SET status = 'claimed', claimed_at = now(), prague_day = v_day, recipient = v_recipient,
         rfc_message_id = p_rfc_message_id, autonomous = coalesce(p_autonomous, false),
         attempts = attempts + 1, stop_reason = NULL, error_code = NULL
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'prague_day', v_day);
END $$;

-- ===========================================================================
-- 7) Potvrzení odeslání (Gmail vrátil id zprávy)
-- ===========================================================================

CREATE OR REPLACE FUNCTION agent_outbox_confirm(
  p_id               bigint,
  p_sent_message_id  text,
  p_sent_thread_id   text,
  p_body_sha256      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     agent_outbox%ROWTYPE;
  v_account bigint;
  v_verno   integer;
  v_action  text;
  v_how     text;
BEGIN
  IF p_sent_message_id IS NULL OR p_sent_message_id !~ '^[A-Za-z0-9_-]{1,128}$'
     OR (p_sent_thread_id IS NOT NULL AND p_sent_thread_id !~ '^[A-Za-z0-9_-]{1,128}$')
     OR (p_body_sha256 IS NOT NULL AND p_body_sha256 !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'AO010: neplatné id odeslané zprávy' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_row FROM agent_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AO011: zpráva % ve frontě není', p_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.status = 'sent' THEN
    IF v_row.sent_message_id = p_sent_message_id THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true);
    END IF;
    RAISE EXCEPTION 'AO012: zpráva už je potvrzená s jiným id' USING ERRCODE = 'check_violation';
  END IF;
  -- needs_attention: výsledek byl nejistý a úloha zprávu dohledala v Odeslané poště.
  IF v_row.status NOT IN ('claimed', 'needs_attention') OR v_row.rfc_message_id IS NULL THEN
    RAISE EXCEPTION 'AO012: potvrdit jde jen rezervovanou zprávu (stav %)', v_row.status USING ERRCODE = 'check_violation';
  END IF;

  UPDATE agent_outbox
     SET status = 'sent', sent_at = now(), sent_message_id = p_sent_message_id, sent_thread_id = p_sent_thread_id,
         sent_body_sha256 = p_body_sha256, stop_reason = NULL, error_code = NULL
   WHERE id = p_id;

  SELECT d.account_id INTO v_account FROM deal d WHERE d.id = v_row.deal_id;

  IF v_row.kind = 'offer' AND v_row.scope_version_id IS NOT NULL THEN
    -- Jediná cesta, kterou strážce SV006 pustí koncept → odesláno bez
    -- schválené žádosti: příznak s id verze a samostatný řádek fronty 'sent'.
    PERFORM set_config('app.agent_send', v_row.scope_version_id::text, true);
    UPDATE deal_scope_version SET status = 'sent'
     WHERE id = v_row.scope_version_id AND status = 'draft'
    RETURNING version INTO v_verno;
    PERFORM set_config('app.agent_send', '', true);
    UPDATE deal SET phase = 'nabidka'
     WHERE id = v_row.deal_id AND (phase IS NULL OR phase = 'poptavka');
  END IF;

  v_how := CASE WHEN v_row.autonomous THEN 'automaticky (agent)' ELSE 'po schválení člověkem' END;
  IF v_account IS NOT NULL THEN
    INSERT INTO sales_activity (account_id, deal_id, kind, outcome, subject, body, occurred_at, created_by, source, external_id)
    VALUES (
      v_account, v_row.deal_id, 'email', 'completed',
      'Odesláno zákazníkovi: ' || agent_outbox_kind_label(v_row.kind)
        || CASE WHEN v_verno IS NOT NULL THEN ' (verze ' || v_verno || ')' ELSE '' END,
      'Zprávu odeslala odchozí fronta ' || v_how || ' (fronta č. ' || v_row.id || '). Text je v Odeslané poště schránky.',
      now(), NULL, 'agent:outbox', 'outbox:' || v_row.id
    )
    ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING;
  END IF;

  -- Významová událost (řádkovou změnu zapsal trigger): jen id a kódy.
  v_action := v_row.kind || CASE WHEN v_row.autonomous THEN '.auto_sent' ELSE '.approved_sent' END;
  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
  VALUES ('system', 'agent_outbox', v_action, 'agent_outbox', v_row.id, NULL,
          jsonb_build_object('kind', v_row.kind, 'deal_id', v_row.deal_id, 'scope_version_id', v_row.scope_version_id,
                             'price_map_version', v_row.price_map_version, 'mailbox_member_id', v_row.mailbox_member_id,
                             'autonomous', v_row.autonomous, 'approval_request_id', v_row.approval_request_id));
  RETURN jsonb_build_object('ok', true, 'duplicate', false);
END $$;

-- ===========================================================================
-- 8) Ostatní přechody: zablokování, selhání, nejistý výsledek, vrácení
-- ===========================================================================

-- p_status: blocked (z queued nebo jiný důvod u blocked), failed /
-- needs_attention (z claimed), queued (z claimed jen s důvodem 'throttled' —
-- Gmail zprávu prokazatelně nepřijal). p_task_title NULL = bez úkolu.
CREATE OR REPLACE FUNCTION agent_outbox_finish(
  p_id          bigint,
  p_status      text,
  p_reason      text,
  p_error_code  text DEFAULT NULL,
  p_task_title  text DEFAULT NULL,
  p_task_text   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row  agent_outbox%ROWTYPE;
  v_task bigint;
BEGIN
  IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,63}$'
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9][a-z0-9_.-]{0,63}$') THEN
    RAISE EXCEPTION 'AO020: neplatný důvod nebo kód chyby' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_row FROM agent_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AO011: zpráva % ve frontě není', p_id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
       (v_row.status = 'queued' AND p_status = 'blocked')
    OR (v_row.status = 'blocked' AND p_status = 'blocked')
    OR (v_row.status = 'claimed' AND p_status IN ('failed', 'needs_attention'))
    OR (v_row.status = 'claimed' AND p_status = 'queued' AND p_reason = 'throttled')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'transition_not_allowed', 'status', v_row.status);
  END IF;

  IF p_task_title IS NOT NULL THEN
    v_task := agent_outbox_task(v_row, p_task_title, coalesce(p_task_text, p_task_title));
  END IF;

  UPDATE agent_outbox
     SET status = p_status,
         stop_reason = CASE WHEN p_status = 'queued' THEN NULL ELSE p_reason END,
         error_code = p_error_code,
         task_id = coalesce(v_task, task_id),
         -- Vrácená rezervace (throttled) uvolní den i Message-ID; nic neodešlo.
         claimed_at = CASE WHEN p_status = 'queued' THEN NULL ELSE claimed_at END,
         prague_day = CASE WHEN p_status = 'queued' THEN NULL ELSE prague_day END,
         rfc_message_id = CASE WHEN p_status = 'queued' THEN NULL ELSE rfc_message_id END
   WHERE id = p_id;

  IF p_status IN ('blocked', 'failed') AND v_row.status <> 'blocked' THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
    VALUES ('system', 'agent_outbox',
            v_row.kind || CASE WHEN p_status = 'blocked' THEN '.send_blocked' ELSE '.send_failed' END,
            'agent_outbox', v_row.id, NULL,
            jsonb_build_object('kind', v_row.kind, 'deal_id', v_row.deal_id, 'reason', p_reason,
                               'error_code', p_error_code, 'price_map_version', v_row.price_map_version));
  END IF;
  RETURN jsonb_build_object('ok', true, 'task_id', v_task);
END $$;

-- Rezervace starší než p_minutes → needs_attention + úkol. Nic se neposílá
-- znovu; úloha pak zkusí zprávu dohledat podle Message-ID.
CREATE OR REPLACE FUNCTION agent_outbox_mark_stale(p_minutes integer)
RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row  agent_outbox%ROWTYPE;
  v_ids  bigint[] := '{}';
  v_task bigint;
BEGIN
  IF p_minutes IS NULL OR p_minutes < 1 THEN
    RAISE EXCEPTION 'AO020: neplatný limit minut' USING ERRCODE = 'check_violation';
  END IF;
  FOR v_row IN
    SELECT * FROM agent_outbox
     WHERE status = 'claimed' AND claimed_at < now() - make_interval(mins => p_minutes)
     ORDER BY id
     FOR UPDATE SKIP LOCKED
  LOOP
    v_task := agent_outbox_task(v_row,
      'Zkontrolovat odeslání: ' || agent_outbox_kind_label(v_row.kind) || ' (fronta č. ' || v_row.id || ')',
      'Odeslání zprávy z odchozí fronty nedoběhlo a není jisté, jestli zpráva odešla. Fronta ji sama znovu NEPOŠLE. '
        || 'Zkontroluj Odeslanou poštu schránky; když zpráva neodešla, uvolni ji v Cockpitu znovu, jinak ji nech být.');
    UPDATE agent_outbox SET status = 'needs_attention', stop_reason = 'stale_claim', task_id = v_task WHERE id = v_row.id;
    v_ids := v_ids || v_row.id;
  END LOOP;
  RETURN v_ids;
END $$;

-- ===========================================================================
-- 9) Schválení člověkem
-- ===========================================================================

-- Nabídka bez bran pravomoci → typovaná žádost send_offer (stejná jako
-- z detailu obchodu, 0084), žadatel 'system:agent_outbox'. Zpráva čeká
-- ve stavu blocked/approval_required; schválení ji vrátí do fronty
-- (approval_exec_send_offer níže).
CREATE OR REPLACE FUNCTION agent_outbox_request_offer_approval(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row       agent_outbox%ROWTYPE;
  v_ver       deal_scope_version%ROWTYPE;
  v_settings  jsonb := approval_action_settings() -> 'send_offer';
  v_content   jsonb;
  v_hash      text;
  v_level     text;
  v_req       bigint;
BEGIN
  SELECT * INTO v_row FROM agent_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_row.kind <> 'offer' OR v_row.scope_version_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_offer');
  END IF;
  IF v_row.status NOT IN ('queued', 'blocked') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_queued');
  END IF;
  SELECT * INTO v_ver FROM deal_scope_version WHERE id = v_row.scope_version_id FOR SHARE;
  IF NOT FOUND OR v_ver.status <> 'draft' THEN
    UPDATE agent_outbox SET status = 'blocked', stop_reason = 'version_not_draft' WHERE id = p_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'version_not_draft');
  END IF;
  IF v_ver.send_approved_at IS NOT NULL THEN
    -- Už schválená (např. člověkem z detailu obchodu): rovnou zpět do fronty.
    UPDATE agent_outbox SET status = 'queued', stop_reason = NULL, approved_at = coalesce(approved_at, v_ver.send_approved_at),
           approved_by = coalesce(approved_by, 'request:' || v_ver.send_approval_request_id),
           approval_request_id = coalesce(approval_request_id, v_ver.send_approval_request_id)
     WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'approved', true, 'approval_request_id', v_ver.send_approval_request_id);
  END IF;

  v_content := approval_offer_content(v_ver);
  v_hash := approval_params_hash('send_offer', 'deal_scope_version', v_ver.id, v_content);
  SELECT ap.level INTO v_level FROM authority_policy ap
   WHERE ap.action_kind = 'send_offer' AND ap.active AND loop_level_rank(ap.level) IS NOT NULL
   ORDER BY loop_level_rank(ap.level) ASC LIMIT 1;

  INSERT INTO approval_request (
    case_id, node, action_kind, requested_level, status, requested_by, expires_at,
    action_type, target_table, target_id, params, params_hash, transition
  ) VALUES (
    NULL, v_settings ->> 'node', 'send_offer', coalesce(v_level, 'L2'), 'pending', 'system:agent_outbox',
    now() + make_interval(days => (v_settings ->> 'validity_days')::integer),
    'send_offer', 'deal_scope_version', v_ver.id,
    jsonb_build_object('deal_id', v_ver.deal_id, 'version_id', v_ver.id, 'version', v_ver.version),
    v_hash, 'draft>send_approved'
  )
  ON CONFLICT (action_type, target_table, target_id, params_hash)
    WHERE status = 'pending' AND action_type IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_req;
  IF v_req IS NULL THEN
    SELECT ar.id INTO v_req FROM approval_request ar
     WHERE ar.action_type = 'send_offer' AND ar.target_table = 'deal_scope_version'
       AND ar.target_id = v_ver.id AND ar.status = 'pending'
     ORDER BY ar.id DESC LIMIT 1;
  END IF;

  UPDATE agent_outbox SET status = 'blocked', stop_reason = 'approval_required', approval_request_id = v_req WHERE id = p_id;
  IF v_row.status = 'queued' THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
    VALUES ('system', 'agent_outbox', 'offer.approval_requested', 'agent_outbox', v_row.id, NULL,
            jsonb_build_object('kind', v_row.kind, 'deal_id', v_row.deal_id, 'approval_request_id', v_req,
                               'price_map_version', v_row.price_map_version));
  END IF;
  RETURN jsonb_build_object('ok', true, 'approved', false, 'approval_request_id', v_req);
END $$;

-- Člověk (obchodní role, AAL2) uvolní zprávu k odeslání: doptání nebo
-- připomínku čekající na schválení, selhanou zprávu, nebo nejistou zprávu
-- s výslovným potvrzením, že neodešla. Nabídka čekající na schválení se
-- schvaluje jen přes žádost send_offer (verze nabídky má svůj otisk a strážce).
CREATE OR REPLACE FUNCTION agent_outbox_release(p_id bigint, p_confirm_not_sent boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := loop_actor();
  v_row   agent_outbox%ROWTYPE;
BEGIN
  IF NOT can_see_sales() THEN
    RAISE EXCEPTION 'Odeslání zákazníkovi uvolňuje jen obchodní role' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM agent_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zpráva % ve frontě není', p_id USING ERRCODE = 'P0002';
  END IF;
  IF v_row.body_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Text zprávy už je po retenci smazaný' USING ERRCODE = '22023';
  END IF;
  IF v_row.kind = 'offer' AND NOT EXISTS (
       SELECT 1 FROM deal_scope_version v
        WHERE v.id = v_row.scope_version_id AND v.status = 'draft' AND v.send_approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Nabídku nejdřív schval v Ke schválení (žádost o odeslání nabídky)' USING ERRCODE = '22023';
  END IF;
  IF v_row.status = 'needs_attention' AND NOT coalesce(p_confirm_not_sent, false) THEN
    RAISE EXCEPTION 'Nejdřív ověř v Odeslané poště, že zpráva neodešla' USING ERRCODE = '22023';
  END IF;
  IF v_row.status NOT IN ('blocked', 'failed', 'needs_attention') THEN
    RAISE EXCEPTION 'Uvolnit jde jen zablokovanou, selhanou nebo nejistou zprávu (stav %)', v_row.status USING ERRCODE = '22023';
  END IF;
  UPDATE agent_outbox
     SET status = 'queued', stop_reason = NULL, error_code = NULL, approved_at = now(), approved_by = v_actor,
         claimed_at = NULL, prague_day = NULL, rfc_message_id = NULL
   WHERE id = p_id;
  RETURN 'queued';
END $$;

-- Zamítnuté nebo vypršelé žádosti send_offer → důvod u čekající zprávy
-- (executor 0084 vrací obchod vlastníkovi s úkolem, fronta jen zaznamená).
CREATE OR REPLACE FUNCTION agent_outbox_sync_approvals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE agent_outbox o
     SET stop_reason = CASE ar.status WHEN 'rejected' THEN 'approval_rejected' ELSE 'approval_expired' END
    FROM approval_request ar
   WHERE o.status = 'blocked' AND o.stop_reason = 'approval_required'
     AND ar.id = o.approval_request_id AND ar.status IN ('rejected', 'expired');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ===========================================================================
-- 10) Retence a výmaz osobních údajů
-- ===========================================================================

-- Text, předmět a adresy koncových zpráv starších než p_days dní se smažou;
-- řádek (id, stavy, časy, kódy) zůstává kvůli limitům, reportingu a auditu.
CREATE OR REPLACE FUNCTION agent_outbox_purge_text(p_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'AO030: retence nejméně 30 dní' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE agent_outbox
     SET subject = NULL, body = NULL, to_email = NULL, recipient = NULL, body_purged_at = now()
   WHERE body_purged_at IS NULL AND status IN ('sent', 'failed', 'blocked')
     AND coalesce(sent_at, updated_at) < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Výmaz podle adresy (GDPR): smaže text i adresu všech zpráv pro adresu;
-- čekající zpráva se zablokuje (nic se už neodešle). Rozpracovanou
-- rezervaci (claimed) nechá — tu dořeší potvrzení nebo mark_stale.
CREATE OR REPLACE FUNCTION agent_outbox_erase_address(p_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_n integer;
BEGIN
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'AO030: neplatná adresa' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE agent_outbox
     SET status = CASE WHEN status = 'queued' THEN 'blocked' ELSE status END,
         stop_reason = CASE WHEN status = 'queued' THEN 'gdpr_erased' ELSE stop_reason END,
         subject = NULL, body = NULL, to_email = NULL, recipient = NULL, body_purged_at = now()
   WHERE (lower(to_email) = v_email OR lower(recipient) = v_email)
     AND status <> 'claimed';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ===========================================================================
-- 11) Strážce verze nabídky (0084) — cesta odchozí fronty a zavření díry INSERT 'sent'
-- ===========================================================================

CREATE OR REPLACE FUNCTION deal_scope_version_send_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.send_approved_at IS NOT NULL OR NEW.send_approval_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Schválení k odeslání nastavuje jen schválená žádost' USING ERRCODE = 'SV007';
    END IF;
    -- 0104: rovnou odeslanou verzi smí založit jen člověk (import PDF nabídky,
    -- která UŽ odešla mimo systém; created_by = importující). Automat
    -- (servisní klíč bez autora) zakládá jen koncept a odesílá přes frontu.
    IF NEW.status = 'sent' AND NEW.created_by IS NULL THEN
      RAISE EXCEPTION 'Odeslanou verzi nabídky nejde založit bez autora — odeslání jde přes odchozí frontu' USING ERRCODE = 'SV006';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.send_approved_at IS DISTINCT FROM OLD.send_approved_at
     OR NEW.send_approval_request_id IS DISTINCT FROM OLD.send_approval_request_id THEN
    IF OLD.send_approval_request_id IS NOT NULL
       OR NEW.send_approval_request_id IS NULL
       OR OLD.status <> 'draft' OR NEW.status <> 'draft'
       OR coalesce(current_setting('app.approval_exec', true), '') <> NEW.send_approval_request_id::text THEN
      RAISE EXCEPTION 'Schválení k odeslání nastavuje jen schválená žádost' USING ERRCODE = 'SV007';
    END IF;
    NEW.send_approved_at := now();
  END IF;

  IF OLD.send_approved_at IS NOT NULL
     AND (NEW.scope IS DISTINCT FROM OLD.scope
          OR NEW.amount_one_time IS DISTINCT FROM OLD.amount_one_time
          OR NEW.expected_mrr IS DISTINCT FROM OLD.expected_mrr
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id) THEN
    RAISE EXCEPTION 'Schválenou verzi nabídky nejde měnit — založ novou verzi' USING ERRCODE = 'SV008';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'sent' AND OLD.send_approved_at IS NULL
     AND approval_offer_requires_approval(OLD.amount_one_time, OLD.expected_mrr, OLD.currency::text)
     -- 0104: samostatné odeslání odchozí frontou s plnou pravomocí (agent_outbox_confirm).
     AND NOT (
       coalesce(current_setting('app.agent_send', true), '') = NEW.id::text
       AND EXISTS (SELECT 1 FROM agent_outbox o
                    WHERE o.scope_version_id = NEW.id AND o.status = 'sent' AND o.autonomous)
     ) THEN
    RAISE EXCEPTION 'Verzi nabídky nejde označit jako odeslanou bez schválené žádosti' USING ERRCODE = 'SV006';
  END IF;
  RETURN NEW;
END $$;

-- ===========================================================================
-- 12) Executor schválení odeslání nabídky (0084) — zpráva čekající ve frontě
-- ===========================================================================

CREATE OR REPLACE FUNCTION approval_exec_send_offer(p_req approval_request)
RETURNS TABLE (out_status text, out_result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings  jsonb := approval_action_settings() -> 'send_offer';
  v_ver       deal_scope_version%ROWTYPE;
  v_found     boolean;
  v_deal_id   bigint := (p_req.params ->> 'deal_id')::bigint;
  v_version   integer := (p_req.params ->> 'version')::integer;
  v_account   bigint;
  v_deal_own  uuid;
  v_owner     uuid;
  v_reason    text;
  v_due       date;
  v_task      bigint;
  v_act       bigint;
  v_approver  text;
  v_outbox    bigint;
BEGIN
  SELECT * INTO v_ver FROM deal_scope_version WHERE id = p_req.target_id FOR UPDATE;
  v_found := FOUND;
  IF v_found THEN
    v_deal_id := v_ver.deal_id;
    v_version := v_ver.version;
  END IF;
  SELECT d.account_id, d.owner_id INTO v_account, v_deal_own FROM deal d WHERE d.id = v_deal_id;
  v_owner := approval_first_active_member(ARRAY[
    v_deal_own,
    approval_member_uuid(p_req.requested_by),
    (SELECT ln.owner_id FROM loop_node ln WHERE ln.node = p_req.node)
  ]);

  IF NOT v_found THEN
    v_reason := 'version_missing';
  ELSIF v_ver.status <> 'draft' THEN
    v_reason := 'version_not_draft';
  ELSIF v_ver.send_approved_at IS NOT NULL THEN
    v_reason := 'version_already_approved';
  ELSIF approval_params_hash(p_req.action_type, p_req.target_table, p_req.target_id, approval_offer_content(v_ver))
        IS DISTINCT FROM p_req.params_hash THEN
    v_reason := 'version_changed';
  END IF;

  IF v_reason IS NOT NULL THEN
    v_task := approval_human_task(
      'Zkontrolovat nabídku (verze ' || coalesce(v_version::text, '?') || '): schválení k odeslání se neuplatnilo',
      'Žádost č. ' || p_req.id || ' o schválení odeslání byla schválena, ale verze se neoznačila ('
        || CASE v_reason
             WHEN 'version_missing' THEN 'verze už neexistuje'
             WHEN 'version_not_draft' THEN 'verze už není koncept'
             WHEN 'version_already_approved' THEN 'verze už je schválená jinou žádostí'
             ELSE 'obsah verze se od žádosti změnil'
           END
        || '). Nic se neodeslalo. Zkontroluj nabídku a případně požádej o schválení znovu.',
      v_owner, v_account, CASE WHEN v_account IS NULL THEN NULL ELSE v_deal_id END);
    RETURN QUERY SELECT 'needs_attention'::text,
      jsonb_build_object('reason', v_reason, 'task_id', v_task, 'assignee_id', v_owner,
                         'deal_id', v_deal_id, 'version', v_version);
    RETURN;
  END IF;

  PERFORM set_config('app.approval_exec', p_req.id::text, true);
  UPDATE deal_scope_version
     SET send_approved_at = now(), send_approval_request_id = p_req.id
   WHERE id = v_ver.id;
  PERFORM set_config('app.approval_exec', '', true);

  v_approver := coalesce(
    (SELECT tm.full_name FROM team_member tm WHERE tm.id = approval_member_uuid(p_req.decided_by)),
    'schvalovatel');

  -- 0104: čeká-li k verzi zpráva v odchozí frontě, vrátí se do fronty
  -- a odešle ji agent při nejbližším běhu. Úkol „pošli sám" nevzniká.
  UPDATE agent_outbox
     SET status = 'queued', stop_reason = NULL, approved_at = now(), approved_by = p_req.decided_by,
         approval_request_id = p_req.id
   WHERE scope_version_id = v_ver.id AND status = 'blocked'
     AND stop_reason IN ('approval_required', 'approval_expired')
  RETURNING id INTO v_outbox;

  IF v_outbox IS NOT NULL THEN
    INSERT INTO sales_activity (account_id, deal_id, kind, outcome, subject, body, occurred_at, created_by, source, external_id)
    VALUES (
      v_account, v_deal_id, 'note', 'completed',
      'Nabídka (verze ' || v_version || ') schválena k odeslání',
      'Žádost č. ' || p_req.id || ' schválil(a) ' || v_approver
        || '. Nabídku odešle odchozí fronta agenta při nejbližším běhu (fronta č. ' || v_outbox || '); neposílej ji ručně.',
      now(), NULL, 'approval', 'approval:' || p_req.id
    )
    ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_act;
    RETURN QUERY SELECT 'completed'::text,
      jsonb_build_object('version_id', v_ver.id, 'version', v_version, 'deal_id', v_deal_id, 'outbox_id', v_outbox,
                         'activity_id', v_act, 'assignee_id', v_owner);
    RETURN;
  END IF;

  v_due := approval_add_working_days(approval_today(), (v_settings ->> 'task_working_days')::integer);

  v_task := approval_human_task(
    (v_settings ->> 'task_title') || ' (verze ' || v_version || ')',
    'Verze ' || v_version || ' nabídky je schválená k odeslání (žádost č. ' || p_req.id || ', schválil(a) '
      || v_approver || '). Cockpit nic neodesílá: pošli nabídku klientovi sám a potom ji na detailu obchodu označ jako odeslanou.',
    v_owner, v_account, v_deal_id, 'high', v_due);

  INSERT INTO sales_activity (account_id, deal_id, kind, outcome, subject, body, occurred_at, created_by, source, external_id)
  VALUES (
    v_account, v_deal_id, 'note', 'completed',
    'Nabídka (verze ' || v_version || ') schválena k odeslání',
    'Žádost č. ' || p_req.id || ' schválil(a) ' || v_approver || '. Cockpit nic neodeslal; úkol „'
      || (v_settings ->> 'task_title') || '“ čeká do ' || to_char(v_due, 'FMDD. FMMM. YYYY') || '.',
    now(), NULL, 'approval', 'approval:' || p_req.id
  )
  ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_act;

  RETURN QUERY SELECT 'completed'::text,
    jsonb_build_object('version_id', v_ver.id, 'version', v_version, 'deal_id', v_deal_id, 'task_id', v_task,
                       'activity_id', v_act, 'assignee_id', v_owner, 'due_on', v_due);
END $$;

-- ===========================================================================
-- 13) Oprávnění
-- ===========================================================================

REVOKE ALL ON FUNCTION agent_outbox_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_action_kind(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_autonomy_granted(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_task(agent_outbox, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_kind_label(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_enqueue(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_claim(bigint, text, text, boolean, integer, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_confirm(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_finish(bigint, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_mark_stale(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_request_offer_approval(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_sync_approvals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_purge_text(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_erase_address(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_release(bigint, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION deal_scope_version_send_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_exec_send_offer(approval_request) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION agent_outbox_release(bigint, boolean) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION agent_outbox_enqueue(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_claim(bigint, text, text, boolean, integer, text[], integer) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_confirm(bigint, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_finish(bigint, text, text, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_mark_stale(integer) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_request_offer_approval(bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_sync_approvals() TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_purge_text(integer) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_erase_address(text) TO service_role;
    GRANT EXECUTE ON FUNCTION agent_outbox_autonomy_granted(text) TO service_role;
  END IF;
END $$;

-- ===========================================================================
-- 14) Pravidla pravomoci (jen když aktivní pravidlo chybí): L2 = vždy člověk
-- ===========================================================================

INSERT INTO authority_policy (action_kind, level, active, note, updated_by)
SELECT v.kind, 'L2', true, v.note, 'system:migration_0104'
FROM (VALUES
  ('send_standard_offer', 'Agent smi sam odeslat standardni nabidku z mapy jen s L4; vychozi L2 = schvaluje obchod'),
  ('send_info_request', 'Agent smi sam odeslat doptani udaju jen s L4; vychozi L2 = schvaluje obchod'),
  ('send_follow_up', 'Agent smi sam odeslat pripominku nabidky jen s L4; vychozi L2 = schvaluje obchod')
) AS v(kind, note)
WHERE NOT EXISTS (SELECT 1 FROM authority_policy ap WHERE ap.action_kind = v.kind AND ap.active);

INSERT INTO schema_migration (version, note)
VALUES ('0104', 'agent_outbox: odchozi fronta agenta (enqueue/claim/confirm/finish/mark_stale/request_offer_approval/release/sync_approvals/purge/erase), denni limity, strazce SV006 pro frontu a INSERT sent bez autora, executor send_offer vraci zpravu do fronty, pravidla send_* = L2, tvrdy audit bez textu')
ON CONFLICT (version) DO NOTHING;
