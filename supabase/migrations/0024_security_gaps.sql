-- 0024 — Dvě mezery v zabezpečení, které audit našel.
--
-- 1) calendar_token a team_member jako jediné neměly require_aal2.
--
-- U calendar_token to je nejcitlivější tabulka v systému: drží refresh
-- token k Microsoftu, což je trvalý přístup do kalendáře konkrétního
-- člověka. Politika sice omezuje čtení na vlastní řádek, ale session,
-- která neprošla druhým faktorem, se k němu dostat neměla.
--
-- Pozor na pořadí: RESTRICTIVE politiky se spojují přes AND, PERMISSIVE
-- přes OR. Kdyby tohle bylo PERMISSIVE, znamenalo by to pravý opak —
-- „stačí AAL2 NEBO být členem týmu" — a zabezpečení by to oslabilo.
ALTER POLICY caltoken_self ON calendar_token USING (member_id = auth.uid());

DROP POLICY IF EXISTS require_aal2 ON calendar_token;
CREATE POLICY require_aal2 ON calendar_token
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS require_aal2 ON team_member;
CREATE POLICY require_aal2 ON team_member
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2');

-- 2) Log volání API — slouží dvěma věcem najednou:
--    * omezení počtu volání (leaklý klíč šlo do teď tlouct bez limitu),
--    * stopa, co přes API dělaly externí nástroje. Doteď se u zápisu
--      vědělo jen „čí klíč", ne kdy a co.
CREATE TABLE IF NOT EXISTS api_request (
  id      bigserial PRIMARY KEY,
  key_id  bigint NOT NULL REFERENCES api_key(id) ON DELETE CASCADE,
  path    text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_request_key_at_idx ON api_request(key_id, at DESC);

-- Stejně jako api_key: RLS zapnuté, nula politik = přes běžného uživatele
-- nedostupné, sahá na to jen servisní klíč ze serveru.
ALTER TABLE api_request ENABLE ROW LEVEL SECURITY;
