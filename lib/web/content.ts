/**
 * Texty webu: typovaný přístup k hotovým českým textům (lib/web/data/copy.json),
 * strategii (strategy.json) a ověřeným faktům (facts.json).
 *
 * Pravidla:
 * - Texty používej DOSLOVA. Zástupce „[DOPLNÍ KLIENT: …]“ nech v textu
 *   a vykresli přes <PlaceholderText> (components/web), který je zviditelní.
 * - Modul importuje celý copy.json (~95 kB) → volej ho ze serverových komponent
 *   (stránky, layouty) a klientským komponentám předávej jen hotové řetězce.
 * - Data jsou kopie /home/user/md-site/content.json (klíče copy, strategy, audit),
 *   aplikace na cestu mimo repozitář nezávisí.
 */
import type { Metadata } from 'next'
import copyData from './data/copy.json'
import strategyData from './data/strategy.json'
import factsData from './data/facts.json'
import { COMPANY } from './company'
import { stripPlaceholders } from './placeholders'

// ── typy ────────────────────────────────────────────────────────────────────

export interface SectionCopy {
  /** Stabilní id sekce v rámci stránky (např. "hero", "typy-akci", "faq"). */
  id: string
  heading: string
  /** Může být prázdný řetězec. */
  body: string
  /** Surové položky; rozparsuj přes parseItem(). */
  items?: string[]
  /** Surové CTA („Text → /cesta“); rozparsuj přes parseCta(). */
  cta?: string
}

export interface PageCopy {
  /** Cesta stránky, např. "/catering/svatby" nebo vzor "/blog/[slug]". */
  path: string
  metaTitle: string
  metaDescription: string
  sections: SectionCopy[]
  /** Jen u některých stránek (produkt): hlavní tlačítko. */
  cta?: string
}

export interface SitemapEntry {
  path: string
  title: string
  goal: string
  sections: string[]
  primaryCta: string
}

export interface ParsedItem {
  /** Část před „ — “ (název karty, otázka, krok), jinak null. */
  title: string | null
  /** Hlavní text (bez odkazu a bez štítku). */
  text: string
  /** Štítek před dvojtečkou („Průměr: …“, „Instagram: …“), jinak null. */
  label: string | null
  /** Cíl odkazu za „→“ (interní cesta začínající „/“), jinak null. */
  href: string | null
  /** Původní řetězec. */
  raw: string
}

export interface Cta {
  label: string
  href: string | null
}

// ── data ────────────────────────────────────────────────────────────────────

const PAGES: PageCopy[] = (copyData as { pages: PageCopy[] }).pages
const PAGE_BY_PATH = new Map(PAGES.map((p) => [p.path, p]))

const MICROCOPY = new Map<string, string[]>()
for (const line of (copyData as { microcopy: string[] }).microcopy) {
  const i = line.indexOf(': ')
  if (i < 0) continue
  const key = line.slice(0, i).trim()
  const value = line.slice(i + 2).trim()
  MICROCOPY.set(key, [...(MICROCOPY.get(key) ?? []), value])
}

// ── stránky a sekce ─────────────────────────────────────────────────────────

/** Všechny stránky s texty (38 cest včetně vzorů /blog/[slug]). */
export function allPages(): readonly PageCopy[] {
  return PAGES
}

/** Texty stránky podle cesty, nebo undefined. */
export function findPage(path: string): PageCopy | undefined {
  return PAGE_BY_PATH.get(normalizePath(path))
}

/** Texty stránky podle cesty; neznámá cesta = chyba při buildu (překlep se neschová). */
export function getPage(path: string): PageCopy {
  const page = findPage(path)
  if (!page) throw new Error(`content: stránka ${path} v copy.json není`)
  return page
}

/** Sekce stránky podle id, nebo undefined. */
export function findSection(path: string, id: string): SectionCopy | undefined {
  return findPage(path)?.sections.find((s) => s.id === id)
}

/** Sekce stránky podle id; chybějící = chyba při buildu. */
export function getSection(path: string, id: string): SectionCopy {
  const s = findSection(path, id)
  if (!s) throw new Error(`content: sekce "${id}" na stránce ${path} není`)
  return s
}

/** Sekce i s rozparsovanými položkami a CTA (pohodlné pro komponenty). */
export function getSectionParsed(path: string, id: string) {
  const s = getSection(path, id)
  return { ...s, parsedItems: (s.items ?? []).map(parseItem), parsedCta: s.cta ? parseCta(s.cta) : null }
}

function normalizePath(path: string): string {
  if (path === '/') return path
  return path.replace(/\/+$/, '')
}

// ── parsování položek a CTA ─────────────────────────────────────────────────

const ARROW = /\s*→\s*/

/**
 * Rozloží položku z copy.json:
 *   "Firemní catering — Obědy do kanceláře… Od [DOPLNÍ KLIENT] Kč/os. · od 4 osob → /catering/firemni"
 *   → { title: "Firemní catering", text: "Obědy do kanceláře… · od 4 osob", href: "/catering/firemni" }
 *   "Průměr: [DOPLNÍ KLIENT]" → { label: "Průměr", text: "[DOPLNÍ KLIENT]" }
 */
export function parseItem(raw: string): ParsedItem {
  let rest = raw.trim()
  let href: string | null = null
  const parts = rest.split(ARROW)
  if (parts.length > 1) {
    const last = parts[parts.length - 1].trim()
    if (/^\/\S*$/.test(last) || /^https?:\/\//.test(last)) {
      href = last
      rest = parts.slice(0, -1).join(' → ').trim()
    }
  }
  let title: string | null = null
  let label: string | null = null
  const dash = rest.indexOf(' — ')
  if (dash > 0) {
    title = rest.slice(0, dash).trim()
    rest = rest.slice(dash + 3).trim()
  } else {
    const m = /^([^:[\]]{1,40}):\s+(.+)$/.exec(rest)
    if (m && !/^https?$/i.test(m[1])) {
      label = m[1].trim()
      rest = m[2].trim()
    }
  }
  return { title, text: rest, label, href, raw }
}

/** "Chci nabídku do pár minut → /poptavka" → { label, href }. Bez šipky href = null. */
export function parseCta(raw: string): Cta {
  const parts = raw.split(ARROW)
  if (parts.length > 1) {
    const href = parts[parts.length - 1].trim()
    if (/^\/\S*$/.test(href) || /^https?:\/\//.test(href) || /^(tel|mailto):/.test(href)) {
      return { label: parts.slice(0, -1).join(' → ').trim(), href }
    }
  }
  return { label: raw.trim(), href: null }
}

/** Rozdělí "A · B · C" na položky. */
export function splitDots(value: string): string[] {
  return value.split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean)
}

// ── zástupci [DOPLNÍ KLIENT] (implementace v placeholders.ts, bez JSON) ──────

export { CLIENT_PLACEHOLDER, hasClientPlaceholder, splitPlaceholders, stripPlaceholders } from './placeholders'

// ── mikrotexty ──────────────────────────────────────────────────────────────

/**
 * Mikrotext podle klíče = část řádku před první dvojtečkou, např.
 *   microcopy('POPTÁVKA — pole Typ akce') → "Vyberte typ akce"
 *   microcopy('POTVRZENÍ — standard, text', { 'e-mail': 'jan@firma.cz' })
 * Proměnné {název} se nahradí; neznámé zůstanou. Neznámý klíč = chyba při buildu.
 */
export function microcopy(key: string, vars?: Record<string, string | number>): string {
  const v = MICROCOPY.get(key)
  if (!v) throw new Error(`content: mikrotext "${key}" není`)
  return vars ? interpolate(v[0], vars) : v[0]
}

/** Všechny hodnoty klíče (klíč „ASISTENT — tlačítko“ je dvakrát). */
export function microcopyAll(key: string): string[] {
  return [...(MICROCOPY.get(key) ?? [])]
}

/** Mikrotext rozdělený podle „ · “ (možnosti selectu, tlačítka). */
export function microcopyList(key: string): string[] {
  return splitDots(microcopy(key))
}

/** Seznam všech klíčů mikrotextů. */
export function microcopyKeys(): string[] {
  return [...MICROCOPY.keys()]
}

/** Nahradí {proměnná} hodnotami. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all))
}

// ── strategie a fakta ───────────────────────────────────────────────────────

export const strategy = strategyData as {
  positioning: unknown
  audiences: unknown
  sitemap: SitemapEntry[]
  homepage: string
  conversion: string
  redirects: string[]
  dropOrMerge: unknown
  openQuestionsForClient: unknown
}

/** Záznam mapy webu (cíl stránky, sekce, hlavní CTA). */
export function sitemapEntry(path: string): SitemapEntry | undefined {
  return strategy.sitemap.find((e) => e.path === path)
}

/**
 * Přesměrování ze starého webu jako páry { from, to } (jen řádky tvaru „/a → /b“).
 * Vhodné pro next.config redirects() v hlavním systému.
 */
export function legacyRedirects(): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = []
  for (const line of strategy.redirects) {
    const m = /^(\/[^\s]*)\s*(?:\([^)]*\))?\s*→\s*(\/[^\s]*)/.exec(line)
    if (m && m[1] !== m[2]) out.push({ from: m[1], to: m[2] })
  }
  return out
}

/** Ověřená fakta z auditu starého webu (menu, minima osob, kontakty…). Jen jako podklad, ne copy. */
export const facts: readonly string[] = (factsData as { facts: string[] }).facts

// ── firma ───────────────────────────────────────────────────────────────────

export { COMPANY } from './company'

// ── metadata ────────────────────────────────────────────────────────────────

/**
 * Metadata stránky z copy.json (title je už kompletní, proto `absolute`).
 *   export const metadata = pageMetadata('/catering/svatby')
 * U dynamických cest (/reference/[slug]) předej skutečnou cestu a případně override.
 */
export function pageMetadata(path: string, override: Partial<Metadata> = {}): Metadata {
  const page = getPage(path)
  const title = stripPlaceholders(page.metaTitle)
  const description = stripPlaceholders(page.metaDescription)
  const canonical = path.includes('[') ? undefined : path
  return {
    title: { absolute: title },
    description,
    alternates: canonical ? { canonical } : undefined,
    openGraph: { title, description, url: canonical, locale: 'cs_CZ', siteName: COMPANY.brand, type: 'website' },
    ...override,
  }
}
