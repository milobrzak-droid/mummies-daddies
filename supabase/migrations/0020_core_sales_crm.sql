-- 0020 — Core sales CRM.
-- Keeps the existing delivery/project model, but adds the sales ownership,
-- follow-up and activity trail needed by an internal sales team.

ALTER TYPE team_role ADD VALUE IF NOT EXISTS 'obchodnik';

CREATE OR REPLACE FUNCTION can_see_sales() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_member
    WHERE id = auth.uid() AND role::text IN ('vedeni', 'obchodnik')
  );
$$;

ALTER TABLE contact
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE deal
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_contact_id bigint REFERENCES contact(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_step text,
  ADD COLUMN IF NOT EXISTS next_step_due date,
  ADD COLUMN IF NOT EXISTS lost_reason text,
  ADD COLUMN IF NOT EXISTS closed_at date,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz,
  ADD COLUMN IF NOT EXISTS forecast_category text NOT NULL DEFAULT 'pipeline'
    CHECK (forecast_category IN ('pipeline', 'best_case', 'commit', 'closed'));

-- Existing projects inherit the client owner so they immediately appear in
-- the correct salesperson's pipeline after the migration.
UPDATE deal d
SET owner_id = a.owner_id
FROM account a
WHERE d.account_id = a.id
  AND d.owner_id IS NULL
  AND a.owner_id IS NOT NULL;

UPDATE deal
SET closed_at = COALESCE(won_at, updated_at::date), forecast_category = 'closed'
WHERE stage IN ('vyhráno', 'prohráno') AND closed_at IS NULL;

CREATE INDEX IF NOT EXISTS deal_owner_id_idx ON deal(owner_id);
CREATE INDEX IF NOT EXISTS deal_stage_idx ON deal(stage);
CREATE INDEX IF NOT EXISTS deal_expected_close_idx ON deal(expected_close);
CREATE INDEX IF NOT EXISTS deal_next_step_due_idx ON deal(next_step_due);

CREATE TYPE sales_activity_kind AS ENUM ('call', 'email', 'meeting', 'note', 'other');
CREATE TYPE sales_activity_outcome AS ENUM ('completed', 'no_answer', 'follow_up', 'cancelled');

CREATE TABLE sales_activity (
  id            bigserial PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  deal_id       bigint REFERENCES deal(id) ON DELETE SET NULL,
  contact_id    bigint REFERENCES contact(id) ON DELETE SET NULL,
  kind          sales_activity_kind NOT NULL,
  outcome       sales_activity_outcome NOT NULL DEFAULT 'completed',
  subject       text NOT NULL,
  body          text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  follow_up_on  date,
  created_by    uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sales_activity_account_idx ON sales_activity(account_id, occurred_at DESC);
CREATE INDEX sales_activity_deal_idx ON sales_activity(deal_id, occurred_at DESC);
CREATE INDEX sales_activity_creator_idx ON sales_activity(created_by, occurred_at DESC);
CREATE INDEX sales_activity_follow_up_idx ON sales_activity(follow_up_on)
  WHERE follow_up_on IS NOT NULL;

ALTER TABLE sales_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_activity_all ON sales_activity FOR ALL
  USING (can_see_sales()) WITH CHECK (can_see_sales());

-- Some environments intentionally postpone migration 0007 until everyone has
-- MFA. If it is already active, extend the same AAL2 boundary to this new table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'account' AND policyname = 'require_aal2'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY require_aal2 ON sales_activity AS RESTRICTIVE FOR ALL
      USING ((select auth.jwt()->>'aal') = 'aal2')
      WITH CHECK ((select auth.jwt()->>'aal') = 'aal2')
    $policy$;
  END IF;
END;
$$;

-- A newly logged interaction refreshes the deal's freshness marker. The
-- application still owns the explicit next step and its due date.
CREATE OR REPLACE FUNCTION touch_deal_last_activity() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL THEN
    UPDATE deal
    SET last_activity_at = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at)
    WHERE id = NEW.deal_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_activity_touch_deal
  AFTER INSERT OR UPDATE OF occurred_at, deal_id ON sales_activity
  FOR EACH ROW EXECUTE FUNCTION touch_deal_last_activity();
