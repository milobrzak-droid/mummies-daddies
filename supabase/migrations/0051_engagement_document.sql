-- 0051 — engagement_document: odkazy na firemní dokumenty v SharePointu.
--
-- Rozhodnutí vlastníka 2026-09-28: firemní dokumenty žijí v SharePointu/
-- Teams. Cockpit ukládá jen odkaz + metadata, NIKDY obsah (plan kap. 8:
-- „metadata a vazba na milník, ne obsah"). Proto tady není žádný sloupec
-- na obsah/přílohu — jen title, url (musí mířit na *.sharepoint.com) a kind.
--
-- milestone_id: vazba na engagement_milestone je žádoucí (plan kap. 8), ale
-- ta tabulka je zatím v NEAPLIKOVANÉ migraci 0042 — FK na ni by tuhle
-- migraci taky zablokovala. Sloupec je proto zatím nullable bigint BEZ FK;
-- FK (REFERENCES engagement_milestone(id) ON DELETE SET NULL) se doplní
-- samostatnou migrací, až bude 0042 aplikovaná.
--
-- Idempotentní (IF NOT EXISTS, DROP POLICY IF EXISTS, ON CONFLICT).

CREATE TABLE IF NOT EXISTS engagement_document (
  id             bigserial PRIMARY KEY,
  engagement_id  bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  -- Bez FK, dokud není aplikovaná 0042_engagement_milestone.sql — viz komentář výše.
  milestone_id   bigint,
  title          text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  -- Jen odkaz do SharePointu — nikdy nahraný soubor (kap. 8: metadata, ne obsah).
  url            text NOT NULL CHECK (url ~ '^https://[a-z0-9-]+\.sharepoint\.com/'),
  kind           text NOT NULL DEFAULT 'jine'
                 CHECK (kind IN ('podklad', 'vystup', 'smlouva', 'jine')),
  created_by     uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN engagement_document.milestone_id IS
  'Vazba na engagement_milestone.id — zatím bez FK, protože 0042_engagement_milestone.sql není aplikovaná. FK doplnit samostatnou migrací, až bude.';

CREATE INDEX IF NOT EXISTS engagement_document_engagement_idx
  ON engagement_document(engagement_id);
CREATE INDEX IF NOT EXISTS engagement_document_milestone_idx
  ON engagement_document(milestone_id) WHERE milestone_id IS NOT NULL;

ALTER TABLE engagement_document ENABLE ROW LEVEL SECURITY;

-- Domácí styl (0003 + 0007): permisivní pro člena týmu + RESTRICTIVE AAL2.
DROP POLICY IF EXISTS biz_all ON engagement_document;
CREATE POLICY biz_all ON engagement_document
  FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());

DROP POLICY IF EXISTS require_aal2 ON engagement_document;
CREATE POLICY require_aal2 ON engagement_document
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON engagement_document FROM anon;

INSERT INTO schema_migration (version, note)
VALUES ('0051', 'engagement_document - odkazy na SharePoint dokumenty (metadata, ne obsah)')
ON CONFLICT (version) DO NOTHING;
