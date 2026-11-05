// Doručení přehledu (digestu) e-mailem přes Microsoft Graph.
//
// Rozhodnutí vlastníka 2026-09-28 (nahrazuje plán se servisní schránkou
// cockpit@): přehled odchází z MILOVY VLASTNÍ SCHRÁNKY viktor@mummiesdaddies.com přes
// jeho delegované připojení Outlooku — žádná registrace appky v Entra, žádný
// app-only client secret, žádné Exchange RBAC. Celé je to VYPNUTÉ, dokud
// DIGEST_SEND_ENABLED !== 'true' (app/api/cron/weekly-digest/route.ts pak
// vrací 404 a nic nedělá).
//
// Rytmus (plán přestavby, kap. 9): cron běží DENNĚ v 05:00 UTC (vercel.json;
// Hobby = nejvýš 1× denně, spuštění kdykoli v té hodině). Nový cron se
// nepřidává; o druhu rozhoduje pražský den v digestKindFor.
//  - pondělí a pátek (pražský čas) = přehled týdne, odchází VŽDY. Obsahem je
//    PROVOZNÍ PŘEHLED firmy (domain/crm/opsReport.ts, e-mail opsReportEmail.ts):
//    obchody, dodávky podle milníků, čeká na nás / na klienta, Ke schválení,
//    riziko termínů a kapacity, neověřené položky a Stav zdrojů; v pondělí za
//    minulý týden Po–Ne, v pátek za tento. Když se provozní přehled nepodaří
//    složit, odejde dosavadní přehled týdne (follow-upy, firmy k oslovení,
//    blokace) — pondělí ani pátek nezůstanou bez e-mailu,
//  - ostatní dny = krátký ranní souhrn (bez „Firem k oslovení"), jen když je
//    co hlásit: follow-up po termínu, blokovaný obchod, nebo zdroj ve
//    „Stavu zdrojů", který je zastaralý nebo skončil chybou
//    (Digest.sourceAlerts) — rozbitý zdroj souhrn odešle vždy.
// „Jednou denně" drží marker digest_send_log (pražský den, druh).
//
// ── Režim delegated (výchozí; DIGEST_SEND_MODE chybí nebo =delegated) ──────
// Token člena DIGEST_SENDER_MEMBER_ID (záložně OUTLOOK_MAIL_SYNC_MEMBER_ID —
// Viktor) přes service-only RPC z migrace 0041 (calendar_token_get_for_service
// / calendar_token_update_for_service). Prošlý token se obnoví
// (refreshAccessToken přihlašovací appky MS_CLIENT_ID/MS_CLIENT_SECRET);
// Microsoft může refresh token rotovat, takže když se obnovený token
// neuloží, NEPOSÍLÁ se nic (fail closed). Odeslání: POST /me/sendMail
// (connectors/graph sendMailAsMe). Token musí mít Mail.Send (GRAPH_SCOPES) —
// Viktor jednou znovu připojí Outlook v Nastavení; do té doby Graph vrací 403
// a u konektoru graph_send se zapíše MISSING_MAIL_SEND_ERROR.
// Env (jen server): DIGEST_SEND_ENABLED=true, CRON_SECRET, APP_URL (https),
// DIGEST_RECIPIENTS, OUTLOOK_MAIL_SYNC_MEMBER_ID nebo DIGEST_SENDER_MEMBER_ID,
// MS_CLIENT_ID, MS_CLIENT_SECRET, klíč Supabase se service rolí; migrace
// 0040 (job_run), 0041 (tokenové RPC) a 0053 (digest_send_log) aplikované.
// DIGEST_SENDER ani MS_APP_* se v tomhle režimu nečtou.
//
// ── Režim app (volitelná alternativa, DIGEST_SEND_MODE=app) ────────────────
// Servisní schránka DIGEST_SENDER (výchozí cockpit@mummiesdaddies.com) s app-only
// tokenem z VLASTNÍ registrace v Entra, omezené přes Exchange RBAC jen na tu
// schránku. Nastavení správcem (jednorázově, před zapnutím):
// 1) Microsoft 365: vytvořit schránku cockpit@mummiesdaddies.com (stačí sdílená
//    schránka bez licence — posílá se jejím jménem, nikdo se do ní nepřihlašuje).
// 2) Entra ID → App registrations → nová registrace (single tenant), např.
//    „Cockpit – odesílání". Certificates & secrets → client secret
//    (hodnotu hned uložit do Vercelu, znovu se nezobrazí; hlídat expiraci).
//    Z Overview: Directory (tenant) ID → MS_APP_TENANT_ID, Application
//    (client) ID → MS_APP_CLIENT_ID. Záměrně JINÁ registrace než přihlašovací
//    appka MS_CLIENT_ID (ta má delegovaná práva uživatelů).
// 3) Omezit appku jen na cockpit@ přes RBAC for Applications v Exchange Online
//    (nahrazuje Application Access Policies):
//      Connect-ExchangeOnline
//      New-ServicePrincipal -AppId <Application ID> -ObjectId <Object ID
//        z Enterprise applications, NE z App registrations> -DisplayName "Cockpit"
//      New-ManagementScope -Name "Cockpit sender" `
//        -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'cockpit@mummiesdaddies.com'"
//      New-ManagementRoleAssignment -App <Object ID> -Role "Application Mail.Send" `
//        -CustomResourceScope "Cockpit sender"
//      Test-ServicePrincipalAuthorization -Identity <Object ID> -Resource cockpit@mummiesdaddies.com
//        (InScope = True; pro jinou schránku, např. viktor@, musí vyjít False)
//    POZOR: Mail.Send NEUDĚLOVAT (resp. odebrat admin consent) v Entra → API
//    permissions. Oprávnění z Entra a z Exchange RBAC se sčítají — plošný
//    Mail.Send z Entra by omezení na jednu schránku zrušil (appka by mohla
//    posílat jako kdokoli ve firmě). Změna RBAC se projeví za 30 min – 2 h.
// 4) Env navíc k delegated (bez MS_CLIENT_* a member id): DIGEST_SEND_MODE=app,
//    MS_APP_TENANT_ID, MS_APP_CLIENT_ID, MS_APP_CLIENT_SECRET,
//    DIGEST_SENDER=cockpit@mummiesdaddies.com (výchozí, když chybí).
//
// Společné pro oba režimy: DIGEST_RECIPIENTS = max. 20 adres, jen
// @mummiesdaddies.com; při odeslání se navíc vyřadí adresy, které nejsou členy týmu
// s rolí vedeni/obchodnik (team_member).
//
// Zdroje: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
//         https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
//         https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
//         https://vercel.com/docs/cron-jobs/usage-and-pricing (Hobby: 1× denně, ±59 min)
//
// ── Co tu je ────────────────────────────────────────────────────────────────
// Čisté části (validace env a příjemců, druh přehledu, rozhodnutí poslat /
// neposlat) a deliverDigest s vstříknutými závislostmi, ať jde celý tok
// testovat s falešným fetch a bez databáze. Zámek (runJob z worker/) si
// předává route — domain/ na worker/ sahat nesmí.
//
// Příjemci: DIGEST_RECIPIENTS smí obsahovat jen @mummiesdaddies.com (jinak chyba
// konfigurace s počtem, bez adres) a při odeslání se ještě zúží na adresy
// z team_member (filterTeamRecipientsAsService). Do logu a job_run jdou jen
// počty.
//
// Proč vlastní loadDigestAsService místo getTodaysDigest: getTodaysDigest
// čte přes createClient (session přihlášeného uživatele). Cron žádnou session
// nemá, RLS by vrátilo prázdná data a e-mail by tvrdil „nic nečeká", i když
// to není pravda. Tady se stejné zdroje čtou service-role klientem a skládají
// stejnými čistými funkcemi (dueFollowUps přes getDueFollowUps,
// dueForOutreach, buildDigest).

import { createHash, timingSafeEqual } from 'node:crypto'
import type { AppCredentials, OutgoingMail, SendMailResult } from '@/connectors/graph'
import { getConnectorState } from '@/core/connectorState'
import { createAdminClient } from '@/lib/supabase/admin'
import { pragueDayOf } from '@/lib/pragueDate'
import { COMPANY } from '@/config'
import { buildDigest, outlookMailSyncEnabledFromEnv, sectionTotal, type BlockedDeal, type Digest, type DigestFollowUp } from '@/domain/crm/digest'
import { normalizeAppUrl, renderDigestEmail, type DigestEmailSource } from '@/domain/crm/digestEmail'
import { defaultWeek } from '@/domain/crm/changes'
import { opsReportItemCount, type OpsReport } from '@/domain/crm/opsReport'
import { renderOpsReportEmail } from '@/domain/crm/opsReportEmail'
import { loadOpsReport } from '@/domain/crm/queries/opsReport'
import { logError } from '@/lib/log'
import { getDueFollowUps } from '@/domain/crm/queries/followUps'
import { getMeetingIntakeStats } from '@/domain/crm/queries/meetingIntake'
import { lastApiMeetingNoteAt } from '@/domain/crm/queries/meetingNotes'
import { dueForOutreach, type OutreachAccount } from '@/domain/crm/outreach'
import { applyOutreachOptOut } from '@/domain/crm/outreachContacts'
import { loadAccountOptOut } from '@/domain/crm/queries/outreachOptOut'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import type { StoredToken } from '@/domain/crm/mailSync'
import { loadMailWebhookHealth } from '@/domain/crm/mailSyncService'
import { runJobHealthCheck } from '@/domain/crm/jobHealth'
import { loadOAuthHealth } from '@/lib/oauthOverview'

export const DIGEST_JOB_NAME = 'weekly-digest'
export const GRAPH_SEND_CONNECTOR = 'graph_send'
export const DEFAULT_DIGEST_SENDER = COMPANY.digestSender
export const MAX_DIGEST_RECIPIENTS = 20
/** Přehled nese interní data (obchody, blokery) — jen na firemní adresy. */
export const DIGEST_RECIPIENT_DOMAIN = COMPANY.emailDomain

// ── Autorizace cronu ────────────────────────────────────────────────────────

/** `Authorization: Bearer ${CRON_SECRET}` v konstantním čase (jako outlook-mail). */
export function isCronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  // Hash srovná délky, takže timingSafeEqual nevyzradí ani délku tajemství.
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

// ── Konfigurace ─────────────────────────────────────────────────────────────

// Záměrně přísné: jedna adresa, žádná jména „Jan <a@b>", žádné mezery ani
// znaky, které by šly zneužít v hlavičce. Doména musí mít tečku a TLD ≥ 2.
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value) && !value.includes('..')
}

export type RecipientsResult = { ok: true; recipients: string[] } | { ok: false; error: string }

/** DIGEST_RECIPIENTS: čárkami oddělené adresy @mummiesdaddies.com, bez duplicit, 1–20. */
export function parseDigestRecipients(raw: string | undefined): RecipientsResult {
  const parts = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return { ok: false, error: 'DIGEST_RECIPIENTS je prázdné' }
  const invalid = parts.filter((p) => !isValidEmail(p)).length
  // Neplatnou adresu nevypisujeme — jen počet (log nemá nést osobní údaje).
  if (invalid > 0) return { ok: false, error: `DIGEST_RECIPIENTS obsahuje ${invalid} neplatnou adresu/adres` }
  // Mimo firemní doménu nic neposíláme (překlep v env = únik interních dat).
  const foreign = parts.filter((p) => !p.endsWith(`@${DIGEST_RECIPIENT_DOMAIN}`)).length
  if (foreign > 0) {
    return { ok: false, error: `DIGEST_RECIPIENTS obsahuje ${foreign} adresu/adres mimo @${DIGEST_RECIPIENT_DOMAIN} — povolené jsou jen firemní adresy` }
  }
  const recipients = Array.from(new Set(parts))
  if (recipients.length > MAX_DIGEST_RECIPIENTS) {
    return { ok: false, error: `DIGEST_RECIPIENTS má ${recipients.length} adres, max. ${MAX_DIGEST_RECIPIENTS}` }
  }
  return { ok: true, recipients }
}

export type DigestSendMode = 'delegated' | 'app'
/** Rozhodnutí 2026-09-28: z Viktorovy schránky přes jeho delegované připojení. */
export const DEFAULT_DIGEST_SEND_MODE: DigestSendMode = 'delegated'

type DigestDeliveryBase = {
  appUrl: string
  recipients: string[]
}

/** Servisní schránka s app-only tokenem (volitelná alternativa). */
export type AppDigestDeliveryConfig = DigestDeliveryBase & {
  mode: 'app'
  sender: string
  credentials: AppCredentials
}

/** Vlastní schránka člena přes jeho delegovaný token (výchozí). */
export type DelegatedDigestDeliveryConfig = DigestDeliveryBase & {
  mode: 'delegated'
  /** team_member.id (= calendar_token.member_id) odesílatele. */
  senderMemberId: string
}

export type DigestDeliveryConfig = AppDigestDeliveryConfig | DelegatedDigestDeliveryConfig

export type ConfigResult = { ok: true; config: DigestDeliveryConfig } | { ok: false; errors: string[] }

/** DIGEST_SEND_MODE: prázdné = výchozí delegated; neznámá hodnota = null (chyba konfigurace). */
export function parseDigestSendMode(raw: string | undefined): DigestSendMode | null {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return DEFAULT_DIGEST_SEND_MODE
  return value === 'delegated' || value === 'app' ? value : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Chyby obsahují jen JMÉNA proměnných, nikdy hodnoty. */
export function readDigestDeliveryConfig(env: Record<string, string | undefined>): ConfigResult {
  const errors: string[] = []

  const mode = parseDigestSendMode(env.DIGEST_SEND_MODE)
  if (!mode) errors.push('DIGEST_SEND_MODE musí být delegated (výchozí) nebo app')

  let appUrl = ''
  try {
    appUrl = normalizeAppUrl(env.APP_URL?.trim() ?? '')
  } catch {
    errors.push('APP_URL chybí nebo není https URL')
  }

  const recipients = parseDigestRecipients(env.DIGEST_RECIPIENTS)
  if (!recipients.ok) errors.push(recipients.error)

  if (mode === 'app') {
    const sender = (env.DIGEST_SENDER?.trim() || DEFAULT_DIGEST_SENDER).toLowerCase()
    if (!isValidEmail(sender)) errors.push('DIGEST_SENDER není platná adresa')

    const tenantId = env.MS_APP_TENANT_ID?.trim() ?? ''
    const clientId = env.MS_APP_CLIENT_ID?.trim() ?? ''
    const clientSecret = env.MS_APP_CLIENT_SECRET ?? ''
    if (!tenantId) errors.push('MS_APP_TENANT_ID chybí')
    if (!clientId) errors.push('MS_APP_CLIENT_ID chybí')
    if (!clientSecret) errors.push('MS_APP_CLIENT_SECRET chybí')

    if (errors.length > 0 || !recipients.ok) return { ok: false, errors }
    return {
      ok: true,
      config: { mode, appUrl, recipients: recipients.recipients, sender, credentials: { tenantId, clientId, clientSecret } },
    }
  }

  if (mode === 'delegated') {
    // Odesílatel = člen, jehož Outlook token se použije. Záložně člen syncu
    // pošty (Viktor), ať se nemusí nastavovat totéž uuid dvakrát.
    const own = env.DIGEST_SENDER_MEMBER_ID?.trim() ?? ''
    const source = own ? 'DIGEST_SENDER_MEMBER_ID' : 'OUTLOOK_MAIL_SYNC_MEMBER_ID'
    const memberId = (own || env.OUTLOOK_MAIL_SYNC_MEMBER_ID?.trim() || '').toLowerCase()
    if (!memberId) errors.push('DIGEST_SENDER_MEMBER_ID chybí (a není ani záložní OUTLOOK_MAIL_SYNC_MEMBER_ID)')
    else if (!UUID_RE.test(memberId)) errors.push(`${source} není uuid člena týmu`)
    // Cron token skoro vždy obnovuje (žije ~1 h) — bez přihlašovací appky to nejde.
    if (!env.MS_CLIENT_ID?.trim()) errors.push('MS_CLIENT_ID chybí (potřeba k obnově tokenu Outlooku)')
    if (!env.MS_CLIENT_SECRET) errors.push('MS_CLIENT_SECRET chybí (potřeba k obnově tokenu Outlooku)')

    if (errors.length > 0 || !recipients.ok) return { ok: false, errors }
    return { ok: true, config: { mode, appUrl, recipients: recipients.recipients, senderMemberId: memberId } }
  }

  return { ok: false, errors }
}

// ── Druh přehledu a štítek data ────────────────────────────────────────────

/** Den v týdnu v Praze (0 = neděle … 6 = sobota). */
export function pragueWeekday(now: Date): number {
  return new Date(`${pragueDayOf(now)}T00:00:00Z`).getUTCDay()
}

export type DigestKind = 'weekly' | 'daily'

/**
 * Pondělí a pátek = týdenní přehled, který odchází VŽDY (i „nic nečeká" je
 * informace). Jiný den = ranní souhrn, který se posílá jen, když je co hlásit.
 */
export function digestKindFor(now: Date): DigestKind {
  const d = pragueWeekday(now)
  return d === 1 || d === 5 ? 'weekly' : 'daily'
}

/**
 * Přehled týdne odchází vždy. Ranní souhrn (digest bez „Firem k oslovení",
 * viz loadDigestAsService) jen když má položky (follow-upy po termínu,
 * blokované obchody) nebo zdroj potřebuje pozornost (zastaralý / chyba) —
 * rozbitý zdroj ho odešle i bez jiného obsahu.
 */
export function shouldSendDigest(kind: DigestKind, digest: Pick<Digest, 'isEmpty' | 'sourceAlerts'>): boolean {
  return kind === 'weekly' || !digest.isEmpty || digest.sourceAlerts > 0
}

const labelFmt = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: COMPANY.timeZone,
  weekday: 'long',
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
})

/** Např. „pondělí 28. 9. 2026". */
export function czechDateLabel(now: Date): string {
  return labelFmt.format(now).replace(/\s+/g, ' ').trim()
}

// ── Delegovaný token (režim delegated) ─────────────────────────────────────

/** Text chyby konektoru graph_send, když token nemá Mail.Send. Čte ho člověk. */
export const MISSING_MAIL_SEND_ERROR = 'Chybí oprávnění Mail.Send — znovu připojte Outlook v Nastavení'
export const SENDER_NOT_CONNECTED_ERROR =
  'Outlook odesílatele přehledu není připojený — připojte Outlook v Nastavení (udělí i Mail.Send)'
export const SENDER_REFRESH_FAILED_ERROR =
  'Obnova přihlášení k Outlooku odesílatele selhala — znovu připojte Outlook v Nastavení (udělí i Mail.Send)'
export const SENDER_TOKEN_SAVE_ERROR =
  'Obnovené přihlášení k Outlooku se nepodařilo uložit — přehled se neposlal'

/** Token pro odeslání; app-only výsledek (getAppOnlyToken) je s ním kompatibilní. */
export type DigestTokenResult = { ok: true; accessToken: string } | { ok: false; status: number; message: string }

export type DelegatedTokenDeps = {
  /** calendar_token_get_for_service (0041). Chyba = vyhodit s očištěnou zprávou. */
  load: () => Promise<StoredToken | null>
  /** connectors/graph refreshAccessToken (null = obnova selhala). */
  refresh: (refreshToken: string) => Promise<{ access_token: string; refresh_token: string; expires_in: number } | null>
  /** calendar_token_update_for_service (0041); false = neuloženo. */
  save: (t: { access_token: string; refresh_token: string; expires_at: string }) => Promise<boolean>
  now: () => number
}

const tokenFail = (message: string): DigestTokenResult => ({ ok: false, status: 0, message })

/**
 * Platný delegovaný token odesílatele. Stejný postup jako resolveAccessToken
 * u syncu pošty (domain/crm/mailSync.ts), ale vrací výsledek místo výjimky
 * (deliverDigest pak chybu zapíše u graph_send) a hlášky míří na Mail.Send:
 *  - platný (s rezervou 60 s) → použít,
 *  - jinak obnovit a rotovaný refresh token ULOŽIT; když uložení selže,
 *    fail closed — neposílá se (nový token by se ztratil a starý už
 *    nemusí platit).
 * Tokeny se nikdy nevrací v chybě ani nelogují.
 */
export async function getDelegatedSendToken(deps: DelegatedTokenDeps, skewMs = 60_000): Promise<DigestTokenResult> {
  let stored: StoredToken | null
  try {
    stored = await deps.load()
  } catch (e) {
    return tokenFail(e instanceof Error ? e.message : 'Načtení tokenu odesílatele selhalo')
  }
  if (!stored?.access_token || !stored.refresh_token) return tokenFail(SENDER_NOT_CONNECTED_ERROR)
  if (stored.expires_at && Date.parse(stored.expires_at) - skewMs > deps.now()) {
    return { ok: true, accessToken: stored.access_token }
  }

  let refreshed: Awaited<ReturnType<DelegatedTokenDeps['refresh']>>
  try {
    refreshed = await deps.refresh(stored.refresh_token)
  } catch {
    refreshed = null
  }
  if (!refreshed) return tokenFail(SENDER_REFRESH_FAILED_ERROR)

  const lifetime = Number.isFinite(refreshed.expires_in) ? refreshed.expires_in : 0
  let saved = false
  try {
    saved = await deps.save({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: new Date(deps.now() + lifetime * 1000).toISOString(),
    })
  } catch {
    saved = false
  }
  if (!saved) return tokenFail(SENDER_TOKEN_SAVE_ERROR)
  return { ok: true, accessToken: refreshed.access_token }
}

/**
 * Delegované odeslání: 403 = token bez Mail.Send (ErrorAccessDenied) → místo
 * „Graph 403 …" srozumitelná hláška, co udělat. Ostatní výsledky beze změny.
 */
export function explainDelegatedSendResult(result: SendMailResult): SendMailResult {
  if (!result.ok && result.status === 403) return { ok: false, status: 403, message: MISSING_MAIL_SEND_ERROR }
  return result
}

// ── Doručení ────────────────────────────────────────────────────────────────

export type LoadedDigest = {
  digest: Digest
  source: DigestEmailSource
  /**
   * Provozní přehled pro pondělí a pátek (druh 'weekly'). Chybí/null = nepodařilo
   * se ho složit → odejde dosavadní přehled týdne z `digest`.
   */
  report?: OpsReport | null
}

export type DigestDeliveryDeps = {
  now: () => Date
  /**
   * Atomicky zabere marker „dnes odesláno" (digest_send_log, 0053; INSERT …
   * ON CONFLICT DO NOTHING). true = zabral tenhle běh, false = marker už
   * existoval (dnes odešlo / odesílá jiný běh). Chyba = vyhodit (fail closed).
   */
  claimSendMarker: (pragueDay: string, kind: DigestKind) => Promise<boolean>
  /** Smaže marker, ať to další běh zkusí znovu (po selhání / když se neposílá). */
  releaseSendMarker: (pragueDay: string, kind: DigestKind) => Promise<void>
  /** Vrátí jen ty adresy, které patří členům týmu (team_member). */
  filterTeamRecipients: (recipients: string[]) => Promise<string[]>
  /** Ranní souhrn ('daily') bez „Firem k oslovení" — viz loadDigestAsService. */
  loadDigest: (now: Date, kind: DigestKind) => Promise<LoadedDigest>
  getToken: () => Promise<DigestTokenResult>
  sendMail: (accessToken: string, mail: OutgoingMail) => Promise<SendMailResult>
  recordSuccess: () => Promise<void>
  recordError: (message: string) => Promise<void>
}

export type DigestDeliveryStats = {
  kind: DigestKind
  prague_day: string
  outcome: 'sent' | 'already_sent' | 'nothing_to_report'
  /** Jen u odeslaného (informativně; o „dnes už odešlo" rozhoduje digest_send_log). */
  sent_day?: string
  /** Počet příjemců, ne adresy (job_run je čitelný týmem, drží jen čísla). */
  recipients: number
  /** Kolik adres z konfigurace vypadlo, protože nejsou v team_member. */
  dropped_recipients?: number
  items: number
  /** Kolik zdrojů bylo zastaralých / s chybou (Digest.sourceAlerts). */
  source_alerts?: number
  /** Jen u pondělního/pátečního provozního přehledu (jinak dosavadní přehled). */
  format?: 'provozni_prehled'
}

/** Best-effort vedlejší zápis: jeho selhání nesmí změnit výsledek běhu. */
async function bestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    // záměrně ignorováno — viz volající
  }
}

/** Celkový počet položek (i skrytých v oříznutých sekcích). */
function itemCount(digest: Digest): number {
  return digest.sections.reduce((n, s) => n + sectionTotal(s), 0)
}

/**
 * Jeden běh doručení. Volá se UVNITŘ zámku runJob (proti překryvu běhů);
 * „jednou denně" navíc drží trvalý marker digest_send_log (0053):
 *  1) příjemci se zúží na členy týmu (team_member) — nikdo mimo tým nic
 *     nedostane, ani když zůstane v env; logují se jen počty,
 *  2) marker (pražský den, druh) se zabere PŘED odesláním; když už
 *     existoval, nic se neposílá (already_sent),
 *  3) když se nakonec neposílá (ranní souhrn bez obsahu) nebo cokoli selže
 *     (načtení dat, token, odeslání), marker se smaže, ať to další běh zkusí
 *     znovu; selhání tokenu/odeslání zapíše chybu konektoru 'graph_send'
 *     a vyhodí — runJob běh označí jako failed,
 *  4) recordSuccess je best-effort: odeslaný e-mail nikdy nezmění na chybu.
 */
export async function deliverDigest(
  config: Pick<DigestDeliveryConfig, 'appUrl' | 'recipients'>,
  deps: DigestDeliveryDeps,
): Promise<DigestDeliveryStats> {
  const now = deps.now()
  const day = pragueDayOf(now)
  const kind = digestKindFor(now)

  const members = new Set((await deps.filterTeamRecipients(config.recipients)).map((r) => r.toLowerCase()))
  const recipients = config.recipients.filter((r) => members.has(r.toLowerCase()))
  const dropped = config.recipients.length - recipients.length
  const base = { kind, prague_day: day, recipients: recipients.length, dropped_recipients: dropped }
  if (recipients.length === 0) {
    throw new Error(`Žádný z ${config.recipients.length} příjemců DIGEST_RECIPIENTS není člen týmu (team_member) — nic se neposlalo`)
  }

  if (!(await deps.claimSendMarker(day, kind))) return { ...base, outcome: 'already_sent', items: 0 }

  let items = 0
  let sourceAlerts = 0
  let ops: OpsReport | null = null
  try {
    const { digest, source, report } = await deps.loadDigest(now, kind)
    // Pondělí a pátek: provozní přehled, když ho loader složil; jinak dosavadní přehled týdne.
    ops = kind === 'weekly' ? report ?? null : null
    items = ops ? opsReportItemCount(ops) : itemCount(digest)
    sourceAlerts = digest.sourceAlerts
    if (!shouldSendDigest(kind, digest)) {
      await deps.releaseSendMarker(day, kind)
      return { ...base, outcome: 'nothing_to_report', items, source_alerts: sourceAlerts }
    }

    const generatedAtLabel = czechDateLabel(now)
    const email = ops
      ? renderOpsReportEmail(ops, { appUrl: config.appUrl, generatedAtLabel })
      : renderDigestEmail(digest, { appUrl: config.appUrl, generatedAtLabel, source, variant: kind })

    const token = await deps.getToken()
    if (!token.ok) {
      await bestEffort(() => deps.recordError(token.message))
      throw new Error(token.message)
    }
    const sent = await deps.sendMail(token.accessToken, { subject: email.subject, html: email.html, to: recipients })
    if (!sent.ok) {
      await bestEffort(() => deps.recordError(sent.message))
      throw new Error(sent.message)
    }
  } catch (err) {
    // Neodešlo → uvolnit marker pro další pokus. Selhání uvolnění nesmí
    // zakrýt původní chybu (marker pak zůstane a dnes se už nepošle — fail closed).
    await bestEffort(() => deps.releaseSendMarker(day, kind))
    throw err
  }
  await bestEffort(() => deps.recordSuccess())
  return { ...base, outcome: 'sent', sent_day: day, items, source_alerts: sourceAlerts, ...(ops ? { format: 'provozni_prehled' as const } : {}) }
}

// ── Data pro cron (service role) ───────────────────────────────────────────

type Admin = ReturnType<typeof createAdminClient>

async function blockedDeals(admin: Admin): Promise<BlockedDeal[]> {
  const { data, error } = await admin.from('deal')
    .select('id, account_id, title, status_blocker, account:account!deal_account_id_fkey(name)')
    .not('status_blocker', 'is', null)
    .order('title')
  if (error) throw new Error(`Načtení blokovaných obchodů selhalo: ${error.message}`)
  type Row = { id: number; account_id: number | null; title: string; status_blocker: string | null; account: { name?: string } | null }
  return ((data ?? []) as unknown as Row[])
    .filter((d): d is Row & { status_blocker: string } => d.status_blocker != null)
    .map((d) => ({ id: d.id, account_id: d.account_id, title: d.title, account_name: d.account?.name ?? null, status_blocker: d.status_blocker }))
}

async function followUpsWithAccounts(admin: Admin, now: Date): Promise<DigestFollowUp[]> {
  const nudges = await getDueFollowUps(now)
  if (nudges.length === 0) return []
  const { data, error } = await admin.from('deal').select('id, account_id')
    .in('id', Array.from(new Set(nudges.map((n) => n.deal_id))))
  if (error) throw new Error(`Načtení klientů k follow-upům selhalo: ${error.message}`)
  const byId = new Map(((data ?? []) as { id: number; account_id: number | null }[]).map((d) => [d.id, d.account_id]))
  // Jen pole Nudge + account_id — adresy příjemců upomínek do e-mailu nepatří.
  return nudges.map((n): DigestFollowUp => ({
    deal_id: n.deal_id,
    title: n.title,
    account_name: n.account_name,
    due: n.due,
    days_overdue: n.days_overdue,
    level: n.level,
    account_id: byId.get(n.deal_id) ?? null,
  }))
}

async function outreach(admin: Admin, now: Date) {
  const [accounts, deals] = await Promise.all([
    // Bez našeho posledního e-mailu firma do fronty nepatří (dueForOutreach).
    admin.from('account').select('id, name, last_inbound_at, last_outbound_at, nudged_on, snooze_until, notes')
      .not('last_outbound_at', 'is', null),
    admin.from('deal').select('account_id').in('stage', OPEN_DEAL_STAGE_FILTER),
  ])
  if (accounts.error) throw new Error(`Načtení firem selhalo: ${accounts.error.message}`)
  if (deals.error) throw new Error(`Načtení obchodů selhalo: ${deals.error.message}`)
  const open = new Set((deals.data ?? []).map((d) => d.account_id as number))
  const rows = (accounts.data ?? []) as (Omit<OutreachAccount, 'has_open_deal'> & { notes: string | null })[]
  const due = dueForOutreach(rows.map((a) => ({ ...a, has_open_deal: open.has(a.id) })), now)
  // Firmy, které nesouhlasí s oslovením (0087 + poznámka), přehled nenabídne.
  const notes = new Map(rows.map((a) => [a.id, a.notes ?? null]))
  return applyOutreachOptOut(due, await loadAccountOptOut(admin, due.map((c) => c.account_id), notes)).queue
}

// Stejné pravidlo jako obrazovka (i zápis, který doplnil naplánovanou schůzku).
async function lastMeetingNoteAt(admin: Admin): Promise<string | null> {
  return lastApiMeetingNoteAt(admin)
}

/**
 * Stejné zdroje jako getTodaysDigest, ale přes service-role klienta (cron
 * nemá session). Ranní souhrn ('daily') je krátký: „Firmy k oslovení" se pro
 * něj vůbec nečtou (jsou v přehledu týdne) a nerozhodují o odeslání.
 *
 * Přehled týdne ('weekly', pondělí a pátek) navíc skládá provozní přehled
 * ze stejných existujících dotazů jako stránka Týden (loadOpsReport), přes
 * tentýž servisní klient. canSeeSales = true: příjemci projdou jen s rolí
 * vedeni/obchodnik (filterTeamRecipientsAsService), tedy s can_see_sales.
 * Týden: v pondělí minulý Po–Ne, v pátek tento (defaultWeek). Selhání
 * provozního přehledu se zaloguje a odejde dosavadní přehled týdne.
 */
export async function loadDigestAsService(now: Date, kind: DigestKind = 'weekly'): Promise<LoadedDigest> {
  const admin = createAdminClient()
  const [followUps, outreachList, blocked, lastSkillNote, graphCalendar, outlookMailInbox, outlookMailSent, graphSend, mailWebhook, intake, jobCheck, oauthHealth] =
    await Promise.all([
      followUpsWithAccounts(admin, now),
      kind === 'daily' ? Promise.resolve([]) : outreach(admin, now),
      blockedDeals(admin),
      lastMeetingNoteAt(admin),
      getConnectorState('graph_calendar'),
      getConnectorState('outlook:inbox'),
      getConnectorState('outlook:sent'),
      getConnectorState(GRAPH_SEND_CONNECTOR),
      loadMailWebhookHealth(process.env, now.getTime()),
      // Příjem diktátu (0078): bez migrace null, chyba čtení řádek zdroje nerozbije.
      getMeetingIntakeStats(admin, now).catch(() => null),
      // Denní kontrola úloh: visící běhy uzavře (0100) a vrátí stav; nevyhazuje.
      runJobHealthCheck(admin, now),
      // Konektor Claude za 24 h (diagnostika v audit_event); nevyhazuje.
      loadOAuthHealth(admin, now),
    ])
  const lastNote = [lastSkillNote, intake?.lastReceivedAt ?? null]
    .filter((v): v is string => v != null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  const digest = buildDigest({
    followUps,
    outreach: outreachList,
    blockedDeals: blocked,
    connectorStates: { graphCalendar, outlookMailInbox, outlookMailSent, graphSend },
    lastMeetingNoteAt: lastNote,
    meetingIntake: intake ? { received30d: intake.received30d, unmatched: intake.unmatched } : null,
    outlookMailSyncEnabled: outlookMailSyncEnabledFromEnv(process.env),
    mailWebhook,
    jobHealth: jobCheck.health,
    oauthHealth,
    generatedAt: now,
  })
  const source = { followUps, outreach: outreachList, blockedDeals: blocked }
  if (kind !== 'weekly') return { digest, source }

  let report: OpsReport | null = null
  try {
    report = await loadOpsReport({
      now,
      week: defaultWeek(pragueDayOf(now)),
      canSeeSales: true,
      digest: { digest, source },
      db: admin,
      asService: true,
    })
  } catch (e) {
    logError('cron.weeklyDigest.opsReport', e)
  }
  return { digest, source, report }
}

// Role, které smí vidět obchodní data (obchody, částky) — stejné pravidlo
// jako can_see_sales() v migraci 0020 (RLS pro deal/account/…). Přehled nese
// přesně tahle data (follow-upy, firmy k oslovení, blokované obchody), takže
// příjemci musí projít stejným sítem, ne jen "je člen týmu".
// Shodu s can_see_sales() a ostatními kopiemi hlídá test/sales-roles.test.ts.
export const DIGEST_ALLOWED_ROLES: ReadonlySet<string> = new Set(['vedeni', 'obchodnik'])

/**
 * Zúží příjemce na e-maily členů týmu s rolí, která smí vidět obchodní data
 * (vedeni/obchodnik — stejné pravidlo jako can_see_sales() v migraci 0020).
 * Tým je malý, čteme všechny řádky a porovnáváme e-mail bez ohledu na
 * velikost písmen. Chyba = vyhodit (fail closed: bez ověření nikomu neposílat).
 */
export async function filterTeamRecipientsAsService(recipients: string[]): Promise<string[]> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('team_member').select('email, role')
  if (error) throw new Error(`Načtení členů týmu selhalo: ${error.message}`)
  const emails = new Set(((data ?? []) as { email: string | null; role: string | null }[])
    .filter((m) => DIGEST_ALLOWED_ROLES.has(m.role ?? ''))
    .map((m) => (m.email ?? '').trim().toLowerCase())
    .filter(Boolean))
  return recipients.filter((r) => emails.has(r.toLowerCase()))
}
