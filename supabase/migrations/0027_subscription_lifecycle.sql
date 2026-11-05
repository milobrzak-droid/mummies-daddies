-- 0027 — Ukončení předplatného.
--
-- Předplatné šlo jen založit. Odchod klienta se nedal zaznamenat jinak než
-- smazáním řádku — jenže tím by se zpětně změnily už vykázané měsíce, což
-- je stejná chyba jako přepočítávání kurzu u uzavřených obchodů (0025).
-- Ukončené předplatné tedy zůstává, jen se přestane počítat do běžícího MRR.
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS ended_on date;

-- Běžící MRR nesmí zahrnovat ukončená předplatná. Navazuje na opravu
-- křížového spojení z migrace 0025 — agregace po stranách zůstává.
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
         SUM(mrr) FILTER (WHERE ended_on IS NULL) AS running_mrr,
         SUM(mrr) FILTER (WHERE ended_on IS NULL AND churn_risk = 'high'::churn_risk) AS at_risk_mrr
  FROM subscription
  GROUP BY account_id
) s ON s.account_id = a.id;

INSERT INTO schema_migration (version, note)
VALUES ('0027','ukončení předplatného') ON CONFLICT (version) DO NOTHING;
