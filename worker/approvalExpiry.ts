// Denní vypršení žádostí o schválení (migrace 0084). Běží v EXISTUJÍCÍ denní
// cron cestě /api/cron/follow-ups (Vercel Hobby má omezený počet cronů), pod
// vlastním zámkem runJob('approval-expiry'), takže selhání hlídače follow-upů
// vypršení nezastaví a naopak.
//
// Celou práci dělá databáze v jedné funkci expire_due_approvals (jen
// service_role): prošlé čekající žádosti → expired, u typovaných spustí další
// stav (vlastník dostane úkol) a zopakuje neúspěšná provedení. Tady je jen
// zámek, záznam do job_run a čitelný stav, když migrace ještě neběžela.
import { runJob, type JobDbAdapter, type JobResult, type JobStats } from './jobRunner'

export const APPROVAL_EXPIRY_JOB = 'approval-expiry'
/** Zámek drží déle než nejdelší běh (route má maxDuration 60 s). */
export const APPROVAL_EXPIRY_TTL_SECONDS = 120
/** Kolik prošlých žádostí jeden běh uzavře (zbytek dožene další den). */
export const APPROVAL_EXPIRY_LIMIT = 200

export interface ApprovalExpiryDb {
  /** Volá RPC expire_due_approvals; vrací jeho počty. */
  expireDueApprovals(limit: number): Promise<{ data: unknown; error: { code?: string; message: string } | null }>
}

/** Chybí funkce z 0084 (PostgREST PGRST202, Postgres 42883). */
export function isMissingFunction(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === 'PGRST202' || e.code === '42883')
}

export async function runApprovalExpiryJob(deps: { jobDb: JobDbAdapter; expiryDb: ApprovalExpiryDb }): Promise<JobResult> {
  return runJob(deps.jobDb, APPROVAL_EXPIRY_JOB, APPROVAL_EXPIRY_TTL_SECONDS, async () => {
    const { data, error } = await deps.expiryDb.expireDueApprovals(APPROVAL_EXPIRY_LIMIT)
    if (isMissingFunction(error)) return { state: 'missing_migration', migration: '0084' } satisfies JobStats
    if (error) throw new Error(`expire_due_approvals: ${error.message}`)
    return (data && typeof data === 'object' ? data : {}) as JobStats
  })
}
