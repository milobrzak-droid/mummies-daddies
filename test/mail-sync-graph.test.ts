import { describe, expect, it } from 'vitest'
import {
  fetchMailDeltaPage,
  isGraphLink,
  mailDeltaStartUrl,
  MAIL_DELTA_PREFER,
  parseRetryAfter,
} from '@/connectors/graph'

const G = 'https://graph.microsoft.com/v1.0'

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
}

describe('mail delta — Graph transport', () => {
  it('start URL vybírá jen metadata', () => {
    const u = mailDeltaStartUrl('inbox')
    expect(u).toBe(`${G}/me/mailFolders/inbox/messages/delta?$select=id,internetMessageId,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isDraft,webLink`)
    expect(u).not.toMatch(/subject|body/i)
  })

  it('posílá Prefer s maxpagesize a ImmutableId a vrací stránku', async () => {
    let seen: RequestInit | undefined
    const r = await fetchMailDeltaPage('TOK', mailDeltaStartUrl('sentitems'), async (_u, init) => {
      seen = init
      return res(200, { value: [{ id: '1' }], '@odata.nextLink': `${G}/next` })
    })
    const h = seen!.headers as Record<string, string>
    expect(h.Prefer).toBe(MAIL_DELTA_PREFER)
    expect(h.Prefer).toContain('odata.maxpagesize=50')
    expect(h.Prefer).toContain('IdType="ImmutableId"')
    expect(h.Authorization).toBe('Bearer TOK')
    expect(r).toEqual({ kind: 'page', messages: [{ id: '1' }], nextLink: `${G}/next`, deltaLink: null })
  })

  it('odkazy mimo Graph zahodí a na cizí URL vůbec nevolá', async () => {
    const r = await fetchMailDeltaPage('T', `${G}/x`, async () => res(200, { value: [], '@odata.deltaLink': 'https://evil.example/d' }))
    expect(r).toMatchObject({ kind: 'page', deltaLink: null })
    let called = false
    const bad = await fetchMailDeltaPage('T', 'https://evil.example/x', async () => { called = true; return res(200, {}) })
    expect(bad.kind).toBe('error')
    expect(called).toBe(false)
  })

  it('429 → throttled s Retry-After', async () => {
    expect(await fetchMailDeltaPage('T', `${G}/x`, async () => res(429, {}, { 'Retry-After': '7' })))
      .toEqual({ kind: 'throttled', retryAfterSeconds: 7 })
  })

  it('410 i syncStateNotFound → expired', async () => {
    expect(await fetchMailDeltaPage('T', `${G}/x`, async () => res(410, { error: { code: 'x' } }))).toEqual({ kind: 'expired' })
    expect(await fetchMailDeltaPage('T', `${G}/x`, async () => res(400, { error: { code: 'syncStateNotFound' } }))).toEqual({ kind: 'expired' })
  })

  it('jiná chyba nese jen status a kód, ne text Graphu', async () => {
    const r = await fetchMailDeltaPage('T', `${G}/x`, async () => res(500, { error: { code: 'generalException', message: 'detail' } }))
    expect(r).toEqual({ kind: 'error', status: 500, message: 'Graph 500 generalException' })
  })

  it('403 (token bez Mail.Read) → forbidden, ne obecná chyba', async () => {
    expect(await fetchMailDeltaPage('T', `${G}/x`, async () => res(403, { error: { code: 'ErrorAccessDenied', message: 'detail' } })))
      .toEqual({ kind: 'forbidden', code: 'ErrorAccessDenied' })
    expect(await fetchMailDeltaPage('T', `${G}/x`, async () => res(403, undefined)))
      .toEqual({ kind: 'forbidden', code: null })
  })

  it('síťová chyba → error', async () => {
    const r = await fetchMailDeltaPage('T', `${G}/x`, async () => { throw new Error('ECONNRESET') })
    expect(r).toMatchObject({ kind: 'error', status: 0 })
  })

  it('parseRetryAfter', () => {
    expect(parseRetryAfter(null)).toBe(10)
    expect(parseRetryAfter('3')).toBe(3)
    expect(parseRetryAfter('nesmysl')).toBe(10)
    expect(isGraphLink(`${G}/a`)).toBe(true)
    expect(isGraphLink('https://graph.microsoft.com.evil/a')).toBe(false)
  })
})
