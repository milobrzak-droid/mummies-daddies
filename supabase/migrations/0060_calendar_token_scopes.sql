-- 0060 — calendar_token.granted_scopes: která delegovaná oprávnění Microsoft
-- při posledním připojení Outlooku skutečně udělil (pole `scope` z odpovědi
-- tokenového endpointu, normalizované connectors/graph normalizeGrantedScopes:
-- mezerami oddělené názvy, bez prefixu https://graph.microsoft.com/).
--
-- Proč: od 28. 9. 2026 GRAPH_SCOPES obsahuje i Mail.Read a Mail.Send
-- (sync metadat pošty a odesílání přehledu z Viktorovy schránky). Starší tokeny
-- je nemají; Nastavení (/nastaveni) podle tohohle sloupce ukáže
-- „Chybí oprávnění: Mail.Read / Mail.Send — klikni Znovu připojit".
--
-- Není to tajemství ani osobní údaj — jen seznam názvů oprávnění. Zapisuje
-- ho callback OAuth (app/api/ms/callback) session člena; platí dál
-- caltoken_self (0006) a require_aal2 (0024). NULL = neznámé (připojeno před
-- touto migrací, nebo Microsoft scope nevrátil).
--
-- Kód s chybějícím sloupcem počítá (callback zápis přeskočí a zaloguje,
-- Nastavení ukáže „neznámé"), takže migraci lze aplikovat kdykoli po deployi.
-- Po aplikaci se hodnota doplní až dalším připojením Outlooku.
--
-- Bez explicitního BEGIN/COMMIT: scripts/migrate.mjs obaluje každý soubor
-- vlastní transakcí.

ALTER TABLE calendar_token ADD COLUMN IF NOT EXISTS granted_scopes text;

INSERT INTO schema_migration (version, note)
VALUES ('0060', 'calendar_token.granted_scopes: udelena delegovana opravneni Microsoftu z posledniho pripojeni (upozorneni na chybejici Mail.Read/Mail.Send v Nastaveni)')
ON CONFLICT (version) DO NOTHING;
