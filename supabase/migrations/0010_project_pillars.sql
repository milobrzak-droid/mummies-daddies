-- 0010 — Obchod = pilíř firmy (firemní akce / soukromé oslavy / cheesecaky) určuje fáze, plus
-- interní realizační tým. Přerámování `deal` → „Projekt" bez přejmenování tabulky.
--   pillar        — primární typ projektu (řídí sadu fází v aplikaci)
--   phase         — aktuální fáze (validovaná v app dle pilíře; nahrazuje `stage`)
--   delivery_team — interní noha, která projekt dodává (ne partner)
ALTER TABLE deal ADD COLUMN pillar text
  CHECK (pillar IN ('b2b_akce', 'b2c_oslavy', 'cheesecaky'));
ALTER TABLE deal ADD COLUMN phase text;
ALTER TABLE deal ADD COLUMN delivery_team text
  CHECK (delivery_team IN ('kuchyne', 'cukrarna', 'obsluha', 'logistika', 'externi'));

-- `stage` (deal_stage) a `delivery_lane` (0009) se přestávají používat ve prospěch
-- phase/delivery_team; ponecháváme je nullable pro zpětnou kompatibilitu, smažou se později.
