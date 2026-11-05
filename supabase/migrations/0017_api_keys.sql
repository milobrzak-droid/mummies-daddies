-- 0017 — API klíče pro server-to-server přístup (Claude Code, budoucí
-- Notion sync) k read-only REST API pod /api/v1/*. Ukládá se jen hash
-- klíče; plaintext appka zná jen jednou, v okamžiku vytvoření.
-- RLS je zapnuté BEZ jediné policy — tabulka je záměrně nedosažitelná
-- přes běžný cookie-session PostgREST přístup, jen přes service-role
-- klienta v admin server actions (stejně jako ostatní admin operace).
CREATE TABLE api_key (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  key_prefix    text NOT NULL,
  created_by    uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
