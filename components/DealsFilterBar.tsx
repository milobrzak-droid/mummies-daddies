import Link from 'next/link'
import { buttonClass } from '@/components/ui/Button'
import { DEAL_KINDS } from '@/lib/domain'

// Filtry tabule obchodů (plán vlny 2): jeden řádek – segmenty stavu jako
// odkazy (zachovají hledání, obchodníka i typ) a vedle nich hledání s
// obchodníkem a typem. Formulář je obyčejný GET, funguje i bez JavaScriptu.

export const DEAL_STATE_SEGMENTS = [
  { key: 'open', label: 'Otevřené' },
  { key: 'vyhráno', label: 'Vyhrané' },
  { key: 'prohráno', label: 'Prohrané' },
  { key: 'odloženo', label: 'Odložené' },
  { key: 'all', label: 'Vše' },
] as const

export type DealsFilterValues = { q: string; owner: string; state: string; kind: string }

/** Adresa tabule se zvolenými filtry; výchozí hodnoty do adresy nepíše. */
export function dealsFilterHref(values: DealsFilterValues): string {
  const params = new URLSearchParams()
  if (values.q) params.set('q', values.q)
  if (values.owner && values.owner !== 'all') params.set('owner', values.owner)
  if (values.state && values.state !== 'open') params.set('state', values.state)
  if (values.kind && values.kind !== 'all') params.set('kind', values.kind)
  const qs = params.toString()
  return qs ? `/cockpit/pipeline?${qs}` : '/cockpit/pipeline'
}

export function DealsFilterBar({ values, owners }: {
  values: DealsFilterValues
  owners: { id: string; full_name: string }[]
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
      <nav aria-label="Stav obchodů" className="seg">
        {DEAL_STATE_SEGMENTS.map((s) => (
          <Link
            key={s.key}
            href={dealsFilterHref({ ...values, state: s.key })}
            className="seg-item"
            aria-current={values.state === s.key ? 'page' : undefined}
            scroll={false}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <form role="search" aria-label="Hledat v obchodech" className="flex min-w-0 grow flex-wrap items-center gap-2">
        {values.state !== 'open' && <input type="hidden" name="state" value={values.state} />}
        <input
          type="search"
          name="q"
          defaultValue={values.q}
          placeholder="Klient, obchod, kontakt…"
          aria-label="Hledat klienta, obchod nebo kontakt"
          className="!w-auto min-w-0 grow basis-48 !rounded-full"
        />
        <select name="owner" defaultValue={values.owner} aria-label="Obchodník" className="!w-auto !rounded-full">
          <option value="all">Všichni obchodníci</option>
          {owners.map((member) => <option key={member.id} value={member.id}>{member.full_name}</option>)}
        </select>
        <select name="kind" defaultValue={values.kind} aria-label="Typ obchodu" className="!w-auto !rounded-full">
          <option value="all">Všechny typy</option>
          {DEAL_KINDS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          <option value="none">Nedoplněný typ</option>
        </select>
        <button type="submit" className={buttonClass('secondary')}>Filtrovat</button>
      </form>
    </div>
  )
}
