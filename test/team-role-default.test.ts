// Security review: nový člen týmu nesmí tiše dostat roli 'vedeni'.
// Schéma vyžaduje explicitní roli, createParticipant ji předá beze změny
// a migrace 0056 mění jen DEFAULT sloupce (žádný UPDATE existujících řádků).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { createParticipant } from '@/lib/actions/team'
import { participantSchema, teamRole } from '@/lib/validation/schemas'
import { TEAM_ROLES, seesByznys } from '@/lib/domain'
import { createSupabaseFake, hasOp, opArgs } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ME = '11111111-1111-4111-8111-111111111111'
const NEW = '33333333-3333-4333-8333-333333333333'
const BASE = { email: 'novy@mummiesdaddies.com', full_name: 'Nový Člen', password: 'heslo1234' }

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

function setup(isAdmin = true) {
  const gateFake = createSupabaseFake({ resolve: () => ({ data: { is_admin: isAdmin }, error: null }) })
  const adminFake = createSupabaseFake()
  const createUser = vi.fn(async () => ({ data: { user: { id: NEW } }, error: null }))
  vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
  vi.mocked(createClient).mockResolvedValue(gateFake.client as never)
  vi.mocked(createAdminClient).mockReturnValue({ ...adminFake.client, auth: { admin: { createUser } } } as never)
  return { createUser, updates: () => adminFake.calls.filter((c) => hasOp(c, 'update')) }
}

beforeEach(() => vi.clearAllMocks())

describe('participantSchema — role je povinná', () => {
  test('bez role neprojde (žádný tichý default)', () => {
    const r = participantSchema.safeParse(BASE)
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]).toMatchObject({ path: ['role'], message: 'Vyber roli.' })
  })

  test('prázdná role (placeholder ve formuláři) neprojde', () => {
    expect(participantSchema.safeParse({ ...BASE, role: '' }).success).toBe(false)
  })

  test('neznámá role neprojde', () => {
    expect(participantSchema.safeParse({ ...BASE, role: 'admin' }).success).toBe(false)
  })

  test.each(teamRole.options)('platná role %s projde beze změny', (role) => {
    const r = participantSchema.safeParse({ ...BASE, role })
    expect(r.success).toBe(true)
    expect(r.data?.role).toBe(role)
  })

  test('enum schématu = role v lib/domain.ts', () => {
    expect([...teamRole.options].sort()).toEqual(TEAM_ROLES.map((r) => r.key).sort())
  })
})

describe('createParticipant — předá zvolenou roli', () => {
  test('lektor ve formuláři → UPDATE team_member s role lektor', async () => {
    const { updates, createUser } = setup()
    const res = await createParticipant(null, form({ ...BASE, role: 'lektor' }))
    expect(res).toEqual({ success: true })
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(updates()).toHaveLength(1)
    expect(updates()[0].table).toBe('team_member')
    expect(opArgs(updates()[0], 'update')).toEqual([{ full_name: BASE.full_name, role: 'lektor', is_admin: false }])
  })

  test('bez role → fieldErrors.role, uživatel se nezaloží', async () => {
    const { updates, createUser } = setup()
    const res = await createParticipant(null, form(BASE))
    expect(res).toEqual({ success: false, fieldErrors: { role: 'Vyber roli.' } })
    expect(createUser).not.toHaveBeenCalled()
    expect(updates()).toHaveLength(0)
  })

  test('ne-admin je odmítnut dřív než validace', async () => {
    const { createUser } = setup(false)
    const res = await createParticipant(null, form({ ...BASE, role: 'vedeni' }))
    expect(res).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(createUser).not.toHaveBeenCalled()
  })

  test('AAL2 guard: requireUser se volá s aal2', async () => {
    setup()
    await createParticipant(null, form({ ...BASE, role: 'partner' }))
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
  })
})

describe('migrace 0056 — výchozí role', () => {
  const raw = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0056_team_role_default.sql'), 'utf8')
  const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

  test('nastaví DEFAULT na partner', () => {
    expect(sql).toMatch(/ALTER TABLE\s+team_member\s+ALTER COLUMN\s+role\s+SET DEFAULT\s+'partner'/i)
  })

  test('výchozí role nevidí Byznys', () => {
    expect(seesByznys('partner')).toBe(false)
  })

  test('nemění existující řádky (žádný UPDATE/DELETE)', () => {
    expect(sql).not.toMatch(/\bUPDATE\b/i)
    expect(sql).not.toMatch(/\bDELETE\b/i)
  })

  test('zapíše se do schema_migration', () => {
    expect(sql).toMatch(/INSERT INTO\s+schema_migration[\s\S]*'0056'[\s\S]*ON CONFLICT \(version\) DO NOTHING/i)
  })
})
