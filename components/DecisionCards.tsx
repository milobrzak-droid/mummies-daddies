// Prezentační díly stránky Ke schválení: klidná anatomie souhrn (segment
// s počty) → karty s důkazem → historie; klidný prázdný stav. Bez dotazů a bez
// stavu (serverové komponenty); klientské je jen rozhodování, odložení
// a „Zkusit znovu". Od 0084 karta říká, co se po schválení stane, a historie
// ukazuje výsledek provedení; odložení je uložené na žádosti.
import type { ReactNode } from 'react'
import Link from 'next/link'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { buttonClass } from '@/components/ui/Button'
import { ApprovalDecideButtons } from '@/components/ApprovalDecideButtons'
import { ApprovalRetryButton } from '@/components/ApprovalRetryButton'
import { SnoozedRow } from '@/components/DecisionSnooze'
import type { ActionResult } from '@/lib/actionResult'
import { formatCzk } from '@/lib/format'
import type { ApprovalItem, DecisionItem } from '@/core/loopQueries'
import type { HistoryItem } from '@/core/decisionHistory'
import { EXTERNAL_LINK_REL, safeExternalHref } from '@/core/untrusted'
import { actorName, nodeLabel } from '@/core/workCaseFlow'
import {
  approvalTitle,
  executionSummary,
  isApprovalActionType,
  isSnoozed,
  offerParams,
  type ExecutionTone,
} from '@/core/approvalActions'

export type DecisionKind = 'schvaleni' | 'otazky'

const KIND_LABEL: Record<string, string> = {
  external_commitment: 'Závazek vůči klientovi',
}

/** Čitelný název činnosti: známé druhy česky, ostatní bez podtržítek. */
export function approvalKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, ' ')
}

/** „L2" nepatří do textů pro lidi: úroveň schválení jako číslo z 4. */
export function levelLabel(level: string): string {
  const n = /^L([1-4])$/.exec(level)?.[1]
  return n ? `${n} z 4` : 'neznámá'
}

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('cs-CZ') : '—')
export const fmtAge = (d: number) => (d === 0 ? 'dnes' : d === 1 ? '1 den' : d < 5 ? `${d} dny` : `${d} dní`)

function Ico({ d, className = 'h-[22px] w-[22px]' }: { d: string; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}
const ICON_CHECK = 'm5 12 5 5L20 7'
const ICON_DOC = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4'
const ICON_HELP = 'M9.1 9a3 3 0 1 1 4.3 2.7c-.9.5-1.4 1.1-1.4 2.3M12 17.5h.01'

// --- Filtr druhů (segment s počty = souhrn stránky) ------------------------

export function DecisionKindFilter({
  current,
  counts,
}: {
  current: DecisionKind | null
  counts: { all: number; schvaleni: number; otazky: number }
}) {
  const item = (href: string, active: boolean, label: string, n: number) => (
    <Link href={href} aria-current={active ? 'page' : undefined} className="seg-item">
      {label}
      <span className="seg-count tabular-nums">{n}</span>
    </Link>
  )
  return (
    <nav aria-label="Druhy návrhů" className="seg">
      {item('/cockpit/rozhodnuti', current === null, 'Vše', counts.all)}
      {item('/cockpit/rozhodnuti?druh=schvaleni', current === 'schvaleni', 'Schválení', counts.schvaleni)}
      {item('/cockpit/rozhodnuti?druh=otazky', current === 'otazky', 'Otázky k rozhodnutí', counts.otazky)}
    </nav>
  )
}

// --- Karta -------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 text-headline">{children}</div>
    </div>
  )
}

function CardShell({
  tone,
  icon,
  eyebrow,
  title,
  status,
  proposed,
  after,
  footer,
  children,
}: {
  tone: 'tile-sky' | 'tile-lav'
  icon: string
  eyebrow: string
  title: string
  status: ReactNode
  proposed: ReactNode
  after?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <article className={`${CARD} flex flex-col gap-5 p-5 sm:p-6`}>
      <div className="flex flex-wrap items-start gap-3.5">
        <span aria-hidden="true" className={`${tone} grid h-10 w-10 flex-none place-items-center rounded-btn text-ink`}><Ico d={icon} className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1 basis-56">
          <div className="eyebrow">{eyebrow}</div>
          <h2 className="m-0 mt-1 font-heading text-title2 font-bold">{title}</h2>
        </div>
        {status}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="eyebrow mb-2">Co navrhujeme</div>
          {proposed}
        </div>
        <div>
          <div className="eyebrow mb-2">Odkud to víme</div>
          {children}
        </div>
      </div>
      {after}
      {footer && <div className="flex flex-wrap items-start gap-4 border-t border-[color:var(--c-line-2)] pt-4">{footer}</div>}
    </article>
  )
}

function AgeStatus({ ageDays, expired, expiresAt }: { ageDays: number; expired?: boolean; expiresAt?: string | null }) {
  if (expired) return <span className="st fail">Vypršelo {fmtDate(expiresAt ?? null)}</span>
  return <span className="st">Čeká {fmtAge(ageDays)}</span>
}

function EvidenceBox({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2.5 rounded-tile border border-border bg-surface p-4">{children}</div>
}

const OPEN_LINK = buttonClass('outline', 'sm', 'shrink-0')

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

/** Nabídka, o jejímž odeslání se rozhoduje — jen pro obchodní role (RLS sales_only). */
export type OfferTarget = {
  version: number
  amount_one_time: number | string
  expected_mrr: number | string
  currency: 'CZK' | 'EUR'
  deal_id: number
  deal_title: string | null
  account_id: number | null
}

function fmtMoney(v: number | string, currency: 'CZK' | 'EUR'): string {
  if (currency === 'CZK') return formatCzk(v)
  return `${Number(v).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} EUR`
}

/** Co se stane po schválení (a po zamítnutí nebo vypršení) — jednou větou. */
function Consequences({ onApprove, onReject, external }: { onApprove: string; onReject: string | null; external: boolean }) {
  return (
    <section aria-label="Co se stane po rozhodnutí" className="flex gap-3.5 rounded-tile bg-[color:var(--c-soft)] p-4">
      <span aria-hidden="true" className={`${external ? 'tile-sun' : 'tile-mint'} grid h-9 w-9 flex-none place-items-center rounded-full text-ink`}>
        <Ico d={external ? ICON_HAND : ICON_BOLT} className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <div className="eyebrow mb-1">Po schválení</div>
        <p className="m-0 text-headline">{onApprove}</p>
        {onReject && <p className="m-0 mt-1.5 text-callout text-muted">{onReject}</p>}
      </div>
    </section>
  )
}

const ICON_BOLT = 'M13 2 4 14h7l-1 8 9-12h-7z'
const ICON_HAND = 'M12 3v10M8 7v7M16 7v7M4 12v3a7 7 0 0 0 14 0v-5'

export function ApprovalCard({
  a,
  requester,
  canDecide,
  action,
  snoozeAction = null,
  title,
  consequences,
  offer = null,
  snoozedByName = null,
  now = new Date(),
}: {
  a: ApprovalItem
  requester: string
  canDecide: boolean
  action: Action
  snoozeAction?: Action | null
  title?: string
  consequences?: { onApprove: string; onReject: string | null }
  offer?: OfferTarget | null
  snoozedByName?: string | null
  now?: Date
}) {
  const kind = title ?? approvalTitle(a, approvalKindLabel)
  const typed = isApprovalActionType(a.action_type)
  const offerRef = a.action_type === 'send_offer' ? offerParams(a.params) : null
  const caseHref = a.case_id ? `/cockpit/pripady/${a.case_id}` : null
  const dealHref = offer?.account_id ? `/cockpit/clients/${offer.account_id}/deals/${offer.deal_id}?tab=nabidky` : null
  const context = a.case_title
    ?? (offer?.deal_title ? `Nabídka ${offer.deal_title}` : offerRef ? `Nabídka (verze ${offerRef.version})` : null)
  const label = `${kind}${context ? ` — ${context}` : ''}`

  // Odložená žádost (0084): vidí ji všichni jako jeden řádek; vrátit smí jen schvalovatel.
  if (!a.expired && a.snoozed_until && isSnoozed(a, now)) {
    return (
      <SnoozedRow
        title={label}
        until={a.snoozed_until}
        byName={snoozedByName}
        requestId={a.id}
        action={canDecide ? snoozeAction : null}
      />
    )
  }

  return (
    <CardShell
      tone="tile-sky"
      icon={ICON_CHECK}
      eyebrow={`Schválení${context ? ` · ${context}` : ''}`}
      title={kind}
      status={<AgeStatus ageDays={a.ageDays} expired={a.expired} expiresAt={a.expires_at} />}
      after={consequences && <Consequences {...consequences} external={a.action_type === 'send_offer'} />}
      footer={
        a.expired ? (
          <p className="m-0 text-callout text-muted">
            Žádost vypršela, už se nedá schválit ani zamítnout.{typed ? ' Denní kontrola ji uzavře a vlastník dostane úkol.' : ''}
          </p>
        ) : canDecide ? (
          <ApprovalDecideButtons
            action={action}
            requestId={a.id}
            label={label}
            caseHref={caseHref ?? dealHref}
            editLabel={caseHref ? 'Upravit' : 'Otevřít obchod'}
            snoozeAction={snoozeAction}
            typed={typed}
          />
        ) : (
          <p className="m-0 text-callout text-muted">
            {a.action_type === 'send_offer'
              ? 'Rozhodnout může jen někdo jiný než žadatel, s přístupem k obchodu a dostatečnou rolí. Tobě se tlačítka nezobrazují.'
              : 'Rozhodnout může jen někdo jiný než žadatel, s dostatečnou rolí. Tobě se tlačítka nezobrazují.'}
          </p>
        )
      }
      proposed={
        <div className="flex flex-col gap-3 rounded-tile bg-[color:var(--c-soft)] p-4">
          <Fact label="Žádá">{requester}</Fact>
          <div className="grid grid-cols-2 gap-3">
            <Fact label="Úroveň">{levelLabel(a.requested_level)}</Fact>
            <Fact label="Vyprší">{a.expires_at ? fmtDate(a.expires_at) : 'Bez termínu'}</Fact>
          </div>
        </div>
      }
    >
      <EvidenceBox>
        {a.action_type === 'send_offer' ? (
          <>
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="grid h-9 w-9 flex-none place-items-center rounded-full bg-[color:var(--c-soft)] text-ink"><Ico d={ICON_DOC} className="h-[18px] w-[18px]" /></span>
              <div className="min-w-0 flex-1">
                <span className="block text-headline">
                  {offer?.deal_title ?? 'Nabídka'}{offerRef ? ` · verze ${offerRef.version}` : ''}
                </span>
                <span className="text-footnote text-muted">
                  {offer
                    ? `${fmtMoney(offer.amount_one_time, offer.currency)}${Number(offer.expected_mrr) > 0 ? ` + ${fmtMoney(offer.expected_mrr, offer.currency)} měsíčně` : ''}`
                    : 'Částky vidí jen obchodní role'}
                  {' · '}podáno před {fmtAge(a.ageDays)}
                </span>
              </div>
            </div>
            {dealHref ? (
              <div className="flex items-center justify-between gap-3 text-callout text-muted">
                Rozsah a verze nabídky jsou u obchodu.
                <Link href={dealHref} className={OPEN_LINK} aria-label={`Otevřít obchod — ${offer?.deal_title ?? kind}`}>Otevřít</Link>
              </div>
            ) : (
              <p className="m-0 text-callout text-muted">Obsah nabídky kryje otisk žádosti; změní-li se, schválení se neuplatní.</p>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="grid h-9 w-9 flex-none place-items-center rounded-full bg-[color:var(--c-soft)] text-ink"><Ico d={ICON_DOC} className="h-[18px] w-[18px]" /></span>
              <div className="min-w-0 flex-1">
                <span className="block text-headline">{a.case_title ?? 'Bez případu'}</span>
                <span className="text-footnote text-muted">
                  {a.case_node ? nodeLabel(a.case_node) : 'Rozhoduje vedení'} · podáno před {fmtAge(a.ageDays)}
                </span>
              </div>
            </div>
            {caseHref ? (
              <div className="flex items-center justify-between gap-3 text-callout text-muted">
                Podklady, kroky a poznámky jsou v případu.
                <Link href={caseHref} className={OPEN_LINK} aria-label={`Otevřít případ — ${a.case_title ?? kind}`}>Otevřít</Link>
              </div>
            ) : (
              <p className="m-0 text-callout text-muted">Žádost není navázaná na případ.</p>
            )}
          </>
        )}
      </EvidenceBox>
    </CardShell>
  )
}

export function QuestionCard({ d }: { d: DecisionItem }) {
  const evidence = safeExternalHref(d.evidence_link)
  const caseHref = d.case_id ? `/cockpit/pripady/${d.case_id}` : null
  return (
      <CardShell
        tone="tile-lav"
        icon={ICON_HELP}
        eyebrow={`Otázka k rozhodnutí${d.case_title ? ` · ${d.case_title}` : ''}`}
        title={d.question}
        status={<AgeStatus ageDays={d.ageDays} />}
        proposed={
          <div className="flex flex-col gap-3 rounded-tile bg-[color:var(--c-soft)] p-4">
            <div className="eyebrow">Možnosti</div>
            {d.options.length ? (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {d.options.map((o) => (
                  <li key={o} className="rounded-full bg-surface px-3 py-1 text-callout font-semibold shadow-[inset_0_0_0_1px_var(--c-line)]">{o}</li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-callout text-muted">Bez předdefinovaných možností.</p>
            )}
          </div>
        }
      >
        <EvidenceBox>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid h-9 w-9 flex-none place-items-center rounded-full bg-[color:var(--c-soft)] text-ink"><Ico d={ICON_DOC} className="h-[18px] w-[18px]" /></span>
            <div className="min-w-0 flex-1">
              <span className="block text-headline">{d.case_title ?? 'Bez případu'}</span>
              <span className="text-footnote text-muted">Čeká {fmtAge(d.ageDays)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {evidence ? (
              <a
                href={evidence}
                target="_blank"
                rel={EXTERNAL_LINK_REL}
                aria-label={`Otevřít důkaz — ${d.case_title ?? d.question}`}
                className={OPEN_LINK}
              >
                Otevřít důkaz
              </a>
            ) : (
              <span className="text-callout text-muted">Bez odkazu na důkaz.</span>
            )}
            {caseHref && (
              <Link href={caseHref} className={buttonClass('secondary', 'sm')} aria-label={`Rozhodnout v případu — ${d.case_title ?? d.question}`}>
                Rozhodnout v případu
              </Link>
            )}
          </div>
        </EvidenceBox>
      </CardShell>
  )
}

// --- Historie ---------------------------------------------------------------

const HISTORY_ST: Record<HistoryItem['status'], { cls: string; label: string }> = {
  approved: { cls: 'st done', label: 'Schváleno' },
  rejected: { cls: 'st fail', label: 'Zamítnuto' },
  expired: { cls: 'st', label: 'Vypršelo' },
}

const TONE_ST: Record<ExecutionTone, string> = { done: 'st done', wait: 'st', fail: 'st fail' }

/** Kolik posledních rozhodnutí je vidět hned; starší jsou pod <details>. */
const HISTORY_VISIBLE = 5

export function DecisionHistory({
  items,
  names,
  retryAction = null,
}: {
  items: HistoryItem[]
  names: ReadonlyMap<string, string>
  retryAction?: Action | null
}) {
  const row = (h: HistoryItem) => {
    const title = approvalTitle(h, approvalKindLabel)
    const offer = h.action_type === 'send_offer' ? offerParams(h.params) : null
    const sum = h.execution ? executionSummary(h.execution, h, names) : null
    return (
      <li key={h.id} className="flex items-start gap-3 border-t border-[color:var(--c-line-2)] py-3 first:border-t-0">
        <div className="min-w-0 flex-1">
          <b className="block text-headline">
            {title}
            {h.case_title ? `: ${h.case_title}` : offer ? ` (verze ${offer.version})` : ''}
          </b>
          <small className="mt-0.5 block text-footnote text-muted">
            {h.decided_by ? `${actorName(h.decided_by, names)} · ` : ''}
            {fmtDate(h.decided_at)}
          </small>
          {sum && (
            <div className="mt-2 flex flex-col items-start gap-1.5">
              <span className={TONE_ST[sum.tone]}>{sum.label}</span>
              <small className="block text-footnote text-muted">{sum.text}</small>
              {sum.canRetry && retryAction && (
                <ApprovalRetryButton action={retryAction} requestId={h.id} label={title} />
              )}
            </div>
          )}
          {!sum && isApprovalActionType(h.action_type) && (
            <small className="mt-1 block text-footnote text-muted">Výsledek provedení zatím není zapsaný.</small>
          )}
        </div>
        <span className={HISTORY_ST[h.status].cls}>{HISTORY_ST[h.status].label}</span>
      </li>
    )
  }
  const recent = items.slice(0, HISTORY_VISIBLE)
  const older = items.slice(HISTORY_VISIBLE)
  return (
    <section className={`${CARD} p-5 sm:p-6`} aria-labelledby="dh-h">
      <h2 id="dh-h" className="m-0 mb-1 font-heading text-title2 font-bold">Historie rozhodnutí</h2>
      {items.length === 0 ? (
        <p className="m-0 text-callout text-muted">Zatím nikdo nic nerozhodl. Vyřízené návrhy se ukážou tady.</p>
      ) : (
        <>
          <p className="m-0 mb-2 text-callout text-muted">Co kdo rozhodl a jestli se to provedlo.</p>
          <ul className="m-0 list-none p-0">{recent.map(row)}</ul>
          {older.length > 0 && (
            <details className="group mt-1 border-t border-[color:var(--c-line-2)]">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 text-callout font-semibold text-ink [&::-webkit-details-marker]:hidden">
                <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
                Starší rozhodnutí ({older.length})
              </summary>
              <ul className="m-0 list-none p-0">{older.map(row)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  )
}

// --- Klidný prázdný stav -----------------------------------------------------

export function CalmEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className={CARD}>
      {filtered ? (
        <EmptyState title="Tady nic nečeká" tone="calm" action={{ href: '/cockpit/rozhodnuti', label: 'Zobrazit vše' }}>
          V ostatních druzích se ještě podívej.
        </EmptyState>
      ) : (
        <EmptyState title="Nic nečeká na tebe" tone="calm">
          Vše je vyřízené. Nový návrh se ukáže tady.
        </EmptyState>
      )}
    </div>
  )
}
