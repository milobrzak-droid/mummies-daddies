-- 0022 — Plánované schůzky a eskalace.
--
-- Schůzka se nově plánuje z Cockpitu: založí se událost v Outlooku (s Teams
-- odkazem, aby na ni dorazil Fireflies) a v Cockpitu zůstane záznam. Až
-- schůzka proběhne, import z Fireflies ten samý záznam doplní o zápis —
-- proto ms_event_id, ať se pozná, že jde o tutéž schůzku, a nevznikne
-- druhá kopie.
ALTER TABLE sales_activity ADD COLUMN IF NOT EXISTS ms_event_id text;
CREATE INDEX IF NOT EXISTS sales_activity_ms_event_idx ON sales_activity(ms_event_id) WHERE ms_event_id IS NOT NULL;

-- Naplánovaná, ale ještě neproběhlá schůzka. Dosavadní hodnoty popisují,
-- jak jednání dopadlo — u budoucí schůzky ještě není co hodnotit.
ALTER TYPE sales_activity_outcome ADD VALUE IF NOT EXISTS 'planned';

-- Kdo koho eskaluje. Když obchodník neudělá follow-up ani po upozornění,
-- jde to na jeho nadřízeného.
ALTER TABLE team_member ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES team_member(id) ON DELETE SET NULL;

-- Kdy naposledy jsme na chybějící follow-up upozorňovali — aby hlídač
-- neposílal totéž každý den znovu.
ALTER TABLE deal ADD COLUMN IF NOT EXISTS follow_up_nudged_on date;
ALTER TABLE deal ADD COLUMN IF NOT EXISTS follow_up_escalated_on date;
