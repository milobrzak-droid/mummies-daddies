import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import type { BreadcrumbItem } from '../Breadcrumbs'
import { Hero, type HeroCta } from '../Hero'

/**
 * Hero stránek cateringu (web v2): sdílený <Hero> – text vlevo s obřím Anton titulkem
 * a malinovým slovem, jídlo vpravo jako natočená „samolepka“ v poměru podle fotky
 * (na šířku 4:3, na výšku 4:5 → bez rozmazání a bez ořezu jídla).
 */
export function isWidePhoto(photo: Photo | null | undefined): boolean {
  return !!photo && !photo.placeholder && !!photo.src && (photo.width ?? 0) >= 1600 && (photo.width ?? 0) / (photo.height ?? 1) >= 1.4
}

export function CateringHero({
  title,
  lead,
  photo,
  primaryCta,
  secondaryCta,
  breadcrumbs,
  tone,
  tags,
  id = 'hero-title',
}: {
  title: string
  lead?: string | null
  photo: Photo
  primaryCta?: HeroCta | null
  secondaryCta?: HeroCta | null
  breadcrumbs: BreadcrumbItem[]
  tone: SurfaceTone
  /** Plovoucí štítky s fakty (např. minimum osob). */
  tags?: string[]
  id?: string
}) {
  return (
    <Hero
      title={title}
      lead={lead}
      photo={photo}
      primaryCta={primaryCta}
      secondaryCta={secondaryCta}
      breadcrumbs={breadcrumbs}
      tone={tone}
      size="page"
      tags={tags}
      id={id}
    />
  )
}
