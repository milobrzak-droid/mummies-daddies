import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Cron = { path: string; schedule: string }
const config = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as { crons?: Cron[] }

/** Hobby plán: nejvýš jedno spuštění denně → minuta i hodina musí být pevné číslo. */
function atMostDaily(schedule: string): boolean {
  const [min, hour] = schedule.trim().split(/\s+/)
  return /^\d+$/.test(min) && /^\d+$/.test(hour)
}

describe('vercel.json — cron', () => {
  it('outlook-mail běží denně ve 04:00 UTC', () => {
    expect(config.crons).toContainEqual({ path: '/api/cron/outlook-mail', schedule: '0 4 * * *' })
  })

  it('weekly-digest denně v 05:00 UTC (po/pá přehled týdne, jinak ranní souhrn jen když je co hlásit)', () => {
    expect(config.crons).toContainEqual({ path: '/api/cron/weekly-digest', schedule: '0 5 * * *' })
  })

  it('všechny plány jsou povolené na Hobby (nejvýš 1× denně)', () => {
    for (const c of config.crons ?? []) expect(atMostDaily(c.schedule), c.schedule).toBe(true)
  })
})

describe('/api/cron/outlook-mail — vypínač', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('bez OUTLOOK_MAIL_SYNC_ENABLED=true vrací 404, i se správným CRON_SECRET', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'yes')
    const { GET } = await import('@/app/api/cron/outlook-mail/route')
    const res = await GET(new Request('https://x/api/cron/outlook-mail', { headers: { authorization: 'Bearer s3cret' } }))
    expect(res.status).toBe(404)
  })

  it('zapnutá route bez správného Bearer vrací 401', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'true')
    const { GET } = await import('@/app/api/cron/outlook-mail/route')
    const res = await GET(new Request('https://x/api/cron/outlook-mail', { headers: { authorization: 'Bearer spatne' } }))
    expect(res.status).toBe(401)
  })
})
