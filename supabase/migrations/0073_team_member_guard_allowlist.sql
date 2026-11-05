-- 0073 — zpevnění pojistky z 0069 na team_member: místo výčtu zakázaných
-- sloupců výčet povolených (jen full_name) + kontrola, že klientské role po
-- REVOKE opravdu nemají UPDATE.
--
-- KONTEXT: 0069 zavřela self-eskalaci (DROP team_self, REVOKE zápisu pro
-- anon/authenticated, BEFORE UPDATE trigger team_member_guard_privileged).
-- Uživatelská session do team_member nezapisuje vůbec — i vlastní jméno
-- (updateMyDisplayName) jde od a581eea přes admin klienta. Zbyly dvě mezery,
-- které se projeví, jen kdyby někdo UPDATE klientům vrátil (ručně v produkci
-- nebo budoucí migrací):
--   a) Trigger v 0069 hlídá pevný seznam sloupců (id, email, role, is_admin,
--      manager_id, deactivated_at). weekly_capacity_hours z 0062 v něm není
--      a každý další sloupec s oprávněním nebo kapacitou by musel někdo
--      ručně připsat.
--   b) Nic neověří, že REVOKE opravdu zabral — UPDATE zděděný přes jinou roli
--      nebo sloupcový grant na jinou roli by prošel bez povšimnutí.
--
-- CO SE MĚNÍ
--
-- 1) team_member_guard_privileged (CREATE OR REPLACE, stejný název i trigger
--    jako v 0069): vyjmuté role zůstávají stejné (postgres = vlastník
--    SECURITY DEFINER funkcí jako set_team_member_admin z 0045
--    a set_weekly_capacity z 0062, supabase_admin, service_role = admin
--    klient). Pro KOHOKOLI jiného se porovná celý řádek jako jsonb bez
--    full_name — změnit smí nejvýš full_name, cokoli jiného (včetně
--    budoucích sloupců) skončí SQLSTATE 42501. Funkce je záměrně SECURITY
--    INVOKER: current_user pak odpovídá volajícímu.
--
-- 2) REVOKE rozšířený o PUBLIC a práva REFERENCES a TRIGGER (0069 odebrala
--    INSERT/UPDATE/DELETE/TRUNCATE jen anon a authenticated). SELECT zůstává.
--
-- 3) Kontrola na konci: když anon nebo authenticated po REVOKE pořád mají
--    UPDATE na tabulku nebo na kterýkoli sloupec (zděděné přes jinou roli,
--    ručně nastavené v produkci), migrace skončí chybou a transakce se vrátí.
--    Správce pak granty zkontroluje (\dp team_member) a odebere.
--
-- ZÁVISLOSTI: 0069 (trigger team_member_guard_privileged, sloupec
-- deactivated_at), 0026 (schema_migration). Idempotentní: CREATE OR
-- REPLACE, DROP TRIGGER IF EXISTS, REVOKE, ON CONFLICT DO NOTHING.

DO $$
BEGIN
  IF to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0073 vyžaduje tabulku public.team_member — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.team_member_guard_privileged()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'team_member' AND column_name = 'deactivated_at') THEN
    RAISE EXCEPTION '0073 vyžaduje trigger team_member_guard_privileged a sloupec team_member.deactivated_at — nejdřív aplikujte 0069_security_fixes.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0073 vyžaduje tabulku public.schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- 1) Pojistka: mimo vyjmuté role se smí změnit nejvýš full_name.
CREATE OR REPLACE FUNCTION team_member_guard_privileged()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- current_user je v SECURITY DEFINER funkci vlastník (postgres), u admin
  -- klienta service_role. Kdokoli jiný smí změnit jen full_name.
  IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'full_name') IS DISTINCT FROM (to_jsonb(OLD) - 'full_name') THEN
    RAISE EXCEPTION 'Změna oprávnění člena týmu je vyhrazená administraci' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION team_member_guard_privileged() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_member_guard_privileged ON team_member;
CREATE TRIGGER team_member_guard_privileged
  BEFORE UPDATE ON team_member
  FOR EACH ROW EXECUTE FUNCTION team_member_guard_privileged();

-- 2) Klientské role (a PUBLIC) do team_member nezapisují vůbec.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON team_member FROM PUBLIC, anon, authenticated;

-- 3) Ověření: klientské role nemají UPDATE ani na tabulku, ani na sloupec.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND (has_table_privilege(r, 'public.team_member', 'UPDATE')
            OR has_any_column_privilege(r, 'public.team_member', 'UPDATE')) THEN
      RAISE EXCEPTION '0073: role % má po REVOKE pořád UPDATE na team_member — zkontrolujte ruční granty (\dp team_member)', r;
    END IF;
  END LOOP;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0073', 'team_member guard: allowlist jen full_name (misto vyctu sloupcu), REVOKE i PUBLIC/REFERENCES/TRIGGER, kontrola zbylych UPDATE grantu')
ON CONFLICT (version) DO NOTHING;
