-- 0083 — OAuth konektor (Claude / Cowork): refresh tokeny a rozsah schválení.
--
-- PROČ: konektor se v Cowork pořád odpojoval („Can't reach Cockpit right
-- now — it may need to be reconnected"). OAuth vrstva (0018, 0043) uměla jen
-- authorization_code a vydala jediný access token na 90 dní bez refresh
-- tokenu. Když token vypršel nebo se zneplatnil, klient neměl jak si vyžádat
-- nový a musel se připojit od začátku.
--
-- CO SE MĚNÍ
--
-- 1) oauth_refresh_token: refresh tokeny (OAuth 2.1, rotace). V databázi leží
--    jen sha256 hash tokenu, nikdy plaintext. Každý refresh token je
--    jednorázový: při použití se označí used_at a vydá se nový token stejné
--    „rodiny" (family_id). Použití už použitého tokenu (reuse) znamená, že
--    token unikl — zneplatní se celá rodina (refresh tokeny i jimi vydané
--    access tokeny v api_key). api_key_id ukazuje na access token vydaný
--    spolu s refresh tokenem; ON DELETE SET NULL, ať smazání klíče nerozbije
--    evidenci rodiny.
--    Jen service role: RLS bez politik a REVOKE ALL klientům (vzor api_key
--    z 0017/0024, mfa_failure z 0069).
--
-- 2) oauth_code.scope: rozsah, který schvalovatel na souhlasné obrazovce
--    zvolil ('read' = jen čtení, 'full' = čtení i zápis). Token endpoint ho
--    přenese do api_key.scope. Stávající kódy (TTL 60 s) dostanou 'read'.
--
-- POŘADÍ NASAZENÍ: migraci aplikovat PŘED nasazením kódu. Kód bez ní běží
-- bezpečně: bez tabulky se refresh token nevydá (konektor funguje jako dřív),
-- bez sloupce oauth_code.scope se vydává jen 'read'.
--
-- Idempotentní: IF NOT EXISTS, DO blok na constraint, ON CONFLICT DO NOTHING.

DO $$
BEGIN
  IF to_regclass('public.oauth_client') IS NULL
     OR to_regclass('public.oauth_code') IS NULL
     OR to_regclass('public.api_key') IS NULL
     OR to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0083 vyžaduje tabulky oauth_client, oauth_code, api_key a team_member — nejdřív aplikujte 0018, 0017 a 0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_key' AND column_name = 'scope'
  ) THEN
    RAISE EXCEPTION '0083 vyžaduje sloupec api_key.scope — nejdřív aplikujte 0043_api_key_scope.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0083 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) oauth_code.scope

ALTER TABLE oauth_code ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'read';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_code_scope_check' AND conrelid = 'public.oauth_code'::regclass
  ) THEN
    ALTER TABLE oauth_code ADD CONSTRAINT oauth_code_scope_check CHECK (scope IN ('read', 'full'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) oauth_refresh_token

CREATE TABLE IF NOT EXISTS oauth_refresh_token (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  family_id   uuid NOT NULL,
  client_id   text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  approved_by uuid NOT NULL REFERENCES team_member(id) ON DELETE CASCADE,
  scope       text NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'full')),
  api_key_id  bigint REFERENCES api_key(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_refresh_token_family_idx ON oauth_refresh_token(family_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_token_client_idx ON oauth_refresh_token(client_id, approved_by);

ALTER TABLE oauth_refresh_token ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON oauth_refresh_token FROM PUBLIC, anon, authenticated;
GRANT ALL ON oauth_refresh_token TO service_role;
GRANT USAGE ON SEQUENCE oauth_refresh_token_id_seq TO service_role;

INSERT INTO schema_migration (version, note)
VALUES ('0083', 'oauth_refresh_token (rotace, hash, rodina) + oauth_code.scope pro konektor Claude/Cowork')
ON CONFLICT (version) DO NOTHING;
