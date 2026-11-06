import type { ReactNode } from 'react'
import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import type { BreadcrumbItem } from '../Breadcrumbs'
import { Hero } from '../Hero'

/**
 * Úvod podstránky s fotkou NA VÝŠKU (portrét kuchaře, týmu): sdílený <Hero> web v2,
 * fotka 4:5 vpravo jako rovná samolepka (lidé se nenaklánějí), na mobilu pod textem.
 * Titulek je <h1>.
 */
export function SplitHero({
  title,
  lead,
  eyebrow,
  photo,
  breadcrumbs,
  tone = 'blush',
  id = 'hero-title',
  children,
}: {
  title: string
  lead?: string | null
  eyebrow?: string | null
  photo: Photo | null
  breadcrumbs?: BreadcrumbItem[]
  tone?: SurfaceTone
  id?: string
  children?: ReactNode
}) {
  return (
    <Hero title={title} lead={lead} eyebrow={eyebrow} photo={photo} breadcrumbs={breadcrumbs} tone={tone} size="page" tilt={false} id={id}>
      {children}
    </Hero>
  )
}
