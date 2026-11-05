-- 0028 — audit_event: kdo změnil částku nebo fázi obchodu, a z čeho na co.
--
-- Kapitola 3 plánu přestavby („Původ a audit", docs/PROVOZ.md) chce,
-- aby u každé důležité změny šlo dohledat aktér, akce, entita a stav před
-- a po. Tahle migrace staví jen samotnou tabulku a její čtení — trigger na
-- cenu/fázi vynucený v databázi, source_ref/evidence a čtyři rozlišené
-- stavy údaje jsou mimo rozsah téhle kapitoly a přijdou později.
--
-- Aktér může být přihlášený člověk, API klíč, nebo systém (naplánovaná
-- úloha) — proto actor_type/actor_id, ne jen odkaz na team_member. API klíč
-- teď taky nese, kdo ho vytvořil (lib/apiKeyAuth.ts), takže zápisy přes API
-- mají stejně dohledatelného aktéra jako zápisy z appky.
--
-- Zápisy jdou vždy přes servisní (admin) klienta, který RLS obchází — jako
-- api_key a oauth_code tabulka proto nemá INSERT politiku, protože by
-- k ničemu nebyla: přes běžnou session se sem nezapisuje. Čtení je omezené
-- na členy týmu s AAL2, stejný vzor jako u deal a calendar_token (0024).
CREATE TABLE IF NOT EXISTS audit_event (
  id           bigserial PRIMARY KEY,
  actor_type   text NOT NULL,
  actor_id     text,
  action       text NOT NULL,
  entity_table text NOT NULL,
  entity_id    bigint NOT NULL,
  before       jsonb,
  after        jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- Hlavní dotaz je „historie téhle jedné entity, nejnovější první".
CREATE INDEX IF NOT EXISTS audit_event_entity_idx
  ON audit_event(entity_table, entity_id, occurred_at DESC);

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_event_read ON audit_event;
CREATE POLICY audit_event_read ON audit_event
  FOR SELECT
  USING (is_team_member());

-- Pozor na pořadí (viz 0024): RESTRICTIVE se spojuje přes AND, takže tohle
-- čtení zužuje, nikdy nerozšiřuje — bez AAL2 se k historii nedostane nikdo,
-- ani člen týmu.
DROP POLICY IF EXISTS require_aal2 ON audit_event;
CREATE POLICY require_aal2 ON audit_event
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2');

INSERT INTO schema_migration (version, note)
VALUES ('0028','audit_event - původ změn ceny a fáze') ON CONFLICT (version) DO NOTHING;
