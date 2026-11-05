-- 0055 — seed cílových seznamů.
--
-- Mummies and Daddies zatím cílové seznamy nepoužívá (outbound = fáze 2),
-- proto migrace žádný seznam nezakládá. Číslo zůstává, aby řada migrací
-- byla souvislá (test/migrations-lint.test.ts). Seznamy založí obchod
-- v UI, až modul zapne (CompanyConfig.modules.targetLists).

INSERT INTO schema_migration (version, note)
VALUES ('0055', 'seed cilovych seznamu - zadny (outbound je faze 2)')
ON CONFLICT (version) DO NOTHING;
