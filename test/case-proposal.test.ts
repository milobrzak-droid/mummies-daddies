// Návrh pracovního případu (case_proposal, migrace 0067): zápis přes sink
// šablony (service role), kontext schopnosti nad Supabase, rozhodnutí
// člověka (Server Action + RPC) a statická kontrola migrace v domácím stylu.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { recordAudit } from '@/core/audit'
import { COMPANY } from '@/config'
import {
  CASE_PROPOSAL_STATUSES,
  PROPOSAL_ALREADY_DECIDED_MESSAGE,
  PROPOSAL_METHODS,
  PROPOSALS_MIGRATION_PENDING_MESSAGE,
  caseProposalRow,
  caseProposalSink,
  proposalErrorMessage,
} from '@/core/agents/caseProposal'
import { CAPABILITY_ID_RE, CapabilityAbort, type ProposalDraft } from '@/core/agents/template'
import type { MailToCaseOutput } from '@/core/agents/mailToCase'
import { decideCaseProposal } from '@/core/actions/caseProposals'
import { supabaseMailToCaseContext } from '@/domain/crm/mailToCase'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: USER })),
  requireUser: vi.fn(async () => ({ id: USER })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn(async () => {}) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ok = (data: unknown): QueryResult => ({ data, error: null })
const err = (code: string, message = 'x'): QueryResult => ({ data: null, error: { code, message } })

function draft(over: Partial<ProposalDraft<unknown, MailToCaseOutput>> = {}): ProposalDraft<unknown, MailToCaseOutput> {
  return {
    capability: 'mail_to_case',
    sourceKey: 'outlook:inbox|message.inbound|<a@x>',
    event: {
      source: 'outlook:inbox',
      type: 'message.inbound',
      external_id: '<a@x>',
      occurred_at: '2026-09-27T10:00:00.000Z',
      subject: { kind: 'account', id: 1 },
      participants: [],
      evidence: { kind: 'email_message', sourceId: '<a@x>', webLink: 'https://outlook.office.com/mail/id/a' },
      title: null,
      payload: null,
    },
    output: { title: 'Odpověď od Acme — další krok', rationale: 'Odpověď na naši zprávu.' },
    reasons: ['Odpověď na naši zprávu.'],
    method: 'rule',
    infoState: 'ai_suggestion',
    target: { node: 'uzel_a', accountId: 1, steps: ['Krok 1', 'Krok 2'] },
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('sink case_proposal (service role)', () => {
  test('řádek návrhu', () => {
    expect(caseProposalRow(draft(), 9, 'system:mail_to_case')).toEqual({
      capability: 'mail_to_case',
      source_key: 'outlook:inbox|message.inbound|<a@x>',
      occurred_at: '2026-09-27T10:00:00.000Z',
      node: 'uzel_a',
      account_id: 1,
      title: 'Odpověď od Acme — další krok',
      rationale: 'Odpověď na naši zprávu.',
      steps: ['Krok 1', 'Krok 2'],
      method: 'rule',
      info_state: 'ai_suggestion',
      evidence_id: 9,
      status: 'pending',
      created_by: 'system:mail_to_case',
    })
  })

  test('nový návrh: evidence (první zápis vyhrává), upsert s idempotencí, audit ai_suggestion', async () => {
    const fake = createSupabaseFake({
      resolve: (c) => (c.table === 'evidence' && hasOp(c, 'select') ? ok({ id: 9 }) : c.table === 'case_proposal' ? ok([{ id: 42 }]) : ok(null)),
    })
    const res = await caseProposalSink(fake.client as never, { createdBy: 'system:mail_to_case' }).propose(draft())
    expect(res).toBe('created')
    const evidenceUpsert = fake.calls.find((c) => c.table === 'evidence' && hasOp(c, 'upsert'))!
    expect(opArgs(evidenceUpsert, 'upsert')).toEqual([
      { source_kind: 'email_message', source_id: '<a@x>', web_link: 'https://outlook.office.com/mail/id/a', created_by: 'system:mail_to_case' },
      { onConflict: 'source_kind,source_id', ignoreDuplicates: true },
    ])
    const upsert = fake.calls.find((c) => c.table === 'case_proposal')!
    expect(opArgs(upsert, 'upsert')?.[1]).toEqual({ onConflict: 'capability,source_key', ignoreDuplicates: true })
    expect((opArgs(upsert, 'upsert')?.[0] as { evidence_id: number }).evidence_id).toBe(9)
    expect(recordAudit).toHaveBeenCalledWith(
      'case_proposal', 42, 'case_proposal.created', null,
      { capability: 'mail_to_case', node: 'uzel_a', account_id: 1, method: 'rule' },
      { type: 'system', id: 'mail_to_case' },
      { evidenceId: 9, infoState: 'ai_suggestion' },
    )
  })

  test('konflikt (stejný zdroj nebo už čekající návrh firmy) = duplicita bez auditu', async () => {
    for (const result of [ok([]), err('23505')]) {
      const fake = createSupabaseFake({
        resolve: (c) => (c.table === 'evidence' ? ok({ id: 9 }) : result),
      })
      expect(await caseProposalSink(fake.client as never, { createdBy: 's' }).propose(draft())).toBe('duplicate')
    }
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('bez migrace 0067 → CapabilityAbort; bez dokladu → chyba', async () => {
    const fake = createSupabaseFake({ resolve: (c) => (c.table === 'evidence' ? ok({ id: 9 }) : err('PGRST205')) })
    await expect(caseProposalSink(fake.client as never, { createdBy: 's' }).propose(draft())).rejects.toBeInstanceOf(CapabilityAbort)
    const d = draft()
    await expect(
      caseProposalSink(fake.client as never, { createdBy: 's' }).propose({ ...d, event: { ...d.event, evidence: null } }),
    ).rejects.toThrow('návrh bez odkazu na zdroj nevznikne')
  })
})

describe('kontext schopnosti nad Supabase', () => {
  test('dotazy: naše poslední odchozí před zprávou, aktivní případ nebo čekající návrh, pozdější zamítnutí', async () => {
    const fake = createSupabaseFake({
      resolve: (c) => {
        if (c.table === 'account') return ok({ name: 'Acme a.s.' })
        if (c.table === 'mail_event' && hasOp(c, 'order')) return ok([{ occurred_at: '2026-09-20T09:00:00+00:00' }])
        if (c.table === 'mail_event') return ok([{ id: 1 }])
        return ok([])
      },
    })
    const ctx = supabaseMailToCaseContext(fake.client as never)
    expect(await ctx.accountName(1)).toBe('Acme a.s.')
    expect(await ctx.lastOutboundBefore(1, '2026-09-27T10:00:00.000Z')).toBe('2026-09-20T09:00:00.000Z')
    expect(await ctx.hasMailBefore(1, '2026-09-27T10:00:00.000Z')).toBe(true)
    expect(await ctx.alreadyTracked(1, 'uzel_a')).toBe(false)
    expect(await ctx.rejectedAfter(1, 'uzel_a', '2026-09-27T10:00:00.000Z')).toBe(false)

    const out = fake.calls.find((c) => c.table === 'mail_event' && hasOp(c, 'order'))!
    expect(out.ops.filter((o) => o.method === 'eq').map((o) => o.args)).toEqual([['account_id', 1], ['direction', 'outbound']])
    expect(opArgs(out, 'lt')).toEqual(['occurred_at', '2026-09-27T10:00:00.000Z'])
    const wc = fake.calls.find((c) => c.table === 'work_case')!
    expect(opArgs(wc, 'in')).toEqual(['status', ['open', 'in_progress', 'waiting']])
    const pending = fake.calls.find((c) => c.table === 'case_proposal' && c.ops.some((o) => o.method === 'eq' && o.args[1] === 'pending'))
    expect(pending).toBeDefined()
    const rejected = fake.calls.find((c) => c.table === 'case_proposal' && hasOp(c, 'gt'))!
    expect(opArgs(rejected, 'gt')).toEqual(['decided_at', '2026-09-27T10:00:00.000Z'])
  })

  test('bez tabulky case_proposal → CapabilityAbort (klidně, bez dalších pokusů)', async () => {
    const fake = createSupabaseFake({ resolve: (c) => (c.table === 'case_proposal' ? err('42P01') : ok([])) })
    const ctx = supabaseMailToCaseContext(fake.client as never)
    await expect(ctx.alreadyTracked(1, 'uzel_a')).rejects.toThrow(PROPOSALS_MIGRATION_PENDING_MESSAGE)
  })
})

describe('decideCaseProposal (Server Action)', () => {
  function form(fields: Record<string, string>): FormData {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    return fd
  }
  function setup(resolve: (c: QueryCall) => QueryResult, rpc?: (name: string, args: unknown) => QueryResult) {
    const fake = createSupabaseFake({ user: { id: USER }, resolve, rpc })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    return fake
  }
  const pending = (c: QueryCall) => (c.table === 'case_proposal' ? ok({ id: 5, status: 'pending', evidence_id: 9 }) : ok(null))

  test('bez AAL2 uživatele se nesáhne do DB', async () => {
    const { tryRequireUser } = await import('@/lib/auth/requireUser')
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const fake = setup(pending)
    expect(await decideCaseProposal(null, form({ proposal_id: '5', accept: '1' }))).toEqual({ success: false, error: 'auth' })
    expect(fake.from).not.toHaveBeenCalled()
  })

  test('neplatný formulář, neexistující a už rozhodnutý návrh', async () => {
    setup(pending)
    expect(await decideCaseProposal(null, form({ proposal_id: 'x', accept: '1' }))).toEqual({ success: false, error: 'Neplatný požadavek. Obnovte stránku.' })
    setup(() => ok(null))
    expect(await decideCaseProposal(null, form({ proposal_id: '5', accept: '1' }))).toEqual({ success: false, error: 'Návrh nebyl nalezen.' })
    setup(() => ok({ id: 5, status: 'accepted', evidence_id: 9 }))
    expect(await decideCaseProposal(null, form({ proposal_id: '5', accept: '1' }))).toEqual({ success: false, error: PROPOSAL_ALREADY_DECIDED_MESSAGE })
  })

  test('přijetí: RPC založí případ, audit human_confirmed s dokladem, přesměrování na případ', async () => {
    const fake = setup(pending, (name) => (name === 'accept_case_proposal' ? ok(77) : ok(null)))
    await expect(decideCaseProposal(null, form({ proposal_id: '5', accept: '1' }))).rejects.toThrow('NEXT_REDIRECT:/cockpit/pripady/77')
    expect(fake.rpc).toHaveBeenCalledWith('accept_case_proposal', { p_proposal_id: 5 })
    expect(recordAudit).toHaveBeenCalledWith(
      'work_case', 77, 'case_proposal.accepted',
      { proposal_id: 5, status: 'pending' },
      { proposal_id: 5, status: 'accepted', work_case_id: 77 },
      { type: 'user', id: USER },
      { evidenceId: 9, infoState: 'human_confirmed' },
    )
  })

  test('zamítnutí: RPC s poznámkou, audit bez textu poznámky', async () => {
    const fake = setup(pending)
    expect(await decideCaseProposal(null, form({ proposal_id: '5', accept: '0', note: 'Jen poděkování' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('reject_case_proposal', { p_proposal_id: 5, p_note: 'Jen poděkování' })
    const call = vi.mocked(recordAudit).mock.calls[0]
    expect(call.slice(0, 3)).toEqual(['case_proposal', 5, 'case_proposal.rejected'])
    expect(JSON.stringify(call)).not.toContain('Jen poděkování')
  })

  test('chyby RPC → česká hláška (souběh, chybějící migrace)', async () => {
    setup(pending, () => err('22023', 'Návrh už byl rozhodnut (stav accepted)'))
    expect(await decideCaseProposal(null, form({ proposal_id: '5', accept: '0' }))).toEqual({ success: false, error: PROPOSAL_ALREADY_DECIDED_MESSAGE })
    setup(pending, () => err('PGRST202', 'Could not find the function'))
    expect(await decideCaseProposal(null, form({ proposal_id: '5', accept: '1' }))).toEqual({ success: false, error: PROPOSALS_MIGRATION_PENDING_MESSAGE })
    setup(() => err('42P01', 'relation "case_proposal" does not exist'))
    expect(await decideCaseProposal(null, form({ proposal_id: '5', accept: '1' }))).toEqual({ success: false, error: PROPOSALS_MIGRATION_PENDING_MESSAGE })
    expect(proposalErrorMessage({ code: 'P0002', message: 'Návrh 5 neexistuje' })).toBe('Návrh nebyl nalezen.')
  })
})

// ---------------------------------------------------------------------------
// Statická kontrola 0067 (bez DB), vzor test/loop-hardening.test.ts.

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const raw = readFileSync('supabase/migrations/0067_case_proposal.sql', 'utf8')
const sql = strip(raw)

function fn(name: string): { header: string; body: string } {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(sql)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return { header: m[1], body: m[2] }
}

describe('0067_case_proposal.sql', () => {
  test('guard prerekvizit je první příkaz a jmenuje 0038 i 0039', () => {
    expect(sql.trim().startsWith('DO $$')).toBe(true)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0038_evidence\.sql'/)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0039_loop_core\.sql'/)
    expect(sql).toMatch(/to_regprocedure\('public\.loop_actor\(\)'\) IS NULL/)
  })

  test('idempotence: IF NOT EXISTS, UNIQUE (capability, source_key), jeden čekající návrh na firmu a uzel', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS case_proposal/)
    expect(sql).toMatch(/CONSTRAINT case_proposal_source_unique UNIQUE \(capability, source_key\)/)
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS case_proposal_one_pending_uidx\s+ON case_proposal \(capability, account_id, node\)\s+WHERE status = 'pending'/)
  })

  test('uzel je FK na loop_node, žádný výčet uzlů žádné firmy', () => {
    expect(sql).toMatch(/node\s+text NOT NULL REFERENCES loop_node\(node\)/)
    for (const n of COMPANY.nodes) expect(raw).not.toContain(`'${n}'`)
  })

  test('doložení a stav údaje: evidence NOT NULL RESTRICT, jen ai_suggestion', () => {
    expect(sql).toMatch(/evidence_id\s+bigint NOT NULL REFERENCES evidence\(id\) ON DELETE RESTRICT/)
    expect(sql).toMatch(/CHECK \(info_state = 'ai_suggestion'\)/)
  })

  test('hodnoty CHECKů sedí s TypeScriptem', () => {
    const list = (col: string) => {
      const m = new RegExp(`CHECK \\(${col} IN \\(([^)]*)\\)\\)`).exec(sql)
      return m ? [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]) : null
    }
    expect(list('status')).toEqual([...CASE_PROPOSAL_STATUSES])
    expect(list('method')).toEqual([...PROPOSAL_METHODS])
    expect(sql).toContain(`CHECK (capability ~ '${CAPABILITY_ID_RE.source}')`)
  })

  test('RLS: čtení pro tým, RESTRICTIVE AAL2, žádný přímý zápis klienta', () => {
    expect(sql).toMatch(/ALTER TABLE case_proposal ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/CREATE POLICY case_proposal_read ON case_proposal\s+FOR SELECT USING \(\(SELECT is_team_member\(\)\)\)/)
    expect(sql).toMatch(/CREATE POLICY require_aal2 ON case_proposal\s+AS RESTRICTIVE FOR ALL/)
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON case_proposal\s+FOR (INSERT|UPDATE|DELETE|ALL)/)
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON case_proposal FROM authenticated/)
    expect(sql).toMatch(/REVOKE ALL ON case_proposal FROM PUBLIC, anon/)
  })

  test.each(['accept_case_proposal', 'reject_case_proposal'])('%s: SECURITY DEFINER, search_path, aktér z loop_actor, FOR UPDATE, stav pending', (name) => {
    const { header, body } = fn(name)
    expect(header).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/)
    expect(body).toMatch(/v_actor\s+text := loop_actor\(\);/)
    expect(body).toMatch(/FOR UPDATE;/)
    expect(body).toMatch(/RAISE EXCEPTION 'Návrh % neexistuje', p_proposal_id USING ERRCODE = 'P0002'/)
    expect(body).toMatch(/RAISE EXCEPTION 'Návrh už byl rozhodnut \(stav %\)', v_[\w.]+ USING ERRCODE = '22023'/)
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${name}\\([^)]*\\) FROM PUBLIC, anon;`))
    expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${name}\\([^)]*\\) TO authenticated;`))
  })

  test('přijetí: případ open s autorem = aktér, kroky todo, doložené rozhodnutí, návrh accepted', () => {
    const { body } = fn('accept_case_proposal')
    expect(body).toMatch(/INSERT INTO work_case \(title, node, status, account_id, lead_owner_id, created_by\)\s+VALUES \(v_p\.title, v_p\.node, 'open', v_p\.account_id, v_owner, v_actor\)/)
    expect(body).toMatch(/INSERT INTO case_step \(case_id, position, title, status\)[\s\S]*'todo'[\s\S]*jsonb_array_elements_text\(v_p\.steps\) WITH ORDINALITY/)
    expect(body).toMatch(/INSERT INTO decision \([^)]*evidence_id\)[\s\S]*v_p\.evidence_id/)
    expect(body).toMatch(/SET status = 'accepted', decided_by = v_actor, decided_at = now\(\), work_case_id = v_case/)
  })

  test('texty chyb z RPC mapuje proposalErrorMessage', () => {
    expect(proposalErrorMessage({ code: '22023', message: 'Návrh už byl rozhodnut (stav rejected)' })).toBe(PROPOSAL_ALREADY_DECIDED_MESSAGE)
  })

  test('schema_migration nese 0067', () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0067'/)
    expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
  })
})
