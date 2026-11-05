-- 0019 — Kontakt může patřit i partnerovi, nejen klientovi.
--
-- Proč: při přenosu CRM z Notionu do Cockpitu se ukázalo, že velká část
-- kontaktů jsou lidé na straně partnerů (TAUPARTNER, BETA TRADE, RSM, Rhomates…),
-- ne u koncových klientů. Bez téhle vazby by se zahodily.
--
-- account_id i partner_id jsou nullable — kontakt patří právě jednomu z nich,
-- což hlídá CHECK níže.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS partner_id bigint REFERENCES partner(id) ON DELETE CASCADE;

ALTER TABLE contact DROP CONSTRAINT IF EXISTS contact_belongs_to_one;
ALTER TABLE contact ADD CONSTRAINT contact_belongs_to_one CHECK (
  (account_id IS NOT NULL AND partner_id IS NULL)
  OR (account_id IS NULL AND partner_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS contact_partner_id_idx ON contact(partner_id);
