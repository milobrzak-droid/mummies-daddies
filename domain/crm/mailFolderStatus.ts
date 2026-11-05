// Čitelný stav jedné složky pošty (Doručená / Odeslaná) pro Nastavení →
// „Pošta z Outlooku". Čistá funkce nad řádkem connector_state, bez I/O.
//
// Proč: „poslední synchronizace nikdy" říká jen last_success_at, který se
// nastaví až po DOTAŽENÍ celé složky. Složka, která teprve stránkuje historii
// (kurzor phase 'paging'), nebo na kterou v běhu nepřišla řada, vypadala stejně
// jako složka, která se vůbec nespustila. Tady se ty případy rozliší podle
// kurzoru, chyb a updated_at (= čas posledního pokusu).

import { isStale, type ConnectorState } from '@/core/connectorState'
import { parseCursor } from '@/domain/crm/mailSync'
import { describeProgress, mailSyncProgress } from '@/domain/crm/mailSyncProgress'

export type FolderTone = 'ok' | 'warn' | 'error'

export type FolderStatus = {
  tone: FolderTone
  /** Čas posledního úspěšného dotažení, nebo null. */
  lastSuccessAt: string | null
  /** Čas posledního pokusu (updated_at / last_error_at), nebo null. */
  lastAttemptAt: string | null
  /** Česká věta pro člověka; null = vše v pořádku a není co dodat. */
  message: string | null
}

export function describeFolderStatus(
  state: ConnectorState | null,
  staleAfterHours: number,
  nowMs: number = Date.now(),
): FolderStatus {
  if (state === null) {
    return {
      tone: 'error',
      lastSuccessAt: null,
      lastAttemptAt: null,
      message:
        'Tuhle složku zatím žádný běh nezaložil — synchronizace ještě neproběhla, nebo skončila dřív, než na složku přišla řada. Spusťte ji ručně (cron outlook-mail) a zkontrolujte poslední běh v job_run.',
    }
  }

  const lastAttemptAt = latest(state.last_error_at, state.updated_at)
  const base = { lastSuccessAt: state.last_success_at, lastAttemptAt }

  if (state.consecutive_errors > 0) {
    return {
      ...base,
      tone: 'error',
      message: `Poslední pokus selhal (${state.consecutive_errors}× po sobě): ${state.last_error?.trim() || 'neznámá chyba'}`,
    }
  }

  const cursor = parseCursor(state.cursor)

  if (state.last_success_at === null) {
    if (cursor?.phase === 'paging') {
      // S oknem (kurzor nese `since`) ukážeme, kam se načetlo a kolik zhruba zbývá.
      const progress = mailSyncProgress(cursor, nowMs)
      if (progress) return { ...base, tone: 'warn', message: describeProgress(progress) }
      return {
        ...base,
        tone: 'warn',
        message:
          'Probíhá první načtení historie — každý běh dotáhne další část (Microsoft vrací zprávy po stránkách, běh má denní limit). Hotovo bude, až se složka dotáhne celá.',
      }
    }
    return {
      ...base,
      tone: 'warn',
      message:
        'Složka zatím nebyla dotažena — v posledních bězích na ni nepřišla řada (limit stránek/času) nebo ji Microsoft dočasně omezil. Další běh naváže; ruční spuštění cronu to urychlí.',
    }
  }

  if (isStale(state, staleAfterHours)) {
    return {
      ...base,
      tone: 'error',
      message:
        cursor?.phase === 'paging'
          ? 'Zastaralé — složka se znovu načítá od začátku (delta token vypršel), běh dotahuje další část.'
          : 'Zastaralé — poslední synchronizace je starší než 36 hodin, cron pravděpodobně neběží nebo skončil dřív.',
    }
  }

  return { ...base, tone: 'ok', message: null }
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}
