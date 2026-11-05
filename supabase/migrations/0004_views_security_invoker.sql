-- SECURITY: classic Postgres views run with the VIEW OWNER's privileges, which
-- bypasses RLS on the underlying tables. Left as-is, the anon key could read the
-- aggregated business/financial views straight from PostgREST. Setting
-- security_invoker makes each view execute as the querying role, so the RLS from
-- 0003_rls.sql applies through the view: authenticated team members see all,
-- anon sees nothing. (Postgres 15+, which Supabase runs.)
ALTER VIEW v_account_rollup      SET (security_invoker = on);
ALTER VIEW v_pipeline_by_line    SET (security_invoker = on);
ALTER VIEW v_mrr_health          SET (security_invoker = on);
ALTER VIEW v_delivery_health     SET (security_invoker = on);
ALTER VIEW v_reference_pipeline  SET (security_invoker = on);
ALTER VIEW v_partner_attribution SET (security_invoker = on);
