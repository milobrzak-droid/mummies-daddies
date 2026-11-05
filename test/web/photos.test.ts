import { describe, expect, it } from 'vitest'
import { conventionalSrc, getPhoto, getPhotos, parseManifest, photoSlots } from '@/lib/web/photos'

describe('photos', () => {
  it('parseManifest: pole, {photos}, záznamy podle slotu, galerie slot.N', () => {
    expect(parseManifest([{ slot: 'home.hero', src: '/web/photos/a.jpg', alt: 'A' }]).get('home.hero')?.[0].src).toBe('/web/photos/a.jpg')
    expect(parseManifest({ photos: [{ slot: 'home.hero', file: 'b.jpg', altCs: 'B' }] }).get('home.hero')?.[0]).toMatchObject({ src: '/web/photos/b.jpg', alt: 'B' })
    const m = parseManifest({
      'catering.svatby.gallery.2': { file: '/web/photos/g2.jpg' },
      'catering.svatby.gallery.1': { file: '/web/photos/g1.jpg' },
      'home.kitchen.1': { file: '/web/photos/k1.jpg' },
    })
    expect(m.get('catering.svatby.gallery')?.map((e) => e.src)).toEqual(['/web/photos/g1.jpg', '/web/photos/g2.jpg'])
    expect(m.get('home.kitchen.1')?.[0].src).toBe('/web/photos/k1.jpg')
    expect(parseManifest({ 'home.hero': { src: 'https://cizi.example/x.jpg' } }).size).toBe(0)
  })

  it('getPhoto nikdy nespadne: neznámý slot = zástupce', () => {
    const p = getPhoto('neexistuje.slot')
    expect(p).toMatchObject({ placeholder: true, src: null })
    expect(p.alt.length).toBeGreaterThan(0)
  })

  it('každý slot z výběru vrátí fotku nebo zástupce s alt', () => {
    for (const s of photoSlots()) for (const p of getPhotos(s)) expect(p.alt.trim().length).toBeGreaterThan(0)
  })

  it('konvenční název souboru', () => {
    expect(conventionalSrc('home.hero')).toBe('/web/photos/home-hero.jpg')
    expect(conventionalSrc('catering.svatby.gallery', 1)).toBe('/web/photos/catering-svatby-gallery-2.jpg')
  })
})
