-- 0049 — nové fáze obchodu (kapitola 5), krok 1 ze 2: rozšíření enumu.
--
-- Rozhodnutí vedení 28. 9. 2026 (docs/PROVOZ.md, 5.1–5.3):
--   kvalifikace → diagnostika → rozsah_nabidka → rozhodovani
--   → vyhráno / prohráno / odloženo
--
-- Postup expand → backfill → switch:
--   0049 (tenhle soubor) jen PŘIDÁ čtyři nové hodnoty do enumu deal_stage.
--   0050 převede existující obchody na nové hodnoty, přepne výchozí hodnotu
--        sloupce a opraví v_pipeline_by_line.
--   Kód (DEAL_STAGES v lib/domain.ts) se nasazuje AŽ po 0049 + 0050.
--
-- Proč dva soubory: ALTER TYPE … ADD VALUE smí od Postgresu 12 běžet
-- v transakci (scripts/migrate.mjs každý soubor obaluje BEGIN/COMMIT), ale
-- nově přidanou hodnotu nejde POUŽÍT (UPDATE, DEFAULT, porovnání v pohledu)
-- dřív, než se ta transakce potvrdí — Postgres by hlásil „unsafe use of new
-- value". Backfill proto musí být samostatný soubor v samostatné transakci.
-- Při ručním spuštění v SQL editoru Supabase: 0049 a 0050 spustit JAKO DVA
-- SAMOSTATNÉ BĚHY, ne vložit oba soubory najednou (editor celé vložení
-- pouští jako jednu transakci). 0050 to hlídá a skončí srozumitelnou chybou.
--
-- Staré hodnoty (lead, proběhlo_jednání, nabídka, vyjednávání) v enumu
-- ZŮSTÁVAJÍ — Postgres hodnotu enumu odebrat neumí (jen přes nový typ
-- a přepsání sloupce, pohledů a funkcí, což za pět obchodů nestojí).
-- Po 0050 je nic nepoužívá; aplikace je při čtení pro jistotu převádí
-- (lib/dealStageLegacy.ts).
--
-- Pořadí: nové hodnoty se řadí před 'vyhráno', takže ORDER BY stage dává
-- staré otevřené, nové otevřené, pak zavřené. IF NOT EXISTS = idempotentní.
-- Zámky: ADD VALUE bere jen krátký zámek na katalog typu, data nepřepisuje.

ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'kvalifikace' BEFORE 'vyhráno';
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'diagnostika' BEFORE 'vyhráno';
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'rozsah_nabidka' BEFORE 'vyhráno';
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'rozhodovani' BEFORE 'vyhráno';

INSERT INTO schema_migration (version, note)
VALUES ('0049', 'deal_stage: nove faze kvalifikace, diagnostika, rozsah_nabidka, rozhodovani (expand, stare hodnoty zustavaji nepouzite)')
ON CONFLICT (version) DO NOTHING;
