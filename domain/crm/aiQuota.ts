// Denní strop volání modelu na čtení PDF (import nabídky /nabidka/import
// i hromadný import zakázek /import/zakazky) — na uživatele, na serveru.
//
// Proč: každé PDF jde k Anthropicu a stojí kredity; strop souborů na jedno
// odeslání (5) neomezí, kolikrát se formulář odešle. Počítadlo je audit_event
// (žádná nová tabulka): každé volání modelu zapíše PŘED voláním řádek
// action = 'ai.pdf_extract' s entity_table = 'team_member' a entity_ref = id
// člověka (0082 dovoluje entitu bez bigint id). Stejný řádek je zároveň stopa
// „kdo kdy nechal AI číst PDF" — jen id a zdroj, nic z dokumentu.
// Počítá se pražský kalendářní den; index audit_event_entity_ref_idx (0082)
// pokrývá dotaz. Souběh dvou odeslání může strop překročit nanejvýš o pár
// volání — je to pojistka proti spálení kreditů, ne účetnictví.
//
// Když počítadlo nejde přečíst nebo zapsat, volání se NEPUSTÍ (fail closed):
// bez počítadla by strop nic nechránil.

import type { SupabaseClient } from '@supabase/supabase-js'
import { pragueLocalToUtc, pragueToday } from '@/lib/pragueDate'
import { logError } from '@/lib/log'

export const AI_PDF_ACTION = 'ai.pdf_extract'
export const AI_PDF_DAILY_LIMIT_DEFAULT = 40
const AI_PDF_DAILY_LIMIT_MAX = 1000

export type AiPdfSource = 'offer_import' | 'bulk_import'

/** AI_PDF_DAILY_LIMIT: celé číslo 1–1000; jinak výchozí 40. */
export function aiPdfDailyLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AI_PDF_DAILY_LIMIT?.trim()
  if (!raw || !/^\d+$/.test(raw)) return AI_PDF_DAILY_LIMIT_DEFAULT
  const n = Number(raw)
  return n >= 1 && n <= AI_PDF_DAILY_LIMIT_MAX ? n : AI_PDF_DAILY_LIMIT_DEFAULT
}

export const AI_QUOTA_MESSAGES = {
  exhausted: (limit: number) =>
    `Dnešní limit čtení PDF umělou inteligencí (${limit} souborů na člověka) je vyčerpaný. Zkus to zítra, nebo údaje zadej ručně či tabulkou.`,
  unavailable: 'Denní limit čtení PDF teď nejde ověřit, proto se PDF nečetlo. Zkus to prosím za chvíli.',
} as const

export type AiQuotaResult = { ok: true; used: number; limit: number } | { ok: false; error: string }

type Db = Pick<SupabaseClient, 'from'>

/**
 * Zabere jedno volání modelu z denního stropu člověka. ok = smí se volat
 * (řádek už je zapsaný); jinak česká věta pro uživatele.
 */
export async function takeAiPdfQuota(
  db: Db,
  userId: string,
  source: AiPdfSource,
  opts: { now?: Date; limit?: number } = {},
): Promise<AiQuotaResult> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? aiPdfDailyLimitFromEnv()
  const dayStart = pragueLocalToUtc(`${pragueToday(now)}T00:00`).toISOString()
  const { count, error } = await db
    .from('audit_event')
    .select('id', { count: 'exact', head: true })
    .eq('entity_table', 'team_member')
    .eq('entity_ref', userId)
    .eq('action', AI_PDF_ACTION)
    .gte('occurred_at', dayStart)
  if (error || typeof count !== 'number') {
    if (error) logError('aiQuota.count', error)
    return { ok: false, error: AI_QUOTA_MESSAGES.unavailable }
  }
  if (count >= limit) return { ok: false, error: AI_QUOTA_MESSAGES.exhausted(limit) }

  const { error: insertError } = await db.from('audit_event').insert({
    actor_type: 'user',
    actor_id: userId,
    action: AI_PDF_ACTION,
    entity_table: 'team_member',
    entity_id: null,
    entity_ref: userId,
    before: null,
    after: { source },
  })
  if (insertError) {
    logError('aiQuota.record', insertError)
    return { ok: false, error: AI_QUOTA_MESSAGES.unavailable }
  }
  return { ok: true, used: count + 1, limit }
}
