import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { isInformationState, type InformationState } from '@/core/informationState'

// Audit je pozorovací vrstva, ne transakční záruka. V okamžiku, kdy sem
// volání dorazí, skutečná změna (např. update obchodu) už úspěšně proběhla
// server-side — takže selhání zápisu do audit_event nemá co odvolávat.
// Nejde tím zpětně vzít, co se už stalo. Jde jen o to, aby výpadek audit
// logu nikdy nestrhl s sebou reálnou operaci: proto se selhání jen zaloguje
// jako varování, ne vyhodí výjimka. Známé omezení: pokud recordAudit selže,
// ta konkrétní změna zůstane bez záznamu původu a nikdo se o tom nedozví
// jinak než z runtime logu.

export type AuditActor = {
  type: 'user' | 'api_key' | 'system'
  id: string | null
}

// Volitelný původ události (migrace 0038): odkaz na řádek `evidence`
// a stav údaje. Obojí je nullable i v databázi; kdo to nepředá, píše audit
// přesně jako dřív.
export type AuditProvenance = {
  evidenceId?: number | null
  infoState?: InformationState | null
}

export async function recordAudit(
  entityTable: string,
  entityId: number,
  action: string,
  before: unknown,
  after: unknown,
  actor: AuditActor,
  provenance?: AuditProvenance,
): Promise<void> {
  try {
    const admin = createAdminClient()
    // Nové sloupce se do insertu přidají jen když jsou zadané, takže tvar
    // zápisu pro stávající volající zůstává beze změny.
    const provenanceColumns: { evidence_id?: number | null; info_state?: InformationState | null } = {}
    if (provenance?.evidenceId !== undefined) provenanceColumns.evidence_id = provenance.evidenceId
    if (provenance?.infoState !== undefined) {
      if (provenance.infoState === null || isInformationState(provenance.infoState)) {
        provenanceColumns.info_state = provenance.infoState
      } else {
        // Neplatný stav by shodil celý insert na CHECKu a audit by se ztratil;
        // radši zapsat událost bez stavu a chybu nahlásit.
        logError('audit', new Error('neplatný info_state, vynecháno'), { action, entityTable, entityId })
      }
    }
    const { error } = await admin.from('audit_event').insert({
      actor_type: actor.type,
      actor_id: actor.id,
      action,
      entity_table: entityTable,
      entity_id: entityId,
      before: before ?? null,
      after: after ?? null,
      ...provenanceColumns,
    })
    if (error) {
      logError('audit', error, { action, entityTable, entityId })
    }
  } catch (e) {
    logError('audit', e, { action, entityTable, entityId })
  }
}

// ---------------------------------------------------------------------------
// Rozhodnutí, které audit události má úprava obchodu vyvolat.
//
// Žije tady, ne v domain/crm/actions/deals.ts, protože ten soubor má nahoře
// 'use server' — Next.js pak bere KAŽDÝ jeho export jako Server Akci a
// vyžaduje, aby byla async. Tohle je záměrně synchronní čistá funkce (stejný
// důvod jako u shouldFreezeRate v domain/finance/fx.ts), takže patří sem.

export type DealAuditDiffEntry = {
  action: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

// amount_one_time se porovnává přes Number(): PostgREST vrací numeric jako
// string, takže '580000' (z DB) vs 580000 (nově dopočtené) by bez castu
// vypadalo jako změna, i když se hodnota nezměnila.
export function dealAuditDiff(
  existing: { amount_one_time: number | string | null; stage: string },
  next: { amount_one_time: number | string | null; stage: string | undefined },
): DealAuditDiffEntry[] {
  const diffs: DealAuditDiffEntry[] = []
  if (Number(existing.amount_one_time) !== Number(next.amount_one_time)) {
    diffs.push({
      action: 'deal.amount_changed',
      before: { amount_one_time: existing.amount_one_time },
      after: { amount_one_time: next.amount_one_time },
    })
  }
  if (existing.stage !== next.stage) {
    diffs.push({
      action: 'deal.stage_changed',
      before: { stage: existing.stage },
      after: { stage: next.stage },
    })
  }
  return diffs
}
