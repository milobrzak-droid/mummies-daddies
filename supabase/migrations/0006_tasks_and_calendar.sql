-- 0006 — internal TODO tasks + per-user calendar (Microsoft Graph) tokens.

CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'blocked', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'normal', 'high');

CREATE TABLE task (
  id            bigserial PRIMARY KEY,
  title         text NOT NULL,
  description   text,
  status        task_status NOT NULL DEFAULT 'todo',
  priority      task_priority NOT NULL DEFAULT 'normal',
  assignee_id   uuid REFERENCES team_member(id) ON DELETE SET NULL,   -- who does it
  created_by    uuid REFERENCES team_member(id) ON DELETE SET NULL,
  due_on        date,
  -- optional cross-links so a task can hang off a client / deal / engagement
  account_id    bigint REFERENCES account(id) ON DELETE SET NULL,
  deal_id       bigint REFERENCES deal(id) ON DELETE SET NULL,
  engagement_id bigint REFERENCES engagement(id) ON DELETE SET NULL,
  -- Microsoft Graph event id, so we can update/delete the mirrored Outlook event
  ms_event_id   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_assignee_idx ON task(assignee_id);
CREATE INDEX task_status_idx   ON task(status);

ALTER TABLE task ENABLE ROW LEVEL SECURITY;
-- MVP: any team member sees + edits the team's tasks (same pattern as biz tables).
CREATE POLICY task_all ON task FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER task_set_updated_at BEFORE UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-user Microsoft Graph OAuth tokens (write tasks into the person's Outlook).
-- Only the owning user's row is visible (self RLS); the app reads/writes it
-- server-side. Tokens are sensitive — this table is never exposed client-side.
CREATE TABLE calendar_token (
  member_id     uuid PRIMARY KEY REFERENCES team_member(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'microsoft',
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  account_email text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE calendar_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY caltoken_self ON calendar_token FOR ALL
  USING (member_id = auth.uid()) WITH CHECK (member_id = auth.uid());
CREATE TRIGGER caltoken_set_updated_at BEFORE UPDATE ON calendar_token
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
