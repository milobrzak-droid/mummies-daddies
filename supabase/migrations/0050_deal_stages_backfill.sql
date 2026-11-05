-- 0050 — nové fáze obchodu (kapitola 5), krok 2 ze 2: převod dat.
--
-- Předpoklad: 0049 je aplikovaná a POTVRZENÁ (samostatná transakce) — nové
-- hodnoty enumu nejde použít ve stejné transakci, ve které vznikly. Kontrola
-- na začátku souboru skončí srozumitelnou chybou, když tomu tak není.
--
-- Mapování (rozhodnutí vedení 28. 9. 2026, docs/PROVOZ.md 5.1–5.3;
-- stejné jako LEGACY_DEAL_STAGE_MAP v lib/dealStageLegacy.ts):
--   lead              → kvalifikace
--   proběhlo_jednání  → kvalifikace
--   nabídka           → rozsah_nabidka
--   vyjednávání       → rozhodovani
--   vyhráno / prohráno / odloženo beze změny
--
-- Co soubor dělá:
--   1. Ověří, že nové hodnoty enumu existují a jsou potvrzené.
--   2. Vypne audit trigger deal_audit_price_stage_trigger (0034/0035), aby
--      převod nevyrobil N obyčejných `deal.stage_changed` řádků, které by
--      v historii obchodu vypadaly jako rozhodnutí člověka. Místo nich
--      zapíše JEDEN řádek `deal.stage_remapped` na převedený obchod
--      (actor_type 'system', actor_id 'migration:0050', before/after {stage}).
--      Trigger deal_audit_insert_delete_trigger (0035) se nevypíná — hlídá
--      jen INSERT/DELETE, na UPDATE nereaguje.
--   3. Převede obchody. U převáděného obchodu s prázdnou pravděpodobností
--      (probability_pct IS NULL) zmrazí výchozí pravděpodobnost STARÉ fáze
--      (lead 10, proběhlo_jednání 30, nabídka 55, vyjednávání 75). Důvod:
--      aplikace při prázdné pravděpodobnosti bere výchozí hodnotu fáze
--      a proběhlo_jednání (30 %) → kvalifikace (10 %) by jinak tiše snížilo
--      váženou pipeline. Vyplněná pravděpodobnost se nemění. Zmrazení je
--      v audit řádku vidět (before/after nese i probability_pct).
--   4. Trigger zase zapne (vše v jedné transakci — když cokoli selže,
--      rollback vrátí i stav triggeru).
--   5. Výchozí hodnota deal.stage: 'lead' → 'kvalifikace'.
--   6. v_pipeline_by_line: dřív `stage NOT IN ('vyhráno','prohráno')`, takže
--      se do pipeline počítalo i `odloženo` (a počítaly by se tam i jakékoli
--      budoucí zavřené fáze). Nově allow-list otevřených fází — stejný
--      seznam jako příznak `open` v DEAL_STAGES (lib/domain.ts).
--      security_invoker = on zůstává (vzor 0004/0046).
--
-- Ostatní pohledy a funkce, které filtrují podle fáze (prověřeno grepem
-- v 0001–0048), se nemění — všechny se ptají jen na 'vyhráno'/'prohráno',
-- které se nemění: v_account_rollup (0001/0025/0027), v_contracted_over_time
-- a v_impact_summary (0046), index/doplnění closed_at v 0020. Audit funkce
-- z 0034/0035 fázi jen kopírují do JSON, nefiltrují podle ní.
--
-- Staré hodnoty enumu zůstávají (Postgres je odebrat neumí), po převodu je
-- nic nepoužívá. CHECK proti nim záměrně NENÍ: mezi aplikací migrací
-- a nasazením kódu by starý kód zakládal obchody se stage 'lead'
-- a CHECK by ty zápisy shodil. Aplikace staré hodnoty při čtení převádí.
--
-- Zámky: ALTER TABLE … DISABLE/ENABLE TRIGGER bere na `deal` SHARE ROW
-- EXCLUSIVE do konce transakce; UPDATE pár řádků; CREATE OR REPLACE VIEW
-- krátký zámek na pohled. Tabulka je malá (jednotky obchodů).

-- 1. Kontrola předpokladu.
DO $$
DECLARE
  v_missing     text[];
  v_uncommitted text[];
BEGIN
  SELECT array_agg(v ORDER BY v) INTO v_missing
  FROM unnest(ARRAY['kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani']) AS v
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'deal_stage' AND e.enumlabel = v
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0050: v enumu deal_stage chybí hodnoty % — nejdřív aplikuj 0049_deal_stages_expand.sql', v_missing;
  END IF;

  -- Hodnoty vzniklé v TÉTO transakci (0049 a 0050 vložené najednou) nejde
  -- použít; bez téhle kontroly by UPDATE spadl na méně jasné chybě.
  SELECT array_agg(e.enumlabel::text ORDER BY e.enumlabel) INTO v_uncommitted
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'deal_stage'
    AND e.enumlabel IN ('kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani')
    AND e.xmin::text = (txid_current() % 4294967296)::text;
  IF v_uncommitted IS NOT NULL THEN
    RAISE EXCEPTION '0050: hodnoty % vznikly v téže transakci — spusť 0049 a 0050 jako dva samostatné běhy', v_uncommitted;
  END IF;
END $$;

-- 2. Audit trigger na UPDATE vypnout jen po dobu převodu.
ALTER TABLE deal DISABLE TRIGGER deal_audit_price_stage_trigger;

-- 3. Převod + jeden audit řádek na převedený obchod.
WITH remap AS (
  SELECT
    d.id,
    d.stage           AS old_stage,
    d.probability_pct AS old_probability,
    CASE d.stage
      WHEN 'lead'             THEN 'kvalifikace'
      WHEN 'proběhlo_jednání' THEN 'kvalifikace'
      WHEN 'nabídka'          THEN 'rozsah_nabidka'
      WHEN 'vyjednávání'      THEN 'rozhodovani'
    END::deal_stage   AS new_stage,
    CASE d.stage
      WHEN 'lead'             THEN 10
      WHEN 'proběhlo_jednání' THEN 30
      WHEN 'nabídka'          THEN 55
      WHEN 'vyjednávání'      THEN 75
    END               AS legacy_probability
  FROM deal d
  WHERE d.stage IN ('lead', 'proběhlo_jednání', 'nabídka', 'vyjednávání')
),
updated AS (
  UPDATE deal d
  SET stage           = r.new_stage,
      probability_pct = COALESCE(d.probability_pct, r.legacy_probability)
  FROM remap r
  WHERE d.id = r.id
  RETURNING d.id, r.old_stage, r.new_stage, r.old_probability, d.probability_pct AS new_probability
)
INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
SELECT
  'system', 'migration:0050', 'deal.stage_remapped', 'deal', u.id,
  jsonb_build_object('stage', u.old_stage)
    || CASE WHEN u.old_probability IS NULL
            THEN jsonb_build_object('probability_pct', NULL) ELSE '{}'::jsonb END,
  jsonb_build_object('stage', u.new_stage)
    || CASE WHEN u.old_probability IS NULL
            THEN jsonb_build_object('probability_pct', u.new_probability) ELSE '{}'::jsonb END
FROM updated u;

-- 4. Trigger zpět.
ALTER TABLE deal ENABLE TRIGGER deal_audit_price_stage_trigger;

-- 5. Nový obchod začíná v kvalifikaci.
ALTER TABLE deal ALTER COLUMN stage SET DEFAULT 'kvalifikace';

-- 6. Pipeline = jen otevřené fáze (allow-list; odloženo už není pipeline).
CREATE OR REPLACE VIEW v_pipeline_by_line
WITH (security_invoker = on) AS
SELECT
  revenue_line,
  revenue_category,
  COUNT(*)                                              AS deals,
  SUM(amount_one_time)                                  AS gross_one_time,
  SUM(client_paid_one_time)                             AS client_paid,
  SUM(amount_one_time - client_paid_one_time)           AS subsidy_covered,
  SUM(amount_one_time * probability_pct / 100.0)        AS weighted_pipeline
FROM deal
WHERE stage IN ('kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani')
GROUP BY revenue_line, revenue_category;

ALTER VIEW v_pipeline_by_line SET (security_invoker = on);

INSERT INTO schema_migration (version, note)
VALUES ('0050', 'deal_stage backfill na nove faze (audit deal.stage_remapped), default kvalifikace, v_pipeline_by_line allow-list otevrenych fazi')
ON CONFLICT (version) DO NOTHING;
