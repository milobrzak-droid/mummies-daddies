/**
 * Token Cloudflare Turnstile pro formuláře webu, BEZ změny vzhledu stránky.
 *
 * Widget se vykreslí mimo formulář (pevný kontejner u okraje stránky) v režimu
 * `appearance: 'interaction-only'`: návštěvník ho uvidí, jen když Cloudflare
 * opravdu potřebuje interakci. Token se získá těsně před odesláním
 * (lib/web/api.ts) a server ho ověří (lib/turnstile.ts).
 *
 * Bez NEXT_PUBLIC_TURNSTILE_SITE_KEY (vývoj, testy) vrací null — server pak
 * požadavek odmítne (pro vývoj slouží testovací klíče Cloudflare, lib/turnstile.ts).
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const TIMEOUT_MS = 20_000

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  execute: (idOrEl: string | HTMLElement) => void
  remove: (id: string) => void
}

let scriptLoad: Promise<TurnstileApi | null> | null = null

function api(): TurnstileApi | null {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null
}

function loadScript(): Promise<TurnstileApi | null> {
  if (api()) return Promise.resolve(api())
  scriptLoad ??= new Promise((resolve) => {
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.onload = () => resolve(api())
    s.onerror = () => {
      scriptLoad = null
      resolve(null)
    }
    document.head.appendChild(s)
  })
  return scriptLoad
}

export async function getTurnstileToken(siteKey: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY): Promise<string | null> {
  if (!siteKey || typeof window === 'undefined') return null
  const ts = await loadScript()
  if (!ts) return null
  const host = document.createElement('div')
  host.setAttribute('data-md-turnstile', '')
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:60'
  document.body.appendChild(host)
  return new Promise<string | null>((resolve) => {
    let id: string | null = null
    const done = (token: string | null) => {
      clearTimeout(timer)
      if (id) try { ts.remove(id) } catch { /* widget už není */ }
      host.remove()
      resolve(token)
    }
    const timer = setTimeout(() => done(null), TIMEOUT_MS)
    try {
      id = ts.render(host, {
        sitekey: siteKey,
        execution: 'execute',
        appearance: 'interaction-only',
        language: 'cs',
        callback: (token: string) => done(token),
        'error-callback': () => done(null),
        'timeout-callback': () => done(null),
      })
      ts.execute(id)
    } catch {
      done(null)
    }
  })
}
