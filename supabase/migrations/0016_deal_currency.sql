-- 0016 — Podpora cizích měn u projektů. Firma fakturuje v Kč, ale nabídky
-- (typicky pro slovenské klienty) přicházejí v EUR. amount_one_time zůstává
-- VŽDY v Kč (jediný zdroj pravdy pro rollupy a dashboard); currency +
-- amount_one_time_original + fx_rate jsou jen audit trail toho, v čem a za
-- jaký kurz byla částka zadaná.
CREATE TYPE deal_currency AS ENUM ('CZK', 'EUR');

ALTER TABLE deal ADD COLUMN IF NOT EXISTS currency deal_currency NOT NULL DEFAULT 'CZK';
ALTER TABLE deal ADD COLUMN IF NOT EXISTS amount_one_time_original numeric(14,2);
ALTER TABLE deal ADD COLUMN IF NOT EXISTS fx_rate numeric(10,4);
