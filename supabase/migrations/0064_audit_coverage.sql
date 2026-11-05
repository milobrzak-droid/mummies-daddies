-- 0064 — audit všech dnešních zápisů: jeden obecný DB trigger na řádkové
-- změny klíčových tabulek, aktér i u zápisů přes servisní klíč (REST, MCP,
-- admin klient) a historie obchodů/předplatného jen pro obchodní role.
--
-- PROČ: kapitola 3 plánu přestavby (docs/PROVOZ.md) končí bodem
-- „Napojení všech dnešních zápisů (formuláře, REST, MCP)". Inventura všech
-- zápisových cest (docs/PROVOZ.md) ukázala, že audit_event dnes
-- dostává jen: cenu/fázi/peníze/vznik/smazání obchodu (trigger 0034/0035)
-- a hrst appkových volání recordAudit (smazání kontaktu a úkolu, přeobsazení
-- vlastníka klienta, aliasy a vztahy firem, stav a akceptace milníku,
-- předání dodávky, redakce aktivity, export kontaktu, schůzka z API se
-- zdrojem). Všechno ostatní — založení a úpravy klientů, kontaktů, úkolů,
-- dodávek, předplatného, cílových seznamů, případů Loop Core, aktivit
-- z formulářů i z REST/MCP, další krok obchodu z API — nezanechalo žádnou
-- stopu. Dopisovat recordAudit do desítek akcí by opakovalo chybu, kterou
-- 0034 popsala u obchodu: appkové volání obejde každý zápis mimo tu jednu
-- akci (jiná akce, API, cron, SQL, kaskáda ze smazání firmy).
--
-- ROZHODNUTÍ: jeden obecný trigger audit_row_change() na úrovni tabulky.
-- Pro každou krytou tabulku je JEDINÝM zdrojem řádkových událostí
-- `<tabulka>.created | .updated | .deleted`. Nikdy obojí:
--   * appková volání, která jen zrcadlila řádkovou změnu kryté tabulky
--     (contact.deleted, task.deleted, account.owner_changed,
--     company_alias.*, relationship.*, milestone.status/.accepted,
--     engagement.handoff_completed, activity.created z API), appka po
--     aplikaci téhle migrace vynechá — core/auditDb.ts → dbAuditActive()
--     čte tenhle řádek v schema_migration. Do aplikace appka zapisuje dál
--     sama, takže nasazený kód bez migrace neztratí ani stávající audit;
--   * zůstávají jen VÝZNAMOVÉ události, které nejsou řádkovou změnou nebo
--     které trigger záměrně nevidí: contact.exported (čtení),
--     sales_activity.redacted (GDPR redakce mění jen subject/body a ty
--     jsou u sales_activity v seznamu ignorovaných sloupců níže);
--   * obchod (deal): vznik, smazání a změny ceny/fáze/peněz dál zapisuje
--     VÝHRADNĚ 0034/0035. Tady se na deal věší jen UPDATE a sloupce, které
--     hlídá 0034/0035, jsou v seznamu ignorovaných — obecný trigger je nikdy
--     nezapíše, takže vzniká jen `deal.updated` pro zbytek (další krok,
--     vlastník, termíny…), hlavně pro set_next_step z REST/MCP. Funkce
--     0034/0035 se tu NEMĚNÍ (běží na nich souběžné větve).
--
-- CO SE UKLÁDÁ (stejný princip jako 0037 a domain/crm/auditPayload.ts —
-- audit_event nemá retenci ani výmaz, takže do něj nesmí nic osobního):
--   * `_columns` = seřazené NÁZVY změněných sloupců (u vzniku a smazání
--     názvy vyplněných sloupců bez id/created_at/updated_at). Název sloupce
--     nic o člověku neprozradí, a přesto je vidět, že se změnil třeba e-mail.
--   * HODNOTY jen u sloupců z allow-listu tabulky (1. argument triggeru):
--     id a cizí klíče, stavy a číselníky, data, booleany, počty. Nikdy
--     jména, e-maily, telefony, volný text (poznámky, názvy, důvody, další
--     krok), odkazy ani IČO/jméno firmy (u OSVČ je to osobní údaj). Nový
--     sloupec, který sem nikdo nepřidá, se tak zapíše jen názvem — fail safe.
--   * u UPDATE before = staré hodnoty, after = nové hodnoty + `_columns`;
--     u INSERT before = NULL; u DELETE after = NULL a `_columns` je v before.
--   * update, který mění jen ignorované sloupce (2. argument; vždy
--     updated_at), nezaloží nic — např. last_inbound_at z mail syncu,
--     ms_event_id z Outlook synchronizace úkolů, markery follow-upu.
--   Čistá TS zrcadlo téhle logiky i allow-listů je v core/auditCoverage.ts;
--   test/audit-coverage-0064.test.ts hlídá, že se SQL a TS neliší.
--
-- AKTÉR (audit_request_context):
--   1) auth.uid() není NULL → 'user' / uuid, info_state 'human_confirmed'
--      (zápis z přihlášené session = člověk v appce).
--   2) servisní klíč (auth.uid() NULL, role service_role) → aktér
--      z hlavičky `x-cockpit-audit-actor` ('user:<uuid>', 'api_key:<vlastník
--      klíče>', 'system:<úloha>'), volitelně `x-cockpit-audit-evidence`
--      (id řádku evidence, musí existovat) a `x-cockpit-audit-info-state`.
--      PostgREST je zpřístupňuje v GUC request.headers. Věří se jim JEN pod
--      service_role: servisní klíč drží jen server, a přihlášený uživatel
--      (auth.uid() není NULL) hlavičkou nic nepřepíše. Posílá je
--      createAuditedAdminClient (core/auditDb.ts) — REST/MCP zápisy,
--      plánování schůzky a import nabídek přes admin klienta.
--   3) jinak 'system' / 'db-trigger:' || role požadavku (JWT role, jinak
--      SET ROLE, jinak session_user) — např. db-trigger:service_role pro
--      servisní zápis bez hlavičky, db-trigger:postgres pro SQL editor.
--   OPRAVA ÚVAHY z 0034/0035: `current_user` uvnitř SECURITY DEFINER funkce
--   je VLASTNÍK funkce, ne role, která zápis spustila. 0034/0035 proto pro
--   každý zápis mimo přihlášenou session píšou 'db-trigger:postgres'
--   (ověřeno v PGlite). Tady se role bere z JWT / GUC role, které
--   SECURITY DEFINER nemění. 0034/0035 se nepřepisují (viz výše).
--
-- PŮVOD: evidence_id z hlavičky (servisní zápis), jinak ze sloupce řádku
-- (3. argument: engagement_milestone.acceptance_evidence_id,
-- decision.evidence_id), když se v té změně nastavil. Akceptace milníku tak
-- nese doklad stejně, jako ho nesla appková událost milestone.accepted.
--
-- VIDITELNOST: audit_event čte tým s AAL2 (0028). Řádky entit deal,
-- deal_partner a subscription ale nesou částky, fáze a MRR — rozhodnutí
-- majitele 28. 9. 2026 (0058): obchody a peníze vidí jen obchodní role.
-- Dosud historie obchodu v audit_event tu hranici obcházela. Nová RESTRICTIVE
-- politika audit_event_sales_only je skryje všem mimo can_see_sales().
--
-- MIMO ROZSAH (zdůvodnění v docs/PROVOZ.md): deal_partner (složený
-- klíč, audit_event.entity_id je bigint), team_member a loop_node (klíč
-- uuid/text), systémové a bezpečnostní tabulky (api_key, api_request,
-- oauth_*, calendar_token, connector_state, job_run/job_lock, mail_event,
-- digest_send_log, evidence, audit_event, schema_migration).
--
-- PROVOZ: backfill nebo hromadný import po téhle migraci založí audit řádek
-- na každý dotčený řádek (aktér db-trigger:postgres). Kdo to nechce, vypne
-- trigger na dobu převodu jako 0050 (ALTER TABLE … DISABLE TRIGGER
-- audit_row_change) a zapíše jeden souhrnný řádek sám.
--
-- ZÁVISLOSTI: 0028 (audit_event), 0038 (evidence, info_state), 0020
-- (can_see_sales), 0026 (schema_migration) a tabulky z 0001, 0006, 0020,
-- 0033, 0039, 0042, 0048, 0051. Guard níže skončí srozumitelnou chybou.
-- Idempotentní: CREATE OR REPLACE, DROP … IF EXISTS + CREATE, ON CONFLICT.
-- Zámky: CREATE TRIGGER bere na každé tabulce krátký SHARE ROW EXCLUSIVE
-- (malé tabulky, zlomek sekundy); data se nepřepisují.

DO $$
DECLARE
  v_req text[];
BEGIN
  IF to_regclass('public.audit_event') IS NULL THEN
    RAISE EXCEPTION '0064 vyžaduje tabulku public.audit_event — nejdřív aplikujte 0028_audit_event.sql';
  END IF;
  IF to_regclass('public.evidence') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'audit_event' AND column_name = 'evidence_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'audit_event' AND column_name = 'info_state') THEN
    RAISE EXCEPTION '0064 vyžaduje evidence a audit_event.evidence_id/info_state — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0064 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0064 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0064 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  FOREACH v_req SLICE 1 IN ARRAY ARRAY[
    ['account', '0001_base_schema.sql'],
    ['contact', '0001_base_schema.sql'],
    ['deal', '0001_base_schema.sql'],
    ['engagement', '0001_base_schema.sql'],
    ['partner', '0001_base_schema.sql'],
    ['partner_registration', '0001_base_schema.sql'],
    ['reference_card', '0001_base_schema.sql'],
    ['subscription', '0001_base_schema.sql'],
    ['task', '0006_tasks_and_calendar.sql'],
    ['sales_activity', '0020_core_sales_crm.sql'],
    ['company_alias', '0033_company_alias_relationship.sql'],
    ['relationship', '0033_company_alias_relationship.sql'],
    ['work_case', '0039_loop_core.sql'],
    ['case_step', '0039_loop_core.sql'],
    ['decision', '0039_loop_core.sql'],
    ['approval_request', '0039_loop_core.sql'],
    ['authority_policy', '0039_loop_core.sql'],
    ['engagement_milestone', '0042_engagement_milestone.sql'],
    ['target_list', '0048_target_list.sql'],
    ['target_list_item', '0048_target_list.sql'],
    ['engagement_document', '0051_engagement_document.sql']
  ] LOOP
    IF to_regclass('public.' || v_req[1]) IS NULL THEN
      RAISE EXCEPTION '0064 vyžaduje tabulku public.% — nejdřív aplikujte %', v_req[1], v_req[2];
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- 1) Kontext požadavku: kdo zapisuje a na základě čeho
-- ===========================================================================

-- Volá se jen z audit_row_change() (SECURITY DEFINER, běží jako vlastník),
-- proto sama SECURITY DEFINER není a klientům se EXECUTE odebírá.
-- auth.uid() i auth.jwt() čtou request-scoped GUC, ne roli, pod kterou
-- funkce běží — uvnitř SECURITY DEFINER dávají přihlášeného uživatele.
CREATE OR REPLACE FUNCTION audit_request_context(
  OUT actor_type text,
  OUT actor_id text,
  OUT info_state text,
  OUT evidence_id bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_role    text;
  v_raw     text;
  v_headers jsonb;
  v_actor   text[];
  v_ev      text;
  v_state   text;
BEGIN
  -- Role požadavku: JWT (PostgREST), jinak SET ROLE, jinak session_user.
  -- current_user tu nepoužíváme — v SECURITY DEFINER je to vlastník funkce.
  v_role := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(nullif(current_setting('role', true), ''), 'none'),
    session_user
  );

  IF v_uid IS NOT NULL THEN
    actor_type := 'user';
    actor_id   := v_uid::text;
    info_state := 'human_confirmed';
    RETURN;
  END IF;

  IF v_role = 'service_role' THEN
    v_raw := nullif(current_setting('request.headers', true), '');
    IF v_raw IS NOT NULL THEN
      BEGIN
        v_headers := v_raw::jsonb;
      EXCEPTION WHEN others THEN
        -- Rozbitá hlavička nesmí shodit skutečný zápis — jen se nepoužije.
        v_headers := NULL;
      END;
    END IF;

    -- Tvar MUSÍ sedět s AUDIT_ACTOR_RE v core/auditCoverage.ts.
    v_actor := regexp_match(
      coalesce(v_headers ->> 'x-cockpit-audit-actor', ''),
      '^(user|api_key|system)(?::([A-Za-z0-9._:@-]{1,128}))?$'
    );
    IF v_actor IS NOT NULL THEN
      actor_type := v_actor[1];
      actor_id   := v_actor[2];
    END IF;

    -- Odkaz na evidenci jen na existující řádek: neplatné id by shodilo
    -- insert do audit_event na FK a s ním i skutečný zápis.
    v_ev := v_headers ->> 'x-cockpit-audit-evidence';
    IF v_ev ~ '^[1-9][0-9]{0,17}$' AND EXISTS (SELECT 1 FROM evidence e WHERE e.id = v_ev::bigint) THEN
      evidence_id := v_ev::bigint;
    END IF;

    v_state := v_headers ->> 'x-cockpit-audit-info-state';
    IF v_state IN ('source_fact', 'ai_suggestion', 'human_confirmed', 'actual_result') THEN
      info_state := v_state;
    END IF;
  END IF;

  IF actor_type IS NULL THEN
    actor_type := 'system';
    actor_id   := 'db-trigger:' || v_role;
    evidence_id := NULL;
    info_state  := NULL;
  ELSIF actor_type = 'user' AND info_state IS NULL THEN
    -- Admin klient jednající za přihlášeného člověka (plánování schůzky,
    -- import nabídky) je pořád lidský zápis.
    info_state := 'human_confirmed';
  END IF;
END $$;

REVOKE ALL ON FUNCTION audit_request_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_request_context() FROM anon, authenticated;

-- ===========================================================================
-- 2) Výběr bezpečných hodnot
-- ===========================================================================

-- Z řádku (jsonb) vybere hodnoty sloupců p_columns, které jsou v allow-listu
-- p_safe. Ostatní sloupce zůstanou jen jménem v `_columns`.
CREATE OR REPLACE FUNCTION audit_pick(p_row jsonb, p_columns text[], p_safe text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_object_agg(c, p_row -> c) FILTER (WHERE c = ANY (p_safe)), '{}'::jsonb)
  FROM unnest(p_columns) AS c
$$;

REVOKE ALL ON FUNCTION audit_pick(jsonb, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_pick(jsonb, text[], text[]) FROM anon, authenticated;

-- ===========================================================================
-- 3) Obecný trigger
-- ===========================================================================

-- Argumenty (CREATE TRIGGER … EXECUTE FUNCTION audit_row_change(a, b, c)):
--   a  allow-list sloupců, jejichž HODNOTY smí do auditu (čárkami, bez mezer)
--   b  sloupce, jejichž samotná změna není auditní událost (updated_at vždy)
--   c  sloupec s id evidence (nebo '')
-- SECURITY DEFINER: audit_event nemá INSERT politiku (0028); vlastník funkce
-- RLS obchází (stejný vzor jako 0034/0035). Výjimky se nechytají: změna
-- a její audit jsou jedna transakce — radši neprovedená změna než změna bez
-- původu.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_safe     text[] := '{}';
  v_ignore   text[] := ARRAY['updated_at'];
  v_evcol    text;
  v_old      jsonb;
  v_row      jsonb;
  v_cols     text[];
  v_before   jsonb;
  v_after    jsonb;
  v_verb     text;
  v_ctx      record;
  v_evidence bigint;
BEGIN
  IF TG_NARGS >= 1 AND TG_ARGV[0] <> '' THEN
    v_safe := string_to_array(TG_ARGV[0], ',');
  END IF;
  IF TG_NARGS >= 2 AND TG_ARGV[1] <> '' THEN
    v_ignore := v_ignore || string_to_array(TG_ARGV[1], ',');
  END IF;
  IF TG_NARGS >= 3 AND TG_ARGV[2] <> '' THEN
    v_evcol := TG_ARGV[2];
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_row := to_jsonb(NEW);
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}') INTO v_cols
    FROM jsonb_each(v_row) AS n
    WHERE n.value IS DISTINCT FROM (v_old -> n.key)
      AND n.key <> ALL (v_ignore);
    IF cardinality(v_cols) = 0 THEN
      RETURN NULL;
    END IF;
    v_before := audit_pick(v_old, v_cols, v_safe);
    v_after  := audit_pick(v_row, v_cols, v_safe) || jsonb_build_object('_columns', to_jsonb(v_cols));
    v_verb   := 'updated';
  ELSE
    v_row := CASE WHEN TG_OP = 'INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}') INTO v_cols
    FROM jsonb_each(v_row) AS n
    WHERE n.value <> 'null'::jsonb
      AND n.key <> ALL (ARRAY['id', 'created_at', 'updated_at']);
    IF TG_OP = 'INSERT' THEN
      v_after := audit_pick(v_row, v_cols, v_safe) || jsonb_build_object('_columns', to_jsonb(v_cols));
      v_verb  := 'created';
    ELSE
      v_before := audit_pick(v_row, v_cols, v_safe) || jsonb_build_object('_columns', to_jsonb(v_cols));
      v_verb   := 'deleted';
    END IF;
  END IF;

  SELECT * INTO v_ctx FROM audit_request_context();
  v_evidence := v_ctx.evidence_id;
  IF v_evidence IS NULL AND v_evcol IS NOT NULL AND TG_OP <> 'DELETE' AND v_evcol = ANY (v_cols) THEN
    v_evidence := (v_row ->> v_evcol)::bigint;
  END IF;

  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after, evidence_id, info_state)
  VALUES (
    v_ctx.actor_type, v_ctx.actor_id, TG_TABLE_NAME || '.' || v_verb, TG_TABLE_NAME,
    (v_row ->> 'id')::bigint, v_before, v_after, v_evidence, v_ctx.info_state
  );
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION audit_row_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_row_change() FROM anon, authenticated;

-- ===========================================================================
-- 4) Napojení tabulek (MUSÍ sedět s DB_AUDITED_TABLES v core/auditCoverage.ts)
-- ===========================================================================

-- account: jméno, IČO, web, sídlo, poznámky a profil jen jménem (OSVČ).
-- last_inbound_at/last_outbound_at posouvá mail sync (0041), ne člověk.
DROP TRIGGER IF EXISTS audit_row_change ON account;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'client_since,founded_on,industry,is_reference,legal_form,ms_licenses,nace,nudged_on,owner_id,raynet_id,referred_by_partner_id,size_band,snooze_until',
    'last_inbound_at,last_outbound_at',
    '');

-- approval_request: rozhodnutí přes RPC 0053/0057; poznámka je volný text.
DROP TRIGGER IF EXISTS audit_row_change ON approval_request;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'action_kind,case_id,decided_at,decided_by,expires_at,node,requested_by,requested_level,status',
    '',
    '');

-- authority_policy: kdo co smí schválit — dnes jen přes SQL, tím spíš audit.
DROP TRIGGER IF EXISTS audit_row_change ON authority_policy;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON authority_policy
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'action_kind,active,level,updated_by',
    '',
    '');

DROP TRIGGER IF EXISTS audit_row_change ON case_step;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON case_step
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'case_id,due_at,position,status',
    '',
    '');

-- company_alias: doména a název aliasu jen jménem (u OSVČ osobní údaj).
DROP TRIGGER IF EXISTS audit_row_change ON company_alias;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON company_alias
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id',
    '',
    '');

-- contact: jméno, e-mail, telefon, role a poznámky NIKDY (0037).
DROP TRIGGER IF EXISTS audit_row_change ON contact;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON contact
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,is_champion,partner_id',
    '',
    '');

-- deal: jen UPDATE. Vznik/smazání a sloupce ceny, fáze a peněz zapisuje
-- výhradně 0034/0035 — proto jsou tu v ignorovaných (nikdy obojí).
-- last_activity_at posouvá trigger aktivity (0059), follow_up_* hlídač
-- follow-upů, client_paid_one_time je generovaný sloupec.
DROP TRIGGER IF EXISTS audit_row_change ON deal;
CREATE TRIGGER audit_row_change
  AFTER UPDATE ON deal
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,closed_at,deal_kind,decision_due,delivery_lane,delivery_team,estimate_md,expected_close,forecast_category,next_step_due,owner_id,phase,pillar,primary_contact_id,probability_pct,revenue_category,revenue_line,sourced_by_partner,subsidy_program,won_at',
    'amount_one_time,amount_one_time_original,client_paid_one_time,cogs_one_time,currency,expected_mrr,follow_up_escalated_on,follow_up_nudged_on,fx_rate,last_activity_at,stage,subsidy_pct',
    '');

-- decision: otázka, možnosti a volba jsou volný text; doklad nese evidence_id.
DROP TRIGGER IF EXISTS audit_row_change ON decision;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON decision
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'case_id,decided_at,decided_by,evidence_id',
    '',
    'evidence_id');

-- engagement: ROI (peníze), cíl, rozsah, finanční rámec, rizika a odkaz na
-- balíček jen jménem. adoption_delta_pp je generovaný sloupec.
DROP TRIGGER IF EXISTS audit_row_change ON engagement;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON engagement
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,baseline_adoption_pct,baseline_captured_on,client_sponsor_contact_id,copilot_licenses,deal_id,due_on,follow_up_checkpoint_on,gate_next_steps_owned,gate_outputs_captured,gate_pack_delivered,gate_peer_learning,gate_ratios_respected,gate_safety_followed,handoff_by,handoff_completed_at,kind,nnpsa,phase,post_adoption_pct,post_captured_on,reference_worthy,started_on,time_saved_min_week,trained_count,workshops_delivered',
    'adoption_delta_pp',
    '');

DROP TRIGGER IF EXISTS audit_row_change ON engagement_document;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON engagement_document
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'created_by,engagement_id,kind,milestone_id',
    '',
    '');

-- engagement_milestone: akceptace nese doklad (acceptance_evidence_id).
DROP TRIGGER IF EXISTS audit_row_change ON engagement_milestone;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON engagement_milestone
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'acceptance_evidence_id,accepted_at,accepted_by_contact_id,deputy_id,due_on,engagement_id,owner_id,status',
    '',
    'acceptance_evidence_id');

DROP TRIGGER IF EXISTS audit_row_change ON partner;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON partner
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'is_referrer,kind,roles,via_partner_id',
    '',
    '');

-- partner_registration: marže programu je obchodní údaj → jen jménem.
DROP TRIGGER IF EXISTS audit_row_change ON partner_registration;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON partner_registration
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'partner_id,program,status',
    '',
    '');

-- reference_card: souhlas klienta (approved_public) je přesně ta změna,
-- u které se má vědět kdo a kdy.
DROP TRIGGER IF EXISTS audit_row_change ON reference_card;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON reference_card
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,approved_public,engagement_id,is_ms_anchor,used_in_deals',
    '',
    '');

DROP TRIGGER IF EXISTS audit_row_change ON relationship;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON relationship
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'child_account_id,parent_account_id,relationship_type',
    '',
    '');

-- sales_activity: předmět a tělo nikdy. Změna JEN předmětu/těla je GDPR
-- redakce (domain/crm/gdprSweep.ts) a tu zapisuje appka jako významovou
-- událost sales_activity.redacted (tvar 0037) — proto ignorované.
DROP TRIGGER IF EXISTS audit_row_change ON sales_activity;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON sales_activity
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,contact_id,created_by,deal_id,follow_up_on,kind,occurred_at,outcome,partner_id,source',
    'body,subject',
    '');

-- subscription: MRR a licence jsou obchodní čísla — řádky auditu vidí jen
-- obchodní role (politika audit_event_sales_only níže).
DROP TRIGGER IF EXISTS audit_row_change ON subscription;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON subscription
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,churn_risk,deal_id,ended_on,health_score,is_ms_subsidized,mrr,product,renewal_date,seats,started_on',
    '',
    '');

-- target_list: název, segment, zdůvodnění a hypotéza jsou volný text.
DROP TRIGGER IF EXISTS audit_row_change ON target_list;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON target_list
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'created_by,owner_id',
    '',
    '');

DROP TRIGGER IF EXISTS audit_row_change ON target_list_item;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON target_list_item
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,contact_id,created_by,list_id,next_step_due,status',
    '',
    '');

-- task: název a popis nikdy (0037). ms_event_id zapisuje Outlook sync.
DROP TRIGGER IF EXISTS audit_row_change ON task;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON task
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,assignee_id,created_by,deal_id,due_on,engagement_id,priority,status',
    'ms_event_id',
    '');

DROP TRIGGER IF EXISTS audit_row_change ON work_case;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON work_case
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,created_by,deal_id,deputy_id,lead_owner_id,node,status',
    '',
    '');

-- Kontrola konfigurace proti skutečnému schématu: sloupec v argumentech,
-- který v tabulce není, by se tiše nikdy nezapsal (překlep). Neblokuje —
-- chybějící sloupec nic neprozradí, jen se ohlásí.
DO $$
DECLARE
  v_problem text;
BEGIN
  -- tgargs je bytea s argumenty oddělenými nulovým bajtem; encode(…, 'escape')
  -- ho vypíše jako text '\000'.
  FOR v_problem IN
    SELECT format('%s.%s', c.relname, col.name)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
    CROSS JOIN LATERAL unnest(string_to_array(encode(t.tgargs, 'escape'), '\000')) AS arg(value)
    CROSS JOIN LATERAL unnest(string_to_array(arg.value, ',')) AS col(name)
    WHERE t.tgname = 'audit_row_change' AND NOT t.tgisinternal AND col.name <> ''
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute att
        WHERE att.attrelid = c.oid AND att.attname = col.name AND att.attnum > 0 AND NOT att.attisdropped
      )
  LOOP
    RAISE WARNING '0064: audit_row_change odkazuje na neexistující sloupec %', v_problem;
  END LOOP;
END $$;

-- ===========================================================================
-- 5) Historie obchodů a předplatného jen pro obchodní role (0058)
-- ===========================================================================

-- RESTRICTIVE se spojuje přes AND s audit_event_read (tým) a require_aal2
-- (0028) — jen zužuje. Funkce v (SELECT …): vyhodnotí se jednou za dotaz.
DROP POLICY IF EXISTS audit_event_sales_only ON audit_event;
CREATE POLICY audit_event_sales_only ON audit_event
  AS RESTRICTIVE FOR SELECT
  USING (entity_table NOT IN ('deal', 'deal_partner', 'subscription') OR (SELECT can_see_sales()));

INSERT INTO schema_migration (version, note)
VALUES ('0064', 'audit_row_change: obecny audit trigger (21 tabulek, deal jen UPDATE mimo sloupce 0034/0035), akter z auth.uid() nebo hlavicky servisniho klice, jen nazvy sloupcu + bezpecne hodnoty; audit_event_sales_only')
ON CONFLICT (version) DO NOTHING;
