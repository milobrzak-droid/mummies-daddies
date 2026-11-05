// Věta o stavu napojení na iDoklad (stránka Finance) — čistá funkce, ať se dá
// otestovat každý stav: vypnuto, chybí tajemství, zatím nikdy neběželo,
// poslední běh selhal, v pořádku. Bez hodnot tajemství, jen názvy proměnných.
import { dayLabel } from '@/domain/crm/today'
import type { IdokladStatus } from '@/domain/finance/queries/idoklad'

export type IdokladNote = { tone: 'calm' | 'problem'; text: string }

export function idokladNote(status: IdokladStatus, now: Date = new Date()): IdokladNote {
  if (!status.enabled) {
    return {
      tone: 'calm',
      text: 'Čtení z iDokladu je vypnuté, finanční záznamy se zatím zapisují ručně. Zapnutí popisuje docs/PROVOZ.md.',
    }
  }
  if (status.missing.length > 0) {
    return { tone: 'problem', text: `Čtení z iDokladu je zapnuté, ale chybí ${status.missing.join(' a ')} (Vercel → Environment Variables).` }
  }
  if (status.consecutiveErrors > 0 && status.lastError) {
    return { tone: 'problem', text: `Poslední načtení z iDokladu selhalo: ${status.lastError}` }
  }
  if (!status.lastSuccessAt) {
    return { tone: 'calm', text: `iDoklad je napojený, první načtení proběhne v nejbližším denním běhu (čte se posledních ${status.days} dní).` }
  }
  return {
    tone: 'calm',
    text: `iDoklad: poslední načtení ${dayLabel(status.lastSuccessAt, now)}, čte se posledních ${status.days} dní. Nic se do iDokladu nezapisuje.`,
  }
}
