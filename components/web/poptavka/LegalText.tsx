import { Fragment } from 'react'
import { PlaceholderText } from '../PlaceholderText'

/**
 * Text právních šablon. Kromě „[DOPLNÍ KLIENT: …]“ (PlaceholderText) zvýrazní
 * i zástupce „[DOPLNÍ KLIENT / PRÁVNÍK: …]“, „[DOPLNÍ PRÁVNÍK: …]“ a
 * „[DOPLNÍ: …]“, které sdílený regex nezachytí – na webu musí být vidět.
 */
const ANY_PLACEHOLDER = /\[DOPLNÍ[^\]]*\]/g

export function LegalText({ text }: { text: string }) {
  const parts: { text: string; fill: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(ANY_PLACEHOLDER)) {
    const i = m.index ?? 0
    if (i > last) parts.push({ text: text.slice(last, i), fill: false })
    parts.push({ text: m[0], fill: true })
    last = i + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), fill: false })
  return (
    <>
      {parts.map((p, i) =>
        p.fill ? (
          <span key={i} className="md-fill" title="Doplní klient nebo právník">
            {p.text}
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

/** Obsahuje text jakéhokoli zástupce [DOPLNÍ …]? */
export function hasAnyPlaceholder(text: string): boolean {
  return /\[DOPLNÍ/.test(text)
}
