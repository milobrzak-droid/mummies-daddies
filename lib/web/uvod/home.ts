/**
 * Data úvodní stránky (SERVER ONLY: čte copy.json a manifest fotek).
 * Skládá props sekcí podle strategy.homepage; texty bere doslova z copy
 * (lib/web/content), jen je rozdělí na části. Stránka app/(web)/page.tsx je
 * pak čistá kompozice komponent z components/web/uvod.
 */
import {
  contactLine,
  keepTogether,
  lastSegment,
  splitEventCardText,
  splitProduct,
  splitStepNumber,
  type CheesecakeCard,
  type EventTypeCard,
  type QuickStartLabels,
  type ReferenceCard,
  type ReferenceNote,
  type VenueCard,
} from '@/components/web/uvod'
import { faqFromItems } from '@/components/web/Faq'
import { COMPANY, getSection, getSectionParsed, microcopy, parseCta, splitDots, type ParsedItem } from '@/lib/web/content'
import { inquiryHref } from '@/lib/web/inquiry-link'
import { CHEESECAKES, QUICK_START_EVENT_TYPES } from '@/lib/web/options'
import { getPhoto } from '@/lib/web/photos'

const HOME = '/'

type Link = { label: string; href: string }

function link(raw: string | undefined | null, fallbackHref?: string): Link | null {
  if (!raw) return null
  const c = parseCta(raw)
  const href = c.href ?? fallbackHref
  return href ? { label: c.label, href } : null
}

function byLabel(items: ParsedItem[], label: string): ParsedItem | undefined {
  return items.find((i) => i.label === label)
}

/** Hlavní poptávkové CTA úvodu (nese kontext zdroj=/). */
export const HOME_INQUIRY_HREF = inquiryHref({ zdroj: HOME })

// ── hero ────────────────────────────────────────────────────────────────────

export function heroData() {
  const s = getSectionParsed(HOME, 'hero')
  const secondary = byLabel(s.parsedItems, 'Sekundární odkaz')
  const trust = byLabel(s.parsedItems, 'Mikrodůvěra')
  return {
    title: s.heading,
    lead: s.body,
    photo: getPhoto('home.hero'),
    mobilePhoto: getPhoto('home.hero.mobile'),
    primaryCta: s.parsedCta ? { label: s.parsedCta.label, href: HOME_INQUIRY_HREF } : null,
    secondaryCta: secondary?.href ? { label: secondary.text, href: secondary.href } : null,
    trust: trust?.text ?? null,
  }
}

// ── rychlý start (sdílený s /kontakt) ───────────────────────────────────────

export function quickStartLabels(submit?: string): QuickStartLabels {
  const items = getSection(HOME, 'rychly-start').items ?? []
  const [typ, datum, osob] = items
  return {
    eventType: (typ ?? 'Typ akce').split(/\s+▾/)[0].trim(),
    eventTypePlaceholder: microcopy('RYCHLÝ START — placeholder typ akce'),
    date: datum ?? microcopy('POPTÁVKA — pole Datum'),
    guests: osob ?? microcopy('RYCHLÝ START — placeholder počet osob'),
    guestsPlaceholder: microcopy('RYCHLÝ START — placeholder počet osob'),
    submit: submit ?? microcopy('RYCHLÝ START — tlačítko'),
  }
}

export function quickStartData() {
  const s = getSection(HOME, 'rychly-start')
  return {
    heading: s.heading,
    body: s.body,
    labels: quickStartLabels(s.cta ? parseCta(s.cta).label : undefined),
    options: QUICK_START_EVENT_TYPES.map(({ value, label }) => ({ value, label })),
  }
}

// ── mřížka typů akcí ────────────────────────────────────────────────────────

export function eventGridData() {
  const s = getSectionParsed(HOME, 'typy-akci')
  const cards: EventTypeCard[] = s.parsedItems
    .filter((i): i is ParsedItem & { title: string; href: string } => !!i.title && !!i.href)
    .map((i) => {
      const t = splitEventCardText(i.text)
      return { title: i.title, ...t, href: i.href, photo: getPhoto(`home.grid.${lastSegment(i.href)}`) }
    })
  return {
    heading: s.heading,
    lead: s.body,
    cards,
    assistant: s.cta ? { label: parseCta(s.cta).label, href: inquiryHref({ typ: 'nevim', zdroj: HOME }) } : null,
  }
}

// ── proč my ─────────────────────────────────────────────────────────────────

export function whyUsData() {
  const s = getSectionParsed(HOME, 'proc-my')
  return {
    heading: s.heading,
    lead: s.body,
    pillars: s.parsedItems.filter((i) => i.title).map((i) => ({ title: i.title!, text: i.text })),
  }
}

// ── reference ───────────────────────────────────────────────────────────────

const REFERENCE_PHOTO: Record<string, string> = {
  'bvlgari-luxury-party': 'home.references.bvlgari',
  'svatba-jitka-a-rostislav': 'home.references.jitka-rostislav',
  'svatba-katka-a-jirka': 'home.references.katka-jirka',
}

export function referencesData() {
  const s = getSectionParsed(HOME, 'reference')
  const cards: ReferenceCard[] = s.parsedItems
    .filter((i) => i.title && i.href)
    .map((i) => {
      const slug = lastSegment(i.href) ?? ''
      return { title: i.title!, text: i.text, href: i.href!, photo: REFERENCE_PHOTO[slug] ? getPhoto(REFERENCE_PHOTO[slug]) : null }
    })
  const notes: ReferenceNote[] = s.parsedItems
    .filter((i) => i.label && i.label !== 'Čísla')
    .map((i) => ({ label: i.label!, text: i.text }))
  const numbers = byLabel(s.parsedItems, 'Čísla')
  return {
    heading: s.heading,
    lead: s.body,
    cards,
    notes,
    stats: numbers ? splitDots(numbers.text) : [],
    cta: link(s.cta),
  }
}

// ── z naší kuchyně ──────────────────────────────────────────────────────────

export function kitchenData() {
  const s = getSection(HOME, 'z-kuchyne')
  const dishes = s.items ?? []
  return {
    heading: s.heading,
    lead: s.body,
    dishes,
    photos: Array.from({ length: 6 }, (_, i) => getPhoto(`home.kitchen.${i + 1}`)),
    cta: link(s.cta),
  }
}

// ── jak to funguje ──────────────────────────────────────────────────────────

export function howItWorksData() {
  const s = getSectionParsed(HOME, 'jak-to-funguje')
  return {
    heading: s.heading,
    lead: s.body,
    steps: s.parsedItems.map((i) => ({ title: splitStepNumber(i.title ?? i.text).title, text: i.title ? i.text : '' })),
    cta: s.parsedCta ? { label: s.parsedCta.label, href: HOME_INQUIRY_HREF } : null,
  }
}

// ── partnerské prostory ─────────────────────────────────────────────────────

const VENUE_PHOTO: [RegExp, string][] = [
  [/Hudlick/i, 'home.venues.hudlicka-stodola'],
  [/Star[ýy] T[ýy]n/i, 'home.venues.stary-tyn'],
  [/Dvou Stodol/i, 'home.venues.u-dvou-stodol'],
]

export function venuesData() {
  const s = getSection(HOME, 'prostory')
  const venues: VenueCard[] = (s.items ?? []).map((name) => {
    const slot = VENUE_PHOTO.find(([re]) => re.test(name))?.[1]
    return { name, photo: slot ? getPhoto(slot) : null }
  })
  return { heading: s.heading, lead: s.body, venues, cta: link(s.cta) }
}

// ── cheesecaky ──────────────────────────────────────────────────────────────

const CHEESECAKE_PHOTO: Record<string, string> = {
  'daddy-vanilkovy': 'home.cheesecakes.daddy-vanilkovy',
  'daddy-pistaciovo-malinovy': 'home.cheesecakes.daddy-pistaciovo-malinovy',
  'mini-cheesecaky-10-ks': 'home.cheesecakes.mini-10ks',
}

export function cheesecakesData() {
  const s = getSection(HOME, 'cheesecaky')
  const products: CheesecakeCard[] = (s.items ?? []).flatMap((raw) => {
    const p = splitProduct(raw)
    const cake = CHEESECAKES.find((c) => c.name === p.name)
    if (!cake) return []
    return [{ ...p, price: p.price ? keepTogether(p.price) : null, href: `/cheesecaky/${cake.slug}`, photo: CHEESECAKE_PHOTO[cake.slug] ? getPhoto(CHEESECAKE_PHOTO[cake.slug]) : null }]
  })
  const [order, add] = splitDots(s.cta ?? '').map((c) => parseCta(c))
  return {
    heading: s.heading,
    lead: s.body,
    products,
    order: order?.href ? { label: order.label, href: order.href } : null,
    // „Přidat na akci → /poptavka?doplnek=sladky-bar“ + kontext zdroje
    addToEvent: add ? { label: add.label, href: inquiryHref({ doplnek: 'sladky-bar', zdroj: HOME }) } : null,
  }
}

/** schema.org Product pro cheesecaky na úvodu (jen ověřené ceny z options). */
export function cheesecakeProductsLd(products: CheesecakeCard[]) {
  const items = products.flatMap((p, i) => {
    const cake = CHEESECAKES.find((c) => `/cheesecaky/${c.slug}` === p.href)
    if (!cake || !cake.priceConfirmed) return []
    const url = `${COMPANY.siteUrl}${p.href}`
    return [
      {
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'Product',
          name: cake.name,
          url,
          ...(p.photo?.src ? { image: `${COMPANY.siteUrl}${p.photo.src}` } : {}),
          brand: { '@type': 'Brand', name: COMPANY.brand },
          offers: { '@type': 'Offer', price: String(cake.price), priceCurrency: 'CZK', url },
        },
      },
    ]
  })
  return items.length ? { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: items } : null
}

// ── tým ─────────────────────────────────────────────────────────────────────

export function teamData() {
  const s = getSectionParsed(HOME, 'tym')
  return {
    heading: s.heading,
    body: s.body,
    signature: byLabel(s.parsedItems, 'Podpis')?.text ?? null,
    photo: getPhoto('home.team'),
    cta: link(s.cta),
  }
}

// ── FAQ ─────────────────────────────────────────────────────────────────────

export function faqData() {
  const s = getSection(HOME, 'faq')
  return { heading: s.heading, lead: s.body, items: faqFromItems(s.items), cta: link(s.cta) }
}

// ── závěrečná poptávka ──────────────────────────────────────────────────────

export function finalInquiryData() {
  const s = getSection(HOME, 'zaverecna-poptavka')
  const [chatTitle = '', formLabel = '', ...contacts] = s.items ?? []
  const lines = contacts.map(contactLine)
  const phone = lines.find((l) => l.kind === 'phone')
  const email = lines.find((l) => l.kind === 'email')
  return {
    heading: s.heading,
    body: s.body,
    chatTitle,
    greeting: microcopy('ASISTENT — úvodní zpráva'),
    chips: QUICK_START_EVENT_TYPES.map((e) => ({ label: e.label, href: inquiryHref({ typ: e.value, zdroj: HOME }) })),
    assistantNote: microcopy('POPTÁVKA — informace o asistentovi'),
    formLabel,
    formHref: HOME_INQUIRY_HREF,
    primary: { label: parseCta(s.cta ?? '').label, href: HOME_INQUIRY_HREF },
    phone: phone && phone.kind === 'phone' ? { text: phone.text, href: phone.href } : null,
    email: email && email.kind === 'email' ? { text: email.text, href: email.href } : null,
  }
}
