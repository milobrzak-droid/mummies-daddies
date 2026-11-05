-- 0084 — schválení napojené na konkrétní akci (P1.5 revize stavu z 29. 9. 2026,
-- kapitola 2B „Schválení je konec záznamu, nikoli začátek provedení").
--
-- PROČ: do téhle migrace bylo schválení jen záznam rozhodnutí. Po schválení se
-- nic neprovedlo, stav „vypršelo" nenastavoval žádný kód (shouldExpire volaly
-- jen testy) a „Odložit do…" platilo jen v jednom prohlížeči (localStorage).
-- Nově žádost nese, CO se po rozhodnutí stane, a databáze to ve stejné
-- transakci provede a zapíše výsledek.
--
-- CO SE MĚNÍ
--
-- 1) approval_request dostává popis akce (vše NULL = dosavadní žádost „jen
--    záznam", ta se chová přesně jako dřív):
--      action_type   druh akce: confirm_next_step | send_offer
--      target_table  + target_id  identita cíle (work_case | deal_scope_version)
--      params        parametry (jen interní údaje; u nabídky jen id a číslo
--                    verze — částky ne, žádost čte celý tým, částky jen
--                    obchodní role)
--      params_hash   otisk (sha256) parametrů, u nabídky otisk OBSAHU verze
--                    (rozsah, částky, měna) v okamžiku žádosti
--      transition    jediný povolený přechod cíle:
--                      confirm_next_step  active>next_step_confirmed
--                      send_offer         draft>send_approved
--      expires_at    u typované žádosti povinné (výchozí platnost z konfigurace)
--      snoozed_until + snoozed_by  „Odložit do…" na serveru
--    action_kind = action_type (pravidlo pravomoci v authority_policy se hledá
--    podle druhu akce; seed obou druhů je L2, viz konec souboru).
--
-- 2) approval_execution — výsledek provedení, JEDEN řádek na žádost
--    (UNIQUE request_id = kotva idempotence). Stav completed | failed |
--    needs_attention, na co se reagovalo (approved | rejected | expired),
--    result = jen id a kódy (task_id, step_id, reason…), počet pokusů,
--    kdo a kdy. Čte tým (případ ukazuje výsledek na své časové ose), zápis
--    jen funkce níže. Audit měkkým triggerem 0082 (nová tabulka).
--
-- 3) Executor approval_execute(žádost) — volá ho decide_approval ve stejné
--    transakci hned po schválení/zamítnutí a denní úloha po vypršení:
--      schváleno + confirm_next_step   BEZPEČNÝ INTERNÍ ZÁPIS: krok případu
--                                      a úkol řešiteli s termínem
--      schváleno + send_offer          NEVRATNÁ EXTERNÍ AKCE → nic neodesílá:
--                                      verze nabídky se označí „schváleno
--                                      k odeslání", vlastník obchodu dostane
--                                      úkol „Odeslat nabídku klientovi"
--                                      a obchod záznam do aktivit
--      zamítnuto / vypršelo            DALŠÍ STAV: případ (obchod) se vrací
--                                      vlastníkovi s úkolem „rozhodni, jak dál"
--    Cíl se před zápisem znovu ověří (případ otevřený, verze pořád koncept,
--    otisk parametrů sedí, řešitel aktivní). Když ne, nezapíše se nic
--    z akce a výsledek je needs_attention + úkol ke kontrole pro vlastníka.
--    Neočekávaná chyba se zachytí v podtransakci (nic se nezapíše), výsledek
--    je failed se SQLSTATE a denní úloha to zkusí znovu (nejvýš 3 pokusy);
--    ručně jde zopakovat RPC retry_approval_execution.
--    IDEMPOTENCE: řádek žádosti se zamkne FOR UPDATE, a když už výsledek
--    completed/needs_attention existuje, executor nic nedělá — opakované
--    schválení (DB ho stejně odmítne, žádost už není čekající), opakovaný
--    běh denní úlohy ani ruční „zkusit znovu" nic nezdvojí. Záznam do
--    aktivit má navíc unikátní klíč (source 'approval', external_id
--    'approval:<id>') a stejná čekající žádost nejde založit dvakrát
--    (částečný unikátní index nad druhem, cílem a otiskem).
--
-- 4) request_action_approval(druh, cíl, parametry, platnost) — RPC pro
--    typovanou žádost. Ověří cíl a parametry, zmrazí uzel (u případu jeho
--    uzel, u nabídky uzel z konfigurace), spočítá otisk a úroveň
--    = pravidlo činnosti (bez pravidla L2, 0053). Odeslání nabídky smí
--    žádat jen obchodní role. decide_approval je přepsaná jen o dvě věci:
--    odeslání nabídky schvaluje jen obchodní role (nabídku jiná role ani
--    nevidí) a po rozhodnutí se spustí executor. Čtyři oči, pravomoc podle
--    snímku uzlu, zámek FOR UPDATE a expirace zůstávají z 0057.
--
-- 5) Nabídka: deal_scope_version.send_approved_at + send_approval_request_id.
--    Nový strážce deal_scope_version_send_guard (vedle 0072, který se nemění):
--      SV006  koncept → odesláno bez schválené žádosti, když to hranice
--             vyžaduje
--      SV007  schválení k odeslání nastavuje jen executor schválené žádosti
--             (transakčně lokální příznak app.approval_exec, vzor
--             app.scope_version_accept z 0072)
--      SV008  schválenou verzi nejde měnit (oprava = nová verze)
--    HRANICE: config/mummiesDaddies.ts → approvalActions.sendOffer.requireApprovalFromCzk
--    (kopie ve funkci approval_action_settings). authority_policy žádnou
--    částkovou hranici nemá — jen action_kind, level, active; seed jediný:
--    external_commitment = L2. Cílová architektura říká „finanční a jiné
--    nevratné úkony mají zvláštní hranici", číslo ale nikde neurčuje. Výchozí
--    hranice je proto 0 Kč = schválení VŽDY: vymyšlená částka by potichu
--    vyřadila menší nabídky ze čtyř očí a „neznámá situace pravomoc snižuje,
--    nikdy nezvyšuje". Hodnota nabídky = jednorázově + 12 × měsíčně; u verze
--    v EUR se hranice neporovnává (bez kurzu nejde spolehlivě) a schválení
--    je potřeba vždy. Import PDF (service_role vkládá rovnou odeslanou verzi)
--    zapisuje fakt, že nabídka UŽ odešla mimo Cockpit — to strážce nehlídá.
--
-- 6) expire_due_approvals() — jen service_role, volá ji EXISTUJÍCÍ denní cron
--    /api/cron/follow-ups (Vercel Hobby má omezený počet cronů): čekající
--    žádosti po platnosti → expired (decided_at = teď, decided_by NULL jako
--    dosud povoloval CHECK z 0039) a u typovaných spustí další stav
--    (vlastník dostane úkol). Pak zopakuje neúspěšná provedení (< 3 pokusy).
--    FOR UPDATE SKIP LOCKED: souběžné rozhodnutí člověka nepřebije.
--
-- 7) snooze_approval(žádost, do kdy | NULL) — „Odložit do…" / „Vrátit".
--    Smí jen ten, kdo o žádosti může rozhodnout (stejná pravidla jako
--    decide_approval), nejvýš o 30 dní a ne za konec platnosti. Zobrazí se
--    všem (sloupec žádosti), rozhodnutím se odložení ruší.
--
-- BEZPEČNOST: tým na approval_request ani approval_execution dál nezapisuje
-- (0039: SELECT-only + REVOKE). Všechny zápisy jdou přes SECURITY DEFINER
-- funkce s pevným search_path; aktér vždy z auth.uid() (loop_actor), nikdy
-- z parametru. Vnitřní funkce executoru nemají klientské EXECUTE. Executor
-- běží s právy vlastníka funkce, ale zapisuje jen to, co popisuje schválená
-- žádost (její cíl, parametry a jediný přechod) — pravomoc dává rozhodnutí
-- oprávněného člověka, ne volající.
--
-- AUDIT (konvence 0064/0082): approval_request má tvrdý trigger z 0064 —
-- tady se jen přepíše allow-list o nové sloupce (hodnoty: druh, cíl, otisk,
-- přechod, odložení; params jen názvem — nese název kroku). approval_execution
-- dostává měkký trigger (nová tabulka, chyba auditu zápis neshodí),
-- deal_scope_version měkký trigger z 0082 s rozšířeným allow-listem. Řádky,
-- které executor zakládá (case_step, task, sales_activity, verze nabídky),
-- zapisují jejich vlastní triggery s aktérem z auth.uid() (schvalovatel),
-- u denní úlohy z hlavičky servisního klíče (system:approval-expiry).
-- core/auditCoverage.ts a test/audit-coverage-0064.test.ts to hlídají.
--
-- KÓD JE TOLERANTNÍ K NENASAZENÉ MIGRACI: bez 0084 obrazovky ukazují žádosti
-- jako dřív (jen záznam), formuláře typovaných žádostí hlásí „čeká na
-- migraci 0084" a denní úloha vypršení jen zapíše, že čeká na migraci.
--
-- ZÁVISLOSTI: 0039 + 0053 + 0057 (Loop Core, pravomoc v SQL, snímek uzlu),
-- 0069/0082 (team_member.deactivated_at, is_team_member jen interní role,
-- audit_row_change_soft), 0064 (audit_row_change), 0072 (deal_scope_version),
-- 0006 (task), 0020/0021 (sales_activity, source/external_id), 0026 (ledger).
-- Guard níže skončí srozumitelnou chybou.
-- Idempotentní: ADD COLUMN IF NOT EXISTS, constrainty jen když chybí,
-- CREATE … IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS + CREATE,
-- seed jen bez aktivního pravidla, ON CONFLICT DO NOTHING.
-- Zámky: ALTER approval_request/deal_scope_version (ADD COLUMN bez výchozí
-- hodnoty, CHECK nad malou tabulkou) krátký ACCESS EXCLUSIVE; data se
-- nepřepisují.

DO $$
DECLARE
  v_req text[];
BEGIN
  FOREACH v_req SLICE 1 IN ARRAY ARRAY[
    ['work_case', '0039_loop_core.sql'],
    ['case_step', '0039_loop_core.sql'],
    ['decision', '0039_loop_core.sql'],
    ['approval_request', '0039_loop_core.sql'],
    ['authority_policy', '0039_loop_core.sql'],
    ['loop_node', '0039_loop_core.sql'],
    ['task', '0006_tasks_and_calendar.sql'],
    ['sales_activity', '0020_core_sales_crm.sql'],
    ['deal_scope_version', '0072_deal_scope_version.sql'],
    ['audit_event', '0028_audit_event.sql'],
    ['schema_migration', '0026_migration_ledger.sql']
  ] LOOP
    IF to_regclass('public.' || v_req[1]) IS NULL THEN
      RAISE EXCEPTION '0084 vyžaduje tabulku public.% — nejdřív aplikujte %', v_req[1], v_req[2];
    END IF;
  END LOOP;

  FOREACH v_req SLICE 1 IN ARRAY ARRAY[
    ['approval_request', 'node', '0057_loop_core_hardening.sql'],
    ['team_member', 'deactivated_at', '0069_security_fixes.sql'],
    ['sales_activity', 'external_id', '0021_activity_partner.sql'],
    ['audit_event', 'entity_ref', '0082_audit_gaps_partner_lockdown.sql']
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_req[1] AND column_name = v_req[2]
    ) THEN
      RAISE EXCEPTION '0084 vyžaduje sloupec %.% — nejdřív aplikujte %', v_req[1], v_req[2], v_req[3];
    END IF;
  END LOOP;

  IF to_regprocedure('public.loop_actor()') IS NULL
     OR to_regprocedure('public.loop_level_rank(text)') IS NULL
     OR to_regprocedure('public.loop_role_max_level(text)') IS NULL THEN
    RAISE EXCEPTION '0084 vyžaduje pravomoc schvalování v SQL (loop_actor, loop_level_rank, loop_role_max_level) — nejdřív aplikujte 0039_loop_core.sql a 0053_security_hardening.sql';
  END IF;
  IF to_regprocedure('public.loop_approver_role_for_node(uuid, text)') IS NULL
     OR to_regprocedure('public.loop_is_vedeni(uuid)') IS NULL THEN
    RAISE EXCEPTION '0084 vyžaduje snímek uzlu a roli vedení (loop_approver_role_for_node, loop_is_vedeni) — nejdřív aplikujte 0057_loop_core_hardening.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0084 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change()') IS NULL THEN
    RAISE EXCEPTION '0084 vyžaduje audit_row_change() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0084 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) Nastavení z konfigurace firmy a čisté pomocné funkce
-- ===========================================================================

-- Kopie COMPANY.approvalActions z config/mummiesDaddies.ts (camelCase → snake_case).
-- MUSÍ zůstat shodná; test/approval-executor-0084.test.ts ji porovnává.
-- Změna hodnoty = nová migrace (vzor autoDelivery z 0080).
CREATE OR REPLACE FUNCTION approval_action_settings()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT '{"confirm_next_step": {"validity_days": 7}, "send_offer": {"node": "obchod", "require_approval_from_czk": 0, "validity_days": 5, "task_title": "Odeslat nabídku klientovi", "task_working_days": 1}, "return_task": {"working_days": 1}}'::jsonb
$$;

-- Datum o N pracovních dní později (Po–Pá, svátky se nepočítají — termín
-- úkolu je orientační). Stejné pravidlo jako auto_delivery_add_working_days
-- v 0080; vlastní kopie, ať schvalování nezávisí na vnitřku automatické dodávky.
CREATE OR REPLACE FUNCTION approval_add_working_days(p_from date, p_days integer)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day  date := p_from;
  v_left integer := greatest(coalesce(p_days, 0), 0);
BEGIN
  WHILE v_left > 0 LOOP
    v_day := v_day + 1;
    IF extract(isodow FROM v_day) < 6 THEN
      v_left := v_left - 1;
    END IF;
  END LOOP;
  RETURN v_day;
END $$;

-- Dnešní den a konec dne v časovém pásmu firmy (config/mummiesDaddies.ts timeZone).
CREATE OR REPLACE FUNCTION approval_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (now() AT TIME ZONE 'Europe/Prague')::date
$$;

-- Konec dne = půlnoc dne následujícího (jako pragueDayEnd v core/workCaseFlow.ts).
CREATE OR REPLACE FUNCTION approval_day_end(p_day date)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Prague')
$$;

-- 'user:<uuid>' → uuid; cokoli jiného (system:…, api_key:…) → NULL.
CREATE OR REPLACE FUNCTION approval_member_uuid(p_actor text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_actor ~ '^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN substring(p_actor FROM 6)::uuid
  END
$$;

-- Otisk parametrů žádosti: sha256 z kanonického jsonb (jsonb řadí klíče sám).
CREATE OR REPLACE FUNCTION approval_params_hash(p_action_type text, p_target_table text, p_target_id bigint, p_content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'action_type', p_action_type,
    'target', p_target_table || ':' || p_target_id::text,
    'content', p_content
  )::text, 'UTF8')), 'hex')
$$;

-- Obsah verze nabídky, který schválení kryje: co se změní, to schválení ruší.
CREATE OR REPLACE FUNCTION approval_offer_content(p_version deal_scope_version)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'deal_id', p_version.deal_id,
    'version', p_version.version,
    'scope', p_version.scope,
    'amount_one_time', p_version.amount_one_time,
    'expected_mrr', p_version.expected_mrr,
    'currency', p_version.currency::text,
    'evidence_id', p_version.evidence_id
  )
$$;

-- Vyžaduje odeslání verze schválenou žádost? Hodnota = jednorázově + 12 ×
-- měsíčně. Hranice null = nikdy, 0 = vždy; verze mimo CZK vždy (bez kurzu).
-- Zrcadlo offerNeedsSendApproval v domain/crm/scopeVersion.ts.
CREATE OR REPLACE FUNCTION approval_offer_requires_approval(p_amount numeric, p_mrr numeric, p_currency text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN (approval_action_settings() #>> '{send_offer,require_approval_from_czk}') IS NULL THEN false
    WHEN p_currency IS DISTINCT FROM 'CZK' THEN true
    ELSE coalesce(p_amount, 0) + 12 * coalesce(p_mrr, 0)
         >= (approval_action_settings() #>> '{send_offer,require_approval_from_czk}')::numeric
  END
$$;

-- První aktivní interní člen týmu z kandidátů (v pořadí). Stejný výčet rolí
-- jako is_team_member() z 0082; NULL a odešlí se přeskočí.
CREATE OR REPLACE FUNCTION approval_first_active_member(p_candidates uuid[])
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT c.id
    FROM unnest(p_candidates) WITH ORDINALITY AS c(id, ord)
    JOIN team_member tm ON tm.id = c.id
   WHERE tm.deactivated_at IS NULL
     AND tm.role::text IN ('vedeni', 'obchodnik', 'projektak', 'lektor')
   ORDER BY c.ord
   LIMIT 1
$$;

-- ===========================================================================
-- 2) approval_request: popis akce, odložení
-- ===========================================================================

ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS action_type text;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS target_table text;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS target_id bigint;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS params jsonb;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS params_hash text;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS transition text;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS snoozed_by text;

COMMENT ON COLUMN approval_request.action_type IS
  'Druh akce, kterou po rozhodnutí provede executor (0084): confirm_next_step | send_offer. NULL = žádost jen jako záznam.';
COMMENT ON COLUMN approval_request.params_hash IS
  'sha256 parametrů (u nabídky obsahu verze) v okamžiku žádosti; executor ho před provedením ověří.';
COMMENT ON COLUMN approval_request.transition IS
  'Jediný přechod cíle, který schválení povoluje (0084).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.approval_request'::regclass AND conname = 'approval_request_action_type_check') THEN
    ALTER TABLE approval_request ADD CONSTRAINT approval_request_action_type_check
      CHECK (action_type IS NULL OR action_type IN ('confirm_next_step', 'send_offer'));
  END IF;
  -- Typovaná žádost nese všechno najednou (cíl, parametry, otisk, přechod,
  -- platnost) a pravidlo pravomoci podle druhu akce; žádost „jen záznam" nic z toho.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.approval_request'::regclass AND conname = 'approval_request_action_shape') THEN
    ALTER TABLE approval_request ADD CONSTRAINT approval_request_action_shape CHECK (
      (action_type IS NULL AND target_table IS NULL AND target_id IS NULL AND params IS NULL
         AND params_hash IS NULL AND transition IS NULL)
      OR (action_type IS NOT NULL AND target_table IS NOT NULL AND target_id IS NOT NULL
          AND params IS NOT NULL AND jsonb_typeof(params) = 'object'
          AND params_hash ~ '^[0-9a-f]{64}$' AND expires_at IS NOT NULL
          AND action_kind = action_type)
    );
  END IF;
  -- Jediný povolený přechod podle druhu akce (shodně s APPROVAL_ACTIONS v core/approvalActions.ts).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.approval_request'::regclass AND conname = 'approval_request_action_target') THEN
    ALTER TABLE approval_request ADD CONSTRAINT approval_request_action_target CHECK (
      action_type IS NULL
      OR (action_type = 'confirm_next_step' AND target_table = 'work_case'
          AND transition = 'active>next_step_confirmed' AND case_id = target_id)
      OR (action_type = 'send_offer' AND target_table = 'deal_scope_version'
          AND transition = 'draft>send_approved')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.approval_request'::regclass AND conname = 'approval_request_snooze_consistent') THEN
    ALTER TABLE approval_request ADD CONSTRAINT approval_request_snooze_consistent
      CHECK ((snoozed_until IS NULL) = (snoozed_by IS NULL));
  END IF;
  -- Druh akce nejde „napodobit" obecnou žádostí (vypadala by jako akce,
  -- ale nic by neprovedla). Stávající řádky se ověří níže.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.approval_request'::regclass AND conname = 'approval_request_typed_kind') THEN
    ALTER TABLE approval_request ADD CONSTRAINT approval_request_typed_kind
      CHECK (action_type IS NOT NULL OR action_kind NOT IN ('confirm_next_step', 'send_offer')) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM approval_request
              WHERE action_type IS NULL AND action_kind IN ('confirm_next_step', 'send_offer')) THEN
    RAISE NOTICE '0084: approval_request má obecné žádosti s action_kind confirm_next_step/send_offer — approval_request_typed_kind zůstává NOT VALID; po opravě spusťte ALTER TABLE approval_request VALIDATE CONSTRAINT approval_request_typed_kind.';
  ELSE
    ALTER TABLE approval_request VALIDATE CONSTRAINT approval_request_typed_kind;
  END IF;
END $$;

-- Stejná čekající žádost (druh, cíl, otisk) nejde založit dvakrát.
CREATE UNIQUE INDEX IF NOT EXISTS approval_request_action_pending_uidx
  ON approval_request (action_type, target_table, target_id, params_hash)
  WHERE status = 'pending' AND action_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_request_target_idx
  ON approval_request (target_table, target_id) WHERE target_table IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_request_expiry_idx
  ON approval_request (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;

-- Smí člen o žádosti rozhodnout (a tedy ji odložit)? Stejná pravidla jako
-- decide_approval: ne žadatel, role pro zmrazený uzel stačí na úroveň,
-- odeslání nabídky jen obchodní role. Volá se jen zevnitř SECURITY DEFINER
-- funkcí níže; klientům EXECUTE odebráno.
CREATE OR REPLACE FUNCTION approval_can_decide(p_member uuid, p_req approval_request)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max text;
BEGIN
  IF p_member IS NULL OR p_req.requested_by = 'user:' || p_member::text THEN
    RETURN false;
  END IF;
  v_max := loop_role_max_level(loop_approver_role_for_node(p_member, p_req.node));
  IF v_max IS NULL
     OR loop_level_rank(p_req.requested_level) IS NULL
     OR loop_level_rank(p_req.requested_level) > loop_level_rank(v_max) THEN
    RETURN false;
  END IF;
  IF p_req.action_type = 'send_offer' AND NOT EXISTS (
    SELECT 1 FROM team_member tm
     WHERE tm.id = p_member AND tm.deactivated_at IS NULL AND tm.role::text IN ('vedeni', 'obchodnik')
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

-- ===========================================================================
-- 3) approval_execution: výsledek provedení (jeden na žádost)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS approval_execution (
  id              bigserial PRIMARY KEY,
  request_id      bigint NOT NULL REFERENCES approval_request(id) ON DELETE RESTRICT,
  case_id         bigint REFERENCES work_case(id) ON DELETE RESTRICT,
  action_type     text NOT NULL,
  request_status  text NOT NULL,
  status          text NOT NULL,
  result          jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts        integer NOT NULL DEFAULT 1,
  executed_by     text NOT NULL,
  executed_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_execution_request_key UNIQUE (request_id),
  CONSTRAINT approval_execution_action_type_check CHECK (action_type IN ('confirm_next_step', 'send_offer')),
  CONSTRAINT approval_execution_request_status_check CHECK (request_status IN ('approved', 'rejected', 'expired')),
  CONSTRAINT approval_execution_status_check CHECK (status IN ('completed', 'failed', 'needs_attention')),
  CONSTRAINT approval_execution_result_object CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT approval_execution_attempts_check CHECK (attempts >= 1),
  CONSTRAINT approval_execution_actor_check CHECK (executed_by ~ '^(user|system):[A-Za-z0-9._:@-]{1,128}$')
);

CREATE INDEX IF NOT EXISTS approval_execution_case_idx ON approval_execution (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_execution_failed_idx ON approval_execution (executed_at) WHERE status = 'failed';

COMMENT ON TABLE approval_execution IS
  'Výsledek provedení schválené/zamítnuté/vypršelé žádosti (0084): completed | failed | needs_attention, jen id a kódy v result.';

ALTER TABLE approval_execution ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_execution_read ON approval_execution;
CREATE POLICY approval_execution_read ON approval_execution
  FOR SELECT USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS require_aal2 ON approval_execution;
CREATE POLICY require_aal2 ON approval_execution
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

-- Zápis jen funkce executoru (SECURITY DEFINER). Obrana do hloubky: bez
-- zápisové politiky i bez GRANTu.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON approval_execution FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 4) Nabídka: schváleno k odeslání + strážce
-- ===========================================================================

ALTER TABLE deal_scope_version ADD COLUMN IF NOT EXISTS send_approved_at timestamptz;
ALTER TABLE deal_scope_version ADD COLUMN IF NOT EXISTS send_approval_request_id bigint
  REFERENCES approval_request(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.deal_scope_version'::regclass AND conname = 'deal_scope_version_send_approval_consistent') THEN
    ALTER TABLE deal_scope_version ADD CONSTRAINT deal_scope_version_send_approval_consistent
      CHECK ((send_approved_at IS NULL) = (send_approval_request_id IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN deal_scope_version.send_approved_at IS
  'Kdy verzi schválená žádost (send_approval_request_id) označila jako schválenou k odeslání (0084). Odesílá člověk.';

-- SECURITY INVOKER (jako strážce z 0072): čte jen NEW/OLD, příznak transakce
-- a čistou funkci hranice. Běží PO deal_scope_version_guard (pořadí podle
-- názvu), takže přechody stavu a neměnnost odeslané verze už ověřil 0072.
CREATE OR REPLACE FUNCTION deal_scope_version_send_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.send_approved_at IS NOT NULL OR NEW.send_approval_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Schválení k odeslání nastavuje jen schválená žádost' USING ERRCODE = 'SV007';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.send_approved_at IS DISTINCT FROM OLD.send_approved_at
     OR NEW.send_approval_request_id IS DISTINCT FROM OLD.send_approval_request_id THEN
    -- Nastavit jednou, jen u konceptu a jen z executoru téže žádosti
    -- (transakčně lokální příznak nastavuje approval_exec_send_offer).
    IF OLD.send_approval_request_id IS NOT NULL
       OR NEW.send_approval_request_id IS NULL
       OR OLD.status <> 'draft' OR NEW.status <> 'draft'
       OR coalesce(current_setting('app.approval_exec', true), '') <> NEW.send_approval_request_id::text THEN
      RAISE EXCEPTION 'Schválení k odeslání nastavuje jen schválená žádost' USING ERRCODE = 'SV007';
    END IF;
    -- Čas razítkuje databáze.
    NEW.send_approved_at := now();
  END IF;

  IF OLD.send_approved_at IS NOT NULL
     AND (NEW.scope IS DISTINCT FROM OLD.scope
          OR NEW.amount_one_time IS DISTINCT FROM OLD.amount_one_time
          OR NEW.expected_mrr IS DISTINCT FROM OLD.expected_mrr
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id) THEN
    RAISE EXCEPTION 'Schválenou verzi nabídky nejde měnit — založ novou verzi' USING ERRCODE = 'SV008';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'sent' AND OLD.send_approved_at IS NULL
     AND approval_offer_requires_approval(OLD.amount_one_time, OLD.expected_mrr, OLD.currency::text) THEN
    RAISE EXCEPTION 'Verzi nabídky nejde označit jako odeslanou bez schválené žádosti' USING ERRCODE = 'SV006';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS deal_scope_version_send_guard ON deal_scope_version;
CREATE TRIGGER deal_scope_version_send_guard
  BEFORE INSERT OR UPDATE ON deal_scope_version
  FOR EACH ROW EXECUTE FUNCTION deal_scope_version_send_guard();

-- ===========================================================================
-- 5) Executor
-- ===========================================================================

-- Úkol pro člověka (návrat vlastníkovi, kontrola). created_by NULL = založil
-- systém (ukáže se i vlastníkovi v „Co se změnilo").
CREATE OR REPLACE FUNCTION approval_human_task(
  p_title       text,
  p_description text,
  p_assignee    uuid,
  p_account_id  bigint,
  p_deal_id     bigint,
  p_priority    text DEFAULT 'normal',
  p_due_on      date DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO task (title, description, status, priority, assignee_id, created_by, due_on, account_id, deal_id)
  VALUES (
    left(p_title, 300),
    left(p_description, 2000),
    'todo',
    p_priority::task_priority,
    p_assignee,
    NULL,
    coalesce(p_due_on, approval_add_working_days(approval_today(), (approval_action_settings() #>> '{return_task,working_days}')::integer)),
    p_account_id,
    p_deal_id
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Schváleno + confirm_next_step: krok případu a úkol řešiteli (bezpečný
-- interní zápis). Parametry jsou z žádosti — nic z volajícího.
CREATE OR REPLACE FUNCTION approval_exec_confirm_next_step(p_req approval_request)
RETURNS TABLE (out_status text, out_result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case      work_case%ROWTYPE;
  v_found     boolean;
  v_title     text := p_req.params ->> 'title';
  v_assignee  uuid := (p_req.params ->> 'assignee_id')::uuid;
  v_due       date := (p_req.params ->> 'due_on')::date;
  v_reason    text;
  v_owner     uuid;
  v_pos       integer;
  v_step      bigint;
  v_task      bigint;
BEGIN
  -- FOR UPDATE: případ se během provedení neuzavře ani nepřesune.
  SELECT * INTO v_case FROM work_case WHERE id = p_req.target_id FOR UPDATE;
  v_found := FOUND;
  IF NOT v_found THEN
    v_reason := 'case_missing';
  ELSIF v_case.status IN ('done', 'cancelled') THEN
    v_reason := 'case_closed';
  ELSIF approval_params_hash(p_req.action_type, p_req.target_table, p_req.target_id, p_req.params)
        IS DISTINCT FROM p_req.params_hash THEN
    v_reason := 'params_changed';
  ELSIF approval_first_active_member(ARRAY[v_assignee]) IS NULL THEN
    v_reason := 'assignee_inactive';
  END IF;

  IF v_reason IS NOT NULL THEN
    v_owner := approval_first_active_member(ARRAY[
      v_case.lead_owner_id,
      (SELECT ln.owner_id FROM loop_node ln WHERE ln.node = p_req.node),
      approval_member_uuid(p_req.requested_by)
    ]);
    v_task := approval_human_task(
      'Zkontrolovat schválený krok: ' || coalesce(v_title, 'další krok'),
      'Žádost č. ' || p_req.id || ' o potvrzení dalšího kroku byla schválena, ale krok se nezaložil ('
        || CASE v_reason
             WHEN 'case_closed' THEN 'případ je mezitím uzavřený'
             WHEN 'case_missing' THEN 'případ už neexistuje'
             WHEN 'params_changed' THEN 'parametry žádosti nesedí s otiskem'
             ELSE 'řešitel už není aktivním členem týmu'
           END
        || '). Rozhodni, jestli krok založit ručně, nebo požádat o schválení znovu.',
      v_owner, v_case.account_id, v_case.deal_id);
    RETURN QUERY SELECT 'needs_attention'::text,
      jsonb_build_object('reason', v_reason, 'task_id', v_task, 'assignee_id', v_owner);
    RETURN;
  END IF;

  SELECT coalesce(max(cs.position), 0) + 1 INTO v_pos FROM case_step cs WHERE cs.case_id = v_case.id;
  INSERT INTO case_step (case_id, position, title, status, due_at)
  VALUES (v_case.id, v_pos, v_title, 'todo', approval_day_end(v_due))
  RETURNING id INTO v_step;

  v_task := approval_human_task(
    v_title,
    'Schválený další krok případu „' || left(v_case.title, 200) || '“ (žádost č. ' || p_req.id
      || '). Krok je v případu jako „' || left(v_title, 200) || '“; až ho dokončíš, označ ho tam jako hotový.',
    v_assignee, v_case.account_id, v_case.deal_id, 'normal', v_due);

  RETURN QUERY SELECT 'completed'::text,
    jsonb_build_object('step_id', v_step, 'task_id', v_task, 'assignee_id', v_assignee, 'due_on', v_due);
END $$;

-- Schváleno + send_offer: NIC SE NEODESÍLÁ. Verze → schváleno k odeslání,
-- úkol „Odeslat nabídku klientovi" vlastníkovi obchodu, záznam do aktivit.
CREATE OR REPLACE FUNCTION approval_exec_send_offer(p_req approval_request)
RETURNS TABLE (out_status text, out_result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings  jsonb := approval_action_settings() -> 'send_offer';
  v_ver       deal_scope_version%ROWTYPE;
  v_found     boolean;
  v_deal_id   bigint := (p_req.params ->> 'deal_id')::bigint;
  v_version   integer := (p_req.params ->> 'version')::integer;
  v_account   bigint;
  v_deal_own  uuid;
  v_owner     uuid;
  v_reason    text;
  v_due       date;
  v_task      bigint;
  v_act       bigint;
  v_approver  text;
BEGIN
  SELECT * INTO v_ver FROM deal_scope_version WHERE id = p_req.target_id FOR UPDATE;
  v_found := FOUND;
  IF v_found THEN
    v_deal_id := v_ver.deal_id;
    v_version := v_ver.version;
  END IF;
  SELECT d.account_id, d.owner_id INTO v_account, v_deal_own FROM deal d WHERE d.id = v_deal_id;
  v_owner := approval_first_active_member(ARRAY[
    v_deal_own,
    approval_member_uuid(p_req.requested_by),
    (SELECT ln.owner_id FROM loop_node ln WHERE ln.node = p_req.node)
  ]);

  IF NOT v_found THEN
    v_reason := 'version_missing';
  ELSIF v_ver.status <> 'draft' THEN
    v_reason := 'version_not_draft';
  ELSIF v_ver.send_approved_at IS NOT NULL THEN
    v_reason := 'version_already_approved';
  ELSIF approval_params_hash(p_req.action_type, p_req.target_table, p_req.target_id, approval_offer_content(v_ver))
        IS DISTINCT FROM p_req.params_hash THEN
    v_reason := 'version_changed';
  END IF;

  IF v_reason IS NOT NULL THEN
    v_task := approval_human_task(
      'Zkontrolovat nabídku (verze ' || coalesce(v_version::text, '?') || '): schválení k odeslání se neuplatnilo',
      'Žádost č. ' || p_req.id || ' o schválení odeslání byla schválena, ale verze se neoznačila ('
        || CASE v_reason
             WHEN 'version_missing' THEN 'verze už neexistuje'
             WHEN 'version_not_draft' THEN 'verze už není koncept'
             WHEN 'version_already_approved' THEN 'verze už je schválená jinou žádostí'
             ELSE 'obsah verze se od žádosti změnil'
           END
        || '). Nic se neodeslalo. Zkontroluj nabídku a případně požádej o schválení znovu.',
      v_owner, v_account, CASE WHEN v_account IS NULL THEN NULL ELSE v_deal_id END);
    RETURN QUERY SELECT 'needs_attention'::text,
      jsonb_build_object('reason', v_reason, 'task_id', v_task, 'assignee_id', v_owner,
                         'deal_id', v_deal_id, 'version', v_version);
    RETURN;
  END IF;

  -- Jediný povolený přechod: koncept → schváleno k odeslání (strážce SV007
  -- pustí jen tuto transakci s id téže žádosti).
  PERFORM set_config('app.approval_exec', p_req.id::text, true);
  UPDATE deal_scope_version
     SET send_approved_at = now(), send_approval_request_id = p_req.id
   WHERE id = v_ver.id;
  PERFORM set_config('app.approval_exec', '', true);

  v_approver := coalesce(
    (SELECT tm.full_name FROM team_member tm WHERE tm.id = approval_member_uuid(p_req.decided_by)),
    'schvalovatel');
  v_due := approval_add_working_days(approval_today(), (v_settings ->> 'task_working_days')::integer);

  v_task := approval_human_task(
    (v_settings ->> 'task_title') || ' (verze ' || v_version || ')',
    'Verze ' || v_version || ' nabídky je schválená k odeslání (žádost č. ' || p_req.id || ', schválil(a) '
      || v_approver || '). Cockpit nic neodesílá: pošli nabídku klientovi sám a potom ji na detailu obchodu označ jako odeslanou.',
    v_owner, v_account, v_deal_id, 'high', v_due);

  -- Záznam na časovou osu obchodu. Klíč (source, external_id) = idempotence.
  INSERT INTO sales_activity (account_id, deal_id, kind, outcome, subject, body, occurred_at, created_by, source, external_id)
  VALUES (
    v_account, v_deal_id, 'note', 'completed',
    'Nabídka (verze ' || v_version || ') schválena k odeslání',
    'Žádost č. ' || p_req.id || ' schválil(a) ' || v_approver || '. Cockpit nic neodeslal; úkol „'
      || (v_settings ->> 'task_title') || '“ čeká do ' || to_char(v_due, 'FMDD. FMMM. YYYY') || '.',
    now(), NULL, 'approval', 'approval:' || p_req.id
  )
  ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_act;

  RETURN QUERY SELECT 'completed'::text,
    jsonb_build_object('version_id', v_ver.id, 'version', v_version, 'deal_id', v_deal_id, 'task_id', v_task,
                       'activity_id', v_act, 'assignee_id', v_owner, 'due_on', v_due);
END $$;

-- Zamítnuto / vypršelo: případ (obchod) se vrací vlastníkovi s úkolem.
CREATE OR REPLACE FUNCTION approval_exec_return_to_owner(p_req approval_request)
RETURNS TABLE (out_status text, out_result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case     work_case%ROWTYPE;
  v_ver      deal_scope_version%ROWTYPE;
  v_what     text := CASE p_req.status WHEN 'rejected' THEN 'zamítnuta' ELSE 'vypršela bez rozhodnutí' END;
  v_note     text := CASE WHEN p_req.status = 'rejected' AND nullif(btrim(p_req.decision_note), '') IS NOT NULL
                          THEN ' Poznámka schvalovatele: „' || left(btrim(p_req.decision_note), 500) || '“.'
                          ELSE '' END;
  v_deal_id  bigint;
  v_version  integer;
  v_account  bigint;
  v_deal_own uuid;
  v_owner    uuid;
  v_task     bigint;
  v_act      bigint;
BEGIN
  IF p_req.action_type = 'confirm_next_step' THEN
    SELECT * INTO v_case FROM work_case WHERE id = p_req.target_id FOR UPDATE;
    IF NOT FOUND OR v_case.status IN ('done', 'cancelled') THEN
      -- Uzavřený případ se nevrací nikomu — není co rozhodovat.
      RETURN QUERY SELECT 'completed'::text, jsonb_build_object('reason', 'case_closed');
      RETURN;
    END IF;
    v_owner := approval_first_active_member(ARRAY[
      v_case.lead_owner_id,
      (SELECT ln.owner_id FROM loop_node ln WHERE ln.node = p_req.node),
      approval_member_uuid(p_req.requested_by)
    ]);
    v_task := approval_human_task(
      'Rozhodnout, jak dál: návrh kroku „' || left(coalesce(p_req.params ->> 'title', 'další krok'), 200) || '“ '
        || CASE p_req.status WHEN 'rejected' THEN 'zamítnut' ELSE 'vypršel' END,
      'Žádost č. ' || p_req.id || ' o potvrzení dalšího kroku v případu „' || left(v_case.title, 200) || '“ ' || v_what
        || '.' || v_note || ' Případ se ti vrací: uprav návrh a požádej znovu, nebo zvol jiný postup.',
      v_owner, v_case.account_id, v_case.deal_id);
    RETURN QUERY SELECT 'completed'::text,
      jsonb_build_object('reason', 'returned_to_owner', 'task_id', v_task, 'assignee_id', v_owner);
    RETURN;
  END IF;

  -- send_offer
  SELECT * INTO v_ver FROM deal_scope_version WHERE id = p_req.target_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'completed'::text, jsonb_build_object('reason', 'version_missing');
    RETURN;
  END IF;
  v_deal_id := v_ver.deal_id;
  v_version := v_ver.version;
  SELECT d.account_id, d.owner_id INTO v_account, v_deal_own FROM deal d WHERE d.id = v_deal_id;
  v_owner := approval_first_active_member(ARRAY[
    v_deal_own,
    approval_member_uuid(p_req.requested_by),
    (SELECT ln.owner_id FROM loop_node ln WHERE ln.node = p_req.node)
  ]);
  v_task := approval_human_task(
    'Nabídka (verze ' || v_version || '): odeslání ' || CASE p_req.status WHEN 'rejected' THEN 'zamítnuto' ELSE 'vypršelo' END
      || ' — upravit, nebo požádat znovu',
    'Žádost č. ' || p_req.id || ' o schválení odeslání verze ' || v_version || ' ' || v_what || '.' || v_note
      || ' Nic se neodeslalo. Verze zůstává konceptem: založ upravenou verzi, nebo požádej o schválení znovu.',
    v_owner, v_account, v_deal_id);
  INSERT INTO sales_activity (account_id, deal_id, kind, outcome, subject, body, occurred_at, created_by, source, external_id)
  VALUES (
    v_account, v_deal_id, 'note', 'completed',
    'Odeslání nabídky (verze ' || v_version || ') ' || CASE p_req.status WHEN 'rejected' THEN 'zamítnuto' ELSE 'vypršelo' END,
    'Žádost č. ' || p_req.id || ' ' || v_what || '. Nic se neodeslalo; vlastník obchodu dostal úkol rozhodnout, jak dál.',
    now(), NULL, 'approval', 'approval:' || p_req.id
  )
  ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_act;
  RETURN QUERY SELECT 'completed'::text,
    jsonb_build_object('reason', 'returned_to_owner', 'task_id', v_task, 'assignee_id', v_owner,
                       'deal_id', v_deal_id, 'version', v_version, 'activity_id', v_act);
END $$;

-- Jádro: jeden výsledek na žádost. Volá decide_approval (schváleno/zamítnuto),
-- expire_due_approvals (vypršelo, opakování) a retry_approval_execution.
CREATE OR REPLACE FUNCTION approval_execute(p_request_id bigint, p_actor text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req     approval_request%ROWTYPE;
  v_prev    approval_execution%ROWTYPE;
  v_status  text;
  v_result  jsonb;
BEGIN
  -- FOR UPDATE: souběžná provedení téže žádosti se seřadí, druhé uvidí výsledek prvního.
  SELECT * INTO v_req FROM approval_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Požadavek % neexistuje', p_request_id USING ERRCODE = 'P0002';
  END IF;
  IF v_req.action_type IS NULL THEN
    RETURN NULL; -- žádost „jen záznam": nic se neprovádí
  END IF;
  IF v_req.status NOT IN ('approved', 'rejected', 'expired') THEN
    RAISE EXCEPTION 'Požadavek ještě není rozhodnutý' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_prev FROM approval_execution WHERE request_id = p_request_id;
  IF FOUND AND v_prev.status <> 'failed' THEN
    RETURN v_prev.status; -- idempotence: provedeno jednou, podruhé nic
  END IF;

  -- Podtransakce: chyba vrátí všechny zápisy akce, výsledek je failed.
  BEGIN
    IF v_req.status = 'approved' AND v_req.action_type = 'confirm_next_step' THEN
      SELECT e.out_status, e.out_result INTO v_status, v_result FROM approval_exec_confirm_next_step(v_req) e;
    ELSIF v_req.status = 'approved' AND v_req.action_type = 'send_offer' THEN
      SELECT e.out_status, e.out_result INTO v_status, v_result FROM approval_exec_send_offer(v_req) e;
    ELSE
      SELECT e.out_status, e.out_result INTO v_status, v_result FROM approval_exec_return_to_owner(v_req) e;
    END IF;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'Provedení nevrátilo výsledek' USING ERRCODE = 'XX000';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Jen SQLSTATE: text výjimky může nést hodnoty řádku.
    RAISE WARNING '0084: provedení žádosti % selhalo (SQLSTATE %), nic se nezapsalo', p_request_id, SQLSTATE;
    v_status := 'failed';
    v_result := jsonb_build_object('sqlstate', SQLSTATE);
  END;

  INSERT INTO approval_execution AS e
    (request_id, case_id, action_type, request_status, status, result, attempts, executed_by, executed_at)
  VALUES
    (v_req.id, v_req.case_id, v_req.action_type, v_req.status, v_status, coalesce(v_result, '{}'::jsonb), 1,
     coalesce(p_actor, 'system:approval-executor'), now())
  ON CONFLICT (request_id) DO UPDATE
     SET status = EXCLUDED.status,
         result = EXCLUDED.result,
         attempts = e.attempts + 1,
         executed_by = EXCLUDED.executed_by,
         executed_at = EXCLUDED.executed_at
   WHERE e.status = 'failed';
  RETURN v_status;
END $$;

-- ===========================================================================
-- 6) RPC
-- ===========================================================================

-- Typovaná žádost o schválení. Aktér z auth.uid() (loop_actor: přihlášený
-- člen týmu s AAL2). Vrací id žádosti; stejnou čekající žádost vrátí místo
-- založení druhé.
CREATE OR REPLACE FUNCTION request_action_approval(
  p_action_type  text,
  p_target_id    bigint,
  p_params       jsonb DEFAULT '{}'::jsonb,
  p_expires_at   timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        text := loop_actor();
  v_settings     jsonb := approval_action_settings() -> p_action_type;
  v_case         work_case%ROWTYPE;
  v_ver          deal_scope_version%ROWTYPE;
  v_params       jsonb;
  v_content      jsonb;
  v_hash         text;
  v_node         text;
  v_case_id      bigint;
  v_target_table text;
  v_transition   text;
  v_expires      timestamptz;
  v_policy       text;
  v_title        text;
  v_assignee     uuid;
  v_due          date;
  v_decision     bigint;
  v_id           bigint;
BEGIN
  IF p_action_type IS NULL OR p_action_type NOT IN ('confirm_next_step', 'send_offer') OR v_settings IS NULL THEN
    RAISE EXCEPTION 'Neznámý druh akce' USING ERRCODE = '22023';
  END IF;
  IF p_target_id IS NULL THEN
    RAISE EXCEPTION 'Chybí cíl žádosti' USING ERRCODE = '22023';
  END IF;
  v_expires := coalesce(p_expires_at, now() + make_interval(days => (v_settings ->> 'validity_days')::integer));
  IF v_expires <= now() THEN
    RAISE EXCEPTION 'Platnost požadavku musí končit v budoucnu' USING ERRCODE = '22023';
  END IF;
  IF v_expires > now() + interval '90 days' THEN
    RAISE EXCEPTION 'Platnost požadavku může být nejvýš 90 dní' USING ERRCODE = '22023';
  END IF;

  IF p_action_type = 'confirm_next_step' THEN
    -- FOR SHARE: případ se během žádosti neuzavře ani nepřesune.
    SELECT * INTO v_case FROM work_case WHERE id = p_target_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Případ % neexistuje', p_target_id USING ERRCODE = 'P0002';
    END IF;
    IF v_case.status IN ('done', 'cancelled') THEN
      RAISE EXCEPTION 'Případ je uzavřený — schválení už nejde žádat' USING ERRCODE = 'LP004';
    END IF;
    v_title := btrim(coalesce(p_params ->> 'title', ''));
    IF char_length(v_title) NOT BETWEEN 1 AND 300 THEN
      RAISE EXCEPTION 'Název kroku musí mít 1 až 300 znaků' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_assignee := (p_params ->> 'assignee_id')::uuid;
      v_due := (p_params ->> 'due_on')::date;
      v_decision := nullif(p_params ->> 'decision_id', '')::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Neplatné parametry kroku' USING ERRCODE = '22023';
    END;
    IF v_assignee IS NULL OR approval_first_active_member(ARRAY[v_assignee]) IS NULL THEN
      RAISE EXCEPTION 'Řešitel kroku musí být aktivní člen týmu' USING ERRCODE = '22023';
    END IF;
    IF v_due IS NULL OR v_due < approval_today() OR v_due > approval_today() + 365 THEN
      RAISE EXCEPTION 'Termín kroku musí být od dneška nejvýš za rok' USING ERRCODE = '22023';
    END IF;
    IF v_decision IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = v_decision AND d.case_id = v_case.id) THEN
      RAISE EXCEPTION 'Rozhodnutí nepatří k tomuto případu' USING ERRCODE = '22023';
    END IF;
    v_params := jsonb_build_object('title', v_title, 'assignee_id', v_assignee, 'due_on', v_due, 'decision_id', v_decision);
    v_content := v_params;
    v_node := v_case.node;
    v_case_id := v_case.id;
    v_target_table := 'work_case';
    v_transition := 'active>next_step_confirmed';
  ELSE
    -- send_offer: verze nabídky jsou obchodní údaj (0058/0072).
    IF NOT can_see_sales() THEN
      RAISE EXCEPTION 'Odeslání nabídky ke schválení posílá jen obchodní role' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_ver FROM deal_scope_version WHERE id = p_target_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Verze nabídky % neexistuje', p_target_id USING ERRCODE = 'P0002';
    END IF;
    IF v_ver.status <> 'draft' THEN
      RAISE EXCEPTION 'Schválit k odeslání jde jen koncept nabídky' USING ERRCODE = '22023';
    END IF;
    IF v_ver.send_approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'Verze nabídky už je schválená k odeslání' USING ERRCODE = '22023';
    END IF;
    -- Parametry bez částek (žádost čte celý tým); otisk kryje celý obsah verze.
    v_params := jsonb_build_object('deal_id', v_ver.deal_id, 'version_id', v_ver.id, 'version', v_ver.version);
    v_content := approval_offer_content(v_ver);
    -- Stejná žádost (dvojklik) se vrátí níže; čekající žádost na jiný obsah
    -- téže verze je chyba — nejdřív ať se rozhodne ta první.
    IF EXISTS (SELECT 1 FROM approval_request ar
                WHERE ar.action_type = 'send_offer' AND ar.target_table = 'deal_scope_version'
                  AND ar.target_id = v_ver.id AND ar.status = 'pending'
                  AND ar.params_hash IS DISTINCT FROM approval_params_hash(p_action_type, 'deal_scope_version', v_ver.id, v_content)) THEN
      RAISE EXCEPTION 'Žádost o schválení této verze už čeká' USING ERRCODE = '22023';
    END IF;
    v_node := v_settings ->> 'node';
    v_case_id := NULL;
    v_target_table := 'deal_scope_version';
    v_transition := 'draft>send_approved';
  END IF;

  v_hash := approval_params_hash(p_action_type, v_target_table, p_target_id, v_content);

  -- Úroveň = aktivní pravidlo činnosti (nejnižší), bez pravidla L2 (0053).
  SELECT ap.level INTO v_policy
    FROM authority_policy ap
   WHERE ap.action_kind = p_action_type AND ap.active AND loop_level_rank(ap.level) IS NOT NULL
   ORDER BY loop_level_rank(ap.level) ASC
   LIMIT 1;
  v_policy := coalesce(v_policy, 'L2');

  INSERT INTO approval_request (
    case_id, node, action_kind, requested_level, status, requested_by, expires_at,
    action_type, target_table, target_id, params, params_hash, transition
  ) VALUES (
    v_case_id, v_node, p_action_type, v_policy, 'pending', v_actor, v_expires,
    p_action_type, v_target_table, p_target_id, v_params, v_hash, v_transition
  )
  ON CONFLICT (action_type, target_table, target_id, params_hash)
    WHERE status = 'pending' AND action_type IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT ar.id INTO v_id FROM approval_request ar
     WHERE ar.action_type = p_action_type AND ar.target_table = v_target_table
       AND ar.target_id = p_target_id AND ar.params_hash = v_hash AND ar.status = 'pending';
  END IF;
  RETURN v_id;
END $$;

-- Rozhodnutí o žádosti: tělo 0057 beze změny (loop_actor, zámek, stav,
-- expirace, čtyři oči, pravomoc podle snímku uzlu) + dvě věci z 0084:
-- odeslání nabídky schvaluje jen obchodní role a po rozhodnutí se ve
-- stejné transakci spustí definovaný další krok (executor).
CREATE OR REPLACE FUNCTION decide_approval(
  p_request_id  bigint,
  p_approve     boolean,
  p_note        text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := loop_actor();
  v_req   approval_request%ROWTYPE;
  v_role  text;
  v_max   text;
  v_new   text;
BEGIN
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Chybí rozhodnutí (approve true/false)' USING ERRCODE = '22023';
  END IF;
  -- FOR UPDATE: dvě souběžná rozhodnutí nad týmž požadavkem se seřadí.
  SELECT * INTO v_req FROM approval_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Požadavek % neexistuje', p_request_id USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Požadavek už není čekající (stav %)', v_req.status USING ERRCODE = '22023';
  END IF;
  IF v_req.expires_at IS NOT NULL AND v_req.expires_at <= now() THEN
    RAISE EXCEPTION 'Požadavek vypršel' USING ERRCODE = '22023';
  END IF;
  -- Čtyři oči: explicitně (srozumitelná chyba), CHECK to jistí i v tabulce.
  IF v_req.requested_by = v_actor THEN
    RAISE EXCEPTION 'Vlastní požadavek nelze schválit ani zamítnout' USING ERRCODE = '42501';
  END IF;
  -- Pravomoc: role odvozená v SQL ze SNÍMKU uzlu (approval_request.node).
  v_role := loop_approver_role_for_node(auth.uid(), v_req.node);
  v_max := loop_role_max_level(v_role);
  IF v_max IS NULL
     OR loop_level_rank(v_req.requested_level) IS NULL
     OR loop_level_rank(v_req.requested_level) > loop_level_rank(v_max) THEN
    RAISE EXCEPTION 'Nemáš oprávnění schválit tuto úroveň' USING ERRCODE = '42501';
  END IF;
  -- 0084: nabídku vidí jen obchodní role, jen ta ji smí schválit k odeslání.
  IF v_req.action_type = 'send_offer' AND NOT can_see_sales() THEN
    RAISE EXCEPTION 'Odeslání nabídky schvaluje jen obchodní role' USING ERRCODE = '42501';
  END IF;
  v_new := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE approval_request
     SET status = v_new, decided_by = v_actor, decided_at = now(), decision_note = p_note,
         snoozed_until = NULL, snoozed_by = NULL
   WHERE id = p_request_id;
  -- 0084: definovaný další krok ve stejné transakci (provedení / návrat vlastníkovi).
  IF v_req.action_type IS NOT NULL THEN
    PERFORM approval_execute(p_request_id, v_actor);
  END IF;
  RETURN v_new;
END $$;

-- „Odložit do…" (p_until) / „Vrátit" (NULL). Jen kdo smí rozhodnout.
CREATE OR REPLACE FUNCTION snooze_approval(p_request_id bigint, p_until timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := loop_actor();
  v_req   approval_request%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM approval_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Požadavek % neexistuje', p_request_id USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Požadavek už není čekající (stav %)', v_req.status USING ERRCODE = '22023';
  END IF;
  IF v_req.expires_at IS NOT NULL AND v_req.expires_at <= now() THEN
    RAISE EXCEPTION 'Požadavek vypršel' USING ERRCODE = '22023';
  END IF;
  IF NOT approval_can_decide(auth.uid(), v_req) THEN
    RAISE EXCEPTION 'Odložit smí jen ten, kdo o žádosti může rozhodnout' USING ERRCODE = '42501';
  END IF;
  IF p_until IS NOT NULL THEN
    IF p_until <= now() THEN
      RAISE EXCEPTION 'Odložit jde jen do budoucna' USING ERRCODE = '22023';
    END IF;
    IF p_until > now() + interval '30 days' THEN
      RAISE EXCEPTION 'Odložit jde nejvýš o 30 dní' USING ERRCODE = '22023';
    END IF;
    IF v_req.expires_at IS NOT NULL AND p_until > v_req.expires_at THEN
      RAISE EXCEPTION 'Odložit jde nejvýš do konce platnosti žádosti' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE approval_request
     SET snoozed_until = p_until,
         snoozed_by = CASE WHEN p_until IS NULL THEN NULL ELSE v_actor END
   WHERE id = p_request_id;
  RETURN p_until;
END $$;

-- Zopakovat neúspěšné provedení (jen failed). Smí žadatel, kdo smí
-- rozhodnout, nebo vedení; akce je už rozhodnutá, opakování nic nerozšiřuje.
CREATE OR REPLACE FUNCTION retry_approval_execution(p_request_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor text := loop_actor();
  v_req   approval_request%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM approval_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Požadavek % neexistuje', p_request_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_execution e WHERE e.request_id = p_request_id AND e.status = 'failed') THEN
    RAISE EXCEPTION 'Provedení není co opakovat' USING ERRCODE = '22023';
  END IF;
  IF v_req.requested_by <> v_actor
     AND NOT loop_is_vedeni(auth.uid())
     AND NOT approval_can_decide(auth.uid(), v_req) THEN
    RAISE EXCEPTION 'Zopakovat provedení smí žadatel, schvalovatel nebo vedení' USING ERRCODE = '42501';
  END IF;
  RETURN approval_execute(p_request_id, v_actor);
END $$;

-- Denní úloha (jen service_role): vypršení + další stav, pak opakování
-- neúspěšných provedení. Vrací počty pro job_run.
CREATE OR REPLACE FUNCTION expire_due_approvals(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   constant text := 'system:approval-expiry';
  v_limit   integer := greatest(1, least(coalesce(p_limit, 200), 1000));
  r         record;
  v_status  text;
  v_expired integer := 0;
  v_retried integer := 0;
  v_counts  jsonb := jsonb_build_object('completed', 0, 'needs_attention', 0, 'failed', 0);
BEGIN
  -- Přihlášený uživatel sem nesmí (klientům EXECUTE odebráno; tohle je pojistka).
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Vypršení spouští jen plánovaná úloha' USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT ar.id FROM approval_request ar
     WHERE ar.status = 'pending' AND ar.expires_at IS NOT NULL AND ar.expires_at <= now()
     ORDER BY ar.expires_at, ar.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE approval_request
       SET status = 'expired', decided_at = now(), snoozed_until = NULL, snoozed_by = NULL
     WHERE id = r.id AND status = 'pending';
    IF FOUND THEN
      v_expired := v_expired + 1;
      v_status := approval_execute(r.id, v_actor);
      IF v_status IS NOT NULL THEN
        v_counts := jsonb_set(v_counts, ARRAY[v_status], to_jsonb((v_counts ->> v_status)::integer + 1));
      END IF;
    END IF;
  END LOOP;

  FOR r IN
    SELECT e.request_id FROM approval_execution e
     WHERE e.status = 'failed' AND e.attempts < 3
     ORDER BY e.executed_at
     LIMIT 50
  LOOP
    v_status := approval_execute(r.request_id, v_actor);
    v_retried := v_retried + 1;
    IF v_status IS NOT NULL THEN
      v_counts := jsonb_set(v_counts, ARRAY[v_status], to_jsonb((v_counts ->> v_status)::integer + 1));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'retried', v_retried) || v_counts;
END $$;

-- ===========================================================================
-- 7) Práva: vnitřní funkce nikomu z klientů; RPC jen authenticated;
--    vypršení jen service_role; čisté funkce hranice i klientům (strážce
--    deal_scope_version_send_guard běží s právy zapisujícího).
-- ===========================================================================

REVOKE ALL ON FUNCTION approval_add_working_days(date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_day_end(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_member_uuid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_params_hash(text, text, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_offer_content(deal_scope_version) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_first_active_member(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_can_decide(uuid, approval_request) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_human_task(text, text, uuid, bigint, bigint, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_exec_confirm_next_step(approval_request) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_exec_send_offer(approval_request) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_exec_return_to_owner(approval_request) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approval_execute(bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION deal_scope_version_send_guard() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION approval_action_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION approval_offer_requires_approval(numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approval_action_settings() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION approval_offer_requires_approval(numeric, numeric, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION request_action_approval(text, bigint, jsonb, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION decide_approval(bigint, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION snooze_approval(bigint, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION retry_approval_execution(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_action_approval(text, bigint, jsonb, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION decide_approval(bigint, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION snooze_approval(bigint, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION retry_approval_execution(bigint) TO authenticated;

REVOKE ALL ON FUNCTION expire_due_approvals(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION expire_due_approvals(integer) TO service_role;

-- ===========================================================================
-- 8) Audit (MUSÍ sedět s DB_AUDITED_TABLES v core/auditCoverage.ts)
-- ===========================================================================

-- approval_request: tvrdý trigger z 0064 s rozšířeným allow-listem.
-- params (název kroku = volný text) a decision_note jen názvem.
DROP TRIGGER IF EXISTS audit_row_change ON approval_request;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'action_kind,action_type,case_id,decided_at,decided_by,expires_at,node,params_hash,requested_by,requested_level,snoozed_by,snoozed_until,status,target_id,target_table,transition',
    '',
    '');

-- approval_execution: nová tabulka → měkký trigger (0082). result jen názvem.
DROP TRIGGER IF EXISTS audit_row_change_soft ON approval_execution;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON approval_execution
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'action_type,attempts,case_id,executed_at,executed_by,request_id,request_status,status',
    '',
    '',
    '');

-- deal_scope_version: měkký trigger z 0082 + nové sloupce schválení k odeslání.
DROP TRIGGER IF EXISTS audit_row_change_soft ON deal_scope_version;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON deal_scope_version
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'amount_one_time,created_by,currency,deal_id,decided_at,evidence_id,expected_mrr,send_approval_request_id,send_approved_at,sent_at,status,version',
    '',
    'evidence_id',
    '');

-- Kontrola konfigurace proti schématu (jako 0064/0082): jen ohlásí.
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
      AND c.relname IN ('approval_request', 'approval_execution', 'deal_scope_version')
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute att
        WHERE att.attrelid = c.oid AND att.attname = col.name AND att.attnum > 0 AND NOT att.attisdropped
      )
  LOOP
    RAISE WARNING '0084: audit trigger odkazuje na neexistující sloupec %', v_problem;
  END LOOP;
END $$;

-- ===========================================================================
-- 9) Pravidla pravomoci pro nové druhy akcí (jen když aktivní pravidlo chybí)
-- ===========================================================================

INSERT INTO authority_policy (action_kind, level, active, note, updated_by)
SELECT v.kind, 'L2', true, v.note, 'system:migration_0084'
FROM (VALUES
  ('confirm_next_step', 'Potvrdit dalsi krok pripadu: po schvaleni interni zapis kroku a ukolu (L2)'),
  ('send_offer', 'Odeslat nabidku klientovi: externi zavazek, Cockpit nic neodesila, jen zalozi ukol (L2)')
) AS v(kind, note)
WHERE NOT EXISTS (SELECT 1 FROM authority_policy ap WHERE ap.action_kind = v.kind AND ap.active);

INSERT INTO schema_migration (version, note)
VALUES ('0084', 'approval executor: approval_request nese druh akce, cil, otisk parametru, platnost a jediny prechod; approval_execution (completed/failed/needs_attention); confirm_next_step (krok + ukol) a send_offer (schvaleno k odeslani + ukol, nic se neodesila); vyprseni expire_due_approvals, odlozeni snooze_approval; strazce SV006-SV008')
ON CONFLICT (version) DO NOTHING;
