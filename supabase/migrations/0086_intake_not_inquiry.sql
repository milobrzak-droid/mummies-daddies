-- 0086 — „Není poptávka" bez ruční práce: bezpečné Zpět i po práci
-- automatů a uzavření jedním klikem tam, kde už vznikla lidská práce.
--
-- PROČ: tlačítko „Není poptávka" (auto_intake_undo, 0081) odmítlo vrácení
-- i tehdy, když u klienta mezitím přibylo jen to, co tam dal SÁM Cockpit:
--   * další e-mail téže domény → automat ho připsal k firmě jako aktivitu
--     (auto_intake_found, stav 'attached', sales_activity.source = 'auto_intake'),
--   * follow-up hlídač založil případ „Follow-up: …" s krokem „Ozvat se
--     klientovi" (work_case.created_by 'system:…', nikdo na něj nesáhl),
--   * úkol „Odpovědět na poptávku" se tlačítkem Synchronizovat úkoly zapsal
--     do Outlooku (task.ms_event_id).
-- Hláška pak radila „smaž ho ručně", což na obrazovce nejde. A kde vrácení
-- opravdu nejde (vznikla lidská práce), nebyla v aplikaci žádná cesta.
--
-- TŘI VĚCI V TÉTO MIGRACI
--   1) auto_intake.status smí nově být 'dismissed' = uzavřeno jako „Není
--      poptávka" BEZ mazání (u klienta už byla lidská práce). Vazby zůstávají,
--      protože klient, obchod i úkol dál existují. CHECKy se vyměňují.
--   2) auto_intake_undo (CREATE OR REPLACE): za vlastní práci automatu bere
--      i výše uvedené tři případy a smaže je spolu s ostatním (úkol
--      v kalendáři jen nahlásí — událost v Outlooku smaže člověk, Cockpit do
--      cizího kalendáře nesahá). Nedotčený případ = stav 'open', všechny
--      kroky 'todo', v auditu žádný zásah člověka (aktér 'user'/'api_key')
--      a nic dalšího na něj neukazuje (rozhodnutí, schválení, alokace…,
--      z katalogu FK — default deny jako v 0081). Odmítnutí (AI001) nově nese
--      v DETAIL, co brání (task_started, deal_moved, nebo název tabulky), ať
--      aplikace řekne česky proč. Opraveno i to, že chybějící kontakt
--      (NULL v seznamu vlastních řádků) vypnul kontrolu cizích kontaktů.
--   3) auto_intake_dismiss(bigint) — alternativa jedním klikem: obchod
--      z poptávky do Prohráno s důvodem „Nebyla to poptávka", úkol
--      „Odpovědět na poptávku" uzavřít (hotovo), firmu odložit o rok
--      (account.snooze_until — vypadne z Oslovování a přehledů k oslovení)
--      a záznam poptávky označit 'dismissed'. Nic se nemaže. Vyhraný obchod
--      se nemění (AI002): poptávka to byla.
--
-- PRÁVA: obě funkce SECURITY DEFINER (klient nesmí mazat ani měnit
-- auto_intake), aktér VŽDY z loop_actor() (přihlášený člen týmu s AAL2)
-- a obchodní role z can_see_sales(). Volat smí authenticated, ne anon.
--
-- AUDIT: všechno, co funkce mění a maže, auditují triggery svých tabulek
-- (0034/0035 obchod, 0064 ostatní) s aktérem = přihlášený člověk
-- (auth.uid() platí i uvnitř SECURITY DEFINER). Změna stavu auto_intake jde
-- přes jeho trigger z 0081 (status, decided_by, decided_at jsou v allow-listu).
--
-- PRAŽSKÝ DEN: closed_at obchodu a odklad firmy se počítají v SQL stejně
-- jako v 0080 ((now() AT TIME ZONE 'Europe/Prague')::date) — klient datum
-- nepodstrčí.
--
-- IDEMPOTENCE: DROP CONSTRAINT IF EXISTS + ADD, CREATE OR REPLACE FUNCTION,
-- REVOKE/GRANT, ON CONFLICT. Data se nemění.
--
-- ZÁVISLOSTI: 0081 (auto_intake, auto_intake_undo), 0039 (work_case,
-- case_step, loop_actor), 0020 (deal.lost_reason/closed_at/forecast_category,
-- can_see_sales), 0030 (account.snooze_until), 0006 (task.ms_event_id),
-- 0028 (audit_event), 0026 (ledger). Guard níže skončí srozumitelnou chybou.
-- Čísla 0084 a 0085 drží jiné větve; 0086 je záměrné.

DO $$
BEGIN
  IF to_regclass('public.auto_intake') IS NULL OR to_regprocedure('public.auto_intake_undo(bigint)') IS NULL THEN
    RAISE EXCEPTION '0086 vyžaduje tabulku auto_intake a funkci auto_intake_undo — nejdřív aplikujte 0081_auto_intake.sql';
  END IF;
  IF to_regclass('public.work_case') IS NULL OR to_regclass('public.case_step') IS NULL
     OR to_regprocedure('public.loop_actor()') IS NULL THEN
    RAISE EXCEPTION '0086 vyžaduje work_case, case_step a loop_actor() — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0086 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.audit_event') IS NULL THEN
    RAISE EXCEPTION '0086 vyžaduje tabulku audit_event — nejdřív aplikujte 0028_audit_event.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0086 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  -- Sloupce, na které funkce sahají přímo (z pozdějších migrací než 0001).
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'deal' AND column_name IN ('lost_reason', 'closed_at', 'forecast_category', 'probability_pct', 'next_step', 'next_step_due'))
           OR (table_name = 'account' AND column_name = 'snooze_until')
           OR (table_name = 'task' AND column_name = 'ms_event_id')
           OR (table_name = 'sales_activity' AND column_name IN ('source', 'created_by'))
           OR (table_name = 'work_case' AND column_name IN ('created_by', 'account_id', 'deal_id'))
           OR (table_name = 'audit_event' AND column_name IN ('actor_type', 'before', 'after')))) <> 16 THEN
    RAISE EXCEPTION '0086 vyžaduje sloupce z migrací 0006, 0020, 0021, 0028, 0030 a 0039 — nejdřív aplikujte starší migrace';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Nový stav 'dismissed'

ALTER TABLE auto_intake DROP CONSTRAINT IF EXISTS auto_intake_status_check;
ALTER TABLE auto_intake ADD CONSTRAINT auto_intake_status_check
  CHECK (status IN ('active', 'undone', 'dismissed'));

-- Vrácené nemá žádné vazby (všechno je pryč); uzavřené bez mazání vazby drží.
-- Obojí nese kdo a kdy; aktivní ne.
ALTER TABLE auto_intake DROP CONSTRAINT IF EXISTS auto_intake_undone_consistent;
ALTER TABLE auto_intake ADD CONSTRAINT auto_intake_undone_consistent CHECK (
  (status = 'active' AND decided_at IS NULL AND decided_by IS NULL)
  OR (status = 'undone' AND decided_at IS NOT NULL AND decided_by IS NOT NULL
      AND account_id IS NULL AND contact_id IS NULL AND deal_id IS NULL
      AND task_id IS NULL AND activity_id IS NULL AND alias_id IS NULL)
  OR (status = 'dismissed' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
);

COMMENT ON COLUMN auto_intake.status IS
  'active = založeno a platí; undone = „Není poptávka" smazalo, co vzniklo (paměť zamítnuté domény); dismissed = uzavřeno jako „Není poptávka" bez mazání, protože u klienta byla lidská práce (obchod v Prohráno, firma odložená) — 0086.';

-- ---------------------------------------------------------------------------
-- 2) „Není poptávka" (Zpět): smaže, co založil automat — i to, co k poptávce
-- přidal později — a doménu si zapamatuje. Výjimky, které aplikace překládá:
--   P0002  záznam neexistuje
--   22023  už bylo vráceno / už je uzavřeno
--   42501  bez oprávnění (nepřihlášen, bez AAL2, není člen týmu, bez obchodní role)
--   AI001  u klienta je lidská práce → nic se nesmaže; DETAIL říká co
-- Všechno běží v jedné transakci: buď zmizí všechno, nebo nic.

CREATE OR REPLACE FUNCTION auto_intake_undo(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor     text := loop_actor();
  v_row       auto_intake%ROWTYPE;
  r           record;
  c           record;
  v_target_id bigint;
  v_owned     bigint[];
  v_n         bigint;
  v_ref       boolean;
  v_ok        boolean;
  v_task      task%ROWTYPE;
  v_deal      deal%ROWTYPE;
  v_acts      bigint[] := '{}';
  v_cases     bigint[] := '{}';
  v_calendar  boolean := false;
  v_deleted   jsonb := '{}'::jsonb;
  v_cnt       integer;
BEGIN
  IF NOT can_see_sales() THEN
    RAISE EXCEPTION 'Poptávky smí vracet jen obchodní role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM auto_intake WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automatické založení % neexistuje', p_id USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status = 'dismissed' THEN
    RAISE EXCEPTION 'Už je uzavřeno jako Není poptávka' USING ERRCODE = '22023';
  END IF;
  IF v_row.status <> 'active' THEN
    RAISE EXCEPTION 'Už bylo vráceno' USING ERRCODE = '22023';
  END IF;

  -- ---- Co přesně jsme založili a je pořád beze změny? (jinak nic nemazat)
  -- Úkol zapsaný do Outlooku (ms_event_id) je práce synchronizace, ne člověka:
  -- smaže se a aplikace řekne, ať člověk smaže i událost v kalendáři.
  IF v_row.task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM task WHERE id = v_row.task_id;
    IF FOUND THEN
      IF v_task.status::text <> 'todo' THEN
        RAISE EXCEPTION 'Úkol už někdo řeší — zpět to nejde' USING ERRCODE = 'AI001', DETAIL = 'task_started';
      END IF;
      v_calendar := v_task.ms_event_id IS NOT NULL;
    END IF;
  END IF;
  IF v_row.deal_id IS NOT NULL THEN
    SELECT * INTO v_deal FROM deal WHERE id = v_row.deal_id;
    IF FOUND AND (v_deal.stage::text <> 'kvalifikace' OR coalesce(v_deal.amount_one_time, 0) <> 0) THEN
      RAISE EXCEPTION 'S obchodem se už pracuje — zpět to nejde' USING ERRCODE = 'AI001', DETAIL = 'deal_moved';
    END IF;
  END IF;

  -- ---- Co k poptávce později přidal automat (a smí odejít s ní)
  -- a) další e-maily téže domény, které auto_intake_found připsal k firmě
  IF v_row.account_id IS NOT NULL THEN
    SELECT coalesce(array_agg(sa.id ORDER BY sa.id), '{}') INTO v_acts
      FROM sales_activity sa
     WHERE sa.account_id = v_row.account_id
       AND sa.source = 'auto_intake'
       AND sa.created_by IS NULL
       AND sa.id IS DISTINCT FROM v_row.activity_id;
  END IF;

  -- b) případy, které založil systém (follow-up hlídač…) a nikdo na ně nesáhl
  FOR c IN
    SELECT wc.id
      FROM work_case wc
     WHERE ((v_row.account_id IS NOT NULL AND wc.account_id = v_row.account_id)
         OR (v_row.deal_id IS NOT NULL AND wc.deal_id = v_row.deal_id))
       AND wc.created_by LIKE 'system:%'
       AND wc.status = 'open'
     ORDER BY wc.id
  LOOP
    v_ok := NOT EXISTS (SELECT 1 FROM case_step cs WHERE cs.case_id = c.id AND cs.status <> 'todo')
      -- Člověk v auditu (přihlášený nebo přes API klíč): případ, jeho kroky
      -- vzniklé, změněné i smazané. Bez auditu 0064 zůstává jen kontrola stavů.
      AND NOT EXISTS (
        SELECT 1 FROM audit_event ae
         WHERE ae.actor_type IN ('user', 'api_key')
           AND ((ae.entity_table = 'work_case' AND ae.entity_id = c.id)
             OR (ae.entity_table = 'case_step'
                 AND (ae.after ->> 'case_id' = c.id::text OR ae.before ->> 'case_id' = c.id::text
                      OR ae.entity_id IN (SELECT cs.id FROM case_step cs WHERE cs.case_id = c.id)))));
    IF v_ok THEN
      -- Cokoli dalšího, co na případ ukazuje (rozhodnutí, schválení, alokace,
      -- návrh…), je lidská práce. Z katalogu, ať platí i pro budoucí tabulky.
      FOR r IN
        SELECT cc.conrelid::regclass::text AS tbl, a.attname::text AS col
          FROM pg_constraint cc
          JOIN pg_attribute a ON a.attrelid = cc.conrelid AND a.attnum = cc.conkey[1]
         WHERE cc.contype = 'f' AND cardinality(cc.conkey) = 1
           AND cc.confrelid = 'public.work_case'::regclass
      LOOP
        CONTINUE WHEN r.tbl = 'case_step';
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', r.tbl, r.col) INTO v_ref USING c.id;
        IF v_ref THEN
          v_ok := false;
          EXIT;
        END IF;
      END LOOP;
    END IF;
    IF v_ok THEN
      v_cases := v_cases || c.id;
    END IF;
  END LOOP;

  -- ---- Cokoli dalšího, co ukazuje na klienta, obchod nebo kontakt (z katalogu, ne ze seznamu)
  FOR r IN
    SELECT cc.conrelid AS relid, cc.conrelid::regclass::text AS tbl, a.attname::text AS col, cc.confrelid AS target
      FROM pg_constraint cc
      JOIN pg_attribute a ON a.attrelid = cc.conrelid AND a.attnum = cc.conkey[1]
     WHERE cc.contype = 'f'
       AND cardinality(cc.conkey) = 1
       AND cc.confrelid IN ('public.account'::regclass, 'public.deal'::regclass, 'public.contact'::regclass)
  LOOP
    -- Ledger sám a metadata pošty (jen metadata komunikace, odcházejí s klientem).
    CONTINUE WHEN r.tbl IN ('auto_intake', 'mail_event');
    v_target_id := CASE r.target
      WHEN 'public.account'::regclass THEN v_row.account_id
      WHEN 'public.deal'::regclass THEN v_row.deal_id
      ELSE v_row.contact_id
    END;
    CONTINUE WHEN v_target_id IS NULL;
    -- Vlastní řádky bez NULL: NULL v poli by NOT (id = ANY(…)) změnil na NULL
    -- a cizí řádky by se nepočítaly (chyba 0081 u poptávky bez kontaktu).
    v_owned := array_remove(CASE r.tbl
      WHEN 'contact' THEN ARRAY[v_row.contact_id]
      WHEN 'deal' THEN ARRAY[v_row.deal_id]
      WHEN 'task' THEN ARRAY[v_row.task_id]
      WHEN 'sales_activity' THEN ARRAY[v_row.activity_id] || v_acts
      WHEN 'company_alias' THEN ARRAY[v_row.alias_id]
      WHEN 'work_case' THEN v_cases
      ELSE ARRAY[]::bigint[]
    END, NULL);
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = r.relid AND attname = 'id' AND NOT attisdropped) THEN
      IF r.tbl = 'case_proposal' THEN
        -- Čekající návrh od systému (třeba „odpověď od klienta") smí odejít s klientem; zbytek ne.
        EXECUTE format(
          'SELECT count(*) FROM %s WHERE %I = $1 AND NOT (id = ANY($2)) AND NOT (status = ''pending'' AND created_by LIKE ''system:%%'')',
          r.tbl, r.col) INTO v_n USING v_target_id, v_owned;
      ELSE
        EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1 AND NOT (id = ANY($2))', r.tbl, r.col)
          INTO v_n USING v_target_id, v_owned;
      END IF;
    ELSE
      -- Tabulka bez sloupce id (složený klíč, např. deal_partner): jakýkoli řádek je cizí práce.
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO v_n USING v_target_id;
    END IF;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'U klienta už je další práce (%) — zpět to nejde', r.tbl USING ERRCODE = 'AI001', DETAIL = r.tbl;
    END IF;
  END LOOP;

  -- ---- Ledger: vráceno + paměť zamítnuté domény. Vazby se nulují hned (CHECK),
  -- audit nese, co to bylo, v `before` (samá čísla).
  UPDATE auto_intake
     SET status = 'undone', decided_by = v_actor, decided_at = now(),
         account_id = NULL, contact_id = NULL, deal_id = NULL, task_id = NULL, activity_id = NULL, alias_id = NULL
   WHERE id = p_id;

  -- ---- Smazání v pořadí od nejmenšího; každé musí zasáhnout právě očekávaný řádek.
  -- Případ systému: kroky odejdou kaskádou (případ je 'open', strážce 0057 to pustí).
  IF cardinality(v_cases) > 0 THEN
    DELETE FROM work_case WHERE id = ANY(v_cases);
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('cases', v_cnt);
  END IF;
  IF v_row.task_id IS NOT NULL THEN
    DELETE FROM task WHERE id = v_row.task_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('task', v_cnt);
  END IF;
  IF cardinality(v_acts) > 0 THEN
    DELETE FROM sales_activity WHERE id = ANY(v_acts);
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('extra_activities', v_cnt);
  END IF;
  IF v_row.activity_id IS NOT NULL THEN
    DELETE FROM sales_activity WHERE id = v_row.activity_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('activity', v_cnt);
  END IF;
  IF v_row.deal_id IS NOT NULL THEN
    DELETE FROM deal WHERE id = v_row.deal_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('deal', v_cnt);
  END IF;
  IF v_row.contact_id IS NOT NULL THEN
    DELETE FROM contact WHERE id = v_row.contact_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('contact', v_cnt);
  END IF;
  IF v_row.alias_id IS NOT NULL THEN
    DELETE FROM company_alias WHERE id = v_row.alias_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('alias', v_cnt);
  END IF;
  IF v_row.account_id IS NOT NULL THEN
    -- Kaskáda odnese metadata pošty klienta (mail_event) a čekající systémové návrhy.
    DELETE FROM account WHERE id = v_row.account_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('account', v_cnt);
  END IF;

  RETURN jsonb_build_object('status', 'undone', 'id', p_id, 'deleted', v_deleted, 'calendar_event', v_calendar);
END $$;

REVOKE ALL ON FUNCTION auto_intake_undo(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auto_intake_undo(bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) „Uzavřít jako Není poptávka": kde Zpět nejde, jedním klikem a bez mazání.
--   obchod z poptávky  → Prohráno, důvod „Nebyla to poptávka" (vyhraný ne: AI002)
--   úkol z poptávky    → hotovo, pokud ještě běží
--   firma              → snooze_until = dnes + 365 dní (delší odklad zůstane)
--   záznam poptávky    → 'dismissed' (zmizí z karty Nové poptávky a štítku u klienta)
-- Výjimky: P0002, 22023 (už vráceno / už uzavřeno), 42501, AI002.

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
    SELECT stage::text INTO v_stage FROM deal WHERE id = v_row.deal_id FOR UPDATE;
    IF FOUND THEN
      IF v_stage = 'vyhráno' THEN
        RAISE EXCEPTION 'Obchod je vyhraný — poptávka to byla' USING ERRCODE = 'AI002';
      ELSIF v_stage = 'prohráno' THEN
        v_deal := 'already_lost';
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
VALUES ('0086', 'Neni poptavka: Zpet smaze i dalsi e-maily automatu, nedotceny follow-up pripad a ukol v kalendari (DETAIL u AI001, oprava NULL kontaktu); auto_intake_dismiss uzavre poptavku bez mazani (obchod Prohrano, ukol hotovo, firma odlozena o rok, stav dismissed)')
ON CONFLICT (version) DO NOTHING;
