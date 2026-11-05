'use server'
import { AUTH_ERROR_MESSAGE, requireUser, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logError, logWarn } from '@/lib/log'
import { allDayEventForDate, createCalendarEvent, refreshAccessToken, updateCalendarEvent } from '@/connectors/graph'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import type { ActionResult } from '@/lib/actionResult'
import type { CalendarToken, Task } from '@/lib/types'

export async function disconnectOutlook(): Promise<void> {
  await requireUser({ aal2: true })
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return
  await s.from('calendar_token').delete().eq('member_id', user.id)
  revalidatePath('/cockpit/nastaveni')
}

// Manual "push my tasks" action: creates/updates an all-day Outlook event for
// every one of the caller's open tasks that has a due date. Per-task auto-push
// on create/edit can be layered on top of this later.
export async function syncMyTasksToOutlook(): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return { success: false, error: 'Nejsi přihlášený.' }

  // Od 0031 access_token/refresh_token nejdou přečíst přímo (tabulka drží
  // jen šifrované bytea sloupce) — čtení i zápis jde přes SECURITY DEFINER
  // RPC, stejně jako v connectors/graph/token.ts.
  const { data: tokenRows } = await s.rpc('calendar_token_get_decrypted', { p_member_id: user.id })
  const token = (tokenRows?.[0] ?? null) as CalendarToken | null
  if (!token || !token.access_token || !token.refresh_token) {
    const error = 'Outlook není připojený.'
    await recordConnectorError('graph_calendar', error)
    return { success: false, error }
  }

  let accessToken = token.access_token
  const isExpired = !token.expires_at || new Date(token.expires_at).getTime() <= Date.now()
  if (isExpired) {
    const refreshed = await refreshAccessToken(token.refresh_token)
    if (!refreshed) {
      const error = 'Přihlášení k Outlooku vypršelo. Připoj účet znovu v Nastavení.'
      await recordConnectorError('graph_calendar', error)
      return { success: false, error }
    }
    accessToken = refreshed.access_token
    const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
    const { error: updateError } = await s.rpc('calendar_token_update_tokens', {
      p_member_id: user.id,
      p_access_token: refreshed.access_token,
      p_refresh_token: refreshed.refresh_token,
      p_expires_at: expiresAt,
    })
    // Microsoft mohl refresh token rotovat; když se nový neuloží, ztratil by
    // se tiše. Nepokračujeme, jako by bylo uloženo.
    if (updateError) {
      logError('graph.tokenUpdate', updateError, { memberId: user.id })
      const error = 'Nepodařilo se uložit obnovené přihlášení k Outlooku. Zkus to znovu, případně připoj účet znovu v Nastavení.'
      await recordConnectorError('graph_calendar', error)
      return { success: false, error }
    }
  }

  const { data: tasksData, error: tasksErr } = await s
    .from('task').select('*')
    .eq('assignee_id', user.id)
    .not('due_on', 'is', null)
    .neq('status', 'done')
  if (tasksErr) return { success: false, error: 'Nepodařilo se načíst úkoly.' }

  const tasks = (tasksData ?? []) as Task[]

  // Dřív se tu úspěch hlásil bezpodmínečně: když Microsoft odmítl všechny
  // události, uživatel dostal „hotovo" a byl přesvědčený, že termíny má
  // v kalendáři. Počítáme tedy, co se opravdu povedlo.
  let written = 0
  let failed = 0
  for (const task of tasks) {
    if (!task.due_on) continue
    const event = allDayEventForDate(task.title, task.due_on, task.description ?? undefined)
    if (!task.ms_event_id) {
      const eventId = await createCalendarEvent(accessToken, event)
      if (eventId) {
        await s.from('task').update({ ms_event_id: eventId }).eq('id', task.id)
        written++
      } else {
        failed++
      }
    } else {
      if (await updateCalendarEvent(accessToken, task.ms_event_id, event)) written++
      else failed++
    }
  }

  // Sync doběhl do konce, i kdyby žádný úkol nepotřeboval zápis (0 úkolů
  // po due_on) — spojení s Microsoftem prokazatelně fungovalo, takže je to
  // úspěch konektoru. Neúspěch jednotlivých úkolů (viz `failed` níž) je
  // problém konkrétní události, ne rozbité spojení — nevede
  // k recordConnectorError.
  await recordConnectorSuccess('graph_calendar', new Date().toISOString())

  revalidatePath('/cockpit/tasks')
  revalidatePath('/cockpit/nastaveni')

  if (failed > 0) {
    logWarn('calendar.sync', 'část úkolů se do kalendáře nezapsala', { written, failed })
    return {
      success: false,
      error: written === 0
        ? `Do kalendáře se nepodařilo zapsat ani jeden úkol (${failed} selhalo). Zkus Outlook připojit znovu.`
        : `Zapsáno ${written} úkolů, ${failed} se nepodařilo. Zkus to prosím znovu.`,
    }
  }
  return { success: true }
}
