-- ============================================================================
-- DO NOT APPLY YET.
--
-- This migration enforces AAL2 (TOTP MFA) at the database (RLS) level. Apply
-- it ONLY once BOTH of the following are true:
--   1. Every team_member has enrolled a TOTP factor (verify via
--      auth.mfa_factors / the app's enrollment status — nobody is left on
--      password-only auth).
--   2. MFA_ENFORCED=true has been live for a while so enrollment is actually
--      required and verified, not just optional in the UI.
--
-- Applying this BEFORE every user has enrolled will lock out anyone whose
-- session is still at aal1 (i.e. has not completed TOTP) from ALL business
-- data — they will authenticate fine but every SELECT/INSERT/UPDATE/DELETE
-- on these tables will be denied. There is no "soft" mode: RESTRICTIVE
-- policies are ANDed with the existing permissive is_team_member() policies,
-- so once this is live, aal2 is a hard requirement to touch this data.
--
-- This file is written now so it's ready to run later; it is NOT run by this
-- change and is not wired into any migration runner invocation.
-- ============================================================================

-- Why RESTRICTIVE: existing per-table policies (biz_all / task_all, see
-- 0003_rls.sql and 0006_tasks_and_calendar.sql) are PERMISSIVE and grant
-- access to any is_team_member(). Postgres ORs permissive policies together
-- and ANDs the result with all restrictive policies. Adding a RESTRICTIVE
-- require_aal2 policy alongside the existing permissive one means a row is
-- only reachable when BOTH "is a team member" AND "session is aal2" hold,
-- without touching/duplicating the existing business logic in those policies.
--
-- (select auth.jwt()->>'aal') is wrapped in a scalar subquery per Supabase's
-- performance guidance so Postgres can evaluate/cache it once per statement
-- instead of once per row.

CREATE POLICY require_aal2 ON account AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON contact AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON partner AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON partner_registration AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON deal AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON deal_partner AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON subscription AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON engagement AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON reference_card AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

CREATE POLICY require_aal2 ON task AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2')
  WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');

-- Deliberately NOT applied to team_member or calendar_token:
--   - team_member must stay reachable at aal1 so a freshly password-only
--     user can load the app shell (nav, "who am I", the MFA-enrollment
--     screen itself) before they've had a chance to enroll/step up.
--   - calendar_token is already locked to a single row via caltoken_self
--     (member_id = auth.uid()); the Microsoft Graph connect/refresh flow
--     needs to work pre-AAL2 too, and it carries no business data.
-- If tighter enforcement is ever wanted on these, add it as its own
-- follow-up migration after confirming it doesn't break the enroll flow.
