-- 0103 — inquiry_agent: REZERVOVÁNO pro balík P2 — inbound agent (fronta inquiry_agent_run, RPC inquiry_agent_found).
--
-- Zástupce založený základovým balíkem, aby čísla migrací zůstala souvislá
-- (test/migrations-lint.test.ts) i při paralelní práci balíků. Obsah dopíše
-- jen vlastník (P2); ostatní balíky tento soubor nemění. Až do té doby
-- migrace jen zapíše svou verzi do ledgeru.

INSERT INTO schema_migration (version, note)
VALUES ('0103', 'rezervovano pro P2: inquiry_agent')
ON CONFLICT (version) DO NOTHING;
