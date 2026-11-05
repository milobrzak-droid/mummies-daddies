/** Ikony jen pro stránky cateringu (sdílené icons.tsx se nemění). Dekorativní. */
export function IconCheck({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}

/** Drobný ornament (oddělovač chodů v menu). */
export function Ornament({ className }: { className?: string }) {
  return (
    <svg width="56" height="10" viewBox="0 0 56 10" fill="none" aria-hidden="true" focusable="false" className={className}>
      <path d="M0 5h22M34 5h22" stroke="currentColor" strokeWidth="1" />
      <path d="M28 1.5 31.5 5 28 8.5 24.5 5Z" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}
