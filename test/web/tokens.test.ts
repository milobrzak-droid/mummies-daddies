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
