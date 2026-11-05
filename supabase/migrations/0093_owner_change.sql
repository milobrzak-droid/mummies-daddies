-- 0093 — cílové seznamy v hromadném předání práce a jednotlivá změna
-- vlastníka (případ, milník, obchod, dodávka, cílový seznam).
--
-- Revize stavu 29. 9. 2026, „Týmový provoz a zastupitelnost": vlastníka
-- jednotlivé věci šlo změnit jen hromadným „Předat práci" (0088). Navíc
-- hromadné předání neznalo vlastníky cílových seznamů (target_list.owner_id),
-- takže po odchodu člověka zůstaly jeho seznamy bez pána.
--
-- 1) transfer_member_work — NOVÁ VERZE (zpětně kompatibilní)
--    Stejný podpis (uuid, uuid, uuid, text[], date), stejný návrat (jsonb
--    s počty) i stejná pravidla jako v 0088. Přibývá druh 'seznamy':
--      seznamy   target_list.owner_id (cílový seznam nemá stav „uzavřeno",
--                takže se předávají všechny seznamy člověka)
--    Starý volající, který 'seznamy' neposílá, dostane přesně totéž co
--    dřív. Klíč 'seznamy' je ve výsledku jen tehdy, když byl druh vybraný.
--    Zbytek těla je beze změny převzatý z 0088 (v_allowed má navíc
--    'seznamy'; lib/memberWork.ts WORK_KINDS a test/member-work.test.ts je
--    porovnávají).
--
-- 2) change_work_owner — jednotlivá změna vlastníka (a zástupce)
--    kind  druh            tabulka              vlastník / zástupce
--    ----  --------------  -------------------  -----------------------------
--    pripady   případ      work_case            lead_owner_id / deputy_id
--    milniky   milník      engagement_milestone owner_id / deputy_id
--    obchody   obchod      deal                 owner_id / (zástupce není)
--    dodavky   dodávka     engagement           owner_id / deputy_id
--    seznamy   cílový seznam target_list        owner_id / (zástupce není)
--    PRAVIDLA jako u hromadného předání:
--      * volá jen service_role (aplikace: lib/actions/ownerChange.ts, admin
--        klient s hlavičkou aktéra x-cockpit-audit-actor); REVOKE od PUBLIC,
--        anon a authenticated. Oprávnění ověří aplikace a znovu funkce.
--      * aktér (p_actor) musí být aktivní člen interní role (TW003 → OC003),
--        stejně jako příjemce: vlastník i zástupce musí být aktivní člen
--        interní role, ne Partner ani deaktivovaný (OC007). Kdo už na věci
--        je a beze změny zůstává, se znovu nekontroluje (jinak by šlo změnit
--        vlastníka jen po vyřazení deaktivovaného zástupce).
--      * zástupce ≠ vlastník (OC008), zástupce bez vlastníka nedává smysl
--        (OC012). Obchod a cílový seznam zástupce nemají (OC011).
--      * měnit jde jen otevřenou věc (OC005): jako v hromadném předání
--        ne uzavřený milník, uzavřenou dodávku, zavřený případ ani obchod
--        vyhráno / prohráno / odloženo.
--      * existujícího vlastníka nejde jen odebrat, jen předat (OC009).
--    OPRÁVNĚNÍ (rozdíl proti hromadnému předání, které smí jen správce):
--      smí správce týmu (is_admin), role vedení a ten, kdo věc dnes vlastní
--      nebo zastupuje; u případu i vlastník oblasti případu (loop_node.owner_id
--      — stejné pravidlo jako work_case_guard v 0057). Nikdo tím nezískává
--      právo, které dnes nemá: u případu je to totéž pravidlo, milníky,
--      dodávky a obchody dnes mění vlastníka přes formuláře s RLS.
--    SOUBĚH: p_expect = {"owner": uuid|null, "deputy": uuid|null} je stav,
--      který uživatel viděl; když se mezitím změnil, OC006.
--    VRÁCENÍ (toast „Zpět"): p_undo_of = id souhrnného záznamu auditu, který
--      chce ten samý aktér vrátit. Projde jen když je záznam tohoto aktéra,
--      není starší než 30 minut, patří té věci, věc je ještě přesně ve stavu,
--      který změna vytvořila, a p_owner / p_deputy jsou přesně původní hodnoty
--      (OC010, jinak OC006). Oprávnění se pak neposuzuje znovu — jinak by
--      předávající, který věc odevzdal, nemohl vlastní změnu vrátit.
--    AUDIT: každý přepsaný řádek zapíše řádkový trigger tabulky (0064/0082)
--      s aktérem z hlavičky; navíc jeden souhrnný záznam
--      'team_member.work_item_reassigned' (entity_table team_member,
--      entity_ref = předchozí držitel, jinak nový; v after druh, id věci,
--      id klienta a dodávky pro odkaz, role owner/deputy, od koho komu, počty
--      a případně undo_of — jen id, druhy a čísla, žádný název ani jméno).
--      Z něj čte „Co se změnilo" (domain/crm/changes.ts, handoverChanges).
--      Když se nic nemění, záznam nevzniká.
--    Chyby OC001 nemá oprávnění, OC002 věc neexistuje, OC003 aktér není
--    aktivní člen interní role, OC004 neznámý druh nebo chybí vstup,
--    OC005 věc je uzavřená, OC006 mezitím změněno, OC007 vybraný člověk není
--    aktivní člen interní role, OC008 zástupce = vlastník, OC009 vlastníka
--    nejde odebrat, OC010 vrácení nejde, OC011 druh nemá zástupce, OC012
--    zástupce bez vlastníka. Překlad v lib/ownerChange.ts (OWNER_CHANGE_ERRORS).
--
-- RLS: nová tabulka nevzniká. Funkce jsou SECURITY DEFINER se search_path.
--
-- ZÁVISLOSTI: 0088 (transfer_member_work), 0048 (target_list), 0039 (work_case,
-- loop_node), 0042 (engagement_milestone), 0061 (engagement.owner_id), 0069
-- (team_member.deactivated_at), 0082 (audit_event.entity_ref), 0026 (ledger).
-- Guard níže skončí srozumitelnou chybou. Idempotentní: CREATE OR REPLACE,
-- ON CONFLICT.

DO $$
BEGIN
  IF to_regclass('public.team_member') IS NULL OR to_regclass('public.engagement') IS NULL
     OR to_regclass('public.deal') IS NULL OR to_regclass('public.account') IS NULL THEN
    RAISE EXCEPTION '0093 vyžaduje team_member, engagement, deal a account — nejdřív aplikujte 0001–0003';
  END IF;
  IF to_regclass('public.target_list') IS NULL THEN
    RAISE EXCEPTION '0093 vyžaduje target_list — nejdřív aplikujte 0048_target_list.sql';
  END IF;
  IF to_regclass('public.work_case') IS NULL OR to_regclass('public.loop_node') IS NULL THEN
    RAISE EXCEPTION '0093 vyžaduje work_case a loop_node — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
  IF to_regclass('public.engagement_milestone') IS NULL THEN
    RAISE EXCEPTION '0093 vyžaduje engagement_milestone — nejdřív aplikujte 0042_engagement_milestone.sql';
  END IF;
  IF to_regclass('public.allocation') IS NULL THEN
    RAISE EXCEPTION '0093 vyžaduje allocation — nejdřív aplikujte 0062_capacity.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'engagement' AND column_name = 'owner_id') THEN
    RAISE EXCEPTION '0093 vyžaduje engagement.owner_id — nejdřív aplikujte 0061_delivery_impact.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'team_member' AND column_name = 'deactivated_at') THEN
    RAISE EXCEPTION '0093 vyžaduje team_member.deactivated_at — nejdřív aplikujte 0069_security_fixes.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'audit_event' AND column_name = 'entity_ref') THEN
    RAISE EXCEPTION '0093 vyžaduje audit_event.entity_ref — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regprocedure('public.transfer_member_work(uuid, uuid, uuid, text[], date)') IS NULL THEN
    RAISE EXCEPTION '0093 vyžaduje transfer_member_work — nejdřív aplikujte 0088_impact_metric_owner_transfer.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0093 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) transfer_member_work — nová verze s cílovými seznamy
-- ===========================================================================

CREATE OR REPLACE FUNCTION transfer_member_work(
  p_from uuid,
  p_to uuid,
  p_actor uuid,
  p_kinds text[],
  p_today date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allowed  constant text[] := ARRAY['klienti', 'obchody', 'seznamy', 'dodavky', 'milniky', 'ukoly', 'pripady', 'alokace', 'oblasti'];
  v_internal constant text[] := ARRAY['vedeni', 'obchodnik', 'projektak', 'lektor'];
  v_counts   jsonb := '{}'::jsonb;
  v_freed    integer := 0;
  v_n        integer;
  v_m        integer;
  v_total    integer := 0;
  r          record;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_actor IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'Chybí, od koho a komu se práce předává' USING ERRCODE = 'TW001';
  END IF;
  IF p_from = p_to THEN
    RAISE EXCEPTION 'Práci nejde předat témuž člověku' USING ERRCODE = 'TW001';
  END IF;
  IF p_kinds IS NULL OR cardinality(p_kinds) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_kinds) AS k WHERE k IS NULL OR NOT (k = ANY (v_allowed))) THEN
    RAISE EXCEPTION 'Neznámý druh předávané práce' USING ERRCODE = 'TW004';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_member tm
                  WHERE tm.id = p_actor AND tm.is_admin AND tm.deactivated_at IS NULL
                    AND tm.role::text = ANY (v_internal)) THEN
    RAISE EXCEPTION 'Předat práci smí jen aktivní správce týmu' USING ERRCODE = 'TW003';
  END IF;

  -- Souběžná předání téhož člověka se seřadí.
  PERFORM 1 FROM team_member tm WHERE tm.id IN (p_from, p_to) ORDER BY tm.id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = p_from) THEN
    RAISE EXCEPTION 'Člověk, od kterého se předává, neexistuje' USING ERRCODE = 'TW002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_member tm
                  WHERE tm.id = p_to AND tm.deactivated_at IS NULL AND tm.role::text = ANY (v_internal)) THEN
    RAISE EXCEPTION 'Práci jde předat jen aktivnímu členovi týmu s interní rolí' USING ERRCODE = 'TW002';
  END IF;

  IF 'klienti' = ANY (p_kinds) THEN
    UPDATE account SET owner_id = p_to WHERE owner_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('klienti', v_n);
  END IF;

  IF 'obchody' = ANY (p_kinds) THEN
    UPDATE deal SET owner_id = p_to
     WHERE owner_id = p_from AND stage::text NOT IN ('vyhráno', 'prohráno', 'odloženo');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('obchody', v_n);
  END IF;

  IF 'seznamy' = ANY (p_kinds) THEN
    UPDATE target_list SET owner_id = p_to WHERE owner_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('seznamy', v_n);
  END IF;

  IF 'dodavky' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM engagement
     WHERE phase::text <> 'uzavreno'
       AND ((owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND owner_id = p_to));
    v_freed := v_freed + v_m;
    UPDATE engagement
       SET owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE owner_id = p_from AND phase::text <> 'uzavreno';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE engagement
       SET deputy_id = CASE WHEN owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from AND phase::text <> 'uzavreno';
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('dodavky', v_n + v_m);
  END IF;

  IF 'milniky' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM engagement_milestone
     WHERE status <> 'uzavreno'
       AND ((owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND owner_id = p_to));
    v_freed := v_freed + v_m;
    UPDATE engagement_milestone
       SET owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE owner_id = p_from AND status <> 'uzavreno';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE engagement_milestone
       SET deputy_id = CASE WHEN owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from AND status <> 'uzavreno';
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('milniky', v_n + v_m);
  END IF;

  IF 'ukoly' = ANY (p_kinds) THEN
    UPDATE task SET assignee_id = p_to WHERE assignee_id = p_from AND status::text <> 'done';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('ukoly', v_n);
  END IF;

  IF 'pripady' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM work_case
     WHERE status IN ('open', 'in_progress', 'waiting')
       AND ((lead_owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND lead_owner_id = p_to));
    v_freed := v_freed + v_m;
    UPDATE work_case
       SET lead_owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE lead_owner_id = p_from AND status IN ('open', 'in_progress', 'waiting');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE work_case
       SET deputy_id = CASE WHEN lead_owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from AND status IN ('open', 'in_progress', 'waiting');
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('pripady', v_n + v_m);
  END IF;

  IF 'alokace' = ANY (p_kinds) THEN
    v_n := 0;
    -- Budoucí (od dneška): jen jiný člověk.
    UPDATE allocation
       SET member_id = p_to,
           substitute_id = CASE WHEN substitute_id = p_to THEN NULL ELSE substitute_id END
     WHERE member_id = p_from AND starts_on >= p_today;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_n := v_n + v_m;
    -- Běžící: ukončit včerejškem, od dneška totéž pro nového člověka.
    FOR r IN
      SELECT a.id, a.engagement_id, a.work_case_id, a.hours_per_week, a.ends_on, a.substitute_id, a.note
        FROM allocation a
       WHERE a.member_id = p_from AND a.starts_on < p_today
         AND (a.ends_on IS NULL OR a.ends_on >= p_today)
       ORDER BY a.id
       FOR UPDATE
    LOOP
      UPDATE allocation SET ends_on = p_today - 1 WHERE id = r.id;
      INSERT INTO allocation (member_id, engagement_id, work_case_id, hours_per_week, starts_on, ends_on,
                              substitute_id, note, created_by)
      VALUES (p_to, r.engagement_id, r.work_case_id, r.hours_per_week, p_today, r.ends_on,
              CASE WHEN r.substitute_id = p_to THEN NULL ELSE r.substitute_id END, r.note, p_actor);
      v_n := v_n + 1;
    END LOOP;
    -- Zástup v běžících a budoucích alokacích.
    UPDATE allocation
       SET substitute_id = CASE WHEN member_id = p_to THEN NULL ELSE p_to END
     WHERE substitute_id = p_from AND (ends_on IS NULL OR ends_on >= p_today);
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('alokace', v_n + v_m);
  END IF;

  IF 'oblasti' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM loop_node
     WHERE (owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND owner_id = p_to);
    v_freed := v_freed + v_m;
    UPDATE loop_node
       SET owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE owner_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE loop_node
       SET deputy_id = CASE WHEN owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('oblasti', v_n + v_m);
  END IF;

  SELECT coalesce(sum(value::integer), 0) INTO v_total FROM jsonb_each_text(v_counts);
  v_counts := v_counts || jsonb_build_object('bez_zastupce', v_freed);

  IF v_total > 0 THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, entity_ref, before, after, info_state)
    VALUES ('user', p_actor::text, 'team_member.work_transferred', 'team_member', NULL, p_from::text,
            jsonb_build_object('member_id', p_from),
            jsonb_build_object('to_member_id', p_to, 'kinds', to_jsonb(p_kinds), 'counts', v_counts, 'on', p_today),
            'human_confirmed');
  END IF;

  RETURN v_counts;
END $$;

REVOKE ALL ON FUNCTION transfer_member_work(uuid, uuid, uuid, text[], date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION transfer_member_work(uuid, uuid, uuid, text[], date) TO service_role;

COMMENT ON FUNCTION transfer_member_work(uuid, uuid, uuid, text[], date) IS
  'Předání otevřené práce člověka jinému členovi týmu (jedna transakce, souhrn v auditu); od 0093 i cílové seznamy. Jen service_role.';

-- ===========================================================================
-- 2) change_work_owner — jednotlivá změna vlastníka (a zástupce)
-- ===========================================================================

CREATE OR REPLACE FUNCTION change_work_owner(
  p_kind text,
  p_id bigint,
  p_actor uuid,
  p_owner uuid,
  p_deputy uuid,
  p_expect jsonb DEFAULT NULL,
  p_undo_of bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_internal   constant text[] := ARRAY['vedeni', 'obchodnik', 'projektak', 'lektor'];
  v_has_deputy boolean := p_kind IN ('pripady', 'milniky', 'dodavky');
  v_role       text;
  v_admin      boolean;
  v_old_owner  uuid;
  v_old_deputy uuid;
  v_account    bigint;
  v_engagement bigint;
  v_node       text;
  v_closed     boolean;
  v_ev         record;
  v_owner_chg  boolean;
  v_from       uuid;
  v_to         uuid;
  v_freed      integer;
  v_after      jsonb;
  v_audit_id   bigint;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('pripady', 'milniky', 'obchody', 'dodavky', 'seznamy')
     OR p_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'Neznámý druh věci nebo chybí vstup' USING ERRCODE = 'OC004';
  END IF;

  SELECT tm.role::text, tm.is_admin INTO v_role, v_admin
    FROM team_member tm
   WHERE tm.id = p_actor AND tm.deactivated_at IS NULL AND tm.role::text = ANY (v_internal);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vlastníka smí měnit jen aktivní člen týmu s interní rolí' USING ERRCODE = 'OC003';
  END IF;

  -- Načtení věci se zámkem řádku (souběžné změny téže věci se seřadí).
  IF p_kind = 'pripady' THEN
    SELECT c.lead_owner_id, c.deputy_id, c.account_id, NULL::bigint, c.node,
           c.status NOT IN ('open', 'in_progress', 'waiting')
      INTO v_old_owner, v_old_deputy, v_account, v_engagement, v_node, v_closed
      FROM work_case c WHERE c.id = p_id FOR UPDATE;
  ELSIF p_kind = 'milniky' THEN
    SELECT m.owner_id, m.deputy_id, e.account_id, m.engagement_id, NULL::text, m.status = 'uzavreno'
      INTO v_old_owner, v_old_deputy, v_account, v_engagement, v_node, v_closed
      FROM engagement_milestone m JOIN engagement e ON e.id = m.engagement_id
     WHERE m.id = p_id FOR UPDATE OF m;
  ELSIF p_kind = 'dodavky' THEN
    SELECT e.owner_id, e.deputy_id, e.account_id, e.id, NULL::text, e.phase::text = 'uzavreno'
      INTO v_old_owner, v_old_deputy, v_account, v_engagement, v_node, v_closed
      FROM engagement e WHERE e.id = p_id FOR UPDATE;
  ELSIF p_kind = 'obchody' THEN
    SELECT d.owner_id, NULL::uuid, d.account_id, NULL::bigint, NULL::text,
           d.stage::text IN ('vyhráno', 'prohráno', 'odloženo')
      INTO v_old_owner, v_old_deputy, v_account, v_engagement, v_node, v_closed
      FROM deal d WHERE d.id = p_id FOR UPDATE;
  ELSE
    SELECT t.owner_id, NULL::uuid, NULL::bigint, NULL::bigint, NULL::text, false
      INTO v_old_owner, v_old_deputy, v_account, v_engagement, v_node, v_closed
      FROM target_list t WHERE t.id = p_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Věc neexistuje' USING ERRCODE = 'OC002';
  END IF;
  IF v_closed THEN
    RAISE EXCEPTION 'Uzavřenou věc už nejde předat' USING ERRCODE = 'OC005';
  END IF;

  IF p_undo_of IS NOT NULL THEN
    -- Vrácení vlastní čerstvé změny: záznam je tohoto aktéra, do 30 minut,
    -- patří této věci a věc je ještě přesně ve stavu, který změna vytvořila.
    SELECT ae.before, ae.after INTO v_ev
      FROM audit_event ae
     WHERE ae.id = p_undo_of
       AND ae.action = 'team_member.work_item_reassigned'
       AND ae.actor_id = p_actor::text
       AND ae.occurred_at > now() - interval '30 minutes';
    IF NOT FOUND
       OR v_ev.after->>'kind' IS DISTINCT FROM p_kind
       OR v_ev.after->>'item_id' IS DISTINCT FROM p_id::text
       OR v_ev.after->>'undo_of' IS NOT NULL THEN
      RAISE EXCEPTION 'Tuhle změnu už nejde vrátit' USING ERRCODE = 'OC010';
    END IF;
    IF (v_ev.after->'to'->>'owner') IS DISTINCT FROM v_old_owner::text
       OR (v_has_deputy AND (v_ev.after->'to'->>'deputy') IS DISTINCT FROM v_old_deputy::text) THEN
      RAISE EXCEPTION 'Věc mezitím změnil někdo jiný' USING ERRCODE = 'OC006';
    END IF;
    IF (v_ev.before->>'owner') IS DISTINCT FROM p_owner::text
       OR (v_has_deputy AND (v_ev.before->>'deputy') IS DISTINCT FROM p_deputy::text) THEN
      RAISE EXCEPTION 'Tuhle změnu už nejde vrátit' USING ERRCODE = 'OC010';
    END IF;
  ELSE
    -- coalesce: věc bez vlastníka / zástupce (NULL) nesmí dát NULL místo „ne".
    IF NOT (coalesce(v_admin, false) OR v_role = 'vedeni'
            OR coalesce(v_old_owner = p_actor, false)
            OR (v_has_deputy AND coalesce(v_old_deputy = p_actor, false))
            OR (p_kind = 'pripady' AND EXISTS (SELECT 1 FROM loop_node n WHERE n.node = v_node AND n.owner_id = p_actor))) THEN
      RAISE EXCEPTION 'Vlastníka téhle věci smí měnit správce týmu, vedení nebo ten, kdo ji vlastní či zastupuje' USING ERRCODE = 'OC001';
    END IF;
    IF p_expect IS NOT NULL
       AND (NULLIF(p_expect->>'owner', '')::uuid IS DISTINCT FROM v_old_owner
            OR (v_has_deputy AND NULLIF(p_expect->>'deputy', '')::uuid IS DISTINCT FROM v_old_deputy)) THEN
      RAISE EXCEPTION 'Věc mezitím změnil někdo jiný' USING ERRCODE = 'OC006';
    END IF;
    IF p_owner IS NULL AND v_old_owner IS NOT NULL THEN
      RAISE EXCEPTION 'Vlastníka nejde jen odebrat, předej ho jinému člověku' USING ERRCODE = 'OC009';
    END IF;
  END IF;

  IF NOT v_has_deputy AND p_deputy IS NOT NULL THEN
    RAISE EXCEPTION 'Tenhle druh věci zástupce nemá' USING ERRCODE = 'OC011';
  END IF;
  IF p_deputy IS NOT NULL AND p_owner IS NULL THEN
    RAISE EXCEPTION 'Zástupce bez vlastníka nedává smysl' USING ERRCODE = 'OC012';
  END IF;
  IF p_deputy IS NOT NULL AND p_deputy = p_owner THEN
    RAISE EXCEPTION 'Zástupce musí být jiný člověk než vlastník' USING ERRCODE = 'OC008';
  END IF;
  IF p_owner IS NOT NULL AND p_owner IS DISTINCT FROM v_old_owner
     AND NOT EXISTS (SELECT 1 FROM team_member tm
                      WHERE tm.id = p_owner AND tm.deactivated_at IS NULL AND tm.role::text = ANY (v_internal)) THEN
    RAISE EXCEPTION 'Vlastníkem jde určit jen aktivního člena týmu s interní rolí' USING ERRCODE = 'OC007';
  END IF;
  IF p_deputy IS NOT NULL AND p_deputy IS DISTINCT FROM v_old_deputy
     AND NOT EXISTS (SELECT 1 FROM team_member tm
                      WHERE tm.id = p_deputy AND tm.deactivated_at IS NULL AND tm.role::text = ANY (v_internal)) THEN
    RAISE EXCEPTION 'Zástupcem jde určit jen aktivního člena týmu s interní rolí' USING ERRCODE = 'OC007';
  END IF;

  -- Beze změny nic nezapisujeme ani neauditujeme.
  IF p_owner IS NOT DISTINCT FROM v_old_owner
     AND (NOT v_has_deputy OR p_deputy IS NOT DISTINCT FROM v_old_deputy) THEN
    RETURN jsonb_build_object('changed', false, 'kind', p_kind, 'id', p_id);
  END IF;

  IF p_kind = 'pripady' THEN
    UPDATE work_case SET lead_owner_id = p_owner, deputy_id = p_deputy WHERE id = p_id;
  ELSIF p_kind = 'milniky' THEN
    UPDATE engagement_milestone SET owner_id = p_owner, deputy_id = p_deputy WHERE id = p_id;
  ELSIF p_kind = 'dodavky' THEN
    UPDATE engagement SET owner_id = p_owner, deputy_id = p_deputy WHERE id = p_id;
  ELSIF p_kind = 'obchody' THEN
    UPDATE deal SET owner_id = p_owner WHERE id = p_id;
  ELSE
    UPDATE target_list SET owner_id = p_owner WHERE id = p_id;
  END IF;

  v_owner_chg := p_owner IS DISTINCT FROM v_old_owner;
  v_from := CASE WHEN v_owner_chg THEN v_old_owner ELSE v_old_deputy END;
  v_to   := CASE WHEN v_owner_chg THEN p_owner ELSE p_deputy END;
  -- Nový vlastník byl dosud zástupcem a zástupce se uvolnil (jako u hromadného předání).
  v_freed := CASE WHEN v_has_deputy AND v_old_deputy IS NOT NULL AND v_old_deputy = p_owner AND p_deputy IS NULL THEN 1 ELSE 0 END;

  v_after := jsonb_build_object(
    'kind', p_kind,
    'item_id', p_id,
    'account_id', v_account,
    'engagement_id', v_engagement,
    'role', CASE WHEN v_owner_chg THEN 'owner' ELSE 'deputy' END,
    'from_member_id', v_from,
    'to_member_id', v_to,
    'to', jsonb_build_object('owner', p_owner, 'deputy', p_deputy),
    'counts', jsonb_build_object(p_kind, 1, 'bez_zastupce', v_freed)
  );
  IF p_undo_of IS NOT NULL THEN
    v_after := v_after || jsonb_build_object('undo_of', p_undo_of);
  END IF;

  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, entity_ref, before, after, info_state)
  VALUES ('user', p_actor::text, 'team_member.work_item_reassigned', 'team_member', NULL,
          coalesce(v_from, v_to)::text,
          jsonb_build_object('owner', v_old_owner, 'deputy', v_old_deputy),
          v_after,
          'human_confirmed')
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'changed', true,
    'audit_id', v_audit_id,
    'kind', p_kind,
    'id', p_id,
    'account_id', v_account,
    'engagement_id', v_engagement,
    'role', CASE WHEN v_owner_chg THEN 'owner' ELSE 'deputy' END,
    'owner', p_owner,
    'deputy', p_deputy,
    'before_owner', v_old_owner,
    'before_deputy', v_old_deputy,
    'freed_deputy', v_freed
  );
END $$;

REVOKE ALL ON FUNCTION change_work_owner(text, bigint, uuid, uuid, uuid, jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION change_work_owner(text, bigint, uuid, uuid, uuid, jsonb, bigint) TO service_role;

COMMENT ON FUNCTION change_work_owner(text, bigint, uuid, uuid, uuid, jsonb, bigint) IS
  'Jednotlivá změna vlastníka (a zástupce) případu, milníku, obchodu, dodávky nebo cílového seznamu se souhrnem v auditu a vrácením vlastní čerstvé změny. Jen service_role.';

INSERT INTO schema_migration (version, note)
VALUES ('0093', 'predani prace: cilove seznamy v transfer_member_work + change_work_owner (jednotliva zmena vlastníka s auditem a vracenim)')
ON CONFLICT (version) DO NOTHING;
