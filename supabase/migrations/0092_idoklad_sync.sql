-- 0092 — čtení z iDokladu: zdroj a doklad u finančních záznamů, fronta
-- „Rozdíly k vyřešení" (P2.3 revize stavu 29. 9. 2026).
--
-- PROČ: účetnictví zůstává v iDokladu (rozhodnutí vlastníka 28. 9. 2026,
-- ROZHODNUTI.md 10.1), ale Cockpit dosud opisoval „vyfakturováno" a „přijato"
-- ručně. Denní úloha (cron ares-enrich, přepínač IDOKLAD_SYNC_ENABLED, výchozí
-- vypnuto) teď ČTE vydané faktury a úhrady z iDokladu API v3, spáruje je
-- s firmou (IČO, název) a se záznamy Cockpitu (číslo dokladu, variabilní
-- symbol, částka) a zapíše jen jednoznačné shody. Nejisté a rozdíly jdou do
-- fronty níže; člověk je vyřeší na stránce Finance. Do iDokladu se NIKDY nic
-- nezapisuje (jen GET).
--
-- 1) FINANCIAL_RECORD (nové sloupce a zdroj)
--      source 'idoklad'      záznam vznikl z iDokladu (CHECK doplněn). Ruční
--                            'ucetnictvi' zůstává pro ručně opsaný doklad.
--      idoklad_kind          'invoice' (vydaná faktura ↔ druh 'invoiced')
--                            nebo 'payment' (úhrada ↔ druh 'received').
--      idoklad_id            id dokladu / úhrady v iDokladu. IDEMPOTENCE:
--                            částečný UNIQUE index (idoklad_kind, idoklad_id)
--                            přes VŠECHNY stavy — zrušený záznam se z iDokladu
--                            znovu nevytvoří (člověk ho zrušil vědomě).
--                            Spárovaný ruční záznam nese odkaz na doklad,
--                            i když jeho zdroj zůstal 'rucne' / 'milnik'
--                            (zdroj se podle 0063 po založení nemění).
--      idoklad_due_on        SPLATNOST z iDokladu (DateOfMaturity) — vlastní
--                            sloupec této větve. Větev s polem „Splatnost"
--                            (migrace 0090) není v main; po jejím sloučení se
--                            sloupec sjednotí s ní (jeden sloupec splatnosti,
--                            sloupec idoklad_due_on se pak převede a zruší).
--    Strážce financial_record_idoklad_guard: přihlášený člověk (auth.uid())
--    údaje z iDokladu nezapíše ani nepřepíše — jen servisní zápis úlohy
--    (a serverové akce nad frontou, které píší servisním klíčem s hlavičkou
--    aktéra). Ostatní sloupce hlídá strážce z 0063 beze změny.
--    Audit financial_record (0082, měkký) se NEMĚNÍ: nové sloupce nejsou
--    v allow-listu, do auditu jde jen jejich NÁZEV v `_columns` (hodnota
--    `source = 'idoklad'` je vidět). Zápisy úlohy nesou aktéra
--    system:job:idoklad-sync a stav údaje source_fact.
--
-- 2) IDOKLAD_DISCREPANCY — fronta „Rozdíly k vyřešení" pro vedení
--      kind    amount_mismatch        faktura a záznam mají různou částku/měnu
--              payment_mismatch       stav úhrady se liší (úhrada v iDokladu
--                                     × záznamy „přijato" v Cockpitu)
--              invoice_without_record faktura v iDokladu, kterou nejde zapsat
--                                     jednoznačně (neznámá firma, víc kandidátů,
--                                     nepodporovaná měna)
--              record_without_invoice potvrzený záznam „vyfakturováno" s číslem
--                                     dokladu, který v iDokladu není
--      status  open / resolved / dismissed; resolution applied / dismissed /
--              auto (rozdíl zmizel sám, např. po opravě záznamu).
--      dedupe_key  vygenerovaný klíč (druh + doklad + záznam), UNIQUE:
--              jeden rozdíl = jeden řádek, běh ho nezdvojí.
--      fingerprint otisk stavu (částky, stavy): odložený („dismissed") rozdíl
--              se znovu otevře jen když se otisk změní.
--    Zapisuje výhradně servisní klíč (úloha a serverové akce); člen týmu
--    řádky jen čte a rozhoduje (UPDATE, strážce idoklad_discrepancy_guard
--    dovolí měnit jen rozhodnutí a vynutí resolved_by = auth.uid()). Nemaže
--    nikdo. RLS jako financial_record: RESTRICTIVE AAL2 + sales_only
--    (jen obchodní role). Audit: měkký trigger (0082) — id, druh, stav,
--    rozhodnutí s hodnotou; číslo dokladu, důvod a částky jen názvem.
--    Řádky auditu vidí jen obchodní role (politika
--    audit_event_sales_only_idoklad, RESTRICTIVE — vedle 0082, žádná
--    předefinace cizí politiky).
--
-- ZÁVISLOSTI: 0063 (financial_record), 0064 (audit_row_change), 0082
-- (audit_row_change_soft), 0002 (team_member, is_team_member), 0006
-- (set_updated_at), 0020 (can_see_sales), 0026 (ledger). Guard níže skončí
-- srozumitelnou chybou. IDEMPOTENTNÍ: IF NOT EXISTS, DROP … IF EXISTS,
-- CREATE OR REPLACE, ON CONFLICT. Kód je tolerantní k chybějícím
-- sloupcům i tabulce (stránka Finance ukáže „čeká na migraci 0092").

DO $$
BEGIN
  IF to_regclass('public.financial_record') IS NULL THEN
    RAISE EXCEPTION '0092 vyžaduje tabulku financial_record — nejdřív aplikujte 0063_financial_record.sql';
  END IF;
  IF to_regclass('public.account') IS NULL OR to_regclass('public.team_member') IS NULL
     OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0092 vyžaduje account, team_member a is_team_member() — nejdřív aplikujte 0001 a 0002';
  END IF;
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION '0092 vyžaduje funkci set_updated_at() — nejdřív aplikujte 0006_tasks_and_calendar.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0092 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0092 vyžaduje audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regclass('public.audit_event') IS NULL THEN
    RAISE EXCEPTION '0092 vyžaduje tabulku audit_event — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0092 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) financial_record: zdroj 'idoklad', odkaz na doklad, splatnost
-- ===========================================================================

ALTER TABLE financial_record DROP CONSTRAINT IF EXISTS financial_record_source_check;
ALTER TABLE financial_record ADD CONSTRAINT financial_record_source_check
  CHECK (source IN ('rucne', 'nabidka', 'milnik', 'ucetnictvi', 'idoklad'));

ALTER TABLE financial_record ADD COLUMN IF NOT EXISTS idoklad_kind text;
ALTER TABLE financial_record ADD COLUMN IF NOT EXISTS idoklad_id bigint;
ALTER TABLE financial_record ADD COLUMN IF NOT EXISTS idoklad_due_on date;

ALTER TABLE financial_record DROP CONSTRAINT IF EXISTS financial_record_idoklad_check;
ALTER TABLE financial_record ADD CONSTRAINT financial_record_idoklad_check CHECK (
  -- odkaz na doklad je celý, nebo žádný
  (idoklad_kind IS NULL) = (idoklad_id IS NULL)
  AND (idoklad_kind IS NULL
       OR (idoklad_kind = 'invoice' AND kind = 'invoiced')
       OR (idoklad_kind = 'payment' AND kind = 'received'))
  -- záznam ze zdroje iDoklad se vždy opírá o doklad
  AND (source <> 'idoklad' OR idoklad_id IS NOT NULL)
  -- splatnost má jen faktura
  AND (idoklad_due_on IS NULL OR idoklad_kind = 'invoice')
);

-- Idempotence podle id dokladu v iDokladu (všechny stavy).
CREATE UNIQUE INDEX IF NOT EXISTS financial_record_idoklad_uidx
  ON financial_record(idoklad_kind, idoklad_id)
  WHERE idoklad_id IS NOT NULL;

COMMENT ON COLUMN financial_record.idoklad_kind IS
  'invoice (vydaná faktura, druh invoiced) nebo payment (úhrada, druh received) z iDokladu; NULL = záznam bez odkazu na doklad.';
COMMENT ON COLUMN financial_record.idoklad_id IS
  'Id dokladu nebo úhrady v iDokladu API v3; podle něj je načítání idempotentní. Zapisuje jen úloha (servisní klíč).';
COMMENT ON COLUMN financial_record.idoklad_due_on IS
  'Splatnost faktury z iDokladu (DateOfMaturity). Vlastní sloupec; po sloučení větve s polem Splatnost (0090) se sjednotí s ním.';

CREATE OR REPLACE FUNCTION financial_record_idoklad_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- service_role / migrace nemají auth.uid() → vyjmuté (úloha a serverové akce).
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.idoklad_kind IS NOT NULL OR NEW.idoklad_id IS NOT NULL OR NEW.idoklad_due_on IS NOT NULL
       OR NEW.source = 'idoklad' THEN
      RAISE EXCEPTION 'Údaje z iDokladu zapisuje jen automatické načtení'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.idoklad_kind, NEW.idoklad_id, NEW.idoklad_due_on)
        IS DISTINCT FROM (OLD.idoklad_kind, OLD.idoklad_id, OLD.idoklad_due_on) THEN
    RAISE EXCEPTION 'Údaje z iDokladu zapisuje jen automatické načtení'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS financial_record_idoklad_guard ON financial_record;
CREATE TRIGGER financial_record_idoklad_guard
  BEFORE INSERT OR UPDATE ON financial_record
  FOR EACH ROW EXECUTE FUNCTION financial_record_idoklad_guard();

-- ===========================================================================
-- 2) idoklad_discrepancy: fronta „Rozdíly k vyřešení"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS idoklad_discrepancy (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL,
  status           text NOT NULL DEFAULT 'open',
  reason           text NOT NULL,
  idoklad_kind     text,
  idoklad_id       bigint,
  document_number  text,
  account_id       bigint REFERENCES account(id) ON DELETE CASCADE,
  record_id        bigint REFERENCES financial_record(id) ON DELETE CASCADE,
  currency         text,
  idoklad_amount   numeric(14,2),
  record_amount    numeric(14,2),
  fingerprint      text NOT NULL,
  dedupe_key       text GENERATED ALWAYS AS (
    kind || ':' || coalesce(idoklad_kind, '-') || ':' || coalesce(idoklad_id::text, '-') || ':' || coalesce(record_id::text, '-')
  ) STORED,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES team_member(id) ON DELETE SET NULL,
  resolution       text,
  resolution_note  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idoklad_discrepancy_kind_check
    CHECK (kind IN ('amount_mismatch', 'payment_mismatch', 'invoice_without_record', 'record_without_invoice')),
  CONSTRAINT idoklad_discrepancy_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT idoklad_discrepancy_doc_kind_check
    CHECK (idoklad_kind IS NULL OR idoklad_kind IN ('invoice', 'payment')),
  CONSTRAINT idoklad_discrepancy_doc_pair_check
    CHECK ((idoklad_kind IS NULL) = (idoklad_id IS NULL)),
  -- Rozdíl se vždy týká dokladu, nebo záznamu (nebo obojího).
  CONSTRAINT idoklad_discrepancy_target_check
    CHECK (idoklad_id IS NOT NULL OR record_id IS NOT NULL),
  CONSTRAINT idoklad_discrepancy_resolution_check
    CHECK (resolution IS NULL OR resolution IN ('applied', 'dismissed', 'auto')),
  -- Otevřený rozdíl nemá rozhodnutí, vyřešený ho má.
  CONSTRAINT idoklad_discrepancy_resolved_check
    CHECK ((status = 'open') = (resolution IS NULL AND resolved_at IS NULL)),
  CONSTRAINT idoklad_discrepancy_reason_check
    CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT idoklad_discrepancy_note_check
    CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  CONSTRAINT idoklad_discrepancy_document_check
    CHECK (document_number IS NULL OR char_length(document_number) <= 200),
  CONSTRAINT idoklad_discrepancy_dedupe_uk UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idoklad_discrepancy_open_idx
  ON idoklad_discrepancy(kind, last_seen_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idoklad_discrepancy_account_idx
  ON idoklad_discrepancy(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idoklad_discrepancy_record_idx
  ON idoklad_discrepancy(record_id) WHERE record_id IS NOT NULL;

COMMENT ON TABLE idoklad_discrepancy IS
  'Fronta „Rozdíly k vyřešení": co denní čtení z iDokladu nedokázalo zapsat jednoznačně nebo v čem se Cockpit a iDoklad liší. Zapisuje jen úloha; člen týmu rozhoduje. Jen obchodní role (sales_only).';
COMMENT ON COLUMN idoklad_discrepancy.fingerprint IS
  'Otisk stavu rozdílu (částky, stavy). Odložený rozdíl se znovu otevře jen při změně otisku.';

DROP TRIGGER IF EXISTS idoklad_discrepancy_set_updated_at ON idoklad_discrepancy;
CREATE TRIGGER idoklad_discrepancy_set_updated_at BEFORE UPDATE ON idoklad_discrepancy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Strážce rozhodnutí: přihlášený člověk smí jen uzavřít otevřený rozdíl
-- (vyřešeno / odloženo) a vždy jako on sám a „teď". Servisní zápis úlohy
-- (bez auth.uid()) nemá omezení.
CREATE OR REPLACE FUNCTION idoklad_discrepancy_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.idoklad_kind, NEW.idoklad_id, NEW.document_number, NEW.account_id, NEW.record_id,
      NEW.currency, NEW.idoklad_amount, NEW.record_amount, NEW.reason, NEW.fingerprint, NEW.first_seen_at, NEW.last_seen_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.idoklad_kind, OLD.idoklad_id, OLD.document_number, OLD.account_id, OLD.record_id,
      OLD.currency, OLD.idoklad_amount, OLD.record_amount, OLD.reason, OLD.fingerprint, OLD.first_seen_at, OLD.last_seen_at) THEN
    RAISE EXCEPTION 'Rozdíl z iDokladu lze jen uzavřít, ne přepsat'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'Uzavřený rozdíl už člověk znovu neotevírá'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('resolved', 'dismissed') OR NEW.resolution NOT IN ('applied', 'dismissed') THEN
      RAISE EXCEPTION 'Rozdíl lze uzavřít jako vyřešený nebo odložený'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.resolved_by := auth.uid();
    NEW.resolved_at := now();
  ELSIF (NEW.resolution, NEW.resolution_note, NEW.resolved_at, NEW.resolved_by)
        IS DISTINCT FROM (OLD.resolution, OLD.resolution_note, OLD.resolved_at, OLD.resolved_by) THEN
    RAISE EXCEPTION 'Rozhodnutí o rozdílu se po uzavření nemění'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS idoklad_discrepancy_guard ON idoklad_discrepancy;
CREATE TRIGGER idoklad_discrepancy_guard
  BEFORE UPDATE ON idoklad_discrepancy
  FOR EACH ROW EXECUTE FUNCTION idoklad_discrepancy_guard();

ALTER TABLE idoklad_discrepancy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idoklad_discrepancy_select ON idoklad_discrepancy;
CREATE POLICY idoklad_discrepancy_select ON idoklad_discrepancy FOR SELECT
  USING ((SELECT is_team_member()));

DROP POLICY IF EXISTS idoklad_discrepancy_update ON idoklad_discrepancy;
CREATE POLICY idoklad_discrepancy_update ON idoklad_discrepancy FOR UPDATE
  USING ((SELECT is_team_member()))
  WITH CHECK ((SELECT is_team_member()));

-- INSERT ani DELETE politika záměrně NENÍ (default-deny): zapisuje jen servisní klíč.

DROP POLICY IF EXISTS require_aal2 ON idoklad_discrepancy;
CREATE POLICY require_aal2 ON idoklad_discrepancy
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS sales_only ON idoklad_discrepancy;
CREATE POLICY sales_only ON idoklad_discrepancy
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

REVOKE ALL ON idoklad_discrepancy FROM anon;
REVOKE INSERT, DELETE, TRUNCATE ON idoklad_discrepancy FROM authenticated;

-- ===========================================================================
-- 3) Audit (MUSÍ sedět s DB_AUDITED_TABLES v core/auditCoverage.ts)
-- ===========================================================================

-- Číslo dokladu, důvod, částky, měna, poznámka a otisk jen názvem v `_columns`;
-- last_seen_at (denní „viděno znovu") není auditní událost.
DROP TRIGGER IF EXISTS audit_row_change_soft ON idoklad_discrepancy;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON idoklad_discrepancy
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,idoklad_id,idoklad_kind,kind,record_id,resolution,resolved_at,resolved_by,status',
    'last_seen_at',
    '',
    '');

-- Kontrola konfigurace proti schématu (jako 0082/0084): jen ohlásí.
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
    WHERE t.tgname = 'audit_row_change_soft' AND NOT t.tgisinternal AND col.name <> ''
      AND c.relname = 'idoklad_discrepancy'
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute att
        WHERE att.attrelid = c.oid AND att.attname = col.name AND att.attnum > 0 AND NOT att.attisdropped
      )
  LOOP
    RAISE WARNING '0092: audit_row_change_soft odkazuje na neexistující sloupec %', v_problem;
  END LOOP;
END $$;

-- Historii rozdílů vidí jen obchodní role. RESTRICTIVE se spojuje přes AND
-- s audit_event_read, require_aal2 i s politikami z 0064 a 0082 — jen zužuje;
-- vlastní politika (ne předefinace cizí) nekoliduje s ostatními větvemi.
DROP POLICY IF EXISTS audit_event_sales_only_idoklad ON audit_event;
CREATE POLICY audit_event_sales_only_idoklad ON audit_event
  AS RESTRICTIVE FOR SELECT
  USING (entity_table <> 'idoklad_discrepancy' OR (SELECT can_see_sales()));

INSERT INTO schema_migration (version, note)
VALUES ('0092', 'iDoklad: financial_record.source idoklad + idoklad_kind/idoklad_id (idempotence) + idoklad_due_on (splatnost, sjednotit s 0090); fronta idoklad_discrepancy (rozdily k vyreseni, jen obchodni role, audit); strazci; nic se do iDokladu nezapisuje')
ON CONFLICT (version) DO NOTHING;
