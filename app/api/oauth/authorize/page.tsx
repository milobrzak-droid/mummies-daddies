import { createAdminClient } from '@/lib/supabase/admin'
import { getCurrentMember, memberIsAdmin, memberSeesSales } from '@/lib/queries/currentMember'
import { approveOAuth } from '@/lib/actions/oauth'
import { isAllowedRedirectUri, isDefaultClaudeRedirect } from '@/lib/oauth'
import { SubmitButton } from '@/components/SubmitButton'
import { AuthShell, AUTH_CARD } from '@/components/ui/AuthCard'

// Autorizační obrazovka OAuth flow. Sem klienta (claude.ai / Cowork) pošle
// prohlížeč; middleware ho předtím donutí se přihlásit, takže tady už víme,
// kdo schvaluje. Potvrzením vzniká jednorázový kód se zvoleným rozsahem (jen čtení /
// čtení i zápis); API klíč se založí až při jeho výměně — viz lib/actions/oauth.ts a /api/oauth/token.
export const dynamic = 'force-dynamic'

type Params = Promise<{
  client_id?: string
  redirect_uri?: string
  code_challenge?: string
  code_challenge_method?: string
  response_type?: string
  state?: string
}>

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <AuthShell>
      <div className={`${AUTH_CARD} space-y-3`}>
        <div>
          <p className="eyebrow mb-1.5">Připojení aplikace</p>
          <h1 className="m-0 font-heading text-title1 font-bold">Připojení nelze dokončit</h1>
        </div>
        <p className="m-0 text-body text-muted">{children}</p>
      </div>
    </AuthShell>
  )
}

const SCOPE_OPTION = 'flex items-start gap-3 rounded-tile border border-border p-3.5'

export default async function AuthorizePage({ searchParams }: { searchParams: Params }) {
  const sp = await searchParams

  if (sp.response_type !== 'code') {
    return <Problem>Nepodporovaný typ požadavku. Zkus konektor přidat znovu.</Problem>
  }
  // Jen PKCE S256 — bez něj by šel kód zneužít, kdyby unikl z redirectu.
  if (!sp.code_challenge || sp.code_challenge_method !== 'S256') {
    return <Problem>Chybí bezpečnostní ověření (PKCE S256). Zkus konektor přidat znovu.</Problem>
  }
  if (!sp.client_id || !sp.redirect_uri) {
    return <Problem>Neúplný požadavek — chybí identifikace aplikace.</Problem>
  }

  const admin = createAdminClient()
  const { data: client } = await admin
    .from('oauth_client')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', sp.client_id)
    .maybeSingle()

  if (!client) return <Problem>Neznámá aplikace. Zkus konektor přidat znovu.</Problem>
  if (!client.redirect_uris.includes(sp.redirect_uri)) {
    return <Problem>Adresa pro návrat nesouhlasí s registrací aplikace.</Problem>
  }
  // Klient mohl být zaregistrován dřív, než platil seznam povolených hostů.
  if (!isAllowedRedirectUri(sp.redirect_uri)) {
    return <Problem>Adresa pro návrat není na seznamu povolených hostů konektorů. Přístup nelze udělit.</Problem>
  }

  const { user, member } = await getCurrentMember()
  if (!user || !memberIsAdmin(member)) {
    return <Problem>Připojit aplikaci k Cockpitu může jen admin.</Problem>
  }
  // Zápis se nabízí a předvybírá jen schvalovateli s obchodní rolí (vedení,
  // obchodník) — zápisové nástroje (aktivity, další kroky) stejně vyžadují
  // obchodní roli. Server to při schválení i při vydání tokenu ověří znovu.
  const canWrite = memberSeesSales(member)
  // Zápis se předvybírá jen pro host z výchozího seznamu Claude; pro cokoli
  // jiného (host z OAUTH_REDIRECT_HOSTS, loopback) je předvybráno jen čtení.
  const trustedHost = isDefaultClaudeRedirect(sp.redirect_uri)
  const preselectWrite = canWrite && trustedHost

  // Host redirect_uri je jediný údaj o klientovi, kterému jde věřit —
  // client_name si registrující volí sám. Proto ho ukazujeme nahoře.
  let redirectHost: string
  try {
    redirectHost = new URL(sp.redirect_uri).host
  } catch {
    return <Problem>Adresa pro návrat je neplatná.</Problem>
  }

  return (
    <AuthShell wide>
      <div className={`${AUTH_CARD} space-y-4`}>
        <div>
          <p className="eyebrow mb-1.5">Připojení aplikace</p>
          <h1 className="m-0 font-heading text-title1 font-bold">Připojit k Cockpitu</h1>
        </div>
        <div className="rounded-tile bg-[color:var(--c-soft)] p-4">
          <p className="eyebrow m-0">Aplikace</p>
          <p className="m-0 mt-1 break-all text-title2 font-bold text-ink">{client.client_name ?? 'bez názvu'}</p>
          <p className="eyebrow m-0 mt-3">Přístup se vydá aplikaci, která se vrací na adresu</p>
          <p className="m-0 mt-1 break-all font-mono text-headline text-ink">{redirectHost}</p>
          <p className="m-0 break-all text-footnote text-muted">{sp.redirect_uri}</p>
          <p className="m-0 mt-3">
            <span className={trustedHost ? 'st done' : 'st'}>{trustedHost ? 'Adresa konektoru Claude' : 'Jiná adresa než Claude'}</span>
          </p>
        </div>
        <p className="m-0 text-callout text-muted">
          Název si aplikace zvolila sama a není ověřený; jediný spolehlivý údaj je adresa výše.
          Povol přístup, jen pokud adresu poznáváš a připojení jsi právě spustil ty.
        </p>
        {!trustedHost && (
          <p role="alert" className="m-0 rounded-tile bg-[color:var(--c-warn-soft)] p-3.5 text-callout text-ink">
            <b>Pozor:</b> tohle není adresa konektoru Claude (claude.ai / claude.com). Pokud nevíš přesně, co
            to je, přístup nepovoluj. Zápis je proto vypnutý předvolbou, zvol ho jen výslovně.
          </p>
        )}
        <p className="m-0 text-callout text-muted">
          Po schválení získá aplikace token, který platí 90 dní a sám se obnovuje, dokud ho nezrušíš v sekci{' '}
          <b className="text-ink">API klíče</b>. Vše, co token smí, je vypsáno u zvoleného rozsahu níže.
        </p>
        <form action={approveOAuth} className="space-y-4">
          <input type="hidden" name="client_id" value={sp.client_id} />
          <input type="hidden" name="redirect_uri" value={sp.redirect_uri} />
          <input type="hidden" name="code_challenge" value={sp.code_challenge} />
          <input type="hidden" name="state" value={sp.state ?? ''} />
          <fieldset className="m-0 space-y-2 border-0 p-0">
            <legend className="eyebrow mb-2 p-0">Vyber, co aplikace smí</legend>
            <label className={`${SCOPE_OPTION}${canWrite ? '' : ' opacity-60'}`}>
              <input type="radio" name="scope" value="full" defaultChecked={preselectWrite} disabled={!canWrite} className="mt-1" />
              <div className="text-callout text-muted">
                <b className="text-headline text-ink">Čtení i zápis</b>
                <ul className="mt-1 list-disc pl-5">
                  <li>
                    <b className="text-ink">zakládat</b> nové aktivity (zápisy z jednání), úkoly a další kroky u
                    projektů — vždy s tvým jménem jako autorem a se stopou v auditu,
                  </li>
                  <li>
                    <b className="text-ink">číst</b> souhrny obchodů a dodávek (kolik projektů máme venku,
                    částky a marže) a kontakty a klienty z interního CRM,
                  </li>
                  <li>
                    <b className="text-ink">nikdy nesmí</b> nic mazat ani měnit role, uživatele a API klíče.
                  </li>
                </ul>
                {!canWrite && (
                  <p className="m-0 mt-1">Nedostupné: tvá role nepatří mezi obchodní (vedení, obchodník).</p>
                )}
              </div>
            </label>
            <label className={SCOPE_OPTION}>
              <input type="radio" name="scope" value="read" defaultChecked={!preselectWrite} className="mt-1" />
              <div className="text-callout text-muted">
                <b className="text-headline text-ink">Jen čtení</b>
                <ul className="mt-1 list-disc pl-5">
                  <li>
                    <b className="text-ink">číst</b> klienty, partnery, projekty (včetně částek a marží) a souhrnná
                    čísla dashboardu (obchody a částky jen s obchodní rolí),
                  </li>
                  <li>
                    <b className="text-ink">nic nezapisuje</b> a nic nemaže — zápisové nástroje ji server odmítne.
                  </li>
                </ul>
              </div>
            </label>
          </fieldset>
          <p className="m-0 text-callout text-muted">
            Přístup jde kdykoli zrušit v sekci <b className="text-ink">API klíče</b>. Aplikace se po schválení
            umí sama obnovovat, dokud přístup nezrušíš.
          </p>
          <SubmitButton>Povolit přístup</SubmitButton>
        </form>
      </div>
    </AuthShell>
  )
}
