/**
 * Konfigurace stránek cateringu (/catering a 9 typů akcí): jak se jednotlivé
 * sekce z copy.json vykreslí, jaké fotky (sloty z content.json › pick) k nim
 * patří a jaký typ akce se předvyplní v průvodci poptávkou.
 *
 * Jen data – texty se čtou z lib/web/content (copy.json) a nikdy se tu nepíšou.
 * Pořadí sekcí = pořadí v copy.json; sekce „hero“ a „cta“ mají pevné místo.
 */
import type { CustomerKind, EventType } from './options'
import type { PastelTone, SurfaceTone } from './tokens'

export const CATERING_PATH = '/catering'

export const CATERING_SLUGS = [
  'firemni',
  'snidane',
  'coffee-break',
  'obedy',
  'vecere-a-bankety',
  'spolecenske-akce',
  'teambuilding',
  'svatby',
  'oslavy-a-piknik',
] as const
export type CateringSlug = (typeof CATERING_SLUGS)[number]

/** Odkaz na fotku: slot (a pořadí v galerii od 0). */
export interface PhotoRef {
  slot: string
  index?: number
}

/**
 * Jak vykreslit sekci:
 * - chips      – položky jako štítky (typy akcí, příležitosti, doplňky, nápoje)
 * - checklist  – seznam s fajfkami, volitelně s fotkou vedle
 * - packages   – položky „Název — popis“ jako pastelové karty s cenou a minimem
 * - menu       – ukázkové menu jako tištěná karta
 * - steps      – číslované kroky
 * - faq        – časté dotazy (<details> + FAQPage JSON-LD)
 * - feature    – text vedle fotky (s CTA sekce)
 * - text       – nadpis, text a CTA
 * - gallery    – fotky ze slotu galerie (prázdné zástupce vynechá)
 * - links      – položky „Text → /cesta“ jako klikací karty s fotkami
 * - format     – krátká textová sekce s cenou a minimem; sousední format sekce
 *                se seskupí do jedné mřížky karet (večeře: bufet, banket, sharing table)
 */
export type SectionLayout =
  | { kind: 'chips' }
  | { kind: 'checklist'; photo?: PhotoRef }
  | { kind: 'packages' }
  | { kind: 'menu' }
  | { kind: 'steps' }
  | { kind: 'faq' }
  | { kind: 'feature'; photo: PhotoRef; reverse?: boolean }
  | { kind: 'text' }
  | { kind: 'gallery'; slot: string }
  | { kind: 'links'; photos: PhotoRef[] }
  | { kind: 'format' }

export type SectionConfig = SectionLayout & {
  /** Pozadí sekce; výchozí střídá krémovou a bílou. */
  tone?: SurfaceTone
  soft?: boolean
}

export interface CateringTypeConfig {
  slug: CateringSlug
  path: `/catering/${CateringSlug}`
  /** Typ akce předvyplněný v průvodci (?typ=…), když ho CTA v copy neuvádí. */
  eventType: EventType
  segment?: CustomerKind
  /** Název služby v přehledu /catering › sluzby (zdroj ceny od a minima). */
  overviewTitle: string
  /** Popisek v drobečkové navigaci. */
  breadcrumb: string
  tone: PastelTone
  ctaTone: SurfaceTone
  hero: PhotoRef
  /** Fotka karty v přehledu /catering (stejná jako mřížka na úvodu). */
  card: PhotoRef
  sections: Record<string, SectionConfig>
  /** Pás fotek vložený za sekci s daným id. */
  bands?: { after: string; photos: PhotoRef[] }[]
}

const g = (slot: string, ...indexes: number[]): PhotoRef[] => indexes.map((index) => ({ slot, index }))

export const CATERING_TYPES: readonly CateringTypeConfig[] = [
  {
    slug: 'firemni',
    path: '/catering/firemni',
    eventType: 'firemni',
    segment: 'firma',
    overviewTitle: 'Firemní catering',
    breadcrumb: 'Firemní catering',
    tone: 'sage',
    ctaTone: 'blush',
    hero: { slot: 'catering.firemni.hero' },
    card: { slot: 'home.grid.firemni' },
    sections: {
      'typy-akci': { kind: 'chips' },
      balicky: { kind: 'packages' },
      'ukazkova-menu': { kind: 'menu', tone: 'sage', soft: true },
      'pravidelne-obedy': { kind: 'feature', photo: { slot: 'catering.obedy.hero' } },
      reference: { kind: 'feature', photo: { slot: 'reference.bvlgari.cover' }, reverse: true },
      fakturace: { kind: 'checklist' },
      faq: { kind: 'faq' },
    },
    bands: [{ after: 'typy-akci', photos: g('catering.firemni.gallery', 0, 1, 2) }],
  },
  {
    slug: 'snidane',
    path: '/catering/snidane',
    eventType: 'snidane',
    overviewTitle: 'Snídaně',
    breadcrumb: 'Snídaně',
    tone: 'vanilla',
    ctaTone: 'sage',
    hero: { slot: 'catering.snidane.hero' },
    card: { slot: 'home.grid.snidane' },
    sections: {
      balicky: { kind: 'packages' },
      doplnky: { kind: 'chips', tone: 'vanilla', soft: true },
      fotky: { kind: 'gallery', slot: 'catering.snidane.gallery' },
    },
  },
  {
    slug: 'coffee-break',
    path: '/catering/coffee-break',
    eventType: 'coffee-break',
    overviewTitle: 'Coffee break',
    breadcrumb: 'Coffee break',
    tone: 'blush',
    ctaTone: 'sage',
    hero: { slot: 'catering.coffee-break.hero' },
    card: { slot: 'home.grid.coffee-break' },
    sections: {
      standard: { kind: 'checklist', photo: { slot: 'catering.coffee-break.gallery' } },
      varianty: { kind: 'text', tone: 'blush', soft: true },
      'se-zazitkem': { kind: 'packages' },
      napoje: { kind: 'chips', tone: 'paper' },
    },
  },
  {
    slug: 'obedy',
    path: '/catering/obedy',
    eventType: 'obed',
    overviewTitle: 'Obědy s rozvozem',
    breadcrumb: 'Obědy',
    tone: 'pistachio',
    ctaTone: 'blush',
    hero: { slot: 'catering.obedy.hero' },
    card: { slot: 'home.grid.obedy' },
    sections: {
      formy: { kind: 'packages' },
      'tydenni-menu': { kind: 'menu', tone: 'pistachio', soft: true },
      podminky: { kind: 'checklist', photo: { slot: 'catering.obedy.gallery' } },
      pravidelne: { kind: 'text', tone: 'paper' },
    },
  },
  {
    slug: 'vecere-a-bankety',
    path: '/catering/vecere-a-bankety',
    eventType: 'vecere',
    overviewTitle: 'Večeře a bankety',
    breadcrumb: 'Večeře a bankety',
    tone: 'vanilla',
    ctaTone: 'blush',
    hero: { slot: 'catering.vecere-a-bankety.hero' },
    card: { slot: 'home.grid.vecere-a-bankety' },
    sections: {
      bufet: { kind: 'format' },
      banket: { kind: 'format' },
      'sharing-table': { kind: 'format' },
      'ukazkova-menu': { kind: 'menu', tone: 'vanilla', soft: true },
      fotky: { kind: 'gallery', slot: 'catering.vecere-a-bankety.gallery' },
    },
  },
  {
    slug: 'spolecenske-akce',
    path: '/catering/spolecenske-akce',
    eventType: 'spolecenska-akce',
    overviewTitle: 'Společenské akce',
    breadcrumb: 'Společenské akce',
    tone: 'blush',
    ctaTone: 'vanilla',
    hero: { slot: 'catering.spolecenske-akce.hero' },
    card: { slot: 'home.grid.spolecenske-akce' },
    sections: {
      formaty: { kind: 'packages' },
      napoje: { kind: 'checklist', photo: { slot: 'catering.spolecenske-akce.gallery', index: 1 }, tone: 'paper' },
      obsluha: { kind: 'feature', photo: { slot: 'catering.spolecenske-akce.gallery', index: 0 }, reverse: true },
      bvlgari: { kind: 'feature', photo: { slot: 'catering.spolecenske-akce.bvlgari' }, tone: 'paper' },
      agentury: { kind: 'text', tone: 'sage', soft: true },
    },
  },
  {
    slug: 'teambuilding',
    path: '/catering/teambuilding',
    eventType: 'teambuilding',
    segment: 'firma',
    overviewTitle: 'Teambuilding',
    breadcrumb: 'Teambuilding',
    tone: 'pistachio',
    ctaTone: 'vanilla',
    hero: { slot: 'catering.teambuilding.hero' },
    card: { slot: 'home.grid.teambuilding' },
    sections: {
      formaty: { kind: 'packages' },
      'bbq-menu': { kind: 'menu', tone: 'pistachio', soft: true },
      prubeh: { kind: 'steps' },
      fotky: { kind: 'gallery', slot: 'catering.teambuilding.gallery' },
    },
  },
  {
    slug: 'svatby',
    path: '/catering/svatby',
    eventType: 'svatba',
    overviewTitle: 'Svatby',
    breadcrumb: 'Svatby',
    tone: 'blush',
    ctaTone: 'vanilla',
    hero: { slot: 'catering.svatby.hero' },
    card: { slot: 'home.grid.svatby' },
    sections: {
      pribeh: { kind: 'feature', photo: { slot: 'catering.svatby.gallery', index: 0 } },
      menu: { kind: 'packages', tone: 'paper' },
      extra: { kind: 'checklist', photo: { slot: 'catering.svatby.sweet-bar' } },
      'jak-to-probiha': { kind: 'steps', tone: 'blush', soft: true },
      reference: { kind: 'links', photos: [{ slot: 'reference.jitka-rostislav.cover' }, { slot: 'reference.katka-jirka.cover' }] },
      prostory: { kind: 'feature', photo: { slot: 'prostory.stary-tyn' }, reverse: true, tone: 'paper' },
      faq: { kind: 'faq' },
    },
    bands: [{ after: 'extra', photos: [{ slot: 'catering.svatby.cake' }, ...g('catering.svatby.gallery', 1, 2)] }],
  },
  {
    slug: 'oslavy-a-piknik',
    path: '/catering/oslavy-a-piknik',
    eventType: 'oslava',
    overviewTitle: 'Oslavy a piknik',
    breadcrumb: 'Oslavy a piknik',
    tone: 'vanilla',
    ctaTone: 'blush',
    hero: { slot: 'catering.oslavy-a-piknik.hero' },
    card: { slot: 'home.grid.oslavy-a-piknik' },
    sections: {
      balicky: { kind: 'packages' },
      prilezitosti: { kind: 'chips', tone: 'vanilla', soft: true },
      'ukazkove-menu': { kind: 'menu' },
      'cheesecake-dort': { kind: 'feature', photo: { slot: 'cheesecaky.hero' }, tone: 'blush', soft: true },
    },
    bands: [{ after: 'ukazkove-menu', photos: g('catering.oslavy-a-piknik.gallery', 0, 1) }],
  },
]

export function cateringTypeOf(slug: string): CateringTypeConfig | undefined {
  return CATERING_TYPES.find((t) => t.slug === slug)
}

export function getCateringType(slug: CateringSlug): CateringTypeConfig {
  const t = cateringTypeOf(slug)
  if (!t) throw new Error(`catering: neznámý typ ${slug}`)
  return t
}

/** Fotky formátů servisu v přehledu (/catering › formaty), podle začátku názvu položky. */
export const FORMAT_PHOTOS: { match: RegExp; slot: string | null }[] = [
  { match: /^Bufet/, slot: 'catering.formats.bufet' },
  { match: /^Studený raut/, slot: 'catering.formats.raut' },
  { match: /^Teplý raut/, slot: null },
  { match: /^Banket/, slot: 'catering.formats.banket' },
  { match: /^Sharing table/, slot: null },
  { match: /^Finger food/, slot: 'catering.formats.finger-food' },
  { match: /^BBQ/, slot: 'catering.formats.bbq-live-cooking' },
]
