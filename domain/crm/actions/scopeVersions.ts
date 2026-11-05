'use server'
// Verze nabídky obchodu (kap. 5, migrace 0072). Jen obchodní role
// (rozhodnutí majitele 2026-09-28): RLS sales_only to vynucuje v DB, tady
// hlásíme srozumitelnou větu předem.
//
// Přijetí jde přes RPC accept_deal_scope_version (SECURITY INVOKER, jedna
// transakce): ostatní otevřené verze → superseded, verze → accepted, částky
// obchodu běžným UPDATE deal → audit trigger 0034/0035 zapíše změnu částek
// s aktérem přihlášeného uživatele. Samotné přijetí zapisujeme do auditu
// s původem human_confirmed (člověk potvrdil rozhodnutí klienta).
//
// Odeslání (0084): když to šablona procesu vyžaduje, koncept jde označit jako
// odeslaný až po schválené žádosti „Odeslat nabídku klientovi" (čtyři oči).
// Žádost zakládá RPC request_action_approval; po schválení Cockpit nic
// neodešle, jen verzi označí jako schválenou k odeslání a vlastník obchodu
// dostane úkol. DB strážce (SV006) odeslání bez schválení odmítne i mimo appku.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { recordAudit } from '@/core/audit'
import { dbSoftAuditActive } from '@/core/auditDb'
import { czkPerEur } from '@/connectors/cnb'
import { shouldFreezeRate } from '@/domain/finance/fx'
import {
  SCOPE_VERSION_COLUMNS,
  SCOPE_VERSION_MISSING_MESSAGE,
  SCOPE_VERSION_SEND_COLUMNS,
  canTransitionScopeVersion,
  isScopeVersionMissing,
  isScopeVersionStatus,
  nextVersionNumber,
  offerNeedsSendApproval,
  scopeVersionDbMessage,
  scopeVersionSchema,
  type ScopeVersionRow,
  type ScopeVersionStatus,
} from '@/domain/crm/scopeVersion'
import { isMissingColumn } from '@/core/loopQueries'
import { approvalActionErrorMessage } from '@/core/approvalActions'

const SALES_ACCESS_ERROR = 'Verze nabídky může spravovat jen člen s přístupem k obchodu.'
const NOT_FOUND = 'Verze nabídky nebyla nalezena.'
const DEAL_NOT_FOUND = 'Obchod nebyl nalezen.'
const STALE = 'Verze nabídky mezitím změnila stav. Načti prosím stránku znovu.'

type Db = Awaited<ReturnType<typeof createClient>>

function dealPath(accountId: number, dealId: number): string {
  return `/cockpit/clients/${accountId}/deals/${dealId}`
}

function refresh(accountId: number, dealId: number) {
  revalidatePath(dealPath(accountId, dealId))
  revalidatePath(`/cockpit/clients/${accountId}`)
  revalidatePath('/cockpit/pipeline')
}

function failFromDb(error: { code?: string | null; message?: string | null }): ActionResult {
  if (isScopeVersionMissing(error)) return { success: false, error: SCOPE_VERSION_MISSING_MESSAGE }
  return { success: false, error: scopeVersionDbMessage(error) ?? dbErrorMessage('action.scopeVersions', error) }
}

async function gate(
  user: { id: string } | null,
  accountId: number,
  dealId: number,
): Promise<{ userId: string } | ActionResult> {
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, dealId)) return { success: false, error: 'Neplatné ID.' }
  if (!memberSeesSales((await getCurrentMember()).member)) return { success: false, error: SALES_ACCESS_ERROR }
  return { userId: user.id }
}

async function dealBelongs(s: Db, accountId: number, dealId: number): Promise<boolean> {
  const { data } = await s.from('deal').select('id').eq('id', dealId).eq('account_id', accountId).maybeSingle()
  return !!data
}

async function loadVersion(
  s: Db,
  dealId: number,
  versionId: number,
): Promise<{ row: ScopeVersionRow } | ActionResult> {
  // Se sloupci schválení k odeslání (0084); před migrací bez nich.
  const query = (cols: string) =>
    s.from('deal_scope_version').select(cols).eq('id', versionId).eq('deal_id', dealId).maybeSingle()
  let res = await query(SCOPE_VERSION_COLUMNS + SCOPE_VERSION_SEND_COLUMNS)
  if (isMissingColumn(res.error)) res = await query(SCOPE_VERSION_COLUMNS)
  const { data, error } = res
  if (error) return failFromDb(error)
  if (!data) return { success: false, error: NOT_FOUND }
  return { row: data as unknown as ScopeVersionRow }
}

const SEND_NEEDS_APPROVAL =
  'Tuhle verzi je potřeba před odesláním schválit (čtyři oči). Požádej o schválení odeslání.'

export async function createScopeVersion(
  accountId: number,
  dealId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  const g = await gate(user, accountId, dealId)
  if (!('userId' in g)) return g
  const parsed = scopeVersionSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const i of parsed.error.issues) {
      const k = String(i.path[0] ?? '_')
      if (!fieldErrors[k]) fieldErrors[k] = i.message
    }
    return { success: false, fieldErrors }
  }
  const s = await createClient()
  if (!await dealBelongs(s, accountId, dealId)) return { success: false, error: DEAL_NOT_FOUND }
  const { data: existing, error: readError } = await s
    .from('deal_scope_version')
    .select('version')
    .eq('deal_id', dealId)
  if (readError) return failFromDb(readError)
  const { error } = await s.from('deal_scope_version').insert({
    deal_id: dealId,
    version: nextVersionNumber((existing ?? []) as { version: number }[]),
    status: 'draft',
    ...parsed.data,
  })
  // 23505 = souběžně vznikla verze se stejným číslem.
  if (error?.code === '23505') return { success: false, error: 'Mezitím vznikla jiná verze. Zkus to prosím znovu.' }
  if (error) return failFromDb(error)
  refresh(accountId, dealId)
  return { success: true }
}

async function setStatus(
  user: { id: string } | null,
  accountId: number,
  dealId: number,
  versionId: number,
  to: Extract<ScopeVersionStatus, 'sent' | 'rejected'>,
): Promise<ActionResult> {
  const g = await gate(user, accountId, dealId)
  if (!('userId' in g)) return g
  if (!areEntityIds(versionId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadVersion(s, dealId, versionId)
  if (!('row' in loaded)) return loaded
  const from = loaded.row.status
  if (!isScopeVersionStatus(from) || !canTransitionScopeVersion(from, to)) return { success: false, error: STALE }
  // Schválení odeslání (0084). undefined = migrace ještě neběžela, DB nehlídá.
  if (to === 'sent' && loaded.row.send_approved_at === null && offerNeedsSendApproval(loaded.row)) {
    return { success: false, error: SEND_NEEDS_APPROVAL }
  }
  // .eq('status', from) = optimistický zámek proti souběžné změně.
  const { data, error } = await s
    .from('deal_scope_version')
    .update({ status: to })
    .eq('id', versionId)
    .eq('deal_id', dealId)
    .eq('status', from)
    .select('id')
  if (error) return failFromDb(error)
  if (!data || (data as unknown[]).length === 0) return { success: false, error: STALE }
  // Akce jako řetězcový literál přímo v každém volání (ne přes proměnnou):
  // test/audit-coverage-0064.test.ts z toho statickým skenem čte tabulku
  // a akci, aby ověřil, že nejde o duplicitu s DB triggerem 0064.
  // Po migraci 0082 zapisuje změnu stavu trigger (deal_scope_version.updated); appka
  // ji zapisuje sama jen do té doby (jinak by vznikla dvakrát).
  if (!(await dbSoftAuditActive())) {
    if (to === 'sent') {
      await recordAudit(
        'deal_scope_version',
        versionId,
        'deal.scope_version_sent',
        { status: from, deal_id: dealId, version: loaded.row.version },
        { status: to, deal_id: dealId, version: loaded.row.version },
        { type: 'user', id: g.userId },
        { infoState: 'human_confirmed' },
      )
    } else {
      await recordAudit(
        'deal_scope_version',
        versionId,
        'deal.scope_version_rejected',
        { status: from, deal_id: dealId, version: loaded.row.version },
        { status: to, deal_id: dealId, version: loaded.row.version },
        { type: 'user', id: g.userId },
        { infoState: 'human_confirmed' },
      )
    }
  }
  refresh(accountId, dealId)
  return { success: true }
}

export async function sendScopeVersion(
  accountId: number,
  dealId: number,
  versionId: number,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  return setStatus(user, accountId, dealId, versionId, 'sent')
}

/**
 * „Požádat o schválení odeslání" (0084): žádost „Odeslat nabídku klientovi"
 * na konkrétní koncept. O schválení rozhoduje jiný člen obchodu s pravomocí
 * na /rozhodnuti; po schválení Cockpit nic neodešle, jen založí úkol.
 */
export async function requestScopeVersionSendApproval(
  accountId: number,
  dealId: number,
  versionId: number,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  const g = await gate(user, accountId, dealId)
  if (!('userId' in g)) return g
  if (!areEntityIds(versionId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadVersion(s, dealId, versionId)
  if (!('row' in loaded)) return loaded
  if (loaded.row.status !== 'draft') return { success: false, error: 'Schválit k odeslání jde jen koncept nabídky.' }
  if (loaded.row.send_approved_at) return { success: false, error: 'Tahle verze už je schválená k odeslání.' }
  const { error } = await s.rpc('request_action_approval', {
    p_action_type: 'send_offer',
    p_target_id: versionId,
    p_params: {},
    p_expires_at: null,
  })
  if (error) {
    return { success: false, error: approvalActionErrorMessage(error) ?? scopeVersionDbMessage(error) ?? dbErrorMessage('action.scopeVersions.requestSend', error) }
  }
  refresh(accountId, dealId)
  revalidatePath('/cockpit/rozhodnuti')
  return { success: true }
}

export async function rejectScopeVersion(
  accountId: number,
  dealId: number,
  versionId: number,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  return setStatus(user, accountId, dealId, versionId, 'rejected')
}

export async function acceptScopeVersion(
  accountId: number,
  dealId: number,
  versionId: number,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  const g = await gate(user, accountId, dealId)
  if (!('userId' in g)) return g
  if (!areEntityIds(versionId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const { data: deal } = await s
    .from('deal')
    .select('stage, currency, amount_one_time, amount_one_time_original, fx_rate')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!deal) return { success: false, error: DEAL_NOT_FOUND }
  const loaded = await loadVersion(s, dealId, versionId)
  if (!('row' in loaded)) return loaded
  const v = loaded.row
  if (v.status !== 'sent') return { success: false, error: STALE }

  // Kurz pro verzi v EUR: u uzavřeného obchodu se stejnou EUR částkou zůstává
  // kurz z doby uzavření (shouldFreezeRate), jinak živý ČNB.
  let fxRate: number | null = null
  if (v.currency === 'EUR') {
    const amount = Number(v.amount_one_time)
    if (shouldFreezeRate(deal, { currency: 'EUR', amount_one_time_original: amount }) && deal.fx_rate != null) {
      fxRate = Number(deal.fx_rate)
    } else {
      try {
        fxRate = await czkPerEur()
      } catch (e) {
        return { success: false, error: `Přepočet kurzu selhal: ${(e as Error).message}` }
      }
    }
  }

  const { data, error } = await s.rpc('accept_deal_scope_version', {
    p_deal_id: dealId,
    p_version_id: versionId,
    p_fx_rate: fxRate,
  })
  if (error) return failFromDb(error)

  const result = (data ?? {}) as { before?: unknown; after?: unknown; superseded_versions?: number[] }
  await recordAudit(
    'deal',
    dealId,
    'deal.scope_version_accepted',
    { deal: result.before ?? null, version: v.version, status: 'sent' },
    { deal: result.after ?? null, version: v.version, status: 'accepted', superseded_versions: result.superseded_versions ?? [] },
    { type: 'user', id: g.userId },
    { evidenceId: v.evidence_id, infoState: 'human_confirmed' },
  )
  refresh(accountId, dealId)
  return { success: true }
}
