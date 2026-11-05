-- 0021 — Aktivita může patřit i partnerovi, nejen klientovi.
--
-- Proč: velká část reálných schůzek je s partnery (BETA TRADE, TAUPARTNER,
-- DeltaHost, Rhomates) — přes ně chodí poptávky. V původním návrhu měla
-- sales_activity account_id NOT NULL, takže takové schůzky neměly kam.
-- Stejný vzor jako u contact (migrace 0019).
ALTER TABLE sales_activity ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE sales_activity ADD COLUMN IF NOT EXISTS partner_id bigint REFERENCES partner(id) ON DELETE CASCADE;

ALTER TABLE sales_activity DROP CONSTRAINT IF EXISTS sales_activity_belongs_to_one;
ALTER TABLE sales_activity ADD CONSTRAINT sales_activity_belongs_to_one CHECK (
  (account_id IS NOT NULL AND partner_id IS NULL)
  OR (account_id IS NULL AND partner_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS sales_activity_partner_idx ON sales_activity(partner_id, occurred_at DESC);

-- Zdroj záznamu a id z něj — aby opakovaný import ze schůzkového nástroje
-- (Fireflies) nezaložil tutéž schůzku dvakrát.
ALTER TABLE sales_activity ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE sales_activity ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS sales_activity_external_idx
  ON sales_activity(source, external_id) WHERE external_id IS NOT NULL;
