// Políčko „Nesouhlasí s oslovením" (0087) ve formuláři kontaktu a štítek
// u kontaktu / firmy. Statické vykreslení, bez prohlížeče.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContactForm } from '@/components/ContactForm'
import { ContactOptOutChip, DoNotContactChip } from '@/components/DoNotContactChip'
import type { Contact } from '@/lib/types'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const action = async () => ({ success: true as const })
const base: Contact = {
  id: 1, account_id: 2, partner_id: null, full_name: 'Petra Nováková', role: null, email: null, phone: null,
  notes: null, is_champion: false, created_at: '2026-01-01',
}

describe('ContactForm', () => {
  it('nový kontakt: zaškrtávátko nezaškrtnuté, pole „Odkud / proč" v obalu, který ho CSS schová', () => {
    const html = renderToStaticMarkup(<ContactForm action={action} />)
    expect(html).toContain('Nesouhlasí s oslovením')
    const box = html.match(/<input[^>]*name="do_not_contact"[^>]*>/)![0]
    expect(box).toContain('class="optout-toggle"')
    expect(box).not.toContain('checked')
    expect(html).toContain('class="optout-reason"')
    expect(html).toContain('name="do_not_contact_reason"')
    expect(html).toContain('maxLength="300"')
  })

  it('úprava kontaktu s nesouhlasem: zaškrtnuté, důvod a kdo/kdy v nápovědě', () => {
    const html = renderToStaticMarkup(
      <ContactForm
        action={action}
        initial={{ ...base, do_not_contact: true, do_not_contact_reason: 'Řekla na veletrhu', do_not_contact_at: '2026-09-29T08:00:00Z' }}
        optOutInfo="Zapsáno 29. 9. 2026 (Viktor Kovář). Odškrtnutím se nesouhlas zruší."
      />,
    )
    expect(html.match(/<input[^>]*name="do_not_contact"[^>]*>/)![0]).toContain('checked=""')
    expect(html).toContain('value="Řekla na veletrhu"')
    expect(html).toContain('Zapsáno 29. 9. 2026 (Viktor Kovář)')
  })

  it('CSS pravidlo pro schování důvodu existuje v globals.css', () => {
    const css = readFileSync('app/globals.css', 'utf8')
    expect(css).toContain('.optout-group:not(:has(.optout-toggle:checked)) .optout-reason { display: none; }')
  })
})

describe('štítky', () => {
  it('kontakt: políčko, poznámka, nic', () => {
    expect(renderToStaticMarkup(<ContactOptOutChip contact={{ do_not_contact: true, notes: null }} />)).toContain('>Nesouhlasí s oslovením<')
    expect(renderToStaticMarkup(<ContactOptOutChip contact={{ notes: 'Nekontaktovat.' }} />)).toContain('Nesouhlasí s oslovením (podle poznámky)')
    expect(renderToStaticMarkup(<ContactOptOutChip contact={{ do_not_contact: false, notes: 'Volat ráno.' }} />)).toBe('')
  })

  it('firma s počtem', () => {
    expect(renderToStaticMarkup(<DoNotContactChip detail="1 z 3" />)).toContain('Nesouhlasí s oslovením (1 z 3)')
  })
})
