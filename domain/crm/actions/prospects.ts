'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { aresSearchByName, pickAresMatch } from '@/connectors/ares'
import { prospectFromDomainSchema } from '@/lib/validation/schemas'

// Založení klienta z domény účastníků schůzky ("Firmy mimo CRM"). Původně
// to volal automatický import schůzek z Fireflies — ten byl 2026-09-28 zrušen
// (zápisy dnes jdou z Wispr Flow přes Cowork skill a MCP), takže v aplikaci
// teď tuhle akci nic nevolá. Ponechána záměrně: validační schéma
// (prospectFromDomainSchema v lib/validation/schemas.ts) patří jinému kroku,
// a akce se hodí, až skill nebo UI začne hlásit neznámé firmy znovu.
//
// IČO se doplňuje přes STEJNÉ přísné pravidlo jako všude jinde v appce
// (pickAresMatch, connectors/ares): jen přesná shoda jména, nebo jediný výsledek
// u jmen 6+ znaků. Odvozený název domény ("spolchemie.cz" → "Spolchemie")
// není spolehlivé obchodní jméno — je to jen hádanka, dokud ji ARES
// nepotvrdí. Volnější pravidlo tu bylo už třikrát draze vyvráceno (viz
// komentář u pickAresMatch), takže se u prospektů z domény neriskuje o nic
// míň než u ručně zakládaných klientů — nejisté IČO/kraj prostě zůstane
// prázdné a doplní se přes /clients/doplnit-ico jako u každého jiného klienta.

export type FoundResult =
  | { ok: true; accountId: number; createdAccount: boolean }
  | { ok: false; error: string }

// Generické schránky nenesou jméno člověka — ponechá se celá adresa.
const GENERIC_LOCAL = new Set(['api', 'info', 'sales', 'obchod', 'podpora'])

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  if (GENERIC_LOCAL.has(local.toLowerCase())) return email
  return local.split(/[._-]+/).filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ')
}

// Domény o dvou částech, u kterých je TLD "co.uk"/"com.au" apod., ne jen
// poslední nálepka — jinak by se z "firma.co.uk" stalo jméno "Co".
const TWO_PART_TLD = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'co.nz', 'co.jp', 'com.br',
])

// Odvodí jméno klienta z domény hosta ("spolchemie.cz" → "Spolchemie").
// Je to jen výchozí odhad pro pole "název" — ARES ho buď potvrdí (a doplní
// IČO/kraj), nebo ne, a pak zůstane přesně to, co tahle funkce vrátí, dokud
// to někdo ručně neopraví na kartě klienta.
function nameFromDomain(domain: string): string {
  const labels = domain.toLowerCase().split('.').filter(Boolean)
  let core = labels
  if (labels.length > 2 && TWO_PART_TLD.has(labels.slice(-2).join('.'))) {
    core = labels.slice(0, -2)
  } else if (labels.length > 1) {
    core = labels.slice(0, -1)
  }
  const slug = core[core.length - 1] || domain
  const words = slug.split(/[-_]+/).filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  return words.join(' ') || domain
}

// ILIKE bez zástupných znaků: `%` a `_` (a samotný `\`) ve jméně se escapují,
// takže hledání zůstane přesnou shodou bez ohledu na velikost písmen —
// jméno "a_b" nesmí najít "axb", "%" nesmí najít cokoli.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Založí (nebo dohledá) klienta pro firmu, která se ukázala jako "mimo CRM"
 * v importu schůzek — jeden klik místo příštího ručního běhu skriptu.
 *
 * `domain` – doména hostů ze schůzky (např. "spolchemie.cz").
 * `emails` – e-maily účastníků na téhle doméně.
 * `sourceLabel` – odkud prospekt přišel, do poznámky. Povolené hodnoty určuje
 *   prospectSourceLabel v lib/validation/schemas.ts (zatím jen historické "Fireflies").
 */
export async function foundAccountFromDomain(
  domain: string,
  emails: string[],
  sourceLabel: string,
): Promise<FoundResult> {
  if (!await tryRequireUser({ aal2: true })) return { ok: false, error: AUTH_ERROR_MESSAGE }
  if (typeof domain !== 'string' || !domain.trim()) return { ok: false, error: 'Chybí doména.' }
  const input = prospectFromDomainSchema.safeParse({ domain, emails, sourceLabel })
  if (!input.success) return { ok: false, error: 'Neplatný vstup (doména, e-maily nebo zdroj).' }
  const cleanDomain = input.data.domain

  const s = await createClient()
  const name = nameFromDomain(cleanDomain)

  // Klient pod tímhle jménem už může existovat — třeba ho někdo mezitím
  // založil ručně, nebo firma přišla schůzkou podruhé pod jinou doménou.
  // V tom případě jen dotáhneme kontakty, druhého klienta nezakládáme.
  const { data: existing, error: lookupError } = await s
    .from('account').select('id').ilike('name', escapeLikePattern(name)).maybeSingle()
  if (lookupError) return { ok: false, error: lookupError.message }

  let accountId: number
  let createdAccount = false

  if (existing) {
    accountId = existing.id
  } else {
    const candidates = await aresSearchByName(name, 20).catch(() => [])
    const pick = pickAresMatch(name, candidates, candidates.length)

    const notes = `Prospekt odhalený ze záznamu schůzky (${input.data.sourceLabel}) — doména ${cleanDomain}. `
      + `Jméno i kontakty vznikly z e-mailů účastníků, ověř a doplň ručně.`

    const { data: created, error } = await s.from('account').insert({
      name,
      ico: pick?.company.ico ?? null,
      region: pick?.company.region ?? null,
      notes,
    }).select('id').single()
    if (error || !created) return { ok: false, error: error?.message ?? 'Klienta se nepodařilo založit.' }
    accountId = created.id
    createdAccount = true
  }

  // Kontakty z e-mailů účastníků — jen ty, které ještě neznáme (podle e-mailu).
  const wanted = [...new Set(input.data.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))]
  if (wanted.length) {
    const { data: known } = await s.from('contact').select('email').in('email', wanted)
    const have = new Set((known ?? []).map((c) => (c.email ?? '').toLowerCase()))
    const fresh = wanted.filter((e) => !have.has(e))
    if (fresh.length) {
      const { error: contactError } = await s.from('contact').insert(
        fresh.map((e) => ({ full_name: nameFromEmail(e), email: e, account_id: accountId })),
      )
      if (contactError) return { ok: false, error: contactError.message }
    }
  }

  revalidatePath('/cockpit/schuzky')
  revalidatePath('/cockpit/clients')
  revalidatePath(`/cockpit/clients/${accountId}`)
  revalidatePath('/cockpit/clients/doplnit-ico')
  return { ok: true, accountId, createdAccount }
}
