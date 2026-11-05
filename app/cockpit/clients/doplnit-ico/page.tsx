import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { Card, CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pager } from '@/components/Pager'
import { IcoPicker } from '@/components/IcoPicker'
import { WorkCaseNotice } from '@/components/WorkCaseNotice'
import { AresEnrichButton } from '@/components/AresEnrichButton'
import { isCurrentUserAdmin } from '@/lib/queries/team'
import { mapWithConcurrency } from '@/lib/concurrency'
import { aresSearch, cleanCompanyName, type AresCompany } from '@/connectors/ares'
import { ARES_MIGRATION_MISSING_MESSAGE, type AresStatus } from '@/domain/crm/aresEnrich'
import { listMissingIcoPage, MISSING_ICO_PAGE_SIZE, parsePageParam } from '@/domain/crm/queries/missingIco'
import { runAresEnrichBatch } from './actions'

export const dynamic = 'force-dynamic'
// Ruční dávka (runAresEnrichBatch) má časový rozpočet 50 s; server akce
// dědí maxDuration stránky, na které běží.
export const maxDuration = 60

// Proč ta stránka vůbec existuje: automatický lookup (pickAresMatch
// v connectors/ares, dávka v domain/crm/aresEnrich.ts) záměrně přiřadí jen
// přesnou shodu jména — zkratka ("CCH" → vzduchotechnika, ne Coca-Cola)
// nebo běžné jméno s desítkami shod ("Magna" → 56 firem, první je vinařský
// spolek) se nesmí přiřadit samo. Špatné IČO v CRM je horší než prázdné
// pole — spletli jsme se takhle už třikrát. Co automat nerozhodne, nabídne
// tahle stránka jako kandidáty a rozhodne člověk jedním klikem.
//
// Po importu prospektů jde o stovky firem. Stránka proto ukazuje 20 na
// stránku (?strana=N, stabilně podle jména) a ptá se ARESu jen na ně, nejvýš
// 4 dotazy současně. Firmy, které ARES pod jménem nezná (ověřil automat),
// jsou skryté — ?vse=1 je ukáže taky.

const LOOKUP_CONCURRENCY = 4
const LOOKUP_TIMEOUT_MS = 6_000

type Lookup = { candidates: AresCompany[]; failed: boolean; tooMany?: boolean }

// Stavová pilulka (.st): žlutá tečka = čeká na rozhodnutí člověka, modrá = jen informace.
const STATUS_LABEL: Record<AresStatus, { text: string; cls: string }> = {
  nejednoznacne: { text: 'Automat si nebyl jistý', cls: 'st' },
  nenalezeno: { text: 'ARES jméno nezná', cls: 'st info' },
  prirazeno: { text: 'IČO od automatu bylo smazáno', cls: 'st info' },
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function pageHref(page: number, showAll: boolean): string {
  const params = new URLSearchParams()
  if (page > 1) params.set('strana', String(page))
  if (showAll) params.set('vse', '1')
  const qs = params.toString()
  return qs ? `/cockpit/clients/doplnit-ico?${qs}` : '/cockpit/clients/doplnit-ico'
}

// Česká shoda čísla: 1 klient nemá / 2–4 klienti nemají / 5+ klientů nemá.
function missingPhrase(n: number): string {
  return n === 1 ? 'klient nemá' : n >= 2 && n <= 4 ? 'klienti nemají' : 'klientů nemá'
}

function hiddenPhrase(n: number): string {
  if (n === 1) return '1 firma, kterou ARES pod jménem nezná, je skrytá'
  if (n >= 2 && n <= 4) return `${n} firmy, které ARES pod jménem nezná, jsou skryté`
  return `${n} firem, které ARES pod jménem nezná, je skryto`
}

export default async function DoplnitIcoPage({
  searchParams,
}: {
  searchParams: Promise<{ strana?: string | string[]; vse?: string | string[] }>
}) {
  const sp = await searchParams
  const showAll = first(sp.vse) === '1'
  const [data, isAdmin] = await Promise.all([
    listMissingIcoPage({ page: parsePageParam(sp.strana), includeNotFound: showAll }),
    isCurrentUserAdmin(),
  ])

  // Jen firmy z aktuální stránky, nejvýš 4 dotazy najednou. Výpadek ARESu
  // u jedné firmy nesmí shodit stránku — ukáže se u ní jako „neodpověděl".
  const lookups = await mapWithConcurrency(data.rows, LOOKUP_CONCURRENCY, async (a): Promise<Lookup> => {
    const q = cleanCompanyName(a.name)
    if (!q) return { candidates: [], failed: false }
    try {
      const r = await aresSearch(q, { count: 5, timeoutMs: LOOKUP_TIMEOUT_MS })
      return { candidates: r.candidates, failed: false, tooMany: r.tooMany === true }
    } catch {
      return { candidates: [], failed: true }
    }
  })

  const hidden = showAll || data.migrationPending ? 0 : data.notFound
  const firstShown = data.shown === 0 ? 0 : (data.page - 1) * MISSING_ICO_PAGE_SIZE + 1
  const lastShown = Math.min(data.page * MISSING_ICO_PAGE_SIZE, data.shown)

  return (
    <>
      <PageHeader
        title="Doplnit IČO"
        eyebrow="Klienti"
        subtitle={
          data.totalMissing > 0
            ? `${data.totalMissing} ${missingPhrase(data.totalMissing)} vyplněné IČO. Automat přiřadí jen jednoznačnou shodu — u ostatních vyber ze skutečných kandidátů z ARESu, nebo zadej číslo ručně.`
            : 'Všichni klienti mají vyplněné IČO.'
        }
        back={{ href: '/cockpit/clients', label: 'Klienti' }}
      />
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />

      {data.migrationPending && (
        <div className="mb-6">
          <WorkCaseNotice>
            <p className="font-medium text-ink m-0">{ARES_MIGRATION_MISSING_MESSAGE}</p>
            <p className="mt-1 mb-0">
              Seznam i ruční výběr fungují, jen se zatím nepamatuje, které firmy už automat prověřil.
            </p>
          </WorkCaseNotice>
        </div>
      )}

      {isAdmin && !data.migrationPending && data.totalMissing > 0 && (
        <Card
          id="ares-auto"
          title="Automatické doplnění"
          sub="Automat projde firmy bez IČO a přiřadí jen jednoznačnou shodu z ARESu."
          className="mb-6 max-w-3xl"
        >
          <AresEnrichButton action={runAresEnrichBatch} />
        </Card>
      )}

      {data.totalMissing === 0 && (
        <div className={CARD}>
          <EmptyState tone="calm" title="Hotovo, nic k doplnění." action={{ href: '/cockpit/clients', label: 'Zpět na klienty' }}>
            Až přibude firma bez IČO, objeví se tady s kandidáty z ARESu.
          </EmptyState>
        </div>
      )}

      {data.totalMissing > 0 && (
        <p className="text-callout text-muted mb-4 max-w-3xl">
          {data.shown > 0
            ? `Zobrazeno ${firstShown}–${lastShown} z ${data.shown} · strana ${data.page} z ${data.totalPages}.`
            : 'Na seznamu teď nikdo není.'}
          {hidden > 0 && (
            <>
              {' '}
              {hiddenPhrase(hidden)}
              {' — '}
              <Link href={pageHref(1, true)} className="underline hover:text-ink font-semibold">zobrazit i je</Link>.
            </>
          )}
          {showAll && data.notFound > 0 && (
            <>
              {' '}
              <Link href={pageHref(1, false)} className="underline hover:text-ink">Skrýt firmy, které ARES nezná</Link>.
            </>
          )}
        </p>
      )}

      {data.rows.length > 0 && (
        <div className="flex flex-col gap-4">
          {data.rows.map((a, i) => {
            const status = a.ares_status ? STATUS_LABEL[a.ares_status] : null
            return (
              <section key={a.id} className={`${CARD} p-5 sm:p-6`}>
                <div className="flex items-center gap-x-3 gap-y-2 flex-wrap mb-3">
                  <h2 className="m-0 font-heading text-title2 font-bold">
                    <Link href={`/cockpit/clients/${a.id}`}>{a.name}</Link>
                  </h2>
                  {status && <span className={status.cls}>{status.text}</span>}
                </div>
                <IcoPicker accountId={a.id} candidates={lookups[i].candidates} lookupFailed={lookups[i].failed} tooMany={lookups[i].tooMany} />
              </section>
            )
          })}
        </div>
      )}

      <Pager page={data.page} pageCount={data.totalPages} hrefFor={(page) => pageHref(page, showAll)} label="Stránkování firem bez IČO" />
    </>
  )
}
