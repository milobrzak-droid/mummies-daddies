// Dokumenty dodávky — čistá doménová logika bez DB.
//
// Rozhodnutí vlastníka 2026-09-28: firemní dokumenty žijí v SharePointu/
// Teams, Cockpit ukládá jen odkaz + metadata, NIKDY obsah (plan kap. 8:
// „metadata a vazba na milník, ne obsah"). Proto dokument = title + url + kind
// (+ nepovinná vazba na milník) a URL smí mířit JEN na firemní SharePoint
// mummiesdaddies.sharepoint.com nebo OneDrive for Business mummiesdaddies-my.sharepoint.com
// (zúženo v 0053 — dřív jakýkoli *.sharepoint.com, tj. i cizí tenant) —
// odkazy na teams.microsoft.com (chat/kanály) záměrně nepovolujeme, protože
// nejsou trvalý doklad a v Teams se dá odkaz smazat/přesunout mimo kontrolu
// projektu; sdílený obsah Teamsu se ukládá do SharePointu, kam pak vede
// tenhle odkaz. (Kap. 8: formulář přijme i odkaz na SOUBOR v Teams, 1drv.ms
// nebo sdílecí odkaz — domain/delivery/documentLink.ts ho ale před uložením
// převede na SharePoint URL, přes objectUrl nebo webUrl z Graphu; do DB jde
// dál jen firemní SharePoint.) DB constraint (engagement_document_url_host_check
// v 0053_security_hardening.sql) validuje stejně — regex tady i tam musí
// zůstat shodný (hlídá test/security-0053.test.ts). Délku ≤ 2000 hlídá
// zod i DB (engagement_document_url_length_check).
import { z } from 'zod'
import { COMPANY } from '@/config'

// Revize kap. 2E (migrace 0094): kromě odkazu a metadat nese dokument dodávky
// identitu položky v SharePointu (drive + item), aktuální verzi, typ dokumentu
// a stav koncept → schváleno → odesláno → přijato. Vše jen metadata; obsah
// souboru Cockpit nikdy nečte ani neindexuje.
export const DOCUMENT_KINDS = ['podklad', 'vystup', 'smlouva', 'jine'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  podklad: 'Podklad',
  vystup: 'Výstup',
  smlouva: 'Smlouva',
  jine: 'Jiné',
}

// Typ dokumentu (doc_type v 0094) — o čem dokument je; `kind` výš je jeho role
// v dodávce (podklad od klienta, výstup pro klienta, smlouva).
export const DOCUMENT_TYPES = ['nabidka', 'procesni_mapa', 'zapis', 'predavaci_balicek', 'jine'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  nabidka: 'Nabídka',
  procesni_mapa: 'Procesní mapa',
  zapis: 'Zápis',
  predavaci_balicek: 'Předávací balíček',
  jine: 'Jiné',
}

export function isDocumentType(v: unknown): v is DocumentType {
  return typeof v === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(v)
}

// Stav dokumentu (status v 0094). Pořadí přechodů drží i DB trigger
// engagement_document_workflow_guard; „přijato" jde jen přes milník s dokladem
// akceptace („Odesláno ≠ přijato", stejně jako u milníku v 0042).
export const DOCUMENT_STATUSES = ['draft', 'approved', 'sent', 'accepted'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  draft: 'Koncept',
  approved: 'Schváleno',
  sent: 'Odesláno',
  accepted: 'Přijato klientem',
}

export function isDocumentStatus(v: unknown): v is DocumentStatus {
  return typeof v === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(v)
}

const DOCUMENT_TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  draft: ['approved'],
  approved: ['draft', 'sent'],
  sent: ['draft', 'accepted'],
  accepted: [],
}

/** Stavy, do kterých smí člověk dokument přepnout ručně (bez „přijato" — to dělá akceptace milníku). */
export function nextDocumentStatuses(from: DocumentStatus): DocumentStatus[] {
  return DOCUMENT_TRANSITIONS[from].filter((s) => s !== 'accepted')
}

export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return DOCUMENT_TRANSITIONS[from].includes(to)
}

/** Sledujeme jen dokumenty, které už někdo schválil: schválené, odeslané, přijaté. */
export function isWatchedStatus(status: DocumentStatus): boolean {
  return status !== 'draft'
}

// Musí odpovídat engagement_document_url_host_check v 0053_security_hardening.sql.
// Povolené tenanty jsou konfigurace firmy (COMPANY.sharepointHosts, kapitola 11);
// výsledný regex je znak po znaku stejný jako dřív natvrdo psaný
// /^https:\/\/(mummiesdaddies|mummiesdaddies-my)\.sharepoint\.com\// (hosty spojené „|").
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SHAREPOINT_HOSTS: readonly string[] = COMPANY.sharepointHosts
export const SHAREPOINT_URL_RE = new RegExp(
  `^https://(${SHAREPOINT_HOSTS.map(escapeRe).join('|')})\\.sharepoint\\.com/`,
)
export const SHAREPOINT_EXAMPLES = SHAREPOINT_HOSTS.map((h) => `https://${h}.sharepoint.com/…`).join(' nebo ')
export const DOCUMENT_URL_MAX = 2000

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const optionalId = z.preprocess((v) => (v === '' || v == null ? null : v), id.nullable())

export const engagementDocumentSchema = z.object({
  engagement_id: id,
  milestone_id: optionalId,
  title: z.string().trim().min(1, 'Vyplň název dokumentu.').max(200, 'Nejvýš 200 znaků.'),
  url: z
    .string()
    .trim()
    .min(1, 'Vyplň odkaz na dokument.')
    .max(DOCUMENT_URL_MAX, 'Odkaz je moc dlouhý.')
    .regex(SHAREPOINT_URL_RE, `Odkaz musí vést na firemní SharePoint (${SHAREPOINT_EXAMPLES}).`),
  kind: z.enum(DOCUMENT_KINDS, { message: 'Vyber typ dokumentu.' }),
  doc_type: z.enum(DOCUMENT_TYPES, { message: 'Vyber typ dokumentu.' }).default('jine'),
})

export const documentEntityId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

// Vstup formuláře „Přidat dokument" (plan kap. 8). Oproti
// engagementDocumentSchema: název je nepovinný (doplní se z metadat
// SharePointu, pokud je načíst jde) a odkaz se tu jen ořízne a omezí
// délkou — přísné parsování a povolené hosty řeší parseDocumentLink
// (./documentLink.ts). Výsledný řádek se před zápisem ještě jednou ověří
// engagementDocumentSchema (shodné s DB constrainty).
export const documentLinkInputSchema = z.object({
  milestone_id: optionalId,
  title: z.preprocess((v) => (v == null ? '' : v), z.string().trim().max(200, 'Nejvýš 200 znaků.')),
  url: z.string().trim().min(1, 'Vyplň odkaz na dokument.').max(DOCUMENT_URL_MAX, 'Odkaz je moc dlouhý.'),
  kind: z.enum(DOCUMENT_KINDS, { message: 'Vyber typ dokumentu.' }),
  // Formulář bez typu (starší volání) = „Jiné".
  doc_type: z.preprocess((v) => (v === '' || v == null ? 'jine' : v), z.enum(DOCUMENT_TYPES, { message: 'Vyber typ dokumentu.' })),
})
