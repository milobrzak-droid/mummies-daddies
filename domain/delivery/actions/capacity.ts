'use server'
// Zápisy kapacit a alokací (kap. 10, migrace 0062_capacity.sql).
//
// Každá exportovaná akce začíná tryRequireUser({ aal2: true }). Zápisy jdou
// přes uživatelského klienta (RLS team_all + RESTRICTIVE AAL2); admin klient
// tu není potřeba. created_by neposíláme — DB ho doplní z auth.uid()
// a trigger z 0062 odmítne cokoli jiného.
//
// Kapacita: team_member uživatelská session vůbec neupravuje (0062 ruší
// team_self a odebírá UPDATE), proto změna kapacity jde přes RPC set_weekly_capacity,
// které samo hlídá AAL2 a pravidlo „admin a vedení komukoli, ostatní sobě"
// (canSetCapacity v domain/delivery/capacity.ts je jeho zrcadlo pro UI).
//
// Před migrací 0062: chybějící tabulka / funkce → klidná česká hláška.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { pragueToday } from '@/lib/pragueDate'
import { isMissingFunction } from '@/lib/queries/dealPublic'
import { isMissingRelation } from '@/core/loopQueries'
import {
  parseAllocationCreate,
  parseAllocationUpdate,
  parseCapacity,
  planAllocationEnd,
  type AllocationInsert,
} from '@/domain/delivery/capacity'
import { z } from 'zod'

const MISSING_MIGRATION = 'Kapacity ještě nejsou dostupné — čekají na migraci 0062.'
const NOT_FOUND_ALLOCATION = 'Alokace nebyla nalezena.'
const NOT_FOUND_ENGAGEMENT = 'Dodávka nebyla nalezena.'
const CHECK_FAILED = 'Údaje alokace neprošly kontrolou (hodiny 0,1–80, konec ne před začátkem, zástup jiný člověk).'
const REFERENCE_GONE = 'Vybraný člověk, dodávka nebo případ už neexistuje.'

const ENGAGEMENT_EDIT_PATTERN = '/cockpit/clients/[id]/engagements/[engagementId]/edit'

type Db = Awaited<ReturnType<typeof createClient>>
type DbError = { code?: string; message?: string } | null

function revalidateCapacity(): void {
  revalidatePath('/cockpit/kapacity')
  // Sekce „Kdo na tom pracuje" na stránce dodávky.
  revalidatePath(ENGAGEMENT_EDIT_PATTERN, 'page')
}

function writeError(error: DbError): string {
  if (isMissingRelation(error)) return MISSING_MIGRATION
  if (error?.code === '23514') return CHECK_FAILED
  if (error?.code === '23503') return REFERENCE_GONE
  return dbErrorMessage('action.capacity', error)
}

async function insertAllocation(s: Db, row: AllocationInsert): Promise<ActionResult> {
  const { error } = await s.from('allocation').insert(row)
  if (error) return { success: false, error: writeError(error) }
  revalidateCapacity()
  return { success: true }
}

type LoadedAllocation = { id: number; member_id: string; starts_on: string; ends_on: string | null }

async function loadAllocation(s: Db, allocationId: number): Promise<{ ok: true; row: LoadedAllocation } | { ok: false; error: string }> {
  const { data, error } = await s
    .from('allocation')
    .select('id, member_id, starts_on, ends_on')
    .eq('id', allocationId)
    .maybeSingle()
  if (isMissingRelation(error)) return { ok: false, error: MISSING_MIGRATION }
  if (error) return { ok: false, error: dbErrorMessage('action.capacity', error) }
  if (!data) return { ok: false, error: NOT_FOUND_ALLOCATION }
  return { ok: true, row: data as LoadedAllocation }
}

/** Nová alokace ze stránky /kapacity (cíl z pole target). */
export async function createAllocation(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = parseAllocationCreate(Object.fromEntries(formData.entries()))
  if (!parsed.ok) return { success: false, fieldErrors: parsed.fieldErrors }
  const s = await createClient()
  return insertAllocation(s, parsed.data)
}

/** Nová alokace ze stránky dodávky — cíl je vždy tahle dodávka této firmy. */
export async function createEngagementAllocation(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = parseAllocationCreate(Object.fromEntries(formData.entries()), {
    engagement_id: engagementId,
    work_case_id: null,
  })
  if (!parsed.ok) return { success: false, fieldErrors: parsed.fieldErrors }
  const s = await createClient()
  // Dodávka musí patřit k firmě z URL (stejně jako u milníků).
  const { data, error } = await s.from('engagement').select('id, account_id').eq('id', engagementId).maybeSingle()
  if (error) return { success: false, error: dbErrorMessage('action.capacity', error) }
  if (!data || (data as { account_id: number }).account_id !== accountId) {
    return { success: false, error: NOT_FOUND_ENGAGEMENT }
  }
  return insertAllocation(s, parsed.data)
}

/** Úprava hodin, období, zástupu a poznámky. Člověk a cíl zůstávají. */
export async function updateAllocation(allocationId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(allocationId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadAllocation(s, allocationId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const parsed = parseAllocationUpdate(Object.fromEntries(formData.entries()), loaded.row.member_id)
  if (!parsed.ok) return { success: false, fieldErrors: parsed.fieldErrors }
  const { data, error } = await s.from('allocation').update(parsed.data).eq('id', allocationId).select('id')
  if (error) return { success: false, error: writeError(error) }
  if (!data?.length) return { success: false, error: NOT_FOUND_ALLOCATION }
  revalidateCapacity()
  return { success: true }
}

/**
 * Ukončit k dnešku (pražský den): běžící alokace dostane konec = dnes,
 * ještě nezačatá se smaže (nikdy neplatila), skončená se nemění.
 */
export async function endAllocation(allocationId: number): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(allocationId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadAllocation(s, allocationId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const plan = planAllocationEnd(loaded.row, pragueToday())
  if (plan.kind === 'already_ended') return { success: false, error: 'Alokace už skončila.' }
  const q =
    plan.kind === 'delete'
      ? s.from('allocation').delete().eq('id', allocationId).select('id')
      : s.from('allocation').update({ ends_on: plan.ends_on }).eq('id', allocationId).select('id')
  const { data, error } = await q
  if (error) return { success: false, error: writeError(error) }
  if (!data?.length) return { success: false, error: NOT_FOUND_ALLOCATION }
  revalidateCapacity()
  return { success: true }
}

const memberId = z.uuid()

/** Týdenní kapacita člověka přes RPC set_weekly_capacity (0062). */
export async function setMemberCapacity(targetMemberId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!memberId.safeParse(targetMemberId).success) return { success: false, error: 'Neplatný člen týmu.' }
  const parsed = parseCapacity(Object.fromEntries(formData.entries()))
  if (!parsed.ok) return { success: false, fieldErrors: parsed.fieldErrors }
  const s = await createClient()
  const { error } = await s.rpc('set_weekly_capacity', {
    p_member_id: targetMemberId,
    p_hours: parsed.data.weekly_capacity_hours,
  })
  if (error) {
    if (isMissingFunction(error)) return { success: false, error: MISSING_MIGRATION }
    if (error.code === '42501') return { success: false, error: 'Kapacitu kolegy smí měnit jen vedení nebo admin.' }
    if (error.code === 'P0002') return { success: false, error: 'Člen týmu nebyl nalezen.' }
    return { success: false, error: dbErrorMessage('action.capacity', error) }
  }
  revalidatePath('/cockpit/kapacity')
  return { success: true }
}
