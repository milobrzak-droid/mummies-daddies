import { formatCzk, formatDate } from '@/lib/format'
import type { ScopeVersionRow } from '@/domain/crm/scopeVersion'

function formatMoney(v: number | string, currency: 'CZK' | 'EUR'): string {
  if (currency === 'CZK') return formatCzk(v)
  return `${Number(v).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} EUR`
}

// Rozsah nabídky je volný text — po řádcích z něj děláme položky. Nic se
// nevymýšlí: „nové" je řádek, který v předchozí verzi není.
export function scopeLines(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/\r?\n/).map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean)
}

export function DealsOfferCard({ latest, previous }: { latest: ScopeVersionRow | null; previous: ScopeVersionRow | null }) {
  if (!latest) {
    return (
      <section className="card-deep flex flex-col gap-2.5 p-5">
        <h2 className="m-0 font-heading text-title2 font-bold" style={{ color: '#fff' }}>Co je v nabídce</h2>
        <p className="m-0 text-sm text-white/85">Zatím žádná verze nabídky. Po založení první verze se tu ukáže, co je v ní slíbeno.</p>
      </section>
    )
  }
  const lines = scopeLines(latest.scope).slice(0, 12)
  const prevSet = new Set(scopeLines(previous?.scope).map((l) => l.toLowerCase()))
  const sameCurrency = previous && previous.currency === latest.currency
  const prevAmount = previous ? Number(previous.amount_one_time) : 0
  const delta = sameCurrency && prevAmount > 0
    ? Math.round(((Number(latest.amount_one_time) - prevAmount) / prevAmount) * 1000) / 10
    : null
  return (
    <section className="card-deep flex flex-col gap-2.5 p-5" aria-label={`Co je v nabídce, verze ${latest.version}`}>
      <div className="mb-0.5 flex items-center gap-2">
        <h2 className="m-0 grow font-heading text-title2 font-bold" style={{ color: '#fff' }}>Co je v nabídce</h2>
        <span className="rounded-full bg-white/15 px-2.5 py-1 text-xs font-bold">Verze v{latest.version}</span>
      </div>
      {lines.length === 0 && <p className="m-0 text-sm text-white/85">Rozsah verze je prázdný.</p>}
      {lines.map((l, i) => {
        const isNew = previous != null && !prevSet.has(l.toLowerCase())
        return (
          <div key={`${i}-${l}`} className={`in-pill !rounded-[22px] !items-center ${isNew ? 'g' : 'w'}`}>
            <span className="min-w-0">{l}</span>
            {previous && <small className="shrink-0 text-xs font-semibold opacity-85">{isNew ? 'nové' : `v${previous.version}`}</small>}
          </div>
        )
      })}
      <div className="mt-auto pt-2.5">
        <div className="text-[12.5px] text-white/85">Cena nabídky v{latest.version}</div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2.5">
          <span className="big-num text-[32px] tabular-nums">{formatMoney(latest.amount_one_time, latest.currency)}</span>
          {delta !== null && (
            <span className="rounded-full bg-white/15 px-2.5 py-1 text-xs font-bold">
              {delta > 0 ? '+ ' : delta < 0 ? '− ' : ''}{Math.abs(delta).toLocaleString('cs-CZ')} % oproti v{previous!.version}
            </span>
          )}
        </div>
        {latest.sent_at && <div className="mt-2 text-[12.5px] text-white/85">Odesláno {formatDate(latest.sent_at)}</div>}
      </div>
    </section>
  )
}
