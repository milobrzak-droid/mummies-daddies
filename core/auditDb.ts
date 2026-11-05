// Napojení appky na DB audit trigger z migrace 0064 (viz core/auditCoverage.ts
// a docs/PROVOZ.md):
//
// 1) dbAuditActive() / dbSoftAuditActive() — běží už trigger (0064 / 0082)? Appková volání recordAudit, která
//    jen zrcadlí řádkovou změnu kryté tabulky, se po aplikaci 0064
//    vynechávají (jinak by se změna zapsala dvakrát). Do té doby je appka
//    dál zapisuje sama — kód jde nasadit před migrací a nic se neztratí.
//    Zdroj pravdy je řádek '0064' v schema_migration (soubor ho vkládá ve
//    stejné transakci, ve které zakládá triggery).
//
// 2) createAuditedAdminClient() — admin klient (servisní klíč) s hlavičkami,
//    ze kterých trigger pozná skutečného aktéra (člověk, API klíč, úloha)
//    a původ (evidence, stav údaje). Bez nich by zápis přes servisní klíč
//    nesl jen 'db-trigger:service_role'.

import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import {
  AUDIT_SOFT_TRIGGER_MIGRATION,
  AUDIT_TRIGGER_MIGRATION,
  auditContextHeaders,
  type AuditContext,
} from '@/core/auditCoverage'

// Kladná odpověď platí napořád (migrace se nevrací); záporná jen chvíli, ať
// se aplikace migrace projeví bez redeploye.
const NEGATIVE_TTL_MS = 60_000

// Cache po verzích migrace ('0064', '0082'): každá se zjišťuje zvlášť.
const caches = new Map<string, { active: boolean; checkedAt: number }>()

async function migrationApplied(version: string, now: number): Promise<boolean> {
  const cache = caches.get(version)
  if (cache?.active) return true
  if (cache && now - cache.checkedAt < NEGATIVE_TTL_MS) return false
  let active = false
  try {
    const { data, error } = await createAdminClient()
      .from('schema_migration')
      .select('version')
      .eq('version', version)
      .maybeSingle()
    if (error) logError('audit.dbAuditActive', error)
    active = !error && data != null
  } catch (e) {
    logError('audit.dbAuditActive', e)
    active = false
  }
  caches.set(version, { active, checkedAt: now })
  return active
}

/**
 * Je aplikovaná migrace 0064 (DB audit trigger)? Při chybě čtení vrací false
 * — appka pak audit zapíše sama; dvojí zápis je menší škoda než žádný.
 */
export async function dbAuditActive(now: number = Date.now()): Promise<boolean> {
  return migrationApplied(AUDIT_TRIGGER_MIGRATION, now)
}

/**
 * Je aplikovaná migrace 0082 (audit financial_record, allocation,
 * metric_observation, case_proposal, deal_scope_version, deal_partner,
 * loop_node a team_member)? Stejná pravidla jako dbAuditActive.
 */
export async function dbSoftAuditActive(now: number = Date.now()): Promise<boolean> {
  return migrationApplied(AUDIT_SOFT_TRIGGER_MIGRATION, now)
}

/** Jen pro testy: zapomene zjištěný stav. */
export function resetDbAuditActiveCache(): void {
  caches.clear()
}

/** Admin klient, jehož zápisy trigger 0064 připíše danému aktérovi a původu. */
export function createAuditedAdminClient(ctx: AuditContext) {
  return createAdminClient({ headers: auditContextHeaders(ctx) })
}
