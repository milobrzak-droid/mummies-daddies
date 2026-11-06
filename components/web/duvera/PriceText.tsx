import { Fragment } from 'react'
import { PlaceholderText } from '../PlaceholderText'

/**
 * Text z copy, ve kterém se ceny („1 290 Kč“, „od [DOPLNÍ KLIENT] Kč/os.“)
 * zvýrazní malinově (akcent jen pro ceny). Text zůstává doslova; zástupce
 * [DOPLNÍ KLIENT] se vykreslí přes <PlaceholderText>.
 */
const PRICE = /((?:od\s+)?(?:\d[\d\s ]*|\[DOPLNÍ KLIENT[^\]]*\])\s?Kč(?:\/os\.)?)/gi

export function splitPrices(text: string): { text: string; price: boolean }[] {
  const out: { text: string; price: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(PRICE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), price: false })
    out.push({ text: m[0], price: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), price: false })
  return out
}

export function PriceText({ text }: { text: string }) {
  return (
    <>
      {splitPrices(text).map((p, i) =>
        p.price ? (
          <span key={i} className="whitespace-nowrap font-bold text-raspberry-ink">
            <PlaceholderText text={p.text} />
          </span>
        ) : (
          <Fragment key={i}>
            <PlaceholderText text={p.text} />
          </Fragment>
        ),
      )}
    </>
  )
}
