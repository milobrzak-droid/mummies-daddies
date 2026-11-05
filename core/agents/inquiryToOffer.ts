// Poptávka z e-mailu → rozhodnutí agenta (schopnost „standardní nabídka").
// Skládá kroky: vytěžení modelem → očištění → segment B2B/B2C → vzdálenost
// místa akce → výpočet z mapy → text odpovědi. Závislosti (model,
// geokódování) se předávají zvenku, takže krok je testovatelný bez sítě.
//
// Výsledek je jen ROZHODNUTÍ. Nic neodesílá ani nezapisuje — to udělá
// volající podle authority modelu firmy (samostatné odeslání jen u `send_offer`).
import type { StandardOfferConfig } from '../tenant'
import { evaluateStandardOffer, renderInfoRequest, renderOfferEmail, type EscalationReason, type MissingField, type OfferQuote } from '../standardOffer'
import { resolveSegment, sanitizeInquiry, toOfferInquiry, type SanitizedInquiry, type SegmentDecision } from './inquiryExtraction'

export type InquiryEmail = { subject: string; text: string; fromAddress: string | null }

export type InquiryDeps = {
  /** Volání modelu; vrací surový JSON (connectors/anthropic/inquiry.ts). */
  extract: (input: { companyName: string; priceMap: StandardOfferConfig['priceMap']; today: string; subject: string; text: string }) => Promise<unknown>
  /** Vzdálenost místa akce od provozovny v km (jedna cesta); null = nejde určit. */
  distanceKm: (venue: string) => Promise<number | null>
  /** Je odesílatel v CRM označený jako citlivý / VIP? */
  isVipContact: (fromAddress: string | null) => Promise<boolean>
}

export type InquiryDecision =
  | { kind: 'not_inquiry'; extracted: SanitizedInquiry }
  | { kind: 'send_offer'; extracted: SanitizedInquiry; segment: SegmentDecision; quote: OfferQuote; email: { subject: string; body: string } }
  | { kind: 'ask_info'; extracted: SanitizedInquiry; segment: SegmentDecision; missing: MissingField[]; email: { subject: string; body: string } }
  | { kind: 'escalate'; extracted: SanitizedInquiry | null; segment: SegmentDecision | null; reasons: EscalationReason[]; missing: MissingField[]; draft: OfferQuote | null }

export async function decideInquiry(
  mail: InquiryEmail,
  ctx: { companyName: string; offer: StandardOfferConfig; today: string },
  deps: InquiryDeps,
): Promise<InquiryDecision> {
  let raw: unknown
  try {
    raw = await deps.extract({ companyName: ctx.companyName, priceMap: ctx.offer.priceMap, today: ctx.today, subject: mail.subject, text: mail.text })
  } catch (e) {
    // Selhání modelu nikdy neznamená „není poptávka": člověk se na zprávu podívá.
    const why = e instanceof Error ? e.message : 'neznámá chyba'
    return { kind: 'escalate', extracted: null, segment: null, reasons: [{ code: 'extraction_failed', message: `Poptávku se nepodařilo automaticky přečíst (${why}).` }], missing: [], draft: null }
  }

  const x = sanitizeInquiry(raw, ctx.offer.priceMap)
  if (!x.isCateringInquiry) return { kind: 'not_inquiry', extracted: x }

  const segment = resolveSegment(x, mail.fromAddress)
  const [distanceKm, vipContact] = await Promise.all([
    x.venue ? deps.distanceKm(x.venue).catch(() => null) : Promise.resolve(null),
    deps.isVipContact(mail.fromAddress).catch(() => true), // nejistota = opatrnost
  ])

  const result = evaluateStandardOffer(ctx.offer, toOfferInquiry(x, segment, { distanceKm, vipContact }), ctx.today)
  const reply = `Re: ${mail.subject}`.slice(0, 250)

  if (result.kind === 'standard') {
    const email = renderOfferEmail(result.quote, { companyName: ctx.companyName, signature: ctx.offer.signature, customerName: x.customerName })
    return { kind: 'send_offer', extracted: x, segment, quote: result.quote, email: { subject: reply, body: email.body } }
  }
  if (result.kind === 'needs_info') {
    const body = renderInfoRequest(result.missing, { signature: ctx.offer.signature, customerName: x.customerName })
    return { kind: 'ask_info', extracted: x, segment, missing: result.missing, email: { subject: reply, body } }
  }
  return { kind: 'escalate', extracted: x, segment, reasons: result.reasons, missing: result.missing, draft: result.draft }
}
