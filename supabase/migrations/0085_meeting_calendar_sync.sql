-- 0085 — naplánované schůzky podle Outlooku: vazba na milník dodávky,
-- termín milníku převzatý ze schůzky a čas, kdy ke schůzce přišel zápis.
--
-- PROČ: Tým nesmí dělat věci ručně. Schůzka naplánovaná z Cockpitu
-- (domain/crm/actions/planMeeting.ts: událost v Outlooku + sales_activity
-- s outcome 'planned' a ms_event_id) se dosud v Outlooku posunula nebo
-- zrušila a Cockpit o tom nevěděl. Nově ji kontroluje synchronizace
-- kalendáře (domain/crm/meetingCalendarSync.ts; denně v cronu
-- /api/cron/follow-ups a ručně tlačítkem) a když se schůzka posune, posune
-- ji i v Cockpitu, když se zruší, označí ji jako zrušenou a založí úkol.
-- Na schůzce ale můžou viset další termíny:
--   * DALŠÍ KROK OBCHODU „Follow-up po schůzce …" — pozná se podle textu
--     a termínu, který mu nastavilo plánování; sloupec netřeba.
--   * MILNÍK DODÁVKY (např. Workshop) — tady dosud žádná vazba nebyla.
--     Proto:
--       sales_activity.milestone_id — schůzka patří k milníku (volí se při
--         plánování schůzky),
--       engagement_milestone.due_from_activity_id — termín milníku byl
--         PŘEVZATÝ z téhle schůzky (plánování ho nastavilo, protože milník
--         termín neměl). Jen takový termín smí synchronizace posunout spolu
--         se schůzkou; každý jiný termín milníku zůstane a vlastník milníku
--         dostane úkol „zkontroluj termín milníku" (milník se nepřepisuje
--         potichu).
-- A zápis schůzky (Wispr Flow / skill), který doplní už naplánovanou
-- schůzku (domain/crm/plannedMeetingPairing.ts), nevytváří nový řádek —
-- proto sales_activity.note_received_at: kdy zápis přišel. Bez něj by „Stav
-- zdrojů" (poslední zápis schůzky) u doplněné schůzky viděl jen čas
-- plánování (created_at).
--
-- PŮVOD TERMÍNU MILNÍKU (strážce engagement_milestone_due_source_guard):
--   * due_from_activity_id nastavuje jen server (servisní klíč při
--     plánování schůzky) — přihlášený člověk ho nastavit nesmí, jen zrušit;
--   * když přihlášený člověk změní termín milníku, termín už není převzatý
--     ze schůzky a strážce vazbu sám zruší (jinak by ho synchronizace
--     mohla přepsat);
--   * CHECK: převzatý termín musí existovat (due_on není NULL).
--
-- VIDITELNOST: nové sloupce dědí RLS svých tabulek (sales_activity jen
-- obchodní role 0020/0058, engagement_milestone tým, obojí AAL2). Žádná
-- nová tabulka ani funkce volatelná klientem.
--
-- AUDIT: obecný trigger audit_row_change() (0064) je na obou tabulkách už
-- napojený; nové sloupce v allow-listu nejsou, takže se do auditu zapíše jen
-- jejich název (bezpečný výchozí stav, viz 0064). Hodnoty, na kterých stojí
-- „Co se změnilo" (occurred_at a outcome schůzky, due_on milníku), v
-- allow-listu jsou.
--
-- IDEMPOTENCE: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CHECK
-- přes pg_constraint, CREATE OR REPLACE + DROP TRIGGER IF EXISTS, ON CONFLICT.
-- Data se nepřepisují. Zámky: ADD COLUMN bez výchozí hodnoty je katalogová
-- změna; cizí klíč a trigger berou krátký zámek na dvou malých tabulkách.
--
-- ZÁVISLOSTI: 0020 (sales_activity), 0022 (ms_event_id, outcome 'planned'),
-- 0042 (engagement_milestone), 0026 (ledger). Guard níže skončí
-- srozumitelnou chybou.

DO $$
BEGIN
  IF to_regclass('public.sales_activity') IS NULL THEN
    RAISE EXCEPTION '0085 vyžaduje tabulku public.sales_activity — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'sales_activity' AND column_name = 'ms_event_id') THEN
    RAISE EXCEPTION '0085 vyžaduje sloupec sales_activity.ms_event_id — nejdřív aplikujte 0022_planned_meetings.sql';
  END IF;
  IF to_regclass('public.engagement_milestone') IS NULL THEN
    RAISE EXCEPTION '0085 vyžaduje tabulku public.engagement_milestone — nejdřív aplikujte 0042_engagement_milestone.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0085 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) Sloupce
-- ===========================================================================

ALTER TABLE sales_activity
  ADD COLUMN IF NOT EXISTS milestone_id bigint REFERENCES engagement_milestone(id) ON DELETE SET NULL;
ALTER TABLE sales_activity
  ADD COLUMN IF NOT EXISTS note_received_at timestamptz;
ALTER TABLE engagement_milestone
  ADD COLUMN IF NOT EXISTS due_from_activity_id bigint REFERENCES sales_activity(id) ON DELETE SET NULL;

COMMENT ON COLUMN sales_activity.milestone_id IS
  'Milník dodávky, ke kterému schůzka patří (volí se při plánování schůzky, 0085). Posun nebo zrušení schůzky v Outlooku hlídá termín milníku.';
COMMENT ON COLUMN sales_activity.note_received_at IS
  'Kdy k naplánované schůzce přišel zápis (Wispr Flow / skill) a doplnil ji (0085). U zápisu, který založil nový řádek, NULL (platí created_at).';
COMMENT ON COLUMN engagement_milestone.due_from_activity_id IS
  'Termín milníku je převzatý z této naplánované schůzky (0085): synchronizace kalendáře ho smí posunout spolu se schůzkou. NULL = termín zadal člověk, Cockpit ho nemění.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'engagement_milestone_due_from_activity_check'
      AND conrelid = 'public.engagement_milestone'::regclass
  ) THEN
    ALTER TABLE engagement_milestone
      ADD CONSTRAINT engagement_milestone_due_from_activity_check
      CHECK (due_from_activity_id IS NULL OR due_on IS NOT NULL);
  END IF;
END $$;

-- Cizí klíče s ON DELETE SET NULL: smazání milníku / aktivity nesmí skenovat tabulku.
CREATE INDEX IF NOT EXISTS sales_activity_milestone_idx
  ON sales_activity (milestone_id) WHERE milestone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS engagement_milestone_due_from_activity_idx
  ON engagement_milestone (due_from_activity_id) WHERE due_from_activity_id IS NOT NULL;
-- Synchronizace kalendáře: naplánované schůzky s událostí v Outlooku po členech.
CREATE INDEX IF NOT EXISTS sales_activity_planned_event_idx
  ON sales_activity (created_by, occurred_at) WHERE outcome = 'planned' AND ms_event_id IS NOT NULL;
-- „Stav zdrojů": čas posledního zápisu, který doplnil naplánovanou schůzku.
CREATE INDEX IF NOT EXISTS sales_activity_note_received_idx
  ON sales_activity (note_received_at DESC) WHERE note_received_at IS NOT NULL;

-- ===========================================================================
-- 2) Strážce původu termínu milníku
-- ===========================================================================

-- SECURITY INVOKER: čte jen NEW/OLD a auth.uid() volajícího.
-- auth.uid() je NULL pro servisní klíč (server) i SQL editor — ti smí vše.
CREATE OR REPLACE FUNCTION engagement_milestone_due_source_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.due_from_activity_id IS NOT NULL THEN
      RAISE EXCEPTION 'Termín milníku převzatý ze schůzky nastavuje jen Cockpit při plánování schůzky'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.due_from_activity_id IS NOT NULL
     AND NEW.due_from_activity_id IS DISTINCT FROM OLD.due_from_activity_id THEN
    RAISE EXCEPTION 'Termín milníku převzatý ze schůzky nastavuje jen Cockpit při plánování schůzky'
      USING ERRCODE = '42501';
  END IF;
  -- Člověk změnil termín: od teď je jeho, ne převzatý ze schůzky.
  IF NEW.due_on IS DISTINCT FROM OLD.due_on THEN
    NEW.due_from_activity_id := NULL;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION engagement_milestone_due_source_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS engagement_milestone_due_source_guard ON engagement_milestone;
CREATE TRIGGER engagement_milestone_due_source_guard
  BEFORE INSERT OR UPDATE ON engagement_milestone
  FOR EACH ROW EXECUTE FUNCTION engagement_milestone_due_source_guard();

INSERT INTO schema_migration (version, note)
VALUES ('0085', 'schuzky podle Outlooku: sales_activity.milestone_id + note_received_at, engagement_milestone.due_from_activity_id (termin prevzaty ze schuzky, strazce puvodu), indexy')
ON CONFLICT (version) DO NOTHING;
