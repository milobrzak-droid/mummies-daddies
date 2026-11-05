import Link from 'next/link'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { formatDate } from '@/lib/format'
import { createReminderTask } from '@/domain/delivery/actions/waiting'
import {
  overdueLabel, reminderDraft, reminderMailto, waitingAgeLabel, waitingSummary, WAITING_QUIET_DAYS,
  type WaitingItem,
} from '@/domain/delivery/waiting'
import type { Loaded } from '@/domain/delivery/queries/documents'
import { ReminderButton } from '@/components/ui/ReminderButton'
import { CheckIcon, TodayCount, TodayStatus } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Karta „Čeká na klienta": milníky dodávek, které stojí, protože čekají na
// podklady nebo na schválení klientem. U každého co se čeká, jak dlouho, jestli
// je po termínu, a co udělat: „Připomenout klientovi" založí úkol s návrhem
// e-mailu (nic se neodesílá), návrh jde otevřít i rovnou v poště.

function WaitingRow({ item, scope }: { item: WaitingItem; scope: 'today' | 'engagement' }) {
  const draft = reminderDraft(item)
  const mailto = reminderMailto(draft, item.contact?.email)
  const late = item.signals.includes('overdue')
  const quiet = item.signals.includes('quiet')
  return (
    <li className="rounded-tile border border-border p-3.5">
      {scope === 'today' && <span className="block text-footnote font-semibold text-muted">{item.accountName} · {item.deliveryLabel}</span>}
      <Link href={item.href} className="block font-heading text-[16px] font-bold leading-tight tracking-tight text-ink no-underline hover:text-ink hover:underline">
        {item.title}
      </Link>
      <p className="m-0 mt-1 text-callout text-muted">{item.what}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <TodayStatus tone="info">{waitingAgeLabel(item.daysWaiting)}</TodayStatus>
        {late && item.daysOverdue !== null && <TodayStatus tone="fail">{overdueLabel(item.daysOverdue)}</TodayStatus>}
        {quiet && <TodayStatus tone="wait">Bez pohybu</TodayStatus>}
        {item.dueOn && !late && <span className="text-footnote text-muted">termín {formatDate(item.dueOn)}</span>}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {item.reminderOpen ? (
          <p className="m-0 flex items-center gap-2 text-callout text-muted">
            <span aria-hidden="true" className="text-pos"><CheckIcon size={16} /></span>
            Připomínka je založená v <Link href="/cockpit/tasks" className="font-semibold text-ink underline">Úkolech</Link>.
          </p>
        ) : (
          <>
            <ReminderButton action={createReminderTask.bind(null, item.engagementId, item.milestoneId)} />
            <p className="m-0 text-footnote text-muted">Založí úkol s návrhem e-mailu. Nic se neodesílá.</p>
          </>
        )}

        <details className="text-callout">
          <summary className="inline-flex min-h-[44px] cursor-pointer items-center font-semibold text-ink">Návrh e-mailu</summary>
          <div className="mt-1 rounded-btn bg-[color:var(--c-soft)] p-3">
            <p className="m-0 text-footnote text-muted">Předmět</p>
            <p className="m-0 mb-2 font-semibold text-ink">{draft.subject}</p>
            <p className="m-0 whitespace-pre-line text-ink">{draft.body}</p>
            <p className="m-0 mt-3 text-footnote text-muted">
              {item.contact?.email
                ? `Klientský kontakt: ${item.contact.name ?? item.contact.email}.`
                : 'U dodávky není vyplněný klientský sponzor, adresu doplníš v poště.'}
            </p>
            <a href={mailto} className="mt-1 inline-flex min-h-[44px] items-center font-semibold text-ink underline">
              Otevřít v poště
            </a>
            <p className="m-0 text-footnote text-muted">Otevře nový e-mail. Odejde teprve tehdy, když ho odešleš sám.</p>
          </div>
        </details>
      </div>
    </li>
  )
}

export function WaitingCard({
  result, scope = 'today', max = 5,
}: {
  result: Loaded<{ items: WaitingItem[] }>
  scope?: 'today' | 'engagement'
  max?: number
}) {
  const title = 'Čeká na klienta'
  if (result.state === 'missing_migration') {
    return (
      <Card title={title}>
        <FeaturePending variant="compact" migration="0042">Pak tu bude vidět, na co čekáme od klienta.</FeaturePending>
      </Card>
    )
  }
  if (result.state === 'error') {
    return (
      <Card title={title}>
        <p role="alert" className="m-0 text-callout text-neg">Nepodařilo se načíst, co čeká na klienta. Zkuste to prosím později.</p>
      </Card>
    )
  }

  const items = result.items
  const shown = items.slice(0, max)
  const urgent = items.filter((i) => i.signals.length > 0).length
  return (
    <Card
      title={title}
      sub={waitingSummary(items)}
      badge={urgent > 0 ? <TodayCount n={urgent} tone="neg" /> : undefined}
    >
      {items.length === 0 ? (
        <EmptyState tone="calm" compact title="Nic nečeká na klienta">
          Milník, který čeká na podklady nebo na schválení klientem, se ukáže tady.
        </EmptyState>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {shown.map((item) => <WaitingRow key={item.key} item={item} scope={scope} />)}
          </ul>
          {items.length > shown.length && (
            <p className="m-0 mt-3 text-callout text-muted">A dalších {items.length - shown.length} čeká na klienta.</p>
          )}
          <p className="m-0 mt-3 text-footnote text-muted">
            Zvýrazňujeme milník, který je po termínu nebo čeká na klienta {WAITING_QUIET_DAYS} dní a víc.
          </p>
        </>
      )}
    </Card>
  )
}
