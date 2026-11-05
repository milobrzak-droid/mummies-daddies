-- 0106 — web: potřeby veřejného webu nad vstupem z 0102 (balík P6).
--
-- PROČ: web (app/(web)/…) posílá poptávku a objednávku cheesecaků přes
-- route handlery /api/web/** do RPC z 0102. Tahle migrace doplňuje, co web
-- a Cockpit potřebují navíc:
--
--   1) Záznam souhlasu: verze informačního textu, který zákazník u formuláře
--      potvrdil (consent_version), a znění marketingového souhlasu, pokud ho
--      dal (marketing_consent_text). Čas = received_at, zdroj = source_page.
--   2) Objednávka: způsob platby, pásmo doručení, fakturační údaje firmy
--      (nepovinné) a zdroj.
--   3) web_inquiry_submit a shop_order_submit znovu (CREATE OR REPLACE) —
--      stejné chování jako 0102, navíc ukládají pole z bodů 1 a 2.
--   4) shop_order_set_status — změna stavu objednávky z Cockpitu (člen týmu
--      s AAL2, povolené přechody, kdo a kdy).
--   5) web_intake_retention — výmaz a anonymizace starých záznamů (GDPR):
--      spam po 30 dnech pryč, vyřízené poptávky po 12 měsících a předané
--      či zrušené objednávky po 24 měsících bez osobních údajů.
--
-- OSOBNÍ ÚDAJE zůstávají jen v těchto tabulkách; audit (měkký trigger 0102)
-- nové sloupce nenese. Do logů ani chyb nejde nic z obsahu formuláře.

DO $$
BEGIN
  IF to_regclass('public.web_inquiry') IS NULL OR to_regclass('public.shop_order') IS NULL THEN
    RAISE EXCEPTION '0106 vyžaduje web_inquiry a shop_order — nejdřív aplikujte 0102_web_intake.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) + 2) Nové sloupce
-- ===========================================================================

ALTER TABLE web_inquiry
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS marketing_consent_text text,
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

ALTER TABLE shop_order
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS delivery_zone text,
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS ico text,
  ADD COLUMN IF NOT EXISTS dic text,
  ADD COLUMN IF NOT EXISTS source_page text NOT NULL DEFAULT '/kosik',
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS marketing_consent_text text,
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

ALTER TABLE web_inquiry DROP CONSTRAINT IF EXISTS web_inquiry_consent_check;
ALTER TABLE web_inquiry ADD CONSTRAINT web_inquiry_consent_check CHECK (
  (consent_version IS NULL OR char_length(consent_version) <= 40)
  AND (marketing_consent_text IS NULL OR char_length(marketing_consent_text) <= 1000)
  AND (marketing_consent OR marketing_consent_text IS NULL)
);

ALTER TABLE shop_order DROP CONSTRAINT IF EXISTS shop_order_web_fields_check;
ALTER TABLE shop_order ADD CONSTRAINT shop_order_web_fields_check CHECK (
  (payment_method IS NULL OR payment_method IN ('karta', 'prevod'))
  AND (delivery_zone IS NULL OR (fulfilment = 'delivery' AND delivery_zone ~ '^[a-z0-9-]{1,40}$'))
  AND (company_name IS NULL OR char_length(company_name) <= 200)
  AND (ico IS NULL OR ico ~ '^[0-9]{8}$')
  AND (dic IS NULL OR dic ~ '^[A-Z]{2}[0-9]{8,10}$')
  AND char_length(source_page) <= 200
  AND (consent_version IS NULL OR char_length(consent_version) <= 40)
  AND (marketing_consent_text IS NULL OR char_length(marketing_consent_text) <= 1000)
  AND (marketing_consent OR marketing_consent_text IS NULL)
);

-- Seznam objednávek v Cockpitu řadí podle data předání.
CREATE INDEX IF NOT EXISTS shop_order_fulfilment_idx ON shop_order (fulfilment_date, id);

-- ===========================================================================
-- 3) RPC pro web (jen service_role) — 0102 + nová pole
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
  v_marketing boolean;
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
  v_marketing := coalesce((p ->> 'marketing_consent')::boolean, false);

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
    company_name, ico, marketing_consent, source_page, inquiry,
    consent_version, marketing_consent_text
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
    v_marketing,
    coalesce(nullif(btrim(p ->> 'source_page'), ''), '/'),
    coalesce(p -> 'inquiry', '{}'::jsonb),
    nullif(btrim(p ->> 'consent_version'), ''),
    CASE WHEN v_marketing THEN nullif(btrim(p ->> 'marketing_consent_text'), '') END
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
  v_marketing boolean;
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
  v_marketing := coalesce((p ->> 'marketing_consent')::boolean, false);

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
    customer_name, email, phone, marketing_consent, items, delivery_czk, total_czk,
    payment_method, delivery_zone, company_name, ico, dic, source_page, consent_version, marketing_consent_text
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
    v_marketing,
    coalesce(p -> 'items', '[]'::jsonb),
    coalesce((p ->> 'delivery_czk')::integer, 0),
    (p ->> 'total_czk')::integer,
    nullif(btrim(p ->> 'payment_method'), ''),
    nullif(btrim(p ->> 'delivery_zone'), ''),
    nullif(btrim(p ->> 'company_name'), ''),
    nullif(btrim(p ->> 'ico'), ''),
    nullif(upper(btrim(p ->> 'dic')), ''),
    coalesce(nullif(btrim(p ->> 'source_page'), ''), '/kosik'),
    nullif(btrim(p ->> 'consent_version'), ''),
    CASE WHEN v_marketing THEN nullif(btrim(p ->> 'marketing_consent_text'), '') END
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

-- ===========================================================================
-- 4) Změna stavu objednávky z Cockpitu
-- ===========================================================================
--
-- Přechody (domain/web/shopOrders.ts#SHOP_ORDER_TRANSITIONS musí sedět):
--   new       → confirmed | cancelled
--   confirmed → ready | cancelled | new        (vrácení omylem potvrzené)
--   ready     → handed_over | cancelled | confirmed
--   cancelled → new                            (obnovení zrušené)
--   handed_over je konečný stav.
-- p_expected_status chrání před souběhem dvou lidí (kdo změnil dřív, vyhrál).
-- Chyby: SO010 není člen týmu, SO011 chybí MFA (AAL2), SO012 objednávka
-- neexistuje, SO013 stav se mezitím změnil, SO014 nepovolený přechod.

CREATE OR REPLACE FUNCTION shop_order_set_status(p_order_id bigint, p_status text, p_expected_status text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current text;
BEGIN
  IF NOT (SELECT is_team_member()) THEN
    RAISE EXCEPTION 'SO010: změnit stav objednávky smí jen člen týmu' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce((SELECT auth.jwt() ->> 'aal'), '') <> 'aal2' THEN
    RAISE EXCEPTION 'SO011: změna stavu vyžaduje ověření dvěma faktory' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT status INTO v_current FROM shop_order WHERE id = p_order_id FOR UPDATE;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'SO012: objednávka neexistuje' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_expected_status IS NOT NULL AND p_expected_status <> v_current THEN
    RAISE EXCEPTION 'SO013: stav objednávky se mezitím změnil' USING ERRCODE = 'serialization_failure';
  END IF;
  IF p_status = v_current THEN
    RETURN jsonb_build_object('shop_order_id', p_order_id, 'status', v_current, 'previous_status', v_current, 'changed', false);
  END IF;
  IF NOT (
       (v_current = 'new' AND p_status IN ('confirmed', 'cancelled'))
    OR (v_current = 'confirmed' AND p_status IN ('ready', 'cancelled', 'new'))
    OR (v_current = 'ready' AND p_status IN ('handed_over', 'cancelled', 'confirmed'))
    OR (v_current = 'cancelled' AND p_status = 'new')
  ) THEN
    RAISE EXCEPTION 'SO014: tento přechod stavu není povolený' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE shop_order
     SET status = p_status, status_changed_at = now(), status_changed_by = auth.uid()
   WHERE id = p_order_id;
  RETURN jsonb_build_object('shop_order_id', p_order_id, 'status', p_status, 'previous_status', v_current, 'changed', true);
END;
$$;

REVOKE ALL ON FUNCTION shop_order_set_status(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_order_set_status(bigint, text, text) TO authenticated;

-- ===========================================================================
-- 5) Retence (GDPR): výmaz spamu a anonymizace starých záznamů
-- ===========================================================================
--
-- Volá ji servisní úloha (jen service_role). Lhůty:
--   web_inquiry 'spam'                        → smazat po 30 dnech
--   web_inquiry 'decided' | 'failed'          → anonymizovat po 12 měsících
--                                               (údaje vyřízené poptávky žijí
--                                               dál v CRM u obchodu)
--   shop_order 'handed_over' | 'cancelled'    → anonymizovat 24 měsíců po předání
-- Anonymizace zachová stavy, data a částky (přehledy), osobní údaje a texty
-- přepíše. Vrací jen počty.

CREATE OR REPLACE FUNCTION web_intake_retention(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_spam integer;
  v_inquiries integer;
  v_orders integer;
BEGIN
  DELETE FROM web_inquiry
   WHERE status = 'spam' AND received_at < p_now - interval '30 days';
  GET DIAGNOSTICS v_spam = ROW_COUNT;

  UPDATE web_inquiry
     SET customer_name = 'Anonymizováno',
         email = 'anonymizovano@invalid',
         phone = NULL,
         company_name = NULL,
         ico = NULL,
         marketing_consent_text = NULL,
         inquiry = inquiry - 'venue' - 'special_requests' - 'web_details',
         anonymized_at = p_now
   WHERE anonymized_at IS NULL
     AND status IN ('decided', 'failed')
     AND received_at < p_now - interval '12 months';
  GET DIAGNOSTICS v_inquiries = ROW_COUNT;

  UPDATE shop_order
     SET customer_name = 'Anonymizováno',
         email = 'anonymizovano@invalid',
         phone = 'smazáno',
         delivery_address = CASE WHEN fulfilment = 'delivery' THEN 'smazáno' END,
         dedication = NULL,
         note = NULL,
         company_name = NULL,
         ico = NULL,
         dic = NULL,
         marketing_consent_text = NULL,
         items = (SELECT jsonb_agg(i - 'inscription' - 'mini_flavors') FROM jsonb_array_elements(items) AS i),
         anonymized_at = p_now
   WHERE anonymized_at IS NULL
     AND status IN ('handed_over', 'cancelled')
     AND fulfilment_date < (p_now - interval '24 months')::date;
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  RETURN jsonb_build_object('spam_deleted', v_spam, 'inquiries_anonymized', v_inquiries, 'orders_anonymized', v_orders);
END;
$$;

REVOKE ALL ON FUNCTION web_intake_retention(timestamptz) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION web_inquiry_submit(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION shop_order_submit(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION web_intake_retention(timestamptz) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0106', 'web: zaznam souhlasu, platba a firma u objednavky, shop_order_set_status (tym AAL2), retence web_inquiry a shop_order')
ON CONFLICT (version) DO NOTHING;
