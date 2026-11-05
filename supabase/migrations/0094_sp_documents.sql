-- 0094 — dokumenty dodávek v SharePointu: identita položky, verze, typ,
-- stav (koncept / schváleno / odesláno / přijato) a denní hlídání změn.
--
-- PROČ: dosud byl dokument dodávky jen ručně vložený odkaz (0051). Cockpit
-- z něj neuměl poznat, KTERÝ soubor to je (odkaz se dá přejmenovat, sdílecí
-- odkaz zrušit), KTERÁ verze je schválená ani že se schválená nabídka po
-- schválení potichu změnila nebo zmizela. Revize kap. 2E: „identita souboru
-- a verze, schválená finální verze, sledování změn a práva".
--
-- CO SE UKLÁDÁ (jen metadata, NIKDY obsah souboru — jako 0051):
--   engagement_document
--     drive_id + item_id   trvalá identita položky v Microsoft Graph (obě, nebo
--                          žádná; doplní je Cockpit z Graphu při vložení odkazu),
--     doc_type             nabídka / procesní mapa / zápis / předávací balíček / jiné
--                          (vedle stávajícího `kind` = role dokumentu),
--     e_tag, c_tag,        aktuální verze podle Graphu (cTag se mění jen s
--     version_label,       obsahem, eTag i s metadaty; version_label je číslo
--     last_modified_at/by  verze v SharePointu, např. „3.0"),
--     source_state         ok / missing (soubor zmizel) / no_access (nemá přístup),
--     source_checked_at    kdy naposledy odpověděl Graph,
--     status               draft / approved / sent / accepted,
--     status_changed_at/by kdo a kdy stav změnil, approved_at/by/version_id =
--                          schválení a PŘIPÍCHNUTÁ verze, proti které se hlídá změna.
--   engagement_document_version   append-only záznam pozorovaných verzí (tabulka
--                          je vlastní historie, proto bez auditního triggeru — vzor
--                          evidence z 0038). Píše JEN server (servisní klíč) po
--                          ověření člena; klient má jen čtení, ať si verzi nikdo
--                          nepodvrhne.
--   engagement_document_finding   nález denní kontroly: dokument se od schválení
--                          změnil (changed) / zmizel (missing) / nemá přístup
--                          (no_access). Z nálezu vzniká úkol pro vlastníka a položka
--                          „Co se změnilo". Jeden OTEVŘENÝ nález na dokument a druh
--                          (nic se nezakládá dokola). Zapisuje server; člen smí jen
--                          uzavřít (resolved_*).
--   engagement_milestone.acceptance_document_version_id   milník přijatý klientem
--                          odkazuje na konkrétní verzi dokumentu, kterou klient
--                          přijal (vedle stávajícího dokladu akceptace 0042/0038).
--
-- STAVY A INVARIANTY (DB drží jen tvrdé věci; pořadí přechodů kontroluje i TS
-- domain/delivery/documents.ts):
--   * nový dokument od člověka vždy začíná jako koncept;
--   * přechody: koncept → schváleno, schváleno → koncept | odesláno,
--     odesláno → koncept | přijato; přijato je konec;
--   * „Odesláno ≠ přijato": stav přijato lidem projde jen u dokumentu navázaného
--     na milník, který je přijatý a nese doklad akceptace (0042);
--   * CHECK: koncept nemá schválení; schválený/odeslaný/přijatý ho má;
--   * kdo a kdy stav změnil (a kdo schválil) se doplní z auth.uid() při změně —
--     z klienta jde podvrhnout jen jako servisní klíč;
--   * připíchnutá verze musí patřit tomu samému dokumentu.
--
-- PRÁVA: nové sloupce dědí RLS engagement_document (člen týmu + RESTRICTIVE AAL2,
-- 0051). Nové tabulky: čtení člen týmu, RESTRICTIVE AAL2, klientům odebrané
-- zápisy (nález smí člen jen uzavřít — sloupcový GRANT + trigger).
--
-- AUDIT: trigger audit_row_change (0064) na engagement_document se PŘEDEFINUJE
-- s rozšířeným seznamem hodnot (typ, stav, kdo/kdy, připíchnutá verze, stav zdroje,
-- číslo verze); identita položky, eTag/cTag, kdo naposledy upravil soubor a odkaz
-- jdou jen názvem sloupce. source_checked_at se ignoruje (mění se každý den).
-- engagement_document_finding dostane měkký trigger (0082). Verzová tabulka
-- audit nemá (je sama append-only historií).
--
-- IDEMPOTENCE: ADD COLUMN IF NOT EXISTS, CHECKy a FK přes pg_constraint,
-- CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE + DROP TRIGGER/POLICY IF EXISTS,
-- ON CONFLICT. Stávající řádky se nepřepisují (dostanou výchozí typ „jiné" a
-- stav „koncept"). Zámky: ADD COLUMN bez přepisu tabulky, krátký zámek na
-- malých tabulkách.
--
-- ZÁVISLOSTI: 0051 (engagement_document), 0042 (engagement_milestone), 0006 (task),
-- 0064 (audit_row_change), 0082 (audit_row_change_soft), 0026 (ledger).

DO $$
BEGIN
  IF to_regclass('public.engagement_document') IS NULL THEN
    RAISE EXCEPTION '0094 vyžaduje tabulku public.engagement_document — nejdřív aplikujte 0051_engagement_document.sql';
  END IF;
  IF to_regclass('public.engagement_milestone') IS NULL THEN
    RAISE EXCEPTION '0094 vyžaduje tabulku public.engagement_milestone — nejdřív aplikujte 0042_engagement_milestone.sql';
  END IF;
  IF to_regclass('public.team_member') IS NULL OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0094 vyžaduje team_member a is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regclass('public.task') IS NULL THEN
    RAISE EXCEPTION '0094 vyžaduje tabulku public.task — nejdřív aplikujte 0006_tasks_and_calendar.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change()') IS NULL THEN
    RAISE EXCEPTION '0094 vyžaduje audit_row_change() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0094 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0094 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) engagement_document: identita, verze, typ, stav
-- ===========================================================================

ALTER TABLE engagement_document
  ADD COLUMN IF NOT EXISTS drive_id text,
  ADD COLUMN IF NOT EXISTS item_id text,
  ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'jine',
  ADD COLUMN IF NOT EXISTS e_tag text,
  ADD COLUMN IF NOT EXISTS c_tag text,
  ADD COLUMN IF NOT EXISTS version_label text,
  ADD COLUMN IF NOT EXISTS last_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_modified_by text,
  ADD COLUMN IF NOT EXISTS source_state text,
  ADD COLUMN IF NOT EXISTS source_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_by uuid REFERENCES team_member(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_version_id bigint,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES team_member(id) ON DELETE SET NULL;

COMMENT ON COLUMN engagement_document.drive_id IS
  'Microsoft Graph id knihovny (drive) souboru (0094). Spolu s item_id trvalá identita souboru; NULL = odkaz bez ověřené identity (Graph vypnutý nebo nedostupný).';
COMMENT ON COLUMN engagement_document.item_id IS
  'Microsoft Graph id položky (driveItem) v knihovně drive_id (0094).';
COMMENT ON COLUMN engagement_document.doc_type IS
  'Typ dokumentu: nabidka, procesni_mapa, zapis, predavaci_balicek, jine (0094). Vedle kind = role dokumentu v dodávce.';
COMMENT ON COLUMN engagement_document.c_tag IS
  'Graph cTag: mění se jen se změnou OBSAHU souboru; podle něj se pozná „jiná verze" (0094).';
COMMENT ON COLUMN engagement_document.e_tag IS
  'Graph eTag: mění se i se změnou metadat (0094); záloha, když cTag chybí.';
COMMENT ON COLUMN engagement_document.version_label IS
  'Číslo verze v SharePointu, např. 3.0 (0094); NULL, když ho Graph nevrátil.';
COMMENT ON COLUMN engagement_document.source_state IS
  'Poslední výsledek kontroly zdroje: ok, missing (soubor zmizel), no_access (nemá přístup); NULL = nikdy nezkontrolováno (0094).';
COMMENT ON COLUMN engagement_document.status IS
  'Stav dokumentu: draft, approved, sent, accepted (0094). Přijato jen přes milník s dokladem akceptace.';
COMMENT ON COLUMN engagement_document.approved_version_id IS
  'Verze (engagement_document_version), která byla schválena; proti ní denní kontrola hlídá změnu (0094).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_document_doc_type_check'
                 AND conrelid = 'public.engagement_document'::regclass) THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_doc_type_check
      CHECK (doc_type IN ('nabidka', 'procesni_mapa', 'zapis', 'predavaci_balicek', 'jine'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_document_status_check'
                 AND conrelid = 'public.engagement_document'::regclass) THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_status_check
      CHECK (status IN ('draft', 'approved', 'sent', 'accepted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_document_source_state_check'
                 AND conrelid = 'public.engagement_document'::regclass) THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_source_state_check
      CHECK (source_state IS NULL OR source_state IN ('ok', 'missing', 'no_access'));
  END IF;
  -- Identita je celá, nebo žádná; jen znaky, které Graph v id používá
  -- (id se vkládá do cesty URL — žádné lomítko, mezera ani otazník).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_document_identity_check'
                 AND conrelid = 'public.engagement_document'::regclass) THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_identity_check
      CHECK ((drive_id IS NULL AND item_id IS NULL)
             OR (drive_id IS NOT NULL AND item_id IS NOT NULL
                 AND drive_id ~ '^[A-Za-z0-9!_.=-]{1,255}$' AND item_id ~ '^[A-Za-z0-9!_.=-]{1,255}$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_document_tags_check'
                 AND conrelid = 'public.engagement_document'::regclass) THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_tags_check
      CHECK ((e_tag IS NULL OR char_length(e_tag) BETWEEN 1 AND 256)
             AND (c_tag IS NULL OR char_length(c_tag) BETWEEN 1 AND 256)
             AND (version_label IS NULL OR char_length(version_label) BETWEEN 1 AND 64)
             AND (last_modified_by IS NULL OR char_length(last_modified_by) BETWEEN 1 AND 200));
  END IF;
  -- Koncept nemá schválení; schválený, odeslaný i přijatý dokument ho má.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_document_approval_check'
                 AND conrelid = 'public.engagement_document'::regclass) THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_approval_check
      CHECK ((status = 'draft' AND approved_at IS NULL AND approved_by IS NULL AND approved_version_id IS NULL)
             OR (status <> 'draft' AND approved_at IS NOT NULL AND status_changed_at IS NOT NULL));
  END IF;
END $$;

-- Jeden soubor jen jednou v dodávce (jiný sdílecí odkaz na tentýž soubor = duplicita).
CREATE UNIQUE INDEX IF NOT EXISTS engagement_document_item_uidx
  ON engagement_document (engagement_id, drive_id, item_id) WHERE item_id IS NOT NULL;
-- Denní kontrola: schválené, odeslané a přijaté dokumenty s ověřenou identitou.
CREATE INDEX IF NOT EXISTS engagement_document_watch_idx
  ON engagement_document (id) WHERE item_id IS NOT NULL AND status <> 'draft';

-- ===========================================================================
-- 2) engagement_document_version — pozorované verze (append-only)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS engagement_document_version (
  id            bigserial PRIMARY KEY,
  document_id   bigint NOT NULL REFERENCES engagement_document(id) ON DELETE CASCADE,
  e_tag         text,
  c_tag         text,
  version_label text,
  modified_at   timestamptz,
  modified_by   text,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  -- 'user:<uuid>' nebo 'system:<úloha>' — kdo verzi zaznamenal.
  observed_by   text NOT NULL,
  reason        text NOT NULL,
  CONSTRAINT engagement_document_version_reason_check
    CHECK (reason IN ('linked', 'refreshed', 'approved', 'sync')),
  CONSTRAINT engagement_document_version_observed_by_check
    CHECK (observed_by ~ '^(user|system)(:[A-Za-z0-9._:@-]{1,128})?$'),
  CONSTRAINT engagement_document_version_known_check
    CHECK (e_tag IS NOT NULL OR c_tag IS NOT NULL OR version_label IS NOT NULL),
  CONSTRAINT engagement_document_version_lengths_check
    CHECK ((e_tag IS NULL OR char_length(e_tag) BETWEEN 1 AND 256)
           AND (c_tag IS NULL OR char_length(c_tag) BETWEEN 1 AND 256)
           AND (version_label IS NULL OR char_length(version_label) BETWEEN 1 AND 64)
           AND (modified_by IS NULL OR char_length(modified_by) BETWEEN 1 AND 200))
);

COMMENT ON TABLE engagement_document_version IS
  'Pozorované verze dokumentu dodávky (metadata z Graphu, ne obsah; 0094). Append-only, píše jen server po ověření člena.';

CREATE INDEX IF NOT EXISTS engagement_document_version_doc_idx
  ON engagement_document_version (document_id, observed_at DESC);

ALTER TABLE engagement_document_version ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS engagement_document_version_read ON engagement_document_version;
CREATE POLICY engagement_document_version_read ON engagement_document_version
  FOR SELECT USING (is_team_member());

DROP POLICY IF EXISTS require_aal2 ON engagement_document_version;
CREATE POLICY require_aal2 ON engagement_document_version
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON engagement_document_version FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON engagement_document_version FROM authenticated;
GRANT SELECT ON engagement_document_version TO authenticated;

-- FK z dokumentu na schválenou verzi (po vytvoření tabulky).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_document_approved_version_fkey'
                 AND conrelid = 'public.engagement_document'::regclass) THEN
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_approved_version_fkey
      FOREIGN KEY (approved_version_id) REFERENCES engagement_document_version(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS engagement_document_approved_version_idx
  ON engagement_document (approved_version_id) WHERE approved_version_id IS NOT NULL;

-- ===========================================================================
-- 3) engagement_document_finding — nálezy denní kontroly
-- ===========================================================================

CREATE TABLE IF NOT EXISTS engagement_document_finding (
  id          bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES engagement_document(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  -- U „changed" verze, kterou kontrola viděla; jinak NULL.
  version_id  bigint REFERENCES engagement_document_version(id) ON DELETE SET NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  -- Úkol pro vlastníka, který nález založil (NULL, když nebylo komu ho dát).
  task_id     bigint REFERENCES task(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES team_member(id) ON DELETE SET NULL,
  resolution  text,
  CONSTRAINT engagement_document_finding_kind_check
    CHECK (kind IN ('changed', 'missing', 'no_access')),
  CONSTRAINT engagement_document_finding_resolution_check
    CHECK ((resolved_at IS NULL AND resolution IS NULL AND resolved_by IS NULL)
           OR (resolved_at IS NOT NULL AND resolution IS NOT NULL AND resolution IN ('reapproved', 'draft', 'auto')))
);

COMMENT ON TABLE engagement_document_finding IS
  'Nález denní kontroly dokumentu dodávky: změnil se od schválení / zmizel / nemá přístup (0094). Zapisuje server; člen smí jen uzavřít.';

-- Jeden otevřený nález na dokument a druh.
CREATE UNIQUE INDEX IF NOT EXISTS engagement_document_finding_open_uidx
  ON engagement_document_finding (document_id, kind) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS engagement_document_finding_detected_idx
  ON engagement_document_finding (detected_at DESC);
CREATE INDEX IF NOT EXISTS engagement_document_finding_version_idx
  ON engagement_document_finding (version_id) WHERE version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS engagement_document_finding_task_idx
  ON engagement_document_finding (task_id) WHERE task_id IS NOT NULL;

ALTER TABLE engagement_document_finding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS engagement_document_finding_read ON engagement_document_finding;
CREATE POLICY engagement_document_finding_read ON engagement_document_finding
  FOR SELECT USING (is_team_member());

DROP POLICY IF EXISTS engagement_document_finding_resolve ON engagement_document_finding;
CREATE POLICY engagement_document_finding_resolve ON engagement_document_finding
  FOR UPDATE USING (is_team_member()) WITH CHECK (is_team_member());

DROP POLICY IF EXISTS require_aal2 ON engagement_document_finding;
CREATE POLICY require_aal2 ON engagement_document_finding
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON engagement_document_finding FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON engagement_document_finding FROM authenticated;
GRANT SELECT ON engagement_document_finding TO authenticated;
-- Člen smí jen uzavřít nález; nic dalšího na něm změnit nejde.
GRANT UPDATE (resolved_at, resolved_by, resolution) ON engagement_document_finding TO authenticated;

-- Uzavření z klienta: kdo uzavřel se doplní z auth.uid(); uzavřený nález se
-- znovu neotevře. Servisní klíč (auth.uid() je NULL) je vyjmutý.
CREATE OR REPLACE FUNCTION engagement_document_finding_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'uzavřený nález dokumentu nejde změnit' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolved_at IS NOT NULL THEN
    NEW.resolved_by := auth.uid();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS engagement_document_finding_guard ON engagement_document_finding;
CREATE TRIGGER engagement_document_finding_guard
  BEFORE UPDATE ON engagement_document_finding
  FOR EACH ROW EXECUTE FUNCTION engagement_document_finding_guard();

REVOKE ALL ON FUNCTION engagement_document_finding_guard() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 4) Strážce stavu dokumentu
-- ===========================================================================

-- SECURITY INVOKER: čte engagement_milestone a engagement_document_version pod
-- RLS volajícího (člen týmu je vidí). Servisní klíč (auth.uid() je NULL) smí
-- vše, co projde CHECKy — kontrola sama nic nemění na stavu.
CREATE OR REPLACE FUNCTION engagement_document_workflow_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_uid IS NOT NULL AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'nový dokument dodávky začíná jako koncept' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Připíchnutá verze musí patřit tomuto dokumentu.
  IF NEW.approved_version_id IS NOT NULL
     AND NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id
     AND NOT EXISTS (
       SELECT 1 FROM engagement_document_version v
       WHERE v.id = NEW.approved_version_id AND v.document_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'verze % nepatří k dokumentu %', NEW.approved_version_id, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF v_uid IS NOT NULL AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'approved')
      OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sent'))
      OR (OLD.status = 'sent' AND NEW.status IN ('draft', 'accepted'))
    ) THEN
      RAISE EXCEPTION 'přechod stavu dokumentu % → % není povolený', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    -- „Odesláno ≠ přijato": přijetí lidem projde jen s dokladem akceptace milníku.
    IF v_uid IS NOT NULL AND NEW.status = 'accepted' AND NOT EXISTS (
         SELECT 1 FROM engagement_milestone m
         WHERE m.id = NEW.milestone_id AND m.engagement_id = NEW.engagement_id
           AND m.status IN ('prijato', 'uzavreno') AND m.acceptance_evidence_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'dokument je přijatý jen s dokladem akceptace milníku' USING ERRCODE = 'check_violation';
    END IF;
    IF v_uid IS NOT NULL THEN
      NEW.status_changed_at := now();
      NEW.status_changed_by := v_uid;
    ELSE
      NEW.status_changed_at := coalesce(NEW.status_changed_at, now());
    END IF;
    IF NEW.status = 'draft' THEN
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
      NEW.approved_version_id := NULL;
    ELSIF OLD.status = 'draft' THEN
      NEW.approved_at := now();
      IF v_uid IS NOT NULL THEN
        NEW.approved_by := v_uid;
      END IF;
    END IF;
  ELSIF NEW.status <> 'draft'
        AND NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id
        AND v_uid IS NOT NULL THEN
    -- Nové schválení aktuální verze (po změně souboru): posune základ kontroly.
    NEW.approved_at := now();
    NEW.approved_by := v_uid;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS engagement_document_workflow_guard ON engagement_document;
CREATE TRIGGER engagement_document_workflow_guard
  BEFORE INSERT OR UPDATE ON engagement_document
  FOR EACH ROW EXECUTE FUNCTION engagement_document_workflow_guard();

REVOKE ALL ON FUNCTION engagement_document_workflow_guard() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 5) Milník: verze dokumentu, kterou klient přijal
-- ===========================================================================

ALTER TABLE engagement_milestone
  ADD COLUMN IF NOT EXISTS acceptance_document_version_id bigint
  REFERENCES engagement_document_version(id) ON DELETE SET NULL;

COMMENT ON COLUMN engagement_milestone.acceptance_document_version_id IS
  'Konkrétní verze dokumentu, kterou klient přijal (0094). Doplňuje doklad akceptace (acceptance_evidence_id, 0038/0042); NULL = verze nebyla známá.';

CREATE INDEX IF NOT EXISTS engagement_milestone_acceptance_version_idx
  ON engagement_milestone (acceptance_document_version_id) WHERE acceptance_document_version_id IS NOT NULL;

-- ===========================================================================
-- 6) Audit
-- ===========================================================================

-- engagement_document: tvrdý trigger z 0064 s rozšířeným seznamem hodnot.
-- Identita (drive_id, item_id), eTag/cTag, kdo soubor naposledy upravil a
-- odkaz jsou jen názvem sloupce; source_checked_at se každý den mění → ignorovat.
DROP TRIGGER IF EXISTS audit_row_change ON engagement_document;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON engagement_document
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'approved_at,approved_by,approved_version_id,created_by,doc_type,engagement_id,kind,milestone_id,source_state,status,status_changed_at,status_changed_by,version_label',
    'source_checked_at',
    '');

-- engagement_document_finding: nová tabulka → měkký trigger (0082).
DROP TRIGGER IF EXISTS audit_row_change_soft ON engagement_document_finding;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON engagement_document_finding
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'detected_at,document_id,kind,resolution,resolved_at,resolved_by,task_id,version_id',
    '',
    '',
    '');

-- Kontrola konfigurace proti schématu (jako 0064/0082/0084): jen ohlásí.
DO $$
DECLARE
  v_problem text;
BEGIN
  FOR v_problem IN
    SELECT format('%s.%s', c.relname, col.name)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
    CROSS JOIN LATERAL unnest(string_to_array(encode(t.tgargs, 'escape'), '\000')) AS arg(value)
    CROSS JOIN LATERAL unnest(string_to_array(arg.value, ',')) AS col(name)
    WHERE t.tgname IN ('audit_row_change', 'audit_row_change_soft') AND NOT t.tgisinternal AND col.name <> ''
      AND c.relname IN ('engagement_document', 'engagement_document_finding')
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute att
        WHERE att.attrelid = c.oid AND att.attname = col.name AND att.attnum > 0 AND NOT att.attisdropped
      )
  LOOP
    RAISE WARNING '0094: audit trigger odkazuje na neexistující sloupec %', v_problem;
  END LOOP;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0094', 'dokumenty dodavek v SharePointu: identita polozky (drive+item), verze (eTag/cTag, cislo verze, kdo a kdy zmenil), typ dokumentu, stav draft/approved/sent/accepted, engagement_document_version (pozorovane verze), engagement_document_finding (zmena od schvaleni, zmizel, bez pristupu), verze dokumentu prijata milnikem; audit engagement_document rozsiren, finding mekky trigger')
ON CONFLICT (version) DO NOTHING;
