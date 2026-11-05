-- 0014 — Role členů organizace. Doteď existovala jen 'vedeni', takže nešlo
-- rozlišit, kdo uvidí byznys (peníze) a kdo jen dodávku.
--   vedeni    — vedení firmy: vidí vše (Byznys i Projekty)
--   obchodnik — sales tým: vidí Byznys, pipeline a aktivity
--   projektak — projekťák / IT dodávka: jen Projekty (bez Kč)
--   lektor    — lektor adopce (Launchpad): jen Projekty
--   partner   — externí partner: jen Projekty, omezeně
ALTER TYPE team_role ADD VALUE IF NOT EXISTS 'projektak';
ALTER TYPE team_role ADD VALUE IF NOT EXISTS 'lektor';
ALTER TYPE team_role ADD VALUE IF NOT EXISTS 'partner';
