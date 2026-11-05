-- 0005 — admin flag for USER-MANAGEMENT privileges, kept separate from the
-- data-access role. Every team member (role 'vedeni') sees all data; only an
-- admin may add/reset/deactivate participants. Gate admin Server Actions on
-- is_admin(), read from this DB row (never from JWT/user_metadata — those are
-- user-editable → privilege escalation).
--
-- NOTE: AAL2 (TOTP MFA) RLS enforcement is intentionally NOT here. It lands in a
-- later migration AFTER the MFA-enrollment flow ships and users have enrolled —
-- enforcing AAL2 before anyone has a TOTP factor would lock every user out of all
-- data (a not-yet-enrolled user only reaches AAL1).

ALTER TABLE team_member ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- První správce se nastaví ručně po založení prvního uživatele (service_role,
-- postup v docs/PROVOZ.md) — migrace žádný e-mail neobsahuje.

-- Helper for admin-only Server Actions and future admin RLS policies.
CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member WHERE id = auth.uid() AND is_admin = true
  );
$$;
