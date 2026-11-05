-- =============================================================================
-- CRM — DATOVÝ MODEL (základ)
-- Cockpit firmy Mummies and Daddies (catering, eventy, cheesecaky).
-- Postgres dialekt. Komentáře = proč, ne co.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. ENUMY
-- -----------------------------------------------------------------------------

-- Kategorie tržby = jak se to forecastuje a rolluje.
CREATE TYPE revenue_category AS ENUM (
  'one_time',      -- jednorázová akce nebo objednávka
  'recurring',     -- opakovaná služba (pravidelný firemní catering)
  'royalty'        -- provize a doporučení
);

-- Obchodní linka. MUSÍ sedět s COMPANY.revenueLines (config/mummiesDaddies.ts).
CREATE TYPE revenue_line AS ENUM (
  'catering_firemni',   -- firemní catering a akce (B2B)
  'oslava_soukroma',    -- soukromá oslava (B2C)
  'svatebni_hostina',   -- svatební hostina
  'cheesecaky_eshop',   -- cheesecaky a e-shop
  'firemni_pravidelny', -- pravidelný firemní catering (opakovaná služba)
  'pronajem_prostor',   -- pronájem eventových prostor
  'provize'             -- provize a doporučení
);

CREATE TYPE deal_stage AS ENUM (
  'lead', 'proběhlo_jednání', 'nabídka', 'vyjednávání', 'vyhráno', 'prohráno', 'odloženo'
);

-- Fáze realizace (engagement.phase). Klíče jsou historické, popisky
-- v lib/domain.ts#DELIVERY_PHASES odpovídají realizaci akce.
CREATE TYPE delivery_phase AS ENUM (
  'sm_diagnostika',   -- příprava
  'workshopy',        -- degustace
  'analyza',          -- plánování akce
  'pilot',            -- zkouška menu
  'implementace',     -- realizace akce
  'podpora',          -- pravidelné dodávky
  'mereni_6m',        -- vyhodnocení
  'uzavreno'
);

-- Druhy spolupráce s partnery a dodavateli.
CREATE TYPE partner_program AS ENUM (
  'dodavatel_napoju',      -- víno, nápoje
  'pronajem_vybaveni',     -- stany, mobiliář, inventář
  'eventova_agentura',     -- eventová agentura (přivádí firemní akce)
  'svatebni_agentura',     -- svatební agentura / salon
  'pronajimatel_prostor',  -- pronajímatel prostor
  'doporuceni',            -- doporučení
  'logistika'              -- doprava a logistika
);

CREATE TYPE registration_status AS ENUM (
  'none', 'prospect', 'registered', 'certified', 'advanced', 'elite', 'cpor_claimed'
);

-- Dotace = first-class. U edu linek pokrývá až 82 % → mění "jak velký je deal".
CREATE TYPE subsidy_program AS ENUM (
  'none', 'opz_plus', 'digi_pro_firmy', 'mpsv_rekvalifikace'
);

CREATE TYPE churn_risk AS ENUM ('low', 'medium', 'high');

-- -----------------------------------------------------------------------------
-- 1. ÚČTY A KONTAKTY
-- -----------------------------------------------------------------------------

CREATE TABLE account (
  id                bigserial PRIMARY KEY,
  name              text NOT NULL,
  raynet_id         integer,                    -- most na stávající Raynet
  industry          text,
  size_band         text,                       -- SME / enterprise / holding / veřejný sektor
  is_reference      boolean NOT NULL DEFAULT false,  -- klient použitelný jako reference
  ms_licenses       integer,                    -- historický sloupec (v UI se nepoužívá)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Rollup účtu na DVĚ čísla (přímá odpověď na "how big are these deals"):
--   contracted_one_time = nasmlouvaný jednorázový objem
--   running_mrr         = běžící měsíční MRR
-- Implementováno jako view (v_account_rollup) níže, ne jako denormalizovaný sloupec.

CREATE TABLE contact (
  id            bigserial PRIMARY KEY,
  account_id    bigint REFERENCES account(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  role          text,          -- pracovní pozice kontaktu
  email         text,
  is_champion   boolean NOT NULL DEFAULT false,  -- adoption champion track
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. PARTNEŘI (co-selleři, ne jen "odkud lead")
-- -----------------------------------------------------------------------------

CREATE TABLE partner (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,          -- dodavatel, agentura, pronajímatel
  kind          text,                   -- vendor / distributor / telco / consulting / infra
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Spolupráce s partnerem v konkrétním programu (kdo co přináší a za kolik).
CREATE TABLE partner_registration (
  id             bigserial PRIMARY KEY,
  partner_id     bigint NOT NULL REFERENCES partner(id) ON DELETE CASCADE,
  program        partner_program NOT NULL,
  status         registration_status NOT NULL DEFAULT 'none',
  tier_note      text,                  -- registered / advanced / elite (Beta Trade tier TBD)
  margin_pct     numeric(5,2),          -- distribuční margin / incentive %
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, program)
);

-- -----------------------------------------------------------------------------
-- 3. DEALY — s typem příjmu, dotací a partnerskou atribucí
-- -----------------------------------------------------------------------------

CREATE TABLE deal (
  id                  bigserial PRIMARY KEY,
  account_id          bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  title               text NOT NULL,
  revenue_line        revenue_line NOT NULL,
  revenue_category    revenue_category NOT NULL,   -- odvozeno od linky, drženo pro rychlý rollup
  stage               deal_stage NOT NULL DEFAULT 'lead',
  probability_pct     integer CHECK (probability_pct BETWEEN 0 AND 100),

  -- JEDNORÁZOVÁ část (one_time / cheesecaky_eshop)
  amount_one_time     numeric(14,2) DEFAULT 0,     -- fakturační objem bez DPH, PŘED dotací
  cogs_one_time       numeric(14,2) DEFAULT 0,     -- náklady (lektoři, kluci na IČO ~150-200 tis/projekt)

  -- OPAKOVANÁ část (recurring) — přes subscription, tady jen pointer/expected
  expected_mrr        numeric(12,2) DEFAULT 0,     -- očekávané MRR při konverzi (firemni_pravidelny)

  -- DOTACE — u edu linek zásadní. Kolik reálně platí klient.
  subsidy_program     subsidy_program NOT NULL DEFAULT 'none',
  subsidy_pct         numeric(5,2) DEFAULT 0,      -- 0-82 %

  -- ATRIBUCE
  sourced_by_partner  bigint REFERENCES partner(id),  -- kdo přinesl poptávku

  expected_close      date,
  won_at              date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Kolik reálně zaplatí klient po dotaci (generated column).
ALTER TABLE deal ADD COLUMN client_paid_one_time numeric(14,2)
  GENERATED ALWAYS AS (amount_one_time * (1 - COALESCE(subsidy_pct,0)/100)) STORED;

-- M:N deal ↔ partner: jeden deal může mít víc partnerů (source vs co-sell vs distribuce).
CREATE TABLE deal_partner (
  deal_id         bigint NOT NULL REFERENCES deal(id) ON DELETE CASCADE,
  partner_id      bigint NOT NULL REFERENCES partner(id) ON DELETE CASCADE,
  program         partner_program NOT NULL,
  attribution_pct numeric(5,2) DEFAULT 0,   -- kolik % dealu si partner připisuje
  is_sourcing     boolean NOT NULL DEFAULT false,  -- přinesl lead?
  nnpsa_target    integer,                  -- MS metrika: New Net Paid Seats Added, kterou deal vygeneruje
  PRIMARY KEY (deal_id, partner_id, program)
);

-- -----------------------------------------------------------------------------
-- 4. SUBSCRIPTIONS — vlastní motion (customer success, ne dodávková nástěnka)
--    DNES prázdné/forward-looking: platforma předplatného MVP cíl Q4 2026.
-- -----------------------------------------------------------------------------

CREATE TABLE subscription (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  deal_id        bigint REFERENCES deal(id),      -- z jakého dealu vznikla
  product        text NOT NULL,                    -- 'platforma předplatného', modul (Compass/Launchpad/Orbit)
  seats          integer NOT NULL DEFAULT 0,
  mrr            numeric(12,2) NOT NULL DEFAULT 0,
  started_on     date,
  renewal_date   date,                             -- kdy se rozhoduje o obnově
  churn_risk     churn_risk NOT NULL DEFAULT 'low',
  health_score   integer CHECK (health_score BETWEEN 0 AND 100),  -- adoption-driven
  is_ms_subsidized boolean NOT NULL DEFAULT false, -- "6 měsíců zdarma" Q4 Sema crazy idea
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 5. ENGAGEMENTS (dodávková nástěnka) — pětikroková metodika s měřicí smyčkou
--    Baseline na vstupu, delta na výstupu. Data, ne jen názvy fází.
-- -----------------------------------------------------------------------------

CREATE TABLE engagement (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  deal_id         bigint REFERENCES deal(id),
  kind            text NOT NULL,             -- 'edu' | 'it' | 'platform'
  phase           delivery_phase NOT NULL DEFAULT 'sm_diagnostika',
  started_on      date,
  due_on          date,

  -- VSTUPNÍ AUDIT (baseline)
  baseline_adoption_pct   numeric(5,2),      -- Gamaplast: 17
  baseline_captured_on    date,
  copilot_licenses        integer,           -- kolik licencí na vstupu (renewal risk)

  -- VÝSTUPNÍ AUDIT + 6M FOLLOW-UP (delta) — TOHLE JE PRODUKT ENTERU
  post_adoption_pct       numeric(5,2),      -- Gamaplast: 78
  trained_count           integer,           -- Gamaplast: 82 (pozn.: NE 120)
  time_saved_min_week     integer,           -- Gamaplast: ~40
  workshops_delivered     integer,           -- Lambda Group: 15
  nnpsa                   integer,           -- New Net Paid Seats Added (MS jazyk)
  roi_czk_year            numeric(14,2),     -- roční finanční dopad
  post_captured_on        date,

  reference_worthy        boolean NOT NULL DEFAULT false,  -- flag → generuje referenční kartu
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Delta adopce jako generated column (post - baseline), pro rychlý scoreboard.
ALTER TABLE engagement ADD COLUMN adoption_delta_pp numeric(6,2)
  GENERATED ALWAYS AS (post_adoption_pct - baseline_adoption_pct) STORED;

-- -----------------------------------------------------------------------------
-- 6. REFERENCE CARDS — dodávka krmí další prodej (smyčka, kterou generický CRM nemá)
-- -----------------------------------------------------------------------------

CREATE TABLE reference_card (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL REFERENCES account(id),
  engagement_id   bigint REFERENCES engagement(id),
  headline        text,                       -- "Gamaplast: 17 → 78 %, 40 min/týden, 82 vyškolených"
  approved_public boolean NOT NULL DEFAULT false,  -- klient dal souhlas
  used_in_deals   integer NOT NULL DEFAULT 0,  -- kolikrát reference otevřela další deal
  is_ms_anchor    boolean NOT NULL DEFAULT false,  -- Lambda Group = anchor case pro Ignite
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 7. VIEWS — pohled vedení: portfolio, ne jen "pipeline value"
-- =============================================================================

-- 7a. Rollup účtu na dvě čísla: nasmlouvaný jednorázový objem + běžící MRR.
CREATE VIEW v_account_rollup AS
SELECT
  a.id, a.name,
  COALESCE(SUM(d.amount_one_time) FILTER (WHERE d.stage = 'vyhráno'
           AND d.revenue_category = 'one_time'), 0)  AS contracted_one_time,
  COALESCE(SUM(s.mrr), 0)                              AS running_mrr,
  COALESCE(SUM(s.mrr) FILTER (WHERE s.churn_risk = 'high'), 0) AS at_risk_mrr
FROM account a
LEFT JOIN deal d          ON d.account_id = a.id
LEFT JOIN subscription s  ON s.account_id = a.id
GROUP BY a.id, a.name;

-- 7b. Jednorázová pipeline podle typu příjmu (LIVE vs ROADMAPA rozlišeno linkou).
CREATE VIEW v_pipeline_by_line AS
SELECT
  revenue_line,
  revenue_category,
  COUNT(*)                                              AS deals,
  SUM(amount_one_time)                                  AS gross_one_time,
  SUM(client_paid_one_time)                             AS client_paid,
  SUM(amount_one_time - client_paid_one_time)           AS subsidy_covered,
  SUM(amount_one_time * probability_pct / 100.0)        AS weighted_pipeline
FROM deal
WHERE stage NOT IN ('vyhráno','prohráno')
GROUP BY revenue_line, revenue_category;

-- 7c. Běžící MRR s churn rizikem (subscriptions motion).
CREATE VIEW v_mrr_health AS
SELECT
  SUM(mrr)                                         AS total_mrr,
  SUM(mrr) FILTER (WHERE churn_risk = 'high')      AS mrr_high_risk,
  SUM(mrr) FILTER (WHERE renewal_date <= now() + interval '90 days') AS mrr_renewing_90d,
  COUNT(*)                                         AS active_subs,
  SUM(seats)                                       AS total_seats
FROM subscription;

-- 7d. Zdraví dodávek: kolik engagementů v jaké fázi + kolik má hotový výstupní audit.
CREATE VIEW v_delivery_health AS
SELECT
  phase,
  COUNT(*)                                         AS engagements,
  COUNT(*) FILTER (WHERE post_adoption_pct IS NOT NULL) AS with_post_audit,
  COUNT(*) FILTER (WHERE reference_worthy)          AS reference_worthy
FROM engagement
GROUP BY phase;

-- 7e. Reference pipeline: hotové výsledky připravené prodat další zakázku.
CREATE VIEW v_reference_pipeline AS
SELECT
  a.name,
  e.adoption_delta_pp,
  e.trained_count,
  e.time_saved_min_week,
  e.nnpsa,
  rc.approved_public,
  rc.used_in_deals
FROM engagement e
JOIN account a        ON a.id = e.account_id
LEFT JOIN reference_card rc ON rc.engagement_id = e.id
WHERE e.reference_worthy;

-- 7f. Partner atribuce: kolik pipeline je sourced kterým partnerem + NNPSA total.
CREATE VIEW v_partner_attribution AS
SELECT
  p.name,
  dp.program,
  COUNT(DISTINCT dp.deal_id)                       AS deals,
  SUM(d.amount_one_time * dp.attribution_pct/100)  AS attributed_one_time,
  SUM(dp.nnpsa_target)                             AS nnpsa_target_total
FROM deal_partner dp
JOIN partner p ON p.id = dp.partner_id
JOIN deal d    ON d.id = dp.deal_id
GROUP BY p.name, dp.program;

-- =============================================================================
-- POZN.: subscription a opakované linky (firemni_pravidelny) mohou být zatím
--   prázdné; tabulky existují, aby model neměl švy, až služba naběhne.
-- =============================================================================
