'use client'
import Link from 'next/link'
import { Fragment, useState, type ReactNode } from 'react'
import { AccountPicker } from '@/components/AccountPicker'
import { Chip } from '@/components/Chip'
import { Button } from '@/components/ui/Button'
import { CheckIcon } from '@/components/ui/Icons'
import { useMediaQuery } from '@/components/ui/useMediaQuery'
import { INJECTION_FLAG_LABELS } from '@/core/untrusted'
import { revenueLineLabel } from '@/lib/domain'
import { DEFAULT_IMPORT_REVENUE_LINE, describeClientMatch, IMPORT_STAGE_LABEL, type ImportMember, type ImportStage } from '@/domain/crm/bulkImport'
import { blockers, stageOptions, type ReviewRow } from '@/domain/crm/bulkImportReview'

// Kontrolní fronta „K potvrzení“ pro oba zdroje (PDF i tabulka). Jedna tabulka,
// jeden řádek = jedna zakázka. Člověk může opravit klienta, název, cenu, měnu
// a stav, otevřít podrobnosti (začátek, termín, vlastník, fakturováno, přijato),
// řádek zamítnout, nebo potvrdit. Nic se nezakládá, dokud nepotvrdí; nového
// klienta zakládá jen výslovné „Založit nového klienta“.
// Pod `md` (telefon) jsou řádky karty pod sebou: všechna pole s viditelným
// popiskem a Potvrdit / Podrobnosti / Zamítnout. Vykresluje se vždy jen jedno
// rozvržení (useMediaQuery), aby pole neměla v DOM dvojí `id`. Obal nemá
// vlastní zaoblenou kartu – sedí přes celou šířku nadřazené karty „K potvrzení“.

const TH = 'eyebrow whitespace-nowrap px-3 py-3 text-left font-medium first:pl-5 last:pr-5'
const TD = 'px-3 py-3 align-top first:pl-5 last:pr-5'

export type RowPatch = Partial<ReviewRow>

export function ImportReviewTable({
  rows, members, meId, busy, onPatch, onConfirm, onReject,
}: {
  rows: ReviewRow[]
  members: ImportMember[]
  meId: string
  busy: boolean
  onPatch: (id: string, patch: RowPatch) => void
  onConfirm: (id: string) => void
  onReject: (id: string) => void
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const wide = useMediaQuery('(min-width: 768px)')
  // Obal přes celou šířku nadřazené karty (Card má p-5 / sm:p-6), jen hrany
  // nahoře a dole – žádná karta v kartě.
  const BLEED = '-mx-5 border-y border-[color:var(--c-line-2)] sm:-mx-6'

  if (!wide) {
    return (
      <ul aria-label="Zakázky k potvrzení" className={`${BLEED} m-0 list-none p-0`}>
        {rows.map((row) => (
          <ReviewRowCard
            key={row.id}
            row={row}
            busy={busy}
            detailsOpen={open.has(row.id)}
            onToggle={() => toggle(row.id)}
            onPatch={(patch) => onPatch(row.id, patch)}
            onConfirm={() => onConfirm(row.id)}
            onReject={() => onReject(row.id)}
            details={<RowDetails row={row} members={members} meId={meId} onPatch={(patch) => onPatch(row.id, patch)} />}
          />
        ))}
      </ul>
    )
  }

  return (
    <div role="region" aria-label="Zakázky k potvrzení" tabIndex={0} className={`${BLEED} overflow-x-auto`}>
      <table aria-label="Zakázky k potvrzení" className="w-full min-w-[980px] text-body">
        <thead>
          <tr className="border-b border-border bg-[color:var(--c-soft)]">
            <th scope="col" className={TH}>Zdroj</th>
            <th scope="col" className={`${TH} min-w-[260px]`}>Klient</th>
            <th scope="col" className={`${TH} min-w-[220px]`}>Zakázka</th>
            <th scope="col" className={`${TH} min-w-[190px]`}>Cena bez DPH</th>
            <th scope="col" className={`${TH} min-w-[170px]`}>Stav</th>
            <th scope="col" className={TH}><span className="sr-only">Akce</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.id}>
              <ReviewRowView
                row={row}
                busy={busy}
                detailsOpen={open.has(row.id)}
                onToggle={() => toggle(row.id)}
                onPatch={(patch) => onPatch(row.id, patch)}
                onConfirm={() => onConfirm(row.id)}
                onReject={() => onReject(row.id)}
              />
              {open.has(row.id) && row.state !== 'done' && row.state !== 'rejected' && (
                <tr className="border-b border-[color:var(--c-line-2)] bg-[color:var(--c-soft)]">
                  <td colSpan={6} className="px-5 py-4">
                    <RowDetails row={row} members={members} meId={meId} onPatch={(patch) => onPatch(row.id, patch)} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReviewRowView({
  row, busy, detailsOpen, onToggle, onPatch, onConfirm, onReject,
}: {
  row: ReviewRow
  busy: boolean
  detailsOpen: boolean
  onToggle: () => void
  onPatch: (patch: RowPatch) => void
  onConfirm: () => void
  onReject: () => void
}) {
  const why = blockers(row)
  const rowBusy = row.state === 'saving'

  if (row.state === 'done') {
    return (
      <tr className="border-b border-[color:var(--c-line-2)]">
        <td className={`${TD} text-muted`}><SourceCell row={row} /></td>
        <td colSpan={5} className={TD}>
          <CheckIcon className="mr-1 inline-block align-[-3px] text-pos" />
          <b className="text-ink">Zapsáno:</b> {row.title}
          {row.message && <span className="block text-footnote text-muted">{row.message}</span>}
          {row.result && (
            <Link href={`/cockpit/clients/${row.result.accountId}?view=business`} className="block text-footnote underline">Otevřít klienta</Link>
          )}
        </td>
      </tr>
    )
  }
  if (row.state === 'rejected') {
    return (
      <tr className="border-b border-[color:var(--c-line-2)] text-muted">
        <td className={TD}><SourceCell row={row} /></td>
        <td colSpan={5} className={TD}>Zamítnuto: {row.title}{row.message && <span className="block text-footnote">{row.message}</span>}</td>
      </tr>
    )
  }

  return (
    <tr className="border-b border-[color:var(--c-line-2)]">
      <td className={`${TD} max-w-[160px]`}><SourceCell row={row} /></td>
      <td className={TD}><ClientCell row={row} onPatch={onPatch} /></td>
      <td className={TD}><TitleField row={row} onPatch={onPatch} /></td>
      <td className={TD}><AmountField row={row} onPatch={onPatch} /></td>
      <td className={TD}><StageField row={row} onPatch={onPatch} /></td>
      <td className={`${TD} text-right`}>
        <div className="flex flex-col items-end gap-2">
          <ConfirmButton row={row} busy={busy} blocked={why.length > 0} onConfirm={onConfirm} />
          <div className="flex gap-1">
            <Button variant="quiet" size="sm" onClick={onToggle} aria-expanded={detailsOpen}>Podrobnosti</Button>
            <Button variant="quiet" size="sm" disabled={busy || rowBusy} onClick={onReject} aria-label={`Zamítnout zakázku ${row.title || row.label}`}>Zamítnout</Button>
          </div>
        </div>
      </td>
    </tr>
  )
}

/** Řádek jako karta (telefon): stejná pole a akce jako v tabulce, popisky viditelně. */
function ReviewRowCard({
  row, busy, detailsOpen, onToggle, onPatch, onConfirm, onReject, details,
}: {
  row: ReviewRow
  busy: boolean
  detailsOpen: boolean
  onToggle: () => void
  onPatch: (patch: RowPatch) => void
  onConfirm: () => void
  onReject: () => void
  details: ReactNode
}) {
  const why = blockers(row)
  const rowBusy = row.state === 'saving'
  const LI = 'border-b border-[color:var(--c-line-2)] px-5 py-4 last:border-0 sm:px-6'

  if (row.state === 'done') {
    return (
      <li className={LI}>
        <SourceCell row={row} />
        <p className="m-0 mt-2">
          <CheckIcon className="mr-1 inline-block align-[-3px] text-pos" />
          <b className="text-ink">Zapsáno:</b> {row.title}
        </p>
        {row.message && <span className="block text-footnote text-muted">{row.message}</span>}
        {row.result && (
          <Link href={`/cockpit/clients/${row.result.accountId}?view=business`} className="mt-1 inline-flex min-h-[44px] items-center text-footnote underline">Otevřít klienta</Link>
        )}
      </li>
    )
  }
  if (row.state === 'rejected') {
    return (
      <li className={`${LI} text-muted`}>
        <SourceCell row={row} />
        <p className="m-0 mt-2">Zamítnuto: {row.title}{row.message && <span className="block text-footnote">{row.message}</span>}</p>
      </li>
    )
  }

  const FIELD = 'block'
  const LABEL = 'eyebrow mb-1 block'
  return (
    <li className={LI}>
      <SourceCell row={row} />
      <div className="mt-4 space-y-4">
        <div className={FIELD}>
          <span className={LABEL}>Klient</span>
          <ClientCell row={row} onPatch={onPatch} />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor={`title-${row.id}`}>Zakázka</label>
          <TitleField row={row} onPatch={onPatch} labelled />
        </div>
        <div className={FIELD}>
          <span className={LABEL}>Cena bez DPH</span>
          <AmountField row={row} onPatch={onPatch} />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor={`stage-${row.id}`}>Stav</label>
          <StageField row={row} onPatch={onPatch} labelled />
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <ConfirmButton row={row} busy={busy} blocked={why.length > 0} onConfirm={onConfirm} size="md" className="w-full" />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="quiet" onClick={onToggle} aria-expanded={detailsOpen}>Podrobnosti</Button>
          <Button variant="quiet" disabled={busy || rowBusy} onClick={onReject} aria-label={`Zamítnout zakázku ${row.title || row.label}`}>Zamítnout</Button>
        </div>
      </div>
      {detailsOpen && <div className="mt-4 rounded-tile bg-[color:var(--c-soft)] p-4">{details}</div>}
    </li>
  )
}

function ConfirmButton({ row, busy, blocked, onConfirm, className, size = 'sm' }: {
  row: ReviewRow; busy: boolean; blocked: boolean; onConfirm: () => void; className?: string; size?: 'sm' | 'md'
}) {
  const rowBusy = row.state === 'saving'
  return (
    <Button
      variant="secondary" size={size} disabled={busy || rowBusy || blocked} onClick={onConfirm}
      aria-label={`Potvrdit zakázku ${row.title || row.label}`}
      className={className}
    >
      {rowBusy ? 'Zapisuji…' : row.state === 'error' ? 'Zkusit znovu' : 'Potvrdit'}
    </Button>
  )
}

/** Název zakázky. `labelled`: popisek je vidět jinde (karta), jinak sr-only (tabulka). */
function TitleField({ row, onPatch, labelled = false }: { row: ReviewRow; onPatch: (patch: RowPatch) => void; labelled?: boolean }) {
  return (
    <>
      {!labelled && <label className="sr-only" htmlFor={`title-${row.id}`}>Název zakázky ({row.label})</label>}
      <input
        id={`title-${row.id}`} value={row.title} maxLength={300} disabled={row.state === 'saving'}
        onChange={(e) => onPatch({ title: e.target.value })}
      />
      {row.revenueLine && row.source === 'csv' && row.revenueLine !== DEFAULT_IMPORT_REVENUE_LINE && (
        <span className="mt-1 block text-footnote text-muted">Typ: {revenueLineLabel(row.revenueLine)}</span>
      )}
    </>
  )
}

function AmountField({ row, onPatch }: { row: ReviewRow; onPatch: (patch: RowPatch) => void }) {
  const rowBusy = row.state === 'saving'
  return (
    <>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`amount-${row.id}`}>Cena ({row.label})</label>
        <input
          id={`amount-${row.id}`} inputMode="decimal" value={row.amount} disabled={rowBusy} className="min-w-0 flex-1 text-right tabular-nums"
          onChange={(e) => onPatch({ amount: e.target.value })}
        />
        <label className="sr-only" htmlFor={`cur-${row.id}`}>Měna ({row.label})</label>
        <select id={`cur-${row.id}`} value={row.currency} disabled={rowBusy} onChange={(e) => onPatch({ currency: e.target.value as 'CZK' | 'EUR' })} className="w-[84px]">
          <option value="CZK">CZK</option>
          <option value="EUR">EUR</option>
        </select>
      </div>
      {row.currency === 'EUR' && <span className="mt-1 block text-footnote text-muted">Přepočte se kurzem ČNB.</span>}
    </>
  )
}

function StageField({ row, onPatch, labelled = false }: { row: ReviewRow; onPatch: (patch: RowPatch) => void; labelled?: boolean }) {
  return (
    <>
      {!labelled && <label className="sr-only" htmlFor={`stage-${row.id}`}>Stav ({row.label})</label>}
      <select id={`stage-${row.id}`} value={row.stage} disabled={row.state === 'saving'} onChange={(e) => onPatch({ stage: e.target.value as ImportStage })}>
        {stageOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {row.stage === 'won' && <span className="mt-1 block text-footnote text-muted">Založí se dodávka, bez úkolů.</span>}
    </>
  )
}

/** Odkud řádek je a co je u něj potřeba vědět dřív, než ho potvrdíš. */
function SourceCell({ row }: { row: ReviewRow }) {
  return (
    <div className="space-y-1.5">
      <div className="break-all text-callout font-semibold text-ink">{row.label}</div>
      <Chip tone={row.source === 'pdf' ? 'warn' : 'neutral'}>{row.source === 'pdf' ? 'Návrh AI' : 'Tabulka'}</Chip>
      {row.state === 'saving' && <div role="status" className="text-footnote text-muted">Zapisuji…</div>}
      {row.state === 'error' && row.message && <div role="alert" className="text-footnote text-neg">{row.message}</div>}
    </div>
  )
}

function ClientCell({ row, onPatch }: { row: ReviewRow; onPatch: (patch: RowPatch) => void }) {
  const [picking, setPicking] = useState(false)
  const why = blockers(row)
  const fromSource = why.filter((w) => row.errors.includes(w) || w === 'Tahle zakázka už je importovaná.')
  const otherWhy = why.filter((w) => !fromSource.includes(w))

  return (
    <div className="space-y-2">
      {row.clientText && <div className="text-footnote text-muted">Ve zdroji: {row.clientText}{row.clientIco ? ` · IČO ${row.clientIco}` : ''}</div>}

      {row.choice.mode === 'existing' && !picking && (
        <div>
          <b className="text-ink">{row.choice.name}</b>
          <div className="text-footnote text-muted">
            {row.match.kind === 'matched' && row.match.accountId === row.choice.id ? describeClientMatch(row.match) : 'Klient vybraný ručně.'}
          </div>
          <Button variant="quiet" size="sm" onClick={() => setPicking(true)} className="-ml-2">Změnit klienta</Button>
        </div>
      )}

      {(row.choice.mode !== 'existing' || picking) && (
        <div className="space-y-2">
          {row.choice.mode === 'unset' && <p className="m-0 text-footnote text-muted">{describeClientMatch(row.match)}</p>}
          {row.match.kind === 'ambiguous' && row.match.candidates.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {row.match.candidates.map((c) => (
                <li key={c.id}>
                  <Button variant="outline" size="sm" onClick={() => { onPatch({ choice: { mode: 'existing', id: c.id, name: c.name } }); setPicking(false) }}>
                    Vybrat: {c.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <AccountPicker
            name={`account-${row.id}`}
            placeholder="Najít klienta podle názvu nebo IČO…"
            onChange={(o) => { if (o) { onPatch({ choice: { mode: 'existing', id: o.id, name: o.name } }); setPicking(false) } }}
          />
          {row.choice.mode !== 'new' ? (
            <Button variant="outline" size="sm" onClick={() => { onPatch({ choice: { mode: 'new' } }); setPicking(false) }}>
              Založit nového klienta
            </Button>
          ) : (
            <div className="space-y-2 rounded-btn border border-border p-2">
              <p className="m-0 text-footnote font-semibold text-ink">Nový klient (založí se po potvrzení řádku)</p>
              <label className="block text-footnote text-muted">Název
                <input value={row.newName} maxLength={200} onChange={(e) => onPatch({ newName: e.target.value })} />
              </label>
              <label className="block text-footnote text-muted">IČO (nepovinné)
                <input value={row.newIco} maxLength={12} inputMode="numeric" onChange={(e) => onPatch({ newIco: e.target.value })} />
              </label>
              <Button variant="quiet" size="sm" onClick={() => onPatch({ choice: { mode: 'unset' } })}>Nezakládat</Button>
            </div>
          )}
        </div>
      )}

      {fromSource.map((w) => <p key={w} role="alert" className="m-0 text-footnote font-semibold text-neg">{w}</p>)}
      {otherWhy.length > 0 && <p className="m-0 text-footnote text-muted">Zbývá: {otherWhy.join(' ')}</p>}
    </div>
  )
}

function RowDetails({ row, members, meId, onPatch }: { row: ReviewRow; members: ImportMember[]; meId: string; onPatch: (patch: RowPatch) => void }) {
  const me = members.find((m) => m.id === meId)
  return (
    <div className="space-y-4">
      {row.flags.length > 0 && (
        <div role="alert" className="rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-callout text-neg">
          <p className="m-0 font-semibold">Dokument obsahuje text, který vypadá jako pokyny pro AI.</p>
          <p className="m-0 mt-1">{row.flags.map((f) => INJECTION_FLAG_LABELS[f]).join('; ')}. Návrh ber jako nespolehlivý a ověř klienta, cenu a stav podle PDF.</p>
        </div>
      )}
      {row.warnings.length > 0 && (
        <p className="m-0 text-callout text-[color:var(--c-warn)]">Zkontroluj: {row.warnings.join('; ')}</p>
      )}
      {row.sameTitleDeal && (
        <label className="flex items-start gap-2 text-callout text-ink">
          <input type="checkbox" checked={row.allowSameTitle} onChange={(e) => onPatch({ allowSameTitle: e.target.checked })} />
          <span>
            U klienta už je zakázka „{row.sameTitleDeal.title}“
            {row.choice.mode === 'existing' && (
              <>{' '}(<Link href={`/cockpit/clients/${row.choice.id}/deals/${row.sameTitleDeal.id}/edit`} className="underline">otevřít</Link>)</>
            )}.
            Zaškrtni, jestli chceš založit i tuhle.
          </span>
        </label>
      )}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-callout font-semibold text-[color:#39414D]">Začátek zakázky
          <input type="date" value={row.startedOn} onChange={(e) => onPatch({ startedOn: e.target.value })} />
        </label>
        <label className="block text-callout font-semibold text-[color:#39414D]">Termín
          <input type="date" value={row.dueOn} onChange={(e) => onPatch({ dueOn: e.target.value })} />
        </label>
        <label className="block text-callout font-semibold text-[color:#39414D]">Vlastník
          <select value={row.ownerId} onChange={(e) => onPatch({ ownerId: e.target.value })}>
            <option value="">Já{me?.name ? ` (${me.name})` : ''}</option>
            {members.filter((m) => m.id !== meId).map((m) => <option key={m.id} value={m.id}>{m.name ?? m.email}</option>)}
          </select>
        </label>
        {row.stage === 'won' && (
          <>
            <label className="block text-callout font-semibold text-[color:#39414D]">Fakturováno ({row.currency})
              <input inputMode="decimal" value={row.invoiced} onChange={(e) => onPatch({ invoiced: e.target.value })} className="text-right tabular-nums" />
            </label>
            <label className="block text-callout font-semibold text-[color:#39414D]">Přijato ({row.currency})
              <input inputMode="decimal" value={row.received} onChange={(e) => onPatch({ received: e.target.value })} className="text-right tabular-nums" />
            </label>
          </>
        )}
      </div>
      <p className="m-0 text-footnote text-muted">
        Stav: {IMPORT_STAGE_LABEL[row.stage]}.
        {row.stage === 'won'
          ? ' Fakturováno a přijato se zapíše jako návrh finančního záznamu; doklad doplníš v Financích.'
          : ' Fakturováno a přijato jde uvést jen u „Vyhráno a běží“.'}
      </p>
    </div>
  )
}
