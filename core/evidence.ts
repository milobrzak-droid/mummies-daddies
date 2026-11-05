// Zápis odkazu na zdroj (tabulka `evidence`, migrace 0038).
//
// POZOR — BEZPEČNOST: volat JEN ze serverového kódu (server action, job,
// konektor) a jen s hodnotami ze zdrojového systému (např. Graph message id
// a webLink tak, jak je vrátil Graph). NIKDY ne s sourceId/webLink od
// uživatele. Řádek evidence je sdílený ukazatel (UNIQUE source_kind +
// source_id, první zápis vyhrává), takže podvržený webLink by „otrávil"
// odkaz pro všechny další změny dokládané stejným zdrojem. Proto má INSERT
// jen service_role a tenhle modul bere service-role klienta jako parametr
// (vstříknutý — kvůli testům a aby bylo u volajícího vidět, že jde o admin).
//
// Funkce nikdy nevyhazuje: evidence je součást pozorovací vrstvy jako audit,
// její výpadek nesmí strhnout skutečnou operaci. Vrací typovaný výsledek.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logError } from '@/lib/log'
import { recordAudit, type AuditActor } from '@/core/audit'
import { evidenceRefIssues, type EvidenceRef, type InformationState } from '@/core/informationState'

// Service-role klient (createAdminClient z lib/supabase/admin). Typ je
// alias, aby testy mohly podstrčit falešnou DB přes cast.
export type EvidenceDb = Pick<SupabaseClient, 'from'>

export type RecordEvidenceResult =
  | { ok: true; id: number }
  | { ok: false; reason: 'invalid'; issues: string[] }
  | { ok: false; reason: 'db_error'; message: string }

export async function recordEvidence(
  db: EvidenceDb,
  ref: EvidenceRef,
  createdBy: string | null = null,
): Promise<RecordEvidenceResult> {
  const issues = evidenceRefIssues(ref)
  if (issues.length > 0) return { ok: false, reason: 'invalid', issues }

  try {
    // INSERT ... ON CONFLICT (source_kind, source_id) DO NOTHING.
    const { error: insertError } = await db.from('evidence').upsert(
      {
        source_kind: ref.kind,
        source_id: ref.sourceId,
        web_link: ref.webLink ?? null,
        created_by: createdBy,
      },
      { onConflict: 'source_kind,source_id', ignoreDuplicates: true },
    )
    if (insertError) return fail(insertError.message, ref)

    // Při konfliktu upsert nic nevrací, id proto dohledáme (nové i stávající).
    const { data, error } = await db
      .from('evidence')
      .select('id')
      .eq('source_kind', ref.kind)
      .eq('source_id', ref.sourceId)
      .maybeSingle()
    if (error) return fail(error.message, ref)
    if (!data) return fail('řádek evidence po zápisu nenalezen', ref)
    return { ok: true, id: data.id }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), ref)
  }
}

function fail(message: string, ref: EvidenceRef): RecordEvidenceResult {
  // Do logu jen druh zdroje, ne id (id zprávy může být citlivé).
  logError('evidence', new Error(message), { kind: ref.kind })
  return { ok: false, reason: 'db_error', message }
}

/**
 * Zapíše evidenci a pak audit s původem {evidenceId, infoState}. Když
 * evidence selže, audit se zapíše i tak (bez evidenceId) — ztráta auditu by
 * byla horší. Vrací výsledek zápisu evidence. Platí stejné bezpečnostní
 * pravidlo jako u recordEvidence: jen server, jen hodnoty ze zdroje.
 */
export async function recordAuditWithEvidence(
  db: EvidenceDb,
  ref: EvidenceRef,
  infoState: InformationState,
  audit: {
    entityTable: string
    entityId: number
    action: string
    before: unknown
    after: unknown
    actor: AuditActor
  },
): Promise<RecordEvidenceResult> {
  const createdBy = audit.actor.id ? `${audit.actor.type}:${audit.actor.id}` : `${audit.actor.type}`
  const evidence = await recordEvidence(db, ref, createdBy)
  await recordAudit(audit.entityTable, audit.entityId, audit.action, audit.before, audit.after, audit.actor, {
    evidenceId: evidence.ok ? evidence.id : null,
    infoState,
  })
  return evidence
}
