import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

// Action ID je globální: action jde spustit POSTem na libovolnou stránku,
// včetně /auth/*, kde proxy pouští AAL1, a /login, kde pouští i nepřihlášené.
// Proto si KAŽDÁ action — exportovaná z 'use server' modulu i inline
// closure s direktivou 'use server' v komponentě — musí sama ověřit
// uživatele s AAL2. Výjimky jsou jen přihlášení, odhlášení a MFA.
const ALLOWLIST = new Set([
  'app/login/actions.ts#signIn',
  'app/login/actions.ts#signOut',
])
// MFA actions musí aspoň ověřit přihlášení (bez aal2).
const MFA_ACTIONS = new Set(['lib/actions/mfa.ts#verifyFactor'])

const ROOT = join(__dirname, '..')
// Prochází se jen kořeny s aplikačním kódem. Přeskakuje se podle CELÉ
// relativní cesty, ne podle jména adresáře — vnořené lib/supabase/,
// …/public/ nebo …/test/ se tak neztratí.
const ROOTS = ['app', 'lib', 'domain', 'core', 'components', 'connectors', 'config']
const SKIP_PATHS = new Set(['node_modules', '.next', '.git', '.claude'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = relative(ROOT, p).split('\\').join('/')
    if (SKIP_PATHS.has(rel) || name === 'node_modules') continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

// Odstraní komentáře (hrubě: // do konce řádku mimo URL, /* … */), aby guard
// v komentáři nepřešel jako skutečné volání.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

function isUseServerModule(src: string): boolean {
  const code = src.replace(/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*/, '')
  return /^['"]use server['"]/.test(code)
}

// Text od `{` na pozici open po odpovídající `}` (hrubé párování závorek).
function braceBlock(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

// Začátek těla funkce: první `{` na konci řádku (návratový typ jako
// `Promise<{ ok: boolean }>` tělo není).
function bodyOpen(src: string, from: number): number {
  const m = /\{[ \t]*\r?\n/.exec(src.slice(from))
  return m ? from + m.index : src.indexOf('{', from)
}

// [název, tělo] pro každou `export async function`.
function exportedActions(src: string): [string, string][] {
  const re = /^export\s+(?:default\s+)?async\s+function\s+(\w+)/gm
  return [...src.matchAll(re)].map((m) => [m[1], braceBlock(src, bodyOpen(src, m.index!))])
}

// Doslovná AAL2 brána. Nestačí jakékoli „aal2: true" v textu.
// Volitelně s `allowExternal: true` (0082): správa vlastního účtu (heslo, jméno)
// smí i Partner; AAL2 se tím nevypíná.
const AAL2_LITERAL = /\b(?:requireUser|tryRequireUser)\s*\(\s*\{\s*aal2:\s*true\s*(?:,\s*allowExternal:\s*true\s*)?\}\s*\)/

// Lokální helpery (requireAdmin, salesGate…), jejichž tělo AAL2 bránu
// doslovně obsahuje. Volání takového helperu se počítá jako brána.
function localGuards(src: string): Set<string> {
  const names = new Set<string>()
  for (const m of src.matchAll(/(?:async\s+)?function\s+(\w+)/g)) {
    const body = braceBlock(src, bodyOpen(src, m.index!))
    if (AAL2_LITERAL.test(body)) names.add(m[1])
  }
  return names
}

function callsAny(body: string, names: Iterable<string>): boolean {
  for (const n of names) if (new RegExp(`\\b${n}\\s*\\(`).test(body)) return true
  return false
}

const files = ROOTS.filter((r) => existsSync(join(ROOT, r))).flatMap((r) => walk(join(ROOT, r)))
const sources = new Map(files.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]))
const modules = files.filter((f) => isUseServerModule(readFileSync(f, 'utf8')))

// Exportované actions, které projdou bránou — inline closures na ně smí delegovat.
const guardedExports = new Set<string>()
for (const f of modules) {
  const src = sources.get(f)!
  const guards = localGuards(src)
  for (const [name, body] of exportedActions(src)) {
    if (AAL2_LITERAL.test(body) || callsAny(body, guards)) guardedExports.add(name)
  }
}

describe('každá Server Action má auth guard', () => {
  test('nalezeny use-server moduly', () => {
    expect(modules.length).toBeGreaterThan(10)
  })

  test('prochází i vnořené lib/supabase', () => {
    expect(files.some((f) => relative(ROOT, f).split('\\').join('/').startsWith('lib/supabase/'))).toBe(true)
  })

  test('žádný use-server modul neexportuje nic jiného než async funkce', () => {
    const bad: string[] = []
    for (const f of modules) {
      const src = sources.get(f)!
      for (const m of src.matchAll(/^export\s+(?!async\s+function|type\s|interface\s)(\S+)/gm)) {
        bad.push(`${relative(ROOT, f)}: export ${m[1]}`)
      }
    }
    expect(bad).toEqual([])
  })

  for (const f of modules) {
    const rel = relative(ROOT, f).split('\\').join('/')
    const src = sources.get(f)!
    const guards = localGuards(src)
    for (const [name, body] of exportedActions(src)) {
      const key = `${rel}#${name}`
      if (ALLOWLIST.has(key)) continue
      test(key, () => {
        const firstStatements = body.split('\n').slice(0, 12).join('\n')
        expect(
          /\b(requireUser|tryRequireUser)\s*\(/.test(firstStatements) || callsAny(firstStatements, guards),
          `${key} musí hned na začátku volat requireUser/tryRequireUser/lokální bránu`,
        ).toBe(true)
        if (!MFA_ACTIONS.has(key)) {
          expect(
            AAL2_LITERAL.test(body) || callsAny(body, guards),
            `${key} musí vyžadovat AAL2 (requireUser({ aal2: true }) nebo helper, který ho volá)`,
          ).toBe(true)
        }
      })
    }
  }

  // Inline 'use server' closures v komponentách a stránkách.
  const inline: { key: string; body: string; src: string }[] = []
  for (const f of files) {
    const src = sources.get(f)!
    const rel = relative(ROOT, f).split('\\').join('/')
    const moduleLevel = isUseServerModule(readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/['"]use server['"]/g)) {
      if (moduleLevel && src.slice(0, m.index!).trim() === '') continue
      const open = src.lastIndexOf('{', m.index!)
      const line = src.slice(0, m.index!).split('\n').length
      inline.push({ key: `${rel}:${line}`, body: braceBlock(src, open), src })
    }
  }

  test('inline closures nalezeny (detektor funguje)', () => {
    expect(inline.length).toBeGreaterThan(0)
  })

  for (const { key, body, src } of inline) {
    test(`inline ${key}`, () => {
      const own = AAL2_LITERAL.test(body) || callsAny(body, localGuards(src))
      if (own) return
      // Bez vlastní brány smí jen delegovat na chráněnou exportovanou action
      // a nesmí sahat na databázi ani service role.
      expect(callsAny(body, guardedExports), `${key} nevolá žádnou chráněnou action`).toBe(true)
      expect(body, `${key} sahá na DB bez vlastní brány`).not.toMatch(/createAdminClient|createClient|\.from\s*\(|\.rpc\s*\(/)
    })
  }
})
