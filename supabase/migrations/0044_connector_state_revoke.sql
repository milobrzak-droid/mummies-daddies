-- 0044 — connector_state: explicitní REVOKE klientským rolím.
--
-- 0029 zapnula na connector_state RLS a nechala nula politik (vzor api_key
-- z 0024). Přístup klienta (anon / authenticated) tak blokovalo jen
-- default-deny RLS — stačila by jedna omylem přidaná permisivní politika
-- nebo vypnuté RLS a tabulka by byla klientovi otevřená. job_lock (0040)
-- má navíc REVOKE ALL; tady to chybělo.
--
-- Proč REVOKE ALL a ne týmová SELECT politika: veškerý přístup k tabulce
-- jde přes admin klienta (service role) — core/connectorState.ts
-- (getConnectorState, recordConnectorSuccess, recordConnectorError) i
-- ukládání kurzoru v app/api/cron/outlook-mail/route.ts. Stránky, které
-- ukazují čerstvost (nastaveni, schuzky, digest), volají getConnectorState
-- na serveru, takže uživatelský klient tabulku nikdy nečte a REVOKE nic
-- nerozbije. service_role má BYPASSRLS a vlastní granty, REVOKE se jí
-- netýká.
--
-- Idempotentní: REVOKE nad již odebraným právem je no-op.

REVOKE ALL ON connector_state FROM anon, authenticated;
REVOKE ALL ON SEQUENCE connector_state_id_seq FROM anon, authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0044', 'connector_state - REVOKE ALL FROM anon, authenticated (jen service role)')
ON CONFLICT (version) DO NOTHING;
