// Přiřazení e-mailu k firmě pro last_inbound_at / last_outbound_at
// (docs/PROVOZ.md, kapitola 8). Čistá funkce, bez I/O.
//
// Stejná filozofie jako matchMeeting: radši nic než špatná vazba. E-mail
// přiřadíme jen tehdy, když protistrana vede na právě jednu firmu a mezi
// adresáty není žádná neznámá firemní doména.
//
// Soukromí: výsledek NIKDY nenese e-mailovou adresu. U neznámé firmy vrací
// nanejvýš firemní doménu; neznámý freemail nevrací vůbec nic — gmail.com
// o člověku nic firemního neříká a jeho adresu nemáme proč uchovávat.

import { FREEMAIL, domainOf } from '@/domain/crm/meetingMatch'
import { COMPANY } from '@/config'

export type MailDirection = 'inbound' | 'outbound'

export type MailContact = { id: number; email: string; account_id: number | null }
export type MailAlias = { domain: string; account_id: number }

export type MailMatchInput = {
  direction: MailDirection
  /** Protistrana: u příchozí odesílatel, u odchozí příjemci (to/cc). */
  counterparts: string[]
  contacts: MailContact[]
  aliases: MailAlias[]
  ourDomain?: string
}

export type MailMatchResult =
  | { status: 'matched'; direction: MailDirection; account_id: number; contact_id: number | null }
  | { status: 'ambiguous'; direction: MailDirection; counterpart_domain: null }
  | { status: 'unknown'; direction: MailDirection; counterpart_domain: string | null }
  /** Jen naše adresy — žádná událost se nezapisuje. */
  | { status: 'internal'; direction: MailDirection }

export const OUR_DOMAIN = COMPANY.emailDomain

function norm(email: string): string | null {
  const e = email.trim().toLowerCase()
  const d = domainOf(e)
  return d && e.indexOf('@') > 0 ? e : null
}

export function matchMail(input: MailMatchInput): MailMatchResult {
  const { direction } = input
  const ours = (input.ourDomain ?? OUR_DOMAIN).toLowerCase()

  const byEmail = new Map<string, MailContact>()
  const byDomain = new Map<string, Set<number>>()
  for (const c of input.contacts) {
    const e = norm(c.email)
    if (!e || c.account_id == null) continue
    byEmail.set(e, c)
    const d = domainOf(e)!
    if (FREEMAIL.has(d)) continue // freemail doména nikdy neznamená firmu
    if (!byDomain.has(d)) byDomain.set(d, new Set())
    byDomain.get(d)!.add(c.account_id)
  }
  const byAlias = new Map<string, Set<number>>()
  for (const a of input.aliases) {
    const d = a.domain.trim().toLowerCase().replace(/^@/, '')
    if (!d || FREEMAIL.has(d)) continue
    if (!byAlias.has(d)) byAlias.set(d, new Set())
    byAlias.get(d)!.add(a.account_id)
  }

  const guests = [...new Set(input.counterparts.map(norm).filter((e): e is string => !!e))]
    .filter((e) => domainOf(e) !== ours)
  if (guests.length === 0) return { status: 'internal', direction }

  const accounts = new Set<number>()
  const contactsHit = new Map<number, number>() // contact_id -> account_id
  const unknownCorporate = new Set<string>()
  let conflict = false // jedna doména vede na víc firem

  for (const g of guests) {
    const d = domainOf(g)!
    const exact = byEmail.get(g)
    if (exact && exact.account_id != null) {
      accounts.add(exact.account_id)
      contactsHit.set(exact.id, exact.account_id)
      continue
    }
    if (FREEMAIL.has(d)) continue // neznámý freemail: žádná stopa
    const viaDomain = byDomain.get(d) ?? byAlias.get(d)
    if (!viaDomain) {
      unknownCorporate.add(d)
      continue
    }
    if (viaDomain.size > 1) conflict = true
    viaDomain.forEach((a) => accounts.add(a))
  }

  if (accounts.size === 1 && unknownCorporate.size === 0 && !conflict) {
    const account_id = [...accounts][0]
    const hits = [...contactsHit.keys()]
    return { status: 'matched', direction, account_id, contact_id: hits.length === 1 ? hits[0] : null }
  }
  if (accounts.size > 0) return { status: 'ambiguous', direction, counterpart_domain: null }
  return {
    status: 'unknown',
    direction,
    counterpart_domain: unknownCorporate.size === 1 ? [...unknownCorporate][0] : null,
  }
}
