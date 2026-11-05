// Verze nabídky obchodu (deal_scope_version, 0072) → dokument PDF pro
// zákazníka (core/offerPdf.ts). Verze nese rozsah textem a jednu částku;
// položky ze standardní mapy nemá (ty má OfferQuote a renderOfferPdf).
// Částka verze je bez DPH (stejně jako hodnota obchodu); DPH se dopočte
// sazbou ze schválené mapy firmy. OVĚŘIT sazbu u služby obsluhy.
import { COMPANY } from '@/config'
import { addDaysToPragueDay, pragueDayOf } from '@/lib/pragueDate'
import type { OfferPdfDocument } from '@/core/offerPdf'
import { parseVatBreakdown } from '@/core/standardOffer'
import { formatCzkText } from '@/lib/export/table'
import type { ScopeVersionRow } from '@/domain/crm/scopeVersion'

export type ScopeVersionForPdf = Pick<ScopeVersionRow, 'id' | 'deal_id' | 'version' | 'scope' | 'amount_one_time' | 'expected_mrr' | 'currency' | 'status' | 'sent_at' | 'created_at'> & {
  deal: {
    id: number
    title: string
    account: { id: number; name: string } | null
    primary_contact: { id: number; full_name: string } | null
  } | null
}

/** Verze, ze kterých má smysl tisknout nabídku pro zákazníka. */
export function canPrintScopeVersion(v: Pick<ScopeVersionRow, 'status'>): boolean {
  return v.status === 'draft' || v.status === 'sent' || v.status === 'accepted'
}

export function offerDocumentFromScopeVersion(
  v: ScopeVersionForPdf,
  opts: { today: string; vatRate?: number; validityDays?: number },
): OfferPdfDocument {
  const map = COMPANY.capabilities.standardOffer?.priceMap
  const vatRate = opts.vatRate ?? map?.vatRate ?? 0.12
  const validityDays = opts.validityDays ?? map?.offerValidityDays ?? 14
  const issuedAt = v.sent_at ? pragueDayOf(v.sent_at) : opts.today
  const amount = Math.round((Number(v.amount_one_time) || 0) * 100) / 100
  const mrr = Number(v.expected_mrr) || 0
  const currency = v.currency === 'EUR' ? 'EUR' : 'CZK'
  const lines: OfferPdfDocument['lines'] = [
    { label: v.deal?.title ?? 'Nabídka', detail: null, quantity: 1, unit: 'akce', unitPrice: amount, total: amount },
  ]
  const recurring = mrr > 0
    ? `Pravidelná dodávka: ${currency === 'EUR' ? `${mrr.toFixed(2).replace('.', ',')} EUR` : formatCzkText(mrr)} měsíčně bez DPH (není součástí ceny výše).`
    : null
  // Verze od agenta poptávek nese v textu rozpis DPH po sazbách (stejný jako
  // e-mail s nabídkou). Sedí-li jeho základy na částku verze, tiskne se on —
  // jinak by PDF počítalo vše jednou sazbou a celkem s DPH by nesedělo na
  // e-mail (např. doprava 21 % místo 12 %). Ručně změněná částka = jedna sazba.
  const parsed = currency === 'CZK' ? parseVatBreakdown(v.scope) : null
  const breakdown = parsed && parsed.reduce((s, b) => s + b.base, 0) === amount ? parsed : null
  const vat = breakdown ? breakdown.reduce((s, b) => s + b.vat, 0)
    : currency === 'CZK' ? Math.round(amount * vatRate) : Math.round(amount * vatRate * 100) / 100
  return {
    title: 'Nabídka',
    subtitle: [v.deal?.title, `verze ${v.version}`].filter(Boolean).join(' · '),
    reference: `${v.deal_id}-${v.version}`,
    customer: {
      name: v.deal?.account?.name ?? null,
      // U soukromé oslavy bývá zákazník i kontakt tentýž člověk — dvakrát ho netiskneme.
      contact: v.deal?.primary_contact?.full_name && v.deal.primary_contact.full_name !== v.deal.account?.name
        ? v.deal.primary_contact.full_name
        : null,
    },
    issuedAt,
    validUntil: addDaysToPragueDay(issuedAt, validityDays),
    eventDate: null,
    guests: null,
    includesTitle: null,
    includes: [],
    scopeText: [v.scope?.trim() || null, recurring].filter(Boolean).join('\n\n') || null,
    lines,
    subtotal: amount,
    vat,
    vatRate: breakdown && breakdown.length > 1 ? null : breakdown ? breakdown[0].rate : vatRate,
    vatBreakdown: breakdown && breakdown.length > 1 ? breakdown : null,
    total: amount + vat,
    currency,
  }
}
