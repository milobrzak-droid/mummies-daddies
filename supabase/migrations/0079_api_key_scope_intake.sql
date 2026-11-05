-- 0079 — api_key.scope: nová hodnota 'intake' (jen příjem zápisů schůzek).
--
-- PROČ: zápis z diktátu (Wispr Flow) se odesílá ze zkratky v telefonu nebo
-- z Macu — tedy ze zařízení, kde klíč leží čitelně. Dosavadní rozsahy jsou
-- 'read' (jen čtení) a 'full' (čtení i zápis aktivit, úkolů a dalších kroků
-- přes API a MCP). 'full' klíč ve zkratce by při úniku otevřel víc, než
-- zkratka potřebuje. Klíč se scope 'intake' smí VÝHRADNĚ volat
-- POST /api/ingest/meeting-notes: čtecí routy /api/v1/*, MCP i ostatní
-- zápisové routy ho odmítnou (403 insufficient_scope, lib/apiKeyAuth.ts).
-- Únik takového klíče znamená nanejvýš to, že někdo pošle do fronty
-- zápisů nový text — nic nepřečte a nic nezmění.
--
-- Stávající klíče se nemění (DEFAULT zůstává 'full', hodnoty read/full platí
-- dál). Jen se rozšíří CHECK api_key_scope_check z 0043.
--
-- POŘADÍ NASAZENÍ: bez 0079 kód klíč 'intake' nevydá (insert by shodil CHECK)
-- a hlásí to česky; endpoint pak přijímá jen klíče 'full'.
--
-- Idempotentní: constraint se přepíše, jen když ještě 'intake' nezná.

DO $$
BEGIN
  IF to_regclass('public.api_key') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'api_key' AND column_name = 'scope'
     ) THEN
    RAISE EXCEPTION '0079 vyžaduje sloupec api_key.scope — nejdřív aplikujte 0043_api_key_scope.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0079 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conname = 'api_key_scope_check'
     AND c.conrelid = 'public.api_key'::regclass;

  IF v_def IS NULL OR v_def NOT LIKE '%intake%' THEN
    ALTER TABLE api_key DROP CONSTRAINT IF EXISTS api_key_scope_check;
    ALTER TABLE api_key ADD CONSTRAINT api_key_scope_check
      CHECK (scope IN ('read', 'full', 'intake'));
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0079', 'api_key.scope: hodnota intake (klic jen pro prijem zapisu schuzek, /api/ingest/meeting-notes)')
ON CONFLICT (version) DO NOTHING;
