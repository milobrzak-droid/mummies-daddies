-- 0008 — Referrer (doporučovatel) at the CLIENT level.
-- Some partners bring us clients (RSM, O2, Beta Trade…). That is a relationship-
-- origin fact about the *account*, distinct from deal.sourced_by_partner which is
-- per-deal attribution/economics. A client is referred once; its deals still carry
-- their own sourcing.

-- Who brought us this client. Nullable = direct (no partner).
ALTER TABLE account
  ADD COLUMN referred_by_partner_id bigint REFERENCES partner(id) ON DELETE SET NULL;

CREATE INDEX account_referred_by_partner_id_idx ON account (referred_by_partner_id);

-- Which partners act as referrers. A partner can be a referrer AND a
-- vendor/distributor/telco, so this is an additive flag, not a `kind` override.
ALTER TABLE partner
  ADD COLUMN is_referrer boolean NOT NULL DEFAULT false;

UPDATE partner SET is_referrer = true WHERE name IN ('BETA TRADE', 'O2', 'RSM');

-- RLS: both columns live on tables that already carry the AAL2 RESTRICTIVE
-- policies (0007) + team read policies (0003); no policy change needed.
