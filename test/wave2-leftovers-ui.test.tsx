import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BackLink, FormCard, REST_BTN_CORAL, REST_BTN_DANGER, REST_BTN_SOFT } from '@/components/ui/RestForm'
import { buttonClass } from '@/components/ui/Button'

// Drobnosti po vlně 2 (docs/PROVOZ.md §13 Průřezově): tlačítka
// formulářových stránek přes buttonClass() a nadpisy oddílů přes škálu
// text-title2 / text-headline, ne ručně psané třídy.

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('RestForm: tlačítka přes buttonClass', () => {
  test('konstanty jsou třídy z buttonClass, žádné ruční pilulky', () => {
    expect(REST_BTN_SOFT).toBe(buttonClass('outline'))
    expect(REST_BTN_DANGER).toBe(buttonClass('danger'))
    expect(REST_BTN_CORAL).toBe(buttonClass('primary'))
    const src = stripComments(readFileSync('components/ui/RestForm.tsx', 'utf8'))
    expect(src).toContain("from '@/components/ui/Button'")
    for (const hand of ['btn-coral', 'rounded-full', 'px-4 py-2', 'px-5 py-2.5', 'min-h-[44px] md:min-h-0']) expect(src).not.toContain(hand)
  })

  test('zpětný odkaz je obrysové tlačítko z design systému', () => {
    const html = renderToStaticMarkup(<BackLink href="/cockpit/clients/1">Klient</BackLink>)
    expect(html).toContain('class="btn btn-outline"')
    expect(html).toContain('href="/cockpit/clients/1"')
    expect(html).toContain('← Klient')
  })

  test('nadpis karty je text-title2', () => {
    const html = renderToStaticMarkup(<FormCard id="x" title="Předplatné">obsah</FormCard>)
    expect(html).toMatch(/<h2 id="x-title" class="[^"]*text-title2/)
    expect(html).not.toContain('text-[18px]')
  })
})

describe('nadpisy oddílů', () => {
  test.each([
    ['components/ImportOfferForm.tsx', 'Zkontroluj návrh a potvrď'],
    ['components/HandoffChecklistCard.tsx', 'Předání'],
  ])('%s: h2 ze škály typografie', (file, text) => {
    const src = stripComments(readFileSync(file, 'utf8'))
    const h2 = new RegExp(`<h2 className="([^"]*)">${text}</h2>`).exec(src)
    expect(h2, `h2 „${text}“ nenalezen`).not.toBeNull()
    expect(h2![1]).toMatch(/text-title2|text-headline|text-title1/)
    expect(h2![1]).not.toMatch(/text-\[\d+px\]|text-base|text-sm/)
  })
})
