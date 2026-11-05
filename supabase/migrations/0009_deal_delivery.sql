-- 0009 — Delivery detail on a deal, ported from the pipeline realizací board.
-- The deal already holds the money; these hold "kde projekt stojí": a free note,
-- live status (done / next step / blocker), assigned devs, MD estimate and the
-- delivery lane (internal team vs Rhomates handover). All nullable/defaulted so
-- existing deals are untouched.
ALTER TABLE deal ADD COLUMN note           text;
ALTER TABLE deal ADD COLUMN status_done    text;                    -- hotovo
ALTER TABLE deal ADD COLUMN status_next    text;                    -- další krok
ALTER TABLE deal ADD COLUMN status_blocker text;                    -- blokery (prázdné = ok)
ALTER TABLE deal ADD COLUMN dev_team       text[] NOT NULL DEFAULT '{}';
ALTER TABLE deal ADD COLUMN estimate_md    integer;                 -- odhad rozsahu (MD)
ALTER TABLE deal ADD COLUMN delivery_lane  text;                    -- 'internal' | 'rhomates'

-- RLS: `deal` already carries the team-read + AAL2 policies; new columns inherit them.
