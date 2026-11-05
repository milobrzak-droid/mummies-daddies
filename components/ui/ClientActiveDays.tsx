import type { ActiveDays } from '@/domain/crm/clientOverview'
import { czPlural } from '@/domain/crm/clientOverview'

// Tečková matice „aktivní dny": týdny po sloupcích, dny Po–Ne po řádcích.
// Vyplněná tečka = ten den se s firmou něco dělo (aktivita v historii).
export function ClientActiveDays({ data }: { data: ActiveDays }) {
  const summary = `${data.activeCount} ${czPlural(data.activeCount, ['den', 'dny', 'dní'])} s aktivitou za ${data.weeks} týdnů`
  return (
    <div>
      <div className="flex items-end gap-3">
        <span className="big-num text-[44px] tabular-nums">{data.activeCount}</span>
        <span className="pb-1 text-[13px] leading-tight text-muted">
          {czPlural(data.activeCount, ['den', 'dny', 'dní'])} s aktivitou<br />za {data.weeks} týdnů
        </span>
      </div>
      <div
        role="img"
        aria-label={summary}
        className="mt-4 grid gap-[6px]"
        style={{ gridAutoFlow: 'column', gridTemplateRows: 'repeat(7, 10px)', gridAutoColumns: '10px' }}
      >
        {data.cells.map((c) => (
          <i
            key={c.day}
            className="block rounded-full"
            style={{
              background: c.future ? 'transparent' : c.active ? 'var(--d-deep)' : 'var(--d-track)',
            }}
          />
        ))}
      </div>
      <p className="mt-3 mb-0 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--d-deep)' }} />aktivita</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--d-track)' }} />nic</span>
      </p>
    </div>
  )
}
