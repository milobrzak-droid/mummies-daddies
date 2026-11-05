// Statická kontrola nadpisů: každá stránka má právě jeden <h1>, a to přes
// PageHeader (nebo přímo <h1>). Čtečky obrazovky podle h1 poznají, kde jsou,
// a skok na nadpis 1. úrovně má vést na název stránky, ne na „Klienti“ z karty.
//
// Stránka může mít víc větví `return` (chyba, prázdný stav, data); počítáme
// nadpisy po úsecích mezi `return`, takže dvě alternativní hlavičky nevadí,
// dvě v jedné větvi ano.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Veřejný web (app/(web), components/web, balík P6) skládá hlavičku
// z vlastních komponent (Hero, CateringHero…); jeden h1 na stránku tam
// hlídají vykreslovací testy test/web/*.test.tsx.
const WEB_DIRS = new Set(['(web)', 'web'])

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'api' || name === 'node_modules' || WEB_DIRS.has(name)) continue
      walk(p, match, out)
    } else if (match(name)) out.push(p)
  }
  return out
}

const headingCount = (src: string) => (src.match(/<h1\b|<PageHeader\b/g) ?? []).length

// Kód bez komentářů (v komentáři může být slovo PageHeader i <h1>).
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// Stránka, která jen přesměruje a nic nevykreslí.
const isRedirectOnly = (src: string) => /\bredirect\(/.test(src) && !/<[A-Za-z]/.test(src)

const pages = walk('app', (f) => f === 'page.tsx')
const boundaries = walk('app', (f) => ['error.tsx', 'not-found.tsx', 'global-error.tsx'].includes(f))

describe('jeden h1 na stránku', () => {
  it('našel stránky', () => {
    expect(pages.length).toBeGreaterThan(30)
  })

  for (const file of pages) {
    it(file, () => {
      const src = stripComments(readFileSync(file, 'utf8'))
      if (isRedirectOnly(src)) return
      expect(headingCount(src), 'stránka nemá žádný h1 / PageHeader').toBeGreaterThanOrEqual(1)
      const branches = src.split(/\breturn\b/)
      for (const [i, chunk] of branches.entries()) {
        expect(headingCount(chunk), `víc h1 v jedné větvi (úsek ${i})`).toBeLessThanOrEqual(1)
      }
    })
  }

  for (const file of boundaries) {
    it(`${file} má právě jeden h1`, () => {
      expect(headingCount(stripComments(readFileSync(file, 'utf8')))).toBe(1)
    })
  }

  it('žádná sdílená komponenta kromě PageHeader nevykresluje h1', () => {
    const offenders = walk('components', (f) => f.endsWith('.tsx'))
      .filter((f) => !f.endsWith('PageHeader.tsx'))
      .filter((f) => /<h1\b/.test(stripComments(readFileSync(f, 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('PageHeader vykresluje právě jeden h1', () => {
    expect((readFileSync('components/PageHeader.tsx', 'utf8').match(/<h1\b/g) ?? []).length).toBe(1)
  })
})
