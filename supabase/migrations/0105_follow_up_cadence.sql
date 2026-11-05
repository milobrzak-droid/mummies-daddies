-- 0105 — follow_up_cadence: REZERVOVÁNO pro balík P4 — follow-up cadence (follow_up_attempt, follow_up_facts).
--
-- Zástupce založený základovým balíkem, aby čísla migrací zůstala souvislá
-- (test/migrations-lint.test.ts) i při paralelní práci balíků. Obsah dopíše
-- jen vlastník (P4); ostatní balíky tento soubor nemění. Až do té doby
-- migrace jen zapíše svou verzi do ledgeru.

INSERT INTO schema_migration (version, note)
VALUES ('0105', 'rezervovano pro P4: follow_up_cadence')
ON CONFLICT (version) DO NOTHING;
