// Statická kontrola migrace 0091 (mail_content_intake) a její shody s kódem —
// bez databáze. Chování v opravdovém Postgresu ověřuje
// test/mail-content-0091-pglite.test.ts; obecné konvence (číslování, RLS + AAL2,
// search_path, ledger) hlídá test/migrations-lint.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { DB_AUDITED_TABLES, NEVER_SAFE_COLUMNS } from '@/core/auditCoverage'
import {
  MAIL_CONTENT_ATTACHMENTS_MAX,
  MAIL_CONTENT_DOMAIN_MAX,
  MAIL_CONTENT_EXCERPT_MAX,
  MAIL_CONTENT_SOURCE,
  MAIL_CONTENT_SUBJECT_MAX,
  MAIL_MATCH_METHODS,
  MAIL_SIGNALS,
  MAIL_WAIT_REASONS,
  MAIL_CONTENT_CAPABILITIES,
} from '@/domain/crm/mailContent'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const sql = strip(readFileSync('supabase/migrations/0091_mail_content_intake.sql', 'utf8'))
const list = (re: RegExp): string[] => re.exec(sql)![1].match(/'([\w]+)'/g)!.map((s) => s.slice(1, -1))

describe('0091 — mail_content_intake', () => {
  test('guard je první příkaz a jmenuje závislosti', () => {
    expect(sql.trim().startsWith('DO $$')).toBe(true)
    for (const dep of ['0042_engagement_milestone.sql', '0038_evidence.sql', '0067_case_proposal.sql', '0020_core_sales_crm.sql',
      '0082_audit_gaps_partner_lockdown.sql', '0026_migration_ledger.sql']) {
      expect(sql).toContain(dep)
    }
  })

  test('idempotentní: tabulka, indexy, politiky, funkce i trigger se dají pustit znovu', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS mail_content_intake/)
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?(\w+)/g)]
    expect(indexes.length).toBeGreaterThan(5)
    for (const idx of indexes) expect(idx[1], idx[2]).toBeTruthy()
    for (const p of ['mail_content_intake_read', 'sales_only', 'require_aal2']) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${p} ON mail_content_intake;`)
    }
    expect(sql).toContain('CREATE OR REPLACE FUNCTION purge_mail_content_intake(')
    expect(sql).toContain('DROP TRIGGER IF EXISTS audit_row_change_soft ON mail_content_intake;')
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0091'/)
    expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
  })

  test('RLS: čtení tým, RESTRICTIVE sales_only (obchodní role) a AAL2, klient nezapíše nic', () => {
    expect(sql).toMatch(/ALTER TABLE mail_content_intake ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/CREATE POLICY mail_content_intake_read ON mail_content_intake\s+FOR SELECT USING \(\(SELECT is_team_member\(\)\)\)/)
    expect(sql).toMatch(
      /CREATE POLICY sales_only ON mail_content_intake\s+AS RESTRICTIVE FOR ALL\s+USING \(\(SELECT can_see_sales\(\)\)\)\s+WITH CHECK \(\(SELECT can_see_sales\(\)\)\)/,
    )
    expect(sql).toMatch(/CREATE POLICY require_aal2 ON mail_content_intake\s+AS RESTRICTIVE FOR ALL[\s\S]*?aal2/)
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON mail_content_intake\s+FOR (INSERT|UPDATE|DELETE|ALL)/)
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON mail_content_intake FROM authenticated/)
    expect(sql).toMatch(/GRANT SELECT ON mail_content_intake TO authenticated/)
    expect(sql).toMatch(/REVOKE ALL ON mail_content_intake FROM PUBLIC, anon/)
    expect(sql).toMatch(/GRANT USAGE ON SEQUENCE mail_content_intake_id_seq TO service_role/)
  })

  test('meze a číselníky sedí s TypeScriptem', () => {
    expect(sql).toContain(`char_length(excerpt) BETWEEN 1 AND ${MAIL_CONTENT_EXCERPT_MAX}`)
    expect(sql).toContain(`char_length(subject) BETWEEN 1 AND ${MAIL_CONTENT_SUBJECT_MAX}`)
    expect(sql).toContain(`char_length(sender_domain) BETWEEN 1 AND ${MAIL_CONTENT_DOMAIN_MAX}`)
    expect(sql).toContain(`jsonb_array_length(attachment_names) <= ${MAIL_CONTENT_ATTACHMENTS_MAX}`)
    expect(sql).toMatch(new RegExp(`source\\s+text NOT NULL DEFAULT '${MAIL_CONTENT_SOURCE}'`))
    expect(list(/signals <@ ARRAY\[([^\]]*)\]/)).toEqual([...MAIL_SIGNALS])
    // 0091 zná pět důvodů; šestý (offer_draft) přidává 0099 (test níž).
    expect(list(/wait_reason IN \(([^)]*)\)/)).toEqual(MAIL_WAIT_REASONS.filter((r) => r !== 'offer_draft'))
    expect(list(/match_method IN \(([^)]*)\)/)).toEqual([...MAIL_MATCH_METHODS])
    expect(list(/mail_content_intake_status_check CHECK \(status IN \(([^)]*)\)\)/)).toEqual(['queued', 'proposed', 'discarded', 'expired'])
  })

  test('obsah drží jen řádek, který ho potřebuje: zahozený a vypršelý bez textu (CHECK v DB)', () => {
    const check = /CONSTRAINT mail_content_intake_state_consistent CHECK \(([\s\S]*?)\n  \),/.exec(sql)![1]
    const [queued, proposed, closed] = check.split(/\n\s*OR \(/)
    expect(queued).toMatch(/status = 'queued'[\s\S]*wait_reason IS NOT NULL AND excerpt IS NOT NULL AND proposal_id IS NULL/)
    expect(proposed).toMatch(/status = 'proposed'[\s\S]*account_id IS NOT NULL[\s\S]*decided_at IS NOT NULL AND decided_by IS NOT NULL/)
    expect(closed).toMatch(/status IN \('discarded', 'expired'\)/)
    expect(closed).toMatch(/subject IS NULL AND excerpt IS NULL AND attachment_names = '\[\]'::jsonb/)
  })

  test('tělo zprávy nemá sloupec: žádný body, content ani text', () => {
    const table = /CREATE TABLE IF NOT EXISTS mail_content_intake \(([\s\S]*?)\n\);/.exec(sql)![1]
    const columns = [...table.matchAll(/^\s{2}(\w+)\s+(?:bigserial|bigint|text|jsonb|boolean|date|uuid|timestamptz)/gm)].map((m) => m[1])
    expect(columns).toEqual(expect.arrayContaining(['excerpt', 'subject', 'attachment_names', 'evidence_id', 'dedupe_key']))
    for (const c of columns) expect(c, c).not.toMatch(/^(body|content|text|html|preview|message)$/)
    // Odesílatel jen jako doména, ne adresa.
    expect(columns).toContain('sender_domain')
    expect(columns.filter((c) => /email|address|from|sender$/.test(c))).toEqual([])
  })

  test('retence: výchozí lhůty 30 / 30 / 180 a jen server smí volat', () => {
    expect(sql).toMatch(/p_queued_days\s+integer DEFAULT 30/)
    expect(sql).toMatch(/p_decided_days integer DEFAULT 30/)
    expect(sql).toMatch(/p_max_days\s+integer DEFAULT 180/)
    expect(sql).toMatch(/purge_mail_content_intake\(\s*p_queued_days[\s\S]*?SECURITY DEFINER\s+SET search_path = public, pg_temp/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION purge_mail_content_intake\(integer, integer, integer\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION purge_mail_content_intake\(integer, integer, integer\) TO service_role/)
  })

  test('audit: měkký trigger, allow-list bez volného textu, sedí s DB_AUDITED_TABLES', () => {
    const cfg = DB_AUDITED_TABLES.mail_content_intake
    expect(cfg.soft).toBe(true)
    const args = /audit_row_change_soft\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/.exec(sql)!
    expect(args[1].split(',')).toEqual([...cfg.safe])
    expect(args[3]).toBe(cfg.evidenceColumn)
    for (const c of ['subject', 'excerpt', 'attachment_names', 'sender_domain', 'dedupe_key', 'proposed_date']) {
      expect(cfg.safe, c).not.toContain(c)
    }
    for (const c of cfg.safe) expect(NEVER_SAFE_COLUMNS, c).not.toContain(c)
  })

  test('návrhy z pošty: id schopností jsou platná pro case_proposal a rozlišují druhy', () => {
    for (const c of Object.values(MAIL_CONTENT_CAPABILITIES)) expect(c).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
    expect(new Set(Object.values(MAIL_CONTENT_CAPABILITIES)).size).toBe(Object.keys(MAIL_CONTENT_CAPABILITIES).length)
  })
})

const sql99 = strip(readFileSync('supabase/migrations/0099_mail_offer_attachment.sql', 'utf8'))

describe('0099 — nabídka z přílohy e-mailu (mail_content_intake)', () => {
  test('guard je první příkaz a jmenuje závislosti', () => {
    expect(sql99.trim().startsWith('DO $$')).toBe(true)
    expect(sql99).toContain('0091_mail_content_intake.sql')
    expect(sql99).toContain('0026_migration_ledger.sql')
  })

  test('idempotentní: sloupce, CHECKy, indexy i funkce se dají pustit znovu; ledger 0099', () => {
    expect(sql99).toMatch(/ADD COLUMN IF NOT EXISTS offer_proposal_id uuid/)
    expect(sql99).toMatch(/ADD COLUMN IF NOT EXISTS offer_draft jsonb/)
    expect(sql99).toMatch(/ADD COLUMN IF NOT EXISTS offer_pdf_sha256 text/)
    for (const c of ['mail_content_intake_wait_check', 'mail_content_intake_offer_check']) {
      expect(sql99).toContain(`DROP CONSTRAINT IF EXISTS ${c};`)
    }
    for (const idx of sql99.matchAll(/CREATE (?:UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?(\w+)/g)) expect(idx[1], idx[2]).toBeTruthy()
    expect(sql99).toContain('CREATE OR REPLACE FUNCTION purge_mail_content_intake(')
    expect(sql99).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0099'/)
    expect(sql99).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
  })

  test('důvody čekání sedí s TypeScriptem (0091 + offer_draft)', () => {
    const m = /mail_content_intake_wait_check\s+CHECK \(wait_reason IS NULL OR wait_reason IN \(([^)]*)\)\)/.exec(sql99)!
    expect(m[1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1))).toEqual([...MAIL_WAIT_REASONS])
  })

  test('PDF se neukládá: žádný sloupec na bajty ani soubor, jen návrh (jsonb), otisk a id', () => {
    const cols = [...sql99.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1])
    expect(cols).toEqual(['offer_proposal_id', 'offer_draft', 'offer_pdf_sha256'])
    for (const c of cols) expect(c).not.toMatch(/^(pdf|bytes|content|body|file|blob|bytea|data)$/)
    expect(sql99).not.toMatch(/\bbytea\b/i)
    expect(sql99).toMatch(/offer_pdf_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/)
  })

  test('návrh zakázky drží jen čekající řádek s důvodem offer_draft a id návrhu; velikost je omezená', () => {
    const check = /CONSTRAINT mail_content_intake_offer_check CHECK \(([\s\S]*?)\n\);/.exec(sql99)![1]
    expect(check).toMatch(/wait_reason IS NOT DISTINCT FROM 'offer_draft'\) = \(offer_draft IS NOT NULL\)/)
    expect(check).toMatch(/offer_proposal_id IS NOT NULL/)
    expect(check).toMatch(/jsonb_typeof\(offer_draft\) = 'object'/)
    expect(check).toMatch(/octet_length\(offer_draft::text\) <= 16384/)
  })

  test('retence maže i návrh zakázky u vypršelého řádku a zůstává jen pro server', () => {
    const expire = /WITH x AS \(([\s\S]*?)RETURNING 1/.exec(sql99)![1]
    expect(expire).toMatch(/offer_draft = NULL/)
    expect(sql99).toMatch(/p_queued_days\s+integer DEFAULT 30/)
    expect(sql99).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/)
    expect(sql99).toMatch(/REVOKE ALL ON FUNCTION purge_mail_content_intake\(integer, integer, integer\) FROM PUBLIC, anon, authenticated/)
    expect(sql99).toMatch(/GRANT EXECUTE ON FUNCTION purge_mail_content_intake\(integer, integer, integer\) TO service_role/)
  })

  test('oprávnění a audit se nemění: žádná nová politika ani trigger, nové sloupce v allow-listu nejsou', () => {
    expect(sql99).not.toMatch(/CREATE POLICY|DROP POLICY|GRANT SELECT|CREATE TRIGGER|DROP TRIGGER/)
    for (const c of ['offer_draft', 'offer_proposal_id', 'offer_pdf_sha256']) {
      expect(DB_AUDITED_TABLES.mail_content_intake.safe, c).not.toContain(c)
    }
  })
})
