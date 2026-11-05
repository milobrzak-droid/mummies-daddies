// Nastavení denní kontroly dokumentů dodávek (0094) bez závislostí: názvy úlohy a
// konektoru, limity a čtení přepínačů z prostředí. Odděleno od documentSync.ts,
// aby ho mohla importovat i stránka a cron route bez tahání Graphu a databáze.

/** Úloha = klíč zámku (job_lock, 0040) i aktér zápisů v auditu. */
export const DOC_SYNC_JOB = 'sharepoint-doc-sync'
/** Zámek drží déle než nejdelší běh (cron má maxDuration 60 s). */
export const DOC_SYNC_TTL_SECONDS = 90
/** Řádek connector_state pro čtení souborů z SharePointu. */
export const DOC_SYNC_CONNECTOR = 'graph_files'
/** Aktér v audit_event ('system:sharepoint-doc-sync'). */
export const DOC_SYNC_ACTOR = { type: 'system', id: DOC_SYNC_JOB } as const
/** Kolik dokumentů se zkontroluje za běh (nejstarší kontrola první; zbytek příště). */
export const DOC_SYNC_BATCH = 60
export const DOC_SYNC_DEFAULT_BUDGET_MS = 15_000

/** Denní kontrola dokumentů: jen přesně 'true'. Výchozí vypnuto. */
export function docSyncEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.SHAREPOINT_DOC_SYNC_ENABLED === 'true'
}

/** Člen, jehož token kontrola používá: vlastní proměnná, jinak člen pošty. */
export function docSyncMemberFromEnv(env: Record<string, string | undefined>): string | null {
  return env.SHAREPOINT_DOC_SYNC_MEMBER_ID?.trim() || env.OUTLOOK_MAIL_SYNC_MEMBER_ID?.trim() || null
}
