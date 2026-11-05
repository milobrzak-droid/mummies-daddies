import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'

// Úloha konektoru je za normálních okolností jednoduchá otázka: „změnilo
// se od posledně něco?" Bez trvalého kurzoru a záznamu o čerstvosti ale
// „nic nového" a „synchronizace je rozbitá" vypadají zvenku úplně stejně —
// obojí se navenek projeví jako ticho. Tenhle modul existuje proto, aby
// rozbitý konektor byl vidět, místo aby splynul s konektorem, který jen
// nemá co hlásit.
//
// Je to čistě provozní stav (kurzor + otisk posledního úspěchu/chyby),
// ne doménová data — čte a píše ho jen server přes createAdminClient,
// tabulka connector_state má RLS zapnuté a nula politik (viz migrace
// 0029). Zápisy sem se nikdy nesmí stát důvodem, proč selže samotný sync
// — proto recordConnectorSuccess/recordConnectorError chyby jen logují
// a nevyhazují, stejně jako core/audit.ts.
//
// Dnes ho používá jen graph_calendar (Outlook). Dřívější řádek 'fireflies'
// v tabulce connector_state zůstává jako historická data, kód ho od
// zrušení Fireflies (2026-09-28) nečte.

export type ConnectorState = {
  connector: string
  cursor: string | null
  last_success_at: string | null
  last_error: string | null
  last_error_at: string | null
  consecutive_errors: number
  updated_at: string
}

/** Stav konektoru, nebo null, pokud ještě nikdy neběžel (žádný řádek). */
export async function getConnectorState(connector: string): Promise<ConnectorState | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('connector_state')
    .select('connector, cursor, last_success_at, last_error, last_error_at, consecutive_errors, updated_at')
    .eq('connector', connector)
    .maybeSingle()

  if (error) {
    logError('connectorState', error, { connector, op: 'get' })
    return null
  }

  return data
}

/**
 * Zapíše úspěšný běh konektoru: posune kurzor, nastaví last_success_at na
 * teď, vynuluje consecutive_errors a smaže poslední chybu — konektor je
 * zase prokazatelně v pořádku.
 *
 * Nikdy nevyhazuje: selhání zápisu stavu nesmí shodit samotný sync, který
 * ten stav jen hlásí (stejná defenzivní pozice jako core/audit.ts).
 */
export async function recordConnectorSuccess(connector: string, cursor: string | null): Promise<void> {
  try {
    const admin = createAdminClient()
    const now = new Date().toISOString()
    const { error } = await admin.from('connector_state').upsert(
      {
        connector,
        cursor,
        last_success_at: now,
        consecutive_errors: 0,
        last_error: null,
        last_error_at: null,
        updated_at: now,
      },
      { onConflict: 'connector' },
    )
    if (error) {
      logError('connectorState', error, { connector, op: 'success' })
    }
  } catch (e) {
    logError('connectorState', e, { connector, op: 'success' })
  }
}

/**
 * Zapíše neúspěšný běh konektoru: uloží chybu a zvýší consecutive_errors
 * o jedna. Kurzor ani last_success_at se nemění — poslední známý dobrý
 * bod zůstává tam, kde byl.
 *
 * Zvýšení je typu „přečti, přičti, zapiš" (ne atomický SQL výraz přes
 * supabase-js), takže má drobné okno pro race condition. To je v pořádku:
 * konektory běží jeden po druhém, ne souběžně, takže dva konkurenční
 * zápisy pro stejný `connector` v praxi nenastanou.
 *
 * Nikdy nevyhazuje, ze stejného důvodu jako recordConnectorSuccess.
 */
export async function recordConnectorError(connector: string, error: string): Promise<void> {
  try {
    const admin = createAdminClient()
    const now = new Date().toISOString()

    const { data: existing, error: readError } = await admin
      .from('connector_state')
      .select('consecutive_errors')
      .eq('connector', connector)
      .maybeSingle()

    if (readError) {
      logError('connectorState', readError, { connector, op: 'error-read' })
      return
    }

    const nextConsecutiveErrors = (existing?.consecutive_errors ?? 0) + 1

    const { error: writeError } = await admin.from('connector_state').upsert(
      {
        connector,
        last_error: error,
        last_error_at: now,
        consecutive_errors: nextConsecutiveErrors,
        updated_at: now,
      },
      { onConflict: 'connector' },
    )
    if (writeError) {
      logError('connectorState', writeError, { connector, op: 'error-write' })
    }
  } catch (e) {
    logError('connectorState', e, { connector, op: 'error' })
  }
}

/**
 * Čistá funkce (žádné I/O): má se konektor hlásit jako rozbitý?
 *
 * Platí, když nastane cokoli z:
 * - `state` je null — konektor ještě nikdy neuspěl,
 * - poslední úspěch je starší než `maxAgeHours`,
 * - `consecutive_errors` je 3 nebo víc, bez ohledu na to, jak nedávný je
 *   last_success_at — tři chyby v řadě znamenají, že je něco skutečně
 *   rozbité, ne že je jen ticho. Tahle podmínka záměrně vyhrává i nad
 *   čerstvým úspěchem: „uspěl naposledy před hodinou, ale mezitím třikrát
 *   selhal" se má hlásit jako rozbité.
 *
 * Tohle je funkce, kterou bude volat kapitola 9 (digest) — signatura a
 * chování je záměrně stabilní a dobře zdokumentované.
 */
export function isStale(state: ConnectorState | null, maxAgeHours: number, nowMs: number = Date.now()): boolean {
  if (state === null) return true

  if (state.consecutive_errors >= 3) return true

  if (state.last_success_at === null) return true

  const lastSuccessMs = new Date(state.last_success_at).getTime()
  const ageMs = nowMs - lastSuccessMs
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000

  return ageMs > maxAgeMs
}
