-- 0106 — web: REZERVOVÁNO pro balík P6 — veřejný web (stav objednávky shop_order, další potřeby webu).
--
-- Zástupce založený základovým balíkem, aby čísla migrací zůstala souvislá
-- (test/migrations-lint.test.ts) i při paralelní práci balíků. Obsah dopíše
-- jen vlastník (P6); ostatní balíky tento soubor nemění. Až do té doby
-- migrace jen zapíše svou verzi do ledgeru.

INSERT INTO schema_migration (version, note)
VALUES ('0106', 'rezervovano pro P6: web')
ON CONFLICT (version) DO NOTHING;
