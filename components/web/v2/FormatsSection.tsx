import type { Photo } from '@/lib/web/photos'
import { Explorer } from './Explorer'
import { SectionBand } from './SectionBand'

/**
 * „Vyberte si formát“ (docs/web-v2-design.md §5.8): pruh nadpisu + seznam formátů vlevo
 * a velká fotka vybraného formátu s plovoucími štítky (jen fakta) vpravo.
 */
export function FormatsSection({
  heading,
  lead,
  items,
  id = 'formaty',
}: {
  heading: string
  lead?: string | null
  items: { id: string; label: string; photo: Photo | null; tags: string[]; description: string | null; links: { label: string; href: string; primary?: boolean }[] }[]
  id?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="bg-cream">
      <SectionBand id={`${id}-title`} title={heading} accent="formát" lead={lead} tone="cream" />
      <div className="mx-auto max-w-web-wide pt-6 lg:pt-0 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
        <Explorer label="Formáty cateringu" items={items} />
      </div>
    </section>
  )
}
