-- Enable RLS on every business + team table.
ALTER TABLE team_member          ENABLE ROW LEVEL SECURITY;
ALTER TABLE account              ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact              ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner              ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_partner         ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription         ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_card       ENABLE ROW LEVEL SECURITY;

-- team_member: a user can read all team rows (to show names), update only their own.
CREATE POLICY team_read   ON team_member FOR SELECT USING (is_team_member());
CREATE POLICY team_self   ON team_member FOR UPDATE USING (id = auth.uid());

-- Business tables: full access for any authenticated team member (role 'vedeni').
-- One policy per table, FOR ALL (select/insert/update/delete). When the future
-- 'obchodnik' role arrives, add scoped policies here without reshaping tables.
CREATE POLICY biz_all ON account              FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON contact              FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON partner              FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON partner_registration FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON deal                 FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON deal_partner         FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON subscription         FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON engagement           FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY biz_all ON reference_card        FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
