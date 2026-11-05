/** Ikony pilířů „Proč Mummies & Daddies“ (dekorativní, stroke = currentColor). */
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 32, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  )
}

/** Kuchařská čepice. */
export const IconChefHat = (p: P) => (
  <Svg {...p}>
    <path d="M10 25h12" />
    <path d="M10.5 25v-6.2A5 5 0 0 1 9 9.3a5.5 5.5 0 0 1 10.3-1.8 4.6 4.6 0 0 1 3.7-.1 5 5 0 0 1-1.5 11.4V25" />
    <path d="M14 21v4M18 21v4" />
  </Svg>
)

/** Stopky (nabídka do pár minut). */
export const IconStopwatch = (p: P) => (
  <Svg {...p}>
    <circle cx="16" cy="18" r="9" />
    <path d="M13 5h6M16 5v4M16 18l4-4M24.5 9.5 26 8" />
  </Svg>
)

/** Poklop (plný servis). */
export const IconCloche = (p: P) => (
  <Svg {...p}>
    <path d="M5 23h22" />
    <path d="M7 23a9 9 0 0 1 18 0" />
    <path d="M16 14v-2M14.5 12h3" />
    <path d="M9 27h14" />
  </Svg>
)

/** Jiskra (zážitek navíc). */
export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M14 5c.8 5.2 2.8 7.2 8 8-5.2.8-7.2 2.8-8 8-.8-5.2-2.8-7.2-8-8 5.2-.8 7.2-2.8 8-8Z" />
    <path d="M24 20c.4 2.3 1.2 3.1 3.5 3.5-2.3.4-3.1 1.2-3.5 3.5-.4-2.3-1.2-3.1-3.5-3.5 2.3-.4 3.1-1.2 3.5-3.5Z" />
  </Svg>
)

export const PILLAR_ICONS = [IconChefHat, IconStopwatch, IconCloche, IconSparkle] as const
