-- 0036 — databáze sama zakáže zrcadlový vztah A→B + B→A a duplicity aliasů
-- lišící se jen velikostí písmen.
--
-- PROČ: 0033 to nechala na aplikaci — "kontrola mezi řádky patří do CHECK,
-- a CHECK nesmí sahat na jiné řádky", takže přímý cyklus hlídá jen
-- wouldCreateDirectCycle() před zápisem (lib/actions/companyRelationships.ts).
-- Kontrola v appce je čti-pak-zapiš: dva souběžné požadavky (A→B a B→A)
-- obě uvidí "zrcadlo neexistuje" a obě zapíšou. Bezpečnostní review to
-- označilo za race condition. UNIQUE index na NEuspořádané dvojici to řeší
-- na úrovni databáze — LEAST/GREATEST udělají z (A,B) i (B,A) stejný klíč
-- (menší_id, větší_id), takže druhý insert selže s 23505 bez ohledu na
-- souběh. Aplikační kontrola zůstává jako přívětivá chybová hláška; index
-- je pojistka. Existující relationship_unique_idx (parent, child) se
-- nemění (slouží dál stejný-směr duplicitám a dotazům).
--
-- Druhá půlka: company_alias_unique_idx z 0033 porovnává doménu a název
-- case-sensitive, takže 'Acme.cz' a 'acme.cz' u téhož účtu prošly jako dva
-- různé aliasy — přesně ta duplicita, které měl index zabránit. Nový index
-- používá lower(coalesce(...)); starý se dropne až PO úspěšném vytvoření
-- nového, aby po celou dobu existovala nějaká unikátní pojistka. Aplikace
-- na indexy nespoléhá přes ON CONFLICT (jen prosté INSERTy), takže záměna
-- nic nerozbije; uživateli se místo dřívějšího "prošlo" ukáže chyba 23505
-- i u varianty jen s jinou velikostí písmen.
--
-- GUARDY: pokud v datech dnes porušení existuje, CREATE UNIQUE INDEX by
-- spadl obecným "could not create unique index ... key is duplicated".
-- DO bloky níž to zachytí předem a vypíšou, které řádky (id) je potřeba
-- ručně vyřešit. Migrace v tom případě skončí chybou a NIC nezmění
-- (starý alias index zůstává). Na prázdné tabulce guardy projdou.
--
-- Zámky: CREATE UNIQUE INDEX (bez CONCURRENTLY) drží na tabulce SHARE
-- zámek po dobu vytvoření — u tabulek s desítkami až stovkami řádků jde o
-- milisekundy; CONCURRENTLY nejde v transakčním bloku SQL editoru.

-- 1) Guard: zrcadlové dvojice ve `relationship`.
DO $$
DECLARE
  v_pairs  int;
  v_detail text;
BEGIN
  SELECT count(*),
         string_agg('(' || r1.id || ',' || r2.id || ')', ', ' ORDER BY r1.id)
    INTO v_pairs, v_detail
  FROM relationship r1
  JOIN relationship r2
    ON r1.parent_account_id = r2.child_account_id
   AND r1.child_account_id  = r2.parent_account_id
   AND r1.id < r2.id;

  IF v_pairs > 0 THEN
    RAISE EXCEPTION
      '0036: v tabulce relationship existuje % zrcadlových dvojic A->B / B->A (dvojice id: %). Jeden řádek z každé dvojice smaž ručně a migraci spusť znovu.',
      v_pairs, v_detail;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS relationship_unordered_pair_idx
  ON relationship (
    LEAST(parent_account_id, child_account_id),
    GREATEST(parent_account_id, child_account_id)
  );

-- 2) Guard: duplicitní aliasy lišící se jen velikostí písmen.
DO $$
DECLARE
  v_groups int;
  v_detail text;
BEGIN
  SELECT count(*), string_agg('account_id=' || account_id || ' ids=' || ids, '; ' ORDER BY account_id)
    INTO v_groups, v_detail
  FROM (
    SELECT account_id,
           string_agg(id::text, ',' ORDER BY id) AS ids
    FROM company_alias
    GROUP BY account_id, lower(COALESCE(alias_domain, '')), lower(COALESCE(alias_name, ''))
    HAVING count(*) > 1
  ) d;

  IF v_groups > 0 THEN
    RAISE EXCEPTION
      '0036: v tabulce company_alias existuje % skupin duplicitních aliasů (bez ohledu na velikost písmen): %. Zbytečné řádky smaž ručně a migraci spusť znovu.',
      v_groups, v_detail;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS company_alias_unique_ci_idx
  ON company_alias (account_id, lower(COALESCE(alias_domain, '')), lower(COALESCE(alias_name, '')));

-- Starý case-sensitive index je teď nadbytečný (nový je přísnější). Dropuje
-- se až tady, po úspěšném vytvoření nového.
DROP INDEX IF EXISTS company_alias_unique_idx;

INSERT INTO schema_migration (version, note)
VALUES ('0036', 'relationship_unordered_pair_idx (zadny zrcadlovy vztah A-B/B-A) + company_alias_unique_ci_idx (case-insensitive) nahrazuje company_alias_unique_idx')
ON CONFLICT (version) DO NOTHING;
