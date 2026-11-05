import Link from 'next/link'
import { formatDate } from '@/lib/format'
import { plural } from '@/domain/crm/today'
import { dismissAutoIntake, undoAutoIntake } from '@/domain/crm/actions/autoIntake'
import type { AutoIntakeCard } from '@/domain/crm/queries/autoIntake'
import { IntakeUndoButton } from '@/components/ui/IntakeUndoButton'
import { TodayCount, TodayStatus } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'

// Karta „Nové poptávky" na obrazovce Dnes: klidný seznam firem, které Cockpit
// založil sám z příchozího e-mailu (klient, kontakt, obchod v Kvalifikaci,
// úkol „Odpovědět na poptávku"). U každé je „Není poptávka" (Zpět) a odkaz na
// klienta; pod tím věta o návrzích nižší jistoty, které čekají na schválení.
// Bez poptávek a bez návrhů se karta nevykreslí vůbec (nic k hlášení).
// Čistě prezentační server komponenta; data dodává stránka.

export function hasIntakeContent(card: AutoIntakeCard): boolean {
  return card.state === 'ok' && (card.items.length > 0 || card.pendingProposals > 0)
}

export function TodayIntake({ card }: { card: AutoIntakeCard }) {
  if (card.state !== 'ok' || !hasIntakeContent(card)) return null
  const { items, pendingProposals } = card
  const n = items.length
  return (
    <Card
      title="Nové poptávky"
      sub={n > 0 ? `Založeno automaticky z e-mailu: ${n}` : 'Nic se nezaložilo samo'}
      badge={n + pendingProposals > 0 ? <TodayCount n={n + pendingProposals} /> : undefined}
    >
      {n > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((item) => (
            <li key={item.id} className="rounded-tile border border-border p-3.5">
              <Link
                href={`/cockpit/clients/${item.accountId}`}
                className="block font-heading text-[16px] font-bold leading-tight tracking-tight text-ink no-underline hover:text-ink hover:underline"
              >
                Nová poptávka: {item.accountName}
              </Link>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <TodayStatus tone="done">vzniklo automaticky</TodayStatus>
              </div>
              <p className="m-0 mt-2 text-callout text-muted">
                Další krok: {item.nextStep ?? 'Odpovědět na poptávku'}
                {item.nextStepDue ? ` · do ${formatDate(item.nextStepDue)}` : ''}
              </p>
              <div className="mt-3">
                <IntakeUndoButton
                  action={undoAutoIntake.bind(null, item.id)}
                  dismiss={dismissAutoIntake.bind(null, item.id)}
                  label={item.accountName}
                />
                <p className="m-0 mt-1.5 text-footnote text-muted">
                  Smaže, co vzniklo z e-mailu, a doménu si zapamatuje. Když se s firmou už pracovalo, nabídne uzavření obchodu jako Prohráno.
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {pendingProposals > 0 && (
        <p className={`m-0 text-callout text-muted ${n > 0 ? 'mt-3' : ''}`}>
          {pendingProposals} {plural(pendingProposals, 'nejistá poptávka čeká', 'nejisté poptávky čekají', 'nejistých poptávek čeká')} na tvoje schválení.{' '}
          <Link href="/cockpit/pripady?view=navrhy" className="font-semibold text-ink underline">Otevřít návrhy</Link>
        </p>
      )}
    </Card>
  )
}
