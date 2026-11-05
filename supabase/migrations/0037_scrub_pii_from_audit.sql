-- 0037 — vyčištění osobních údajů z audit_event (jednorázová oprava dat).
--
-- PROČ: bezpečnostní review ukázalo, že starší verze appky při smazání
-- kontaktu, při GDPR redakci aktivity a při smazání úkolu osobní údaj jen
-- PŘESUNULA do audit_event, kde žije bez retence a bez možnosti výmazu:
--   * `contact.deleted`         — before = {full_name, email, role, account_id};
--   * `sales_activity.redacted` — before = {subject, body} PŮVODNÍ neredigovaný
--     text, after = {subject, body} po redakci (redakce tak ztrácela smysl);
--   * `task.deleted`            — before obsahovalo title (volný text).
-- Tahle migrace přepíše existující (historické) řádky těchto tří akcí tak,
-- aby zůstala jen neosobní kostra: že událost proběhla, kdy, kým (actor_*,
-- occurred_at se nemění) a nad čím.
--
-- ZACHOVANÉ KLÍČE (vše ostatní z before/after zmizí):
--   contact.deleted
--     before = {account_id, had_email, pii_scrubbed: true}
--         account_id — z původního before (id firmy, ne osoba),
--         had_email  — boolean, zda kontakt měl neprázdný e-mail.
--         Zahozeno: full_name, email, role (role bývá jmenná, např. "paní
--         Dvořáková").
--     after  = NULL (beze změny; smazání nemá stav po).
--   sales_activity.redacted
--     before = {had_subject, had_body, subject_length, body_length,
--               pii_scrubbed: true}   (délky původního textu ve znacích)
--     after  = {had_subject, had_body, subject_length, body_length,
--               pii_scrubbed: true}   (délky textu po redakci)
--         had_* jsou boolean (neprázdný text), *_length celá čísla.
--         Zahozeno: samotný subject a body v before i v after (redigovaný
--         text může pořád nést kontext o osobě).
--   task.deleted
--     before = {status, assignee_id, pii_scrubbed: true}
--         Stejné klíče, jaké dnes zapisuje appka (taskDeletedAuditBefore
--         v domain/crm/auditPayload.ts, volané z domain/crm/actions/tasks.ts),
--         navíc jen příznak pii_scrubbed kvůli idempotenci.
--         Zahozeno: title (volný text, často se jménem) a vše ostatní.
--     after  = NULL (smazání nemá stav po; případný neprázdný after se
--         zúží na {pii_scrubbed: true}).
--   Řádky, kde je before/after NULL, zůstanou NULL (není co čistit).
--
-- Příznak pii_scrubbed = true dělá migraci IDEMPOTENTNÍ: přepsaný řádek se
-- při dalším běhu nepozná znovu (WHERE ho vynechá), takže počet přepsaných
-- řádků při opakování je 0 a už-vyčištěná kostra se nepřepisuje z prázdna.
-- Test na příznak jde přes ->> (ne operátor ?), aby migrace fungovala i ve
-- klientech, které ? berou jako parametr.
--
-- Proč obyčejné UPDATE: audit_event má RLS (jen SELECT politika pro tým
-- s AAL2, 0028), takže by se přes běžnou roli neaktualizovalo nic. Migrační
-- runner běží jako postgres (BYPASSRLS/vlastník tabulky), jednorázová
-- oprava dat tedy nepotřebuje žádnou UPDATE politiku ani SECURITY DEFINER
-- funkci — a NEPŘIDÁVÁ se žádná. Také se nevytváří žádný trigger, který by
-- UPDATE audit_event blokoval.
--
-- Nové zápisy: appka už dnes zapisuje do všech tří akcí jen zúžené tvary
-- z domain/crm/auditPayload.ts (contactDeletedAuditBefore,
-- salesActivityRedactedAudit, taskDeletedAuditBefore, volané z
-- domain/crm/actions/contacts.ts, gdpr.ts a tasks.ts). Migrace tedy čistí
-- jen historii; PII se po ní znovu nenahromadí.
--
-- Zámky: UPDATE bere ROW EXCLUSIVE a zamyká jen dotčené řádky; tabulka je
-- malá a čtení (MVCC) neblokuje. Na prázdné tabulce je to no-op.

DO $$
DECLARE
  v_contacts int;
  v_activities int;
  v_tasks int;
BEGIN
  UPDATE audit_event
  SET before = CASE
        WHEN before IS NULL THEN NULL
        ELSE jsonb_build_object(
          'account_id', before -> 'account_id',
          'had_email',  COALESCE(btrim(before ->> 'email'), '') <> '',
          'pii_scrubbed', true
        )
      END,
      after = CASE
        WHEN after IS NULL THEN NULL
        ELSE jsonb_build_object('pii_scrubbed', true)
      END
  WHERE action = 'contact.deleted'
    AND (
      (before IS NOT NULL AND (before ->> 'pii_scrubbed') IS DISTINCT FROM 'true')
      OR
      (after  IS NOT NULL AND (after  ->> 'pii_scrubbed') IS DISTINCT FROM 'true')
    );
  GET DIAGNOSTICS v_contacts = ROW_COUNT;

  UPDATE audit_event
  SET before = CASE
        WHEN before IS NULL THEN NULL
        ELSE jsonb_build_object(
          'had_subject',    COALESCE(before ->> 'subject', '') <> '',
          'had_body',       COALESCE(before ->> 'body', '') <> '',
          'subject_length', char_length(COALESCE(before ->> 'subject', '')),
          'body_length',    char_length(COALESCE(before ->> 'body', '')),
          'pii_scrubbed',   true
        )
      END,
      after = CASE
        WHEN after IS NULL THEN NULL
        ELSE jsonb_build_object(
          'had_subject',    COALESCE(after ->> 'subject', '') <> '',
          'had_body',       COALESCE(after ->> 'body', '') <> '',
          'subject_length', char_length(COALESCE(after ->> 'subject', '')),
          'body_length',    char_length(COALESCE(after ->> 'body', '')),
          'pii_scrubbed',   true
        )
      END
  WHERE action = 'sales_activity.redacted'
    AND (
      (before IS NOT NULL AND (before ->> 'pii_scrubbed') IS DISTINCT FROM 'true')
      OR
      (after  IS NOT NULL AND (after  ->> 'pii_scrubbed') IS DISTINCT FROM 'true')
    );
  GET DIAGNOSTICS v_activities = ROW_COUNT;

  UPDATE audit_event
  SET before = CASE
        WHEN before IS NULL THEN NULL
        ELSE jsonb_build_object(
          'status',       before -> 'status',
          'assignee_id',  before -> 'assignee_id',
          'pii_scrubbed', true
        )
      END,
      after = CASE
        WHEN after IS NULL THEN NULL
        ELSE jsonb_build_object('pii_scrubbed', true)
      END
  WHERE action = 'task.deleted'
    AND (
      (before IS NOT NULL AND (before ->> 'pii_scrubbed') IS DISTINCT FROM 'true')
      OR
      (after  IS NOT NULL AND (after  ->> 'pii_scrubbed') IS DISTINCT FROM 'true')
    );
  GET DIAGNOSTICS v_tasks = ROW_COUNT;

  RAISE NOTICE '0037: audit_event - prepsano % radku contact.deleted, % radku sales_activity.redacted, % radku task.deleted', v_contacts, v_activities, v_tasks;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0037', 'scrub PII z audit_event: contact.deleted (jmeno/email/role) a sales_activity.redacted (puvodni subject/body) a task.deleted (title) - zustavaji jen ids, boolean a delky')
ON CONFLICT (version) DO NOTHING;
