'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { areEntityIds, dealKind } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { writeDealTolerant } from '@/domain/crm/dealWrite'
import type { ZodError } from 'zod'

// Rychlá úprava z /inventura (kap. 5, inventuru dělá Viktor sám — plán, bod
// „Owner decision"). Zapisuje SE JEN z těchhle šesti polí (a jen ta, která
// formulář skutečně odeslal), nic jiného na řádku
// obchodu se odsud změnit nedá — invariant a fáze zůstávají, jak byly.
//
// Validace mirroruje dealSchema (lib/validation/schemas.ts): stejné limity
// délky a formát data, jen omezené na pole, která tenhle formulář nabízí.
// Zápis jde přes writeDealTolerant (domain/crm/dealWrite.ts) — když 0052
// ještě neběžela, deal_kind/decision_maker/decision_due se z zápisu tiše
// vynechají (stránka to hlásí noticí, viz domain/crm/queries/inventory.ts).

const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v)
const optDealKind = z.preprocess(emptyToNull, dealKind.nullable())
const boundedText = (max: number, label: string) => z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
  z.string().max(max, `${label} může mít nejvýše ${max} znaků.`).nullable(),
)
// Formát jako dealSchema + kontrola, že den v kalendáři existuje
// (2026-02-30 by jinak prošlo až k DB a skončilo obecnou chybou).
const isRealDay = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
const optIsoDate = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
  z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Zadej platné datum.')
    .refine(isRealDay, 'Zadej platné datum.')
    .nullable(),
)
const noNextStepReason = boundedText(500, 'Důvod')

const inventoryQuickEditSchema = z.object({
  deal_kind: optDealKind,
  decision_maker: boundedText(200, 'Rozhodovatel'),
  decision_due: optIsoDate,
  // Limit 500 znaků jako next_step u cílového seznamu (0048) a důvod (0047).
  next_step: boundedText(500, 'Další krok'),
  next_step_due: optIsoDate,
  no_next_step_reason: noNextStepReason,
})

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '_')
    if (!out[key]) out[key] = issue.message
  }
  return out
}

type QuickEditRow = z.infer<typeof inventoryQuickEditSchema>

function pickSubmitted(data: QuickEditRow, formData: FormData): Partial<QuickEditRow> {
  const out: Partial<QuickEditRow> = {}
  for (const key of Object.keys(inventoryQuickEditSchema.shape) as (keyof QuickEditRow)[]) {
    if (formData.has(key)) Object.assign(out, { [key]: data[key] })
  }
  return out
}

export async function updateInventoryDeal(
  dealId: number,
  accountId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(dealId, accountId)) return { success: false, error: 'Neplatné ID.' }

  const { member } = await getCurrentMember()
  if (!memberSeesSales(member)) return { success: false, error: 'Nemáš přístup k sales CRM.' }

  const parsed = inventoryQuickEditSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }

  // Zapisují se JEN klíče, které formulář skutečně poslal. InventoryRow
  // nevykresluje decision_maker/decision_due mimo fázi „rozhodovani" a
  // deal_kind bez 0052 — kdyby se zapsalo všech šest polí, chybějící by se
  // přepsala na null a smazala existující hodnoty.
  const row = pickSubmitted(parsed.data, formData)
  if (Object.keys(row).length === 0) return { success: false, error: 'Není co uložit.' }

  const s = await createClient()
  // .select('id'): update, který netrefí žádný řádek (cizí klient, smazaný
  // obchod, RLS), jinak vrací úspěch bez chyby.
  const hit = { rows: 0 }
  const { error } = await writeDealTolerant(
    row,
    async (r) => {
      const res = await s.from('deal').update(r).eq('id', dealId).eq('account_id', accountId).select('id')
      hit.rows = Array.isArray(res.data) ? res.data.length : 0
      return res
    },
  )
  if (error) return { success: false, error: dbErrorMessage('action.inventory', error) }
  if (hit.rows === 0) return { success: false, error: 'Obchod nebyl nalezen.' }

  revalidatePath('/cockpit/inventura')
  revalidatePath(`/cockpit/clients/${accountId}`)
  return { success: true }
}
