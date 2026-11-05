import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ReferenceCasePage, referenceAwaitsConsent, referenceStaticParams } from '@/components/web/duvera'
import { duveraMetadata } from '@/lib/web/duvera/metadata'
import { referenceCase } from '@/lib/web/duvera/references'

/**
 * /reference/<slug>: případová studie (shrnutí, zadání, menu, galerie, citace, CTA
 * „Poptat podobnou“ s parametrem vzor). Jen tři studie ze strategie, jiné slugy → 404.
 * Studie bez souhlasu klienta s publikací ([DOPLNÍ KLIENT: souhlas …]) má noindex.
 */
export const dynamicParams = false

export function generateStaticParams() {
  return referenceStaticParams()
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const c = referenceCase(slug)
  if (!c) return {}
  return duveraMetadata(c.path, { ogSlot: c.coverSlot, noindex: referenceAwaitsConsent(slug) })
}

export default async function ReferenceDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!referenceCase(slug)) notFound()
  return <ReferenceCasePage slug={slug} />
}
