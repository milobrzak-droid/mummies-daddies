-- 0025 — Oprava násobení částek v v_account_rollup.
--
-- Původní pohled spojoval account LEFT JOIN deal LEFT JOIN subscription
-- v jednom kroku, což je kartézský součin: klient se třemi obchody a dvěma
-- předplatnými dal šest řádků, takže se každý obchod sečetl dvakrát a každé
-- předplatné třikrát. Ověřeno na modelu — 600 000 se vykázalo jako 1 200 000
-- a MRR 12 000 jako 36 000.
--
-- Zatím to nikoho nepálilo jen proto, že tabulka subscription byla prázdná
-- a LEFT JOIN vracel NULL. Jakmile se založí první předplatné u klienta
-- s víc obchody, obě čísla se nafouknou — a to je přesně teď, protože
-- evidence předplatných šla do provozu včera.
--
-- Náprava: každou stranu sečíst zvlášť, teprve pak spojit.
CREATE OR REPLACE VIEW v_account_rollup AS
SELECT
  a.id,
  a.name,
  COALESCE(d.contracted_one_time, 0::numeric) AS contracted_one_time,
  COALESCE(s.running_mrr, 0::numeric)         AS running_mrr,
  COALESCE(s.at_risk_mrr, 0::numeric)         AS at_risk_mrr
FROM account a
LEFT JOIN (
  SELECT account_id,
         SUM(amount_one_time) FILTER (
           WHERE stage = 'vyhráno'::deal_stage
             AND revenue_category = 'one_time'::revenue_category
         ) AS contracted_one_time
  FROM deal
  GROUP BY account_id
) d ON d.account_id = a.id
LEFT JOIN (
  SELECT account_id,
         SUM(mrr) AS running_mrr,
         SUM(mrr) FILTER (WHERE churn_risk = 'high'::churn_risk) AS at_risk_mrr
  FROM subscription
  GROUP BY account_id
) s ON s.account_id = a.id;
