// Sdílené lineární ikony (docs/PROVOZ.md §7): 24 × 24, tah 2, kulaté
// konce, currentColor, vždy aria-hidden – význam nese text vedle ikony.
// Místo textových znaků ✓ ✗ ⚠ › →, které se v různých písmech kreslí různě.

const ICON_PROPS = {
  'aria-hidden': true, focusable: false, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
} as const

type IconProps = { size?: number; className?: string }

export function CheckIcon({ size = 16, className }: IconProps) {
  return <svg {...ICON_PROPS} width={size} height={size} strokeWidth={2.2} className={className}><path d="m5 12 5 5 9-10" /></svg>
}
export function CrossIcon({ size = 16, className }: IconProps) {
  return <svg {...ICON_PROPS} width={size} height={size} strokeWidth={2.2} className={className}><path d="M6 6l12 12M18 6 6 18" /></svg>
}
export function WarnIcon({ size = 16, className }: IconProps) {
  return <svg {...ICON_PROPS} width={size} height={size} className={className}><path d="M12 3 2 20h20zM12 9v5M12 17h.01" /></svg>
}
export function ChevronRightIcon({ size = 16, className }: IconProps) {
  return <svg {...ICON_PROPS} width={size} height={size} className={className}><path d="m9 6 6 6-6 6" /></svg>
}
export function ArrowRightIcon({ size = 16, className }: IconProps) {
  return <svg {...ICON_PROPS} width={size} height={size} className={className}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
}
export function ArrowUpRightIcon({ size = 18, className }: IconProps) {
  return <svg {...ICON_PROPS} width={size} height={size} className={className}><path d="M7 17 17 7M8 7h9v9" /></svg>
}
