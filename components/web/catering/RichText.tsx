import Link from 'next/link'
import { Fragment } from 'react'
import { PlaceholderText } from '../PlaceholderText'
import { splitInternalLinks } from './parse'

/**
 * Text z copy.json: zástupce [DOPLNÍ KLIENT] zvýrazní (PlaceholderText) a interní
 * odkazy („[Více o teambuildingu](/catering/teambuilding)“ i holou cestu) udělá
 * odkazem (splitInternalLinks). Jinak se text nemění.
 */
export function RichText({ text }: { text: string | null | undefined }) {
  if (!text) return null
  return (
    <>
      {splitInternalLinks(text).map((part, i) =>
        part.href ? (
          <Link key={i} href={part.href} className="md-link">
            {part.text}
          </Link>
        ) : (
          <Fragment key={i}>
            <PlaceholderText text={part.text} />
          </Fragment>
        ),
      )}
    </>
  )
}
