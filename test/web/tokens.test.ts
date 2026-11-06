import { describe, expect, it } from 'vitest'
import { colors } from '@/lib/web/tokens'

function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

describe('kontrast tokenů (WCAG AA 4,5 : 1 pro text)', () => {
  const surfaces = {
    cream: colors.cream, paper: colors.paper,
    blush: colors.blush.DEFAULT, sage: colors.sage.DEFAULT, vanilla: colors.vanilla.DEFAULT, pistachio: colors.pistachio.DEFAULT,
  }
  for (const [name, bg] of Object.entries(surfaces)) {
    it(`cocoa a cocoa-soft na ${name}`, () => {
      expect(contrast(colors.cocoa.DEFAULT, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors.cocoa.soft, bg)).toBeGreaterThanOrEqual(4.5)
    })
  }
  it('sytější tóny (zástupci fotek) nesou jen cocoa', () => {
    for (const bg of [colors.blush.deep, colors.sage.deep, colors.vanilla.deep, colors.pistachio.deep]) {
      expect(contrast(colors.cocoa.DEFAULT, bg)).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('bílý text na malinovém tlačítku (ink i hover)', () => {
    expect(contrast(colors.paper, colors.raspberry.ink)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.paper, colors.raspberry.deep)).toBeGreaterThanOrEqual(4.5)
  })
  it('malinová cena na krémové a bílé', () => {
    expect(contrast(colors.raspberry.ink, colors.cream)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.raspberry.ink, colors.paper)).toBeGreaterThanOrEqual(4.5)
  })
  it('krémový text na kakaové patičce', () => {
    expect(contrast(colors.cream, colors.cocoa.DEFAULT)).toBeGreaterThanOrEqual(7)
  })

})

// Web v2 (docs/web-v2-design.md §1.3): páry, které design používá, a páry, které zakazuje.
describe('kontrast palety v2 (Mummy malina + Daddy modrá)', () => {
  const text = (fg: string, bg: string) => expect(contrast(fg, bg), `${fg} na ${bg}`).toBeGreaterThanOrEqual(4.5)
  const large = (fg: string, bg: string) => expect(contrast(fg, bg), `${fg} na ${bg}`).toBeGreaterThanOrEqual(3)

  it('ink a ink-soft na všech plochách v2 (krém, papír, tinty, máslová)', () => {
    for (const bg of [colors.cream, colors.paper, colors.daddy.tint, colors.raspberry.tint, colors.butter]) {
      text(colors.cocoa.DEFAULT, bg)
      text(colors.cocoa.soft, bg)
    }
  })

  it('krémový text na plných tlačítkách (malina, modrá) i jejich hoveru', () => {
    for (const bg of [colors.raspberry.ink, colors.raspberry.deep, colors.daddy.ink, colors.daddy.deep]) {
      text(colors.cream, bg)
      text(colors.paper, bg)
    }
  })

  it('malinový a modrý text pod 24 px na krému a papíru (ink varianty), akcentová modrá', () => {
    for (const bg of [colors.cream, colors.paper]) {
      text(colors.raspberry.ink, bg)
      text(colors.daddy.ink, bg)
      text(colors.daddy.DEFAULT, bg)
    }
    text(colors.daddy.ink, colors.raspberry.tint)
  })

  it('akcentová malina (#D23F6B) jen pro velký text: ≥ 3 : 1 na krému i tintech, < 4,5 na krému', () => {
    for (const bg of [colors.cream, colors.paper, colors.daddy.tint, colors.raspberry.tint]) large(colors.raspberry.DEFAULT, bg)
    expect(contrast(colors.raspberry.DEFAULT, colors.cream)).toBeLessThan(4.5)
    large(colors.raspberry.ink, colors.daddy.tint)
  })

  it('patička: krém, malina a modrá na ink', () => {
    expect(contrast(colors.cream, colors.cocoa.DEFAULT)).toBeGreaterThanOrEqual(7)
    text(colors.raspberry.onInk, colors.cocoa.DEFAULT)
    text(colors.daddy.onInk, colors.cocoa.DEFAULT)
    text(colors.butter, colors.cocoa.DEFAULT)
  })

  it('stavy formulářů na krému', () => {
    for (const fg of [colors.danger, colors.success, colors.warning]) text(fg, colors.cream)
  })

  it('zakázané páry: tmavý text na plné malině / modré nesplňuje AA (proto se nepoužívá)', () => {
    expect(contrast(colors.cocoa.DEFAULT, colors.raspberry.DEFAULT)).toBeLessThan(4.5)
    expect(contrast(colors.cocoa.DEFAULT, colors.daddy.DEFAULT)).toBeLessThan(4.5)
  })

  it('netextové prvky: 2px ink linka a modrý prstenec fokusu na krému ≥ 3 : 1', () => {
    large(colors.hairline, colors.cream)
    large(colors.daddy.ink, colors.cream)
  })
})
