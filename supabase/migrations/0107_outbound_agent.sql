-- 0107 — outbound_agent: balík P7 — signály, kvalifikace, leady a legální oslovení.
--
-- ČÍSLO: o jedna vyšší než nejvyšší rezervované v kontraktu (0106). Při
-- integraci ho smí integrace přečíslovat; soubor na ničem z 0103–0106
-- nezávisí kromě volitelného rozšíření agent_outbox (oddíl 6).
--
-- PROČ: druhý agent ze zadání (kap. 3–4, varianta B). Z veřejných zdrojů
-- (ARES, otevřená data veřejných zakázek, RSS/iCal akcí, veřejné inzeráty)
-- a z CRM (výročí poslední akce, sezóna) sbírá SIGNÁLY, kvalifikuje je
-- podle ICP firmy, z relevantních založí LEAD (obchod ve fázi poptávky se
-- zdrojem 'agent:outbound:<zdroj>') a připraví OSLOVENÍ:
--   * stávajícím zákazníkům u obdobných služeb (§ 7 odst. 3 zák. 480/2004 Sb.)
--     a kontaktům s doloženým souhlasem smí jít e-mail přes frontu
--     agent_outbox (kind 'outreach'), jen s odkazem na odhlášení;
--   * novým firmám ze signálů jen NÁVRH pro člověka (telefon, osobně,
--     LinkedIn ručně) — nic se neodesílá.
--
--   outbound_signal      — signál ze zdroje (idempotentní podle source + external_ref)
--   outbound_outreach    — návrh / koncept / odeslané oslovení k signálu
--   outreach_consent     — evidence souhlasu se zasíláním (znění, verze, čas, zdroj)
--   outreach_suppression — odhlášení (opt-out) podle otisku e-mailu; přežije výmaz kontaktu
--
-- RPC (EXECUTE jen service_role, volá úloha /api/cron/outbound-agent a
-- odhlašovací routa /api/web/odhlaseni):
--   outbound_signal_upsert(p jsonb)  → {signal_id, duplicate}
--   outbound_lead_create(p jsonb)    → {account_id, deal_id, created_account, duplicate}
--   outbound_unsubscribe(p jsonb)    → {suppressed, contacts}
-- RPC pro Cockpit (tým s obchodní rolí, AAL2):
--   outbound_review(p jsonb)         → rozhodnutí CSO nad signálem / oslovením
--
-- OSOBNÍ ÚDAJE: jména a e-maily kontaktů jsou dál jen v contact; tady je
-- jen otisk e-mailu (sha256 normalizované adresy) a text konceptu oslovení.
-- Audit (měkký, 0082) nese jen id, stavy, data, počty a booleany.

DO $$
BEGIN
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0107 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0107 vyžaduje can_see_sales() a is_team_member() — nejdřív aplikujte 0020 a 0069';
  END IF;
END $$;

-- ===========================================================================
-- 1) Zdroj obchodu (štítek „Agent"): deal.source
-- ===========================================================================
-- Aditivní a idempotentní: pokud pole deal.source zavede jiný balík dřív,
-- IF NOT EXISTS ho nechá být. Outbound zapisuje 'agent:outbound:<zdroj>'.
ALTER TABLE deal ADD COLUMN IF NOT EXISTS source text;
-- 0103 (P2) zavedl deal_source_check jen pro jednoslovné zdroje (email, web).
-- Integrace: povolit i zdroj agenta s dvojtečkou ('agent:outbound:vvz');
-- jednoslovné hodnoty z 0103 platí beze změny.
ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_source_check;
ALTER TABLE deal ADD CONSTRAINT deal_source_check
  CHECK (source IS NULL OR source ~ '^[a-z][a-z0-9_]{0,39}(:[a-z][a-z0-9_]{0,39}){0,2}$');

-- ===========================================================================
-- 2) Signály
-- ===========================================================================

CREATE TABLE IF NOT EXISTS outbound_signal (
  id             bigserial PRIMARY KEY,
  source         text NOT NULL,
  kind           text NOT NULL,
  external_ref   text NOT NULL,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'new',
  title          text NOT NULL,
  url            text,
  signal_date    date,
  ico            text,
  company_name   text,
  -- Ověřená fakta ze zdroje [{key, value, source_url}] — jediný materiál personalizace.
  facts          jsonb NOT NULL DEFAULT '[]'::jsonb,
  score          integer,
  reason_codes   text[] NOT NULL DEFAULT '{}',
  segment        text,
  account_id     bigint REFERENCES account(id) ON DELETE SET NULL,
  contact_id     bigint REFERENCES contact(id) ON DELETE SET NULL,
  deal_id        bigint REFERENCES deal(id) ON DELETE SET NULL,
  qualified_at   timestamptz,
  decided_at     timestamptz,
  decided_by     uuid REFERENCES team_member(id) ON DELETE SET NULL,
  attempts       integer NOT NULL DEFAULT 0,
  error_code     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_signal_ref_key UNIQUE (source, external_ref),
  CONSTRAINT outbound_signal_source_check CHECK (source IN ('ares', 'vvz', 'feed', 'jobs', 'crm')),
  CONSTRAINT outbound_signal_kind_check
    CHECK (kind IN ('public_tender', 'event', 'job_posting', 'crm_anniversary', 'crm_season', 'company_change')),
  CONSTRAINT outbound_signal_status_check CHECK (status IN ('new', 'converted', 'review', 'dismissed', 'blocked', 'failed')),
  CONSTRAINT outbound_signal_score_check CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  CONSTRAINT outbound_signal_text_len_check CHECK (
    char_length(external_ref) BETWEEN 1 AND 300
    AND char_length(title) BETWEEN 1 AND 300
    AND (url IS NULL OR (char_length(url) <= 1000 AND url ~ '^https?://'))
    AND (ico IS NULL OR ico ~ '^[0-9]{8}$')
    AND (company_name IS NULL OR char_length(company_name) <= 200)
    AND (segment IS NULL OR char_length(segment) <= 40)
    AND (error_code IS NULL OR char_length(error_code) <= 64)
  ),
  CONSTRAINT outbound_signal_facts_check CHECK (jsonb_typeof(facts) = 'array' AND pg_column_size(facts) <= 16384)
);

CREATE INDEX IF NOT EXISTS outbound_signal_status_idx ON outbound_signal (status, detected_at DESC);
CREATE INDEX IF NOT EXISTS outbound_signal_ico_idx ON outbound_signal (ico) WHERE ico IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbound_signal_account_idx ON outbound_signal (account_id) WHERE account_id IS NOT NULL;

COMMENT ON TABLE outbound_signal IS
  'Signál outbound agenta (0107, P7). Zapisuje jen outbound_signal_upsert (service_role); rozhoduje úloha outbound-agent nebo CSO v Cockpitu.';

-- ===========================================================================
-- 3) Oslovení
-- ===========================================================================

CREATE TABLE IF NOT EXISTS outbound_outreach (
  id                 bigserial PRIMARY KEY,
  signal_id          bigint REFERENCES outbound_signal(id) ON DELETE CASCADE,
  account_id         bigint REFERENCES account(id) ON DELETE CASCADE,
  contact_id         bigint REFERENCES contact(id) ON DELETE SET NULL,
  deal_id            bigint REFERENCES deal(id) ON DELETE SET NULL,
  -- auto_email = smí odejít sám; review_email = e-mail až po schválení člověkem;
  -- manual = jen návrh pro člověka (telefon, osobně, LinkedIn), nic se neodesílá.
  channel            text NOT NULL,
  status             text NOT NULL DEFAULT 'draft',
  basis              text NOT NULL DEFAULT 'none',
  reason_codes       text[] NOT NULL DEFAULT '{}',
  template_key       text,
  subject            text,
  body               text,
  email_hash         text,
  outbox_source_ref  text,
  outbox_id          bigint,
  prague_day         date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  decided_by         uuid REFERENCES team_member(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_outreach_channel_check CHECK (channel IN ('auto_email', 'review_email', 'manual')),
  CONSTRAINT outbound_outreach_status_check
    CHECK (status IN ('draft', 'approved', 'queued', 'sent', 'skipped', 'rejected', 'done')),
  CONSTRAINT outbound_outreach_basis_check CHECK (basis IN ('existing_customer', 'consent', 'none')),
  -- Bez právního titulu (basis 'none') se e-mail nikdy nepošle: jen ruční návrh.
  CONSTRAINT outbound_outreach_basis_channel_check CHECK (basis <> 'none' OR channel = 'manual'),
  CONSTRAINT outbound_outreach_queue_check CHECK (status NOT IN ('queued', 'sent') OR channel <> 'manual'),
  CONSTRAINT outbound_outreach_ref_key UNIQUE (outbox_source_ref),
  CONSTRAINT outbound_outreach_text_len_check CHECK (
    (template_key IS NULL OR char_length(template_key) <= 64)
    AND (subject IS NULL OR char_length(subject) <= 200)
    AND (body IS NULL OR char_length(body) <= 8000)
    AND (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$')
    AND (outbox_source_ref IS NULL OR outbox_source_ref ~ '^outreach:[0-9]+$')
  )
);

CREATE INDEX IF NOT EXISTS outbound_outreach_status_idx ON outbound_outreach (status, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_outreach_day_idx ON outbound_outreach (prague_day) WHERE status IN ('queued', 'sent');
CREATE INDEX IF NOT EXISTS outbound_outreach_account_idx ON outbound_outreach (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_outreach_signal_idx ON outbound_outreach (signal_id);

COMMENT ON TABLE outbound_outreach IS
  'Oslovení k signálu (0107, P7). E-mail jen při basis existing_customer/consent; jinak návrh pro člověka. Odeslání jen přes agent_outbox.';

-- ===========================================================================
-- 4) Evidence souhlasu a odhlášení
-- ===========================================================================

CREATE TABLE IF NOT EXISTS outreach_consent (
  id               bigserial PRIMARY KEY,
  contact_id       bigint REFERENCES contact(id) ON DELETE CASCADE,
  email_hash       text NOT NULL,
  purpose          text NOT NULL DEFAULT 'outreach',
  -- Přesné znění souhlasu, jak ho člověk viděl, a jeho verze.
  wording          text NOT NULL,
  wording_version  text NOT NULL,
  granted_at       timestamptz NOT NULL,
  source           text NOT NULL,
  source_ref       text,
  withdrawn_at     timestamptz,
  recorded_by      uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_consent_source_check CHECK (source IN ('web_form', 'event', 'paper', 'email', 'other')),
  CONSTRAINT outreach_consent_purpose_check CHECK (purpose IN ('outreach')),
  CONSTRAINT outreach_consent_text_len_check CHECK (
    email_hash ~ '^[0-9a-f]{64}$'
    AND char_length(wording) BETWEEN 10 AND 4000
    AND char_length(wording_version) BETWEEN 1 AND 40
    AND (source_ref IS NULL OR char_length(source_ref) <= 200)
  )
);

CREATE INDEX IF NOT EXISTS outreach_consent_hash_idx ON outreach_consent (email_hash) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS outreach_suppression (
  id            bigserial PRIMARY KEY,
  email_hash    text NOT NULL,
  opted_out_at  timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL,
  outreach_id   bigint REFERENCES outbound_outreach(id) ON DELETE SET NULL,
  recorded_by   uuid REFERENCES team_member(id) ON DELETE SET NULL,
  CONSTRAINT outreach_suppression_hash_key UNIQUE (email_hash),
  CONSTRAINT outreach_suppression_hash_check CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outreach_suppression_source_check CHECK (source IN ('unsubscribe_link', 'reply', 'manual', 'complaint'))
);

COMMENT ON TABLE outreach_suppression IS
  'Odhlášení z obchodních sdělení (0107, P7). Jen otisk e-mailu — přežije výmaz kontaktu, aby se člověk znovu neoslovil.';

DROP TRIGGER IF EXISTS outbound_signal_set_updated_at ON outbound_signal;
CREATE TRIGGER outbound_signal_set_updated_at BEFORE UPDATE ON outbound_signal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS outbound_outreach_set_updated_at ON outbound_outreach;
CREATE TRIGGER outbound_outreach_set_updated_at BEFORE UPDATE ON outbound_outreach
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS outreach_consent_set_updated_at ON outreach_consent;
CREATE TRIGGER outreach_consent_set_updated_at BEFORE UPDATE ON outreach_consent
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Otisk e-mailu (stejný jako core/outbound/unsubscribe.ts#emailHash).
CREATE OR REPLACE FUNCTION outbound_email_hash(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_email IS NULL OR btrim(p_email) = '' THEN NULL
              ELSE encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex') END
$$;

-- ===========================================================================
-- 5) RLS: čte tým s obchodní rolí a AAL2, z klienta nikdo nezapisuje
-- ===========================================================================

ALTER TABLE outbound_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_outreach ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_suppression ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_signal_select ON outbound_signal;
CREATE POLICY outbound_signal_select ON outbound_signal FOR SELECT USING ((SELECT can_see_sales()));
DROP POLICY IF EXISTS outbound_outreach_select ON outbound_outreach;
CREATE POLICY outbound_outreach_select ON outbound_outreach FOR SELECT USING ((SELECT can_see_sales()));
DROP POLICY IF EXISTS outreach_consent_select ON outreach_consent;
CREATE POLICY outreach_consent_select ON outreach_consent FOR SELECT USING ((SELECT can_see_sales()));
DROP POLICY IF EXISTS outreach_suppression_select ON outreach_suppression;
CREATE POLICY outreach_suppression_select ON outreach_suppression FOR SELECT USING ((SELECT can_see_sales()));

DROP POLICY IF EXISTS require_aal2 ON outbound_signal;
CREATE POLICY require_aal2 ON outbound_signal
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');
DROP POLICY IF EXISTS require_aal2 ON outbound_outreach;
CREATE POLICY require_aal2 ON outbound_outreach
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');
DROP POLICY IF EXISTS require_aal2 ON outreach_consent;
CREATE POLICY require_aal2 ON outreach_consent
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');
DROP POLICY IF EXISTS require_aal2 ON outreach_suppression;
CREATE POLICY require_aal2 ON outreach_suppression
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON outbound_signal, outbound_outreach, outreach_consent, outreach_suppression FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON outbound_signal, outbound_outreach, outreach_consent, outreach_suppression FROM authenticated;

-- ===========================================================================
-- 6) Fronta agent_outbox: druh 'outreach' (aditivně, jen když fronta existuje)
-- ===========================================================================
-- Kontrakt (core/agents/outboxPort.ts) zná kind offer|info_request|follow_up.
-- P7 přidává 'outreach' a source_ref 'outreach:<outbound_outreach.id>'.
-- Tabulku zakládá P3 v 0104; když už je, rozšíří se CHECK na kind (pokud
-- se jmenuje agent_outbox_kind_check). Bez tabulky se nic neděje a úloha
-- outbound-agent nechá oslovení ve stavu 'approved' (RPC chybí → další běh).
DO $$
BEGIN
  IF to_regclass('public.agent_outbox') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_outbox_kind_check'
                  AND conrelid = to_regclass('public.agent_outbox')) THEN
    ALTER TABLE agent_outbox DROP CONSTRAINT agent_outbox_kind_check;
    ALTER TABLE agent_outbox ADD CONSTRAINT agent_outbox_kind_check
      CHECK (kind IN ('offer', 'info_request', 'follow_up', 'outreach'));
  END IF;
END $$;

-- ===========================================================================
-- 7) Audit (MUSÍ sedět s core/auditCoverage.outbound.ts) — jen stavy, data a klíče
-- ===========================================================================

DROP TRIGGER IF EXISTS audit_row_change_soft ON outbound_signal;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON outbound_signal
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,attempts,contact_id,deal_id,decided_at,decided_by,detected_at,kind,qualified_at,score,signal_date,source,status',
    '',
    '',
    '');

DROP TRIGGER IF EXISTS audit_row_change_soft ON outbound_outreach;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON outbound_outreach
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,basis,channel,contact_id,deal_id,decided_at,decided_by,outbox_id,prague_day,signal_id,status',
    '',
    '',
    '');

DROP TRIGGER IF EXISTS audit_row_change_soft ON outreach_consent;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON outreach_consent
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'contact_id,granted_at,recorded_by,withdrawn_at',
    '',
    '',
    '');

DROP TRIGGER IF EXISTS audit_row_change_soft ON outreach_suppression;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON outreach_suppression
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'opted_out_at,outreach_id,recorded_by',
    '',
    '',
    '');

-- ===========================================================================
-- 8) RPC úlohy (jen service_role)
-- ===========================================================================

CREATE OR REPLACE FUNCTION outbound_signal_upsert(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_ref text;
  v_id bigint;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'OS000: chybí data signálu' USING ERRCODE = 'check_violation';
  END IF;
  v_source := p ->> 'source';
  v_ref := btrim(p ->> 'external_ref');
  IF v_source IS NULL OR v_ref IS NULL OR v_ref = '' THEN
    RAISE EXCEPTION 'OS000: chybí zdroj nebo klíč signálu' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_id FROM outbound_signal WHERE source = v_source AND external_ref = v_ref;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('signal_id', v_id, 'duplicate', true);
  END IF;

  INSERT INTO outbound_signal (source, kind, external_ref, title, url, signal_date, ico, company_name, facts, account_id, contact_id)
  VALUES (
    v_source,
    p ->> 'kind',
    v_ref,
    left(btrim(p ->> 'title'), 300),
    nullif(btrim(p ->> 'url'), ''),
    (p ->> 'signal_date')::date,
    nullif(btrim(p ->> 'ico'), ''),
    nullif(left(btrim(p ->> 'company_name'), 200), ''),
    coalesce(p -> 'facts', '[]'::jsonb),
    (p ->> 'account_id')::bigint,
    (p ->> 'contact_id')::bigint
  )
  ON CONFLICT (source, external_ref) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM outbound_signal WHERE source = v_source AND external_ref = v_ref;
    RETURN jsonb_build_object('signal_id', v_id, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('signal_id', v_id, 'duplicate', false);
END;
$$;

-- Vnitřní založení leadu (sdílí úloha i Cockpit). Klientům nepřístupné.
-- Firma: podle account_id signálu, jinak podle IČO, jinak nová. Obchod:
-- fáze poptávky firemního pilíře, zdroj 'agent:outbound:<zdroj>'.
CREATE OR REPLACE FUNCTION outbound_create_lead_internal(p_signal_id bigint, p_actor uuid, p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s outbound_signal%ROWTYPE;
  v_account bigint;
  v_deal bigint;
  v_created boolean := false;
BEGIN
  SELECT * INTO s FROM outbound_signal WHERE id = p_signal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OS404: signál neexistuje' USING ERRCODE = 'no_data_found';
  END IF;
  IF s.status = 'blocked' THEN
    RAISE EXCEPTION 'OS409: signál je zablokovaný (vyloučená firma nebo nesouhlas s oslovením)' USING ERRCODE = 'check_violation';
  END IF;
  IF s.deal_id IS NOT NULL THEN
    RETURN jsonb_build_object('account_id', s.account_id, 'deal_id', s.deal_id, 'created_account', false, 'duplicate', true);
  END IF;

  v_account := s.account_id;
  IF v_account IS NULL AND s.ico IS NOT NULL THEN
    SELECT id INTO v_account FROM account WHERE ico = s.ico ORDER BY id LIMIT 1;
  END IF;
  IF v_account IS NULL THEN
    IF s.company_name IS NULL THEN
      RAISE EXCEPTION 'OS422: signál nemá firmu — lead založí člověk ručně' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO account (name, ico, owner_id) VALUES (s.company_name, s.ico, p_owner) RETURNING id INTO v_account;
    v_created := true;
  END IF;

  INSERT INTO deal (account_id, title, revenue_line, revenue_category, stage, pillar, phase, owner_id, source, note)
  VALUES (
    v_account,
    left('Agent: ' || s.title, 200),
    'catering_firemni', 'one_time', 'kvalifikace', 'b2b_akce', 'poptavka',
    p_owner,
    'agent:outbound:' || s.source,
    'Lead z outbound signálu #' || s.id || '. Zdroj a ověřená fakta jsou na stránce Signály.'
  )
  RETURNING id INTO v_deal;

  UPDATE outbound_signal
     SET status = 'converted', account_id = v_account, deal_id = v_deal,
         decided_at = now(), decided_by = p_actor
   WHERE id = s.id;

  RETURN jsonb_build_object('account_id', v_account, 'deal_id', v_deal, 'created_account', v_created, 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION outbound_lead_create(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p IS NULL OR (p ->> 'signal_id') IS NULL THEN
    RAISE EXCEPTION 'OS000: chybí signal_id' USING ERRCODE = 'check_violation';
  END IF;
  RETURN outbound_create_lead_internal((p ->> 'signal_id')::bigint, NULL, (p ->> 'owner_id')::uuid);
END;
$$;

-- Odhlášení z odkazu v e-mailu (nebo ruční zápis odpovědi „nepište mi").
-- Zapíše otisk do outreach_suppression a označí kontakty se stejnou adresou
-- jako „Nesouhlasí s oslovením" (0087). Idempotentní.
CREATE OR REPLACE FUNCTION outbound_unsubscribe(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hash text;
  v_source text;
  v_outreach bigint;
  v_n integer;
BEGIN
  v_hash := lower(p ->> 'email_hash');
  v_source := coalesce(p ->> 'source', 'unsubscribe_link');
  v_outreach := (p ->> 'outreach_id')::bigint;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'OU000: neplatný otisk adresy' USING ERRCODE = 'check_violation';
  END IF;
  IF v_outreach IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outbound_outreach WHERE id = v_outreach) THEN
    v_outreach := NULL;
  END IF;

  INSERT INTO outreach_suppression (email_hash, source, outreach_id, recorded_by)
  VALUES (v_hash, v_source, v_outreach, (p ->> 'recorded_by')::uuid)
  ON CONFLICT (email_hash) DO NOTHING;

  UPDATE outreach_consent SET withdrawn_at = now() WHERE email_hash = v_hash AND withdrawn_at IS NULL;

  UPDATE contact
     SET do_not_contact = true, do_not_contact_at = coalesce(do_not_contact_at, now()),
         do_not_contact_reason = coalesce(do_not_contact_reason, 'Odhlásil se z obchodních sdělení')
   WHERE outbound_email_hash(email) = v_hash AND do_not_contact IS DISTINCT FROM true;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE outbound_outreach SET status = 'skipped'
   WHERE email_hash = v_hash AND status IN ('draft', 'approved');

  RETURN jsonb_build_object('suppressed', true, 'contacts', v_n);
END;
$$;

-- ===========================================================================
-- 9) RPC Cockpitu: rozhodnutí CSO (tým s obchodní rolí)
-- ===========================================================================
-- p = {target: 'signal'|'outreach', id, action}
--   signal:   create_lead | dismiss | reopen
--   outreach: approve (koncept e-mailu → odešle úloha) | reject | done (ručně osloveno) | opt_out
CREATE OR REPLACE FUNCTION outbound_review(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_target text := p ->> 'target';
  v_action text := p ->> 'action';
  v_id bigint := (p ->> 'id')::bigint;
  o outbound_outreach%ROWTYPE;
  v_status text;
BEGIN
  IF v_actor IS NULL OR NOT is_team_member() OR NOT can_see_sales() THEN
    RAISE EXCEPTION 'OR401: jen obchodní role týmu' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'OR401: vyžaduje dvoufázové ověření' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_target = 'signal' THEN
    IF v_action = 'create_lead' THEN
      RETURN outbound_create_lead_internal(v_id, v_actor, v_actor);
    ELSIF v_action = 'dismiss' THEN
      UPDATE outbound_signal SET status = 'dismissed', decided_at = now(), decided_by = v_actor
       WHERE id = v_id AND status IN ('new', 'review', 'failed')
      RETURNING status INTO v_status;
    ELSIF v_action = 'reopen' THEN
      UPDATE outbound_signal SET status = 'review', decided_at = now(), decided_by = v_actor
       WHERE id = v_id AND status = 'dismissed'
      RETURNING status INTO v_status;
    ELSE
      RAISE EXCEPTION 'OR400: neznámá akce' USING ERRCODE = 'check_violation';
    END IF;
    RETURN jsonb_build_object('ok', v_status IS NOT NULL, 'status', v_status);
  ELSIF v_target = 'outreach' THEN
    SELECT * INTO o FROM outbound_outreach WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'status', NULL);
    END IF;
    IF v_action = 'approve' THEN
      -- Schválit k odeslání smí jen e-mail s právním titulem; ruční návrh ne.
      IF o.channel = 'manual' OR o.basis = 'none' OR o.status <> 'draft' THEN
        RETURN jsonb_build_object('ok', false, 'status', o.status);
      END IF;
      IF o.email_hash IS NOT NULL AND EXISTS (SELECT 1 FROM outreach_suppression WHERE email_hash = o.email_hash) THEN
        UPDATE outbound_outreach SET status = 'skipped', decided_at = now(), decided_by = v_actor WHERE id = o.id;
        RETURN jsonb_build_object('ok', false, 'status', 'skipped');
      END IF;
      v_status := 'approved';
    ELSIF v_action = 'reject' THEN
      IF o.status NOT IN ('draft', 'approved') THEN RETURN jsonb_build_object('ok', false, 'status', o.status); END IF;
      v_status := 'rejected';
    ELSIF v_action = 'done' THEN
      IF o.channel <> 'manual' OR o.status <> 'draft' THEN RETURN jsonb_build_object('ok', false, 'status', o.status); END IF;
      v_status := 'done';
    ELSIF v_action = 'opt_out' THEN
      IF o.email_hash IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', o.status); END IF;
      PERFORM outbound_unsubscribe(jsonb_build_object('email_hash', o.email_hash, 'source', 'reply',
        'outreach_id', o.id, 'recorded_by', v_actor));
      RETURN jsonb_build_object('ok', true, 'status', 'skipped');
    ELSE
      RAISE EXCEPTION 'OR400: neznámá akce' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE outbound_outreach SET status = v_status, decided_at = now(), decided_by = v_actor WHERE id = o.id;
    RETURN jsonb_build_object('ok', true, 'status', v_status);
  END IF;
  RAISE EXCEPTION 'OR400: neznámý cíl' USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION outbound_signal_upsert(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION outbound_create_lead_internal(bigint, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION outbound_lead_create(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION outbound_unsubscribe(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION outbound_review(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION outbound_review(jsonb) TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION outbound_signal_upsert(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION outbound_lead_create(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION outbound_unsubscribe(jsonb) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0107', 'outbound_agent: outbound_signal, outbound_outreach, outreach_consent, outreach_suppression, deal.source, RPC (service_role) a outbound_review (tym), RLS AAL2, mekky audit bez textu')
ON CONFLICT (version) DO NOTHING;
