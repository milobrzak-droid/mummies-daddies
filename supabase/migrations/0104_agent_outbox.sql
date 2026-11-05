-- 0104 — agent_outbox: REZERVOVÁNO pro balík P3 — odchozí fronta agent_outbox (RPC agent_outbox_enqueue/claim/confirm).
--
-- Zástupce založený základovým balíkem, aby čísla migrací zůstala souvislá
-- (test/migrations-lint.test.ts) i při paralelní práci balíků. Obsah dopíše
-- jen vlastník (P3); ostatní balíky tento soubor nemění. Až do té doby
-- migrace jen zapíše svou verzi do ledgeru.

INSERT INTO schema_migration (version, note)
VALUES ('0104', 'rezervovano pro P3: agent_outbox')
ON CONFLICT (version) DO NOTHING;
