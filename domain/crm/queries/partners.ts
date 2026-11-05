import { createClient } from '@/lib/supabase/server'
import type { Partner, PartnerWithVia, PartnerRegistration, Contact } from '@/lib/types'
import type { SalesActivityLike } from '@/domain/crm/sales'

// Stejné embedy jako v domain/crm/queries/sales.ts, jen bez `account` — aktivita
// partnera má account_id NULL (viz CHECK v migraci 0021), takže by embed
// stejně vždy vrátil null.
const PARTNER_ACTIVITY_SELECT = [
  '*',
  'deal:deal!sales_activity_deal_id_fkey(id, title)',
  'contact:contact!sales_activity_contact_id_fkey(id, full_name)',
  'author:team_member!sales_activity_created_by_fkey(id, full_name)',
].join(', ')

// PostgREST neumí self-referenční embed (partner→partner přes via_partner_id),
// takže „přes koho" dopočítáme v JS — partnerů je pár, žádný problém.
export async function listPartners(): Promise<PartnerWithVia[]> {
  const s = await createClient()
  const { data, error } = await s.from('partner').select('*').order('name')
  if (error) throw error
  const rows = (data ?? []) as unknown as Partner[]
  const nameById = new Map(rows.map((p) => [p.id, p.name]))
  return rows.map((p) => ({
    ...p,
    via: p.via_partner_id ? { id: p.via_partner_id, name: nameById.get(p.via_partner_id) ?? '' } : null,
  }))
}
export async function getPartnerContacts(partnerId: number): Promise<Contact[]> {
  const s = await createClient()
  const { data, error } = await s.from('contact').select('*')
    .eq('partner_id', partnerId).order('full_name')
  if (error) throw error
  return data ?? []
}
export async function getPartnerActivities(partnerId: number, limit = 50): Promise<SalesActivityLike[]> {
  const s = await createClient()
  const { data, error } = await s.from('sales_activity')
    .select(PARTNER_ACTIVITY_SELECT)
    .eq('partner_id', partnerId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as unknown as SalesActivityLike[]
}
export async function getPartner(id: number): Promise<Partner | null> {
  const s = await createClient()
  const { data, error } = await s.from('partner').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}
export async function getRegistrations(partnerId: number): Promise<PartnerRegistration[]> {
  const s = await createClient()
  const { data, error } = await s.from('partner_registration').select('*').eq('partner_id', partnerId)
  if (error) throw error
  return data ?? []
}
export async function listRegistrations(): Promise<(PartnerRegistration & { partner_name: string })[]> {
  const s = await createClient()
  const { data, error } = await s.from('partner_registration')
    .select('*, partner(name)').order('partner_id')
  if (error) throw error
  // PostgREST embeds the to-one `partner` relation as a nested object; type it
  // explicitly (no `any`) so the embedded name is safe to read.
  type Row = PartnerRegistration & { partner: { name: string } | null }
  return ((data ?? []) as unknown as Row[]).map((r) => ({ ...r, partner_name: r.partner?.name ?? '' }))
}
