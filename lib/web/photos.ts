/**
 * Fotky webu: mapa „místo (slot) → /web/photos/<název>.jpg + alt“.
 *
 * Zdroj pravdy je manifest public/web/photos/manifest.json, který vytváří
 * fotografický agent. Dokud manifest (nebo konkrétní soubor) neexistuje,
 * vrací se ZÁSTUPCE ({ src: null, placeholder: true }) a <PhotoFrame> vykreslí
 * pastelovou plochu místo fotky – build ani stránka kvůli chybějící fotce nespadne.
 *
 * Modul čte soubory (node:fs) → JEN pro serverové komponenty. Klientským
 * komponentám předávej hotový objekt Photo v props.
 *
 * Podporovaný tvar manifestu (doporučený):
 *   { "version": 1, "photos": [
 *       { "slot": "home.hero", "src": "/web/photos/home-hero.jpg", "alt": "…",
 *         "width": 2048, "height": 1152, "provisional": false, "position": "70% 60%" } ] }
 * Tolerované varianty: kořen jako pole; { "slots": { "<slot>": entry | entry[] } };
 * přímo { "<slot>": entry | entry[] }; místo "src" i "file"/"path" (bez lomítka =
 * relativně k /web/photos/); místo "alt" i "altCs". Více záznamů se stejným
 * slotem = galerie (pořadí podle manifestu, případně "index"); klíč „slot.N“
 * (N od 1, např. "catering.svatby.gallery.2") = N-tá fotka galerie slotu.
 */
import fs from 'node:fs'
import path from 'node:path'
import slotsData from './data/photo-slots.json'
import altsData from './data/photo-alts.json'
import blurData from './data/photo-blur.json'

export interface Photo {
  /** Místo na webu, např. "home.hero", "catering.svatby.gallery". */
  slot: string
  /** Cesta v /public (např. "/web/photos/home-hero.jpg"), nebo null = zástupce. */
  src: string | null
  /** Alternativní text (česky). U zástupce popis, co na místě bude. */
  alt: string
  width?: number
  height?: number
  /** true = fotka zatím chybí, vykreslí se pastelový zástupce. */
  placeholder: boolean
  /** true = provizorní fotka (amatérská / ke kontrole), na webu ji jde označit. */
  provisional: boolean
  /** CSS object-position (ohnisko ořezu), např. "70% 60%". */
  position?: string
  /** Doporučený ořez z výběru fotek (informativní). */
  crop?: string
  /** Malý rozmazaný náhled (data URL) pro placeholder="blur" (scripts/web/photo-blur.mjs). */
  blur?: string
}

const BLUR: Record<string, string> = blurData as Record<string, string>

interface PickSlot {
  slot: string
  file: string
  crop: string
  note: string
  provisional: boolean
  original: string
}

interface ManifestEntry {
  slot: string
  src: string
  alt?: string
  width?: number
  height?: number
  provisional?: boolean
  position?: string
  index?: number
}

const PICK: PickSlot[] = (slotsData as { slots: PickSlot[] }).slots
const ALTS: Record<string, string> = altsData as Record<string, string>

export const PHOTO_PUBLIC_DIR = '/web/photos'
const PUBLIC_ROOT = path.join(process.cwd(), 'public')
const MANIFEST_PATH = path.join(PUBLIC_ROOT, 'web', 'photos', 'manifest.json')

/** Všechny sloty z výběru fotek (pro přehled a testy). */
export function photoSlots(): string[] {
  return [...new Set(PICK.map((s) => s.slot))]
}

/** Konvenční název souboru pro slot: "home.hero" → "/web/photos/home-hero.jpg" (index ≥ 1 → "-2", "-3"…). */
export function conventionalSrc(slot: string, index = 0): string {
  const base = slot.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  return `${PHOTO_PUBLIC_DIR}/${base}${index > 0 ? `-${index + 1}` : ''}.jpg`
}

// ── manifest ────────────────────────────────────────────────────────────────

let cache: { mtimeMs: number; map: Map<string, ManifestEntry[]> } | null = null

function normalizeSrc(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  if (s.startsWith('/')) return s
  if (/^https?:\/\//.test(s)) return null // vzdálené zdroje nepoužíváme
  return `${PHOTO_PUBLIC_DIR}/${s.replace(/^\.?\//, '')}`
}

function toEntry(slot: string, raw: unknown): ManifestEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const src = normalizeSrc(r.src ?? r.file ?? r.path ?? r.url)
  if (!src) return null
  const num = (x: unknown) => (typeof x === 'number' && x > 0 ? x : undefined)
  return {
    slot: typeof r.slot === 'string' ? r.slot : slot,
    src,
    alt: typeof r.alt === 'string' ? r.alt : typeof r.altCs === 'string' ? r.altCs : undefined,
    width: num(r.width),
    height: num(r.height),
    provisional: typeof r.provisional === 'boolean' ? r.provisional : undefined,
    position: typeof r.position === 'string' ? r.position : typeof r.focus === 'string' ? r.focus : undefined,
    index: typeof r.index === 'number' ? r.index : undefined,
  }
}

/** Rozparsuje manifest libovolného podporovaného tvaru (exportováno kvůli testům). */
export function parseManifest(json: unknown): Map<string, ManifestEntry[]> {
  const map = new Map<string, ManifestEntry[]>()
  const known = new Set(PICK.map((p) => p.slot))
  const add = (slot: string, raw: unknown) => {
    const e = toEntry(slot, raw)
    if (!e || !e.slot) return
    // Galerie jako „slot.N“ (N od 1): "catering.svatby.gallery.2" → slot "catering.svatby.gallery", index 1.
    const g = /^(.+)\.(\d+)$/.exec(e.slot)
    if (g && !known.has(e.slot) && known.has(g[1])) {
      e.slot = g[1]
      e.index ??= Number(g[2]) - 1
    }
    map.set(e.slot, [...(map.get(e.slot) ?? []), e])
  }
  const fromRecord = (rec: Record<string, unknown>) => {
    for (const [slot, v] of Object.entries(rec)) (Array.isArray(v) ? v : [v]).forEach((x) => add(slot, x))
  }
  if (Array.isArray(json)) json.forEach((x) => add('', x))
  else if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    if (Array.isArray(o.photos)) o.photos.forEach((x) => add('', x))
    else if (Array.isArray(o.slots)) o.slots.forEach((x) => add('', x))
    else if (o.slots && typeof o.slots === 'object') fromRecord(o.slots as Record<string, unknown>)
    else fromRecord(Object.fromEntries(Object.entries(o).filter(([k]) => k.includes('.'))))
  }
  for (const list of map.values()) list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return map
}

function loadManifest(): Map<string, ManifestEntry[]> {
  try {
    const stat = fs.statSync(MANIFEST_PATH)
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.map
    const map = parseManifest(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')))
    cache = { mtimeMs: stat.mtimeMs, map }
    return map
  } catch {
    return new Map()
  }
}

function publicFileExists(src: string): boolean {
  try {
    return fs.statSync(path.join(PUBLIC_ROOT, decodeURIComponent(src.split('?')[0]))).isFile()
  } catch {
    return false
  }
}

// ── výchozí alt ze stávajících podkladů ─────────────────────────────────────

function fallbackAlt(pick: PickSlot | undefined, slot: string): string {
  if (pick) {
    const alt = ALTS[pick.original] ?? ALTS[pick.file]
    if (alt) return alt
    const first = pick.note.split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]$/, '').trim()
    if (first) return first
  }
  return `Fotka: ${slot}`
}

// ── veřejné API ─────────────────────────────────────────────────────────────

/**
 * Fotka pro slot (index = pořadí v galerii). Nikdy nevrací undefined:
 * když fotka chybí, vrátí zástupce (placeholder: true, src: null).
 */
export function getPhoto(slot: string, index = 0): Photo {
  const picks = PICK.filter((p) => p.slot === slot)
  const pick = picks[index] ?? picks[0]
  const entry = loadManifest().get(slot)?.[index]
  const base = { slot, crop: pick?.crop, provisional: pick?.provisional ?? false }

  if (entry && publicFileExists(entry.src)) {
    return {
      ...base,
      src: entry.src,
      alt: entry.alt ?? fallbackAlt(pick, slot),
      width: entry.width,
      height: entry.height,
      provisional: entry.provisional ?? base.provisional,
      position: entry.position,
      blur: BLUR[entry.src],
      placeholder: false,
    }
  }
  const conventional = conventionalSrc(slot, index)
  if (publicFileExists(conventional)) {
    return { ...base, src: conventional, alt: fallbackAlt(pick, slot), blur: BLUR[conventional], placeholder: false }
  }
  return { ...base, src: null, alt: fallbackAlt(pick, slot), placeholder: true }
}

/** Všechny fotky slotu (galerie). Délka = max(počet ve výběru, počet v manifestu), min. 1. */
export function getPhotos(slot: string): Photo[] {
  const count = Math.max(PICK.filter((p) => p.slot === slot).length, loadManifest().get(slot)?.length ?? 0, 1)
  return Array.from({ length: count }, (_, i) => getPhoto(slot, i))
}

/** Absolutní URL fotky pro Open Graph (nebo undefined, když fotka chybí). */
export function ogImage(slot = 'og.default'): { url: string; width?: number; height?: number; alt: string } | undefined {
  const p = getPhoto(slot)
  return p.src ? { url: p.src, width: p.width, height: p.height, alt: p.alt } : undefined
}
