/**
 * Data stránky /kontakt (SERVER ONLY: čte copy.json). Texty doslova z copy.
 */
import { contactLine, type SocialLink } from '@/components/web/uvod'
import { COMPANY, getSection, getSectionParsed, parseCta, splitDots } from '@/lib/web/content'
import { inquiryHref } from '@/lib/web/inquiry-link'
import { QUICK_START_EVENT_TYPES } from '@/lib/web/options'
import { quickStartLabels } from './home'

const PATH = '/kontakt'

export const KONTAKT_INQUIRY_HREF = inquiryHref({ zdroj: PATH })

export function peopleData() {
  const s = getSectionParsed(PATH, 'lide')
  return {
    heading: s.heading,
    lead: s.body,
    people: s.parsedItems
      .filter((i) => i.title)
      .map((i) => ({ name: i.title!, lines: splitDots(i.text).map(contactLine) })),
  }
}

/** „Zavolat / Poptat“ → dvě tlačítka (telefon na Moniku, poptávka s kontextem). */
export function primaryActions() {
  const raw = getSection(PATH, 'site').cta ?? ''
  const [call, ask] = raw.split(/\s*\/\s*/)
  return {
    call: call ? { label: call, href: COMPANY.phoneHref } : null,
    ask: ask ? { label: ask, href: KONTAKT_INQUIRY_HREF } : null,
  }
}

export function quickInquiryData() {
  const s = getSection(PATH, 'rychla-poptavka')
  const cta = s.cta ? parseCta(s.cta) : null
  return {
    heading: s.heading,
    body: s.body,
    labels: quickStartLabels(cta?.label),
    options: QUICK_START_EVENT_TYPES.map(({ value, label }) => ({ value, label })),
  }
}

export function billingData() {
  const s = getSection(PATH, 'fakturace')
  return { heading: s.heading, body: s.body || null, lines: s.items ?? [] }
}

export function premisesData() {
  const s = getSection(PATH, 'provozovna')
  return { heading: s.heading, body: s.body }
}

export function socialsData() {
  const s = getSectionParsed(PATH, 'site')
  const items: SocialLink[] = s.parsedItems
    .filter((i) => i.label)
    .map((i) => {
      const network = i.label!.toLowerCase()
      const match = COMPANY.socials.find((x) => x.network === network && x.handle === i.text)
      return { network, label: i.label!, text: i.text, href: match?.href ?? null }
    })
  return { heading: s.heading, body: s.body, items }
}
