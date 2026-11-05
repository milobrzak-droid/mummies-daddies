// Registr plánovaných úloh: jméno, TTL zámku, okno v pražském čase, tělo.
// Konkrétní úlohy (Outlook sync, pondělní přehled) přibudou samostatně.

import type { JobStats } from './jobRunner'
import type { PragueWindow } from './pragueTime'

export interface JobDefinition {
  /** Unikátní jméno = klíč zámku v job_lock (1–100 znaků). */
  name: string
  /** Jak dlouho zámek drží, než ho smí převzít další běh. Delší než nejdelší běh. */
  ttlSeconds: number
  /** Kdy smí úloha běžet; bez okna kdykoli, kdy ji cron zavolá. */
  window?: PragueWindow
  run: () => Promise<JobStats | void>
}

export type JobRegistry = Readonly<Record<string, JobDefinition>>

export function defineRegistry(jobs: readonly JobDefinition[]): JobRegistry {
  const out: Record<string, JobDefinition> = {}
  for (const job of jobs) {
    if (out[job.name]) throw new Error(`Duplicitní úloha: ${job.name}`)
    if (job.name.length < 1 || job.name.length > 100) throw new Error(`Neplatné jméno úlohy: ${job.name}`)
    if (!Number.isInteger(job.ttlSeconds) || job.ttlSeconds < 1 || job.ttlSeconds > 86_400) {
      throw new Error(`Neplatné TTL úlohy ${job.name}`)
    }
    out[job.name] = job
  }
  return Object.freeze(out)
}
