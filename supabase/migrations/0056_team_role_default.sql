-- 0056 — Výchozí role nového člena týmu = nejnižší oprávnění ('partner').
--
-- PROBLÉM (security review): team_member.role měl od 0002 DEFAULT 'vedeni'.
-- Každý nový řádek, který vznikne bez explicitní role (trigger po založení
-- auth uživatele, ruční založení v Supabase dashboardu, selhaný follow-up
-- UPDATE v createParticipant), tak tiše dostal roli vedení:
--   * can_see_sales() (0020) → vidí Byznys, pipeline a Kč,
--   * seesByznys() v lib/domain.ts → Byznys tab,
--   * loop_role_max_level (0039/0053) → vedeni smí schvalovat až L4.
--
-- PROČ 'partner': role bez Byznysu jsou projektak, lektor a partner
-- (sees_byznys = false v lib/domain.ts, mimo can_see_sales, v Loop Core
-- jen 'member' = L1). Z nich je podle modelu rolí z 0014 nejvíc omezený
-- 'partner' („externí partner: jen Projekty, omezeně“) — každé budoucí
-- zúžení podle role dopadne nejdřív na něj. Je to tedy nejbezpečnější
-- výchozí hodnota; skutečnou roli vždy vybírá admin ve formuláři na /tym.
--
-- Mění se JEN výchozí hodnota sloupce. Existující řádky zůstávají beze
-- změny (žádný UPDATE) — přeřazení stávajících členů je ruční rozhodnutí.
-- Idempotentní: SET DEFAULT lze spustit opakovaně.

ALTER TABLE team_member ALTER COLUMN role SET DEFAULT 'partner';

INSERT INTO schema_migration (version, note)
VALUES ('0056', 'team_member.role default vedeni -> partner (least privilege)')
ON CONFLICT (version) DO NOTHING;
