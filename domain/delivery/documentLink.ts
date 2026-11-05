// Přísné parsování odkazu na dokument, který člen vloží do dokumentů
// dodávky (plan kap. 8). Čistá logika bez sítě a DB.
//
// Dvě různé otázky, dvě různé odpovědi:
//   1. Co smí člen VLOŽIT a co smí Cockpit poslat do Microsoft Graphu
//      k načtení metadat: https odkazy na *.sharepoint.com (vč. OneDrive
//      for Business *-my.sharepoint.com), soubor v Teams
//      (teams.microsoft.com/l/file/…), 1drv.ms a onedrive.live.com.
//   2. Co smí Cockpit ULOŽIT: jen firemní SharePoint (SHAREPOINT_URL_RE,
//      shodný s DB constraintem engagement_document_url_host_check z 0053).
//      Odkaz, který nejde uložit tak, jak je, projde jen tehdy, když ho
//      Graph přeloží na webUrl ve firemním SharePointu.
//
// Parsování je záměrně přísnější než WHATWG URL: odmítá userinfo
// (`https://mummiesdaddies.sharepoint.com@evil.example/`), zpětná lomítka, bílé
// a řídicí znaky, explicitní port, procenta v hostu a JAKOUKOLI normalizaci
// hostu (IDN/punycode, full-width tečky, velká písmena se jen snižují) —
// host v parsované URL musí být znak po znaku host z vloženého textu.
import { DOCUMENT_URL_MAX, SHAREPOINT_URL_RE } from '@/domain/delivery/documents'

export type DocumentLinkSource = 'sharepoint' | 'teams_file' | 'onedrive_personal'

export type ParsedDocumentLink =
  | {
      ok: true
      source: DocumentLinkSource
      /** Normalizovaná podoba vloženého odkazu. */
      url: string
      /** Co poslat do Graphu (/shares/{u!…}/driveItem): u Teams vnitřní objectUrl. */
      resolveUrl: string
      /** Co jde uložit i bez Graphu (firemní SharePoint), jinak null. */
      storableUrl: string | null
    }
  | { ok: false; error: string }

// Jeden DNS label (bez punycode „xn--") + .sharepoint.com. Pokrývá i
// OneDrive for Business (<tenant>-my.sharepoint.com).
const SHAREPOINT_HOST_RE = /^(?!xn--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sharepoint\.com$/
const TEAMS_HOST = 'teams.microsoft.com'
const ONEDRIVE_PERSONAL_HOSTS = new Set(['1drv.ms', 'onedrive.live.com'])
// Odkaz na soubor z Teams („Kopírovat odkaz" u souboru). Chat a kanály nejsou
// trvalý doklad — soubor sdílený v Teams leží v SharePointu (objectUrl).
const TEAMS_FILE_PATH = '/l/file/'

export const DOCUMENT_LINK_ERROR = 'Odkaz musí vést na SharePoint, OneDrive nebo na soubor v Teams (https://…).'
export const TEAMS_LINK_ERROR = 'Z Teams jde vložit jen odkaz na soubor (u souboru „Kopírovat odkaz"), ne na chat nebo kanál.'

/** WHATWG URL + přísné kontroly navíc; null = odmítnuto. */
export function parseStrictHttpsUrl(raw: string): URL | null {
  if (raw.length === 0 || raw.length > DOCUMENT_URL_MAX) return null
  // Bílé a řídicí znaky i zpětná lomítka (WHATWG je u https bere jako „/").
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return null
  if (!/^https:\/\//i.test(raw)) return null
  const authority = raw.slice('https://'.length).split(/[/?#]/, 1)[0]
  // Userinfo, port ani procenta v autoritě nepřipouštíme.
  if (authority.length === 0 || /[@:%]/.test(authority)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null
  // Host musí zůstat, jak byl napsaný (jen malá písmena) — žádné IDN/unicode
  // triky, které by parser přemapoval na jiný host.
  if (u.hostname !== authority.toLowerCase()) return null
  return u
}

function isSharePointHost(host: string): boolean {
  return SHAREPOINT_HOST_RE.test(host)
}

/** Smí se tahle URL uložit (firemní SharePoint, přísně rozparsovaná)? */
export function storableSharePointUrl(raw: string): string | null {
  const u = parseStrictHttpsUrl(raw)
  if (!u || !isSharePointHost(u.hostname)) return null
  return SHAREPOINT_URL_RE.test(u.href) ? u.href : null
}

export function parseDocumentLink(input: string): ParsedDocumentLink {
  const raw = input.trim()
  const u = parseStrictHttpsUrl(raw)
  if (!u) return { ok: false, error: DOCUMENT_LINK_ERROR }
  const host = u.hostname

  if (isSharePointHost(host)) {
    return { ok: true, source: 'sharepoint', url: u.href, resolveUrl: u.href, storableUrl: storableSharePointUrl(u.href) }
  }

  if (host === TEAMS_HOST) {
    if (!u.pathname.startsWith(TEAMS_FILE_PATH)) return { ok: false, error: TEAMS_LINK_ERROR }
    const objectUrl = u.searchParams.get('objectUrl')
    // objectUrl musí sám projít stejně přísnou kontrolou a vést do SharePointu
    // (žádné vnořené Teams / OneDrive / cizí hosty).
    const inner = objectUrl ? parseStrictHttpsUrl(objectUrl) : null
    if (!inner || !isSharePointHost(inner.hostname)) return { ok: false, error: TEAMS_LINK_ERROR }
    if (u.href.length > DOCUMENT_URL_MAX) return { ok: false, error: DOCUMENT_LINK_ERROR }
    return { ok: true, source: 'teams_file', url: u.href, resolveUrl: inner.href, storableUrl: storableSharePointUrl(inner.href) }
  }

  if (ONEDRIVE_PERSONAL_HOSTS.has(host)) {
    return { ok: true, source: 'onedrive_personal', url: u.href, resolveUrl: u.href, storableUrl: null }
  }

  return { ok: false, error: DOCUMENT_LINK_ERROR }
}
