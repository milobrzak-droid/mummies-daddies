'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Chip } from '@/components/Chip'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { AccountPicker } from '@/components/AccountPicker'
import { buttonClass } from '@/components/ui/Button'
import { CheckIcon } from '@/components/ui/Icons'
import {
  approveConnectorBatchAction, approveConnectorProposalAction, rejectConnectorProposalAction, type ConnectorActionState,
} from '@/domain/crm/actions/connectorProposals'
import {
  PROPOSAL_STAGES, PROPOSAL_STAGE_LABEL, PROPOSAL_WARNING_LABEL, PROPOSE_UPDATE_STAGES, SOURCE_KIND_LABEL,
  isAllowedSourceLink, type ConnectorDraft,
} from '@/domain/crm/connectorProposals'
import { REVENUE_LINES } from '@/domain/crm/offer-extract'
import { INJECTION_FLAG_LABELS, EXTERNAL_LINK_REL, safeExternalHref } from '@/core/untrusted'
import { DEFAULT_REVENUE_LINE, PILLARS, dealStageLabel, isPillar, phasesFor, revenueLineLabel } from '@/lib/domain'
import { formatDate, formatOfferPrice } from '@/lib/format'

// Karta návrhu zakázky z konektoru (Claude) na /rozhodnuti. Nic není založené,
// dokud člověk s rolí vedení/admin nepotvrdí; všechna důležitá pole jde před
// schválením opravit a server je znovu ověří. Text ze zdroje (e-mail, PDF) se
// vykresluje jako prostý text (React ho escapuje) — jsou to data, ne pokyny.

type Props = {
  id: number
  draft: ConnectorDraft
  deal: { id: number; title: string; stage: string; amount_czk: number | null; currency: string | null } | null
  canDecide: boolean
}

const v = (x: string | number | null | undefined) => (x == null ? '' : String(x))

function Done({ state }: { state: Extract<ConnectorActionState, { ok: true }> }) {
  return (
    <div role="status" className="rounded-card border border-border bg-surface p-4 text-sm">
      <CheckIcon className="mr-1 inline-block align-[-3px] text-pos" />
      <b>{state.message}</b>
      {state.warnings && state.warnings.length > 0 && <div className="mt-1 text-xs text-muted">zkontroluj: {state.warnings.join('; ')}</div>}
      {state.accountId && state.dealId && (
        <Link href={`/cockpit/clients/${state.accountId}/deals/${state.dealId}`} className="mt-1 block text-xs underline">Otevřít obchod</Link>
      )}
    </div>
  )
}

function SourceLine({ s }: { s: ConnectorDraft['source'] }) {
  const href = isAllowedSourceLink(s.web_link) ? safeExternalHref(s.web_link) : null
  return (
    <div className="text-footnote text-muted">
      <span className="eyebrow block">Zdroj: {SOURCE_KIND_LABEL[s.kind]}</span>
      <span className="block break-words">
        {s.subject ? <>„{s.subject}“</> : s.label ?? '—'}
        {s.sender ? ` · od ${s.sender}` : ''}
        {s.recipient ? ` · pro ${s.recipient}` : ''}
        {s.date ? ` · ${formatDate(/^\d{4}-\d{2}-\d{2}$/.test(s.date) ? `${s.date}T12:00:00Z` : s.date)}` : ''}
      </span>
      {s.message_id && <span className="block break-all">Outlook messageId (od Claude, neověřené): {s.message_id}</span>}
      {href && <a href={href} target="_blank" rel={EXTERNAL_LINK_REL} className="underline underline-offset-2">Otevřít zdroj v Outlooku / SharePointu</a>}
    </div>
  )
}

function Warnings({ d }: { d: ConnectorDraft }) {
  const list = d.warnings.filter((w) => w !== 'injection')
  return (
    <>
      {d.injection_flags.length > 0 && (
        <div role="alert" className="rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">
          <p className="m-0 font-semibold">Text ze zdroje vypadá, že obsahuje pokyny pro AI.</p>
          <p className="m-0 mt-1">
            {d.injection_flags.map((f) => INJECTION_FLAG_LABELS[f]).join('; ')}. Nic z toho se neprovedlo; ověř klienta, částku a stav
            přímo ve zdroji.
          </p>
        </div>
      )}
      {list.length > 0 && (
        <ul className="m-0 list-disc rounded-btn bg-[color:var(--c-warn-soft)] py-2 pl-7 pr-3 text-xs text-[color:var(--c-warn)]">
          {list.map((w) => <li key={w}>{PROPOSAL_WARNING_LABEL[w]}</li>)}
        </ul>
      )}
    </>
  )
}

function RejectForm({ id, label }: { id: number; label: string }) {
  const [state, action] = useActionState(rejectConnectorProposalAction, null)
  const [open, setOpen] = useState(false)
  if (state?.ok) return <span role="status" className="text-callout font-semibold text-muted">{state.message}</span>
  if (!open) {
    return <button type="button" className={buttonClass('quiet')} onClick={() => setOpen(true)} aria-label={`Zamítnout — ${label}`}>Zamítnout</button>
  }
  return (
    <form action={action} className="flex w-full flex-wrap items-end gap-2 rounded-tile bg-[color:var(--c-neg-soft)] p-3">
      <input type="hidden" name="row_id" value={id} />
      <div className="min-w-0 flex-1 basis-60">
        <FormField label="Důvod zamítnutí (uvidí ho Claude)">
          <input name="note" maxLength={500} placeholder="např. duplicita, není to zakázka" />
        </FormField>
      </div>
      <SubmitButton variant="danger">Ano, zamítnout</SubmitButton>
      <button type="button" className={buttonClass('quiet')} onClick={() => setOpen(false)}>Nechat</button>
      {state && !state.ok && <p role="alert" className="m-0 w-full text-sm text-neg">{state.error}</p>}
    </form>
  )
}

function CreateForm({ id, d, canDecide }: { id: number; d: ConnectorDraft; canDecide: boolean }) {
  const [state, action] = useActionState(approveConnectorProposalAction, null)
  const f = d.fields
  const [pillar, setPillar] = useState<string>(f.pillar ?? '')
  const [phase, setPhase] = useState<string>(f.phase ?? '')
  const [choice, setChoice] = useState<string>(d.account.id != null ? `id:${d.account.id}` : d.account.candidates[0] ? `id:${d.account.candidates[0].id}` : 'new')
  const [mode, setMode] = useState<'create' | 'update'>('create')
  const [target, setTarget] = useState<string>(d.duplicates[0] ? String(d.duplicates[0].deal_id) : '')
  const phases = isPillar(pillar) ? phasesFor(pillar) : []
  if (state?.ok) return <Done state={state} />
  const uncertain = d.account.status !== 'matched'

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="row_id" value={id} />
      <input type="hidden" name="mode" value={mode} />
      {state && !state.ok && <p role="alert" className="m-0 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">{state.error}</p>}

      {uncertain ? (
        <div className="space-y-2 rounded-btn border border-border p-3">
          <p className="m-0 text-sm"><b>Klient z návrhu:</b> {d.account.name}{d.account.ico ? ` (IČO ${d.account.ico})` : ''} — v Cockpitu {d.account.status === 'ambiguous' ? 'víc kandidátů' : 'nenalezen'}.</p>
          <FormField label="Klient">
            <select name="account_choice" value={choice} onChange={(e) => setChoice(e.target.value)}>
              {d.account.candidates.map((c) => <option key={c.id} value={`id:${c.id}`}>{c.name} (id {c.id})</option>)}
              <option value="new">Nový klient (IČO a sídlo z ARES při přesné shodě)</option>
            </select>
          </FormField>
          {choice === 'new' && (
            <FormField label="Název nového klienta">
              <input name="new_account_name" defaultValue={d.account.name} maxLength={200} />
            </FormField>
          )}
          <FormField label="…nebo jiný existující klient" hint="Když vybereš tady, má přednost.">
            <AccountPicker name="account_pick" placeholder="Začni psát název nebo IČO…" />
          </FormField>
        </div>
      ) : (
        <p className="m-0 text-sm">
          <input type="hidden" name="account_choice" value={`id:${d.account.id}`} />
          Klient: <Link href={`/cockpit/clients/${d.account.id}`} className="font-semibold underline underline-offset-2">{d.account.name}</Link>
        </p>
      )}

      {d.duplicates.length > 0 && (
        <fieldset className="m-0 space-y-2 rounded-btn border border-border p-3">
          <legend className="px-1 text-sm font-semibold">Možná duplicita</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="_mode" checked={mode === 'create'} onChange={() => setMode('create')} /> Založit nový obchod
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="_mode" checked={mode === 'update'} onChange={() => setMode('update')} /> Aktualizovat existující:
          </label>
          <select name="target_deal_id" value={target} onChange={(e) => setTarget(e.target.value)} disabled={mode !== 'update'} aria-label="Existující obchod">
            {d.duplicates.map((x) => (
              <option key={x.deal_id} value={x.deal_id}>
                {x.title} · {dealStageLabel(x.stage)} · {x.amount_czk != null ? formatOfferPrice(x.amount_czk, 'CZK') : 'bez ceny'}
                {x.reason === 'same_source' ? ' · stejný zdroj' : ''} (id {x.deal_id})
              </option>
            ))}
          </select>
          {mode === 'update' && (
            <p className="m-0 text-xs text-muted">Do vybraného obchodu se přenese částka, náklad, MD, očekávané uzavření, další krok a stav (jen dopředu). Poznámka se nepřepíše.</p>
          )}
        </fieldset>
      )}

      <FormField label="Název zakázky">
        <input name="title" defaultValue={f.title} maxLength={300} required />
      </FormField>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <FormField label="Stav">
          <select name="stage" defaultValue={f.stage ?? 'nabidka_odeslana'}>
            {PROPOSAL_STAGES.map((s) => <option key={s} value={s}>{PROPOSAL_STAGE_LABEL[s]}</option>)}
          </select>
        </FormField>
        <FormField label="Měna">
          <select name="currency" defaultValue={f.currency}>
            <option value="CZK">CZK</option>
            <option value="EUR">EUR (přepočte se kurzem ČNB)</option>
          </select>
        </FormField>
        <FormField label="Částka bez DPH" hint={f.amount_range ? `Odhad: střed rozpětí ${f.amount_range.min}–${f.amount_range.max}.` : f.amount == null ? 'Cena v návrhu chybí.' : undefined}>
          <input name="amount" type="number" step="any" min={0} defaultValue={v(f.amount)} />
        </FormField>
        <FormField label="Náklad (Kč)">
          <input name="cogs" type="number" step="any" min={0} defaultValue={v(f.cogs)} />
        </FormField>
        <FormField label="Odhad MD">
          <input name="estimate_md" type="number" step="1" min={0} defaultValue={v(f.estimate_md)} />
        </FormField>
        <FormField label="Očekávané uzavření">
          <input name="expected_close" type="date" defaultValue={v(f.expected_close)} />
        </FormField>
        <FormField label="Pilíř">
          <select name="pillar" value={pillar} onChange={(e) => { setPillar(e.target.value); setPhase('') }}>
            <option value="">— nevybráno —</option>
            {PILLARS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </FormField>
        <FormField label="Fáze pilíře">
          <select name="phase" value={phase} onChange={(e) => setPhase(e.target.value)} disabled={phases.length === 0}>
            <option value="">— nevybráno —</option>
            {phases.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </FormField>
        <FormField label="Typ výnosu">
          <select name="revenue_line" defaultValue={f.revenue_line ?? DEFAULT_REVENUE_LINE}>
            {REVENUE_LINES.map((line) => <option key={line} value={line}>{revenueLineLabel(line)}</option>)}
          </select>
        </FormField>
        <FormField label="Další krok">
          <input name="next_step" defaultValue={v(f.next_step)} maxLength={300} />
        </FormField>
        <FormField label="Termín dalšího kroku">
          <input name="next_step_due" type="date" defaultValue={v(f.next_step_due)} />
        </FormField>
      </div>
      <FormField label="Poznámka">
        <textarea name="note" defaultValue={v(f.note)} maxLength={2000} rows={2} />
      </FormField>

      {d.contact && (
        <div className="space-y-1 rounded-btn border border-border p-3">
          <FormField label="Založit i kontakt (stejný člověk u klienta se nezdvojí)" checkbox>
            <input type="checkbox" name="create_contact" defaultChecked />
          </FormField>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField label="Jméno"><input name="contact_full_name" defaultValue={d.contact.full_name} maxLength={200} /></FormField>
            <FormField label="Pozice"><input name="contact_role" defaultValue={v(d.contact.role)} maxLength={200} /></FormField>
            <FormField label="E-mail"><input name="contact_email" type="email" defaultValue={v(d.contact.email)} maxLength={320} /></FormField>
            <FormField label="Telefon"><input name="contact_phone" defaultValue={v(d.contact.phone)} maxLength={50} /></FormField>
          </div>
        </div>
      )}

      {canDecide ? (
        <SubmitButton variant="coral" pendingLabel="Zakládám…">{mode === 'update' ? 'Schválit a aktualizovat obchod' : 'Schválit a založit'}</SubmitButton>
      ) : (
        <p className="m-0 text-xs text-muted">Schválit může jen vedení nebo admin.</p>
      )}
    </form>
  )
}

function UpdateForm({ id, d, deal, canDecide }: Props & { d: ConnectorDraft }) {
  const [state, action] = useActionState(approveConnectorProposalAction, null)
  if (state?.ok) return <Done state={state} />
  const c = d.changes ?? {}
  const field = (key: string, label: string, input: 'number' | 'date' | 'text') =>
    key in c ? (
      <FormField key={key} label={label}>
        <input name={`chg_${key}`} type={input} step={input === 'number' ? 'any' : undefined} defaultValue={v(c[key] as string | number | null)} />
      </FormField>
    ) : null
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="row_id" value={id} />
      <input type="hidden" name="mode" value="update" />
      {state && !state.ok && <p role="alert" className="m-0 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">{state.error}</p>}
      <p className="m-0 text-sm">
        Obchod: <Link href={`/cockpit/clients/${d.account.id}/deals/${d.deal_id}`} className="font-semibold underline underline-offset-2">{deal?.title ?? d.fields.title}</Link>
        {deal && <> · teď {dealStageLabel(deal.stage)} · {deal.amount_czk != null ? formatOfferPrice(deal.amount_czk, 'CZK') : 'bez ceny'}</>}
      </p>
      {d.reason && <p className="m-0 text-sm"><span className="text-muted">Zdůvodnění: </span><span className="whitespace-pre-wrap">{d.reason}</span></p>}
      <div className="grid gap-x-4 sm:grid-cols-2">
        {field('amount', `Nová částka (${d.fields.currency})`, 'number')}
        {field('cogs', 'Nový náklad (Kč)', 'number')}
        {field('estimate_md', 'Odhad MD', 'number')}
        {'stage' in c && (
          <FormField label="Nový stav">
            <select name="chg_stage" defaultValue={v(c.stage as string)}>
              {PROPOSE_UPDATE_STAGES.map((s) => <option key={s} value={s}>{dealStageLabel(s)}</option>)}
            </select>
          </FormField>
        )}
        {field('lost_reason', 'Důvod prohry', 'text')}
        {field('expected_close', 'Očekávané uzavření', 'date')}
        {field('next_step', 'Další krok', 'text')}
        {field('next_step_due', 'Termín dalšího kroku', 'date')}
        {field('note', 'Poznámka (přepíše dosavadní)', 'text')}
        {field('pillar', 'Pilíř', 'text')}
        {field('phase', 'Fáze pilíře', 'text')}
      </div>
      {canDecide ? <SubmitButton variant="coral">Schválit změnu</SubmitButton> : <p className="m-0 text-xs text-muted">Schválit může jen vedení nebo admin.</p>}
    </form>
  )
}

export function ConnectorProposalCard(props: Props) {
  const { id, draft: d, canDecide } = props
  const title = d.mode === 'update' ? `Změna obchodu: ${props.deal?.title ?? d.fields.title}` : d.fields.title
  return (
    <li id={`navrh-${id}`} className="tile tile-sun flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-headline text-ink">{title}</h3>
        <Chip tone="warn">Návrh od Claude{d.proposed_by_name ? ` jménem ${d.proposed_by_name}` : ''}</Chip>
        {d.mode === 'create' && d.fields.stage && <Chip tone="blue">{PROPOSAL_STAGE_LABEL[d.fields.stage]}</Chip>}
        {d.mode === 'create' && <Chip tone="info">{formatOfferPrice(d.fields.amount, d.fields.currency)}{d.fields.amount_range ? ' (odhad)' : ''}</Chip>}
      </div>
      <SourceLine s={d.source} />
      <Warnings d={d} />
      {d.mode === 'update' ? <UpdateForm {...props} d={d} /> : <CreateForm id={id} d={d} canDecide={canDecide} />}
      {canDecide && <div className="flex flex-wrap gap-2 border-t border-border pt-3"><RejectForm id={id} label={title} /></div>}
    </li>
  )
}

export function ConnectorBatchApprove({ batchId, ready, total }: { batchId: string; ready: number; total: number }) {
  const [state, action] = useActionState(approveConnectorBatchAction, null)
  if (state?.ok) return <span role="status" className="text-callout font-semibold text-pos">{state.message}</span>
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="batch_id" value={batchId} />
      <SubmitButton variant="soft" size="sm" pendingLabel="Schvaluji…">{`Schválit vše bez varování (${ready} z ${total})`}</SubmitButton>
      {state && !state.ok && <span role="alert" className="text-sm text-neg">{state.error}</span>}
    </form>
  )
}

