-- 0081 — auto_intake: automatické založení poptávky z příchozího e-mailu
-- (nový klient + kontakt + alias domény + obchod + úkol) a bezpečné „Zpět".
--
-- PROČ: firma nesmí dělat věci ručně. Když napíše nová firma (neznámá
-- doména) přímo majiteli schránky, Cockpit sám založí, co je potřeba
-- (klienta, kontakt, alias domény, otevřený obchod v Kvalifikaci s dalším
-- krokem „Odpovědět na poptávku" do 1 pracovního dne a úkol) a člověku
-- jen ukáže výsledek. Pravidla jistoty (kdy automaticky, kdy jen návrh
-- ke schválení) jsou v domain/crm/autoIntake.ts; tady je jen to, co musí
-- být atomické a hlídané databází. Návod pro provoz: docs/PROVOZ.md.
--
-- TŘI VĚCI V TÉTO MIGRACI
--   1) tabulka auto_intake — záznam KAŽDÉHO automatického založení: klíč
--      idempotence (Message-ID zprávy), doména, vazby na všechno, co vzniklo
--      (aby „Zpět" nic nezapomnělo), pražský den (denní limit) a stav
--      active | undone. Řádek ve stavu undone je zároveň paměť „tuhle
--      doménu jsme zamítli" — automat ji už nikdy nezaloží.
--   2) auto_intake_found(jsonb) — JEDNA transakce: kontrola duplicit a limitu,
--      založení všeho a napojení metadat pošty. Buď vznikne všechno, nebo nic
--      (žádní sirotci po půlce zápisu). Souběh cronu a webhooku serializuje
--      advisory zámek; opakované volání pro tutéž zprávu nic nezdvojí.
--      Volat smí jen service_role (cron, webhook).
--   3) auto_intake_undo(bigint) — tlačítko „Není poptávka" (Zpět): v jedné
--      transakci smaže, co automat založil, a doménu si zapamatuje. Odmítne
--      to (SQLSTATE AI001), když u klienta mezitím vznikla JAKÁKOLI další
--      práce (jiný obchod, kontakt, aktivita, úkol, dodávka, případ…) nebo
--      se obchod pohnul — tu člověk mazat jedním klikem nemá. Kontrola
--      prochází VŠECHNY cizí klíče na account/deal/contact z katalogu, takže
--      s budoucí tabulkou platí automaticky (default deny).
--
-- SOUKROMÍ (vědomá výjimka, viz docs/PROVOZ.md a
-- docs/PROVOZ.md): pošta se dál ukládá jako METADATA. Tahle
-- migrace ale dovoluje, aby automat u VYSOKÉ jistoty (osobní firemní adresa,
-- přímo na schránku, ne hromadná) založil kontakt se jménem z hlavičky
-- odesílatele a jeho e-mailem — tedy přesně to, co by člověk opsal ručně.
-- Předmět ani tělo se nečtou a neukládají nikdy. Nespárovaný freemail
-- nezanechá nic. Výjimka je vratná: „Zpět" kontakt smaže.
--
-- ODKAZY NA ZALOŽENÉ ŘÁDKY jsou ON DELETE SET NULL: ledger nesmí zmizet,
-- když někdo klienta smaže ručně — zůstane doména a stav. Doména je
-- identifikátor firmy (stejně jako company_alias.alias_domain), ne osoba.
--
-- VIDITELNOST: obchodní data → RLS jako meeting_note_intake (0078):
-- SELECT pro tým + RESTRICTIVE sales_only (can_see_sales) + RESTRICTIVE
-- require_aal2. Zápis jen přes service_role a RPC výše; authenticated má SELECT.
--
-- AUDIT: obecný trigger audit_row_change() (0064) — jen id, stavy a časy;
-- doména, klíč zprávy a důvody jen názvem sloupce. Musí sedět s
-- DB_AUDITED_TABLES.auto_intake v core/auditCoverage.ts. Všechny řádky,
-- které RPC zakládá a maže (account, contact, deal, task, sales_activity,
-- company_alias), auditují své vlastní triggery: aktér automatu je
-- 'system:auto_intake' (hlavička x-cockpit-audit-actor), aktér „Zpět" je
-- přihlášený člověk (auth.uid(), i uvnitř SECURITY DEFINER).
--
-- IDEMPOTENCE MIGRACE: IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS,
-- ON CONFLICT. Jen nová tabulka a funkce; žádný zásah do existujících dat.
--
-- ZÁVISLOSTI: 0011 (account.web/owner_id), 0020 (deal.owner_id/next_step,
-- sales_activity, can_see_sales), 0021 (sales_activity.source/external_id),
-- 0030 (account.last_*_at), 0038 (evidence), 0039 (loop_actor), 0041
-- (mail_event), 0064 (audit_row_change), 0026 (ledger). Guard níže skončí
-- srozumitelnou chybou. 0080 drží jiná větev, číslo 0081 je záměrné.

DO $$
BEGIN
  IF to_regclass('public.account') IS NULL
     OR to_regclass('public.contact') IS NULL
     OR to_regclass('public.deal') IS NULL
     OR to_regclass('public.task') IS NULL
     OR to_regclass('public.sales_activity') IS NULL
     OR to_regclass('public.company_alias') IS NULL
     OR to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje tabulky account, contact, deal, task, sales_activity, company_alias a team_member — nejdřív aplikujte starší migrace';
  END IF;
  IF to_regclass('public.mail_event') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje tabulku public.mail_event — nejdřív aplikujte 0041_mail_event.sql';
  END IF;
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje tabulku public.evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regprocedure('public.loop_actor()') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje funkci loop_actor() — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change()') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje funkci audit_row_change() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0081 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  -- Sloupce, na které RPC sahá přímo (z pozdějších migrací než 0001).
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'account' AND column_name IN ('web', 'owner_id', 'notes', 'last_inbound_at', 'last_outbound_at'))
           OR (table_name = 'deal' AND column_name IN ('owner_id', 'primary_contact_id', 'next_step', 'next_step_due', 'note'))
           OR (table_name = 'sales_activity' AND column_name IN ('source', 'external_id', 'follow_up_on', 'contact_id', 'deal_id'))
           OR (table_name = 'contact' AND column_name IN ('email', 'partner_id')))) <> 17 THEN
    RAISE EXCEPTION '0081 vyžaduje sloupce z migrací 0011, 0019, 0020, 0021 a 0030 — nejdřív aplikujte starší migrace';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS auto_intake (
  id           bigserial PRIMARY KEY,
  -- Odkud poptávka přišla; dnes jediná hodnota.
  source       text NOT NULL DEFAULT 'outlook_mail',
  -- Klíč idempotence: RFC 5322 Message-ID zprávy, ze které vzniklo. Jeden řádek na zprávu.
  source_key   text NOT NULL,
  -- Firemní doména odesílatele (malá písmena, bez '@'). Po „Zpět" paměť zamítnuté domény.
  domain       text NOT NULL,
  -- active = založeno a platí, undone = člověk klikl „Není poptávka".
  status       text NOT NULL DEFAULT 'active',
  -- Kdy zpráva přišla.
  occurred_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Pražský den založení (dodává volající) — z něj se počítá denní limit.
  created_day  date NOT NULL,
  account_id   bigint REFERENCES account(id) ON DELETE SET NULL,
  contact_id   bigint REFERENCES contact(id) ON DELETE SET NULL,
  deal_id      bigint REFERENCES deal(id) ON DELETE SET NULL,
  task_id      bigint REFERENCES task(id) ON DELETE SET NULL,
  activity_id  bigint REFERENCES sales_activity(id) ON DELETE SET NULL,
  alias_id     bigint REFERENCES company_alias(id) ON DELETE SET NULL,
  evidence_id  bigint REFERENCES evidence(id) ON DELETE SET NULL,
  -- Kódy pravidel, kvůli kterým šlo o vysokou jistotu (ne text zprávy).
  reasons      text[] NOT NULL DEFAULT '{}',
  created_by   text NOT NULL DEFAULT 'system:auto_intake',
  decided_by   text,
  decided_at   timestamptz,
  CONSTRAINT auto_intake_source_check CHECK (source ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT auto_intake_source_key_check CHECK (char_length(source_key) BETWEEN 1 AND 700),
  CONSTRAINT auto_intake_domain_check CHECK (
    char_length(domain) BETWEEN 3 AND 253 AND position('@' IN domain) = 0 AND domain = lower(domain)
  ),
  CONSTRAINT auto_intake_status_check CHECK (status IN ('active', 'undone')),
  -- Vrácené má kdo a kdy a žádné vazby (všechno, co vzniklo, je pryč).
  CONSTRAINT auto_intake_undone_consistent CHECK (
    (status = 'active' AND decided_at IS NULL AND decided_by IS NULL)
    OR (status = 'undone' AND decided_at IS NOT NULL AND decided_by IS NOT NULL
        AND account_id IS NULL AND contact_id IS NULL AND deal_id IS NULL
        AND task_id IS NULL AND activity_id IS NULL AND alias_id IS NULL)
  ),
  CONSTRAINT auto_intake_source_key_unique UNIQUE (source_key)
);

-- Denní limit: kolik jich vzniklo dnes.
CREATE INDEX IF NOT EXISTS auto_intake_day_idx ON auto_intake (created_day);
-- Paměť zamítnutých domén a „už se řešila".
CREATE INDEX IF NOT EXISTS auto_intake_domain_idx ON auto_intake (domain, status);
-- Karta „Nové poptávky" na Dnes = aktivní, nejnovější nahoře.
CREATE INDEX IF NOT EXISTS auto_intake_active_idx ON auto_intake (created_at DESC) WHERE status = 'active';
-- Cizí klíče s ON DELETE SET NULL (výmaz klienta/kontaktu/obchodu… nesmí skenovat tabulku).
CREATE INDEX IF NOT EXISTS auto_intake_account_idx ON auto_intake (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_intake_contact_idx ON auto_intake (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_intake_deal_idx ON auto_intake (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_intake_task_idx ON auto_intake (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_intake_activity_idx ON auto_intake (activity_id) WHERE activity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_intake_alias_idx ON auto_intake (alias_id) WHERE alias_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_intake_evidence_idx ON auto_intake (evidence_id) WHERE evidence_id IS NOT NULL;

ALTER TABLE auto_intake ENABLE ROW LEVEL SECURITY;

-- Čtení pro tým; žádná INSERT/UPDATE/DELETE politika → klient nezapíše nic.
DROP POLICY IF EXISTS auto_intake_read ON auto_intake;
CREATE POLICY auto_intake_read ON auto_intake
  FOR SELECT USING ((SELECT is_team_member()));

-- Poptávka je obchodní věc (jako deal, 0058): jen obchodní role.
DROP POLICY IF EXISTS sales_only ON auto_intake;
CREATE POLICY sales_only ON auto_intake
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

DROP POLICY IF EXISTS require_aal2 ON auto_intake;
CREATE POLICY require_aal2 ON auto_intake
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON auto_intake FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON auto_intake FROM authenticated;
GRANT SELECT ON auto_intake TO authenticated;
GRANT ALL ON auto_intake TO service_role;
GRANT USAGE ON SEQUENCE auto_intake_id_seq TO service_role;

-- Audit (0064): jen id, stavy a časy; domain, source_key a reasons jen názvem
-- sloupce. MUSÍ sedět s DB_AUDITED_TABLES.auto_intake v core/auditCoverage.ts.
DROP TRIGGER IF EXISTS audit_row_change ON auto_intake;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON auto_intake
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,activity_id,alias_id,contact_id,created_by,deal_id,decided_at,decided_by,evidence_id,occurred_at,source,status,task_id',
    '',
    'evidence_id');

-- ---------------------------------------------------------------------------
-- Napojení metadat pošty na (nový nebo existující) klient. Nespárované
-- události téže domény se stanou spárovanými, ať klient má historii
-- a last_inbound_at / last_outbound_at. Spárovaná událost nese firmu, a jen
-- u zprávy, ze které vzniklo založení, i kontakt (CHECK mail_event_matched_has_account).
-- Volají ji jen obě RPC níž; klient ani anon ji volat nemůže.

CREATE OR REPLACE FUNCTION auto_intake_link_mail(
  p_account_id  bigint,
  p_domain      text,
  p_message_id  text,
  p_contact_id  bigint,
  p_occurred_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'auto_intake_link_mail: jen service_role' USING ERRCODE = '42501';
  END IF;
  UPDATE mail_event
     SET account_id = p_account_id,
         match_status = 'matched',
         counterpart_domain = NULL,
         contact_id = CASE
           WHEN direction = 'inbound' AND internet_message_id = p_message_id THEN p_contact_id
           ELSE NULL
         END
   WHERE match_status = 'unknown' AND counterpart_domain = p_domain;
  -- Monotónně: nejnovější spárovaná zpráva daného směru (a aspoň ta, ze které to vzniklo).
  UPDATE account
     SET last_inbound_at = GREATEST(
           last_inbound_at,
           p_occurred_at,
           (SELECT max(m.occurred_at) FROM mail_event m WHERE m.account_id = p_account_id AND m.direction = 'inbound')),
         last_outbound_at = GREATEST(
           last_outbound_at,
           (SELECT max(m.occurred_at) FROM mail_event m WHERE m.account_id = p_account_id AND m.direction = 'outbound'))
   WHERE id = p_account_id;
END $$;

REVOKE ALL ON FUNCTION auto_intake_link_mail(bigint, text, text, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auto_intake_link_mail(bigint, text, text, bigint, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- Atomické založení poptávky. Vstup je jediný jsonb (pravidla jistoty a texty
-- skládá aplikace, tady se jen ověří tvar a vloží):
--   message_id, domain, occurred_at, today (pražský den), daily_limit,
--   owner_id, evidence_id (nepovinné), reasons (pole kódů),
--   account {name, notes}, contact {full_name, email} (nepovinné),
--   deal {title, revenue_line, revenue_category, stage, next_step, next_step_due, note},
--   task {title, due_on, priority}, activity {subject}
-- Výstup: {status, …}:
--   created       všechno vzniklo (id, account_id, contact_id, deal_id, task_id, activity_id, alias_id)
--   duplicate     tuhle zprávu už jsme zpracovali (nic nového)
--   rejected      doménu člověk dřív zamítl („Není poptávka")
--   attached      doména už v CRM je → žádný druhý klient, jen aktivita u něj
--   ambiguous     doména vede na víc klientů → rozhodne člověk (návrh)
--   name_conflict firma se stejným názvem už existuje → rozhodne člověk (návrh)
--   limit         dnešní limit vyčerpán → aplikace založí návrh místo automatu

CREATE OR REPLACE FUNCTION auto_intake_found(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_message   text := nullif(btrim(p ->> 'message_id'), '');
  v_domain    text := lower(nullif(btrim(p ->> 'domain'), ''));
  v_day       date;
  v_limit     integer;
  v_owner     uuid;
  v_occurred  timestamptz;
  v_evidence  bigint;
  v_acc       jsonb := p -> 'account';
  v_con       jsonb := p -> 'contact';
  v_deal      jsonb := p -> 'deal';
  v_task      jsonb := p -> 'task';
  v_act       jsonb := p -> 'activity';
  v_reasons   text[] := '{}';
  v_name      text;
  v_existing  auto_intake%ROWTYPE;
  v_accs      bigint[];
  v_count     integer;
  v_account   bigint;
  v_alias     bigint;
  v_contact   bigint;
  v_dealid    bigint;
  v_taskid    bigint;
  v_activity  bigint;
  v_id        bigint;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'auto_intake_found: jen service_role' USING ERRCODE = '42501';
  END IF;

  -- ---- tvar vstupu (chyba = nic se nezapíše)
  IF v_message IS NULL OR char_length(v_message) > 700 THEN
    RAISE EXCEPTION 'auto_intake_found: chybí nebo je příliš dlouhé message_id' USING ERRCODE = '22023';
  END IF;
  IF v_domain IS NULL OR v_domain !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$' OR char_length(v_domain) > 253 THEN
    RAISE EXCEPTION 'auto_intake_found: neplatná doména' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_day := (p ->> 'today')::date;
    v_limit := (p ->> 'daily_limit')::integer;
    v_owner := (p ->> 'owner_id')::uuid;
    v_occurred := (p ->> 'occurred_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'auto_intake_found: neplatné today, daily_limit, owner_id nebo occurred_at' USING ERRCODE = '22023';
  END;
  IF v_day IS NULL OR v_limit IS NULL OR v_limit < 1 OR v_limit > 1000 OR v_owner IS NULL OR v_occurred IS NULL THEN
    RAISE EXCEPTION 'auto_intake_found: chybí today, daily_limit (1–1000), owner_id nebo occurred_at' USING ERRCODE = '22023';
  END IF;
  v_name := nullif(btrim(v_acc ->> 'name'), '');
  IF v_acc IS NULL OR v_name IS NULL OR char_length(v_name) > 300
     OR v_deal IS NULL OR nullif(btrim(v_deal ->> 'title'), '') IS NULL
     OR v_task IS NULL OR nullif(btrim(v_task ->> 'title'), '') IS NULL
     OR v_act IS NULL OR nullif(btrim(v_act ->> 'subject'), '') IS NULL THEN
    RAISE EXCEPTION 'auto_intake_found: chybí account.name, deal.title, task.title nebo activity.subject' USING ERRCODE = '22023';
  END IF;
  IF v_con IS NOT NULL AND jsonb_typeof(v_con) = 'object'
     AND (nullif(btrim(v_con ->> 'full_name'), '') IS NULL OR nullif(btrim(v_con ->> 'email'), '') IS NULL) THEN
    RAISE EXCEPTION 'auto_intake_found: kontakt musí mít full_name i email' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p -> 'reasons') = 'array' THEN
    SELECT coalesce(array_agg(left(r, 60)), '{}') INTO v_reasons FROM jsonb_array_elements_text(p -> 'reasons') AS r;
  END IF;
  IF p ->> 'evidence_id' IS NOT NULL THEN
    SELECT e.id INTO v_evidence FROM evidence e WHERE e.id = (p ->> 'evidence_id')::bigint;
  END IF;

  -- ---- souběh cronu a webhooku: jedno založení naráz (limit i duplicity jsou pak přesné)
  PERFORM pg_advisory_xact_lock(hashtextextended('auto_intake_found', 0));

  -- ---- idempotence: tuhle zprávu už jsme zpracovali
  SELECT * INTO v_existing FROM auto_intake WHERE source_key = v_message;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'id', v_existing.id, 'account_id', v_existing.account_id);
  END IF;
  IF EXISTS (SELECT 1 FROM sales_activity WHERE source = 'auto_intake' AND external_id = v_message) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  -- ---- doménu člověk dřív zamítl
  IF EXISTS (SELECT 1 FROM auto_intake WHERE domain = v_domain AND status = 'undone') THEN
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  -- ---- doména už v CRM je (alias, kontakt, web klienta) → nikdy druhý klient
  SELECT coalesce(array_agg(DISTINCT k.id), '{}') INTO v_accs FROM (
    SELECT ca.account_id AS id FROM company_alias ca
     WHERE ca.alias_domain IS NOT NULL AND regexp_replace(lower(ca.alias_domain), '^@', '') = v_domain
    UNION
    SELECT c.account_id FROM contact c
     WHERE c.account_id IS NOT NULL AND c.email IS NOT NULL AND lower(split_part(c.email, '@', 2)) = v_domain
    UNION
    SELECT a.id FROM account a
     WHERE a.web IS NOT NULL
       AND lower(substring(a.web FROM '^(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?(?:www\.)?([^/:?#[:space:]]+)')) = v_domain
  ) k;
  IF cardinality(v_accs) > 1 THEN
    RETURN jsonb_build_object('status', 'ambiguous', 'account_ids', to_jsonb(v_accs));
  END IF;
  IF cardinality(v_accs) = 1 THEN
    -- Jen aktivita u existujícího klienta (a spárování zpráv téže domény).
    INSERT INTO sales_activity (account_id, kind, outcome, subject, occurred_at, source, external_id)
    VALUES (v_accs[1], 'email', 'completed', left(v_act ->> 'subject', 300), v_occurred, 'auto_intake', v_message)
    RETURNING id INTO v_activity;
    PERFORM auto_intake_link_mail(v_accs[1], v_domain, v_message, NULL, v_occurred);
    RETURN jsonb_build_object('status', 'attached', 'account_id', v_accs[1], 'activity_id', v_activity);
  END IF;

  -- ---- firma stejného názvu už existuje: duplicitu automat nevyrobí
  IF EXISTS (SELECT 1 FROM account WHERE lower(btrim(name)) = lower(v_name)) THEN
    RETURN jsonb_build_object('status', 'name_conflict');
  END IF;

  -- ---- denní limit (počítají se i vrácená založení)
  SELECT count(*) INTO v_count FROM auto_intake WHERE created_day = v_day;
  IF v_count >= v_limit THEN
    RETURN jsonb_build_object('status', 'limit', 'count', v_count);
  END IF;

  -- ---- založení: všechno, nebo nic (jedna transakce)
  INSERT INTO account (name, owner_id, notes)
  VALUES (v_name, v_owner, nullif(left(v_acc ->> 'notes', 2000), ''))
  RETURNING id INTO v_account;

  INSERT INTO company_alias (account_id, alias_domain) VALUES (v_account, v_domain) RETURNING id INTO v_alias;

  IF v_con IS NOT NULL AND jsonb_typeof(v_con) = 'object' THEN
    INSERT INTO contact (account_id, full_name, email)
    VALUES (v_account, left(btrim(v_con ->> 'full_name'), 200), lower(left(btrim(v_con ->> 'email'), 254)))
    RETURNING id INTO v_contact;
  END IF;

  INSERT INTO deal (
    account_id, title, revenue_line, revenue_category, stage, owner_id, primary_contact_id,
    next_step, next_step_due, note
  ) VALUES (
    v_account,
    left(btrim(v_deal ->> 'title'), 300),
    (v_deal ->> 'revenue_line')::revenue_line,
    (v_deal ->> 'revenue_category')::revenue_category,
    (v_deal ->> 'stage')::deal_stage,
    v_owner,
    v_contact,
    nullif(left(v_deal ->> 'next_step', 300), ''),
    (v_deal ->> 'next_step_due')::date,
    nullif(left(v_deal ->> 'note', 2000), '')
  ) RETURNING id INTO v_dealid;

  INSERT INTO task (title, priority, assignee_id, due_on, account_id, deal_id)
  VALUES (
    left(btrim(v_task ->> 'title'), 300),
    coalesce(nullif(v_task ->> 'priority', ''), 'normal')::task_priority,
    v_owner,
    (v_task ->> 'due_on')::date,
    v_account,
    v_dealid
  ) RETURNING id INTO v_taskid;

  INSERT INTO sales_activity (
    account_id, deal_id, contact_id, kind, outcome, subject, occurred_at, follow_up_on, source, external_id
  ) VALUES (
    v_account, v_dealid, v_contact, 'email', 'completed', left(v_act ->> 'subject', 300), v_occurred,
    (v_deal ->> 'next_step_due')::date, 'auto_intake', v_message
  ) RETURNING id INTO v_activity;

  PERFORM auto_intake_link_mail(v_account, v_domain, v_message, v_contact, v_occurred);

  INSERT INTO auto_intake (
    source_key, domain, status, occurred_at, created_day,
    account_id, contact_id, deal_id, task_id, activity_id, alias_id, evidence_id, reasons
  ) VALUES (
    v_message, v_domain, 'active', v_occurred, v_day,
    v_account, v_contact, v_dealid, v_taskid, v_activity, v_alias, v_evidence, v_reasons
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'status', 'created', 'id', v_id, 'account_id', v_account, 'contact_id', v_contact,
    'deal_id', v_dealid, 'task_id', v_taskid, 'activity_id', v_activity, 'alias_id', v_alias
  );
END $$;

REVOKE ALL ON FUNCTION auto_intake_found(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auto_intake_found(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- „Není poptávka" (Zpět): smaže, co automat založil, a doménu si zapamatuje.
-- SECURITY DEFINER (klient nemá právo mazat), aktér VŽDY z loop_actor()
-- (auth.uid() + AAL2 + člen týmu) a obchodní role z can_see_sales().
-- Výjimky, které aplikace překládá na české věty:
--   P0002  záznam neexistuje
--   22023  už bylo vráceno
--   42501  bez oprávnění (nepřihlášen, bez AAL2, není člen týmu, bez obchodní role)
--   AI001  u klienta už je další práce → jedním klikem to nejde (nic se nesmaže)
-- Všechno běží v jedné transakci: buď zmizí všechno, nebo nic.

CREATE OR REPLACE FUNCTION auto_intake_undo(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   text := loop_actor();
  v_row     auto_intake%ROWTYPE;
  r         record;
  v_target_id bigint;
  v_owned   bigint[];
  v_n       bigint;
  v_task    task%ROWTYPE;
  v_deal    deal%ROWTYPE;
  v_deleted jsonb := '{}'::jsonb;
  v_cnt     integer;
BEGIN
  IF NOT can_see_sales() THEN
    RAISE EXCEPTION 'Poptávky smí vracet jen obchodní role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM auto_intake WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automatické založení % neexistuje', p_id USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'active' THEN
    RAISE EXCEPTION 'Už bylo vráceno' USING ERRCODE = '22023';
  END IF;

  -- ---- Co přesně jsme založili a je pořád beze změny? (jinak nic nemazat)
  IF v_row.task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM task WHERE id = v_row.task_id;
    IF FOUND AND (v_task.status::text <> 'todo' OR v_task.ms_event_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Úkol už někdo řeší nebo je v kalendáři — zpět to nejde' USING ERRCODE = 'AI001';
    END IF;
  END IF;
  IF v_row.deal_id IS NOT NULL THEN
    SELECT * INTO v_deal FROM deal WHERE id = v_row.deal_id;
    IF FOUND AND (v_deal.stage::text <> 'kvalifikace' OR coalesce(v_deal.amount_one_time, 0) <> 0) THEN
      RAISE EXCEPTION 'S obchodem se už pracuje — zpět to nejde' USING ERRCODE = 'AI001';
    END IF;
  END IF;

  -- ---- Cokoli dalšího, co ukazuje na klienta, obchod nebo kontakt (z katalogu, ne ze seznamu)
  FOR r IN
    SELECT c.conrelid AS relid, c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confrelid AS target
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND cardinality(c.conkey) = 1
       AND c.confrelid IN ('public.account'::regclass, 'public.deal'::regclass, 'public.contact'::regclass)
  LOOP
    -- Ledger sám a metadata pošty (jen metadata komunikace, odcházejí s klientem).
    CONTINUE WHEN r.tbl IN ('auto_intake', 'mail_event');
    v_target_id := CASE r.target
      WHEN 'public.account'::regclass THEN v_row.account_id
      WHEN 'public.deal'::regclass THEN v_row.deal_id
      ELSE v_row.contact_id
    END;
    CONTINUE WHEN v_target_id IS NULL;
    v_owned := CASE r.tbl
      WHEN 'contact' THEN ARRAY[v_row.contact_id]
      WHEN 'deal' THEN ARRAY[v_row.deal_id]
      WHEN 'task' THEN ARRAY[v_row.task_id]
      WHEN 'sales_activity' THEN ARRAY[v_row.activity_id]
      WHEN 'company_alias' THEN ARRAY[v_row.alias_id]
      ELSE ARRAY[]::bigint[]
    END;
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
      RAISE EXCEPTION 'U klienta už je další práce (%) — zpět to nejde', r.tbl USING ERRCODE = 'AI001';
    END IF;
  END LOOP;

  -- ---- Ledger: vráceno + paměť zamítnuté domény. Vazby se nulují hned (CHECK),
  -- audit nese, co to bylo, v `before` (samá čísla).
  UPDATE auto_intake
     SET status = 'undone', decided_by = v_actor, decided_at = now(),
         account_id = NULL, contact_id = NULL, deal_id = NULL, task_id = NULL, activity_id = NULL, alias_id = NULL
   WHERE id = p_id;

  -- ---- Smazání v pořadí od nejmenšího; každé musí zasáhnout právě očekávaný řádek.
  IF v_row.task_id IS NOT NULL THEN
    DELETE FROM task WHERE id = v_row.task_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('task', v_cnt);
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

  RETURN jsonb_build_object('status', 'undone', 'id', p_id, 'deleted', v_deleted);
END $$;

REVOKE ALL ON FUNCTION auto_intake_undo(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auto_intake_undo(bigint) TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0081', 'auto_intake: automaticke zalozeni poptavky z prichoziho e-mailu (klient, kontakt, alias, obchod, ukol) - atomicka RPC auto_intake_found (limit, duplicity, souboh), bezpecne Zpet auto_intake_undo (kontrola cizi prace z katalogu FK, pamet zamitnute domeny), audit trigger, jen obchodni role')
ON CONFLICT (version) DO NOTHING;
