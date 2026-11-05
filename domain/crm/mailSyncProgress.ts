// Postup prvního načtení složky pošty a věta o výsledku ručního běhu.
// Čisté funkce bez I/O; kurzor a statistiky dodává volající.
//
// Postup: první načtení jde od nejnovějších zpráv zpět do začátku okna
// (`since`, viz domain/crm/mailSync.ts). Kurzor si pamatuje nejstarší dosud
// načtené datum (`reached`) a počet běhů (`runs`). Podíl hotového je
// (dnes − reached) / (dnes − since). Odhad zbývajících běhů vychází z toho,
// kolik podílu zvládl dosavadní počet běhů — je to odhad, starší pošta bývá
// řidší i hustší.

import { FOLDERS, type FolderKey, type FolderStats, type MailCursor, type MailSyncStats } from '@/domain/crm/mailSync'
import { formatDate } from '@/lib/format'

export type MailSyncProgress = {
  /** Začátek okna (ISO). */
  since: string
  /** Nejstarší dosud načtené datum (ISO); null = zatím žádná stránka. */
  reachedAt: string | null
  /** Podíl hotového 0–100, celé procento. */
  percent: number
  /** Odhad zbývajících běhů; null = zatím nejde odhadnout. */
  runsLeft: number | null
}

/** Postup první synchronizace, nebo null (delta fáze, bez okna, kurzor bez `since`). */
export function mailSyncProgress(cursor: MailCursor | null, nowMs: number): MailSyncProgress | null {
  if (!cursor || cursor.phase !== 'paging' || !cursor.since) return null
  const since = Date.parse(cursor.since)
  const total = nowMs - since
  if (!Number.isFinite(since) || total <= 0) return null

  const reached = cursor.reached ? Date.parse(cursor.reached) : NaN
  const done = Number.isFinite(reached) ? Math.min(total, Math.max(0, nowMs - reached)) : 0
  const share = done / total
  // Stránkování běží, takže 100 % ukážeme až po dotažení (kurzor přejde do delty).
  const percent = Math.min(99, Math.floor(share * 100))

  const runs = cursor.runs ?? 0
  const runsLeft = runs >= 1 && share >= 0.03 ? Math.max(1, Math.ceil((runs * (1 - share)) / share)) : null
  return {
    since: cursor.since,
    reachedAt: Number.isFinite(reached) ? (cursor.reached as string) : null,
    percent,
    runsLeft,
  }
}

function runsWord(n: number): string {
  if (n === 1) return '1 běh'
  return n >= 2 && n <= 4 ? `${n} běhy` : `${n} běhů`
}

/** Věta pro „Stav zdrojů": co je načteno a kolik zhruba zbývá. */
export function describeProgress(p: MailSyncProgress): string {
  const head = p.reachedAt
    ? `Probíhá první načtení historie: načteno zpět do ${formatDate(p.reachedAt)} (okno od ${formatDate(p.since)}), hotovo asi ${p.percent} %.`
    : `Probíhá první načtení historie: okno je od ${formatDate(p.since)}, zatím se nenačetla žádná stránka.`
  const tail =
    p.runsLeft !== null
      ? ` Odhad: ještě asi ${runsWord(p.runsLeft)} (denní běh nebo tlačítko „Dotáhnout další část“).`
      : ' Odhad zbývajících běhů bude po prvních bězích.'
  return head + tail
}

const FOLDER_LABEL: Record<FolderKey, string> = { inbox: 'Doručená', sent: 'Odeslaná' }

function describeFolderRun(key: FolderKey, fs: FolderStats): string {
  const label = FOLDER_LABEL[key]
  switch (fs.outcome) {
    case 'caught_up':
      return `${label}: dotažena (${fs.pages} str., ${fs.inserted} nových zpráv).`
    case 'more_pending':
      return `${label}: načtena další část (${fs.pages} str., ${fs.inserted} nových zpráv), zbývá ještě část.`
    case 'throttled':
      return `${label}: Microsoft dočasně omezil dotazy, zkuste to později.`
    case 'expired':
      return `${label}: synchronizační token vypršel, další běh začne znovu.`
    case 'missing_scope':
      return `${label}: chybí oprávnění Mail.Read, znovu připojte Outlook.`
    case 'error':
      return `${label}: běh skončil chybou${fs.error ? ` (${fs.error})` : ''}.`
    default:
      return `${label}: nepřišla řada (limit stránek nebo času), zkuste to znovu.`
  }
}

/** Souhrn ručního běhu pro tlačítko: jedna věta na složku, jen počty a stavy. */
export function describeManualRun(stats: Pick<MailSyncStats, 'folders'>): string {
  return (Object.keys(FOLDERS) as FolderKey[]).map((k) => describeFolderRun(k, stats.folders[k])).join(' ')
}

// ---------------------------------------------------------------------------
// Ruční běh („Dotáhnout další část")

/** Nejkratší odstup mezi dvěma běhy syncu (cron i ruční), měřeno od startu předchozího. */
export const MANUAL_RUN_MIN_INTERVAL_MS = 60_000

/** Kdo smí spustit ruční běh: správce a obchodní role (rozhodnutí vlastníka 30. 9.). */
export function canRunMailSyncNow(member: { is_admin?: boolean | null; role?: string | null; deactivated_at?: string | null } | null | undefined, seesSales: boolean): boolean {
  if (!member || member.deactivated_at) return false
  return !!member.is_admin || seesSales
}

/** Zbývající čekání v sekundách (0 = smí), podle startu posledního běhu. */
export function manualRunWaitSeconds(lastStartedAt: string | null, nowMs: number): number {
  if (!lastStartedAt) return 0
  const t = Date.parse(lastStartedAt)
  if (!Number.isFinite(t)) return 0
  const left = MANUAL_RUN_MIN_INTERVAL_MS - (nowMs - t)
  return left > 0 ? Math.ceil(left / 1000) : 0
}

export const MANUAL_RUN_MESSAGES = {
  forbidden: 'Ruční synchronizaci pošty smí spustit správce nebo obchodní role.',
  disabled: 'Synchronizace pošty je vypnutá (chybí OUTLOOK_MAIL_SYNC_ENABLED=true v prostředí).',
  memberMissing: 'Synchronizace pošty není dokončená: v prostředí chybí OUTLOOK_MAIL_SYNC_MEMBER_ID.',
  locked: 'Synchronizace pošty už právě běží (denní běh nebo jiný správce). Zkus to za minutu.',
  failed: 'Běh skončil chybou — podrobnosti jsou v záznamu úloh (job_run) a ve Stavu zdrojů.',
  startFailed: 'Synchronizaci se nepodařilo spustit.',
  wait: (s: number) => `Poslední běh začal před chvílí. Další jde spustit za ${s} s.`,
} as const
