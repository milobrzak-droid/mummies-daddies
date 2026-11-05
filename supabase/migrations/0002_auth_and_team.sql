-- Team roles. Only 'vedeni' exists today; 'obchodnik' is future (do not add yet).
CREATE TYPE team_role AS ENUM ('vedeni');

CREATE TABLE team_member (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  email       text NOT NULL,
  role        team_role NOT NULL DEFAULT 'vedeni',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- When an auth user is created (via invite), auto-create their team_member row.
CREATE OR REPLACE FUNCTION handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO team_member (id, full_name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.email
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Helper: is the current request an authenticated team member?
-- Used by RLS policies in the next migration.
CREATE OR REPLACE FUNCTION is_team_member() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid());
$$;
