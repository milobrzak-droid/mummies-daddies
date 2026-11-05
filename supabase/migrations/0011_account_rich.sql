-- 0011 — Bohatší karta klienta: identita (region/web/IČO), vztah (owner, od kdy)
-- a poznámky. Rollup stavu (aktivní projekty, hodnota, stav) se počítá z projektů,
-- není to sloupec.
ALTER TABLE account ADD COLUMN region       text;
ALTER TABLE account ADD COLUMN web          text;
ALTER TABLE account ADD COLUMN ico          text;
ALTER TABLE account ADD COLUMN owner_id     uuid REFERENCES team_member(id) ON DELETE SET NULL;
ALTER TABLE account ADD COLUMN client_since date;
ALTER TABLE account ADD COLUMN notes        text;
