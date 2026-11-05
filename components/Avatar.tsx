// Kulatý avatar s iniciálami. Barva jen rozlišuje lidi (stálá podle jména):
// plné barvy značky s grafitovým písmem jako na klávesách webu. Červená
// mezi nimi není – ta znamená problém (docs/PROVOZ.md §4).
export const AVATAR_COLORS = [
  'var(--brand-turquoise)', 'var(--brand-blue)', 'var(--brand-violet)', 'var(--brand-yellow)',
] as const

export function avatarColor(name: string): string {
  let n = 0
  for (const ch of name || '?') n = (n + ch.charCodeAt(0)) % 997
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const initials =
    (name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-heading font-bold shrink-0"
      style={{ width: size, height: size, background: avatarColor(name), color: 'var(--brand-graphite)', fontSize: Math.round(size * 0.38) }}
      aria-hidden
    >
      {initials}
    </span>
  )
}
