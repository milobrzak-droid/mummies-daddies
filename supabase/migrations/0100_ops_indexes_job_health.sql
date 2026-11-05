-- 0100 — indexy cizích klíčů na klienta/obchod a denní kontrola plánovaných úloh.
--
-- 1) INDEXY. Detail klienta, MCP/API (get_accounts has_open_deal, get_deals
--    account_id), vrácení importu i mazání klienta (ON DELETE CASCADE) hledají
--    řádky podle account_id / deal_id. Tyhle sloupce index neměly (ověřeno
--    grepem migrací 0001–0099: deal(account_id), contact(account_id) — jen
--    částečný contact_do_not_contact_idx z 0087 —, task(deal_id),
--    task(account_id), engagement(account_id)), takže každé takové čtení
--    procházelo celou tabulku. Tabulky jsou malé, CREATE INDEX (bez
--    CONCURRENTLY — migrace běží v transakci běhače) drží zámek SHARE jen
--    zlomek sekundy.
--
-- 2) close_stale_job_runs(p_grace_seconds) — denní kontrola úloh (job_run,
--    0040). Běh, který zůstal 'running' a jeho zámek vypršel (Vercel funkci
--    zabil po maxDuration, takže se finish_job_run nezavolal), se uzavře jako
--    'failed' s českou chybou. Bez toho by visel, dokud stejná úloha znovu
--    nepoběží (try_acquire_job_lock ho převezme až tehdy). Volá ji jen
--    servisní role (cron follow-ups a přehled e-mailem); zámek úlohy
--    neuvolňuje — ten už vypršel, další běh ho převezme normálně.
--    Index job_run_problem_idx zrychlí čtení „selhalo / visí za 7 dní" pro
--    dlaždici Stav úloh v Nastavení a řádek v přehledu.
--
-- Idempotentní (IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING),
-- bez top-level BEGIN/COMMIT (transakci drží běhač).

DO $$
BEGIN
  IF to_regclass('public.job_run') IS NULL THEN
    RAISE EXCEPTION '0100 vyžaduje tabulku job_run — nejdřív aplikujte 0040_job_run.sql';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Indexy

CREATE INDEX IF NOT EXISTS deal_account_id_idx ON deal(account_id);
CREATE INDEX IF NOT EXISTS contact_account_id_idx ON contact(account_id);
CREATE INDEX IF NOT EXISTS task_deal_id_idx ON task(deal_id);
CREATE INDEX IF NOT EXISTS task_account_id_idx ON task(account_id);
CREATE INDEX IF NOT EXISTS engagement_account_id_idx ON engagement(account_id);

-- ---------------------------------------------------------------------------
-- 2) Denní kontrola úloh

CREATE INDEX IF NOT EXISTS job_run_problem_idx
  ON job_run(started_at DESC) WHERE status IN ('running', 'failed');

CREATE OR REPLACE FUNCTION close_stale_job_runs(p_grace_seconds integer DEFAULT 300)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_closed integer;
BEGIN
  IF p_grace_seconds IS NULL OR p_grace_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'p_grace_seconds must be 0..86400';
  END IF;

  WITH closed AS (
    UPDATE job_run r
       SET status = 'failed',
           finished_at = now(),
           error = 'Běh nedoběhl: zámek vypršel bez zápisu výsledku (funkce nejspíš překročila časový limit). Uzavřela denní kontrola úloh.'
     WHERE r.status = 'running'
       AND r.locked_until IS NOT NULL
       AND r.locked_until < now() - make_interval(secs => p_grace_seconds)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_closed FROM closed;

  RETURN v_closed;
END;
$$;

REVOKE ALL ON FUNCTION close_stale_job_runs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION close_stale_job_runs(integer) TO service_role;

COMMENT ON FUNCTION close_stale_job_runs(integer) IS
  'Denní kontrola úloh (0100): běh running s vypršelým zámkem (+ rezerva) uzavře jako failed. Jen service_role. Vrací počet uzavřených běhů.';

INSERT INTO schema_migration (version, note)
VALUES ('0100', 'indexy deal/contact/task/engagement(account_id), task(deal_id); close_stale_job_runs (denni kontrola uloh) + job_run_problem_idx')
ON CONFLICT (version) DO NOTHING;
