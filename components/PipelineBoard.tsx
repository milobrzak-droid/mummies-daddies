'use client'
import { LostReasonSelect, lostReasonComplete } from '@/components/LostReasonSelect'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, type ReactNode, useRef, useState } from 'react'
import { Avatar } from '@/components/Avatar'
import { formatCzk, formatCzkShort, formatDate, formatPersonName } from '@/lib/format'
import { DEAL_STAGES, dealKindLabel, dealStageLabel } from '@/lib/domain'
import { DealsBar, DealsCompanyLogo, DealsIcon, stageDotColor } from '@/components/DealsVisuals'
import { buttonClass } from '@/components/ui/Button'
import { useUndoToast } from '@/components/ui/Toast'
import { OwnerChange } from '@/components/OwnerChange'
import { canChangeOwner, type OwnerActor, type OwnerPerson } from '@/lib/ownerChange'
import { useModal } from '@/components/ui/useModal'
import type { DealStage } from '@/lib/types'
import type { SalesDealLike } from '@/domain/crm/sales'
import type { ActionResult } from '@/lib/actionResult'
import { checkDealInvariant } from '@/domain/crm/dealInvariant'
import { DEAL_TRANSITION_MESSAGES, transitionIssues } from '@/domain/crm/dealTransition'

const tomorrow = () => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10)
}

const CLOSED_BY_STAGE_CHANGE: DealStage[] = ['vyhráno', 'prohráno']

/**
 * Jde změnu fáze vrátit tlačítkem Zpět? Ne u vstupu do Vyhráno ani návratu
 * z něj: vyhrání samo založí dodávku (0080), kterou vrácení fáze nesmaže –
 * proto se vyhrání potvrzuje dialogem. Návrat do Prohráno potřebuje důvod.
 */
export function canUndoStageChange(previous: Pick<SalesDealLike, 'stage' | 'lost_reason'>, next: DealStage): boolean {
  if (previous.stage === next) return false
  if (previous.stage === 'vyhráno' || next === 'vyhráno') return false
  if (previous.stage === 'prohráno' && !previous.lost_reason?.trim()) return false
  return true
}

/** Jde vrátit úpravu dalšího kroku? Jen když předtím nějaký krok s termínem byl. */
export function canUndoNextStep(previous: Pick<SalesDealLike, 'next_step' | 'next_step_due'>): boolean {
  return !!previous.next_step?.trim() && !!previous.next_step_due
}

// Tabule obchodů: sloupec = fáze. Fáze se mění přetažením nebo výběrem na
// kartě, další krok a vlastník (tlačítko „Změnit vlastníka", 0093) přímo na
// kartě – bez přechodu na /edit. Vratné změny
// potvrdí toast se Zpět (vrácení volá tutéž serverovou akci s předchozí
// hodnotou), vyhrání a prohra se potvrzují dialogem.
export function PipelineBoard({
  deals, stages, updateStage, updateNextStep, ownerContext,
}: {
  deals: SalesDealLike[]
  stages: DealStage[]
  updateStage: (dealId: number, stage: string, lostReason?: string) => Promise<ActionResult>
  updateNextStep: (dealId: number, nextStep: string, dueOn: string) => Promise<ActionResult>
  /** Kdo se dívá a koho jde vybrat za vlastníka; bez toho karta změnu vlastníka nenabízí. */
  ownerContext?: { actor: OwnerActor | null; members: OwnerPerson[] }
}) {
  const router = useRouter()
  const toast = useUndoToast()
  const [visibleDeals, setVisibleDeals] = useState(deals)
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set())
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [dropStage, setDropStage] = useState<DealStage | null>(null)
  const [lossDeal, setLossDeal] = useState<SalesDealLike | null>(null)
  const [winDeal, setWinDeal] = useState<SalesDealLike | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  // Přechod zablokovaný povinnými poli (0052) — důvod + odkaz na doplnění.
  const [blocked, setBlocked] = useState<{ deal: SalesDealLike; messages: string[] } | null>(null)
  const today = new Date().toISOString().slice(0, 10)

  const setSaving = (dealId: number, saving: boolean) => {
    setSavingIds((current) => {
      const next = new Set(current)
      if (saving) next.add(dealId)
      else next.delete(dealId)
      return next
    })
  }
  const patchDeal = (dealId: number, patch: Partial<SalesDealLike>) => {
    setVisibleDeals((rows) => rows.map((row) => row.id === dealId ? { ...row, ...patch } : row))
  }

  // Vrácení fáze: tatáž akce s předchozí fází; když uzavření smazalo další
  // krok, vrátí se i ten. Chyba se ukáže v toastu („Vrácení se nepovedlo“).
  async function undoStage(previous: SalesDealLike, stage: DealStage) {
    const back = await updateStage(previous.id, previous.stage, previous.stage === 'prohráno' ? previous.lost_reason ?? undefined : undefined)
    if (!back.success) throw new Error(back.error ?? 'undo failed')
    if (CLOSED_BY_STAGE_CHANGE.includes(stage) && canUndoNextStep(previous)) {
      await updateNextStep(previous.id, previous.next_step!, previous.next_step_due!)
    }
    patchDeal(previous.id, { stage: previous.stage, next_step: previous.next_step, next_step_due: previous.next_step_due })
    router.refresh()
  }

  async function commitStage(deal: SalesDealLike, stage: DealStage, reason?: string) {
    if (deal.stage === stage || savingIds.has(deal.id)) return
    const previous = deal
    setError('')
    setBlocked(null)
    setSaving(deal.id, true)
    patchDeal(deal.id, { stage })
    const result = await updateStage(deal.id, stage, reason)
    if (!result.success) {
      patchDeal(deal.id, { stage: previous.stage })
      setError(result.error ?? 'Fázi se nepodařilo změnit.')
    } else {
      router.refresh()
      toast.show({
        message: `${deal.title}: ${dealStageLabel(stage)}.`,
        undo: canUndoStageChange(previous, stage) ? () => undoStage(previous, stage) : undefined,
      })
    }
    setSaving(deal.id, false)
  }

  function requestStage(deal: SalesDealLike, stage: DealStage) {
    if (deal.stage === stage) return
    // Důvod prohry se doplní v dialogu; ostatní povinná pole přechodu
    // (rozhodovatel a termín pro Rozhodování) jen v úpravě obchodu.
    const issues = transitionIssues(deal, stage).filter((issue) => issue !== 'missing_lost_reason')
    if (issues.length > 0) {
      setError('')
      setBlocked({ deal, messages: issues.map((issue) => DEAL_TRANSITION_MESSAGES[issue]) })
      return
    }
    if (stage === 'prohráno') {
      setLossDeal(deal)
      return
    }
    if (stage === 'vyhráno') {
      setWinDeal(deal)
      return
    }
    void commitStage(deal, stage)
  }

  async function saveNextStep(deal: SalesDealLike, event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingIds.has(deal.id)) return
    const data = new FormData(event.currentTarget)
    const nextStep = String(data.get('next_step') ?? '').trim()
    const dueOn = String(data.get('next_step_due') ?? '')
    const previous = { next_step: deal.next_step, next_step_due: deal.next_step_due }
    setError('')
    setSaving(deal.id, true)
    patchDeal(deal.id, { next_step: nextStep, next_step_due: dueOn })
    const result = await updateNextStep(deal.id, nextStep, dueOn)
    if (!result.success) {
      patchDeal(deal.id, previous)
      setError(result.error ?? 'Další krok se nepodařilo uložit.')
    } else {
      setEditingId(null)
      router.refresh()
      toast.show({
        message: 'Další krok je uložený.',
        undo: canUndoNextStep(previous)
          ? async () => {
            const back = await updateNextStep(deal.id, previous.next_step!, previous.next_step_due!)
            if (!back.success) throw new Error(back.error ?? 'undo failed')
            patchDeal(deal.id, previous)
            router.refresh()
          }
          : undefined,
      })
    }
    setSaving(deal.id, false)
  }

  const grandTotal = visibleDeals
    .filter((deal) => stages.includes(deal.stage))
    .reduce((sum, deal) => sum + Number(deal.amount_one_time ?? 0), 0)
  const shortDate = (value: string) => new Date(value).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-footnote text-muted"><span className="hidden md:inline">Přetáhni kartu mezi sloupci, nebo </span>změň fázi výběrem na kartě.</p>
        {savingIds.size > 0 && <span aria-live="polite" className="text-footnote text-muted">Ukládám změnu…</span>}
      </div>
      {error && <p role="alert" className="mb-4 rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-3 text-body text-neg">{error}</p>}
      {blocked && (
        <div role="alert" className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-3 text-body text-neg">
          <div className="min-w-0">
            <p className="m-0 font-semibold">{blocked.deal.title}: fázi nejde změnit</p>
            {blocked.messages.map((message) => <p key={message} className="m-0">{message}</p>)}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href={`/cockpit/clients/${blocked.deal.account_id}/deals/${blocked.deal.id}/edit`} className={buttonClass('outline', 'sm')}>Doplnit v obchodu</Link>
            <button type="button" onClick={() => setBlocked(null)} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-lg leading-none text-neg hover:bg-white/60" aria-label="Zavřít upozornění">×</button>
          </div>
        </div>
      )}
      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stages.map((stage) => {
          const stageDeals = visibleDeals.filter((deal) => deal.stage === stage)
          const color = stageDotColor(stage)
          const total = stageDeals.reduce((sum, deal) => sum + Number(deal.amount_one_time ?? 0), 0)
          const share = grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0
          const activeDrop = dropStage === stage
          const isOpenStage = DEAL_STAGES.find((item) => item.key === stage)?.open ?? false
          return (
            <section
              key={stage}
              aria-label={`Fáze ${dealStageLabel(stage)}`}
              className={`flex min-w-0 flex-col gap-2.5 rounded-tile px-2.5 py-3 transition-colors duration-fast ${activeDrop ? 'bg-[color:var(--c-accent-soft)] outline outline-2 outline-[color:var(--c-accent)]' : 'bg-[color:var(--c-soft)]'}`}
              onDragOver={(event) => { if (draggedId) { event.preventDefault(); setDropStage(stage) } }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropStage(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const deal = visibleDeals.find((item) => item.id === draggedId)
                setDropStage(null)
                setDraggedId(null)
                if (deal) requestStage(deal, stage)
              }}
            >
              <header className="flex items-center gap-1.5 px-0.5">
                <i aria-hidden="true" className="block h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: color }} />
                <h3 className="m-0 min-w-0 flex-1 text-headline">{dealStageLabel(stage)}</h3>
                <span className="grid h-[22px] min-w-[22px] place-items-center rounded-full bg-surface px-1 text-[11.5px] font-bold tabular-nums text-ink shadow-[inset_0_0_0_1px_var(--c-line)]" aria-label={`${stageDeals.length} obchodů`}>{stageDeals.length}</span>
              </header>
              <div className="flex items-baseline justify-between px-0.5 text-footnote text-muted">
                <b className="text-callout font-bold tabular-nums text-ink">{formatCzkShort(total)}</b>
                <span className="tabular-nums">{share} %</span>
              </div>
              <DealsBar pct={share} color={color} label={`Podíl fáze na hodnotě zobrazených obchodů: ${share} %`} />

              {stageDeals.length === 0 && (
                <div className={`flex flex-col items-center justify-center gap-2 rounded-tile border-2 border-dashed px-3 py-6 text-center text-callout ${activeDrop ? 'border-[color:var(--c-accent)] text-ink' : 'border-[color:var(--c-line)] text-muted'}`}>
                  <DealsIcon name="briefcase" size={22} className="text-muted" />
                  {activeDrop ? 'Pustit sem' : 'Zatím žádný obchod.'}
                </div>
              )}

              {stageDeals.map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  today={today}
                  saving={savingIds.has(deal.id)}
                  editing={editingId === deal.id}
                  onEdit={(open) => setEditingId(open ? deal.id : null)}
                  onSaveNextStep={(event) => void saveNextStep(deal, event)}
                  onStage={(next) => requestStage(deal, next)}
                  onDragStart={() => setDraggedId(deal.id)}
                  onDragEnd={() => { setDraggedId(null); setDropStage(null) }}
                  shortDate={shortDate}
                  ownerContext={ownerContext}
                />
              ))}

              {isOpenStage && (
                <Link href="/cockpit/pipeline/new" className="mt-auto flex min-h-[44px] items-center justify-center gap-1.5 rounded-btn border-[1.5px] border-dashed border-[color:var(--c-line)] p-2.5 text-callout font-semibold text-muted no-underline transition-colors duration-fast hover:bg-surface hover:text-ink">
                  <DealsIcon name="plus" size={15} />Přidat obchod
                </Link>
              )}
            </section>
          )
        })}
      </div>

      {lossDeal && (
        <BoardDialog
          labelId="lost-deal-title"
          eyebrow="Uzavřít obchod"
          title="Co jsme se dozvěděli?"
          onClose={() => setLossDeal(null)}
          onSubmit={(reason) => {
            const deal = lossDeal
            setLossDeal(null)
            void commitStage(deal, 'prohráno', reason)
          }}
          submitLabel="Označit jako prohraný"
          reasonLabel="Důvod prohry"
        >
          Krátký důvod u <b className="text-ink">{lossDeal.title}</b> pomůže týmu příště vyhrát.
        </BoardDialog>
      )}

      {winDeal && (
        <BoardDialog
          labelId="won-deal-title"
          eyebrow="Uzavřít obchod"
          title="Označit obchod jako vyhraný?"
          onClose={() => setWinDeal(null)}
          onSubmit={() => {
            const deal = winDeal
            setWinDeal(null)
            void commitStage(deal, 'vyhráno')
          }}
          submitLabel="Označit jako vyhraný"
        >
          K obchodu <b className="text-ink">{winDeal.title}</b> se hned založí dodávka. Vrácení fáze ji nesmaže,
          proto se vyhrání nedá vrátit tlačítkem Zpět.
        </BoardDialog>
      )}
    </div>
  )
}

function DealCard({
  deal, today, saving, editing, onEdit, onSaveNextStep, onStage, onDragStart, onDragEnd, shortDate, ownerContext,
}: {
  deal: SalesDealLike
  today: string
  saving: boolean
  editing: boolean
  onEdit: (open: boolean) => void
  onSaveNextStep: (event: FormEvent<HTMLFormElement>) => void
  onStage: (stage: DealStage) => void
  onDragStart: () => void
  onDragEnd: () => void
  shortDate: (value: string) => string
  ownerContext?: { actor: OwnerActor | null; members: OwnerPerson[] }
}) {
  // Během úpravy vlastníka se karta nesmí dát táhnout (výběr by se trhal).
  const [ownerEditing, setOwnerEditing] = useState(false)
  const overdue = !!deal.next_step_due && deal.next_step_due < today
  const violations = checkDealInvariant(deal)
  const missingStep = violations.includes('missing_next_step')
  const missingOwner = violations.includes('missing_owner')
  const probability = deal.probability_pct ?? 0
  const ownerName = deal.owner ? formatPersonName(deal.owner.full_name, deal.owner.email) : null
  const isOpen = DEAL_STAGES.find((item) => item.key === deal.stage)?.open ?? false
  const formId = `krok-${deal.id}`
  return (
    <article
      draggable={!saving && !editing && !ownerEditing}
      aria-busy={saving}
      onDragStart={(event) => {
        onDragStart()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(deal.id))
      }}
      onDragEnd={onDragEnd}
      className={`flex min-w-0 flex-col gap-2 rounded-tile border border-[color:var(--c-line)] bg-surface p-3.5 shadow-card transition-shadow duration-fast hover:shadow-card-hover ${saving ? 'opacity-60' : 'md:cursor-grab md:active:cursor-grabbing'}`}
    >
      <div className="flex items-center gap-2">
        <DealsCompanyLogo name={deal.account?.name ?? deal.title} />
        {deal.account
          ? <Link href={`/cockpit/clients/${deal.account.id}`} className="min-w-0 flex-1 truncate text-headline text-ink no-underline hover:underline">{deal.account.name}</Link>
          : <span className="min-w-0 flex-1 truncate text-headline">Bez klienta</span>}
        <span aria-hidden="true" className="hidden select-none text-callout text-muted md:block">⠿</span>
      </div>
      <Link href={`/cockpit/clients/${deal.account_id}/deals/${deal.id}`} className="text-callout font-semibold leading-snug text-ink">
        {deal.title}
      </Link>
      {(deal.deal_kind !== undefined || missingOwner) && (
        <div className="flex flex-wrap gap-1">
          {deal.deal_kind ? (
            <span className="rounded-full bg-[color:var(--c-info-soft)] px-2 py-0.5 text-[11px] font-bold text-ink">
              {dealKindLabel(deal.deal_kind)}
            </span>
          ) : deal.deal_kind === null && (
            <span className="rounded-full border border-dashed border-[color:var(--c-field-line)] px-2 py-0.5 text-[11px] text-muted" title="Workshop, implementace, provoz, nebo jiné?">
              Doplnit typ
            </span>
          )}
          {missingOwner && (
            <span className="rounded-full bg-[color:var(--c-neg-soft)] px-2 py-0.5 text-[11px] font-bold text-neg">Bez vlastníka</span>
          )}
        </div>
      )}
      <div className="font-heading text-title2 font-bold tabular-nums">{formatCzk(deal.amount_one_time)}</div>
      <div className="flex items-center gap-2 text-footnote font-semibold text-muted">
        {ownerName && <span title={ownerName}><Avatar name={ownerName} size={24} /></span>}
        {deal.last_activity_at && (
          <span className="inline-flex items-center gap-1" title="Poslední aktivita">
            <DealsIcon name="calendar" size={13} />{shortDate(deal.last_activity_at)}
          </span>
        )}
        <span className="grow" />
        <b className="text-callout tabular-nums text-ink">{probability} %</b>
      </div>
      <DealsBar pct={probability} color="var(--d-orange)" label={`Šance na výhru ${probability} %`} thin />

      {ownerContext && isOpen && (
        <OwnerChange
          kind="obchody"
          itemId={deal.id}
          itemLabel={deal.title}
          owner={{ id: deal.owner_id ?? null, name: ownerName }}
          members={ownerContext.members}
          canChange={canChangeOwner('obchody', ownerContext.actor, { ownerId: deal.owner_id ?? null })}
          onOpenChange={setOwnerEditing}
          className="self-start"
        />
      )}

      {editing ? (
        <form id={formId} onSubmit={onSaveNextStep} className="space-y-2 rounded-btn border border-[color:var(--c-line)] p-2.5">
          <input name="next_step" defaultValue={deal.next_step ?? ''} placeholder="Co se má stát?" aria-label={`Další krok – ${deal.title}`} required autoFocus className="text-callout" />
          <input name="next_step_due" type="date" defaultValue={deal.next_step_due ?? tomorrow()} aria-label={`Termín dalšího kroku – ${deal.title}`} required className="text-callout" />
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className={buttonClass('secondary', 'sm', 'flex-1')}>Uložit krok</button>
            <button type="button" onClick={() => onEdit(false)} className={buttonClass('quiet', 'sm')}>Zrušit</button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => onEdit(true)}
          disabled={saving}
          aria-label={deal.next_step ? `Upravit další krok – ${deal.title}` : `Přidat další krok – ${deal.title}`}
          className={`group w-full rounded-btn px-3 py-2 text-left text-footnote transition-colors duration-fast ${
            deal.next_step
              ? overdue ? 'bg-[color:var(--c-neg-soft)] text-neg' : 'bg-[color:var(--c-soft)] text-ink hover:bg-[color:var(--c-line-2)]'
              : missingStep ? 'border border-dashed border-[color:var(--c-neg)] text-neg' : 'border border-dashed border-[color:var(--c-line)] text-muted hover:text-ink'
          }`}
        >
          {deal.next_step ? (
            <>
              <span className="block font-semibold">{deal.next_step}</span>
              <span className="mt-0.5 block">
                {deal.next_step_due ? `${overdue ? 'Po termínu · ' : ''}${formatDate(deal.next_step_due)}` : 'Bez termínu'}
              </span>
            </>
          ) : missingStep ? (
            <span className="flex items-center gap-1.5 font-bold"><DealsIcon name="flag" size={13} />Chybí další krok<span className="ml-auto font-semibold">Doplnit</span></span>
          ) : (
            <span>{isOpen ? '+ Přidat další krok' : 'Bez dalšího kroku'}</span>
          )}
        </button>
      )}

      <div className="flex items-center gap-2">
        <Link href={`/cockpit/aktivity?account=${deal.account_id}&deal=${deal.id}`} className={buttonClass('outline', 'sm', 'min-w-0 flex-1')}>
          Zapsat aktivitu
        </Link>
        <select
          aria-label={`Fáze obchodu ${deal.title}`}
          className="!w-auto max-w-[140px] !rounded-full text-footnote"
          value={deal.stage}
          disabled={saving}
          onChange={(event) => onStage(event.target.value as DealStage)}
        >
          {DEAL_STAGES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </div>
    </article>
  )
}

function BoardDialog({
  labelId, eyebrow, title, children, onClose, onSubmit, submitLabel, reasonLabel,
}: {
  labelId: string
  eyebrow: string
  title: string
  children: ReactNode
  onClose: () => void
  onSubmit: (reason: string) => void
  submitLabel: string
  /** Když je zadané, dialog chce povinný text (důvod prohry). */
  reasonLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reasonRef = useRef<HTMLSelectElement & HTMLInputElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const [reason, setReason] = useState('')
  useModal(true, ref, onClose, reasonLabel ? reasonRef : submitRef)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:rgba(20,25,34,.55)] p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelId} className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-e3">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (reasonLabel && !lostReasonComplete(reason)) return
            onSubmit(reason.trim())
          }}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="eyebrow m-0">{eyebrow}</p>
              <h2 id={labelId} className="m-0 mt-1 font-heading text-title2 font-bold">{title}</h2>
            </div>
            <button type="button" onClick={onClose} className="-mr-2 -mt-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-xl text-muted hover:bg-[color:var(--c-soft)]" aria-label="Zavřít">×</button>
          </div>
          <p className="m-0 text-callout text-muted">{children}</p>
          {reasonLabel && (
            <div className="mt-3">
              <LostReasonSelect value={reason} onChange={setReason} selectRef={reasonRef} label={reasonLabel} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={buttonClass('quiet')}>Zrušit</button>
            <button
              ref={submitRef}
              type="submit"
              className={buttonClass('primary')}
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
