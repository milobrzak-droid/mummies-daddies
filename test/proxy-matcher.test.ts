// Matcher v proxy.ts rozhoduje, co projde branou přihlášení. Statické soubory
// z public/ (logo na přihlašovací stránce) musí projít bez přihlášení; stránky
// a API cesty nikdy nesmí z brány vypadnout, ani když končí příponou obrázku.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { config } from '@/proxy'

// Next převádí matcher na regulární výraz nad celou cestou; pro test stačí
// zakotvit tentýž výraz (je psaný jako skupina s negativním lookaheadem).
const [pattern] = config.matcher
const gated = (path: string): boolean => new RegExp(`^${pattern}$`).test(path)

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    const url = `${prefix}/${name}`
    return statSync(full).isDirectory() ? filesUnder(full, url) : [url]
  })
}

describe('proxy matcher: statické soubory bez brány', () => {
  test('každý soubor z public/ je mimo bránu (nový adresář nebo přípona v public/ = doplnit matcher)', () => {
    const files = filesUnder('public')
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(gated(f), f).toBe(false)
  })

  test('logo přihlašovací stránky a další kořenové obrázky', () => {
    for (const p of ['/logo.svg', '/logo-white.svg', '/symbol.svg', '/favicon.ico', '/a.png', '/a.jpg', '/a.jpeg', '/a.gif', '/a.webp', '/a.avif']) {
      expect(gated(p), p).toBe(false)
    }
  })

  test('Next interní soubory a písma zůstávají mimo bránu', () => {
    for (const p of ['/_next/static/chunks/app.js', '/_next/image', '/fonts/FiraMono-Medium.ttf']) expect(gated(p), p).toBe(false)
  })
})

describe('proxy matcher: stránky a API zůstávají za bránou', () => {
  test('stránky a API cesty', () => {
    for (const p of ['/', '/login', '/cockpit/clients', '/cockpit/clients/7', '/cockpit/tasks', '/api/v1/deals', '/api/mcp', '/api/cron/follow-ups', '/api/ingest/meeting-notes', '/auth/mfa/enroll', '/.well-known/oauth-authorization-server']) {
      expect(gated(p), p).toBe(true)
    }
  })

  test('přípona obrázku nestačí: vnořená cesta, API cesta a doplněná cesta se posuzují jako dřív', () => {
    for (const p of ['/api/v1/export.svg', '/api/x.png', '/cockpit/clients/logo.png', '/cockpit/clients/7/foto.jpg', '/logo.svg/extra', '/logo.svg.map', '/login.svg/x', '/svg', '/enter-logo.svgx']) {
      expect(gated(p), p).toBe(true)
    }
  })

  test('jiné přípony než obrázky (skripty, data) brána drží', () => {
    for (const p of ['/x.js', '/x.json', '/x.html', '/x.txt', '/robots.txt', '/secret.env']) expect(gated(p), p).toBe(true)
  })
})
