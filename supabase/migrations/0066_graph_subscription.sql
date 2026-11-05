-- 0066 — graph_subscription: předplatné změn (webhooky) Microsoft Graph pro
-- poštu jednoho člena (docs/PROVOZ.md, kapitola 8).
--
-- PROČ: kapitola 8 je „hotová", když se odpověď klienta v Outlooku do hodiny
-- objeví jako událost u správné firmy. Vercel Hobby ale pouští cron nejvýš
-- 1× denně, takže hodinový polling nejde. Místo něj Microsoft Graph posílá
-- change notifications (POST na /api/ms/notifications) pro
-- me/mailFolders('inbox')/messages a me/mailFolders('sentitems')/messages;
-- notifikace jen spustí stávající delta sync dané složky
-- (domain/crm/mailSync.ts). Předplatné má omezenou životnost (u zpráv
-- Outlooku nejvýš 10 080 minut, tj. necelých 7 dní) a denní cron
-- (/api/cron/outlook-mail) ho obnovuje / zakládá znovu.
--
-- CO SE UKLÁDÁ: jeden řádek na složku (connector_key = 'outlook:inbox' /
-- 'outlook:sent', stejné klíče jako connector_state). Id předplatného,
-- sledovaný zdroj, expirace, čas poslední notifikace a poslední chyba —
-- aby přerušené notifikace byly v Cockpitu vidět („Stav zdrojů" v přehledu
-- a v Nastavení). clientState (HMAC odvozený z CRON_SECRET, viz
-- connectors/graph/subscriptions.ts) se NEUKLÁDÁ — jen jeho SHA-256 otisk
-- (client_state_hash), podle kterého cron pozná, že se tajemství změnilo
-- a předplatné je potřeba založit znovu. Žádná data z pošty, žádné adresy.
--
-- Řádek bez subscription_id = pro složku předplatné momentálně není
-- (založení selhalo); last_error říká proč. Expirace a otisk jsou pak NULL.
--
-- PŘÍSTUP: jen service role (cron, webhook — oba přes createAdminClient).
-- Stránky, které stav ukazují, ho čtou na serveru admin klientem (stejně jako
-- connector_state, viz 0044), takže klient tabulku nepotřebuje. RLS zapnuté,
-- žádná permisivní politika, RESTRICTIVE AAL2 kvůli domácímu stylu a REVOKE
-- ALL klientským rolím (vzor digest_send_log z 0053 a connector_state z 0044).
--
-- ZÁVISLOSTI: 0026 (schema_migration), 0040 (try_acquire_job_lock — webhook
-- běží pod zámkem runJob) a 0041 (mail_event + service RPC k tokenu). Guard
-- níže skončí srozumitelnou chybou. Kód bez téhle migrace funguje: webhook
-- i cron chybějící tabulku (42P01 / PGRST205) jen ohlásí klidnou hláškou
-- a předplatné nezakládají.
--
-- Idempotentní (IF NOT EXISTS, DROP POLICY IF EXISTS, ON CONFLICT DO NOTHING).
-- Bez explicitního BEGIN/COMMIT: scripts/migrate.mjs obaluje každý soubor
-- vlastní transakcí.

DO $$
BEGIN
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0066 vyžaduje tabulku public.schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  IF to_regprocedure('public.try_acquire_job_lock(text, integer)') IS NULL THEN
    RAISE EXCEPTION '0066 vyžaduje zámek úloh (try_acquire_job_lock) — nejdřív aplikujte 0040_job_run.sql';
  END IF;
  IF to_regclass('public.mail_event') IS NULL
     OR to_regprocedure('public.calendar_token_get_for_service(uuid)') IS NULL THEN
    RAISE EXCEPTION '0066 vyžaduje sync pošty (mail_event, calendar_token_get_for_service) — nejdřív aplikujte 0041_mail_event.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS graph_subscription (
  id                   bigserial PRIMARY KEY,
  -- Jedno předplatné na složku; stejný klíč jako connector_state.connector.
  connector_key        text NOT NULL UNIQUE
                       CHECK (length(connector_key) BETWEEN 1 AND 100),
  -- Id od Microsoftu (GUID). NULL = předplatné teď neexistuje (viz last_error).
  subscription_id      text UNIQUE
                       CHECK (subscription_id IS NULL OR length(subscription_id) BETWEEN 1 AND 200),
  resource             text NOT NULL CHECK (length(resource) BETWEEN 1 AND 500),
  expires_at           timestamptz,
  -- SHA-256 (hex) clientState — nikdy clientState samotný.
  client_state_hash    text CHECK (client_state_hash IS NULL OR client_state_hash ~ '^[0-9a-f]{64}$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_notification_at timestamptz,
  -- Krátký text (bez tajemství, bez obsahu pošty), stejný limit jako job_run.error.
  last_error           text CHECK (last_error IS NULL OR length(last_error) <= 500),
  -- Buď je předplatné celé (id + expirace + otisk), nebo žádné.
  CONSTRAINT graph_subscription_complete CHECK (
    (subscription_id IS NULL AND expires_at IS NULL AND client_state_hash IS NULL)
    OR (subscription_id IS NOT NULL AND expires_at IS NOT NULL AND client_state_hash IS NOT NULL)
  )
);

ALTER TABLE graph_subscription ENABLE ROW LEVEL SECURITY;

-- Žádná permisivní politika = klient nic nečte ani nepíše (default-deny).
-- RESTRICTIVE AAL2 jen pro konzistenci s domácím stylem (0041, 0053).
DROP POLICY IF EXISTS require_aal2 ON graph_subscription;
CREATE POLICY require_aal2 ON graph_subscription
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON graph_subscription FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE graph_subscription_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON graph_subscription TO service_role;
GRANT USAGE ON SEQUENCE graph_subscription_id_seq TO service_role;

INSERT INTO schema_migration (version, note)
VALUES ('0066', 'graph_subscription: webhooky Microsoft Graph pro postu (id, expirace, otisk clientState, posledni notifikace/chyba) - jen service role')
ON CONFLICT (version) DO NOTHING;
