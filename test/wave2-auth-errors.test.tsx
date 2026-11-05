import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AppNotFound from '@/app/cockpit/not-found'
import RootNotFound from '@/app/not-found'
import { STATUS_PRIMARY, STATUS_SECONDARY } from '@/components/ui/StatusPanel'

// Vlna 2, chybové stránky: žádná slepá ulička (404 nabízí Dnes a hledání),
// tlačítka ze sdíleného buttonClass (koral jen jedno).

describe('chybové stránky', () => {
  test('404 v aplikaci vede na Dnes a na hledání', () => {
    const html = renderToStaticMarkup(<AppNotFound />)
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Zpět na Dnes')
    expect(html).toContain('href="/cockpit/hledat"')
    expect(html.match(/btn-primary/g)).toHaveLength(1)
  })

  test('404 mimo aplikaci má jednu hlavní akci', () => {
    const html = renderToStaticMarkup(<RootNotFound />)
    expect(html).toContain('href="/"')
    expect(html.match(/btn-primary/g)).toHaveLength(1)
  })

  test('akce stavového panelu jsou tlačítka design systému', () => {
    expect(STATUS_PRIMARY).toBe('btn btn-primary')
    expect(STATUS_SECONDARY).toBe('btn btn-outline')
  })
})
