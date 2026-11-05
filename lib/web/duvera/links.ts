/**
 * Kontextové odkazy na poptávku pro stránky důvěry (reference, prostory, o nás,
 * blog, Vánoce). Bez JSON importů → bezpečné i pro klienta.
 *
 *   contextInquiryHref('/poptavka?typ=svatba&vzor=svatba-katka-a-jirka', { zdroj: '/reference/svatba-katka-a-jirka' })
 *     → "/poptavka?typ=svatba&zdroj=%2Freference%2Fsvatba-katka-a-jirka&vzor=svatba-katka-a-jirka"
 *
 * Hodnoty z copy mají přednost; prázdné parametry („?prostor=“) se zahodí;
 * `zdroj` z copy se použije jen tehdy, když je to cesta (např. „zdroj=blog“
 * nahradí skutečná cesta článku, aby ho /poptavka uměla přečíst).
 */
import { INQUIRY_PATH, inquiryHref, type InquiryLinkParams } from '../inquiry-link'
import { CUSTOMER_KINDS, EVENT_TYPES, EXTRAS, type CustomerKind, type EventType, type Extra } from '../options'

export function contextInquiryHref(raw: string | null | undefined, ctx: InquiryLinkParams = {}): string {
  const href = raw?.trim() || INQUIRY_PATH
  const [path, query = ''] = href.split('?')
  if (path !== INQUIRY_PATH) return href
  const q = new URLSearchParams(query)
  const pick = (key: string) => q.get(key)?.trim() || undefined
  const typ = pick('typ')
  const segment = pick('segment')
  const zdroj = pick('zdroj')
  const osob = Number(pick('osob'))
  const doplnek = q
    .getAll('doplnek')
    .flatMap((v) => v.split(','))
    .filter((v): v is Extra => EXTRAS.some((e) => e.value === v))
  return inquiryHref({
    ...ctx,
    typ: typ && EVENT_TYPES.some((e) => e.value === typ) ? (typ as EventType) : ctx.typ,
    segment: segment && CUSTOMER_KINDS.some((k) => k.value === segment) ? (segment as CustomerKind) : ctx.segment,
    osob: Number.isFinite(osob) && osob > 0 ? osob : ctx.osob,
    datum: pick('datum') ?? ctx.datum,
    zdroj: zdroj?.startsWith('/') ? zdroj : ctx.zdroj,
    vzor: pick('vzor') ?? ctx.vzor,
    prostor: pick('prostor') ?? ctx.prostor,
    doplnek: doplnek.length ? doplnek : ctx.doplnek,
  })
}

/** Stabilní slug z českého textu („Firemní akce“ → „firemni-akce“). */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
