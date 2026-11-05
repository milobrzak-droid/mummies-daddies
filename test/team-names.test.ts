import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { setParticipantFullName } from '@/lib/actions/team'
import { updateMyDisplayName } from '@/lib/actions/security'
import { displayNameSchema } from '@/lib/validation/schemas'
import { formatPersonName } from '@/lib/format'
import { createSupabaseFake, hasOp, opArgs, type QueryCall } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function fd(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

beforeEach(() => vi.clearAllMocks())

describe('displayNameSchema', () => {
  test('ořeže mezery', () => {
    const r = displayNameSchema.safeParse({ full_name: '  Viktor  ' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.full_name).toBe('Viktor')
  })
  test('odmítne prázdné', () => {
    expect(displayNameSchema.safeParse({ full_name: '   ' }).success).toBe(false)
  })
  test('odmítne přes 100 znaků', () => {
    expect(displayNameSchema.safeParse({ full_name: 'a'.repeat(101) }).success).toBe(false)
  })
  test('povolí přesně 100 znaků', () => {
    expect(displayNameSchema.safeParse({ full_name: 'a'.repeat(100) }).success).toBe(true)
  })
})

describe('formatPersonName', () => {
  test('vrátí jméno, když je nastavené a liší se od e-mailu', () => {
    expect(formatPersonName('Viktor Kovář', 'viktor@mummiesdaddies.com')).toBe('Viktor Kovář')
  })
  test('e-mail jako "jméno" nahradí kapitalizovanou lokální částí', () => {
    expect(formatPersonName('viktor@mummiesdaddies.com', 'viktor@mummiesdaddies.com')).toBe('Viktor')
  })
  test('e-mail jako jméno je case-insensitive', () => {
    expect(formatPersonName('VIKTOR@mummiesdaddies.com', 'viktor@mummiesdaddies.com')).toBe('Viktor')
  })
  test('chybějící jméno spadne na e-mail', () => {
    expect(formatPersonName(null, 'jana@mummiesdaddies.com')).toBe('Jana')
  })
  test('chybí obojí → pomlčka', () => {
    expect(formatPersonName(null, null)).toBe('—')
  })
})

describe('setParticipantFullName', () => {
  function setup() {
    const gateFake = createSupabaseFake({ resolve: () => ({ data: { is_admin: true }, error: null }) })
    const adminFake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
    vi.mocked(createClient).mockResolvedValue(gateFake.client as never)
    vi.mocked(createAdminClient).mockReturnValue(adminFake.client as never)
    const updates = () => adminFake.calls.filter((c: QueryCall) => hasOp(c, 'update'))
    return { updates }
  }

  test('admin uloží jméno jinému uživateli', async () => {
    const { updates } = setup()
    const r = await setParticipantFullName(OTHER, null, fd({ full_name: 'Nové Jméno' }))
    expect(r).toEqual({ success: true })
    expect(opArgs(updates()[0], 'update')).toEqual([{ full_name: 'Nové Jméno' }])
  })

  test('odmítne neplatné userId', async () => {
    const { updates } = setup()
    const r = await setParticipantFullName('nope', null, fd({ full_name: 'X' }))
    expect(r).toEqual({ success: false, error: 'Neplatný uživatel.' })
    expect(updates()).toHaveLength(0)
  })

  test('odmítne prázdné jméno', async () => {
    const { updates } = setup()
    const r = await setParticipantFullName(OTHER, null, fd({ full_name: '   ' }))
    expect(r.success).toBe(false)
    expect(updates()).toHaveLength(0)
  })

  test('bez admin práv nic neuloží', async () => {
    const gateFake = createSupabaseFake({ resolve: () => ({ data: { is_admin: false }, error: null }) })
    vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
    vi.mocked(createClient).mockResolvedValue(gateFake.client as never)
    const r = await setParticipantFullName(OTHER, null, fd({ full_name: 'X' }))
    expect(r).toEqual({ success: false, error: 'Nemáš oprávnění.' })
  })
})

describe('updateMyDisplayName', () => {
  test('přihlášený uživatel si uloží vlastní jméno (přes admin klienta — team_self už neexistuje, 0069)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
    const r = await updateMyDisplayName(null, fd({ full_name: 'Moje Jméno' }))
    expect(r).toEqual({ success: true })
    const update = fake.calls.find((c: QueryCall) => hasOp(c, 'update'))!
    expect(opArgs(update, 'update')).toEqual([{ full_name: 'Moje Jméno' }])
    expect(opArgs(update, 'eq')).toEqual(['id', ME])
  })

  test('nepřihlášený dostane chybu', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null as never)
    const r = await updateMyDisplayName(null, fd({ full_name: 'X' }))
    expect(r).toEqual({ success: false, error: 'auth' })
  })

  test('prázdné jméno se odmítne', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
    const r = await updateMyDisplayName(null, fd({ full_name: '' }))
    expect(r.success).toBe(false)
  })
})
