// Nálezy denní kontroly dokumentů dodávek (engagement_document_finding, 0094)
// z pohledu člena: je otevřený nález „změnil se od schválení"? a uzavření
// nálezů po znovuschválení nebo návratu do konceptu. Pracuje s klientem
// přihlášeného člena (RLS + AAL2, člen smí jen uzavřít — sloupcový GRANT a
// trigger v 0094). Zakládá a auto-uzavírá je jen kontrola (documentSync.ts).
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import type { FindingKind } from '@/domain/delivery/documentWatch'

type Db = Pick<SupabaseClient, 'from'>

/** Je u dokumentu otevřený nález tohoto druhu? Chyba nebo chybějící tabulka = ne. */
export async function hasOpenFinding(s: Db, documentId: number, kind: FindingKind): Promise<boolean> {
  const { data, error } = await s
    .from('engagement_document_finding')
    .select('id')
    .eq('document_id', documentId)
    .eq('kind', kind)
    .is('resolved_at', null)
    .limit(1)
  return !error && Array.isArray(data) && data.length > 0
}

/** Uzavře otevřené nálezy dokumentu (jen dané druhy, nebo všechny). Nikdy nevyhazuje. */
export async function resolveDocumentFindings(
  s: Db,
  documentId: number,
  resolution: 'reapproved' | 'draft',
  kinds?: readonly FindingKind[],
): Promise<void> {
  let q = s
    .from('engagement_document_finding')
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq('document_id', documentId)
    .is('resolved_at', null)
  if (kinds) q = q.in('kind', [...kinds])
  const { error } = await q
  if (error && !isMissingRelation(error)) logError('documentFindings', error)
}
