import { Fragment } from 'react'
import { splitPlaceholders } from '@/lib/web/placeholders'

/**
 * Vykreslí text z copy.json a zástupce „[DOPLNÍ KLIENT: …]“ zvýrazní
 * (třída .md-fill v web.css), aby byli na webu viditelní, dokud je klient nedodá.
 * Bezpečné pro server i klienta.
 */
export function PlaceholderText({ text, as: Tag }: { text: string | null | undefined; as?: 'span' | 'p' }) {
  if (!text) return null
  const parts = splitPlaceholders(text)
  const content = parts.map((p, i) =>
    p.placeholder ? (
      <span key={i} className="md-fill" title="Doplní klient">
        {p.text}
      </span>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  )
  return Tag ? <Tag>{content}</Tag> : <>{content}</>
}
