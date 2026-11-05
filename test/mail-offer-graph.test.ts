// Stažení přílohy pro nabídku z e-mailu (connectors/graph/mailAttachment.ts):
// jen GET nad přílohami jedné zprávy, jen právo Mail.Read, limit velikosti,
// odpovědi 403/429/404 roztříděné bez čtení obsahu. Graph je falešný (fetch).
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { GRAPH_SCOPES, downloadMessageAttachment, listMessageAttachments, type FetchLike } from '@/connectors/graph'

const G = 'https://graph.microsoft.com/v1.0'

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, method: String(init.method), headers: (init.headers ?? {}) as Record<string, string> })
    return handler(url, init)
  }
  return { impl, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('oprávnění: stažení přílohy nechce víc než Mail.Read', () => {
  test('GRAPH_SCOPES obsahuje Mail.Read a žádné právo k zápisu do pošty', () => {
    const scopes = GRAPH_SCOPES.split(' ')
    expect(scopes).toContain('Mail.Read')
    expect(scopes).not.toContain('Mail.ReadWrite')
    expect(scopes).not.toContain('Mail.ReadBasic')
  })

  test('konektor nikdy neposílá jiné než GET a nesahá jinam než na přílohy zprávy', async () => {
    const src = readFileSync('connectors/graph/mailAttachment.ts', 'utf8').replace(/\/\/[^\n]*/g, '')
    expect(src).not.toMatch(/method:\s*'(POST|PATCH|PUT|DELETE)'/)
    const urls = [...src.matchAll(/`\$\{GRAPH_BASE\}([^`]*)`/g)].map((m) => m[1])
    expect(urls).toHaveLength(2)
    for (const u of urls) expect(u).toMatch(/^\/me\/messages\/\$\{encodeURIComponent\(messageId\)\}\/attachments/)
  })
})

describe('listMessageAttachments', () => {
  test('vrátí metadata příloh (bez obsahu), vložené a nesouborové označí', async () => {
    const f = fakeFetch(() => json({
      value: [
        { id: 'A1', name: ' nabidka.pdf ', contentType: 'Application/PDF', size: 1234, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' },
        { id: 'A2', name: 'logo.png', contentType: 'image/png', size: 10, isInline: true, '@odata.type': '#microsoft.graph.fileAttachment' },
        { id: 'A3', name: 'Fwd.eml', contentType: 'message/rfc822', size: 5, isInline: false, '@odata.type': '#microsoft.graph.itemAttachment' },
        { name: 'bez-id.pdf' },
      ],
    }))
    const r = await listMessageAttachments('tok', 'AAMk/=', f.impl)
    expect(r).toEqual({
      ok: true,
      items: [
        { id: 'A1', name: 'nabidka.pdf', contentType: 'application/pdf', size: 1234, isInline: false, isFile: true },
        { id: 'A2', name: 'logo.png', contentType: 'image/png', size: 10, isInline: true, isFile: true },
        { id: 'A3', name: 'Fwd.eml', contentType: 'message/rfc822', size: 5, isInline: false, isFile: false },
      ],
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].method).toBe('GET')
    expect(f.calls[0].url).toBe(`${G}/me/messages/AAMk%2F%3D/attachments?$select=id,name,contentType,size,isInline&$top=20`)
    expect(f.calls[0].url).not.toContain('contentBytes')
    expect(f.calls[0].headers.Authorization).toBe('Bearer tok')
  })

  test('403 = forbidden, 429 = throttled s čekáním, 404 = not_found, jiné = error', async () => {
    expect(await listMessageAttachments('t', 'm', fakeFetch(() => json({}, 403)).impl)).toEqual({ ok: false, reason: 'forbidden' })
    expect(await listMessageAttachments('t', 'm', fakeFetch(() => json({}, 429, { 'Retry-After': '7' })).impl)).toEqual({ ok: false, reason: 'throttled', retryAfterSeconds: 7 })
    expect(await listMessageAttachments('t', 'm', fakeFetch(() => json({}, 404)).impl)).toEqual({ ok: false, reason: 'not_found' })
    expect(await listMessageAttachments('t', 'm', fakeFetch(() => json({}, 500)).impl)).toEqual({ ok: false, reason: 'error' })
    expect(await listMessageAttachments('t', 'm', fakeFetch(() => { throw new Error('síť') }).impl)).toEqual({ ok: false, reason: 'error' })
  })
})

describe('downloadMessageAttachment', () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49])

  test('stáhne syrové bajty přes /$value, jen GET', async () => {
    const f = fakeFetch(() => new Response(bytes, { status: 200 }))
    const r = await downloadMessageAttachment('tok', 'M1', 'A/1', 1000, f.impl)
    expect(r).toEqual({ ok: true, bytes })
    expect(f.calls).toEqual([{ url: `${G}/me/messages/M1/attachments/A%2F1/$value`, method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }])
  })

  test('příliš velká příloha: podle Content-Length se nečte, jinak se čtení přeruší na limitu', async () => {
    const declared = await downloadMessageAttachment('t', 'm', 'a', 10, fakeFetch(() => new Response(bytes, { status: 200, headers: { 'Content-Length': '5000' } })).impl)
    expect(declared).toEqual({ ok: false, reason: 'too_large' })
    let read = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        read += 1000
        c.enqueue(new Uint8Array(1000))
        if (read >= 100_000) c.close()
      },
    })
    const streamed = await downloadMessageAttachment('t', 'm', 'a', 2500, fakeFetch(() => new Response(stream, { status: 200 })).impl)
    expect(streamed).toEqual({ ok: false, reason: 'too_large' })
    expect(read).toBeLessThan(10_000)
  })

  test('403/401 = forbidden, 429 = throttled, 404 = not_found, chyba sítě = error', async () => {
    expect(await downloadMessageAttachment('t', 'm', 'a', 10, fakeFetch(() => json({}, 403)).impl)).toEqual({ ok: false, reason: 'forbidden' })
    expect(await downloadMessageAttachment('t', 'm', 'a', 10, fakeFetch(() => json({}, 401)).impl)).toEqual({ ok: false, reason: 'forbidden' })
    expect(await downloadMessageAttachment('t', 'm', 'a', 10, fakeFetch(() => json({}, 503, { 'Retry-After': '3' })).impl)).toEqual({ ok: false, reason: 'throttled', retryAfterSeconds: 3 })
    expect(await downloadMessageAttachment('t', 'm', 'a', 10, fakeFetch(() => json({}, 404)).impl)).toEqual({ ok: false, reason: 'not_found' })
    expect(await downloadMessageAttachment('t', 'm', 'a', 10, fakeFetch(() => { throw new Error('síť') }).impl)).toEqual({ ok: false, reason: 'error' })
  })
})
