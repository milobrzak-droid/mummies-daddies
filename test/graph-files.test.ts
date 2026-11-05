import { describe, expect, it } from 'vitest'
import {
  DRIVE_ITEM_SELECT,
  driveItemUrl,
  encodeSharingUrl,
  getDriveItemLatestVersion,
  getDriveItemMetadata,
  getSharedDriveItemMetadata,
  sharedDriveItemUrl,
} from '@/connectors/graph'

// connectors/graph/files.ts — GET /shares/{u!…}/driveItem, jen metadata.
// Graph je mockovaný (fetchImpl), nic nejde do sítě.

const G = 'https://graph.microsoft.com/v1.0'

function res(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('encodeSharingUrl (learn.microsoft.com/graph/api/shares-get, „Encoding sharing URLs")', () => {
  it('příklad z dokumentace: base64 → bez „=" → u! prefix', () => {
    expect(encodeSharingUrl('https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1'))
      .toBe('u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx')
  })

  it('base64url: „+" → „-", „/" → „_", padding pryč', () => {
    // base64 obsahuje + i / (→ - a _)
    expect(encodeSharingUrl('https://mummiesdaddies.sharepoint.com/?a=~~~>>>??'))
      .toBe('u!aHR0cHM6Ly9tdW1taWVzZGFkZGllcy5zaGFyZXBvaW50LmNvbS8_YT1-fn4-Pj4_Pw')
    // base64 s „+" a „/" uprostřed
    expect(encodeSharingUrl('https://mummiesdaddies.sharepoint.com/:w:/s/Projekt/EabC?e=x>~'))
      .toBe('u!aHR0cHM6Ly9tdW1taWVzZGFkZGllcy5zaGFyZXBvaW50LmNvbS86dzovcy9Qcm9qZWt0L0VhYkM_ZT14Pn4')
  })

  it('UTF-8 znaky (diakritika) se kódují z UTF-8 bajtů', () => {
    expect(encodeSharingUrl('https://mummiesdaddies.sharepoint.com/sites/P/Sdílené dokumenty/Nabídka.docx'))
      .toBe('u!aHR0cHM6Ly9tdW1taWVzZGFkZGllcy5zaGFyZXBvaW50LmNvbS9zaXRlcy9QL1Nkw61sZW7DqSBkb2t1bWVudHkvTmFiw61ka2EuZG9jeA')
  })

  it('výsledek je bezpečný v cestě URL', () => {
    expect(encodeSharingUrl('https://x/?a=~~~>>>??&b=ÿÿ')).toMatch(/^u![A-Za-z0-9_-]+$/)
  })
})

describe('getSharedDriveItemMetadata', () => {
  const LINK = 'https://mummiesdaddies.sharepoint.com/:w:/s/Projekt/EabC'

  it('volá jen …/driveItem s $select na metadata — nikdy obsah', async () => {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    await getSharedDriveItemMetadata('TOK', LINK, async (u, init) => {
      seenUrl = u
      seenInit = init
      return res(200, { name: 'a.docx', webUrl: 'https://mummiesdaddies.sharepoint.com/a.docx' })
    })
    expect(seenUrl).toBe(`${G}/shares/${encodeSharingUrl(LINK)}/driveItem?$select=${DRIVE_ITEM_SELECT.join(',')}`)
    expect(seenUrl).toBe(sharedDriveItemUrl(LINK))
    expect(seenUrl).not.toMatch(/\/content|downloadUrl|thumbnails|\$expand/i)
    expect(seenInit?.method).toBe('GET')
    expect(seenInit?.redirect).toBe('error')
    const h = seenInit!.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer TOK')
    // Žádný redeem sdílecího odkazu (měnil by oprávnění v SharePointu).
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('prefer')
  })

  it('mapuje metadata a downloadUrl z odpovědi nepřebírá', async () => {
    const r = await getSharedDriveItemMetadata('T', LINK, async () => res(200, {
      id: '01ABC',
      parentReference: { driveId: 'b!drive-1', path: '/drives/x/root:/Tajne', siteId: 'SITE' },
      eTag: '"{GUID},4"',
      cTag: '"c:{GUID},2"',
      name: 'Nabídka.docx',
      webUrl: 'https://mummiesdaddies.sharepoint.com/sites/Projekt/Shared%20Documents/Nabidka.docx',
      lastModifiedDateTime: '2026-09-27T12:30:00Z',
      lastModifiedBy: { user: { displayName: 'Jana Nováková', email: 'jana@mummiesdaddies.com' } },
      size: 109112,
      file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', hashes: {} },
      '@microsoft.graph.downloadUrl': 'https://mummiesdaddies.sharepoint.com/download?token=SECRET',
    }))
    expect(r).toEqual({
      kind: 'ok',
      item: {
        itemId: '01ABC',
        driveId: 'b!drive-1',
        eTag: '"{GUID},4"',
        cTag: '"c:{GUID},2"',
        name: 'Nabídka.docx',
        webUrl: 'https://mummiesdaddies.sharepoint.com/sites/Projekt/Shared%20Documents/Nabidka.docx',
        lastModifiedAt: '2026-09-27T12:30:00Z',
        lastModifiedBy: 'Jana Nováková',
        size: 109112,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    })
    expect(JSON.stringify(r)).not.toContain('SECRET')
    // Cesta ani id webu z parentReference se nepřebírá — jen driveId.
    expect(JSON.stringify(r)).not.toContain('Tajne')
    expect(JSON.stringify(r)).not.toContain('SITE')
  })

  it('složka / chybějící nepovinná pole → null', async () => {
    const r = await getSharedDriveItemMetadata('T', LINK, async () => res(200, {
      name: 'Projekt', webUrl: 'https://mummiesdaddies.sharepoint.com/sites/Projekt', folder: { childCount: 3 }, lastModifiedDateTime: 'nesmysl',
    }))
    expect(r).toEqual({
      kind: 'ok',
      item: {
        itemId: null, driveId: null, eTag: null, cTag: null,
        name: 'Projekt', webUrl: 'https://mummiesdaddies.sharepoint.com/sites/Projekt', lastModifiedAt: null, lastModifiedBy: null, size: null, mimeType: null,
      },
    })
  })

  it('stavové kódy → jednoznačný výsledek', async () => {
    const at = (status: number) => getSharedDriveItemMetadata('T', LINK, async () => res(status, { error: { code: 'x' } }))
    expect(await at(401)).toEqual({ kind: 'unauthorized' })
    expect(await at(403)).toEqual({ kind: 'forbidden' })
    expect(await at(404)).toEqual({ kind: 'not_found' })
    expect(await at(429)).toEqual({ kind: 'throttled' })
    expect(await at(500)).toEqual({ kind: 'error', status: 500 })
  })

  it('neplatná odpověď (bez name/webUrl, ne-JSON) → error', async () => {
    expect(await getSharedDriveItemMetadata('T', LINK, async () => res(200, { name: 'a' }))).toEqual({ kind: 'error', status: 200 })
    expect(await getSharedDriveItemMetadata('T', LINK, async () => new Response('<html>', { status: 200 }))).toEqual({ kind: 'error', status: 200 })
  })

  it('výjimka při fetch (timeout, síť) → error, ne pád', async () => {
    const r = await getSharedDriveItemMetadata('T', LINK, async () => { throw new Error('timeout') })
    expect(r).toEqual({ kind: 'error', status: 0 })
  })

  it('ne-https odkaz do Graphu vůbec nepošle', async () => {
    let called = false
    const r = await getSharedDriveItemMetadata('T', 'http://mummiesdaddies.sharepoint.com/a', async () => { called = true; return res(200, {}) })
    expect(r.kind).toBe('error')
    expect(called).toBe(false)
  })
})

describe('getDriveItemMetadata (uložená identita)', () => {
  it('volá /drives/{driveId}/items/{itemId} jen s $select na metadata', async () => {
    let seenUrl = ''
    await getDriveItemMetadata('TOK', 'b!drive-1', '01ABC', async (u) => {
      seenUrl = u
      return res(200, { id: '01ABC', name: 'a.docx', webUrl: 'https://mummiesdaddies.sharepoint.com/a.docx', cTag: 'c1', eTag: 'e1' })
    })
    expect(seenUrl).toBe(driveItemUrl('b!drive-1', '01ABC'))
    expect(seenUrl).toBe(`${G}/drives/b!drive-1/items/01ABC?$select=${DRIVE_ITEM_SELECT.join(',')}`)
    expect(seenUrl).not.toMatch(/\/content|downloadUrl|thumbnails|\$expand/i)
  })

  it('id se do cesty kóduje a neplatné id do Graphu vůbec nejde', async () => {
    let called = false
    const f = async () => { called = true; return res(200, {}) }
    expect(await getDriveItemMetadata('T', 'b!x/../../me', '01ABC', f)).toEqual({ kind: 'error', status: 0 })
    expect(await getDriveItemMetadata('T', 'b!x', '01ABC?$expand=children', f)).toEqual({ kind: 'error', status: 0 })
    expect(called).toBe(false)
  })

  it('404 i 410 = zmizel, 403 = bez přístupu, 401, 429 a chyba jsou rozlišené', async () => {
    const at = (status: number) => getDriveItemMetadata('T', 'b!d', 'I1', async () => res(status, {}))
    expect(await at(404)).toEqual({ kind: 'not_found' })
    expect(await at(410)).toEqual({ kind: 'not_found' })
    expect(await at(403)).toEqual({ kind: 'forbidden' })
    expect(await at(401)).toEqual({ kind: 'unauthorized' })
    expect(await at(429)).toEqual({ kind: 'throttled' })
    expect(await at(503)).toEqual({ kind: 'error', status: 503 })
  })
})

describe('getDriveItemLatestVersion', () => {
  const versions = (value: unknown[]) => async () => res(200, { value })

  it('vybere nejvyšší verzi podle čísla, ne podle pořadí', async () => {
    const v = await getDriveItemLatestVersion('T', 'b!d', 'I1', versions([
      { id: '2.0', lastModifiedDateTime: '2026-09-01T10:00:00Z', lastModifiedBy: { user: { displayName: 'Petr' } } },
      { id: '10.0', lastModifiedDateTime: '2026-09-27T12:30:00Z', lastModifiedBy: { user: { displayName: 'Jana Nováková' } } },
      { id: '9.0', lastModifiedDateTime: '2026-09-20T10:00:00Z' },
      { id: 'current' },
    ]))
    expect(v).toEqual({ label: '10.0', modifiedAt: '2026-09-27T12:30:00Z', modifiedBy: 'Jana Nováková' })
  })

  it('volá jen …/versions, bez obsahu', async () => {
    let seenUrl = ''
    await getDriveItemLatestVersion('T', 'b!d', 'I1', async (u) => { seenUrl = u; return res(200, { value: [] }) })
    expect(seenUrl).toBe(`${G}/drives/b!d/items/I1/versions`)
  })

  it('chyba, prázdný seznam, ne-JSON a výjimka = null (číslo verze je jen doplněk)', async () => {
    expect(await getDriveItemLatestVersion('T', 'b!d', 'I1', async () => res(403, {}))).toBeNull()
    expect(await getDriveItemLatestVersion('T', 'b!d', 'I1', versions([]))).toBeNull()
    expect(await getDriveItemLatestVersion('T', 'b!d', 'I1', versions([{ id: 'current' }]))).toBeNull()
    expect(await getDriveItemLatestVersion('T', 'b!d', 'I1', async () => new Response('<html>', { status: 200 }))).toBeNull()
    expect(await getDriveItemLatestVersion('T', 'b!d', 'I1', async () => { throw new Error('x') })).toBeNull()
    expect(await getDriveItemLatestVersion('T', 'b!d/..', 'I1', versions([{ id: '1.0' }]))).toBeNull()
  })
})
