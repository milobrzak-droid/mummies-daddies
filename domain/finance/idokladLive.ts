// Napojení denního čtení z iDokladu na skutečné prostředí: přihlašovací
// údaje z proměnných, admin klient s hlavičkami aktéra (audit 0064/0082),
// stav konektoru (Stav zdrojů). Volá ho cron /api/cron/ares-enrich pod
// zámkem runJob('idoklad-sync'); logika je v idokladSync.ts.
import { idokladCredentialsFromEnv, IDOKLAD_ENV } from '@/connectors/idoklad'
import { createAuditedAdminClient } from '@/core/auditDb'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { pragueToday } from '@/lib/pragueDate'
import { IDOKLAD_CONNECTOR, IDOKLAD_SYNC_ACTOR_ID, syncDaysFromEnv } from '@/domain/finance/idoklad'
import {
  IDOKLAD_MIGRATION_MISSING_MESSAGE,
  isMigration0092Missing,
  liveIdokladSource,
  runIdokladSync,
  supabaseIdokladSyncDb,
  type IdokladRunStats,
} from '@/domain/finance/idokladSync'

export const MISSING_CREDENTIALS_MESSAGE = `Chybí ${IDOKLAD_ENV.clientId} nebo ${IDOKLAD_ENV.clientSecret} (Vercel → Environment Variables).`

export async function runIdokladLive(env: Record<string, string | undefined> = process.env): Promise<IdokladRunStats> {
  const creds = idokladCredentialsFromEnv(env)
  if (!creds) {
    await recordConnectorError(IDOKLAD_CONNECTOR, MISSING_CREDENTIALS_MESSAGE)
    throw new Error(MISSING_CREDENTIALS_MESSAGE)
  }
  const client = createAuditedAdminClient({ actor: { type: 'system', id: IDOKLAD_SYNC_ACTOR_ID }, infoState: 'source_fact' })
  try {
    const stats = await runIdokladSync({
      db: supabaseIdokladSyncDb(client),
      source: liveIdokladSource(creds),
      today: pragueToday(),
      days: syncDaysFromEnv(env),
    })
    await recordConnectorSuccess(IDOKLAD_CONNECTOR, new Date().toISOString())
    return stats
  } catch (e) {
    const message = isMigration0092Missing(e) ? IDOKLAD_MIGRATION_MISSING_MESSAGE : e instanceof Error ? e.message : String(e)
    await recordConnectorError(IDOKLAD_CONNECTOR, message.slice(0, 300))
    throw isMigration0092Missing(e) ? new Error(IDOKLAD_MIGRATION_MISSING_MESSAGE) : e
  }
}
