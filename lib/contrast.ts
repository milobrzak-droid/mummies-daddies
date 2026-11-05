// Kontrast barev podle WCAG 2.x (relativní jas, poměr 1:1 až 21:1).
// Čisté funkce bez závislostí: používá je test barevných tokenů
// (test/contrast-tokens.test.ts), který čte app/globals.css a hlídá,
// aby žádná dvojice „text na pozadí“ neklesla pod 4,5 : 1 (AA).

export type Rgb = { r: number; g: number; b: number }
export type Rgba = Rgb & { a: number }

/** Minimální poměr pro běžný text (WCAG 1.4.3 AA). */
export const AA_TEXT = 4.5
/** Minimální poměr pro velký text a netextové prvky (1.4.3 / 1.4.11 AA). */
export const AA_LARGE = 3

/** `#abc`, `#aabbcc` nebo `rgba(r,g,b,a)` → barva; jinak null. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase()
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    }
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s)
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number)
    const a = fn[4] === undefined ? 1 : Number(fn[4])
    if ([r, g, b].some((v) => v > 255) || a > 1) return null
    return { r, g, b, a }
  }
  return null
}

/** Průhlednou barvu složí na neprůhledné pozadí (alpha compositing). */
export function flatten(fg: Rgba, bg: Rgb): Rgb {
  const mix = (f: number, b: number) => Math.round(f * fg.a + b * (1 - fg.a))
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) }
}

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * Obdoba CSS `color-mix(in srgb, a pct%, b)`: lineární míchání kanálů
 * v (gama-kódovaném) sRGB. Vrací `#rrggbb`.
 */
export function mixSrgb(a: string, b: string, pctA: number): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) throw new Error(`Neznámá barva: ${!ca ? a : b}`)
  const w = pctA / 100
  const ch = (x: number, y: number) => Math.round(x * w + y * (1 - w)).toString(16).padStart(2, '0')
  return `#${ch(ca.r, cb.r)}${ch(ca.g, cb.g)}${ch(ca.b, cb.b)}`
}

/** Relativní jas podle WCAG (0 = černá, 1 = bílá). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * Kontrastní poměr popředí vůči pozadí. Průhledné popředí se nejdřív složí
 * na pozadí; pozadí musí být neprůhledné (jinak chyba — nevíme, co je pod ním).
 */
export function contrastRatio(fg: string, bg: string): number {
  const f = parseColor(fg)
  const b = parseColor(bg)
  if (!f || !b) throw new Error(`Neznámá barva: ${!f ? fg : bg}`)
  if (b.a !== 1) throw new Error(`Pozadí musí být neprůhledné: ${bg}`)
  const l1 = relativeLuminance(flatten(f, b))
  const l2 = relativeLuminance(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Z textu CSS vytáhne proměnné z bloku `:root { … }` a rozřeší odkazy
 * `var(--x)`. Hodnoty, které nejsou barvou ani odkazem, nechá, jak jsou.
 */
export function readCssTokens(css: string): Record<string, string> {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  if (!root) return {}
  const raw: Record<string, string> = {}
  for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) raw[m[1]] = m[2].trim()
  const resolve = (value: string, depth = 0): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value)
    if (!ref || depth > 10) return value
    const next = raw[ref[1]]
    return next === undefined ? value : resolve(next, depth + 1)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = resolve(v)
  return out
}
