'use server'
// Zapíše, že člověk právě otevřel obrazovku Dnes (okno „Co se změnilo", 0075).
// Volá se z prohlížeče po vykreslení, ne při vykreslování na serveru: čtení
// stránky nesmí nic zapisovat (prefetch, opakované načtení) a seznam změn se
// po zápisu nemá překreslit prázdný. Proto tu není revalidatePath.
//
// Zápis jde přes RPC touch_changes_view() (aktér z auth.uid(), AAL2). Selhání
// (chybí migrace, síť) nic neláme: okno se jen příště spočítá z toho, co je.
import { tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'

export async function touchChangesView(): Promise<{ ok: boolean }> {
  if (!await tryRequireUser({ aal2: true })) return { ok: false }
  try {
    const s = await createClient()
    const { error } = await s.rpc('touch_changes_view')
    if (error) {
      // 42883/PGRST202 = funkce ještě není (migrace 0075): tiše nic.
      if (!isMissingRelation(error) && error.code !== '42883' && error.code !== 'PGRST202') logError('changes.touch', error)
      return { ok: false }
    }
    return { ok: true }
  } catch (e) {
    logError('changes.touch', e)
    return { ok: false }
  }
}
