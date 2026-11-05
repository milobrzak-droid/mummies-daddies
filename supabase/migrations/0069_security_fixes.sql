-- 0069 — Bezpečnostní opravy po auditu (2026-09-28).
--
-- CO SE MĚNÍ
--
-- 1) team_member: konec self-eskalace. Politika team_self (0003) povolovala
--    UPDATE vlastního řádku BEZ omezení sloupců — člen s AAL2 si přes
--    PostgREST mohl nastavit role='vedeni' a is_admin=true, a tím obejít
--    can_see_sales() (0058), is_admin() i admin brány v TS. Aplikace
--    team_member uživatelskou session nikdy nezapisuje (lib/actions/team.ts
--    jde přes admin klienta, set_team_member_admin je SECURITY DEFINER).
--    → DROP team_self, REVOKE INSERT/UPDATE/DELETE pro anon a authenticated
--    a pojistkový BEFORE UPDATE trigger: změna id, email, role, is_admin,
--    manager_id nebo deactivated_at projde jen vlastníkovi tabulky
--    (SECURITY DEFINER RPC, migrace) nebo service_role.
--
-- 2) Deaktivace člena: nový sloupec team_member.deactivated_at (nastavuje
--    deactivateParticipant). is_team_member(), is_admin() a can_see_sales()
--    deaktivované ignorují → ještě platný JWT (do exp) okamžitě ztrácí
--    přístup přes RLS. Všechny tři funkce dostávají pevný search_path
--    public, pg_temp (jako 0035/0045).
--
-- 3) api_key.expires_at: OAuth tokeny (konektor claude.ai) dostávají
--    expiraci; validateApiKey ji vynucuje. Ručně vytvořené klíče mají NULL
--    (bez expirace, jako dosud).
--
-- 4) handle_new_user: team_member vzniká JEN pro pozvaného (invited_at)
--    nebo uživatele založeného adminem přes service role (app_metadata
--    cockpit_member = true — app_metadata uživatel sám měnit nemůže).
--    Samoregistrace (kdyby se v Supabase Auth omylem zapnul signup) už
--    neznamená členství v týmu.
--
-- 5) audit_event: řádky o deal/deal_partner/subscription (částky, COGS,
--    MRR) jen pro obchodní role — RESTRICTIVE audit_sales_only. Historie
--    na detailu obchodu (jen obchodní role) se nemění.
--
-- 6) account, partner, partner_registration, engagement, reference_card:
--    permisivní biz_all FOR ALL (0003) se dělí na SELECT/INSERT/UPDATE pro
--    tým a DELETE jen pro admina (vzor contact z 0058). Kaskáda smazání
--    účtu běží jako vlastník a obchází RLS (deal, subscription, kontakty) —
--    proto mazat smí jen admin. Aplikace tyto tabulky nemaže.
--    require_aal2 (0007) zůstává.
--
-- 7) mail_event: metadata Viktorovy schránky nečte nikdo s uživatelskou
--    session (cron i GDPR export jdou přes service role) → DROP
--    mail_event_read + REVOKE SELECT pro authenticated.
--
-- 8) mfa_failure: počítadlo neúspěšných TOTP ověření na uživatele
--    (lib/actions/mfa.ts). Jen service role — RLS bez politik + REVOKE.
--
-- ZÁVISLOSTI: 0002, 0005, 0017, 0020, 0026, 0028, 0041. Guard níže.
-- Idempotentní: IF NOT EXISTS, DROP … IF EXISTS + CREATE, CREATE OR REPLACE,
-- ON CONFLICT DO NOTHING.
--
-- PO NASAZENÍ ručně ověřit v produkci: SELECT id, email, role, is_admin
-- FROM team_member WHERE is_admin OR role::text IN ('vedeni','obchodnik');
-- — nečekané řádky vrátit a jejich api_key zneplatnit.

DO $$
BEGIN
  IF to_regclass('public.team_member') IS NULL
     OR to_regclass('public.api_key') IS NULL
     OR to_regclass('public.audit_event') IS NULL
     OR to_regclass('public.mail_event') IS NULL THEN
    RAISE EXCEPTION '0069 vyžaduje tabulky team_member, api_key, audit_event a mail_event — nejdřív aplikujte 0002, 0017, 0028 a 0041';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0069 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0069 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) deactivated_at (před funkcemi, které ho čtou)

ALTER TABLE team_member ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

-- ---------------------------------------------------------------------------
-- 1) team_member: žádný zápis s uživatelskou session

DROP POLICY IF EXISTS team_self ON team_member;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON team_member FROM anon, authenticated;

CREATE OR REPLACE FUNCTION team_member_guard_privileged()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- current_user je v SECURITY DEFINER funkci vlastník (postgres), u admin
  -- klienta service_role. Kdokoli jiný nesmí měnit oprávnění ani identitu.
  IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.is_admin IS DISTINCT FROM OLD.is_admin
     OR NEW.manager_id IS DISTINCT FROM OLD.manager_id
     OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at THEN
    RAISE EXCEPTION 'Změna oprávnění člena týmu je vyhrazená administraci' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION team_member_guard_privileged() FROM PUBLIC;

DROP TRIGGER IF EXISTS team_member_guard_privileged ON team_member;
CREATE TRIGGER team_member_guard_privileged
  BEFORE UPDATE ON team_member
  FOR EACH ROW EXECUTE FUNCTION team_member_guard_privileged();

-- ---------------------------------------------------------------------------
-- 2) Helpery ignorují deaktivované členy

CREATE OR REPLACE FUNCTION is_team_member() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member WHERE id = auth.uid() AND deactivated_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member
    WHERE id = auth.uid() AND is_admin = true AND deactivated_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION can_see_sales() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member
    WHERE id = auth.uid() AND role::text IN ('vedeni', 'obchodnik') AND deactivated_at IS NULL
  );
$$;

-- ---------------------------------------------------------------------------
-- 3) api_key.expires_at

ALTER TABLE api_key ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- ---------------------------------------------------------------------------
-- 4) handle_new_user: jen pozvaní / založení adminem

CREATE OR REPLACE FUNCTION handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.invited_at IS NULL
     AND coalesce(NEW.raw_app_meta_data ->> 'cockpit_member', '') <> 'true' THEN
    RETURN NEW;
  END IF;
  INSERT INTO team_member (id, full_name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.email
  );
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) audit_event: obchodní historie jen pro obchodní role

DROP POLICY IF EXISTS audit_sales_only ON audit_event;
CREATE POLICY audit_sales_only ON audit_event AS RESTRICTIVE FOR SELECT
  USING (entity_table NOT IN ('deal', 'deal_partner', 'subscription') OR (SELECT can_see_sales()));

-- ---------------------------------------------------------------------------
-- 6) biz_all → SELECT/INSERT/UPDATE pro tým, DELETE jen admin

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account', 'partner', 'partner_registration', 'engagement', 'reference_card'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '0069: tabulka % neexistuje, přeskakuji', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS biz_all ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_admin', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING ((SELECT is_team_member()))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK ((SELECT is_team_member()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING ((SELECT is_team_member())) WITH CHECK ((SELECT is_team_member()))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING ((SELECT is_team_member()) AND (SELECT is_admin()))', t || '_delete_admin', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 7) mail_event: jen service role

DROP POLICY IF EXISTS mail_event_read ON mail_event;
REVOKE SELECT ON mail_event FROM authenticated;

-- ---------------------------------------------------------------------------
-- 8) mfa_failure: neúspěšná TOTP ověření (jen service role)

CREATE TABLE IF NOT EXISTS mfa_failure (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id  uuid NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_failure_user_at_idx ON mfa_failure(user_id, at DESC);

ALTER TABLE mfa_failure ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mfa_failure FROM PUBLIC, anon, authenticated;
GRANT ALL ON mfa_failure TO service_role;

INSERT INTO schema_migration (version, note)
VALUES ('0069', 'team_member bez self-UPDATE + guard trigger, deactivated_at, api_key.expires_at, handle_new_user jen pozvaní, audit_event sales_only, biz_all DELETE jen admin, mail_event bez čtení, mfa_failure')
ON CONFLICT (version) DO NOTHING;
