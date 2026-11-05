-- 0087 — contact: skutečné políčko „Nesouhlasí s oslovením".
--
-- PROČ: nesouhlas s oslovením se dosud poznal jen heuristikou z poznámky
-- („nekontaktovat", „odhlásil se z odběru"… — domain/crm/outreachContacts.ts).
-- Poznámka je volný text: vzor nemusí sednout a nikde není vidět, kdo a kdy
-- nesouhlas zapsal. Teď má kontakt vlastní příznak; heuristika nad poznámkou
-- zůstává jako druhá pojistka.
--
-- CO SE MĚNÍ (jen contact, žádná nová tabulka)
--
-- 1) Sloupce:
--      do_not_contact         boolean  nesouhlasí s oslovením (výchozí false)
--      do_not_contact_at      kdy se nesouhlas zapsal
--      do_not_contact_reason  odkud/proč, krátký text (nejvýš 300 znaků)
--      do_not_contact_by      kdo nesouhlas zapsal (team_member, SET NULL)
--    CHECK: bez nesouhlasu jsou ostatní tři prázdné; s nesouhlasem je čas vyplněný.
--
-- 2) Trigger contact_do_not_contact_stamp (BEFORE INSERT OR UPDATE): čas
--    a autora doplňuje DATABÁZE, klient je podvrhnout nemůže. Přihlášený
--    člen týmu = auth.uid() a now(). Servisní zápis (bez auth.uid(), např.
--    import) smí poslat vlastní čas (ne v budoucnu) a autora. Trvající
--    nesouhlas si čas i autora drží (mění se jen důvod). Zrušení nesouhlasu
--    vymaže čas, důvod i autora — historie zůstane v auditu.
--
-- 3) Audit: obecný trigger audit_row_change() z 0064 se na contact napojí
--    znovu s rozšířeným allow-listem: do_not_contact, do_not_contact_at
--    a do_not_contact_by s HODNOTOU, důvod (volný text, osobní údaj) jen
--    NÁZVEM v `_columns` — stejně jako jméno, e-mail a poznámka. Musí sedět
--    s DB_AUDITED_TABLES.contact v core/auditCoverage.ts
--    (test/audit-coverage-0064.test.ts; AUDIT_TRIGGER_REDEFINITIONS).
--
-- 4) Částečný index contact(account_id) WHERE do_not_contact — fronta
--    oslovování a seznamy k oslovení se ptají „kdo u firmy nesouhlasí".
--
-- RLS / AAL2: contact má RLS (0003, 0058: čte/zakládá/upravuje tým, maže
-- admin) a RESTRICTIVE require_aal2 (0007). Nové sloupce jsou součást řádku,
-- takže je kryjí stejné politiky; nic se nepřidává ani neuvolňuje. Guard
-- ověří, že RLS na contact je zapnuté; chybějící AAL2 jen ohlásí (NOTICE),
-- stejně jako 0058 (prostředí s odloženým MFA).
--
-- POŘADÍ NASAZENÍ: migrace může jít před kódem i po něm. Kód bez ní běží
-- (sloupec chybí → heuristika nad poznámkou, zaškrtnutý nesouhlas se odmítne
-- srozumitelnou hláškou místo tichého zahození).
--
-- IDEMPOTENTNÍ: ADD COLUMN IF NOT EXISTS, constraint v DO bloku, CREATE OR
-- REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE, CREATE INDEX IF NOT
-- EXISTS, ON CONFLICT DO NOTHING.

DO $$
BEGIN
  IF to_regclass('public.contact') IS NULL OR to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0087 vyžaduje tabulky contact a team_member — nejdřív aplikujte 0001_base_schema.sql a 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change()') IS NULL THEN
    RAISE EXCEPTION '0087 vyžaduje funkci audit_row_change() — nejdřív aplikujte 0064_audit_coverage.sql';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION '0087 vyžaduje funkci auth.uid() (Supabase Auth)';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0087 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contact'::regclass) THEN
    RAISE EXCEPTION '0087: contact nemá zapnuté RLS — nejdřív aplikujte 0003_rls.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.contact'::regclass AND NOT polpermissive
      AND pg_get_expr(polqual, polrelid) ILIKE '%aal2%'
  ) THEN
    RAISE NOTICE '0087: contact zatím nemá RESTRICTIVE AAL2 politiku (0007) — nové sloupce kryje stejné RLS jako zbytek řádku';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Sloupce a konzistence

ALTER TABLE contact ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS do_not_contact_at timestamptz;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS do_not_contact_reason text;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS do_not_contact_by uuid REFERENCES team_member(id) ON DELETE SET NULL;

COMMENT ON COLUMN contact.do_not_contact IS 'Nesouhlasí s oslovením (0087). Takový kontakt se nenabízí k oslovení (fronta, seznamy, konektor).';
COMMENT ON COLUMN contact.do_not_contact_at IS 'Kdy se nesouhlas zapsal (doplňuje trigger contact_do_not_contact_stamp).';
COMMENT ON COLUMN contact.do_not_contact_reason IS 'Odkud/proč nesouhlas, krátký text. Osobní údaj: do auditu jen názvem sloupce.';
COMMENT ON COLUMN contact.do_not_contact_by IS 'Kdo nesouhlas zapsal (doplňuje trigger z auth.uid()).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contact_do_not_contact_reason_len' AND conrelid = 'public.contact'::regclass
  ) THEN
    ALTER TABLE contact ADD CONSTRAINT contact_do_not_contact_reason_len
      CHECK (do_not_contact_reason IS NULL OR char_length(do_not_contact_reason) <= 300);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contact_do_not_contact_consistent' AND conrelid = 'public.contact'::regclass
  ) THEN
    ALTER TABLE contact ADD CONSTRAINT contact_do_not_contact_consistent CHECK (
      CASE WHEN do_not_contact
        THEN do_not_contact_at IS NOT NULL
        ELSE do_not_contact_at IS NULL AND do_not_contact_reason IS NULL AND do_not_contact_by IS NULL
      END
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Čas a autor nesouhlasu z databáze

CREATE OR REPLACE FUNCTION contact_do_not_contact_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NEW.do_not_contact IS NOT TRUE THEN
    NEW.do_not_contact := false;
    NEW.do_not_contact_at := NULL;
    NEW.do_not_contact_reason := NULL;
    NEW.do_not_contact_by := NULL;
    RETURN NEW;
  END IF;

  NEW.do_not_contact_reason := nullif(btrim(NEW.do_not_contact_reason), '');

  IF TG_OP = 'UPDATE' AND OLD.do_not_contact THEN
    -- Nesouhlas trvá: kdy a kdo se nepřepisuje, měnit jde jen důvod.
    NEW.do_not_contact_at := OLD.do_not_contact_at;
    NEW.do_not_contact_by := OLD.do_not_contact_by;
  ELSIF v_uid IS NOT NULL THEN
    NEW.do_not_contact_at := now();
    NEW.do_not_contact_by := v_uid;
  ELSE
    -- Servisní zápis (import, API): vlastní čas smí, jen ne v budoucnu.
    NEW.do_not_contact_at := least(coalesce(NEW.do_not_contact_at, now()), now());
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION contact_do_not_contact_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION contact_do_not_contact_stamp() FROM anon, authenticated;

DROP TRIGGER IF EXISTS contact_do_not_contact_stamp ON contact;
CREATE TRIGGER contact_do_not_contact_stamp
  BEFORE INSERT OR UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION contact_do_not_contact_stamp();

-- ---------------------------------------------------------------------------
-- 3) Audit: contact s rozšířeným allow-listem (0064 + nesouhlas, důvod jen názvem)

DROP TRIGGER IF EXISTS audit_row_change ON contact;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON contact
  FOR EACH ROW EXECUTE FUNCTION audit_row_change(
    'account_id,do_not_contact,do_not_contact_at,do_not_contact_by,is_champion,partner_id',
    '',
    '');

-- ---------------------------------------------------------------------------
-- 4) Index pro „kdo u firmy nesouhlasí"

CREATE INDEX IF NOT EXISTS contact_do_not_contact_idx ON contact(account_id) WHERE do_not_contact;

INSERT INTO schema_migration (version, note)
VALUES ('0087', 'contact.do_not_contact (+ kdy, důvod, kdo): nesouhlas s oslovením, čas a autor z DB, audit bez důvodu')
ON CONFLICT (version) DO NOTHING;
