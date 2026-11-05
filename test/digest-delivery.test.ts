// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { getAppOnlyToken, sendMailAsMe, sendMailAsUser, sendMailUrl, SEND_MAIL_AS_ME_URL, type SendFetch } from '@/connectors/graph'
import type { ConnectorState } from '@/core/connectorState'
import { buildDigest, type DigestInput } from '@/domain/crm/digest'
import {
  DEFAULT_DIGEST_SENDER,
  MISSING_MAIL_SEND_ERROR,
  SENDER_NOT_CONNECTED_ERROR,
  SENDER_REFRESH_FAILED_ERROR,
  SENDER_TOKEN_SAVE_ERROR,
  czechDateLabel,
  deliverDigest,
  digestKindFor,
  explainDelegatedSendResult,
  getDelegatedSendToken,
  isCronAuthorized,
  isValidEmail,
  parseDigestRecipients,
  parseDigestSendMode,
  readDigestDeliveryConfig,
  shouldSendDigest,
  type DelegatedTokenDeps,
  type DigestDeliveryConfig,
  type DigestDeliveryDeps,
} from '@/domain/crm/digestDelivery'
import { opsReportItemCount } from '@/domain/crm/opsReport'
import { opsReport } from './helpers/opsReportFixture'

const SECRET = 'super-secret-value-XYZ'
const TOKEN = 'eyJ.app-only-token.sig'
const MONDAY = new Date('2026-09-28T05:00:00Z') // po 07:00 Praha
const WEDNESDAY = new Date('2026-09-30T05:00:00Z')

const res = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status })

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    followUps: [],
    outreach: [],
    blockedDeals: [],
    connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null },
    lastMeetingNoteAt: null,
    outlookMailSyncEnabled: true,
    generatedAt: MONDAY,
    ...overrides,
  }
}

const nonEmpty = () => input({
  blockedDeals: [{ id: 7, account_id: 3, title: 'Pilot', account_name: 'ACME', status_blocker: 'čeká na podpis' }],
})

// Zdravé zdroje: isStale měří proti skutečnému Date.now(), zápisy schůzek
// proti generatedAt (viz test/digest.test.ts).
const fresh = (connector: string, o: Partial<ConnectorState> = {}): ConnectorState => ({
  connector, cursor: null, last_success_at: new Date(Date.now() - 60_000).toISOString(),
  last_error: null, last_error_at: null, consecutive_errors: 0,
  updated_at: new Date(Date.now() - 60_000).toISOString(), ...o,
})

function healthyInput(at: Date): DigestInput {
  return input({
    generatedAt: at,
    lastMeetingNoteAt: new Date(at.getTime() - 3_600_000).toISOString(),
    connectorStates: {
      graphCalendar: fresh('graph_calendar'),
      outlookMailInbox: fresh('outlook:inbox'),
      outlookMailSent: fresh('outlook:sent'),
      graphSend: fresh('graph_send'),
    },
  })
}

const config: DigestDeliveryConfig = {
  mode: 'app',
  appUrl: 'https://cockpit.example.cz',
  sender: 'cockpit@mummiesdaddies.com',
  recipients: ['viktor@mummiesdaddies.com', 'jana@mummiesdaddies.com'],
  credentials: { tenantId: 'mummiesdaddies.com', clientId: 'client-id', clientSecret: SECRET },
}

function deps({ digestInput, at, ...over }: Partial<DigestDeliveryDeps> & { digestInput?: DigestInput; at?: Date } = {}) {
  const di = digestInput ?? nonEmpty()
  const d = {
    now: () => at ?? MONDAY,
    claimSendMarker: vi.fn(async (day: string, kind: string) => { void day; void kind; return true }),
    releaseSendMarker: vi.fn(async (day: string, kind: string) => { void day; void kind }),
    filterTeamRecipients: vi.fn(async (r: string[]) => r),
    loadDigest: vi.fn(async () => ({ digest: buildDigest(di), source: di })),
    getToken: vi.fn(async () => ({ ok: true as const, accessToken: TOKEN, expiresInSeconds: 3599 })),
    sendMail: vi.fn(async () => ({ ok: true as const })),
    recordSuccess: vi.fn(async () => {}),
    recordError: vi.fn(async (message: string) => { void message }),
    ...over,
  }
  return d
}

describe('příjemci a konfigurace', () => {
  it('validuje e-maily přísně', () => {
    expect(isValidEmail('viktor@mummiesdaddies.com')).toBe(true)
    for (const bad of ['', 'viktor', 'a@b', 'a b@x.cz', 'Jan <a@x.cz>', 'a@x..cz', 'a@x.cz\r\nBcc: e@v.il', 'a..b@x.cz']) {
      expect(isValidEmail(bad), bad).toBe(false)
    }
  })

  it('parsuje čárkami, ořezává, sjednotí velikost a odstraní duplicity', () => {
    expect(parseDigestRecipients(' Viktor@MummiesDaddies.com, jana@mummiesdaddies.com ,,viktor@mummiesdaddies.com')).toEqual({
      ok: true,
      recipients: ['viktor@mummiesdaddies.com', 'jana@mummiesdaddies.com'],
    })
  })

  it('odmítne prázdné, neplatné (bez vypsání adresy) a víc než 20', () => {
    expect(parseDigestRecipients(undefined).ok).toBe(false)
    expect(parseDigestRecipients(' , ').ok).toBe(false)
    const bad = parseDigestRecipients('ok@mummiesdaddies.com,tajny-clovek@@x')
    expect(bad.ok).toBe(false)
    expect(JSON.stringify(bad)).not.toContain('tajny-clovek')
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@mummiesdaddies.com`).join(',')
    expect(parseDigestRecipients(many)).toMatchObject({ ok: false })
    const twenty = Array.from({ length: 20 }, (_, i) => `u${i}@mummiesdaddies.com`).join(',')
    expect(parseDigestRecipients(twenty)).toMatchObject({ ok: true })
  })

  it('M1: jen @mummiesdaddies.com — cizí doménu odmítne s počtem, bez adres', () => {
    const r = parseDigestRecipients('viktor@mummiesdaddies.com,soukromy@gmail.com,x@mummiesdaddies.com.evil.com,y@sub.mummiesdaddies.com')
    expect(r.ok).toBe(false)
    const text = JSON.stringify(r)
    expect(text).toContain('3 adresu/adres mimo @mummiesdaddies.com')
    expect(text).not.toContain('soukromy')
    expect(text).not.toContain('gmail')
    expect(parseDigestRecipients('Viktor@MummiesDaddies.com')).toEqual({ ok: true, recipients: ['viktor@mummiesdaddies.com'] })
    const cfg = readDigestDeliveryConfig({
      APP_URL: 'https://cockpit.example.cz', DIGEST_RECIPIENTS: 'a@example.com', DIGEST_SEND_MODE: 'app',
      MS_APP_TENANT_ID: 't', MS_APP_CLIENT_ID: 'c', MS_APP_CLIENT_SECRET: SECRET,
    })
    expect(cfg.ok).toBe(false)
    expect(JSON.stringify(cfg)).toContain('DIGEST_RECIPIENTS')
    expect(JSON.stringify(cfg)).not.toContain('a@example.com')
  })

  it('config app: výchozí odesílatel cockpit@, chyby jen se jmény proměnných (beze změny)', () => {
    const ok = readDigestDeliveryConfig({
      DIGEST_SEND_MODE: 'app',
      APP_URL: 'https://cockpit.example.cz/',
      DIGEST_RECIPIENTS: 'viktor@mummiesdaddies.com',
      MS_APP_TENANT_ID: 't', MS_APP_CLIENT_ID: 'c', MS_APP_CLIENT_SECRET: SECRET,
    })
    expect(ok.ok && ok.config.mode).toBe('app')
    expect(ok.ok && ok.config.mode === 'app' && ok.config.sender).toBe(DEFAULT_DIGEST_SENDER)
    expect(ok.ok && ok.config.appUrl).toBe('https://cockpit.example.cz')
    expect(ok.ok && ok.config.mode === 'app' && ok.config.credentials).toEqual({ tenantId: 't', clientId: 'c', clientSecret: SECRET })

    const bad = readDigestDeliveryConfig({ DIGEST_SEND_MODE: 'app', APP_URL: 'http://x.cz', MS_APP_CLIENT_SECRET: SECRET, DIGEST_SENDER: 'nope' })
    expect(bad.ok).toBe(false)
    const text = JSON.stringify(bad)
    expect(text).toContain('MS_APP_TENANT_ID')
    expect(text).toContain('DIGEST_RECIPIENTS')
    expect(text).toContain('APP_URL')
    expect(text).toContain('DIGEST_SENDER')
    expect(text).not.toContain(SECRET)
  })

  const MEMBER = 'f6d18417-48ac-423b-b459-d09ee5a5103f'
  const delegatedEnv = {
    APP_URL: 'https://cockpit.example.cz',
    DIGEST_RECIPIENTS: 'viktor@mummiesdaddies.com,lenka@mummiesdaddies.com',
    OUTLOOK_MAIL_SYNC_MEMBER_ID: MEMBER,
    MS_CLIENT_ID: 'login-client', MS_CLIENT_SECRET: SECRET,
  }

  it('režim: výchozí delegated, jen delegated/app, jinak chyba', () => {
    expect(parseDigestSendMode(undefined)).toBe('delegated')
    expect(parseDigestSendMode(' ')).toBe('delegated')
    expect(parseDigestSendMode('Delegated')).toBe('delegated')
    expect(parseDigestSendMode('app')).toBe('app')
    expect(parseDigestSendMode('cockpit')).toBeNull()
    const bad = readDigestDeliveryConfig({ ...delegatedEnv, DIGEST_SEND_MODE: 'smtp' })
    expect(bad).toEqual({ ok: false, errors: ['DIGEST_SEND_MODE musí být delegated (výchozí) nebo app'] })
  })

  it('config delegated (výchozí): bez MS_APP_* i bez DIGEST_SENDER, odesílatel = člen syncu pošty', () => {
    const ok = readDigestDeliveryConfig({ ...delegatedEnv, DIGEST_SENDER: 'nope' })
    expect(ok).toEqual({
      ok: true,
      config: {
        mode: 'delegated',
        appUrl: 'https://cockpit.example.cz',
        recipients: ['viktor@mummiesdaddies.com', 'lenka@mummiesdaddies.com'],
        senderMemberId: MEMBER,
      },
    })
  })

  it('config delegated: DIGEST_SENDER_MEMBER_ID má přednost před OUTLOOK_MAIL_SYNC_MEMBER_ID', () => {
    const other = '11111111-2222-3333-4444-555555555555'
    const ok = readDigestDeliveryConfig({ ...delegatedEnv, DIGEST_SENDER_MEMBER_ID: other.toUpperCase() })
    expect(ok.ok && ok.config.mode === 'delegated' && ok.config.senderMemberId).toBe(other)
  })

  it('config delegated: chybí/neplatné member id a přihlašovací appka → chyby se jmény, bez hodnot', () => {
    const missing = readDigestDeliveryConfig({ ...delegatedEnv, OUTLOOK_MAIL_SYNC_MEMBER_ID: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '' })
    expect(missing.ok).toBe(false)
    const text = JSON.stringify(missing)
    expect(text).toContain('DIGEST_SENDER_MEMBER_ID chybí')
    expect(text).toContain('MS_CLIENT_ID chybí')
    expect(text).toContain('MS_CLIENT_SECRET chybí')
    expect(text).not.toContain('MS_APP_')

    const notUuid = readDigestDeliveryConfig({ ...delegatedEnv, OUTLOOK_MAIL_SYNC_MEMBER_ID: 'viktor@mummiesdaddies.com' })
    expect(notUuid).toEqual({ ok: false, errors: ['OUTLOOK_MAIL_SYNC_MEMBER_ID není uuid člena týmu'] })
    const ownNotUuid = readDigestDeliveryConfig({ ...delegatedEnv, DIGEST_SENDER_MEMBER_ID: 'x' })
    expect(ownNotUuid).toEqual({ ok: false, errors: ['DIGEST_SENDER_MEMBER_ID není uuid člena týmu'] })
    expect(JSON.stringify(ownNotUuid)).not.toContain(SECRET)
  })

  it('config app: MS_APP_* povinné, member id ani MS_CLIENT_* ne', () => {
    const r = readDigestDeliveryConfig({ DIGEST_SEND_MODE: 'app', APP_URL: 'https://cockpit.example.cz', DIGEST_RECIPIENTS: 'viktor@mummiesdaddies.com' })
    expect(r.ok).toBe(false)
    const text = JSON.stringify(r)
    expect(text).toContain('MS_APP_TENANT_ID chybí')
    expect(text).not.toContain('MEMBER_ID')
    expect(text).not.toContain('MS_CLIENT_ID')
  })

  it('cron autorizace: jen přesný Bearer, bez tajemství vždy false', () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true)
    expect(isCronAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false)
    expect(isCronAuthorized(SECRET, SECRET)).toBe(false)
    expect(isCronAuthorized(null, SECRET)).toBe(false)
    expect(isCronAuthorized('Bearer ', '')).toBe(false)
  })
})

describe('druh přehledu', () => {
  it('po a pá = týdenní (posílá i prázdný), jinak ranní jen když je co hlásit', () => {
    expect(digestKindFor(MONDAY)).toBe('weekly')
    expect(digestKindFor(new Date('2026-10-02T05:00:00Z'))).toBe('weekly') // pátek
    expect(digestKindFor(WEDNESDAY)).toBe('daily')
    // neděle 23:30 UTC = pondělí 01:30 Praha
    expect(digestKindFor(new Date('2026-09-27T23:30:00Z'))).toBe('weekly')
    expect(shouldSendDigest('weekly', { isEmpty: true, sourceAlerts: 0 })).toBe(true)
    expect(shouldSendDigest('daily', { isEmpty: true, sourceAlerts: 0 })).toBe(false)
    expect(shouldSendDigest('daily', { isEmpty: false, sourceAlerts: 0 })).toBe(true)
    // zastaralý / rozbitý zdroj odešle ranní souhrn i bez položek
    expect(shouldSendDigest('daily', { isEmpty: true, sourceAlerts: 1 })).toBe(true)
  })

  it('každý den v týdnu (Praha): po a pá týdenní, ostatní ranní souhrn', () => {
    const days: [string, string][] = [
      ['2026-09-28T05:00:00Z', 'weekly'], // po
      ['2026-09-29T05:00:00Z', 'daily'], // út
      ['2026-09-30T05:00:00Z', 'daily'], // st
      ['2026-10-01T05:00:00Z', 'daily'], // čt
      ['2026-10-02T05:00:00Z', 'weekly'], // pá
      ['2026-10-03T05:00:00Z', 'daily'], // so
      ['2026-10-04T05:00:00Z', 'daily'], // ne
      // Hobby cron se spustí kdykoli v 05:00–05:59 UTC — pořád týž pražský den
      ['2026-10-02T05:59:00Z', 'weekly'],
      // zimní čas (UTC+1): po 06:00 Praha
      ['2026-11-02T05:00:00Z', 'weekly'],
    ]
    for (const [iso, kind] of days) expect(digestKindFor(new Date(iso)), iso).toBe(kind)
  })

  it('český štítek data', () => {
    expect(czechDateLabel(MONDAY)).toBe('pondělí 28. 9. 2026')
  })
})

describe('deliverDigest', () => {
  it('pošle jednou všem příjemcům a zapíše úspěch graph_send', async () => {
    const d = deps()
    const stats = await deliverDigest(config, d)
    expect(stats).toEqual({ kind: 'weekly', prague_day: '2026-09-28', outcome: 'sent', sent_day: '2026-09-28', recipients: 2, dropped_recipients: 0, items: 1, source_alerts: 1 })
    expect(d.claimSendMarker).toHaveBeenCalledWith('2026-09-28', 'weekly')
    expect(d.loadDigest).toHaveBeenCalledWith(MONDAY, 'weekly')
    expect(d.releaseSendMarker).not.toHaveBeenCalled()
    expect(d.sendMail).toHaveBeenCalledTimes(1)
    const [token, mail] = vi.mocked(d.sendMail).mock.calls[0] as unknown as [string, { subject: string; html: string; to: string[] }]
    expect(token).toBe(TOKEN)
    expect(mail.to).toEqual(config.recipients)
    expect(mail.subject).toContain('Přehled týdne pondělí 28. 9. 2026')
    expect(mail.html).toContain('https://cockpit.example.cz/cockpit/clients/3/deals/7')
    expect(d.recordSuccess).toHaveBeenCalledTimes(1)
    expect(d.recordError).not.toHaveBeenCalled()
    // stats (jdou do job_run) nenesou adresy
    expect(JSON.stringify(stats)).not.toContain('@')
  })

  it('už dnes odesláno (marker existoval) → nic nenačítá ani neposílá', async () => {
    const d = deps({ claimSendMarker: vi.fn(async (day: string) => day !== '2026-09-28') })
    const stats = await deliverDigest(config, d)
    expect(stats.outcome).toBe('already_sent')
    expect(d.loadDigest).not.toHaveBeenCalled()
    expect(d.getToken).not.toHaveBeenCalled()
    expect(d.sendMail).not.toHaveBeenCalled()
    expect(d.releaseSendMarker).not.toHaveBeenCalled()
  })

  it('L1: marker se zabírá PŘED odesláním', async () => {
    const order: string[] = []
    const d = deps({
      claimSendMarker: vi.fn(async () => { order.push('claim'); return true }),
      sendMail: vi.fn(async () => { order.push('send'); return { ok: true as const } }),
    })
    await deliverDigest(config, d)
    expect(order).toEqual(['claim', 'send'])
  })

  it('L1: chyba markeru = fail closed, nic neposílá', async () => {
    const d = deps({ claimSendMarker: vi.fn(async () => { throw new Error('Chybí migrace 0053') }) })
    await expect(deliverDigest(config, d)).rejects.toThrow('0053')
    expect(d.sendMail).not.toHaveBeenCalled()
  })

  it('L1: selhání načtení dat uvolní marker a vyhodí', async () => {
    const d = deps({ loadDigest: vi.fn(async () => { throw new Error('db down') }) })
    await expect(deliverDigest(config, d)).rejects.toThrow('db down')
    expect(d.releaseSendMarker).toHaveBeenCalledWith('2026-09-28', 'weekly')
  })

  it('L1: selhání uvolnění markeru nezakryje původní chybu', async () => {
    const d = deps({
      sendMail: vi.fn(async () => ({ ok: false as const, status: 500, message: 'Graph 500 x' })),
      releaseSendMarker: vi.fn(async () => { throw new Error('delete failed') }),
    })
    await expect(deliverDigest(config, d)).rejects.toThrow('Graph 500 x')
  })

  it('L1: recordSuccess je best-effort — odeslaný mail zůstane sent', async () => {
    const d = deps({ recordSuccess: vi.fn(async () => { throw new Error('connector_state down') }) })
    const stats = await deliverDigest(config, d)
    expect(stats.outcome).toBe('sent')
    expect(d.sendMail).toHaveBeenCalledTimes(1)
    expect(d.releaseSendMarker).not.toHaveBeenCalled()
  })

  it('M1: příjemci mimo team_member se vyřadí, stats nesou jen počty', async () => {
    const d = deps({ filterTeamRecipients: vi.fn(async () => ['jana@mummiesdaddies.com']) })
    const stats = await deliverDigest(config, d)
    expect(stats).toMatchObject({ outcome: 'sent', recipients: 1, dropped_recipients: 1 })
    const mail = vi.mocked(d.sendMail).mock.calls[0] as unknown as [string, { to: string[] }]
    expect(mail[1].to).toEqual(['jana@mummiesdaddies.com'])
    expect(JSON.stringify(stats)).not.toContain('@')
  })

  it('M1: nikdo z příjemců není v týmu → chyba bez adres, marker se nezabírá', async () => {
    const d = deps({ filterTeamRecipients: vi.fn(async () => []) })
    const err = await deliverDigest(config, d).catch((e: Error) => e)
    expect(String(err)).toContain('Žádný z 2 příjemců')
    expect(String(err)).not.toContain('@')
    expect(d.claimSendMarker).not.toHaveBeenCalled()
    expect(d.sendMail).not.toHaveBeenCalled()
  })

  it('ranní souhrn bez obsahu a se zdravými zdroji se neposílá (marker uvolní), pondělní prázdný ano', async () => {
    const daily = deps({ at: WEDNESDAY, digestInput: healthyInput(WEDNESDAY) })
    expect((await deliverDigest(config, daily)).outcome).toBe('nothing_to_report')
    expect(daily.loadDigest).toHaveBeenCalledWith(WEDNESDAY, 'daily')
    expect(daily.sendMail).not.toHaveBeenCalled()
    expect(daily.releaseSendMarker).toHaveBeenCalledWith('2026-09-30', 'daily')

    const weekly = deps({ digestInput: input() })
    expect((await deliverDigest(config, weekly)).outcome).toBe('sent')
    const mail = vi.mocked(weekly.sendMail).mock.calls[0] as unknown as [string, { subject: string }]
    expect(mail[1].subject).toContain('nic nečeká')
  })

  it('ranní souhrn: rozbitý zdroj (poslední běh s chybou) ho odešle i bez položek', async () => {
    const broken = healthyInput(WEDNESDAY)
    broken.connectorStates.outlookMailInbox = fresh('outlook:inbox', { consecutive_errors: 1, last_error: MISSING_MAIL_SEND_ERROR })
    const d = deps({ at: WEDNESDAY, digestInput: broken })
    const stats = await deliverDigest(config, d)
    expect(stats).toMatchObject({ kind: 'daily', outcome: 'sent', items: 0, source_alerts: 1 })
    const [, mail] = vi.mocked(d.sendMail).mock.calls[0] as unknown as [string, { subject: string; html: string }]
    expect(mail.subject).toBe('Ranní souhrn středa 30. 9. 2026: zdroje dat vyžadují pozornost')
    expect(mail.html).toContain(`— chyba: ${MISSING_MAIL_SEND_ERROR}`)
  })

  it('ranní souhrn: zastaralý zdroj ho odešle, follow-up po termínu i blokovaný obchod taky', async () => {
    // Zastaralý sync pošty (běží sám, denní cron) = porucha → odešle.
    const stale = healthyInput(WEDNESDAY)
    stale.connectorStates = { ...stale.connectorStates, outlookMailInbox: null }
    expect((await deliverDigest(config, deps({ at: WEDNESDAY, digestInput: stale }))).outcome).toBe('sent')

    // Týden bez zápisu schůzky ani použití kalendáře není porucha → ranní souhrn neodejde.
    const quiet = healthyInput(WEDNESDAY)
    quiet.lastMeetingNoteAt = '2026-08-01T10:00:00Z'
    quiet.connectorStates = { ...quiet.connectorStates, graphCalendar: null }
    expect((await deliverDigest(config, deps({ at: WEDNESDAY, digestInput: quiet }))).outcome).toBe('nothing_to_report')

    const blocked = { ...healthyInput(WEDNESDAY), blockedDeals: nonEmpty().blockedDeals }
    const b = deps({ at: WEDNESDAY, digestInput: blocked })
    expect(await deliverDigest(config, b)).toMatchObject({ outcome: 'sent', items: 1, source_alerts: 0 })
    const [, mail] = vi.mocked(b.sendMail).mock.calls[0] as unknown as [string, { subject: string }]
    expect(mail.subject).toBe('Ranní souhrn středa 30. 9. 2026: 1 položka (Blokované obchody: 1)')

    const followUp = {
      ...healthyInput(WEDNESDAY),
      followUps: [{ deal_id: 4, account_id: 2, title: 'Nabídka', account_name: 'ALFATECH', due: '2026-09-25', days_overdue: 5, level: 'owner' as const }],
    }
    expect((await deliverDigest(config, deps({ at: WEDNESDAY, digestInput: followUp }))).outcome).toBe('sent')
  })

  it('selhání tokenu i odeslání: zapíše chybu graph_send a vyhodí', async () => {
    const t = deps({ getToken: vi.fn(async () => ({ ok: false as const, status: 401, message: 'Token 401 invalid_client AADSTS7000215' })) })
    await expect(deliverDigest(config, t)).rejects.toThrow('invalid_client')
    expect(t.recordError).toHaveBeenCalledWith('Token 401 invalid_client AADSTS7000215')
    expect(t.sendMail).not.toHaveBeenCalled()

    const s = deps({ sendMail: vi.fn(async () => ({ ok: false as const, status: 403, message: 'Graph 403 ErrorAccessDenied' })) })
    await expect(deliverDigest(config, s)).rejects.toThrow('ErrorAccessDenied')
    expect(s.recordError).toHaveBeenCalledWith('Graph 403 ErrorAccessDenied')
    expect(s.recordSuccess).not.toHaveBeenCalled()
    // neodešlo → marker pryč, další běh to zkusí znovu
    expect(t.releaseSendMarker).toHaveBeenCalledWith('2026-09-28', 'weekly')
    expect(s.releaseSendMarker).toHaveBeenCalledWith('2026-09-28', 'weekly')
  })
})

describe('pondělí a pátek: provozní přehled', () => {
  it('přehled týdne pošle provozní přehled — stejní příjemci, stejné odeslání, stats nesou formát bez adres', async () => {
    const report = opsReport()
    const di = nonEmpty()
    const d = deps({ loadDigest: vi.fn(async () => ({ digest: buildDigest(di), source: di, report })) })
    const stats = await deliverDigest(config, d)
    expect(stats).toMatchObject({ kind: 'weekly', outcome: 'sent', recipients: 2, items: opsReportItemCount(report), format: 'provozni_prehled' })
    expect(JSON.stringify(stats)).not.toContain('@')
    expect(d.sendMail).toHaveBeenCalledTimes(1)
    const [, mail] = vi.mocked(d.sendMail).mock.calls[0] as unknown as [string, { subject: string; html: string; to: string[] }]
    expect(mail.to).toEqual(config.recipients)
    expect(mail.subject).toBe('Přehled týdne pondělí 28. 9. 2026: 22 položek (Riziko: 6, Ke schválení: 2, Čeká na nás: 3, Čeká na klienta: 1, Neověřené: 7, Obchody: 3)')
    for (const t of ['Dodávky podle milníků', 'Čeká na klienta', 'Ke schválení', 'Riziko termínů a kapacity', 'Neověřené položky', 'Stav zdrojů']) {
      expect(mail.html).toContain(t)
    }
    expect(mail.html).toContain('https://cockpit.example.cz/cockpit/prehled-tydne?tyden=minuly')
    // dosavadní obsah (blokovaný obchod) se nepošle zvlášť jako druhý e-mail
    expect(d.claimSendMarker).toHaveBeenCalledWith('2026-09-28', 'weekly')
  })

  it('provozní přehled se nepodařilo složit → odejde dosavadní přehled týdne (pondělí nezůstane bez e-mailu)', async () => {
    const di = nonEmpty()
    const d = deps({ loadDigest: vi.fn(async () => ({ digest: buildDigest(di), source: di, report: null })) })
    const stats = await deliverDigest(config, d)
    expect(stats).toEqual({ kind: 'weekly', prague_day: '2026-09-28', outcome: 'sent', sent_day: '2026-09-28', recipients: 2, dropped_recipients: 0, items: 1, source_alerts: 1 })
    const [, mail] = vi.mocked(d.sendMail).mock.calls[0] as unknown as [string, { subject: string; html: string }]
    expect(mail.subject).toBe('Přehled týdne pondělí 28. 9. 2026: 1 položka (Blokované obchody: 1)')
    expect(mail.html).toContain('https://cockpit.example.cz/cockpit/clients/3/deals/7')
  })

  it('ranní souhrn provozní přehled nepoužije, ani kdyby ho loader vrátil', async () => {
    const di = { ...healthyInput(WEDNESDAY), blockedDeals: nonEmpty().blockedDeals }
    const d = deps({ at: WEDNESDAY, loadDigest: vi.fn(async () => ({ digest: buildDigest(di), source: di, report: opsReport() })) })
    const stats = await deliverDigest(config, d)
    expect(stats).toMatchObject({ kind: 'daily', outcome: 'sent', items: 1 })
    expect(stats).not.toHaveProperty('format')
    const [, mail] = vi.mocked(d.sendMail).mock.calls[0] as unknown as [string, { subject: string }]
    expect(mail.subject).toBe('Ranní souhrn středa 30. 9. 2026: 1 položka (Blokované obchody: 1)')
  })

  it('selhání odeslání provozního přehledu: chyba graph_send, marker se uvolní', async () => {
    const di = nonEmpty()
    const d = deps({
      loadDigest: vi.fn(async () => ({ digest: buildDigest(di), source: di, report: opsReport() })),
      sendMail: vi.fn(async () => ({ ok: false as const, status: 500, message: 'Graph 500 x' })),
    })
    await expect(deliverDigest(config, d)).rejects.toThrow('Graph 500 x')
    expect(d.recordError).toHaveBeenCalledWith('Graph 500 x')
    expect(d.releaseSendMarker).toHaveBeenCalledWith('2026-09-28', 'weekly')
  })
})

describe('Graph send konektor (fake fetch)', () => {
  const creds = { tenantId: 'mummiesdaddies.com', clientId: 'client-id', clientSecret: SECRET }

  it('token: client credentials na správný endpoint s .default scope', async () => {
    let url = ''
    let init: RequestInit | undefined
    const f: SendFetch = async (u, i) => { url = u; init = i; return res(200, { access_token: TOKEN, expires_in: 3599, token_type: 'Bearer' }) }
    const r = await getAppOnlyToken(creds, f)
    expect(r).toEqual({ ok: true, accessToken: TOKEN, expiresInSeconds: 3599 })
    expect(url).toBe('https://login.microsoftonline.com/mummiesdaddies.com/oauth2/v2.0/token')
    const body = new URLSearchParams(String(init!.body))
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('scope')).toBe('https://graph.microsoft.com/.default')
    expect(body.get('client_secret')).toBe(SECRET)
  })

  it('token chyba nenese secret ani error_description', async () => {
    const f: SendFetch = async () => res(401, {
      error: 'invalid_client',
      error_description: `AADSTS7000215: Invalid client secret provided ${SECRET}`,
      error_codes: [7000215],
    })
    const r = await getAppOnlyToken(creds, f)
    expect(r).toEqual({ ok: false, status: 401, message: 'Token 401 invalid_client AADSTS7000215' })
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('neplatný tenant nevolá síť', async () => {
    const f = vi.fn<SendFetch>()
    expect((await getAppOnlyToken({ ...creds, tenantId: 'evil.com/../x' }, f)).ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it('sendMail: POST /users/{upn}/sendMail, HTML tělo, 202 = ok', async () => {
    let url = ''
    let init: RequestInit | undefined
    const f: SendFetch = async (u, i) => { url = u; init = i; return res(202) }
    const r = await sendMailAsUser(TOKEN, 'cockpit@mummiesdaddies.com', { subject: 'S', html: '<p>x</p>', to: ['a@mummiesdaddies.com'] }, f)
    expect(r).toEqual({ ok: true })
    expect(url).toBe(sendMailUrl('cockpit@mummiesdaddies.com'))
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/cockpit%40mummiesdaddies.com/sendMail')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(init!.body))).toEqual({
      message: { subject: 'S', body: { contentType: 'HTML', content: '<p>x</p>' }, toRecipients: [{ emailAddress: { address: 'a@mummiesdaddies.com' } }] },
      saveToSentItems: true,
    })
  })

  it('sendMail chyba nese jen status a kód; 200 místo 202 není úspěch', async () => {
    const r = await sendMailAsUser(TOKEN, 'cockpit@mummiesdaddies.com', { subject: 'S', html: 'x', to: ['a@mummiesdaddies.com'] },
      async () => res(403, { error: { code: 'ErrorAccessDenied', message: `Access denied ${TOKEN}` } }))
    expect(r).toEqual({ ok: false, status: 403, message: 'Graph 403 ErrorAccessDenied' })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect((await sendMailAsUser(TOKEN, 's@x.cz', { subject: 'S', html: 'x', to: ['a@x.cz'] }, async () => res(200, {}))).ok).toBe(false)
    expect((await sendMailAsUser(TOKEN, 's@x.cz', { subject: 'S', html: 'x', to: [] }, async () => res(202))).ok).toBe(false)
  })
})

describe('delegovaný token odesílatele (getDelegatedSendToken)', () => {
  const NOW = Date.parse('2026-09-28T05:00:00Z')
  const OLD_ACCESS = 'eyJ.old-access.sig'
  const OLD_REFRESH = 'old-refresh-token-VALUE'
  const NEW_ACCESS = 'eyJ.new-access.sig'
  const NEW_REFRESH = 'rotated-refresh-token-VALUE'

  function tokenDeps(over: Partial<DelegatedTokenDeps> & { expiresAt?: string } = {}) {
    const { expiresAt = '2026-09-28T04:00:00Z', ...rest } = over
    return {
      load: vi.fn(async () => ({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH, expires_at: expiresAt })),
      refresh: vi.fn(async (rt: string) => { void rt; return { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600 } }),
      save: vi.fn(async (t: { access_token: string; refresh_token: string; expires_at: string }) => { void t; return true }),
      now: () => NOW,
      ...rest,
    }
  }

  it('platný token (víc než 60 s do expirace) se použije bez obnovy', async () => {
    const d = tokenDeps({ expiresAt: '2026-09-28T05:30:00Z' })
    expect(await getDelegatedSendToken(d)).toEqual({ ok: true, accessToken: OLD_ACCESS })
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.save).not.toHaveBeenCalled()
  })

  it('prošlý token: obnoví a ULOŽÍ rotovaný refresh token, pak vrátí nový access token', async () => {
    const d = tokenDeps()
    expect(await getDelegatedSendToken(d)).toEqual({ ok: true, accessToken: NEW_ACCESS })
    expect(d.refresh).toHaveBeenCalledWith(OLD_REFRESH)
    expect(d.save).toHaveBeenCalledWith({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_at: '2026-09-28T06:00:00.000Z' })
  })

  it('token těsně před expirací (< 60 s) se obnoví', async () => {
    const d = tokenDeps({ expiresAt: '2026-09-28T05:00:30Z' })
    expect(await getDelegatedSendToken(d)).toEqual({ ok: true, accessToken: NEW_ACCESS })
    expect(d.refresh).toHaveBeenCalledTimes(1)
  })

  it('uložení obnoveného tokenu selže (false i výjimka) → fail closed, bez tokenu', async () => {
    for (const save of [vi.fn(async () => false), vi.fn(async () => { throw new Error('rpc down') })]) {
      const r = await getDelegatedSendToken(tokenDeps({ save }))
      expect(r).toEqual({ ok: false, status: 0, message: SENDER_TOKEN_SAVE_ERROR })
      expect(JSON.stringify(r)).not.toContain(NEW_ACCESS)
    }
  })

  it('obnova selže → srozumitelná chyba s pokynem znovu připojit', async () => {
    const r = await getDelegatedSendToken(tokenDeps({ refresh: vi.fn(async () => null) }))
    expect(r).toEqual({ ok: false, status: 0, message: SENDER_REFRESH_FAILED_ERROR })
  })

  it('bez uloženého tokenu → není připojený; chyba načtení → její (očištěná) zpráva', async () => {
    expect(await getDelegatedSendToken(tokenDeps({ load: vi.fn(async () => null) })))
      .toEqual({ ok: false, status: 0, message: SENDER_NOT_CONNECTED_ERROR })
    expect(await getDelegatedSendToken(tokenDeps({ load: vi.fn(async () => ({ access_token: 'a', refresh_token: null, expires_at: null })) })))
      .toEqual({ ok: false, status: 0, message: SENDER_NOT_CONNECTED_ERROR })
    expect(await getDelegatedSendToken(tokenDeps({ load: vi.fn(async () => { throw new Error('Chybí migrace 0041 (calendar_token_get_for_service) — přehled se neposlal.') }) })))
      .toMatchObject({ ok: false, message: expect.stringContaining('0041') })
  })

  it('deliverDigest s delegovaným tokenem: save selže → nic se neposílá, chyba graph_send, marker pryč', async () => {
    const td = tokenDeps({ save: vi.fn(async () => false) })
    const d = deps({ getToken: () => getDelegatedSendToken(td) })
    await expect(deliverDigest(config, d)).rejects.toThrow(SENDER_TOKEN_SAVE_ERROR)
    expect(d.sendMail).not.toHaveBeenCalled()
    expect(d.recordError).toHaveBeenCalledWith(SENDER_TOKEN_SAVE_ERROR)
    expect(d.releaseSendMarker).toHaveBeenCalledWith('2026-09-28', 'weekly')
  })

  it('403 z /me/sendMail = chybí Mail.Send → srozumitelná chyba graph_send', async () => {
    expect(explainDelegatedSendResult({ ok: false, status: 403, message: 'Graph 403 ErrorAccessDenied' }))
      .toEqual({ ok: false, status: 403, message: MISSING_MAIL_SEND_ERROR })
    expect(explainDelegatedSendResult({ ok: false, status: 500, message: 'Graph 500 x' }))
      .toEqual({ ok: false, status: 500, message: 'Graph 500 x' })
    expect(explainDelegatedSendResult({ ok: true })).toEqual({ ok: true })

    const d = deps({ sendMail: vi.fn(async () => explainDelegatedSendResult({ ok: false, status: 403, message: 'Graph 403 ErrorAccessDenied' })) })
    await expect(deliverDigest(config, d)).rejects.toThrow(MISSING_MAIL_SEND_ERROR)
    expect(d.recordError).toHaveBeenCalledWith('Chybí oprávnění Mail.Send — znovu připojte Outlook v Nastavení')
  })
})

describe('sendMailAsMe (delegovaně, fake fetch)', () => {
  it('POST /me/sendMail se stejným tělem jako app-only, 202 = ok', async () => {
    let url = ''
    let init: RequestInit | undefined
    const f: SendFetch = async (u, i) => { url = u; init = i; return res(202) }
    const r = await sendMailAsMe(TOKEN, { subject: 'S', html: '<p>x</p>', to: ['viktor@mummiesdaddies.com', 'lenka@mummiesdaddies.com'] }, f)
    expect(r).toEqual({ ok: true })
    expect(url).toBe(SEND_MAIL_AS_ME_URL)
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(init!.body))).toEqual({
      message: {
        subject: 'S',
        body: { contentType: 'HTML', content: '<p>x</p>' },
        toRecipients: [{ emailAddress: { address: 'viktor@mummiesdaddies.com' } }, { emailAddress: { address: 'lenka@mummiesdaddies.com' } }],
      },
      saveToSentItems: true,
    })
  })

  it('chyba nese jen status a kód, nikdy token ani text odpovědi; síťová chyba i bez příjemců = neúspěch', async () => {
    const r = await sendMailAsMe(TOKEN, { subject: 'S', html: 'x', to: ['a@mummiesdaddies.com'] },
      async () => res(403, { error: { code: 'ErrorAccessDenied', message: `Access is denied ${TOKEN}` } }))
    expect(r).toEqual({ ok: false, status: 403, message: 'Graph 403 ErrorAccessDenied' })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(await sendMailAsMe(TOKEN, { subject: 'S', html: 'x', to: ['a@mummiesdaddies.com'] }, async () => { throw new Error(`boom ${TOKEN}`) }))
      .toEqual({ ok: false, status: 0, message: 'Graph nedostupný' })
    const f = vi.fn<SendFetch>()
    expect((await sendMailAsMe(TOKEN, { subject: 'S', html: 'x', to: [] }, f)).ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
})
