-- 0071 — work_case.node: CHECK s výčtem nahradit FK na loop_node(node).
--
-- PROČ: recenze 0067 (case_proposal) upozornila, že case_proposal.node
-- validuje uzel přes FK na loop_node(node) (tenant-data, viz 0067 hlavička
-- a config/mummiesDaddies.ts komentář „capabilities"), ale work_case.node — tabulka,
-- do které accept_case_proposal() návrh zapisuje — dál validuje přes
-- work_case_node_check, pevný výčet čtyř hodnot firmy (0039). Pokud by
-- budoucí migrace rozšířila loop_node o uzel druhé firmy (a odpovídající
-- CHECK na loop_node), case_proposal by pro ten uzel návrh přijala, ale
-- accept_case_proposal() by při INSERT INTO work_case spadl na 23514 —
-- návrhy druhé firmy by se nikdy nedaly přijmout. Tahle migrace sjednocuje
-- zdroj pravdy: work_case.node bude ověřovat stejnou FK jako case_proposal,
-- takže obě tabulky se rozejít nemůžou.
--
-- CO NEMĚNÍ: loop_node.node má dál svůj vlastní loop_node_node_check
-- (0039) — rozšíření uzlů pro druhou firmu (SQL kopie hodnot z
-- config/*.ts) zůstává budoucí prací, jak popisuje config/mummiesDaddies.ts
-- a config/mummiesDaddies.ts. Pro současný provoz (jen jedna firma, 4 uzly v loop_node)
-- se chování nemění — FK povoluje přesně ty hodnoty, co dřív CHECK.
--
-- IDEMPOTENCE: DROP CONSTRAINT IF EXISTS + přidání FK jen když chybí
-- (podle pg_constraint, ne podle jména), ať opakovaný běh nic nezmění.
--
-- BEZPEČNOST PRO DATA: mění jen CHECK/FK na existujícím sloupci, žádná
-- data se nepřepisují. Stávající řádky work_case mají node z původního
-- výčtu, který je podmnožinou loop_node (seedováno v 0039) — FK projde.
--
-- ZÁVISLOSTI: 0039 (work_case, loop_node), 0067 (case_proposal —
-- motivace téhle migrace).

DO $$
BEGIN
  IF to_regclass('public.work_case') IS NULL OR to_regclass('public.loop_node') IS NULL THEN
    RAISE EXCEPTION '0071 vyžaduje work_case a loop_node — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
END $$;

ALTER TABLE work_case DROP CONSTRAINT IF EXISTS work_case_node_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
     WHERE con.conrelid = 'public.work_case'::regclass
       AND con.conname = 'work_case_node_fkey'
  ) THEN
    ALTER TABLE work_case
      ADD CONSTRAINT work_case_node_fkey FOREIGN KEY (node) REFERENCES loop_node(node);
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0071', 'work_case.node: CHECK vyctu nahrazen FK na loop_node(node), aby se nerozesla s case_proposal.node (0067) — recenze ch11-first-capability')
ON CONFLICT (version) DO NOTHING;
