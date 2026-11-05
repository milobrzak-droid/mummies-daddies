-- 0029 — connector_state: základní kámen kapitoly 8 (Konektory).
--
-- Úloha konektoru je za normálních okolností jednoduchá otázka: „změnilo
-- se od posledně něco?" Bez trvalého kurzoru a záznamu o čerstvosti ale
-- „nic nového" a „synchronizace je rozbitá" vypadají zvenku úplně stejně
-- — obojí se projeví jako ticho. Tahle tabulka existuje proto, aby rozbitý
-- konektor byl vidět, místo aby splynul s konektorem, který jen nemá co
-- hlásit.
--
-- Je to čistě provozní stav, ne doménová data — čte a píše ho jen server
-- (service role), nikdy klient přes RLS. Proto stejný vzor jako api_key /
-- api_request v 0024_security_gaps.sql: RLS zapnuté, nula politik.
--
-- Tahle migrace zakládá jen primitivum. Napojení na živý Fireflies sync
-- (lib/actions/meetings.ts) je záměrně mimo rozsah — je to samostatný,
-- recenzovaný krok, ne něco vedlejšího k téhle změně.
CREATE TABLE IF NOT EXISTS connector_state (
  id                  bigserial PRIMARY KEY,
  connector           text NOT NULL UNIQUE,
  cursor              text,
  last_success_at     timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  consecutive_errors  integer NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE connector_state ENABLE ROW LEVEL SECURITY;
