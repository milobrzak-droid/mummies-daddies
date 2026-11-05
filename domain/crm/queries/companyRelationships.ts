import { createClient } from '@/lib/supabase/server'
import type { CompanyAlias, Relationship } from '@/lib/types'

// Aliasy patřící k účtu — doména/název, pod kterými firma chodí jinde, ale
// je to reálně stejný vztah (viz migrace 0033).
export async function listAliasesForAccount(accountId: number): Promise<CompanyAlias[]> {
  const s = await createClient()
  const { data, error } = await s.from('company_alias').select('*')
    .eq('account_id', accountId).order('created_at')
  if (error) throw error
  return data ?? []
}

export type RelationshipWithParent = Relationship & { parent: { id: number; name: string } | null }
export type RelationshipWithChild = Relationship & { child: { id: number; name: string } | null }

// Firmy, pro které je tenhle účet dceřinou společností (tenhle účet je child).
export async function listParentRelationships(accountId: number): Promise<RelationshipWithParent[]> {
  const s = await createClient()
  const { data, error } = await s.from('relationship')
    .select('*, parent:account!relationship_parent_account_id_fkey(id, name)')
    .eq('child_account_id', accountId)
    .order('created_at')
  if (error) throw error
  return (data ?? []) as unknown as RelationshipWithParent[]
}

// Firmy, které jsou dceřiné společnosti tohohle účtu (tenhle účet je parent).
export async function listChildRelationships(accountId: number): Promise<RelationshipWithChild[]> {
  const s = await createClient()
  const { data, error } = await s.from('relationship')
    .select('*, child:account!relationship_child_account_id_fkey(id, name)')
    .eq('parent_account_id', accountId)
    .order('created_at')
  if (error) throw error
  return (data ?? []) as unknown as RelationshipWithChild[]
}

// ---------------------------------------------------------------------------
// Čistá funkce (žádné I/O), proto tady a ne v domain/crm/actions/companyRelationships.ts
// — ten soubor má nahoře 'use server', takže Next.js bere každý jeho export
// jako Server Akci a vyžaduje, aby byla async (stejný důvod jako u
// dealAuditDiff v core/audit.ts).
//
// UNIQUE index na (parent_account_id, child_account_id) v migraci 0033
// zabrání přesnému duplicitnímu řádku, ale ne opačnému směru — Postgres
// CHECK nesmí sahat na jiné řádky, takže "A je matka B, zároveň B je matka
// A" (přímý dvouřádkový cyklus) musí hlídat appka před zápisem. Nejde o
// vyčerpanou detekci cyklů v grafu (to by pro "mateřské a dceřiné vztahy"
// bylo přestřelené) — jen tenhle konkrétní a nejčastější případ.
export type RelationshipPair = { parent_account_id: number; child_account_id: number }

export function wouldCreateDirectCycle(
  existing: RelationshipPair[],
  candidate: RelationshipPair,
): boolean {
  return existing.some(
    (r) => r.parent_account_id === candidate.child_account_id && r.child_account_id === candidate.parent_account_id,
  )
}
