import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { revalidatePath } from 'next/cache'
import { dismissAutoIntake, undoAutoIntake } from '@/domain/crm/actions/autoIntake'
import {
  DISMISS_FORBIDDEN,
  DISMISS_MIGRATION_PENDING,
  DISMISS_WON,
  DISMISS_WORKED,
  UNDO_ALREADY,
  UNDO_ALREADY_DISMISSED,
  UNDO_CALENDAR_NOTE,
  UNDO_DONE_NOTE,
  UNDO_FORBIDDEN,
  UNDO_MIGRATION_PENDING,
  dismissDoneNote,
  dismissErrorMessage,
  parseDismissResult,
  undoBlocker,
  undoErrorMessage,
  undoRefusedMessage,
} from '@/domain/crm/autoIntakeUndo'
import { IntakeUndoButton } from '@/components/ui/IntakeUndoButton'
import { createSupabaseFake } from './helpers/supabaseFake'

// „Není poptávka" (0086): Zpět zvládne i práci automatů, lidskou práci
// nesmaže a místo rady „smaž ručně" nabídne uzavření bez mazání. Chování
// v Postgresu ověřuje test/intake-not-inquiry-0086-pglite.test.ts; tady
// server akce, překlad chyb, texty a tlačítko.

vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/currentMember', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const VIKTOR = { id: '11111111-1111-4111-8111-111111111111' }

function rpcReturns(result: { data: unknown; error: unknown }) {
  const fake = createSupabaseFake({ rpc: () => result })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue(VIKTOR as never)
  vi.mocked(getCurrentMember).mockResolvedValue({ user: VIKTOR, member: { role: 'vedeni', is_admin: false, full_name: 'Viktor' } } as never)
})

describe('texty: žádná rada „smaž ručně", vždy cesta v aplikaci', () => {
  test('odmítnutí říká proč, že se nic nesmazalo, a co udělat místo toho', () => {
    const msg = undoRefusedMessage({ code: 'AI001', details: 'sales_activity', message: 'x' })
    expect(msg).toContain('aktivita od člověka')
    expect(msg).toContain('Nic se nesmazalo')
    expect(msg).toContain('Prohráno')
    expect(msg).toContain('Nebyla to poptávka')
    expect(msg).not.toMatch(/ručně/)
  })

  test('DETAIL z 0086 i text staré 0081 vedou na stejný důvod', () => {
    expect(undoBlocker({ code: 'AI001', details: 'engagement' })).toBe('engagement')
    expect(undoBlocker({ code: 'AI001', message: 'U klienta už je další práce (engagement) — zpět to nejde' })).toBe('engagement')
    expect(undoBlocker({ code: 'AI001', message: 'Úkol už někdo řeší nebo je v kalendáři — zpět to nejde' })).toBe('task_started')
    expect(undoBlocker({ code: 'AI001', message: 'S obchodem se už pracuje — zpět to nejde' })).toBe('deal_moved')
    expect(undoRefusedMessage({ code: 'AI001', details: 'nova_tabulka' })).toContain('u firmy je další práce')
  })

  test('překlad chyb Zpět', () => {
    expect(undoErrorMessage({ code: '22023', message: 'Už bylo vráceno' })).toBe(UNDO_ALREADY)
    expect(undoErrorMessage({ code: '22023', message: 'Už je uzavřeno jako Není poptávka' })).toBe(UNDO_ALREADY_DISMISSED)
    expect(undoErrorMessage({ code: '42501', message: 'x' })).toBe(UNDO_FORBIDDEN)
    expect(undoErrorMessage({ code: 'PGRST202', message: 'Could not find the function' })).toBe(UNDO_MIGRATION_PENDING)
    expect(undoErrorMessage({ code: 'XX000', message: 'boom' })).toBeNull()
  })

  test('překlad chyb uzavření', () => {
    expect(dismissErrorMessage({ code: 'AI002', message: 'x' })).toBe(DISMISS_WON)
    expect(dismissErrorMessage({ code: 'AI003', message: 'x', details: 'deal_moved' })).toBe(DISMISS_WORKED)
    expect(dismissErrorMessage({ code: '22023', message: 'Už bylo vráceno' })).toBe(UNDO_ALREADY)
    expect(dismissErrorMessage({ code: '22023', message: 'Už je uzavřeno jako Není poptávka' })).toBe(UNDO_ALREADY_DISMISSED)
    expect(dismissErrorMessage({ code: '42501', message: 'x' })).toBe(DISMISS_FORBIDDEN)
    expect(dismissErrorMessage({ code: '42883', message: 'function auto_intake_dismiss does not exist' })).toBe(DISMISS_MIGRATION_PENDING)
    expect(dismissErrorMessage({ code: 'XX000', message: 'boom' })).toBeNull()
  })

  test('potvrzení uzavření vyjmenuje, co se stalo, a že nic nezmizelo', () => {
    const o = parseDismissResult({ status: 'dismissed', deal: 'lost', task: 'done', snooze_until: '2027-09-29' })!
    expect(o).toEqual({ deal: 'lost', task: 'done', snoozeUntil: '2027-09-29' })
    const note = dismissDoneNote(o)
    expect(note).toContain('Prohráno s důvodem „Nebyla to poptávka"')
    expect(note).toContain('Úkol „Odpovědět na poptávku" je uzavřený')
    expect(note).toContain('29. 9. 2027')
    expect(note).toContain('Nic se nesmazalo')
    expect(parseDismissResult({ status: 'undone' })).toBeNull()
    expect(parseDismissResult(null)).toBeNull()
    expect(dismissDoneNote({ deal: 'none', task: 'none', snoozeUntil: null })).toBe('Uzavřeno jako Není poptávka. Nic se nesmazalo.')
    // 0096: rozpracovaný úkol zůstal, firma se neodložila (u ní je další práce).
    const kept = parseDismissResult({ status: 'dismissed', deal: 'lost', task: 'kept', snooze_until: null, account: 'kept' })!
    expect(kept).toEqual({ deal: 'lost', task: 'kept', snoozeUntil: null, accountKept: true })
    const keptNote = dismissDoneNote(kept)
    expect(keptNote).toContain('už někdo řeší, zůstal beze změny')
    expect(keptNote).toContain('Firma zůstala beze změny')
    expect(keptNote).not.toContain('odložená do')
    expect(parseDismissResult({ status: 'dismissed', deal: 'none', task: 'nesmysl' })).toMatchObject({ task: 'none' })
  })
})

describe('undoAutoIntake', () => {
  test('lidská práce: nic se nesmaže, přijde vysvětlení a nabídka uzavření', async () => {
    const fake = rpcReturns({ data: null, error: { code: 'AI001', details: 'deal_moved', message: 'S obchodem se už pracuje — zpět to nejde' } })
    const r = await undoAutoIntake(7)
    expect(fake.rpc).toHaveBeenCalledWith('auto_intake_undo', { p_id: 7 })
    expect(r.success).toBe(false)
    // 0095: uzavření obchod s prací nepřepíše, proto se nenabízí; řeší se v Obchodech.
    expect(r.canDismiss).toBe(false)
    expect(r.error).toContain('s obchodem se už pracuje')
    expect(r.error).toContain('v Obchodech')
    expect(r.error).not.toContain('Prohráno')
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('jiná lidská práce než obchod: uzavření se dál nabízí', async () => {
    rpcReturns({ data: null, error: { code: 'AI001', details: 'sales_activity', message: 'U klienta už je další práce (sales_activity)' } })
    const r = await undoAutoIntake(7)
    expect(r.canDismiss).toBe(true)
  })

  test('vráceno; úkol byl v kalendáři → řekne, ať událost smaže v Outlooku', async () => {
    rpcReturns({ data: { status: 'undone', calendar_event: true, deleted: { task: 1 } }, error: null })
    expect(await undoAutoIntake(7)).toEqual({ success: true, note: `${UNDO_DONE_NOTE} ${UNDO_CALENDAR_NOTE}` })
    rpcReturns({ data: { status: 'undone', calendar_event: false }, error: null })
    expect(await undoAutoIntake(7)).toEqual({ success: true, note: UNDO_DONE_NOTE })
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/oslovovani')
  })

  test('bez AAL2, s neplatným id nebo bez obchodní role RPC nevolá', async () => {
    const fake = rpcReturns({ data: null, error: null })
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    expect(await undoAutoIntake(7)).toEqual({ success: false, error: 'auth' })
    expect(await undoAutoIntake(0)).toMatchObject({ success: false })
    vi.mocked(getCurrentMember).mockResolvedValueOnce({ user: VIKTOR, member: { role: 'projektak', is_admin: false, full_name: 'M' } } as never)
    expect(await undoAutoIntake(7)).toEqual({ success: false, error: UNDO_FORBIDDEN })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
})

describe('dismissAutoIntake (Uzavřít jako Není poptávka)', () => {
  test('volá auto_intake_dismiss a vrátí potvrzení', async () => {
    const fake = rpcReturns({ data: { status: 'dismissed', deal: 'lost', task: 'done', snooze_until: '2027-09-29' }, error: null })
    const r = await dismissAutoIntake(7)
    expect(fake.rpc).toHaveBeenCalledWith('auto_intake_dismiss', { p_id: 7 })
    expect(r.success).toBe(true)
    expect(r.note).toContain('Nebyla to poptávka')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/pipeline')
  })

  test('vyhraný obchod → česká hláška, nic se nezmění', async () => {
    rpcReturns({ data: null, error: { code: 'AI002', message: 'Obchod je vyhraný — poptávka to byla' } })
    expect(await dismissAutoIntake(7)).toEqual({ success: false, error: DISMISS_WON })
  })

  test('0095: obchod s rozdělanou prací → česká hláška, nic se nezmění', async () => {
    rpcReturns({ data: null, error: { code: 'AI003', message: 'S obchodem se už pracuje', details: 'deal_moved' } })
    expect(await dismissAutoIntake(7)).toEqual({ success: false, error: DISMISS_WORKED })
  })

  test('bez AAL2 nebo bez obchodní role RPC nevolá', async () => {
    const fake = rpcReturns({ data: null, error: null })
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    expect(await dismissAutoIntake(7)).toEqual({ success: false, error: 'auth' })
    vi.mocked(getCurrentMember).mockResolvedValueOnce({ user: VIKTOR, member: { role: 'lektor', is_admin: false, full_name: 'L' } } as never)
    expect(await dismissAutoIntake(7)).toEqual({ success: false, error: DISMISS_FORBIDDEN })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
})

describe('tlačítko a migrace', () => {
  test('výchozí stav: jen „Není poptávka", bez nabídky uzavření', () => {
    const noop = async () => ({ success: true })
    const html = renderToStaticMarkup(<IntakeUndoButton action={noop} dismiss={noop} label="Acme" />)
    expect(html).toContain('Není poptávka')
    expect(html).toContain('aria-label="Není poptávka, vrátit zpět: Acme"')
    expect(html).not.toContain('Uzavřít jako Není poptávka')
  })

  test('0086: obě funkce jen pro přihlášené (ne anon) a uzavření nic nemaže', () => {
    const sql = readFileSync('supabase/migrations/0086_intake_not_inquiry.sql', 'utf8').replace(/--[^\n]*/g, '')
    for (const fn of ['auto_intake_undo', 'auto_intake_dismiss']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\(bigint\\) FROM PUBLIC, anon;`))
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${fn}\\(bigint\\) TO authenticated;`))
    }
    const dismissBody = /FUNCTION auto_intake_dismiss\(p_id bigint\)[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(sql)![1]
    expect(dismissBody).not.toMatch(/\bDELETE\b/)
    expect(dismissBody).toContain("lost_reason = 'Nebyla to poptávka'")
    expect(dismissBody).toMatch(/v_actor\s+text := loop_actor\(\)/)
    expect(dismissBody).toMatch(/IF NOT can_see_sales\(\)/)
  })
})
