// Graph transport obsahového vstupu pošty (connectors/graph/mailContent.ts):
// jen vybraná složka, tělo jako text, přílohy jen názvem, složka se nezakládá sama.
import { describe, expect, it } from 'vitest'
import {
  CONTENT_DELTA_PREFER,
  CONTENT_DELTA_SELECT,
  contentDeltaStartUrl,
  createMailFolder,
  fetchAttachmentNames,
  fetchContentDeltaPage,
  findMailFolder,
  fetchMailDeltaPage,
  mailDeltaStartUrl,
} from '@/connectors/graph'

const G = 'https://graph.microsoft.com/v1.0'
const res = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

describe('obsahový delta dotaz', () => {
  it('čte jen zvolenou složku a vybírá předmět a tělo; tělo jako text', async () => {
    const url = contentDeltaStartUrl('AAMk/ID=')
    expect(url).toBe(`${G}/me/mailFolders/AAMk%2FID%3D/messages/delta?$select=${CONTENT_DELTA_SELECT.join(',')}`)
    expect(url).toContain('body')
    expect(url).toContain('subject')
    expect(url).not.toMatch(/inbox|sentitems/i)
    expect(CONTENT_DELTA_PREFER).toContain('outlook.body-content-type="text"')
    expect(CONTENT_DELTA_PREFER).toContain('IdType="ImmutableId"')

    let seen: RequestInit | undefined
    const r = await fetchContentDeltaPage('TOK', url, async (_u, init) => {
      seen = init
      return res(200, { value: [{ id: '1', subject: 'x' }], '@odata.deltaLink': `${G}/d` })
    })
    const h = seen!.headers as Record<string, string>
    expect(h.Prefer).toBe(CONTENT_DELTA_PREFER)
    expect(h.Authorization).toBe('Bearer TOK')
    expect(r).toEqual({ kind: 'page', messages: [{ id: '1', subject: 'x' }], nextLink: null, deltaLink: `${G}/d` })
  })

  it('chyby se vyhodnotí stejně jako u metadat; na cizí adresu nevolá', async () => {
    const u = `${G}/me/mailFolders/x/messages/delta`
    expect(await fetchContentDeltaPage('T', u, async () => res(429, {}, { 'Retry-After': '3' }))).toEqual({ kind: 'throttled', retryAfterSeconds: 3 })
    expect(await fetchContentDeltaPage('T', u, async () => res(410, {}))).toEqual({ kind: 'expired' })
    expect(await fetchContentDeltaPage('T', u, async () => res(403, { error: { code: 'ErrorAccessDenied' } }))).toEqual({ kind: 'forbidden', code: 'ErrorAccessDenied' })
    let called = false
    const bad = await fetchContentDeltaPage('T', 'https://evil.example/x', async () => { called = true; return res(200, {}) })
    expect(bad.kind).toBe('error')
    expect(called).toBe(false)
  })

  it('metadatový sync se nezměnil: pořád bez předmětu a těla', async () => {
    expect(mailDeltaStartUrl('inbox')).not.toMatch(/subject|body/i)
    const r = await fetchMailDeltaPage('T', mailDeltaStartUrl('inbox'), async () => res(200, { value: [] }))
    expect(r.kind).toBe('page')
  })
})

describe('složka podle názvu', () => {
  const folders = (list: { id: string; displayName: string }[]) => res(200, { value: list })

  it('najde mezi složkami nejvyšší úrovně bez ohledu na velikost písmen a mezery', async () => {
    const urls: string[] = []
    const r = await findMailFolder('T', ' cockpit ', async (u) => {
      urls.push(u)
      return folders([{ id: 'A', displayName: 'Inbox' }, { id: 'B', displayName: 'Cockpit' }])
    })
    expect(r).toEqual({ kind: 'found', id: 'B' })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('$select=id,displayName')
  })

  it('jinak hledá ve složce Doručená a nakonec hlásí, že chybí', async () => {
    const seq: string[] = []
    const found = await findMailFolder('T', 'Cockpit', async (u) => {
      seq.push(u)
      return u.includes('/inbox/childFolders') ? folders([{ id: 'C', displayName: 'Cockpit' }]) : folders([])
    })
    expect(found).toEqual({ kind: 'found', id: 'C' })
    expect(seq[1]).toContain('/me/mailFolders/inbox/childFolders')
    expect(await findMailFolder('T', 'Cockpit', async () => folders([]))).toEqual({ kind: 'missing' })
  })

  it('403, throttling, chyba a prázdný název', async () => {
    expect(await findMailFolder('T', 'Cockpit', async () => res(403, {}))).toEqual({ kind: 'forbidden' })
    expect(await findMailFolder('T', 'Cockpit', async () => res(429, {}, { 'Retry-After': '5' }))).toEqual({ kind: 'throttled', retryAfterSeconds: 5 })
    expect(await findMailFolder('T', 'Cockpit', async () => res(500, {}))).toEqual({ kind: 'error', message: 'Graph 500' })
    expect(await findMailFolder('T', '  ', async () => res(200, {}))).toMatchObject({ kind: 'error' })
  })

  it('založení: POST jen s názvem; s právem Mail.Read Graph vrátí 403 → forbidden', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const ok = await createMailFolder('T', 'Cockpit', async (u, init) => {
      seen = { url: u, init }
      return res(201, { id: 'NEW' })
    })
    expect(ok).toEqual({ kind: 'found', id: 'NEW' })
    expect(seen!.url).toBe(`${G}/me/mailFolders`)
    expect(seen!.init.method).toBe('POST')
    expect(JSON.parse(String(seen!.init.body))).toEqual({ displayName: 'Cockpit' })
    expect(await createMailFolder('T', 'Cockpit', async () => res(403, {}))).toEqual({ kind: 'forbidden' })
  })
})

describe('názvy příloh', () => {
  it('jen názvy: $select=name,isInline, bez vložených obrázků; obsah se nikdy nestahuje', async () => {
    let url = ''
    const r = await fetchAttachmentNames('T', 'AAMk=/1', async (u) => {
      url = u
      return res(200, { value: [{ name: 'mapa.pdf', isInline: false }, { name: 'logo.png', isInline: true }, { name: ' ', isInline: false }, { name: 'rozpocet.xlsx' }] })
    })
    expect(r).toEqual({ ok: true, names: ['mapa.pdf', 'rozpocet.xlsx'] })
    expect(url).toBe(`${G}/me/messages/AAMk%3D%2F1/attachments?$select=name,isInline&$top=20`)
    expect(url).not.toMatch(/contentBytes|\$value/)
  })

  it('chyba = bez názvů (best-effort)', async () => {
    expect(await fetchAttachmentNames('T', 'x', async () => res(500, {}))).toEqual({ ok: false })
    expect(await fetchAttachmentNames('T', 'x', async () => { throw new Error('síť') })).toEqual({ ok: false })
  })
})
