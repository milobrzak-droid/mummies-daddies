// Kontrast barevných tokenů (WCAG 2.x AA). Čte skutečné app/globals.css,
// takže když někdo změní token tak, že text na pozadí klesne pod 4,5 : 1,
// spadne tenhle test — ne až audit.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AA_LARGE, AA_TEXT, contrastRatio, flatten, mixSrgb, parseColor, readCssTokens, relativeLuminance,
} from '@/lib/contrast'
import { CHIP_TONES } from '@/components/Chip'
import { AVATAR_COLORS } from '@/components/Avatar'
import { PERSON_COLORS } from '@/components/CapacityVisuals'
import { DEAL_STAGES } from '@/lib/domain'

const tokens = readCssTokens(readFileSync('app/globals.css', 'utf8'))
const tok = (name: string) => {
  const v = tokens[name]
  if (!v) throw new Error(`Token ${name} v globals.css chybí`)
  return v
}
const resolve = (v: string) => v.replace(/^var\((--[\w-]+)\)$/, (_, n: string) => tok(n))
const HUES = ['turquoise', 'blue', 'violet', 'yellow', 'red'] as const

describe('lib/contrast', () => {
  it('parsuje hex (3 i 6 znaků), rgba a klíčová slova', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#1A1F28')).toEqual({ r: 26, g: 31, b: 40, a: 1 })
    expect(parseColor('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 })
    expect(parseColor('rgb(0,0,0)')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('var(--x)')).toBeNull()
    expect(parseColor('#12345')).toBeNull()
    expect(parseColor('rgb(300,0,0)')).toBeNull()
  })

  it('relativní jas a krajní poměry odpovídají WCAG', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10)
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#fff', '#fff')).toBeCloseTo(1, 5)
    // symetrie: nezáleží, co je popředí
    expect(contrastRatio('#5A6472', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#5A6472'), 10)
    // známá hodnota: #767676 na bílé je hranice AA (4,54 : 1)
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2)
  })

  it('průhledné popředí složí na pozadí', () => {
    expect(flatten({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 })).toEqual({ r: 128, g: 128, b: 128 })
    expect(contrastRatio('rgba(0,0,0,0)', '#FFFFFF')).toBeCloseTo(1, 5)
    expect(() => contrastRatio('#000', 'rgba(0,0,0,0.5)')).toThrow(/neprůhledné/)
    expect(() => contrastRatio('nonsense', '#fff')).toThrow(/Neznámá barva/)
  })

  it('mixSrgb odpovídá color-mix(in srgb)', () => {
    expect(mixSrgb('#000000', '#ffffff', 50)).toBe('#808080')
    expect(mixSrgb('#FF0000', 'white', 100)).toBe('#ff0000')
    expect(mixSrgb('#FF0000', 'white', 0)).toBe('#ffffff')
  })

  it('readCssTokens rozřeší var() odkazy a ignoruje komentáře', () => {
    const t = readCssTokens(':root { /* --x: #000; */ --a:#111111; --b: var(--a); --c: var(--b); }')
    expect(t).toEqual({ '--a': '#111111', '--b': '#111111', '--c': '#111111' })
  })
})

// Pozadí, na kterých v aplikaci leží text.
const LIGHT_BACKGROUNDS = ['--surface', '--bg', '--c-soft']

// Tokeny používané jako barva textu (text-*, style color, hover odkazů).
// --c-accent (coral) tu záměrně není: je jen dekorace a hlavní tlačítko;
// na text je --c-accent-text.
const TEXT_TOKENS = [
  '--fg', '--c-ink', '--c-navy', '--muted', '--c-slate', '--c-ink-2',
  '--c-pos', '--c-warn', '--c-neg', '--c-info', '--c-accent-text',
  ...HUES.map((h) => `--t-${h}`),
]

describe('tokeny v app/globals.css: text ≥ 4,5 : 1', () => {
  for (const fg of TEXT_TOKENS) {
    for (const bg of LIGHT_BACKGROUNDS) {
      it(`${fg} na ${bg}`, () => {
        expect(contrastRatio(tok(fg), tok(bg))).toBeGreaterThanOrEqual(AA_TEXT)
      })
    }
  }

  it('stavové barvy na svém měkkém podkladu (štítky, hlášky)', () => {
    for (const [fg, bg] of [
      ['--c-pos', '--c-pos-soft'], ['--c-warn', '--c-warn-soft'], ['--c-neg', '--c-neg-soft'],
      ['--c-info', '--c-info-soft'],
      ['--c-accent-text', '--c-accent-soft'],
    ]) {
      expect(contrastRatio(tok(fg), tok(bg)), `${fg} na ${bg}`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('tlačítko CTA: text na tmavém pozadí', () => {
    expect(contrastRatio(tok('--cta-fg'), tok('--cta-bg'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('průhledný bílý text na tmavých kartách (card-deep, SalesFocus)', () => {
    // nejslabší použité krytí: rgba(255,255,255,0.6) a text-white/60
    expect(contrastRatio('rgba(255,255,255,0.6)', tok('--c-navy'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('sekundární text #3A424E (Sidebar, DataTable) na světlých pozadích', () => {
    for (const bg of LIGHT_BACKGROUNDS) expect(contrastRatio('#3A424E', tok(bg))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('číslo dne na značce „Dnes“ (WorkGantt): bílé na --t-red, grafitové by nestačilo', () => {
    // paleta: --d-orange je alias --t-red (tmavá červená), bílý text na ní ≥ 4,5 : 1
    expect(contrastRatio('#FFFFFF', tok('--t-red'))).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrastRatio(tok('--c-ink'), tok('--t-red'))).toBeLessThan(AA_TEXT)
  })
})

describe('netextové prvky ≥ 3 : 1 (WCAG 1.4.11)', () => {
  it('rámeček vstupního pole je vidět na povrchu i na pozadí', () => {
    for (const bg of LIGHT_BACKGROUNDS) {
      expect(contrastRatio(tok('--c-field-line'), tok(bg)), `--c-field-line na ${bg}`).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })

  it('grafitová hrana klávesy na bílé čepičce i na povrchu', () => {
    for (const bg of ['--brand-white', '--surface']) {
      expect(contrastRatio(tok('--key-edge'), tok(bg)), `--key-edge na ${bg}`).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })

  it('grafitový text na všech barvách značky (klávesy, plné dlaždice)', () => {
    for (const bg of ['--brand-turquoise', '--brand-blue', '--brand-violet', '--brand-yellow', '--brand-red', '--brand-white']) {
      expect(contrastRatio(tok('--brand-graphite'), tok(bg)), `graphite na ${bg}`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('fokusový rámeček je vidět na všech pozadích i na tmavé kartě', () => {
    for (const bg of [...LIGHT_BACKGROUNDS, '--c-navy']) {
      expect(contrastRatio(tok('--focus-ring'), tok(bg)), `--focus-ring na ${bg}`).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })
})

describe('odvozené tóny značky (§4): plocha --p-*, data --d-*, text --t-*', () => {
  for (const h of HUES) {
    it(`${h}: text na vlastní ploše ≥ 4,5 : 1`, () => {
      expect(contrastRatio(tok(`--t-${h}`), tok(`--p-${h}`))).toBeGreaterThanOrEqual(AA_TEXT)
    })
    it(`${h}: bílý text na textovém tónu ≥ 4,5 : 1 (plná barva s bílým písmem)`, () => {
      expect(contrastRatio('#FFFFFF', tok(`--t-${h}`))).toBeGreaterThanOrEqual(AA_TEXT)
    })
    it(`${h}: grafitový text na ploše ≥ 4,5 : 1`, () => {
      expect(contrastRatio(tok('--brand-graphite'), tok(`--p-${h}`))).toBeGreaterThanOrEqual(AA_TEXT)
    })
    it(`${h}: datová barva ≥ 3 : 1 na povrchu i na pozadí`, () => {
      for (const bg of ['--surface', '--bg']) {
        expect(contrastRatio(tok(`--d-${h}`), tok(bg)), `--d-${h} na ${bg}`).toBeGreaterThanOrEqual(AA_LARGE)
      }
    })
  }

  it('neutrální a grafitová datová barva ≥ 3 : 1 na povrchu', () => {
    for (const d of ['--d-neutral', '--d-graphite']) {
      expect(contrastRatio(tok(d), tok('--surface')), d).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })

  it('stavové tokeny jsou tóny značky (žádná druhá paleta)', () => {
    expect(tok('--c-pos')).toBe(tok('--t-turquoise'))
    expect(tok('--c-warn')).toBe(tok('--t-yellow'))
    expect(tok('--c-neg')).toBe(tok('--t-red'))
    expect(tok('--c-info')).toBe(tok('--t-blue'))
  })

  it('bílý text na --d-orange (značka „Dnes“ v Ganttu) ≥ 4,5 : 1', () => {
    expect(contrastRatio('#FFFFFF', tok('--d-orange'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('barvy fází obchodu jsou tokeny --d-* a vidět na bílé (≥ 3 : 1)', () => {
    for (const s of DEAL_STAGES) {
      expect(s.tone, s.key).toMatch(/^var\(--d-[\w-]+\)$/)
      expect(contrastRatio(resolve(s.tone), tok('--surface')), s.key).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })

  it('barvy osob v kapacitách jsou tokeny a ≥ 3 : 1 na bílé', () => {
    for (const c of PERSON_COLORS) {
      expect(c).toMatch(/^var\(--[\w-]+\)$/)
      expect(contrastRatio(resolve(c), tok('--surface')), c).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })

  it('avatar: grafitové iniciály na barvě značky ≥ 4,5 : 1, bez červené', () => {
    for (const c of AVATAR_COLORS) {
      expect(contrastRatio(tok('--brand-graphite'), resolve(c)), c).toBeGreaterThanOrEqual(AA_TEXT)
    }
    expect(AVATAR_COLORS).not.toContain('var(--brand-red)')
  })
})

describe('Chip: text každého tónu na vlastním podkladu ≥ 4,5 : 1', () => {
  for (const [tone, c] of Object.entries(CHIP_TONES)) {
    it(tone, () => {
      expect(contrastRatio(resolve(c.fg), resolve(c.bg))).toBeGreaterThanOrEqual(AA_TEXT)
    })
  }
  it('žádné ruční hex hodnoty, jen tokeny', () => {
    for (const c of Object.values(CHIP_TONES)) {
      for (const v of [c.bg, c.fg, c.dot]) expect(v).toMatch(/^var\(--[\w-]+\)$/)
    }
  })
})
