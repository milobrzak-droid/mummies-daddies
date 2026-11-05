-- 0038 — evidence: odkaz na konkrétní zdroj, který údaj dokládá, a čtyři
-- rozlišené stavy údaje na audit_event.
--
-- Kapitola 3 plánu přestavby („Původ a audit", docs/PROVOZ.md) chce,
-- aby u důležité změny šlo dohledat nejen kdo a kdy (audit_event, 0028/0034),
-- ale i NA ZÁKLADĚ ČEHO — a aby schéma umělo odlišit fakt ze zdroje, návrh
-- AI, lidské potvrzení a skutečný výsledek (cílový dokument, „první test
-- kvality schématu"). Tahle migrace dodává obojí v nejmenší možné podobě.
--
-- 1) Tabulka `evidence` = ukazatel na zdroj, NE kopie zdroje.
--    Ukládá jen: druh zdroje, jeho identifikátor ve zdrojovém systému
--    (id e-mailové zprávy, id schůzky, cesta/id souboru, URL), volitelný
--    hluboký odkaz (webLink) a čas zachycení. Žádné tělo zprávy, žádný
--    přepis, žádný úryvek — stejný princip „ids, ne těla" jako u Outlook
--    konektoru (kontakty a obsah pošty zůstávají ve zdroji, tam platí jejich
--    práva a retence). Proto v tabulce záměrně není sloupec pro text a délky
--    identifikátoru a odkazu jsou omezené CHECKem — aby se sem obsah nedal
--    „propašovat" jako dlouhý řetězec. Kvůli tomu evidence neobsahuje osobní
--    údaje a smí být bezpečně odkazovaná z auditu, který žije bez výmazu
--    (viz 0037, kde se PII z auditu čistila).
--
--    Řádek je append-only: pro tým existuje jen politika SELECT; INSERT
--    smí jen service_role (ten RLS obchází), UPDATE/DELETE nikdo
--    (default-deny). Důvod: kdo by mohl přepsat, na co audit
--    ukazuje, ten by mohl zpětně změnit původ změny. Oprava chyby = nový
--    řádek. UNIQUE (source_kind, source_id) dělá z evidence sdílený ukazatel:
--    jeden zdrojový e-mail dokládá víc změn (cílový dokument: „jeden zdrojový
--    e-mail nesmí způsobit duplicitní vytvoření"), takže se zapisuje
--    `INSERT ... ON CONFLICT (source_kind, source_id) DO NOTHING` a znovu
--    se použije stávající id. captured_at je pak čas PRVNÍHO zachycení.
--
--    created_by je text, ne FK na team_member: stejně jako audit_event.actor_id
--    musí nést i API klíč nebo systém (např. 'user:<uuid>', 'api_key:<id>',
--    'system:<job>'); tvar určuje volající, DB ho nekontroluje.
--
-- 2) Sloupce na audit_event: `evidence_id` (nullable FK) a `info_state`
--    (nullable text s CHECK).
--    ZVOLENO: přímý FK sloupec, ne spojovací tabulka. Proč: (a) vztah
--    „víc auditních řádků → jedna evidence" (M:1) pokrývá případ ze
--    zadání a přímý FK ho vyjadřuje bez další tabulky, (b) čtení historie
--    je jeden JOIN, (c) plán chce tabulky vytvářet, až se hned použijí —
--    spojovací tabulka by řešila „jedna změna dokládaná několika zdroji"
--    (M:N), což dnes nikdo nepotřebuje. Až vznikne, přidá se link tabulka
--    a evidence_id zůstane jako „hlavní" zdroj; přechod nic nerozbije.
--    ON DELETE RESTRICT: evidenci, na kterou audit odkazuje, nejde smazat
--    (a stejně na ni není DELETE politika) — tichá ztráta původu by byla
--    horší než neúspěšné mazání.
--    `info_state` je text + CHECK, ne enum: v 0033 platí totéž a přidání
--    pátého stavu je pak jen výměna CHECKu, ne ALTER TYPE. Čtyři hodnoty
--    odpovídají TypeScriptu v core/informationState.ts (drží se ručně
--    synchronně; test tam hlídá seznam).
--    Stav patří na audit řádek, protože audit_event je jediná dnes existující
--    „věta o změně". Samostatné „tvrzení" (claim) tabulky zatím nejsou;
--    až vzniknou (kapitola 5+), dostanou stejný sloupec s týmž CHECKem.
--    Přechody mezi stavy (AI návrh → lidské potvrzení, nikdy potichu
--    → fakt ze zdroje; potvrzené se nevrací na návrh) hlídá čistá funkce
--    v core/informationState.ts. V DB je NEVYNUCUJEME: audit je append-only,
--    „přechod" je nový řádek, a spolehlivě jde kontrolovat až vůči tvrzení,
--    které zatím nemá tabulku.
--
-- BEZPEČNOST PRO STÁVAJÍCÍ DATA: žádný UPDATE ani NOT NULL. ADD COLUMN bez
-- DEFAULT s NULL je jen změna katalogu (bez přepisu tabulky), stávající řádky
-- a triggery z 0034/0035, které nové sloupce nezmiňují, dál fungují — dostanou
-- NULL. Migrace je idempotentní (IF NOT EXISTS, DROP POLICY IF EXISTS,
-- ON CONFLICT) a jde vložit do SQL editoru opakovaně.
--
-- Zámky: CREATE TABLE je bez zámku na cizí tabulky; ALTER TABLE audit_event
-- ADD COLUMN bere na zlomek sekundy ACCESS EXCLUSIVE (metadata only);
-- přidání FK sloupce bere navíc SHARE ROW EXCLUSIVE na evidence (nová, prázdná).

CREATE TABLE IF NOT EXISTS evidence (
  id          bigserial PRIMARY KEY,
  source_kind text NOT NULL,
  source_id   text NOT NULL,
  web_link    text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  CONSTRAINT evidence_source_kind_check
    CHECK (source_kind IN ('email_message', 'meeting', 'file', 'url')),
  -- Identifikátor, ne obsah: krátký a neprázdný.
  CONSTRAINT evidence_source_id_check
    CHECK (char_length(source_id) BETWEEN 1 AND 512),
  -- Hluboký odkaz jen https (žádné javascript:/data: v odkazu, který UI
  -- jednou vykreslí jako <a href>) a omezené délky.
  CONSTRAINT evidence_web_link_check
    CHECK (web_link IS NULL OR (web_link ~* '^https://' AND char_length(web_link) <= 2048))
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_source_uidx
  ON evidence (source_kind, source_id);

ALTER TABLE audit_event
  ADD COLUMN IF NOT EXISTS evidence_id bigint REFERENCES evidence(id) ON DELETE RESTRICT;

ALTER TABLE audit_event
  ADD COLUMN IF NOT EXISTS info_state text
  CONSTRAINT audit_event_info_state_check
    CHECK (info_state IS NULL OR info_state IN
      ('source_fact', 'ai_suggestion', 'human_confirmed', 'actual_result'));

-- „Které změny dokládá tenhle zdroj?" a rychlá kontrola FK při případném
-- mazání evidence. Částečný index: drtivá většina řádků má evidence_id NULL.
CREATE INDEX IF NOT EXISTS audit_event_evidence_idx
  ON audit_event(evidence_id) WHERE evidence_id IS NOT NULL;

ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;

-- Domácí styl (0033): permisivní politika pro člena týmu + RESTRICTIVE AAL2.
-- Rozdíl proti 0033: člen týmu smí jen SELECT. INSERT pod uživatelskou
-- session záměrně NENÍ: řádek je sdílený ukazatel (UNIQUE source_kind +
-- source_id, ON CONFLICT DO NOTHING), takže kdo vloží první, určí web_link
-- pro všechny další změny dokládané stejným zdrojem — člen týmu by tak mohl
-- „otrávit" odkaz podvrženou URL. Zapisuje proto jen service_role (RLS
-- obchází, politiku nepotřebuje). Aplikační zapisovatelé MUSÍ jít přes
-- serverovou cestu (server action / job se service-role klientem), která
-- source_id a web_link bere ze zdrojového systému (Graph), ne od uživatele.
DROP POLICY IF EXISTS evidence_read ON evidence;
CREATE POLICY evidence_read ON evidence
  FOR SELECT USING (is_team_member());

-- Starší koncept této migrace měl INSERT pro tým; při opakovaném vložení ho
-- odstraníme.
DROP POLICY IF EXISTS evidence_insert ON evidence;
REVOKE INSERT, UPDATE, DELETE ON evidence FROM anon, authenticated;

DROP POLICY IF EXISTS require_aal2 ON evidence;
CREATE POLICY require_aal2 ON evidence
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

INSERT INTO schema_migration (version, note)
VALUES ('0038', 'evidence + audit_event.evidence_id/info_state - puvod a ctyri stavy udaje')
ON CONFLICT (version) DO NOTHING;
