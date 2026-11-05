// Ověření odesílatele příchozí poptávky (SPF / DKIM / DMARC) z hlavičky
// Authentication-Results (RFC 8601), kterou přidává NÁŠ poštovní server.
//
// Proč: agent smí sám odpovědět (nabídka, doptání). Podvržený odesílatel by
// jinak mohl nechat poslat nabídku na cizí adresu nebo vydávat se za
// existujícího klienta. Pravidla:
//   - věříme jen hlavičce s authserv-id našeho serveru (trustedAuthServId);
//     hlavičku se stejným id, kterou přinesla zpráva zvenku, server podle
//     RFC 8601 odstraní, a bereme vždy tu nejvyšší (poslední přidanou);
//   - prošlo = dmarc=pass, nebo dkim=pass s doménou podpisu zarovnanou
//     s doménou adresy From (relaxed: stejná doména nebo poddoména);
//   - Reply-To, které se liší od From, = nesoulad → neodpovídá se;
//   - odpovídá se vždy jen na adresu From (nikdy Reply-To).
// Při selhání agent zprávu dál zapíše do CRM, ale neodpoví a eskaluje.
//
// Čisté funkce bez sítě; nic z hlaviček se neukládá ani neloguje.

export type AuthMethodResult = { method: 'spf' | 'dkim' | 'dmarc'; result: string; domain: string | null }

export type SenderAuthCode =
  | 'auth_results_missing'
  | 'dmarc_fail'
  | 'dkim_unaligned'
  | 'from_invalid'
  | 'from_multiple'
  | 'reply_to_mismatch'

export type SenderAuthVerdict = {
  /** Smí agent odesílateli sám odpovědět? */
  ok: boolean
  codes: SenderAuthCode[]
  /** Jediná adresa, na kterou se smí odpovědět (z From), malými písmeny. */
  replyAddress: string | null
}

const ADDRESS_RE = /[^\s<>"',;@]+@[^\s<>"',;@]+\.[^\s<>"',;@]{2,}/g

/** Všechny e-mailové adresy z hlavičky (From, Reply-To), malými písmeny. */
export function headerAddresses(value: string | null | undefined): string[] {
  if (!value) return []
  // Jméno v uvozovkách může obsahovat „@" (např. "a@b" <c@d>) — adresy v <> mají přednost.
  const angled = [...value.matchAll(/<([^<>]+)>/g)].map((m) => m[1])
  const source = angled.length > 0 ? angled.join(' ') : value.replace(/"[^"]*"/g, ' ')
  return [...new Set((source.match(ADDRESS_RE) ?? []).map((a) => a.toLowerCase()))]
}

export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf('@')
  return at > 0 ? address.slice(at + 1).toLowerCase() : null
}

/** Je doména podpisu zarovnaná s doménou From (stejná nebo nadřazená/poddoména)? */
export function domainsAligned(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase().replace(/\.$/, '')
  const y = b.toLowerCase().replace(/\.$/, '')
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

/**
 * Výsledky z jedné hlavičky Authentication-Results, nebo null, když ji
 * nepřidal důvěryhodný server. Neznámé části se ignorují.
 */
export function parseAuthenticationResults(header: string, trustedAuthServId: string): AuthMethodResult[] | null {
  const unfolded = header.replace(/\r?\n[ \t]+/g, ' ').replace(/\([^()]*\)/g, ' ')
  const parts = unfolded.split(';').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const servId = parts[0].split(/\s+/)[0]?.toLowerCase()
  if (servId !== trustedAuthServId.toLowerCase()) return null
  const out: AuthMethodResult[] = []
  for (const p of parts.slice(1)) {
    const m = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)\b(.*)$/i.exec(p)
    if (!m) continue
    const method = m[1].toLowerCase() as AuthMethodResult['method']
    const props = m[3]
    const prop = (name: string) => new RegExp(`\\b${name.replace('.', '\\.')}\\s*=\\s*"?([^\\s";]+)`, 'i').exec(props)?.[1] ?? null
    let domain: string | null = null
    if (method === 'dkim') {
      const d = prop('header.d') ?? prop('header.i')
      domain = d ? (d.includes('@') ? addressDomain(d) : d.toLowerCase()) : null
    } else if (method === 'dmarc') {
      domain = prop('header.from')?.toLowerCase() ?? null
    } else {
      const mf = prop('smtp.mailfrom')
      domain = mf ? (mf.includes('@') ? addressDomain(mf) : mf.toLowerCase()) : null
    }
    out.push({ method, result: m[2].toLowerCase(), domain })
  }
  return out
}

export type HeaderLike = { name: string; value: string }

const headerValues = (headers: readonly HeaderLike[], name: string) =>
  headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value)

/**
 * Verdikt nad hlavičkami zprávy (v pořadí, jak je vrátil poštovní server:
 * první = nejvyšší = poslední přidaná).
 */
export function evaluateSenderAuth(headers: readonly HeaderLike[], trustedAuthServId: string): SenderAuthVerdict {
  const codes: SenderAuthCode[] = []
  const fromValues = headerValues(headers, 'From')
  const from = fromValues.flatMap(headerAddresses)
  if (fromValues.length !== 1 || from.length > 1) codes.push('from_multiple')
  const replyAddress = from.length === 1 ? from[0] : null
  if (!replyAddress) codes.push('from_invalid')

  const replyTo = headerValues(headers, 'Reply-To').flatMap(headerAddresses)
  if (replyTo.length > 0 && (replyTo.length > 1 || replyTo[0] !== replyAddress)) codes.push('reply_to_mismatch')

  const trusted = headerValues(headers, 'Authentication-Results')
    .map((h) => parseAuthenticationResults(h, trustedAuthServId))
    .find((r): r is AuthMethodResult[] => r !== null)
  const fromDomain = replyAddress ? addressDomain(replyAddress) : null
  if (!trusted) {
    codes.push('auth_results_missing')
  } else {
    const dmarc = trusted.find((r) => r.method === 'dmarc')
    const dkimAligned = trusted.some((r) => r.method === 'dkim' && r.result === 'pass' && domainsAligned(r.domain, fromDomain))
    const dmarcPass = dmarc?.result === 'pass' && (dmarc.domain === null || domainsAligned(dmarc.domain, fromDomain))
    if (dmarc && dmarc.result !== 'pass' && dmarc.result !== 'none' && dmarc.result !== 'bestguesspass') codes.push('dmarc_fail')
    else if (!dmarcPass && !dkimAligned) codes.push('dkim_unaligned')
  }
  return { ok: codes.length === 0, codes: [...new Set(codes)], replyAddress }
}
