// Webhooky Microsoft Graph pro poštu — čistá logika bez I/O
// (docs/PROVOZ.md, kapitola 8: „odpověď klienta v Outlooku se do
// hodiny objeví jako událost u správné firmy a přerušená synchronizace je
// v Cockpitu vidět").
//
// PROČ WEBHOOK: Vercel Hobby pouští cron nejvýš 1× denně, hodinový polling
// tedy nejde. Graph místo toho pošle POST na /api/ms/notifications, kdykoli
// v Doručené nebo Odeslané poště přibude zpráva. Notifikace NIC NEZAPISUJE
// sama — jen spustí stávající delta sync té složky (domain/crm/mailSync.ts),
// který čte metadata z Graph API a zapisuje idempotentně (unikátní
// internet_message_id + direction v mail_event). Obsah notifikace je
// nedůvěryhodný vstup: použije se jen id předplatného (klíč do
// graph_subscription) a clientState (ověření původu); ani id zprávy
// z notifikace se do DB nedostane.
//
// clientState = HMAC(CRON_SECRET, pevný štítek + složka) — žádné nové
// tajemství. V DB je jen jeho SHA-256 otisk (graph_subscription,
// migrace 0066); když se CRON_SECRET změní, otisk nesedí a denní cron
// předplatné založí znovu. Ověření notifikace = přepočet a porovnání
// v konstantním čase; clientState zároveň určuje složku (každá má svůj).
//
// Přepínače: webhook běží, jen když OUTLOOK_MAIL_SYNC_ENABLED i
// OUTLOOK_MAIL_WEBHOOK_ENABLED jsou 'true'. Jinak /api/ms/notifications
// vrací 404 a cron předplatná nezakládá (existující smaže, viz
// domain/crm/mailWebhookRun.ts retireMailSubscriptions).
//
// Orchestrace (Graph + DB přes vstříknuté závislosti) je v
// domain/crm/mailWebhookRun.ts, napojení na Supabase v
// domain/crm/mailSyncService.ts, route handlery jsou tenké slupky.

import {
  clientStateHash,
  clientStateMatches,
  deriveClientState,
  mailFolderSubscriptionResource,
  parseNotificationCollection,
  VALIDATION_TOKEN_MAX_LENGTH,
} from '@/connectors/graph'
import { FOLDERS, type FolderKey } from '@/domain/crm/mailSync'
import { normalizeAppUrl } from '@/domain/crm/digestEmail'

export const MAIL_WEBHOOK_PATH = '/api/ms/notifications'
export const MAIL_WEBHOOK_FOLDERS: readonly FolderKey[] = ['inbox', 'sent']

/** Cron obnovuje předplatné, které vyprší do 36 h (cron běží 1× denně). */
export const RENEW_WITHIN_HOURS = 36
/**
 * reauthorizationRequired může chodit i každých 15 minut; PATCH stejného
 * předplatného častěji než po 10 minutách nedělat (Microsoft Learn varuje
 * před souběžnou reautorizací a obnovou do 10 minut).
 */
export const REAUTH_MIN_INTERVAL_MS = 10 * 60_000

/** Horní mez těla notifikace; Graph posílá malé dávky, víc je podezřelé. */
export const MAX_NOTIFICATION_BODY_BYTES = 1_000_000

const CLIENT_STATE_LABEL = 'cockpit/graph-mail-webhook/v1'

const FOLDER_LABELS: Record<FolderKey, string> = {
  inbox: 'Doručená pošta',
  sent: 'Odeslaná pošta',
}

export function folderLabel(key: FolderKey): string {
  return FOLDER_LABELS[key]
}

// ---------------------------------------------------------------------------
// Přepínače a konfigurace

/** Čistá funkce: webhook je zapnutý jen s oběma přepínači na 'true'. */
export function mailWebhookEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.OUTLOOK_MAIL_SYNC_ENABLED === 'true' && env.OUTLOOK_MAIL_WEBHOOK_ENABLED === 'true'
}

export function webhookConnectorKey(key: FolderKey): string {
  return FOLDERS[key].connector
}

export function webhookResource(key: FolderKey): string {
  return mailFolderSubscriptionResource(FOLDERS[key].graphFolder)
}

export function folderForConnectorKey(connectorKey: string): FolderKey | null {
  return MAIL_WEBHOOK_FOLDERS.find((k) => FOLDERS[k].connector === connectorKey) ?? null
}

export function webhookClientState(secret: string, key: FolderKey): string {
  return deriveClientState(secret, `${CLIENT_STATE_LABEL}/${key}`)
}

export function webhookClientStateHash(secret: string, key: FolderKey): string {
  return clientStateHash(webhookClientState(secret, key))
}

export type NotificationUrlResult = { ok: true; url: string } | { ok: false; error: string }

/** https://<APP_URL>/api/ms/notifications; bez platné https APP_URL nic. */
export function notificationUrlFromEnv(env: Record<string, string | undefined>): NotificationUrlResult {
  const raw = env.APP_URL?.trim()
  if (!raw) return { ok: false, error: 'APP_URL chybí — webhook potřebuje veřejnou https adresu Cockpitu' }
  try {
    return { ok: true, url: `${normalizeAppUrl(raw)}${MAIL_WEBHOOK_PATH}` }
  } catch {
    return { ok: false, error: 'APP_URL není platná https adresa — webhook nejde založit' }
  }
}

// ---------------------------------------------------------------------------
// Řádek graph_subscription (migrace 0066)

export type SubscriptionRow = {
  connector_key: string
  subscription_id: string | null
  resource: string
  expires_at: string | null
  client_state_hash: string | null
  created_at: string
  updated_at: string
  last_notification_at: string | null
  last_error: string | null
}

// ---------------------------------------------------------------------------
// Rozhodnutí o předplatném (cron i lifecycle notifikace)

/**
 * keep     — platné, s rezervou
 * renew    — PATCH nové expirace (vyprší do RENEW_WITHIN_HOURS, nebo
 *            reautorizace na žádost Graphu)
 * create   — žádné předplatné (chybí řádek / id, nebo už vypršelo — Graph ho
 *            smazal sám)
 * recreate — smazat a založit znovu: jiné tajemství (otisk clientState
 *            nesedí), jiný zdroj, nebo poslední operace skončila chybou
 */
export type SubscriptionAction = 'keep' | 'renew' | 'create' | 'recreate'

export function decideSubscriptionAction(
  row: SubscriptionRow | null,
  opts: {
    now: number
    expectedResource: string
    expectedHash: string
    renewWithinMs?: number
    /** Graph poslal reauthorizationRequired — obnovit, i když expirace ještě nehoří. */
    forceRenew?: boolean
  },
): SubscriptionAction {
  if (!row || !row.subscription_id || !row.expires_at) return 'create'
  const exp = Date.parse(row.expires_at)
  if (!Number.isFinite(exp) || exp <= opts.now) return 'create'
  if (row.resource !== opts.expectedResource) return 'recreate'
  if (row.client_state_hash !== opts.expectedHash) return 'recreate'
  if (row.last_error) return 'recreate'
  if (opts.forceRenew) {
    const updated = Date.parse(row.updated_at)
    if (!Number.isFinite(updated) || opts.now - updated >= REAUTH_MIN_INTERVAL_MS) return 'renew'
  }
  const renewWithin = opts.renewWithinMs ?? RENEW_WITHIN_HOURS * 3_600_000
  return exp - opts.now <= renewWithin ? 'renew' : 'keep'
}

// ---------------------------------------------------------------------------
// Příchozí požadavek na /api/ms/notifications

/** Co z notifikací plyne — zpracuje se až po odpovědi (after()). */
export type NotificationWork = {
  /** Id předplatného z ověřených notifikací (jen pro last_notification_at). */
  subscriptionIds: string[]
  /** Složky k delta syncu (změna, missed, subscriptionRemoved). */
  syncFolders: FolderKey[]
  /** subscriptionRemoved — založit znovu. */
  recreateFolders: FolderKey[]
  /** reauthorizationRequired — obnovit (PATCH = reautorizace + nová expirace). */
  renewFolders: FolderKey[]
}

export type NotificationDecision =
  | { kind: 'disabled' }
  | { kind: 'validation'; token: string }
  | { kind: 'bad_request'; reason: string }
  | { kind: 'too_large' }
  | { kind: 'misconfigured'; reason: string }
  | { kind: 'unauthorized'; invalid: number }
  | { kind: 'accepted'; work: NotificationWork; accepted: number; invalid: number; ignored: number }

export type NotificationRequestInput = {
  enabled: boolean
  /** CRON_SECRET — z něj se odvozuje clientState. */
  secret: string | undefined
  /** OUTLOOK_MAIL_SYNC_MEMBER_ID je nastavené (bez něj není čí poštu syncovat). */
  memberConfigured: boolean
  /** ?validationToken= (URL-dekódovaný), nebo null. */
  validationToken: string | null
  /** Tělo požadavku (text), nebo null, když se nečetlo. */
  body: string | null
}

function addOnce<T>(list: T[], v: T): void {
  if (!list.includes(v)) list.push(v)
}

/**
 * Čistá funkce: co s požadavkem udělat. Nesahá na DB ani síť, takže se vejde
 * do 3 s, které Graph na odpověď dává (zbytek běží až po odpovědi).
 */
export function classifyNotificationRequest(input: NotificationRequestInput): NotificationDecision {
  if (!input.enabled) return { kind: 'disabled' }

  // Validace notificationUrl / lifecycleNotificationUrl při vytváření
  // předplatného: token vrátit jako text/plain do 10 s. Token neprůhledný,
  // ale délku omezujeme (jinak by šlo odrážet libovolně dlouhý text).
  if (input.validationToken !== null) {
    const t = input.validationToken
    if (t.length === 0 || t.length > VALIDATION_TOKEN_MAX_LENGTH) return { kind: 'bad_request', reason: 'validationToken' }
    return { kind: 'validation', token: t }
  }

  if (!input.secret) return { kind: 'misconfigured', reason: 'CRON_SECRET chybí' }
  if (!input.memberConfigured) return { kind: 'misconfigured', reason: 'OUTLOOK_MAIL_SYNC_MEMBER_ID chybí' }
  if (input.body === null) return { kind: 'bad_request', reason: 'prázdné tělo' }
  if (input.body.length > MAX_NOTIFICATION_BODY_BYTES) return { kind: 'too_large' }

  let json: unknown
  try {
    json = JSON.parse(input.body)
  } catch {
    return { kind: 'bad_request', reason: 'neplatný JSON' }
  }
  const parsed = parseNotificationCollection(json)
  if (!parsed) return { kind: 'bad_request', reason: 'není kolekce notifikací' }

  const expected = MAIL_WEBHOOK_FOLDERS.map((k) => ({ key: k, clientState: webhookClientState(input.secret!, k) }))
  const work: NotificationWork = { subscriptionIds: [], syncFolders: [], recreateFolders: [], renewFolders: [] }
  let accepted = 0
  let ignored = 0
  let invalid = parsed.malformed

  for (const n of parsed.notifications) {
    // Porovnat se VŠEMI očekávanými hodnotami (bez zkratky), ať čas
    // nezávisí na tom, která složka to je.
    const matches = expected.map((e) => (clientStateMatches(n.clientState, e.clientState) ? e.key : null))
    const folder = matches.find((m): m is FolderKey => m !== null) ?? null
    if (!folder) { invalid++; continue }
    accepted++
    addOnce(work.subscriptionIds, n.subscriptionId)
    switch (n.lifecycleEvent) {
      case null:
      case 'missed':
        addOnce(work.syncFolders, folder)
        break
      case 'subscriptionRemoved':
        addOnce(work.recreateFolders, folder)
        addOnce(work.syncFolders, folder)
        break
      case 'reauthorizationRequired':
        addOnce(work.renewFolders, folder)
        break
      default:
        // Neznámá lifecycle událost: ověřená, ale nevíme, co s ní — nic nedělat.
        ignored++
    }
  }

  if (accepted === 0) return { kind: 'unauthorized', invalid }
  return { kind: 'accepted', work, accepted, invalid, ignored }
}

/** Odpověď pro Graph. Tělo nikdy nenese nic o stavu Cockpitu. */
export function notificationResponse(decision: NotificationDecision): Response {
  switch (decision.kind) {
    case 'disabled':
      return new Response(null, { status: 404 })
    case 'validation':
      return new Response(decision.token, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    case 'bad_request':
      return new Response(null, { status: 400 })
    case 'too_large':
      return new Response(null, { status: 413 })
    case 'misconfigured':
      // 503 → Graph notifikaci zkusí znovu (až 4 h), než se konfigurace opraví.
      return new Response(null, { status: 503 })
    case 'unauthorized':
      return new Response(null, { status: 401 })
    case 'accepted':
      // 202: přijato a zařazeno; sync běží až po odpovědi (after()).
      return new Response(null, { status: 202 })
  }
}

// ---------------------------------------------------------------------------
// Stav pro „Stav zdrojů" (přehled + Nastavení)

export type MailWebhookHealth = {
  enabled: boolean
  /** Tabulka graph_subscription chybí (migrace 0066 neaplikovaná). */
  migrationMissing: boolean
  /** Nejnovější notifikace přes všechny složky. */
  lastNotificationAt: string | null
  /** Nejbližší expirace (ta vyprší první). */
  expiresAt: string | null
  /** Česky, po složkách; prázdné = v pořádku. */
  problems: string[]
  /** Zapnuto a (chybí migrace, nebo aspoň jeden problém). */
  broken: boolean
}

export function disabledMailWebhookHealth(): MailWebhookHealth {
  return { enabled: false, migrationMissing: false, lastNotificationAt: null, expiresAt: null, problems: [], broken: false }
}

const PROBLEM_TEXT_MAX = 160

function shortText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > PROBLEM_TEXT_MAX ? `${t.slice(0, PROBLEM_TEXT_MAX - 1)}…` : t
}

/**
 * Rozbitý webhook = chybí předplatné některé složky, vypršelo, nebo poslední
 * operace s ním skončila chybou. Ticho (žádná notifikace) samo o sobě rozbité
 * není — v noci ani o víkendu nemusí přijít nic; pojistkou je denní delta
 * sync s vlastní čerstvostí.
 */
export function assessMailWebhook(
  rows: SubscriptionRow[] | null,
  opts: { enabled: boolean; now: number },
): MailWebhookHealth {
  if (!opts.enabled) return disabledMailWebhookHealth()
  if (rows === null) {
    return { enabled: true, migrationMissing: true, lastNotificationAt: null, expiresAt: null, problems: [], broken: true }
  }
  const problems: string[] = []
  let lastNotificationAt: string | null = null
  let expiresAt: string | null = null
  for (const key of MAIL_WEBHOOK_FOLDERS) {
    const label = FOLDER_LABELS[key]
    const row = rows.find((r) => r.connector_key === webhookConnectorKey(key)) ?? null
    if (row?.last_notification_at && (!lastNotificationAt || Date.parse(row.last_notification_at) > Date.parse(lastNotificationAt))) {
      lastNotificationAt = row.last_notification_at
    }
    if (!row || !row.subscription_id || !row.expires_at) {
      problems.push(row?.last_error ? `${label}: předplatné chybí (${shortText(row.last_error)})` : `${label}: předplatné chybí`)
      continue
    }
    if (!expiresAt || Date.parse(row.expires_at) < Date.parse(expiresAt)) expiresAt = row.expires_at
    const exp = Date.parse(row.expires_at)
    if (!Number.isFinite(exp) || exp <= opts.now) {
      problems.push(`${label}: předplatné vypršelo`)
    } else if (row.last_error) {
      problems.push(`${label}: ${shortText(row.last_error)}`)
    }
  }
  return { enabled: true, migrationMissing: false, lastNotificationAt, expiresAt, problems, broken: problems.length > 0 }
}
