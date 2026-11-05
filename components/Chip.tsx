import { ReactNode } from 'react'

// Čip = měkký štítek stavu, druhu nebo kategorie. Každý tón je trojice tokenů
// z app/globals.css (docs/PROVOZ.md §4): plocha (--p-*), text (--t-*)
// a tečka (--d-*). Kontrast textu na ploše ≥ 4,5 : 1 hlídá
// test/contrast-tokens.test.ts pro každý tón zvlášť.
export type ChipTone = { bg: string; fg: string; dot: string }

const tone = (name: 'turquoise' | 'blue' | 'violet' | 'yellow' | 'red'): ChipTone => ({
  bg: `var(--p-${name})`, fg: `var(--t-${name})`, dot: `var(--d-${name})`,
})

export const CHIP_TONES: Record<string, ChipTone> = {
  // neutrální: bez významu
  neutral: { bg: 'var(--c-soft)', fg: 'var(--c-slate)', dot: 'var(--d-neutral)' },
  ink: { bg: 'var(--c-soft)', fg: 'var(--c-ink)', dot: 'var(--c-ink)' },
  accent: { bg: 'var(--c-accent-soft)', fg: 'var(--c-accent-text)', dot: 'var(--c-accent)' },
  // stavy (§4: tyrkysová hotovo, žlutá čeká, červená problém, modrá informace)
  pos: tone('turquoise'),
  warn: tone('yellow'),
  neg: tone('red'),
  info: tone('blue'),
  // barvy značky podle druhu věci (modrá firma, fialová rozhodnutí / kontakt)
  turquoise: tone('turquoise'),
  blue: tone('blue'),
  violet: tone('violet'),
  yellow: tone('yellow'),
  red: tone('red'),
  // staré názvy (drží kompatibilitu volání)
  teal: tone('turquoise'),
  purple: tone('violet'),
  sun: tone('yellow'),
  coral: { bg: 'var(--c-accent-soft)', fg: 'var(--c-accent-text)', dot: 'var(--c-accent)' },
  navy: { bg: 'var(--c-soft)', fg: 'var(--c-ink)', dot: 'var(--c-ink)' },
  muted: { bg: 'var(--c-soft)', fg: 'var(--c-slate)', dot: 'var(--d-neutral)' },
}

// `dot`: tečka v barvě tónu před textem (stav: hotovo, čeká, chyba). Stav je
// vždy i slovem, tečka jen pomáhá skenovat seznam.
export function Chip({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: string; dot?: boolean }) {
  const c = CHIP_TONES[tone] ?? CHIP_TONES.neutral
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-[1.45] whitespace-nowrap"
      style={{ background: c.bg, color: c.fg, borderColor: `color-mix(in srgb, ${c.dot} 22%, white)` }}
    >
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c.dot }} />}
      {children}
    </span>
  )
}

// Tón čipu podle fáze obchodu: barva nese význam fáze (§4), ne pořadí.
export const STAGE_CHIP_TONE: Record<string, string> = {
  kvalifikace: 'neutral',
  diagnostika: 'blue',
  rozsah_nabidka: 'yellow',
  rozhodovani: 'violet',
  'vyhráno': 'pos',
  'prohráno': 'neg',
  'odloženo': 'neutral',
}

// Stálý tón pro libovolný klíč (program partnera, druh dokumentu…), kde barva
// jen rozlišuje kategorie. Jen klidné tóny bez stavového významu (žádná
// tyrkysová „hotovo“, žlutá „čeká“ ani červená „problém“).
const TONE_KEYS = ['blue', 'violet', 'neutral']
export function toneForKey(key: string): string {
  let n = 0
  for (const ch of key) n = (n + ch.charCodeAt(0)) % 997
  return TONE_KEYS[n % TONE_KEYS.length]
}
