-- 0013 — Hierarchie partnerů: dodavatele (Taupartner, Omegasoft) získáváme PŘES
-- distributora (Beta Trade). `via_partner_id` = přes kterého partnera nám tenhle
-- partner přišel.
ALTER TABLE partner ADD COLUMN via_partner_id bigint REFERENCES partner(id) ON DELETE SET NULL;
