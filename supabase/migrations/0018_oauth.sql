-- 0018 — Minimální OAuth 2.1 vrstva pro MCP konektor.
--
-- Proč: claude.ai / Cowork „custom connector" neumí zadat vlastní hlavičku
-- ani statický token — než začne s MCP serverem mluvit, provede u něj OAuth
-- Dynamic Client Registration a autorizační flow. Bez toho se nepřipojí
-- vůbec. Tahle vrstva ten flow obslouží a na konci vydá běžný API klíč
-- z tabulky api_key (viz migrace 0017), takže samotný MCP endpoint zůstává
-- beze změny — pořád jen ověřuje `Authorization: Bearer <klíč>`.

-- Klienti zaregistrovaní přes DCR (RFC 7591). Veřejní klienti s PKCE,
-- proto se neukládá client_secret.
CREATE TABLE oauth_client (
  client_id     text PRIMARY KEY,
  client_name   text,
  redirect_uris text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Autorizační kódy: krátkodobé (60 s), jednorázové. Drží plaintext API
-- klíče jen do jeho vyzvednutí na /token — pak se řádek maže.
CREATE TABLE oauth_code (
  code           text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  api_key_id     bigint NOT NULL REFERENCES api_key(id) ON DELETE CASCADE,
  api_key_secret text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- RLS zapnuté BEZ policy — obojí je dosažitelné jen service-role klientem
-- ze server-side route handlerů, stejně jako api_key.
ALTER TABLE oauth_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_code ENABLE ROW LEVEL SECURITY;
