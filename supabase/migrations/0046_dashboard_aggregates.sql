-- 0046 — agregační pohledy pro dashboard (výkon).
--
-- getContractedOverTime a getImpactSummary (lib/queries/dashboard.ts) dosud
-- tahaly všechny vyhrané obchody / všechna engagementy jen kvůli součtům v JS.
-- Tyto pohledy počítají stejné agregáty v SQL. dashboard.ts se ptá nejdřív na
-- pohled a při jeho absenci (42P01 / PGRST205) spadne na původní JS výpočet,
-- takže nezáleží na pořadí nasazení.
--
-- Sémantika (MUSÍ odpovídat lib/queries/dashboard.ts):
--   * Měsíc: to_char(won_at, 'YYYY-MM'). won_at je typu DATE (bez času a
--     časové zóny), takže jde o kalendářní měsíc data tak, jak je uložené —
--     žádný převod do Europe/Prague ani UTC. TS: won_at.slice(0, 7).
--   * Měna: amount_one_time je VŽDY v Kč (0016_deal_currency); žádný FX
--     převod se zde nedělá, currency / fx_rate se ignorují.
--   * Jen stage = 'vyhráno' a won_at IS NOT NULL; NULL částka = 0.
--   * Impact: NULL hodnoty = 0; zaokrouhlení (hodiny = minuty/60, proof rate %)
--     dělá TS nad surovými součty, pohled vrací nezaokrouhlené součty.
--
-- security_invoker = on (vzor 0004): pohled běží s právy dotazujícího, RLS
-- podkladových tabulek platí i přes pohled.

CREATE OR REPLACE VIEW v_contracted_over_time
WITH (security_invoker = on) AS
SELECT
  to_char(won_at, 'YYYY-MM')           AS month,
  COALESCE(SUM(amount_one_time), 0)    AS amount
FROM deal
WHERE stage = 'vyhráno' AND won_at IS NOT NULL
GROUP BY to_char(won_at, 'YYYY-MM');

CREATE OR REPLACE VIEW v_impact_summary
WITH (security_invoker = on) AS
SELECT
  COUNT(*)                                                                    AS engagements_total,
  COUNT(*) FILTER (WHERE post_adoption_pct IS NOT NULL OR post_captured_on IS NOT NULL) AS with_audit,
  COALESCE(SUM(trained_count), 0)                                             AS trained_total,
  COALESCE(SUM(time_saved_min_week), 0)                                       AS minutes_per_week,
  COALESCE(SUM(roi_czk_year), 0)                                              AS roi_total,
  COUNT(*) FILTER (WHERE reference_worthy)                                    AS reference_count
FROM engagement;

-- Idempotence: CREATE OR REPLACE nemusí zachovat reloptions u existujícího pohledu.
ALTER VIEW v_contracted_over_time SET (security_invoker = on);
ALTER VIEW v_impact_summary       SET (security_invoker = on);

REVOKE ALL ON v_contracted_over_time FROM anon;
REVOKE ALL ON v_impact_summary       FROM anon;
GRANT SELECT ON v_contracted_over_time TO authenticated;
GRANT SELECT ON v_impact_summary       TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0046', 'v_contracted_over_time + v_impact_summary (security_invoker) pro dashboard')
ON CONFLICT (version) DO NOTHING;
