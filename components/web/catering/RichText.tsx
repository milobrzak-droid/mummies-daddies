import Link from 'next/link'
import { Fragment } from 'react'
import { PlaceholderText } from '../PlaceholderText'
import { splitInternalLinks } from './parse'

/**
 * Text z copy.json: zástupce [DOPLNÍ KLIENT] zvýrazní (PlaceholderText) a interní
 * cesty v textu („Více na /catering/teambuilding.“) udělá odkazem. Text se nemění.
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
