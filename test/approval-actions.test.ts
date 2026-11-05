// Čistá pravidla schválení napojeného na akci (0084): věty „co se stane po
// schválení", výsledek provedení, odložení, parametry, chyby RPC, časová osa
// případu, stav odeslání nabídky a denní úloha vypršení (bez DB).
import { describe, expect, test, vi } from 'vitest'
import {
  APPROVAL_ACTIONS,
  APPROVAL_ACTION_PENDING_MESSAGE,
  approvalActionErrorMessage,
  approvalConsequences,
  approvalTitle,
  executionSummary,
  fmtDay,
  isSnoozed,
  nextStepParams,
  offerParams,
  snoozeUntil,
  type ApprovalExecution,
} from '@/core/approvalActions'
import { buildCaseTimeline } from '@/core/caseTimeline'
import { offerNeedsSendApproval, scopeSendState, scopeVersionActions, scopeVersionDbMessage } from '@/domain/crm/scopeVersion'
import { requestApprovalSchema, requestNextStepSchema, snoozeApprovalSchema } from '@/core/workCaseSchemas'
import { viewerCanDecide } from '@/core/workCaseFlow'
import { APPROVAL_EXPIRY_JOB, runApprovalExpiryJob } from '@/worker/approvalExpiry'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const names = new Map([[A, 'Viktor'], [B, 'Pavla']])
const stepParams = { title: 'Technická analýza', assignee_id: B, due_on: '2026-10-03', decision_id: 4 }
const offer = { deal_id: 9, version_id: 40, version: 2 }
const exec = (over: Partial<ApprovalExecution>): ApprovalExecution => ({
  request_id: 1, status: 'completed', request_status: 'approved', result: {}, attempts: 1, executed_by: `user:${A}`,
  executed_at: '2026-09-29T10:00:00Z', ...over,
})

describe('parametry žádosti', () => {
  test('další krok a nabídka se čtou bezpečně; nesmysl = null', () => {
    expect(nextStepParams(stepParams)).toEqual(stepParams)
    expect(nextStepParams({ ...stepParams, decision_id: null })).toMatchObject({ decision_id: null })
    expect(nextStepParams({ title: 'x' })).toBeNull()
    expect(nextStepParams(null)).toBeNull()
    expect(offerParams(offer)).toEqual(offer)
    expect(offerParams({ deal_id: 9, version_id: '40', version: 2 })).toBeNull()
  })

  test('datum bez časového pásma serveru', () => {
    expect(fmtDay('2026-10-03')).toBe('3. 10. 2026')
    expect(fmtDay(null)).toBe('—')
  })
})

describe('co se stane po rozhodnutí', () => {
  test('potvrdit další krok: krok, úkol, termín a řešitel; po zamítnutí úkol vlastníkovi', () => {
    const c = approvalConsequences({ action_type: 'confirm_next_step', params: stepParams }, names)
    expect(c.onApprove).toBe('Po schválení se v případu založí krok „Technická analýza“ a úkol s termínem 3. 10. 2026 · řeší Pavla.')
    expect(c.onReject).toContain('vlastník případu úkol rozhodnout, jak dál')
  })

  test('odeslat nabídku: Cockpit nic neodešle, úkol z konfigurace', () => {
    const c = approvalConsequences({ action_type: 'send_offer', params: offer }, names)
    expect(c.onApprove).toContain('Cockpit nic neodešle')
    expect(c.onApprove).toContain('verze 2 nabídky se označí jako schválená k odeslání')
    expect(c.onApprove).toContain('„Odeslat nabídku klientovi“ do 1 pracovního dne')
    expect(c.onReject).toContain('verze zůstane konceptem')
  })

  test('žádost bez druhu akce je jen záznam — a říká to', () => {
    expect(approvalConsequences({ action_type: null }, names)).toEqual({
      onApprove: 'Po schválení se nic samo neprovede, jen se zapíše, kdo co povolil.',
      onReject: null,
    })
  })

  test('název žádosti: druh akce česky, jinak čitelná činnost', () => {
    expect(approvalTitle({ action_type: 'send_offer', action_kind: 'send_offer' }, (k) => k)).toBe(APPROVAL_ACTIONS.send_offer.label)
    expect(approvalTitle({ action_type: null, action_kind: 'external_commitment' }, () => 'Závazek')).toBe('Závazek')
  })
})

describe('výsledek provedení', () => {
  test('provedeno: krok a úkol s řešitelem a termínem', () => {
    const s = executionSummary(exec({ result: { step_id: 1, task_id: 2, assignee_id: B, due_on: '2026-10-03' } }),
      { action_type: 'confirm_next_step', params: stepParams }, names)
    expect(s).toEqual({ tone: 'done', label: 'Provedeno', text: 'Založen krok „Technická analýza“ a úkol · řeší Pavla · do 3. 10. 2026.', canRetry: false })
  })

  test('nabídka schválená k odeslání: nic neodešlo, úkol pro vlastníka', () => {
    const s = executionSummary(exec({ result: { version: 2, task_id: 5, assignee_id: A, due_on: '2026-09-30' } }),
      { action_type: 'send_offer', params: offer }, names)
    expect(s.label).toBe('Schváleno k odeslání')
    expect(s.text).toBe('Verze 2 je schválená k odeslání; Cockpit nic neodeslal. Úkol „Odeslat nabídku klientovi“ · řeší Viktor · do 30. 9. 2026.')
  })

  test('vyžaduje pozornost: důvod česky a kdo má úkol ke kontrole', () => {
    const s = executionSummary(exec({ status: 'needs_attention', result: { reason: 'version_changed', task_id: 5, assignee_id: A } }),
      { action_type: 'send_offer', params: offer }, names)
    expect(s).toMatchObject({ tone: 'wait', label: 'Vyžaduje pozornost', canRetry: false })
    expect(s.text).toBe('Schválená akce se neprovedla: obsah verze se od žádosti změnil. Úkol ke kontrole · řeší Viktor.')
  })

  test('selhání: kód chyby, pokus, zkusit znovu', () => {
    const first = executionSummary(exec({ status: 'failed', result: { sqlstate: '23514' } }), { action_type: 'send_offer' }, names)
    expect(first).toMatchObject({ tone: 'fail', label: 'Provedení selhalo', canRetry: true })
    expect(first.text).toContain('chyba 23514, pokus 1 z 3')
    expect(first.text).toContain('Denní kontrola to zkusí znovu')
    const last = executionSummary(exec({ status: 'failed', attempts: 3, result: { sqlstate: '23514' } }), { action_type: 'send_offer' }, names)
    expect(last.text).toContain('Další pokusy už automaticky nebudou')
  })

  test('zamítnuto / vypršelo: vráceno vlastníkovi; uzavřený případ nic', () => {
    const back = executionSummary(exec({ request_status: 'rejected', result: { reason: 'returned_to_owner', assignee_id: B } }),
      { action_type: 'confirm_next_step', params: stepParams }, names)
    expect(back).toMatchObject({ tone: 'done', label: 'Vráceno vlastníkovi', text: 'Úkol rozhodnout, jak dál · řeší Pavla.' })
    const closed = executionSummary(exec({ request_status: 'expired', result: { reason: 'case_closed' } }),
      { action_type: 'confirm_next_step', params: stepParams }, names)
    expect(closed.label).toBe('Bez dalšího kroku')
  })
})

describe('odložení na serveru', () => {
  const now = new Date('2026-09-29T10:00:00Z')
  test('zítra / týden; nejvýš minutu před koncem platnosti; vrátit = null', () => {
    expect(snoozeUntil('zitra', now, null)?.toISOString()).toBe('2026-09-30T10:00:00.000Z')
    expect(snoozeUntil('tyden', now, '2026-10-02T22:00:00Z')?.toISOString()).toBe('2026-10-02T21:59:00.000Z')
    expect(snoozeUntil('vratit', now, null)).toBeNull()
    // Vyprší za méně než hodinu → odložit už nejde.
    expect(snoozeUntil('zitra', now, '2026-09-29T10:30:00Z')).toBeNull()
  })
  test('je odložená jen do času v budoucnu', () => {
    expect(isSnoozed({ snoozed_until: '2026-09-30T00:00:00Z' }, now)).toBe(true)
    expect(isSnoozed({ snoozed_until: '2026-09-29T09:00:00Z' }, now)).toBe(false)
    expect(isSnoozed({ snoozed_until: null }, now)).toBe(false)
    expect(isSnoozed({}, now)).toBe(false)
  })
})

describe('vstupy formulářů', () => {
  test('obecná žádost nesmí napodobit druh akce', () => {
    const r = requestApprovalSchema.safeParse({ case_id: '3', action_kind: 'send_offer' })
    expect(r.success).toBe(false)
    expect(requestApprovalSchema.safeParse({ case_id: '3', action_kind: 'external_commitment' }).success).toBe(true)
  })
  test('další krok: název, řešitel (uuid), termín; rozhodnutí a platnost volitelné', () => {
    expect(requestNextStepSchema.safeParse({ case_id: '3', title: 'Analýza', assignee_id: B, due_on: '2026-10-03' }).data)
      .toEqual({ case_id: 3, title: 'Analýza', assignee_id: B, due_on: '2026-10-03', decision_id: null, expires_on: null })
    expect(requestNextStepSchema.safeParse({ case_id: '3', title: '', assignee_id: 'x', due_on: '' }).success).toBe(false)
  })
  test('odložení: jen tři volby', () => {
    expect(snoozeApprovalSchema.safeParse({ request_id: '5', choice: 'tyden' }).success).toBe(true)
    expect(snoozeApprovalSchema.safeParse({ request_id: '5', choice: 'navzdy' }).success).toBe(false)
  })
})

describe('kdo smí rozhodnout o odeslání nabídky', () => {
  const req = { requested_by: `user:${B}`, requested_level: 'L2', case_node: 'n1', action_type: 'send_offer' }
  const rows = [{ node: 'n1', owner_id: A, deputy_id: null }]
  test('vlastník uzlu s obchodní rolí ano, bez obchodní role ne', () => {
    expect(viewerCanDecide(req, { id: A, teamRole: 'vedeni' }, rows)).toBe(true)
    expect(viewerCanDecide(req, { id: A, teamRole: 'projektak' }, rows)).toBe(false)
    expect(viewerCanDecide({ ...req, action_type: 'confirm_next_step' }, { id: A, teamRole: 'projektak' }, rows)).toBe(true)
  })
})

describe('chyby RPC 0084 → česká věta', () => {
  test.each([
    ['Žádost o schválení této verze už čeká', 'Žádost o schválení této verze už čeká na rozhodnutí.'],
    ['Odeslání nabídky schvaluje jen obchodní role', 'Odeslání nabídky schvaluje jen člen s přístupem k obchodu.'],
    ['Odložit smí jen ten, kdo o žádosti může rozhodnout', 'Odložit smí jen ten, kdo o žádosti může rozhodnout.'],
    ['Řešitel kroku musí být aktivní člen týmu', 'Řešitel kroku musí být aktivní člen týmu.'],
    ['new row violates check constraint "approval_request_typed_kind"', 'Tahle činnost se žádá vlastním formulářem (Potvrdit další krok / Odeslat nabídku).'],
  ])('%s', (message, text) => {
    expect(approvalActionErrorMessage({ code: '22023', message })).toBe(text)
  })
  test('chybějící funkce z 0084 = čeká na migraci; cizí chyba = null', () => {
    expect(approvalActionErrorMessage({ code: 'PGRST202', message: 'Could not find the function public.snooze_approval(p_request_id, p_until)' }))
      .toBe(APPROVAL_ACTION_PENDING_MESSAGE)
    expect(approvalActionErrorMessage({ code: 'PGRST202', message: 'Could not find the function public.other()' })).toBeNull()
    expect(approvalActionErrorMessage({ code: '23505', message: 'duplicate' })).toBeNull()
  })
})

describe('nabídka: kdy je potřeba schválení odeslání (zrcadlo SQL)', () => {
  const v = (amount: number, mrr = 0, currency: 'CZK' | 'EUR' = 'CZK') => ({ amount_one_time: amount, expected_mrr: mrr, currency })
  test('výchozí hranice 0 Kč = vždy; jiná hranice počítá jednorázově + 12 × měsíčně', () => {
    expect(offerNeedsSendApproval(v(0))).toBe(true)
    expect(offerNeedsSendApproval(v(150000))).toBe(true)
    expect(offerNeedsSendApproval(v(90000), 100000)).toBe(false)
    expect(offerNeedsSendApproval(v(40000, 5000), 100000)).toBe(true) // 40 000 + 60 000
    expect(offerNeedsSendApproval(v(10, 0, 'EUR'), 100000)).toBe(true) // bez kurzu vždy
    expect(offerNeedsSendApproval(v(10), null)).toBe(false) // šablona schválení nevyžaduje
  })

  test('stav odeslání konceptu a nabízené akce', () => {
    const draft = { id: 40, status: 'draft' as const, amount_one_time: 1, expected_mrr: 0, currency: 'CZK' as const }
    expect(scopeSendState({ ...draft, send_approved_at: undefined }, [])).toBe('free') // před 0084
    expect(scopeSendState({ ...draft, send_approved_at: null }, [])).toBe('needs_approval')
    expect(scopeSendState({ ...draft, send_approved_at: null }, [40])).toBe('pending')
    expect(scopeSendState({ ...draft, send_approved_at: '2026-09-29T10:00:00Z' }, [])).toBe('approved')
    expect(scopeSendState({ ...draft, status: 'sent' as const, send_approved_at: null }, [])).toBe('free')
    expect(scopeVersionActions('draft', 'needs_approval')).toEqual(['request_send'])
    expect(scopeVersionActions('draft', 'pending')).toEqual([])
    expect(scopeVersionActions('draft', 'approved')).toEqual(['send'])
    expect(scopeVersionActions('draft')).toEqual(['send'])
    expect(scopeVersionActions('sent', 'needs_approval')).toEqual(['accept', 'reject'])
  })

  test('chyby strážce SV006–SV008 mají českou větu', () => {
    expect(scopeVersionDbMessage({ code: 'SV006' })).toMatch(/schválit/)
    expect(scopeVersionDbMessage({ code: 'SV007' })).toMatch(/schválená žádost/)
    expect(scopeVersionDbMessage({ code: 'SV008' })).toMatch(/novou verzi/)
  })
})

describe('časová osa případu', () => {
  const base = {
    created_at: '2026-09-20T08:00:00Z',
    created_by: `user:${A}`,
    steps: [
      { id: 1, title: 'Workshop', created_at: '2026-09-20T08:00:01Z' },
      { id: 2, title: 'Technická analýza', created_at: '2026-09-29T10:00:00Z' },
    ],
    decisions: [{ id: 4, question: 'Pokračovat technickou analýzou?', chosen: 'ano', decided_by: `user:${B}`, decided_at: '2026-09-27T08:00:00Z', created_at: '2026-09-20T08:00:00Z' }],
    approvals: [{
      id: 7, action_kind: 'confirm_next_step', action_type: 'confirm_next_step', params: stepParams, status: 'approved',
      requested_by: `user:${B}`, decided_by: `user:${A}`, decided_at: '2026-09-29T10:00:00Z', decision_note: null, created_at: '2026-09-28T08:00:00Z',
    }],
    executions: [exec({ request_id: 7, executed_at: '2026-09-29T10:00:00Z', result: { step_id: 2, task_id: 3, assignee_id: B, due_on: '2026-10-03' } })],
  }
  test('nejnovější nahoře; výsledek provedení nad rozhodnutím; kroky šablony patří k založení', () => {
    const t = buildCaseTimeline(base, names, (k) => k)
    expect(t.map((e) => e.title)).toEqual([
      'Provedeno',
      'Schváleno: Potvrdit další krok „Technická analýza“',
      'Přidán krok „Technická analýza“',
      'Žádost o schválení: Potvrdit další krok „Technická analýza“',
      'Rozhodnuto: Pokračovat technickou analýzou? → ano',
      'Případ založen',
    ])
    expect(t[0]).toMatchObject({ tone: 'done', detail: 'Založen krok „Technická analýza“ a úkol · řeší Pavla · do 3. 10. 2026.' })
    expect(t.at(-1)).toMatchObject({ detail: 'Viktor · 1 krok' })
  })
  test('vypršelá žádost bez rozhodovatele', () => {
    const t = buildCaseTimeline({
      ...base,
      approvals: [{ ...base.approvals[0], status: 'expired', decided_by: null }],
      executions: [],
    }, names, (k) => k)
    expect(t.find((e) => e.key === 'decided-7')).toMatchObject({ title: 'Vypršelo bez rozhodnutí: Potvrdit další krok „Technická analýza“', detail: null, tone: 'idle' })
  })
})

describe('denní úloha vypršení', () => {
  const jobDb = (runId: number | null) => ({ tryAcquireJobLock: vi.fn(async () => runId), finishJobRun: vi.fn(async () => {}) })
  test('zapíše počty do job_run pod vlastním zámkem', async () => {
    const db = jobDb(7)
    const r = await runApprovalExpiryJob({
      jobDb: db,
      expiryDb: { expireDueApprovals: vi.fn(async () => ({ data: { expired: 2, retried: 0, completed: 2, failed: 0, needs_attention: 0 }, error: null })) },
    })
    expect(r).toEqual({ status: 'succeeded', runId: 7, stats: { expired: 2, retried: 0, completed: 2, failed: 0, needs_attention: 0 } })
    expect(db.tryAcquireJobLock).toHaveBeenCalledWith(APPROVAL_EXPIRY_JOB, 120)
  })
  test('bez migrace 0084 jen zapíše stav, jiná chyba = failed, držený zámek = skipped', async () => {
    const missing = await runApprovalExpiryJob({
      jobDb: jobDb(1),
      expiryDb: { expireDueApprovals: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) },
    })
    expect(missing).toMatchObject({ status: 'succeeded', stats: { state: 'missing_migration', migration: '0084' } })
    const failed = await runApprovalExpiryJob({
      jobDb: jobDb(2),
      expiryDb: { expireDueApprovals: async () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) },
    })
    expect(failed).toEqual({ status: 'failed', runId: 2, error: 'expire_due_approvals: boom' })
    const expire = vi.fn()
    expect(await runApprovalExpiryJob({ jobDb: jobDb(null), expiryDb: { expireDueApprovals: expire } })).toEqual({ status: 'skipped' })
    expect(expire).not.toHaveBeenCalled()
  })
})
