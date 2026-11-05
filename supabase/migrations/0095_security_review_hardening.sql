-- 0095 — zpevnění z bezpečnostní revize 30. 9. 2026 (nálezy D1 a D3).
--
-- PROČ
--   D1  engagement_document (0094): strážce hlídal jen stav, schválení a
--       připíchnutou verzi. Identitu položky (drive_id, item_id) a pozorovanou
--       verzi zdroje (e_tag, c_tag, version_label, last_modified_*, source_state,
--       source_checked_at) mohl kterýkoli člen týmu (i lektor) přepsat přímo
--       přes PostgREST. Tím by šla zmást denní kontrola „změnilo se od
--       schválení" (hodnoty schválené verze se dají dopsat ručně) nebo
--       přesměrovat serverová synchronizace na jinou položku, kterou token
--       synchronizace vidí. Hlavička 0094 říká, že identitu doplní Cockpit z
--       Graphu, ale databáze to nevynucovala.
--   D3  auto_intake_dismiss (0086) smí kterákoli obchodní role u kteréhokoli
--       automaticky založeného obchodu. Obchod, na kterém už proběhla práce
--       (jiná fáze než Kvalifikace, nebo vyplněná částka), překlopil do
--       Prohráno, vynuloval pravděpodobnost i další krok, zavřel úkol a firmu
--       odložil o rok. Přitom „Není poptávka" má být cesta pro nedotčené
--       obchody, ne způsob, jak zrušit cizí rozjednanou práci.
--
-- CO SE MĚNÍ
--   1) engagement_document_workflow_guard (CREATE OR REPLACE, stejný podpis a
--      stejný trigger z 0094): pro přihlášeného uživatele (auth.uid() není NULL)
--      platí navíc
--        * INSERT: pole identity a pozorované verze zdroje musí zůstat prázdná,
--        * UPDATE: tato pole se nesmí změnit.
--      Servisní klíč a systémový aktér (auth.uid() je NULL: denní kontrola,
--      synchronizace, serverové akce po ověření člena) je smí zapisovat dál.
--      Uživatel dál smí měnit typ (doc_type), stav a připíchnutou verzi
--      přes stávající akce; ty teď identitu a verzi zdroje zapisují servisním
--      klíčem po ověření člena (domain/delivery/actions/documents.ts).
--      Hlídaná pole: drive_id, item_id, e_tag, c_tag, version_label,
--      last_modified_at, last_modified_by, source_state, source_checked_at.
--      Výjimka: check_violation (23514) s věcnou hláškou.
--   2) auto_intake_dismiss (CREATE OR REPLACE, stejný podpis, práva a návratový
--      tvar): obchod, který už není v Kvalifikaci nebo má vyplněnou částku,
--      se NEPŘEPÍŠE na Prohráno; funkce skončí výjimkou AI003 (DETAIL
--      deal_moved) a nezmění nic (ani úkol, ani firmu, ani záznam poptávky).
--      Stejná definice „práce" jako u Zpět v 0086 (auto_intake_undo).
--      Nedotčený obchod, prohraný obchod (already_lost) i vyhraný (AI002) se
--      chovají jako dřív.
--
-- AUDIT: žádný nový trigger ani tabulka; audit_row_change na engagement_document
-- z 0094 zůstává (registr core/auditCoverage.ts se nemění). Zápisy servisním
-- klíčem nesou aktéra přes hlavičku x-cockpit-audit-actor (0064).
--
-- IDEMPOTENCE: CREATE OR REPLACE FUNCTION, REVOKE/GRANT, ON CONFLICT. Data se
-- nemění; stávající řádky se nepřepisují. Nový zámek jen na okamžik výměny
-- funkcí.
--
-- ZÁVISLOSTI: 0094 (engagement_document_workflow_guard, sloupce identity a
-- verze), 0086 (auto_intake_dismiss), 0039 (loop_actor), 0020 (can_see_sales,
-- deal.lost_reason/closed_at/forecast_category), 0026 (ledger). Guard níže
-- skončí srozumitelnou chybou.

DO $$
BEGIN
  IF to_regclass('public.engagement_document') IS NULL
     OR to_regprocedure('public.engagement_document_workflow_guard()') IS NULL THEN
    RAISE EXCEPTION '0095 vyžaduje engagement_document a jeho strážce — nejdřív aplikujte 0094_sp_documents.sql';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'engagement_document'
         AND column_name IN ('drive_id', 'item_id', 'e_tag', 'c_tag', 'version_label', 'last_modified_at',
                             'last_modified_by', 'source_state', 'source_checked_at', 'status', 'approved_version_id')) <> 11 THEN
    RAISE EXCEPTION '0095 vyžaduje sloupce identity a verze dokumentu — nejdřív aplikujte 0094_sp_documents.sql';
  END IF;
  IF to_regprocedure('public.auto_intake_dismiss(bigint)') IS NULL THEN
    RAISE EXCEPTION '0095 vyžaduje funkci auto_intake_dismiss — nejdřív aplikujte 0086_intake_not_inquiry.sql';
  END IF;
  IF to_regprocedure('public.loop_actor()') IS NULL OR to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0095 vyžaduje loop_actor() a can_see_sales() — nejdřív aplikujte 0039 a 0020';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'deal'
         AND column_name IN ('amount_one_time', 'lost_reason', 'closed_at', 'forecast_category', 'probability_pct', 'next_step', 'next_step_due')) <> 7 THEN
    RAISE EXCEPTION '0095 vyžaduje sloupce obchodu z migrací 0001, 0020 a 0021 — nejdřív aplikujte starší migrace';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0095 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) engagement_document: identita a verze zdroje jen pro server
-- ===========================================================================

-- Tělo je 0094 beze změny + blok „Identita a verze zdroje" (INSERT i UPDATE).
-- SECURITY INVOKER: čte engagement_milestone a engagement_document_version pod
-- RLS volajícího (člen týmu je vidí). Servisní klíč (auth.uid() je NULL) smí
-- vše, co projde CHECKy.
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
    -- Identita a verze zdroje: nový dokument od člověka je nemá. Doplní je server
    -- z Graphu po ověření člena (0095).
    IF v_uid IS NOT NULL AND (
         NEW.drive_id IS NOT NULL OR NEW.item_id IS NOT NULL OR NEW.e_tag IS NOT NULL
         OR NEW.c_tag IS NOT NULL OR NEW.version_label IS NOT NULL OR NEW.last_modified_at IS NOT NULL
         OR NEW.last_modified_by IS NOT NULL OR NEW.source_state IS NOT NULL OR NEW.source_checked_at IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'identitu a verzi zdroje dokumentu doplňuje jen Cockpit ze SharePointu' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Identita a verze zdroje: přihlášený člen je nemění (server ano, auth.uid() je NULL).
  IF v_uid IS NOT NULL AND (
       NEW.drive_id IS DISTINCT FROM OLD.drive_id
       OR NEW.item_id IS DISTINCT FROM OLD.item_id
       OR NEW.e_tag IS DISTINCT FROM OLD.e_tag
       OR NEW.c_tag IS DISTINCT FROM OLD.c_tag
       OR NEW.version_label IS DISTINCT FROM OLD.version_label
       OR NEW.last_modified_at IS DISTINCT FROM OLD.last_modified_at
       OR NEW.last_modified_by IS DISTINCT FROM OLD.last_modified_by
       OR NEW.source_state IS DISTINCT FROM OLD.source_state
       OR NEW.source_checked_at IS DISTINCT FROM OLD.source_checked_at
     ) THEN
    RAISE EXCEPTION 'identitu a verzi zdroje dokumentu mění jen Cockpit ze SharePointu' USING ERRCODE = 'check_violation';
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

REVOKE ALL ON FUNCTION engagement_document_workflow_guard() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 2) auto_intake_dismiss: nepřepsat na prohráno obchod, na kterém se pracovalo
-- ===========================================================================

-- Výjimky (aplikace je překládá): P0002 záznam neexistuje, 22023 už vráceno /
-- už uzavřeno, 42501 bez oprávnění, AI002 obchod je vyhraný, AI003 (nově)
-- s obchodem se už pracuje (DETAIL deal_moved) — nic se nezměnilo.
CREATE OR REPLACE FUNCTION auto_intake_dismiss(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  text := loop_actor();
  v_row    auto_intake%ROWTYPE;
  v_today  date := (now() AT TIME ZONE 'Europe/Prague')::date;
  v_stage  text;
  v_amount numeric;
  v_deal   text := 'none';
  v_task   text := 'none';
  v_until  date;
  v_cnt    integer;
BEGIN
  IF NOT can_see_sales() THEN
    RAISE EXCEPTION 'Poptávky smí uzavírat jen obchodní role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM auto_intake WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automatické založení % neexistuje', p_id USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status = 'undone' THEN
    RAISE EXCEPTION 'Už bylo vráceno' USING ERRCODE = '22023';
  END IF;
  IF v_row.status = 'dismissed' THEN
    RAISE EXCEPTION 'Už je uzavřeno jako Není poptávka' USING ERRCODE = '22023';
  END IF;

  IF v_row.deal_id IS NOT NULL THEN
    SELECT stage::text, coalesce(amount_one_time, 0) INTO v_stage, v_amount
      FROM deal WHERE id = v_row.deal_id FOR UPDATE;
    IF FOUND THEN
      IF v_stage = 'vyhráno' THEN
        RAISE EXCEPTION 'Obchod je vyhraný — poptávka to byla' USING ERRCODE = 'AI002';
      ELSIF v_stage = 'prohráno' THEN
        v_deal := 'already_lost';
      ELSIF v_stage <> 'kvalifikace' OR v_amount <> 0 THEN
        -- Práce na obchodu (fáze nebo částka) = stejná hranice jako u Zpět (0086).
        -- Nic nepřepisovat: forecast a další krok cizí práce zůstanou.
        RAISE EXCEPTION 'S obchodem se už pracuje — jako Není poptávka ho nejde uzavřít' USING ERRCODE = 'AI003', DETAIL = 'deal_moved';
      ELSE
        UPDATE deal
           SET stage = 'prohráno', lost_reason = 'Nebyla to poptávka', closed_at = v_today,
               forecast_category = 'closed', probability_pct = 0, next_step = NULL, next_step_due = NULL
         WHERE id = v_row.deal_id;
        v_deal := 'lost';
      END IF;
    END IF;
  END IF;

  IF v_row.task_id IS NOT NULL THEN
    UPDATE task SET status = 'done' WHERE id = v_row.task_id AND status::text <> 'done';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt > 0 THEN
      v_task := 'done';
    END IF;
  END IF;

  IF v_row.account_id IS NOT NULL THEN
    UPDATE account
       SET snooze_until = GREATEST(coalesce(snooze_until, v_today), v_today + 365)
     WHERE id = v_row.account_id
    RETURNING snooze_until INTO v_until;
  END IF;

  UPDATE auto_intake SET status = 'dismissed', decided_by = v_actor, decided_at = now() WHERE id = p_id;

  RETURN jsonb_build_object('status', 'dismissed', 'id', p_id, 'deal', v_deal, 'task', v_task, 'snooze_until', v_until);
END $$;

REVOKE ALL ON FUNCTION auto_intake_dismiss(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auto_intake_dismiss(bigint) TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0095', 'zpevneni z bezpecnostni revize: identita a verze zdroje dokumentu (drive_id, item_id, e_tag, c_tag, version_label, last_modified, source_state) jen servisni klic, ne clen tymu; auto_intake_dismiss neprepise na prohrano obchod, na kterem se uz pracovalo (AI003)')
ON CONFLICT (version) DO NOTHING;
