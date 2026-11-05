-- 0052 — obchodní příležitost (kapitola 5): typ obchodu, obsah příležitosti
-- a povinná pole PŘI PŘECHODU fáze.
--
-- Rozhodnutí vlastníka 28. 9. 2026:
--   * workshop a implementace jsou ODDĚLENÉ obchody (domluvený workshop
--     není schválená implementace) → deal.deal_kind;
--   * povinná pole se hlídají při přechodu fáze, ne při založení.
--
-- Nové sloupce na `deal` (všechny nullable, BEZ výchozí hodnoty — stávající
-- obchody zůstanou NULL, dokud je někdo při inventuře neroztřídí; UI u nich
-- ukazuje „Doplnit typ"):
--   deal_kind         workshop | implementace | provoz | jine
--   problem           problém klienta
--   expected_outcome  očekávaný výsledek
--   decision_maker    kdo rozhoduje (jméno / role)
--   decision_process  jak klient rozhoduje (kroky, schvalování)
--   decision_due      do kdy klient rozhodne
--   value_basis       zdroj odhadu hodnoty (z čeho je částka odhadnutá)
--
-- Trigger deal_stage_transition_guard_trigger (BEFORE INSERT OR UPDATE OF
-- stage) — stejná pravidla jako čistá funkce transitionIssues
-- v domain/crm/dealTransition.ts (UI je ukáže dřív, než se ukládá):
--   * přechod DO 'rozhodovani' vyžaduje decision_maker (neprázdný)
--     a decision_due → jinak SQLSTATE 'CR001';
--   * přechod DO 'prohráno' vyžaduje lost_reason (neprázdný; sloupec je
--     od 0020, dosud ho hlídala jen appka) → jinak SQLSTATE 'CR002'.
--   Kódy CR001/CR002 jsou stabilní: aplikace je překládá na českou hlášku
--   (DEAL_TRANSITION_DB_CODES v domain/crm/dealTransition.ts). Třída 'CR'
--   nekoliduje s žádnou standardní třídou SQLSTATE.
--
-- Kdy trigger NEBLOKUJE:
--   * UPDATE, který fázi nemění (WHEN OLD.stage IS DISTINCT FROM NEW.stage)
--     — obchody, které do rozhodování převedla 0050 bez rozhodovatele, jdou
--     dál upravovat; pravidlo platí až pro další přechod;
--   * převod staré hodnoty na novou (vyjednávání → rozhodovani, stejně jako
--     v 0050 a LEGACY_DEAL_STAGE_MAP) — není to rozhodnutí člověka, ale
--     přejmenování fáze. 0050 je navíc už aplikovaná; na její řádky trigger
--     zpětně nesahá (běží jen na nové zápisy).
--
-- Kód je tolerantní k nenasazené migraci: čte přes select('*') (sloupce pak
-- chybí = undefined a pravidla přechodu se na ně neuplatní — DB je taky
-- ještě nevynucuje) a při zápisu na 42703 / PGRST204 zopakuje zápis bez
-- nových sloupců (domain/crm/dealWrite.ts).
--
-- Idempotentní (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT/TRIGGER IF EXISTS,
-- CREATE OR REPLACE FUNCTION, ON CONFLICT). Zámky: ALTER TABLE … ADD COLUMN
-- bez výchozí hodnoty je jen katalogová změna; ADD CONSTRAINT CHECK projde
-- tabulku (jednotky řádků); CREATE TRIGGER bere krátký SHARE ROW EXCLUSIVE.

ALTER TABLE deal ADD COLUMN IF NOT EXISTS deal_kind text;
ALTER TABLE deal ADD COLUMN IF NOT EXISTS problem text;
ALTER TABLE deal ADD COLUMN IF NOT EXISTS expected_outcome text;
ALTER TABLE deal ADD COLUMN IF NOT EXISTS decision_maker text;
ALTER TABLE deal ADD COLUMN IF NOT EXISTS decision_process text;
ALTER TABLE deal ADD COLUMN IF NOT EXISTS decision_due date;
ALTER TABLE deal ADD COLUMN IF NOT EXISTS value_basis text;

ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_deal_kind_check;
ALTER TABLE deal ADD CONSTRAINT deal_deal_kind_check
  CHECK (deal_kind IS NULL OR deal_kind IN ('workshop', 'implementace', 'provoz', 'jine'));

ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_problem_len;
ALTER TABLE deal ADD CONSTRAINT deal_problem_len
  CHECK (problem IS NULL OR char_length(problem) <= 2000);

ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_expected_outcome_len;
ALTER TABLE deal ADD CONSTRAINT deal_expected_outcome_len
  CHECK (expected_outcome IS NULL OR char_length(expected_outcome) <= 2000);

ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_decision_maker_len;
ALTER TABLE deal ADD CONSTRAINT deal_decision_maker_len
  CHECK (decision_maker IS NULL OR char_length(decision_maker) <= 200);

ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_decision_process_len;
ALTER TABLE deal ADD CONSTRAINT deal_decision_process_len
  CHECK (decision_process IS NULL OR char_length(decision_process) <= 2000);

ALTER TABLE deal DROP CONSTRAINT IF EXISTS deal_value_basis_len;
ALTER TABLE deal ADD CONSTRAINT deal_value_basis_len
  CHECK (value_basis IS NULL OR char_length(value_basis) <= 500);

COMMENT ON COLUMN deal.deal_kind IS
  'Typ obchodu: workshop | implementace | provoz | jine. NULL = zatím neroztříděno (inventura, kap. 5).';
COMMENT ON COLUMN deal.value_basis IS
  'Zdroj odhadu hodnoty obchodu (z čeho je částka odhadnutá).';
COMMENT ON COLUMN deal.decision_due IS
  'Do kdy klient rozhodne. Povinné (spolu s decision_maker) při přechodu do fáze rozhodovani.';

-- Pravidla přechodu fáze. SECURITY INVOKER (výchozí) — jen čte NEW/OLD.
CREATE OR REPLACE FUNCTION deal_stage_transition_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.stage IS NOT DISTINCT FROM NEW.stage THEN
      RETURN NEW;
    END IF;
    -- Převod staré hodnoty na novou (0050 / LEGACY_DEAL_STAGE_MAP) není
    -- rozhodnutí člověka — neblokovat.
    IF OLD.stage::text = 'vyjednávání' AND NEW.stage::text = 'rozhodovani' THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.stage::text = 'rozhodovani'
     AND (NEW.decision_maker IS NULL OR btrim(NEW.decision_maker) = '' OR NEW.decision_due IS NULL) THEN
    RAISE EXCEPTION 'Do fáze Rozhodování nejde obchod posunout bez známého rozhodovatele a termínu rozhodnutí.'
      USING ERRCODE = 'CR001',
            HINT = 'Doplň u obchodu pole Kdo rozhoduje a Termín rozhodnutí.';
  END IF;

  IF NEW.stage::text = 'prohráno'
     AND (NEW.lost_reason IS NULL OR btrim(NEW.lost_reason) = '') THEN
    RAISE EXCEPTION 'Prohraný obchod musí mít důvod prohry.'
      USING ERRCODE = 'CR002',
            HINT = 'Doplň u obchodu Důvod prohry.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS deal_stage_transition_guard_trigger ON deal;
CREATE TRIGGER deal_stage_transition_guard_trigger
  BEFORE INSERT OR UPDATE OF stage ON deal
  FOR EACH ROW
  EXECUTE FUNCTION deal_stage_transition_guard();

INSERT INTO schema_migration (version, note)
VALUES ('0052', 'deal: deal_kind + pole prilezitosti; trigger povinnych poli pri prechodu faze (CR001 rozhodovani, CR002 prohrano)')
ON CONFLICT (version) DO NOTHING;
