-- 0043 — rozsah (scope) API klíče a OAuth kód bez plaintextu klíče.
--
-- 1) api_key.scope: 'read' = jen čtení, 'full' = čtení i zápis.
--    Dosud byl každý klíč plnohodnotný, i ten vydaný přes OAuth konektor,
--    přestože souhlasná obrazovka tvrdila „zapisovat nemůže". Stávající klíče
--    dostanou DEFAULT 'full' — pro ně se chování nemění. Klíče vydané přes
--    OAuth (/api/oauth/token) se nově zakládají se scope 'read' a zápisové
--    MCP nástroje i zápisové /api/v1 routy je odmítnou (403).
--
-- 2) oauth_code už nedrží plaintext API klíče. Klíč se nově zakládá až při
--    výměně kódu na /api/oauth/token, takže kód nese jen to, co je k tomu
--    potřeba: kdo přístup schválil (approved_by). Sloupce api_key_id
--    a api_key_secret zůstávají kvůli zpětné kompatibilitě, ale jsou nově
--    nullable a nový kód je nevyplňuje. U už vypršelých kódů se plaintext
--    nuluje (vyzvednout je stejně nejde); nevypršelé kódy (TTL 60 s) se
--    nechávají být, ať nasazení nerozbije právě probíhající připojení.
--    Nic se nemaže — jde o UPDATE na NULL, ne o DROP.
--
-- POŘADÍ NASAZENÍ: migraci aplikovat PŘED nasazením kódu. Kód chybějící
-- sloupec scope snese (čte ho tolerantně a bez něj bere 'full', tj. dnešní
-- stav), ale OAuth flow bez migrace selže bezpečně — nový kód nevydá kód
-- ani token bez sloupců approved_by/scope.
--
-- Idempotentní: IF NOT EXISTS / DROP NOT NULL / DO blok na constraint.

ALTER TABLE api_key ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'full';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_key_scope_check'
  ) THEN
    ALTER TABLE api_key ADD CONSTRAINT api_key_scope_check CHECK (scope IN ('read', 'full'));
  END IF;
END $$;

ALTER TABLE oauth_code ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES team_member(id) ON DELETE CASCADE;
ALTER TABLE oauth_code ALTER COLUMN api_key_id DROP NOT NULL;
ALTER TABLE oauth_code ALTER COLUMN api_key_secret DROP NOT NULL;

UPDATE oauth_code SET api_key_secret = NULL
WHERE api_key_secret IS NOT NULL AND expires_at < now();

INSERT INTO schema_migration (version, note)
VALUES ('0043', 'api_key.scope (read/full) + oauth_code bez plaintextu klice')
ON CONFLICT (version) DO NOTHING;
