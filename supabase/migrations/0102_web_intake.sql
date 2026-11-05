-- 0102 — web_intake: vstup veřejného webu do systému (kontrakt základového balíku).
--
-- PROČ: systém běží pod webem firmy. Nezávazná poptávka z webového formuláře
-- jde PŘÍMO k agentovi (balík P2) a objednávka cheesecaků PŘÍMO do Cockpitu.
-- Web (balík P6) zapisuje jen přes dvě RPC níže, a to servisním klíčem
-- z route handleru /api/web/** po ověření Turnstile a limitu. Klient
-- prohlížeče do tabulek nikdy nepíše ani je nečte.
--
--   web_inquiry  — poptávka ze strukturovaného formuláře (core/webInquiry.ts).
--                  Stav 'new' čeká na úlohu inquiry-agent (P2), která ji
--                  zpracuje stejnou cestou jako e-mail, jen bez modelu
--                  (evaluateStandardOffer). Sloupce rozhodnutí (decision_kind,
--                  reason_codes, account_id, contact_id, deal_id, quote_total,
--                  price_map_version, decided_at, attempts, error_code)
--                  vyplňuje P2 servisním klíčem.
--   shop_order   — objednávka cheesecaků (core/cheesecakeOrder.ts). Cenu
--                  spočítá server z ceníku firmy; tabulka ji jen uloží.
--                  Stav mění obsluha v Cockpitu (RPC dodá P6 v 0106).
--
-- RPC (EXECUTE jen service_role):
--   web_inquiry_submit(p jsonb) → {web_inquiry_id, duplicate}
--   shop_order_submit(p jsonb)  → {shop_order_id, duplicate}
--   Obě jsou idempotentní podle client_token (uuid z formuláře) a mají
--   pojistku proti zahlcení: nejvýš 5 odeslání z jedné adresy za 24 hodin
--   (chyba WI001 / SO001), nad to se nic nezapíše.
--
-- OSOBNÍ ÚDAJE: jméno, e-mail, telefon, zpráva a adresa jsou jen v těchto
-- tabulkách (RLS: čte jen tým s AAL2; poptávky jen obchodní role). Audit
-- (měkký trigger 0082) nese jen stavy, data a cizí klíče — nikdy text.
--
-- Rezervace dalších čísel pro paralelní balíky (zástupci jen s ledgerem):
--   0103 P2 inquiry_agent, 0104 P3 agent_outbox, 0105 P4 follow_up_cadence,
--   0106 P6 web (stav objednávky, další potřeby webu).

DO $$
BEGIN
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0102 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0102 vyžaduje can_see_sales() a is_team_member() — nejdřív aplikujte 0020 a 0082';
  END IF;
END $$;

-- ===========================================================================
-- 1) Poptávky z webu
-- ===========================================================================

CREATE TABLE IF NOT EXISTS web_inquiry (
  id                 bigserial PRIMARY KEY,
  client_token       uuid NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'new',
  segment            text,
  event_type         text,
  event_date         date,
  guests             integer,
  customer_name      text NOT NULL,
  email              text NOT NULL,
  phone              text,
  company_name       text,
  ico                text,
  marketing_consent  boolean NOT NULL DEFAULT false,
  source_page        text NOT NULL DEFAULT '/',
  -- Strukturovaná pole akce bez kontaktu (tvar webInquiryPayload().inquiry).
  inquiry            jsonb NOT NULL,
  -- Vyplňuje P2 (inquiry-agent).
  decision_kind      text,
  reason_codes       text[] NOT NULL DEFAULT '{}',
  account_id         bigint REFERENCES account(id) ON DELETE SET NULL,
  contact_id         bigint REFERENCES contact(id) ON DELETE SET NULL,
  deal_id            bigint REFERENCES deal(id) ON DELETE SET NULL,
  quote_total        numeric(14, 2),
  price_map_version  text,
  decided_at         timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  error_code         text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_inquiry_client_token_key UNIQUE (client_token),
  CONSTRAINT web_inquiry_status_check CHECK (status IN ('new', 'processing', 'decided', 'failed', 'spam')),
  CONSTRAINT web_inquiry_decision_check
    CHECK (decision_kind IS NULL OR decision_kind IN ('send_offer', 'ask_info', 'escalate', 'not_inquiry')),
  CONSTRAINT web_inquiry_guests_check CHECK (guests IS NULL OR guests BETWEEN 1 AND 100000),
  CONSTRAINT web_inquiry_text_len_check CHECK (
    char_length(customer_name) BETWEEN 1 AND 120
    AND char_length(email) BETWEEN 3 AND 254
    AND (phone IS NULL OR char_length(phone) <= 40)
    AND (company_name IS NULL OR char_length(company_name) <= 200)
    AND (ico IS NULL OR ico ~ '^[0-9]{8}$')
    AND char_length(source_page) <= 200
    AND (segment IS NULL OR char_length(segment) <= 40)
    AND (event_type IS NULL OR char_length(event_type) <= 40)
    AND (error_code IS NULL OR char_length(error_code) <= 64)
  ),
  CONSTRAINT web_inquiry_inquiry_check CHECK (jsonb_typeof(inquiry) = 'object' AND pg_column_size(inquiry) <= 16384)
);

CREATE INDEX IF NOT EXISTS web_inquiry_status_idx ON web_inquiry (status, received_at);
CREATE INDEX IF NOT EXISTS web_inquiry_email_idx ON web_inquiry (lower(email), received_at DESC);

COMMENT ON TABLE web_inquiry IS
  'Nezávazná poptávka z webového formuláře (0102). Zapisuje jen web_inquiry_submit (web, service_role); zpracuje úloha inquiry-agent (P2).';

-- ===========================================================================
-- 2) Objednávky cheesecaků
-- ===========================================================================

CREATE TABLE IF NOT EXISTS shop_order (
  id                 bigserial PRIMARY KEY,
  client_token       uuid NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'new',
  fulfilment_date    date NOT NULL,
  fulfilment         text NOT NULL,
  delivery_address   text,
  dedication         text,
  note               text,
  customer_name      text NOT NULL,
  email              text NOT NULL,
  phone              text NOT NULL,
  marketing_consent  boolean NOT NULL DEFAULT false,
  -- [{product_key, label, quantity, unit_price_czk, total_czk}] (shopOrderPayload).
  items              jsonb NOT NULL,
  delivery_czk       integer NOT NULL DEFAULT 0,
  total_czk          integer NOT NULL,
  account_id         bigint REFERENCES account(id) ON DELETE SET NULL,
  contact_id         bigint REFERENCES contact(id) ON DELETE SET NULL,
  status_changed_at  timestamptz,
  status_changed_by  uuid REFERENCES team_member(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_order_client_token_key UNIQUE (client_token),
  CONSTRAINT shop_order_status_check CHECK (status IN ('new', 'confirmed', 'ready', 'handed_over', 'cancelled')),
  CONSTRAINT shop_order_fulfilment_check CHECK (fulfilment IN ('pickup', 'delivery')),
  CONSTRAINT shop_order_delivery_address_check CHECK (fulfilment <> 'delivery' OR delivery_address IS NOT NULL),
  CONSTRAINT shop_order_items_check
    CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 20 AND pg_column_size(items) <= 16384),
  CONSTRAINT shop_order_amounts_check CHECK (delivery_czk >= 0 AND total_czk > 0 AND total_czk <= 1000000),
  CONSTRAINT shop_order_text_len_check CHECK (
    char_length(customer_name) BETWEEN 1 AND 120
    AND char_length(email) BETWEEN 3 AND 254
    AND char_length(phone) BETWEEN 6 AND 40
    AND (delivery_address IS NULL OR char_length(delivery_address) <= 300)
    AND (dedication IS NULL OR char_length(dedication) <= 80)
    AND (note IS NULL OR char_length(note) <= 1000)
  )
);

CREATE INDEX IF NOT EXISTS shop_order_status_idx ON shop_order (status, fulfilment_date);
CREATE INDEX IF NOT EXISTS shop_order_email_idx ON shop_order (lower(email), received_at DESC);

COMMENT ON TABLE shop_order IS
  'Objednávka cheesecaků z webu (0102). Zapisuje jen shop_order_submit (web, service_role); Cockpit ji zobrazí a obsluha mění stav.';

DROP TRIGGER IF EXISTS web_inquiry_set_updated_at ON web_inquiry;
CREATE TRIGGER web_inquiry_set_updated_at BEFORE UPDATE ON web_inquiry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS shop_order_set_updated_at ON shop_order;
CREATE TRIGGER shop_order_set_updated_at BEFORE UPDATE ON shop_order
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- 3) RLS: tým s AAL2 čte (poptávky jen obchodní role), z klienta nikdo nezapisuje
-- ===========================================================================

ALTER TABLE web_inquiry ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_order ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_inquiry_select ON web_inquiry;
CREATE POLICY web_inquiry_select ON web_inquiry FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS shop_order_select ON shop_order;
CREATE POLICY shop_order_select ON shop_order FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS require_aal2 ON web_inquiry;
CREATE POLICY require_aal2 ON web_inquiry
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS require_aal2 ON shop_order;
CREATE POLICY require_aal2 ON shop_order
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS sales_only ON web_inquiry;
CREATE POLICY sales_only ON web_inquiry
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

REVOKE ALL ON web_inquiry, shop_order FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON web_inquiry, shop_order FROM authenticated;

-- ===========================================================================
-- 4) Audit (MUSÍ sedět s core/auditCoverage.web.ts) — jen stavy, data a klíče
-- ===========================================================================

DROP TRIGGER IF EXISTS audit_row_change_soft ON web_inquiry;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON web_inquiry
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,attempts,contact_id,deal_id,decided_at,decision_kind,event_date,guests,marketing_consent,received_at,status',
    '',
    '',
    '');

DROP TRIGGER IF EXISTS audit_row_change_soft ON shop_order;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON shop_order
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,contact_id,delivery_czk,fulfilment,fulfilment_date,marketing_consent,received_at,status,status_changed_at,status_changed_by,total_czk',
    '',
    '',
    '');

-- ===========================================================================
-- 5) RPC pro web (jen service_role)
-- ===========================================================================

CREATE OR REPLACE FUNCTION web_inquiry_submit(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token uuid;
  v_email text;
  v_id bigint;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'WI000: chybí data poptávky' USING ERRCODE = 'check_violation';
  END IF;
  v_token := (p ->> 'client_token')::uuid;
  v_email := lower(btrim(p ->> 'email'));
  IF v_token IS NULL OR v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'WI000: chybí client_token nebo e-mail' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_id FROM web_inquiry WHERE client_token = v_token;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('web_inquiry_id', v_id, 'duplicate', true);
  END IF;

  IF (SELECT count(*) FROM web_inquiry
       WHERE lower(email) = v_email AND received_at > now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'WI001: příliš mnoho poptávek z jedné adresy' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO web_inquiry (
    client_token, segment, event_type, event_date, guests, customer_name, email, phone,
    company_name, ico, marketing_consent, source_page, inquiry
  ) VALUES (
    v_token,
    nullif(btrim(p ->> 'segment'), ''),
    nullif(btrim(p ->> 'event_type'), ''),
    (p ->> 'event_date')::date,
    (p ->> 'guests')::integer,
    btrim(p ->> 'customer_name'),
    v_email,
    nullif(btrim(p ->> 'phone'), ''),
    nullif(btrim(p ->> 'company_name'), ''),
    nullif(btrim(p ->> 'ico'), ''),
    coalesce((p ->> 'marketing_consent')::boolean, false),
    coalesce(nullif(btrim(p ->> 'source_page'), ''), '/'),
    coalesce(p -> 'inquiry', '{}'::jsonb)
  )
  ON CONFLICT (client_token) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM web_inquiry WHERE client_token = v_token;
    RETURN jsonb_build_object('web_inquiry_id', v_id, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('web_inquiry_id', v_id, 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION shop_order_submit(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token uuid;
  v_email text;
  v_id bigint;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'SO000: chybí data objednávky' USING ERRCODE = 'check_violation';
  END IF;
  v_token := (p ->> 'client_token')::uuid;
  v_email := lower(btrim(p ->> 'email'));
  IF v_token IS NULL OR v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'SO000: chybí client_token nebo e-mail' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_id FROM shop_order WHERE client_token = v_token;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('shop_order_id', v_id, 'duplicate', true);
  END IF;

  IF (SELECT count(*) FROM shop_order
       WHERE lower(email) = v_email AND received_at > now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'SO001: příliš mnoho objednávek z jedné adresy' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO shop_order (
    client_token, fulfilment_date, fulfilment, delivery_address, dedication, note,
    customer_name, email, phone, marketing_consent, items, delivery_czk, total_czk
  ) VALUES (
    v_token,
    (p ->> 'fulfilment_date')::date,
    p ->> 'fulfilment',
    nullif(btrim(p ->> 'delivery_address'), ''),
    nullif(btrim(p ->> 'dedication'), ''),
    nullif(btrim(p ->> 'note'), ''),
    btrim(p ->> 'customer_name'),
    v_email,
    btrim(p ->> 'phone'),
    coalesce((p ->> 'marketing_consent')::boolean, false),
    coalesce(p -> 'items', '[]'::jsonb),
    coalesce((p ->> 'delivery_czk')::integer, 0),
    (p ->> 'total_czk')::integer
  )
  ON CONFLICT (client_token) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM shop_order WHERE client_token = v_token;
    RETURN jsonb_build_object('shop_order_id', v_id, 'duplicate', true);
  END IF;
  RETURN jsonb_build_object('shop_order_id', v_id, 'duplicate', false);
END;
$$;

REVOKE ALL ON FUNCTION web_inquiry_submit(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION shop_order_submit(jsonb) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION web_inquiry_submit(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION shop_order_submit(jsonb) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0102', 'web_intake: web_inquiry + shop_order, RPC web_inquiry_submit a shop_order_submit (jen service_role), RLS AAL2, mekky audit bez textu')
ON CONFLICT (version) DO NOTHING;
