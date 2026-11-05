// Čitelný stav obsahového vstupu pošty pro Nastavení → „Pošta z Outlooku".
// Čistá funkce nad přepínači prostředí a řádkem connector_state, bez I/O.
// Říká česky, co chybí: vypnuto, chybí zapnutá synchronizace, ještě neběželo,
// selhalo (např. složka neexistuje), zastaralé.
import { isStale, type ConnectorState } from '@/core/connectorState'

export type MailContentSource = {
  enabled: boolean
  folderName: string
  aiEnabled: boolean
  aiKeyMissing: boolean
  /** Věta o nabídkách z příloh (describeMailOfferStatus), nebo null/chybí = vypnuto. */
  offerNote?: string | null
  /** connector_state 'outlook:cockpit'; null = ještě neběželo (nebo přepínač vypnutý a stav se nečetl). */
  state: ConnectorState | null
}

export type MailContentStatus = {
  tone: 'idle' | 'ok' | 'warn' | 'error'
  /** Hlavní věta. */
  message: string
  lastSuccessAt: string | null
  /** Věta o AI shrnutí, nebo null. */
  ai: string | null
  /** Věta o nabídkách z příloh, nebo null. */
  offer: string | null
}

/** Stejné okno jako u ostatních složek pošty: denní cron + rezerva. */
export const MAIL_CONTENT_STALE_AFTER_HOURS = 36

export function describeMailContentStatus(
  src: MailContentSource,
  syncEnabled: boolean,
  nowMs: number = Date.now(),
): MailContentStatus {
  const ai = !src.aiEnabled
    ? null
    : src.aiKeyMissing
      ? 'AI shrnutí je zapnuté, ale chybí ANTHROPIC_API_KEY, takže rozhodují jen pravidla.'
      : 'AI shrnutí je zapnuté: model dostane předmět a text vybrané zprávy, bez adres.'
  const base = { lastSuccessAt: src.state?.last_success_at ?? null, ai, offer: src.offerNote ?? null }

  if (!src.enabled) {
    return {
      ...base,
      tone: 'idle',
      message: 'Vypnuto (MAIL_CONTENT_INTAKE_ENABLED). Cockpit z pošty čte jen metadata, z těla zpráv nic.',
    }
  }
  if (!syncEnabled) {
    return {
      ...base,
      tone: 'warn',
      message: 'Zapnuto, ale nic se nečte: běží jen s denní synchronizací pošty (OUTLOOK_MAIL_SYNC_ENABLED).',
    }
  }
  if (src.state === null) {
    return {
      ...base,
      tone: 'warn',
      message: `Zatím neproběhl žádný běh. Čte se s ranní synchronizací; v Outlooku musí existovat složka „${src.folderName}“.`,
    }
  }
  if (src.state.consecutive_errors > 0) {
    return {
      ...base,
      tone: 'error',
      message: `Poslední běh selhal (${src.state.consecutive_errors}× po sobě): ${src.state.last_error?.trim() || 'neznámá chyba'}`,
    }
  }
  if (isStale(src.state, MAIL_CONTENT_STALE_AFTER_HOURS, nowMs)) {
    return {
      ...base,
      tone: 'error',
      message: 'Zastaralé: poslední úspěšný běh je starší než 36 hodin, cron pravděpodobně neběží nebo skončil dřív.',
    }
  }
  return { ...base, tone: 'ok', message: `Čte se složka „${src.folderName}“. Jen zprávy, které do ní přesuneš.` }
}
