// Společné schéma pro testy triggerů auditu v PGlite (0064, 0082): zjednodušená
// kopie krytých tabulek (sloupce podle migrací 0001–0059), stuby
// auth.uid()/auth.jwt() jako v Supabase a role anon/authenticated/service_role.
// PGlite je devDependency (test/pglite-dependency.test.ts hlídá, že nechybí).
export const U_SALES = '11111111-1111-4111-8111-111111111111'
export const U_PM = '22222222-2222-4222-8222-222222222222'
export const U_API = '33333333-3333-4333-8333-333333333333'

export const AUDIT_SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE team_member (id uuid PRIMARY KEY, role text NOT NULL, full_name text);
INSERT INTO team_member VALUES ('${U_SALES}', 'obchodnik', 'S'), ('${U_PM}', 'projektak', 'P'), ('${U_API}', 'vedeni', 'A');
CREATE FUNCTION is_team_member() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid()) $$;
CREATE FUNCTION can_see_sales() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND role IN ('vedeni', 'obchodnik')) $$;

CREATE TABLE evidence (id bigserial PRIMARY KEY, source_kind text NOT NULL, source_id text NOT NULL, web_link text,
  captured_at timestamptz NOT NULL DEFAULT now(), created_by text);
CREATE TABLE audit_event (id bigserial PRIMARY KEY, actor_type text NOT NULL, actor_id text, action text NOT NULL,
  entity_table text NOT NULL, entity_id bigint NOT NULL, before jsonb, after jsonb, occurred_at timestamptz NOT NULL DEFAULT now(),
  evidence_id bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  info_state text CHECK (info_state IS NULL OR info_state IN ('source_fact','ai_suggestion','human_confirmed','actual_result')));
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_event_read ON audit_event FOR SELECT USING (is_team_member());
CREATE POLICY require_aal2 ON audit_event AS RESTRICTIVE FOR ALL USING ((SELECT auth.jwt() ->> 'aal') = 'aal2');

CREATE TYPE task_status AS ENUM ('todo','in_progress','blocked','done');
CREATE TYPE task_priority AS ENUM ('low','normal','high');
CREATE TYPE sales_activity_kind AS ENUM ('call','email','meeting','note','other');
CREATE TYPE sales_activity_outcome AS ENUM ('completed','no_answer','follow_up','cancelled','planned');
CREATE TYPE deal_stage AS ENUM ('kvalifikace','diagnostika','rozsah_nabidka','rozhodovani','vyhráno','prohráno','odloženo');

CREATE TABLE partner (id bigserial PRIMARY KEY, name text NOT NULL, kind text, created_at timestamptz NOT NULL DEFAULT now(),
  is_referrer boolean NOT NULL DEFAULT false, roles text[] NOT NULL DEFAULT '{}', via_partner_id bigint REFERENCES partner(id));
CREATE TABLE partner_registration (id bigserial PRIMARY KEY, partner_id bigint NOT NULL REFERENCES partner(id) ON DELETE CASCADE,
  program text NOT NULL, status text NOT NULL DEFAULT 'none', tier_note text, margin_pct numeric(5,2), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE account (id bigserial PRIMARY KEY, name text NOT NULL, raynet_id integer, industry text, size_band text,
  is_reference boolean NOT NULL DEFAULT false, ms_licenses integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  referred_by_partner_id bigint, region text, web text, ico text, owner_id uuid, client_since date, notes text,
  nace text[], legal_form text, founded_on date, profile text, last_inbound_at timestamptz, last_outbound_at timestamptz, nudged_on date, snooze_until date);
CREATE TABLE contact (id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE, full_name text NOT NULL, role text, email text,
  is_champion boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), partner_id bigint, phone text, notes text);
CREATE TABLE deal (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, title text NOT NULL,
  revenue_line text NOT NULL DEFAULT 'oslava_soukroma', revenue_category text NOT NULL DEFAULT 'one_time', stage deal_stage NOT NULL DEFAULT 'kvalifikace',
  probability_pct integer, amount_one_time numeric(14,2) DEFAULT 0, cogs_one_time numeric(14,2) DEFAULT 0, expected_mrr numeric(12,2) DEFAULT 0,
  subsidy_program text NOT NULL DEFAULT 'none', subsidy_pct numeric(5,2) DEFAULT 0, sourced_by_partner bigint, expected_close date, won_at date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  note text, status_done text, status_next text, status_blocker text, dev_team text[] NOT NULL DEFAULT '{}', estimate_md integer, delivery_lane text,
  pillar text, phase text, delivery_team text, source_pdf_path text, currency text NOT NULL DEFAULT 'CZK', amount_one_time_original numeric(14,2), fx_rate numeric(10,4),
  owner_id uuid, primary_contact_id bigint, next_step text, next_step_due date, lost_reason text, closed_at date, last_activity_at timestamptz,
  forecast_category text NOT NULL DEFAULT 'pipeline', follow_up_nudged_on date, follow_up_escalated_on date, no_next_step_reason text,
  deal_kind text, problem text, expected_outcome text, decision_maker text, decision_process text, decision_due date, value_basis text);
ALTER TABLE deal ADD COLUMN client_paid_one_time numeric(14,2) GENERATED ALWAYS AS (amount_one_time * (1 - COALESCE(subsidy_pct,0)/100)) STORED;
CREATE TABLE subscription (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, deal_id bigint, product text NOT NULL,
  seats integer NOT NULL DEFAULT 0, mrr numeric(12,2) NOT NULL DEFAULT 0, started_on date, renewal_date date, churn_risk text NOT NULL DEFAULT 'low',
  health_score integer, is_ms_subsidized boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), ended_on date);
CREATE TABLE engagement (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, deal_id bigint, kind text NOT NULL,
  phase text NOT NULL DEFAULT 'sm_diagnostika', started_on date, due_on date, baseline_adoption_pct numeric(5,2), baseline_captured_on date, copilot_licenses integer,
  post_adoption_pct numeric(5,2), trained_count integer, time_saved_min_week integer, workshops_delivered integer, nnpsa integer, roi_czk_year numeric(14,2),
  post_captured_on date, reference_worthy boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  gate_outputs_captured boolean, gate_ratios_respected boolean, gate_peer_learning boolean, gate_safety_followed boolean, gate_next_steps_owned boolean,
  gate_pack_delivered boolean, deliverable_pack_url text, follow_up_checkpoint_on date, goal text, scope text, client_sponsor_contact_id bigint,
  financial_frame text, risks text[], handoff_completed_at timestamptz, handoff_by uuid);
ALTER TABLE engagement ADD COLUMN adoption_delta_pp numeric(6,2) GENERATED ALWAYS AS (post_adoption_pct - baseline_adoption_pct) STORED;
CREATE TABLE reference_card (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id), engagement_id bigint, headline text,
  approved_public boolean NOT NULL DEFAULT false, used_in_deals integer NOT NULL DEFAULT 0, is_ms_anchor boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE task (id bigserial PRIMARY KEY, title text NOT NULL, description text, status task_status NOT NULL DEFAULT 'todo', priority task_priority NOT NULL DEFAULT 'normal',
  assignee_id uuid, created_by uuid, due_on date, account_id bigint, deal_id bigint, engagement_id bigint, ms_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sales_activity (id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE, deal_id bigint, contact_id bigint,
  kind sales_activity_kind NOT NULL, outcome sales_activity_outcome NOT NULL DEFAULT 'completed', subject text NOT NULL, body text,
  occurred_at timestamptz NOT NULL DEFAULT now(), follow_up_on date, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  partner_id bigint, source text, external_id text, ms_event_id text);
CREATE TABLE company_alias (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, alias_domain text, alias_name text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE relationship (id bigserial PRIMARY KEY, parent_account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  child_account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, relationship_type text NOT NULL DEFAULT 'subsidiary', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE work_case (id bigserial PRIMARY KEY, title text NOT NULL, node text NOT NULL, lead_owner_id uuid, deputy_id uuid, status text NOT NULL DEFAULT 'open',
  account_id bigint, deal_id bigint, created_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE case_step (id bigserial PRIMARY KEY, case_id bigint NOT NULL REFERENCES work_case(id) ON DELETE CASCADE, position integer NOT NULL DEFAULT 0,
  title text NOT NULL, status text NOT NULL DEFAULT 'todo', due_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE decision (id bigserial PRIMARY KEY, case_id bigint NOT NULL REFERENCES work_case(id), question text NOT NULL, options jsonb NOT NULL DEFAULT '[]',
  chosen text, decided_by text, decided_at timestamptz, evidence_id bigint REFERENCES evidence(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE approval_request (id bigserial PRIMARY KEY, case_id bigint REFERENCES work_case(id), action_kind text NOT NULL, requested_level text NOT NULL,
  status text NOT NULL DEFAULT 'pending', requested_by text NOT NULL, decided_by text, decided_at timestamptz, expires_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(), node text);
CREATE TABLE authority_policy (id bigserial PRIMARY KEY, action_kind text NOT NULL, level text NOT NULL, active boolean NOT NULL DEFAULT true, note text,
  updated_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE engagement_milestone (id bigserial PRIMARY KEY, engagement_id bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE, title text NOT NULL,
  owner_id uuid, deputy_id uuid, status text NOT NULL DEFAULT 'pripraveno', due_on date, accepted_at timestamptz, accepted_by_contact_id bigint,
  acceptance_evidence_id bigint REFERENCES evidence(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE target_list (id bigserial PRIMARY KEY, name text NOT NULL, segment text NOT NULL, rationale text NOT NULL, value_hypothesis text,
  owner_id uuid, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE target_list_item (id bigserial PRIMARY KEY, list_id bigint NOT NULL REFERENCES target_list(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, reason text NOT NULL, contact_id bigint, next_step text, next_step_due date,
  status text NOT NULL DEFAULT 'navrzeno', created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE engagement_document (id bigserial PRIMARY KEY, engagement_id bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE, milestone_id bigint,
  title text NOT NULL, url text NOT NULL, kind text NOT NULL DEFAULT 'jine', created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER task_set_updated_at BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role, anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role, anon;
`
