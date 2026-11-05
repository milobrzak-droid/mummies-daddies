import type { ReactNode } from 'react'
import Link from 'next/link'
import { Avatar } from '@/components/Avatar'
import { CARD } from '@/components/ui/Card'

// Vlastník obchodu v pravém sloupci „Souvislosti“ (plán vlny 2): klidná karta
// s iniciálami a jménem, bez ilustrace. Když obchod nikdo nevede, řekne to
// slovem a nabídne cestu na klienta. `change` je tlačítko „Změnit vlastníka"
// (components/OwnerChange.tsx), které stránka vloží jen tomu, kdo smí.
export function DealsOwnerCard({ name, clientHref, clientName, change }: { name: string | null; clientHref: string; clientName: string; change?: ReactNode }) {
  return (
    <section aria-labelledby="vlastnik-obchodu" className={`${CARD} p-5`}>
      <h2 id="vlastnik-obchodu" className="eyebrow m-0">Vlastník obchodu</h2>
      <div className="mt-3 flex items-center gap-3">
        {name ? <Avatar name={name} size={40} /> : (
          <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full border border-dashed border-[color:var(--c-field-line)] text-muted">?</span>
        )}
        <div className="min-w-0 grow">
          <p className={`m-0 truncate text-headline ${name ? 'text-ink' : 'text-neg'}`}>{name ?? 'Bez vlastníka'}</p>
          <p className="m-0 truncate text-footnote text-muted">
            {name ? <>Klient <Link href={clientHref}>{clientName}</Link></> : 'Obchod zatím nikdo nevede.'}
          </p>
        </div>
      </div>
      {change && <div className="mt-3">{change}</div>}
    </section>
  )
}
