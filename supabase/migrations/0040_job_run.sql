-- 0040 — job_run: záznam běhů plánovaných úloh a zámek proti překryvu.
--
-- Kapitola 9 plánu přestavby („Worker a rytmus", docs/PROVOZ.md)
-- chce plánovač s ochranou proti překryvu běhů. Vercel cron doručuje
-- best-effort: běh může vypadnout, přijít dvakrát nebo se překrýt s
-- předchozím, který ještě neskončil. Proto:
--
-- 1) `job_lock` — jeden řádek na úlohu, `locked_until` = do kdy zámek drží
--    běh `run_id`. Zámek s TTL (ne jen „running" příznak): když worker spadne
--    bez finish_job_run, zámek sám vyprší a další běh ho převezme. Starý
--    běh se při převzetí označí jako failed ('lock expired').
-- 2) `job_run` — historie běhů (running/succeeded/failed/skipped). I odmítnutý
--    běh (zámek drží jiný) se zapíše jako 'skipped', aby šlo z tabulky vyčíst
--    duplicitní doručení cronu. `error` je krátký text (CHECK ≤ 500 znaků) —
--    žádné stack trace ani obsah zpráv (princip „ids, ne těla", viz 0038).
-- 3) `try_acquire_job_lock(job_name, ttl_seconds)` → id běhu nebo NULL.
--    Atomicita: pg_advisory_xact_lock(hashtext(job_name)) serializuje dva
--    souběžné pokusy o tutéž úlohu uvnitř transakce funkce; pak se v klidu
--    přečte job_lock a buď se převezme (neexistuje / vypršel), nebo se
--    zapíše 'skipped'. Advisory xact lock se uvolní na konci transakce,
--    takže nehrozí zapomenutý zámek na úrovni session (pooler PgBouncer).
-- 4) `finish_job_run(run_id, status, stats, error)` uzavře běh a uvolní zámek
--    jen tehdy, když ho pořád drží tentýž běh (převzatý běh už zámek nevrací).
--
-- Obě funkce jsou SECURITY DEFINER se search_path = public, pg_temp; EXECUTE
-- má jen service_role (worker/cron běží pod service-role klientem). Klient
-- smí job_run jen číst (člen týmu s AAL2), job_lock nečte nikdo mimo
-- service_role (žádná politika = default-deny).
--
-- Migrace je idempotentní (IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF
-- EXISTS). Nové tabulky, žádné zámky na cizí tabulky.

CREATE TABLE IF NOT EXISTS job_run (
  id           bigserial PRIMARY KEY,
  job_name     text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',
  locked_until timestamptz,
  error        text,
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT job_run_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT job_run_job_name_check
    CHECK (length(job_name) BETWEEN 1 AND 100),
  CONSTRAINT job_run_error_check
    CHECK (error IS NULL OR length(error) <= 500),
  -- Hotový běh má čas konce, běžící ho nemá.
  CONSTRAINT job_run_finished_check
    CHECK ((status = 'running') = (finished_at IS NULL))
);

-- „Poslední běhy úlohy X" (přehled čerstvosti zdrojů v pondělním souhrnu).
CREATE INDEX IF NOT EXISTS job_run_job_started_idx
  ON job_run(job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS job_lock (
  job_name     text PRIMARY KEY,
  run_id       bigint REFERENCES job_run(id) ON DELETE SET NULL,
  locked_until timestamptz NOT NULL
);

ALTER TABLE job_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_lock ENABLE ROW LEVEL SECURITY;

-- Domácí styl (0038): permisivní SELECT pro člena týmu + RESTRICTIVE AAL2.
-- Žádná INSERT/UPDATE/DELETE politika: zapisují jen funkce níže.
DROP POLICY IF EXISTS job_run_read ON job_run;
CREATE POLICY job_run_read ON job_run
  FOR SELECT USING (is_team_member());

DROP POLICY IF EXISTS require_aal2 ON job_run;
CREATE POLICY require_aal2 ON job_run
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON job_run FROM anon, authenticated;
REVOKE ALL ON job_lock FROM anon, authenticated;

CREATE OR REPLACE FUNCTION try_acquire_job_lock(job_name text, ttl_seconds int)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job   text := try_acquire_job_lock.job_name;
  v_lock  job_lock%ROWTYPE;
  v_run   bigint;
  v_until timestamptz;
BEGIN
  IF v_job IS NULL OR length(v_job) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'job_name must be 1..100 chars';
  END IF;
  IF ttl_seconds IS NULL OR ttl_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'ttl_seconds must be 1..86400';
  END IF;

  -- Serializace souběžných pokusů o tutéž úlohu (do konce transakce).
  PERFORM pg_advisory_xact_lock(hashtext('job_run:' || v_job));

  SELECT * INTO v_lock FROM job_lock l WHERE l.job_name = v_job;

  IF FOUND AND v_lock.locked_until >= now() THEN
    -- Zámek drží jiný běh: zapíšeme přeskočení a vrátíme NULL.
    INSERT INTO job_run (job_name, status, finished_at, error)
    VALUES (v_job, 'skipped', now(), 'locked by run ' || coalesce(v_lock.run_id::text, '?'));
    RETURN NULL;
  END IF;

  -- Převzetí vypršelého zámku: předchozí běh, který se neohlásil, je failed.
  IF FOUND AND v_lock.run_id IS NOT NULL THEN
    UPDATE job_run r
       SET status = 'failed', finished_at = now(), error = 'lock expired'
     WHERE r.id = v_lock.run_id AND r.status = 'running';
  END IF;

  v_until := now() + make_interval(secs => ttl_seconds);
  INSERT INTO job_run (job_name, status, locked_until)
  VALUES (v_job, 'running', v_until)
  RETURNING id INTO v_run;

  INSERT INTO job_lock AS l (job_name, run_id, locked_until)
  VALUES (v_job, v_run, v_until)
  ON CONFLICT ON CONSTRAINT job_lock_pkey
  DO UPDATE SET run_id = EXCLUDED.run_id, locked_until = EXCLUDED.locked_until;

  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION finish_job_run(
  run_id bigint, status text, stats jsonb DEFAULT '{}'::jsonb, error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job text;
BEGIN
  IF finish_job_run.status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'status must be succeeded or failed';
  END IF;

  -- Jen běžící běh; převzatý (už failed 'lock expired') se nepřepisuje.
  UPDATE job_run r
     SET status = finish_job_run.status,
         finished_at = now(),
         stats = coalesce(finish_job_run.stats, '{}'::jsonb),
         error = left(finish_job_run.error, 500)
   WHERE r.id = finish_job_run.run_id AND r.status = 'running'
  RETURNING r.job_name INTO v_job;

  IF v_job IS NULL THEN
    RETURN false;
  END IF;

  -- Uvolnit zámek, jen pokud ho pořád drží tento běh.
  UPDATE job_lock l
     SET locked_until = now() - interval '1 microsecond'
   WHERE l.job_name = v_job AND l.run_id = finish_job_run.run_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION try_acquire_job_lock(text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION finish_job_run(bigint, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION try_acquire_job_lock(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION finish_job_run(bigint, text, jsonb, text) TO service_role;

INSERT INTO schema_migration (version, note)
VALUES ('0040', 'job_run + job_lock - planovac s TTL zamkem proti prekryvu behu')
ON CONFLICT (version) DO NOTHING;
