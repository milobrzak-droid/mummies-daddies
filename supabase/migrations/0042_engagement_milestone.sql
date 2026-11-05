-- 0042 — engagement_milestone: plán milníků dodávky se stavem a akceptací.
--
-- ROZHODNUTÍ VLASTNÍKA 2026-09-28: Delivery Standard (EDS v1.1) je SCHVÁLENÝ
-- v aktuálním znění (docs/PROVOZ.md, kap. 6). Tahle migrace dodává
-- milník, vlastníka/zástupce, šest stavů, akceptaci a FK dokumentu na milník.
-- NEAPLIKOVÁNO na živou DB.
--
-- Vazba na šest kvalitativních bran (0023) ZÁMĚRNĚ NENÍ: brány v 0023 jsou
-- šest boolean sloupců na `engagement` a hodnotí DODÁVKU jako celek (EDS §13
-- — „závěrečná kontrola dodávky", kap. 6), ne jednotlivý milník. Per-milník
-- brány by znamenaly buď kopii šesti sloupců na každý milník (brána „peer
-- learning" nemá u milníku „procesní mapa" smysl), nebo nový model bran
-- (tabulka gate_check) — obojí mimo schválené znění. Milníky a brány proto
-- žijí vedle sebe: milník uzavírá akceptace klientem, dodávku uzavírá šest
-- bran (domain/delivery/deliveryGates.ts). Fakturační podklady taky ne.
--
-- Stavy (kap. 6): připraveno / v práci / čeká na vstup / čeká na schválení /
-- přijato / uzavřeno. Text + CHECK, ne enum (stejně jako 0033/0038): přidání
-- stavu je výměna CHECKu. Hodnoty drží ručně synchronně
-- domain/delivery/milestone.ts (MILESTONE_STATUSES, test hlídá seznam).
--
-- Invariant „Odesláno ≠ přijato": dokument odeslaný klientovi ještě není
-- přijatý. Stav 'prijato' (a 'uzavreno', který akceptaci předpokládá —
-- „teprve potvrzená akceptace uzavírá milník", kap. 7) proto vyžaduje
-- accepted_at A evidenci akceptace (0038 — id e-mailu/schůzky/souboru).
-- Evidence je trvalý doklad bez osobních údajů, proto je povinná právě ona.
-- accepted_by_contact_id je jen informační: ON DELETE SET NULL, aby GDPR
-- výmaz kontaktu klienta nebyl zablokovaný milníkem (RESTRICT by výmaz
-- znemožnil) — akceptace přitom zůstane doložená evidencí. Vynuceno CHECKem,
-- takže to platí pro INSERT i UPDATE a nejde obejít service-role klientem. Pořadí
-- přechodů (graf) hlídá čistá funkce v TS; v DB jen tvrdý invariant.
--
-- owner/deputy jsou nullable: vlastníka lze doplnit až při předání
-- (validateHandoff v TS ho pak hlásí jako chybějící). ON DELETE SET NULL —
-- odchod člena týmu nesmaže milník.
--
-- engagement_document.milestone_id (0051, aplikovaná) dosud neměl FK, protože
-- tahle tabulka neexistovala. Tady ho doplníme (ON DELETE SET NULL — smazání
-- milníku nesmaže odkaz na dokument v SharePointu) hlídaný to_regclass,
-- aby 0042 šla aplikovat i na DB bez 0051. Osiřelé hodnoty (id milníku, který
-- nikdy neexistoval) se před přidáním FK vynulují. FK neumí hlídat, že milník
-- patří ke STEJNÉ dodávce jako dokument — to dělá trigger
-- engagement_document_milestone_guard (SQLSTATE 23514 check_violation).
--
-- Idempotentní (IF NOT EXISTS, DROP ... IF EXISTS, ON CONFLICT, kontrola
-- pg_constraint před ADD CONSTRAINT).

-- ZÁVISLOST: acceptance_evidence_id odkazuje na evidence z 0038.
DO $$
BEGIN
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0042 vyžaduje tabulku public.evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS engagement_milestone (
  id                      bigserial PRIMARY KEY,
  engagement_id           bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  title                   text NOT NULL,
  owner_id                uuid REFERENCES team_member(id) ON DELETE SET NULL,
  deputy_id               uuid REFERENCES team_member(id) ON DELETE SET NULL,
  status                  text NOT NULL DEFAULT 'pripraveno',
  due_on                  date,
  accepted_at             timestamptz,
  accepted_by_contact_id  bigint REFERENCES contact(id) ON DELETE SET NULL,
  acceptance_evidence_id  bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_milestone_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT engagement_milestone_status_check
    CHECK (status IN ('pripraveno', 'v_praci', 'ceka_na_vstup',
                      'ceka_na_schvaleni', 'prijato', 'uzavreno')),
  -- Zástupce není tentýž člověk jako vlastník (zastupitelnost, kap. 6).
  CONSTRAINT engagement_milestone_deputy_check
    CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id),
  -- „Odesláno ≠ přijato".
  CONSTRAINT engagement_milestone_acceptance_check
    CHECK (status NOT IN ('prijato', 'uzavreno')
           OR (accepted_at IS NOT NULL AND acceptance_evidence_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS engagement_milestone_engagement_idx
  ON engagement_milestone(engagement_id);
CREATE INDEX IF NOT EXISTS engagement_milestone_owner_open_idx
  ON engagement_milestone(owner_id, due_on) WHERE status <> 'uzavreno';

-- set_updated_at() existuje od 0006.
DROP TRIGGER IF EXISTS engagement_milestone_set_updated_at ON engagement_milestone;
CREATE TRIGGER engagement_milestone_set_updated_at BEFORE UPDATE ON engagement_milestone
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE engagement_milestone ENABLE ROW LEVEL SECURITY;

-- Domácí styl (0003 + 0007): permisivní pro člena týmu + RESTRICTIVE AAL2.
DROP POLICY IF EXISTS biz_all ON engagement_milestone;
CREATE POLICY biz_all ON engagement_milestone
  FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());

DROP POLICY IF EXISTS require_aal2 ON engagement_milestone;
CREATE POLICY require_aal2 ON engagement_milestone
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON engagement_milestone FROM anon;

-- FK engagement_document.milestone_id → engagement_milestone(id) (viz hlavička).
DO $$
BEGIN
  IF to_regclass('public.engagement_document') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'engagement_document_milestone_id_fkey'
      AND conrelid = 'public.engagement_document'::regclass
  ) THEN
    UPDATE engagement_document d SET milestone_id = NULL
    WHERE d.milestone_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM engagement_milestone m WHERE m.id = d.milestone_id);
    ALTER TABLE engagement_document
      ADD CONSTRAINT engagement_document_milestone_id_fkey
      FOREIGN KEY (milestone_id) REFERENCES engagement_milestone(id) ON DELETE SET NULL;
  END IF;
  COMMENT ON COLUMN engagement_document.milestone_id IS
    'Vazba na engagement_milestone.id (FK ON DELETE SET NULL z 0042); milník musí patřit ke stejné dodávce (trigger engagement_document_milestone_guard).';
END $$;

-- Dokument smí odkazovat jen na milník své dodávky. SECURITY INVOKER: čte
-- engagement_milestone pod RLS volajícího (člen týmu ji vidí celou).
CREATE OR REPLACE FUNCTION engagement_document_milestone_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM engagement_milestone m
    WHERE m.id = NEW.milestone_id AND m.engagement_id = NEW.engagement_id
  ) THEN
    RAISE EXCEPTION 'milník % nepatří k dodávce %', NEW.milestone_id, NEW.engagement_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.engagement_document') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS engagement_document_milestone_guard ON engagement_document;
    CREATE TRIGGER engagement_document_milestone_guard
      BEFORE INSERT OR UPDATE OF milestone_id, engagement_id ON engagement_document
      FOR EACH ROW EXECUTE FUNCTION engagement_document_milestone_guard();
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0042', 'engagement_milestone - stavy milniku, akceptace (odeslano != prijato), FK engagement_document.milestone_id; EDS schvalen 2026-09-28')
ON CONFLICT (version) DO NOTHING;
