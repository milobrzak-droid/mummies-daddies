-- 0033 — Aliasy firem a mateřské/dceřiné vztahy.
--
-- Kapitola 4 plánu přestavby ("Firma a oslovování", docs/PROVOZ.md)
-- pojmenovává konkrétní bolest: stejná firma se v CRM občas objeví dvakrát
-- pod jinou e-mailovou doménou (koupená značka, dceřinka posílající poštu
-- z vlastní domény) a nejde zaznamenat, že firma X je dcera firmy Y. Dopad
-- v praxi: duplicitní oslovování téhož vztahu a nemožnost vidět skupinu
-- firem pohromadě.
--
-- Řešení je záměrně skromné — nejde o sloučení řádků `account` (to by
-- zahodilo historii obou stran), jen o dva odkazy navíc:
--
-- 1) company_alias — "tahle doména/název patří k účtu X". Slouží k
--    rozpoznání, ne k automatickému sloučení: dedup se rozhoduje ručně,
--    tabulka jen drží fakt, že spolu ty dvě identity souvisí.
-- 2) relationship — směrovaný vztah mezi dvěma řádky `account`
--    (mateřská/dceřiná firma). Typ je text s výchozí hodnotou 'subsidiary',
--    ne enum — plán mluví jen o "mateřských a dceřiných vztazích", enum by
--    tu byl předčasná abstrakce nad jedním případem použití.
--
-- Mimo rozsah (viz kapitola 4): "segmenty" a "cílové seznamy" čekají na
-- manažerské rozhodnutí, které ještě nepadlo — nic z toho tu není.

CREATE TABLE IF NOT EXISTS company_alias (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  alias_domain text,
  alias_name   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Alias musí nést aspoň jednu identifikující hodnotu — prázdný řádek by
  -- k ničemu neodkazoval.
  CONSTRAINT company_alias_has_value CHECK (alias_domain IS NOT NULL OR alias_name IS NOT NULL)
);

-- Přesný duplicitní řádek (stejná dvojice domain/name u stejného účtu) nemá
-- smysl evidovat dvakrát. COALESCE na prázdný řetězec, protože NULL = NULL
-- v UNIQUE indexu neplatí (dva řádky s NULL alias_name by jinak prošly jako
-- "různé", i kdyby měly stejnou doménu).
CREATE UNIQUE INDEX IF NOT EXISTS company_alias_unique_idx
  ON company_alias (account_id, COALESCE(alias_domain, ''), COALESCE(alias_name, ''));

CREATE INDEX IF NOT EXISTS company_alias_account_idx ON company_alias(account_id);
-- Opačný směr dotazu: "vídáme tuhle doménu, patří už k nějakému účtu?" —
-- přesně ten case, který má aliasy zabránit duplicitnímu oslovování.
CREATE INDEX IF NOT EXISTS company_alias_domain_idx ON company_alias(alias_domain) WHERE alias_domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS relationship (
  id                bigserial PRIMARY KEY,
  parent_account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  child_account_id  bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  relationship_type text NOT NULL DEFAULT 'subsidiary',
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Firma nemůže být sama sobě mateřská/dceřiná.
  CONSTRAINT relationship_not_self CHECK (parent_account_id != child_account_id)
);

-- Stejná dvojice (parent, child) ve stejném směru se nezapisuje dvakrát.
-- Opačný směr (B→A když už existuje A→B) se z UNIQUE indexu nedá vyloučit
-- — kontrola mezi řádky patří do CHECK, a Postgres CHECK nesmí sahat na
-- jiné řádky. Přímý dvouřádkový cyklus A→B→A proto hlídá aplikační vrstva
-- (wouldCreateDirectCycle v lib/queries/companyRelationships.ts, testováno
-- v test/company-relationships.test.ts) před zápisem, ne databáze.
CREATE UNIQUE INDEX IF NOT EXISTS relationship_unique_idx
  ON relationship (parent_account_id, child_account_id);

CREATE INDEX IF NOT EXISTS relationship_parent_idx ON relationship(parent_account_id);
CREATE INDEX IF NOT EXISTS relationship_child_idx ON relationship(child_account_id);

ALTER TABLE company_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship ENABLE ROW LEVEL SECURITY;

-- Stejný vzor jako biz_all v 0003_rls.sql: členové týmu čtou i zapisují,
-- nula omezení nad rámec členství — jde o běžná CRM data, ne o provozní
-- stav jako connector_state.
DROP POLICY IF EXISTS company_alias_all ON company_alias;
CREATE POLICY company_alias_all ON company_alias
  FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());

DROP POLICY IF EXISTS relationship_all ON relationship;
CREATE POLICY relationship_all ON relationship
  FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());

-- AAL2 nad rámec členství týmu — stejný vzor jako account/deal (0007) a
-- audit_event/connector_state (0028/0029), tedy současný idiomatický
-- zápis RESTRICTIVE politiky pro nové tabulky v této session.
DROP POLICY IF EXISTS require_aal2 ON company_alias;
CREATE POLICY require_aal2 ON company_alias
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS require_aal2 ON relationship;
CREATE POLICY require_aal2 ON relationship
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

INSERT INTO schema_migration (version, note)
VALUES ('0033', 'company_alias a relationship - aliasy domen a materske/dcerine vztahy')
ON CONFLICT (version) DO NOTHING;
