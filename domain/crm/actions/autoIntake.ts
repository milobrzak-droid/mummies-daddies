'use server'
// „Není poptávka" u klienta, kterého Cockpit založil sám z e-mailu
// (domain/crm/autoIntakeService.ts, migrace 0081 a 0086).
//
// Dvě cesty, obě rozhoduje a provádí databáze v JEDNÉ transakci:
//   undoAutoIntake    (RPC auto_intake_undo) — smaže, co automat založil
//                     (klienta, kontakt, alias domény, obchod, úkol, aktivitu)
//                     i to, co k poptávce později přidal sám Cockpit (další
//                     e-mail téže domény, nedotčený follow-up případ, úkol
//                     v kalendáři), a doménu si zapamatuje. Když u klienta
//                     vznikla lidská práce, nic nesmaže a vrátí canDismiss.
//   dismissAutoIntake (RPC auto_intake_dismiss) — kde Zpět nejde: obchod do
//                     Prohráno s důvodem „Nebyla to poptávka", úkol hotovo,
//                     firma odložená o rok, poptávka uzavřená. Nic se nemaže.
// Aktér a AAL2 se berou z přihlášené session uvnitř RPC; audit změn zapisují
// triggery tabulek (aktér = přihlášený člověk). Akce jen ověří přihlášení,
// obchodní roli a přeloží chyby.
import { revalidatePath } from 'next/cache'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { dbErrorMessage } from '@/lib/actionResult'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import {
  DISMISS_FORBIDDEN,
  UNDO_BAD_INPUT,
  UNDO_CALENDAR_NOTE,
  UNDO_DONE_NOTE,
  UNDO_FORBIDDEN,
  dismissDoneNote,
  dismissErrorMessage,
  isUndoRefused,
  canOfferDismiss,
  parseDismissResult,
  parseIntakeId,
  undoErrorMessage,
  type UndoResult,
} from '@/domain/crm/autoIntakeUndo'

// Seznamy, které se po změně musí příště načíst znovu. Obrazovku Dnes ani
// kartu klienta záměrně nepřekreslujeme hned: karta by zmizela dřív, než si
// člověk přečte potvrzení, a stránka smazaného klienta by skončila na
// „nenalezeno". Ostatní stránky se po dalším otevření načtou čerstvě
// (revalidatePath v akci znehodnotí cache navštívených stránek).
const LIST_PATHS = ['/cockpit/clients', '/cockpit/pipeline', '/cockpit/tasks', '/cockpit/sales', '/cockpit/prehled-tydne', '/cockpit/pripady', '/cockpit/oslovovani']

export async function undoAutoIntake(intakeId: number): Promise<UndoResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const id = parseIntakeId(intakeId)
  if (id === null) return { success: false, error: UNDO_BAD_INPUT }
  if (!memberSeesSales((await getCurrentMember()).member)) return { success: false, error: UNDO_FORBIDDEN }

  const s = await createClient()
  const { data, error } = await s.rpc('auto_intake_undo', { p_id: id })
  if (error) {
    // Lidská práce u klienta: nic se nesmazalo, nabídne se uzavření bez mazání.
    if (isUndoRefused(error)) return { success: false, error: undoErrorMessage(error) ?? undefined, canDismiss: canOfferDismiss(error) }
    return { success: false, error: undoErrorMessage(error) ?? dbErrorMessage('action.autoIntake.undo', error) }
  }
  const result = data as { status?: unknown; calendar_event?: unknown } | null
  if (result?.status !== 'undone') return { success: false, error: UNDO_BAD_INPUT }

  for (const path of LIST_PATHS) revalidatePath(path)
  return { success: true, note: result.calendar_event === true ? `${UNDO_DONE_NOTE} ${UNDO_CALENDAR_NOTE}` : UNDO_DONE_NOTE }
}

export async function dismissAutoIntake(intakeId: number): Promise<UndoResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const id = parseIntakeId(intakeId)
  if (id === null) return { success: false, error: UNDO_BAD_INPUT }
  if (!memberSeesSales((await getCurrentMember()).member)) return { success: false, error: DISMISS_FORBIDDEN }

  const s = await createClient()
  const { data, error } = await s.rpc('auto_intake_dismiss', { p_id: id })
  if (error) return { success: false, error: dismissErrorMessage(error) ?? dbErrorMessage('action.autoIntake.dismiss', error) }
  const outcome = parseDismissResult(data)
  if (!outcome) return { success: false, error: UNDO_BAD_INPUT }

  for (const path of LIST_PATHS) revalidatePath(path)
  return { success: true, note: dismissDoneNote(outcome) }
}
