'use client'
// Milníky dodávky (kap. 6, migrace 0042): seznam, přidání, úprava (název,
// termín, vlastník, zástupce), přechody stavu podle grafu
// v domain/delivery/milestone.ts a akceptace s dokladem.
// „Odesláno ≠ přijato": do Přijato se jde jen přes formulář akceptace, který
// vyžaduje dokument v SharePointu (vybraný nebo nový). Přijatý milník je
// zamčený — upravit ani smazat ho nejde.
// Milník bez termínu (typicky ty, které po vyhraném obchodu založil Cockpit
// sám, 0080) má výraznou výzvu „Doplnit termín" přímo v řádku.
import { useActionState, useEffect, useRef, useState } from 'react'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { useFormStatus } from 'react-dom'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { WorkChk, WorkStatus, type WorkStatusTone, WorkNotice } from '@/components/WorkUi'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import {
  acceptMilestone,
  createMilestone,
  deleteMilestone,
  setMilestoneDue,
  setMilestoneStatus,
  updateMilestone,
} from '@/domain/delivery/actions/milestones'
import {
  MILESTONE_STATUS_LABEL,
  isMilestoneLocked,
  milestonesWithoutDue,
  missingDueHeadline,
  nextMilestoneStatuses,
  type MilestoneStatus,
} from '@/domain/delivery/milestone'
import type { EngagementMilestone } from '@/domain/delivery/queries/milestones'
import type { EngagementDocument } from '@/domain/delivery/queries/documents'
import { OwnerChange } from '@/components/OwnerChange'
import { canChangeOwner, type OwnerActor, type OwnerPerson } from '@/lib/ownerChange'
import { createMilestoneInvoiceDraft } from '@/domain/finance/actions/records'
import { CURRENCIES } from '@/domain/finance/records'
import { EXTERNAL_LINK_REL, safeExternalHref } from '@/core/untrusted'
import { formatDate } from '@/lib/format'

type Person = { id: string; full_name: string }

/**
 * Kdo se dívá a koho jde vybrat za vlastníka (lib/queries/ownerChange.ts).
 * S ním se vlastník a zástupce milníku mění tlačítkem „Změnit vlastníka"
 * (audit, „Co se změnilo", Zpět; 0093) a Upravit mění jen název a termín.
 * Bez něj (starší volající) zůstávají výběry v Upravit.
 */
export type MilestoneOwnerContext = { actor: OwnerActor | null; members: OwnerPerson[] }

/**
 * Podklad k fakturaci z přijatého milníku (kap. 10, 0063) — jen obchodní
 * role. 'missing_migration' = tabulka financial_record ještě neexistuje.
 */
export type MilestoneInvoicing =
  | { state: 'hidden' }
  | { state: 'missing_migration' }
  | { state: 'ok'; invoicedMilestoneIds: number[] }
type ContactOption = { id: number; full_name: string }

const STATUS_TONE: Record<MilestoneStatus, WorkStatusTone> = {
  pripraveno: 'idle',
  v_praci: 'info',
  ceka_na_vstup: 'wait',
  ceka_na_schvaleni: 'wait',
  prijato: 'done',
  uzavreno: 'done',
}


function SmallButton({ children, tone = 'ink' }: { children: React.ReactNode; tone?: 'ink' | 'neg' }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className={`text-sm underline disabled:opacity-60 ${tone === 'neg' ? 'text-neg' : 'text-ink'}`}
    >
      {pending ? '…' : children}
    </button>
  )
}

function StatusButton({
  accountId,
  engagementId,
  milestoneId,
  to,
}: {
  accountId: number
  engagementId: number
  milestoneId: number
  to: MilestoneStatus
}) {
  const [state, formAction] = useActionState(
    setMilestoneStatus.bind(null, accountId, engagementId, milestoneId, to),
    null,
  )
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <SmallButton>→ {MILESTONE_STATUS_LABEL[to]}</SmallButton>
      {state?.error && <span role="alert" className="text-neg text-sm">{state.error}</span>}
    </form>
  )
}

function AcceptForm({
  accountId,
  engagementId,
  milestoneId,
  documents,
  contacts,
  today,
}: {
  accountId: number
  engagementId: number
  milestoneId: number
  documents: EngagementDocument[]
  contacts: ContactOption[]
  today: string
}) {
  const [state, formAction] = useActionState(acceptMilestone.bind(null, accountId, engagementId, milestoneId), null)
  const [mode, setMode] = useState<'existing' | 'new'>(documents.length > 0 ? 'existing' : 'new')
  return (
    <form action={formAction} className="mt-3 grid gap-3 md:grid-cols-2 border-t border-[color:var(--c-line-2)] pt-3">
      <p className="md:col-span-2 text-sm text-muted m-0">
        Přijetí zapiš, až ho klient výslovně potvrdí. Dolož ho dokumentem v SharePointu (e-mail s potvrzením,
        podepsaný protokol). Bez data a dokladu milník přijatý není.
      </p>
      <fieldset className="md:col-span-2 flex gap-4 text-sm">
        <legend className="sr-only">Doklad akceptace</legend>
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            name="_mode"
            checked={mode === 'existing'}
            onChange={() => setMode('existing')}
            disabled={documents.length === 0}
          />
          Vybrat dokument dodávky
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="_mode" checked={mode === 'new'} onChange={() => setMode('new')} />
          Přidat nový odkaz
        </label>
      </fieldset>
      {mode === 'existing' ? (
        <div className="md:col-span-2">
          <FormField label="Dokument" error={state?.fieldErrors?.document_id}>
            <select name="document_id" required defaultValue="" className="w-full">
              <option value="" disabled>Vyber dokument…</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </select>
          </FormField>
        </div>
      ) : (
        <>
          <FormField label="Název dokladu" error={state?.fieldErrors?.new_title ?? state?.fieldErrors?.document_id}>
            <input name="new_title" required maxLength={200} className="w-full" />
          </FormField>
          <FormField label="Odkaz na SharePoint" error={state?.fieldErrors?.new_url} hint="https://…sharepoint.com/…">
            <input name="new_url" type="url" required className="w-full" />
          </FormField>
        </>
      )}
      <FormField label="Datum akceptace" error={state?.fieldErrors?.accepted_on}>
        <input name="accepted_on" type="date" required max={today} defaultValue={today} className="w-full" />
      </FormField>
      <FormField label="Kdo za klienta přijal (nepovinné)" error={state?.fieldErrors?.accepted_by_contact_id}>
        <select name="accepted_by_contact_id" defaultValue="" className="w-full">
          <option value="">—</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>{c.full_name}</option>
          ))}
        </select>
      </FormField>
      <div className="md:col-span-2 flex items-center gap-3">
        <SubmitButton>Zapsat přijetí</SubmitButton>
        {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      </div>
    </form>
  )
}

function InvoiceDraftForm({
  accountId,
  engagementId,
  milestoneId,
}: {
  accountId: number
  engagementId: number
  milestoneId: number
}) {
  const [state, formAction] = useActionState(
    createMilestoneInvoiceDraft.bind(null, accountId, engagementId, milestoneId),
    null,
  )
  return (
    <form action={formAction} className="mt-3 grid gap-3 md:grid-cols-3 items-end border-t border-[color:var(--c-line-2)] pt-3">
      <p className="md:col-span-3 text-sm text-muted m-0">
        Vznikne návrh „Vyfakturováno“ navázaný na milník a doklad akceptace. Fakturu vystav v iDokladu, pak ve
        Financích u záznamu klikni Upravit, doplň číslo dokladu a nastav stav Potvrzeno.
      </p>
      <FormField label="Částka k fakturaci" error={state?.fieldErrors?.amount}>
        <input name="amount" required inputMode="decimal" className="w-full" />
      </FormField>
      <FormField label="Měna" error={state?.fieldErrors?.currency}>
        <select name="currency" defaultValue="CZK" className="w-full">
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </FormField>
      <div className="flex items-center gap-3">
        <SubmitButton>Vytvořit podklad k fakturaci</SubmitButton>
      </div>
      {state?.error && <p role="alert" className="md:col-span-3 text-neg text-sm m-0">{state.error}</p>}
    </form>
  )
}

/**
 * Výrazná výzva u milníku bez termínu: vybrat datum a jedním klikem uložit.
 * Bez termínu Cockpit u milníku nepozná, že je po termínu, a časová osa ho
 * táhne jen do dneška.
 */
function DueQuickForm({
  accountId,
  engagementId,
  m,
}: {
  accountId: number
  engagementId: number
  m: EngagementMilestone
}) {
  const [state, formAction] = useActionState(setMilestoneDue.bind(null, accountId, engagementId, m.id), null)
  const inputId = `termin-${m.id}`
  return (
    <form
      action={formAction}
      className="mt-3 flex flex-wrap items-end gap-3 rounded-[14px] bg-[color:var(--c-warn-soft)] px-3.5 py-3"
    >
      <div className="min-w-[12rem] flex-1">
        <p className="m-0 text-sm font-semibold text-[color:var(--c-warn)]">Milník nemá termín</p>
        <p className="m-0 mt-0.5 text-xs text-[color:#3A424E]">
          Doplň datum, do kdy má být hotový. Bez něj Cockpit nepozná, že je milník po termínu.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-semibold text-ink">
          Termín<span className="sr-only"> milníku {m.title}</span>
        </label>
        <input id={inputId} name="due_on" type="date" required className="w-44" />
      </div>
      <SubmitButton>Doplnit termín</SubmitButton>
      {(state?.fieldErrors?.due_on || state?.error) && (
        <p role="alert" className="m-0 basis-full text-neg text-sm">{state?.fieldErrors?.due_on ?? state?.error}</p>
      )}
    </form>
  )
}

/**
 * Úprava milníku: název, termín (a vlastník se zástupcem, dokud je nespravuje
 * OwnerChange). Po uložení se zavře.
 */
function EditMilestoneForm({
  accountId,
  engagementId,
  m,
  members,
  ownerManaged,
  onDone,
}: {
  accountId: number
  engagementId: number
  m: EngagementMilestone
  members: Person[]
  /** Vlastníka a zástupce mění tlačítko „Změnit vlastníka"; formulář je jen přenese beze změny. */
  ownerManaged: boolean
  onDone: () => void
}) {
  const [state, formAction] = useActionState(updateMilestone.bind(null, accountId, engagementId, m.id), null)
  useEffect(() => {
    if (state?.success) onDone()
  }, [state, onDone])
  return (
    <form
      action={formAction}
      aria-label={`Upravit milník ${m.title}`}
      className="mt-3 grid gap-3 md:grid-cols-2 border-t border-[color:var(--c-line-2)] pt-3"
    >
      <div className="md:col-span-2">
        <FormField label="Název milníku" error={state?.fieldErrors?.title}>
          <input name="title" required maxLength={300} defaultValue={m.title} className="w-full" />
        </FormField>
      </div>
      {ownerManaged ? (
        <>
          <input type="hidden" name="owner_id" value={m.owner_id ?? ''} />
          <input type="hidden" name="deputy_id" value={m.deputy_id ?? ''} />
        </>
      ) : (
        <>
          <FormField label="Vlastník" error={state?.fieldErrors?.owner_id}>
            <select name="owner_id" defaultValue={m.owner_id ?? ''} className="w-full">
              <option value="">— nepřiřazen —</option>
              {members.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Zástupce" hint="Jiný člověk než vlastník." error={state?.fieldErrors?.deputy_id}>
            <select name="deputy_id" defaultValue={m.deputy_id ?? ''} className="w-full">
              <option value="">—</option>
              {members.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </select>
          </FormField>
        </>
      )}
      <FormField label="Termín" hint="Prázdné = bez termínu." error={state?.fieldErrors?.due_on}>
        <input name="due_on" type="date" defaultValue={m.due_on ?? ''} className="w-full" />
      </FormField>
      <div className="md:col-span-2 flex flex-wrap items-center gap-3">
        <SubmitButton>Uložit změny</SubmitButton>
        <button type="button" className="text-sm underline text-ink" onClick={onDone}>Zrušit</button>
        {state?.error && <p role="alert" className="text-neg text-sm m-0">{state.error}</p>}
      </div>
    </form>
  )
}

function MilestoneRow({
  accountId,
  engagementId,
  m,
  people,
  members,
  documents,
  contacts,
  today,
  invoicing,
  ownerContext,
  acceptedVersion,
}: {
  accountId: number
  engagementId: number
  invoicing: MilestoneInvoicing
  ownerContext?: MilestoneOwnerContext
  /** Číslo verze dokumentu, kterou klient přijal (0094); undefined = milník verzi nenese. */
  acceptedVersion?: string | null
  m: EngagementMilestone
  people: Map<string, string>
  members: Person[]
  documents: EngagementDocument[]
  contacts: ContactOption[]
  today: string
}) {
  const [showAccept, setShowAccept] = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [editing, setEditing] = useState(false)
  const [delState, delAction] = useActionState(deleteMilestone.bind(null, accountId, engagementId, m.id), null)
  const next = nextMilestoneStatuses(m.status)
  const canAccept = next.includes('prijato')
  const accepted = isMilestoneLocked(m.status)
  const evidenceDoc = documents.find((d) => d.milestone_id === m.id)
  const invoiced = invoicing.state === 'ok' && invoicing.invoicedMilestoneIds.includes(m.id)
  const overdue = !accepted && m.due_on !== null && m.due_on < today
  return (
    <li id={`milnik-${m.id}`} className="scroll-mt-6 border-b border-[color:var(--c-line)] last:border-0 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <WorkChk done={accepted} label={accepted ? 'Přijato' : 'Zatím nepřijato'} />
            <span className="font-semibold text-ink">{m.title}</span>
            <WorkStatus tone={STATUS_TONE[m.status]}>{MILESTONE_STATUS_LABEL[m.status]}</WorkStatus>
            {overdue && <WorkStatus tone="fail">Po termínu</WorkStatus>}
          </div>
          <p className="text-xs text-muted m-0 mt-1">
            Vlastník: {m.owner_id ? people.get(m.owner_id) ?? '—' : 'nepřiřazen'}
            {' · '}Zástupce: {m.deputy_id ? people.get(m.deputy_id) ?? '—' : '—'}
            {' · '}Termín: {m.due_on ? formatDate(m.due_on) : 'bez termínu'}
            {accepted && m.accepted_at && <> · Přijato {formatDate(m.accepted_at)}</>}
            {accepted && acceptedVersion !== undefined && <> · přijatá {acceptedVersion ? `verze ${acceptedVersion}` : 'konkrétní verze dokumentu'}</>}
            {accepted && evidenceDoc && safeExternalHref(evidenceDoc.url) && (
              <>
                {' · '}
                <a href={safeExternalHref(evidenceDoc.url)!} target="_blank" rel={EXTERNAL_LINK_REL} className="underline">
                  doklad
                </a>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {next
            .filter((to) => to !== 'prijato')
            .map((to) => (
              <StatusButton key={to} accountId={accountId} engagementId={engagementId} milestoneId={m.id} to={to} />
            ))}
          {canAccept && (
            <button type="button" className="text-sm underline text-ink" onClick={() => setShowAccept((v) => !v)}>
              {showAccept ? 'Zavřít' : '→ Přijato (s dokladem)'}
            </button>
          )}
          {accepted && invoicing.state === 'ok' && !invoiced && (
            <button type="button" className="text-sm underline text-ink" onClick={() => setShowInvoice((v) => !v)}>
              {showInvoice ? 'Zavřít' : 'Vytvořit podklad k fakturaci'}
            </button>
          )}
          {accepted && invoiced && <WorkStatus tone="done">Podklad k fakturaci založen</WorkStatus>}
          {accepted && invoicing.state === 'missing_migration' && (
            <FeaturePending variant="inline" migration="0063" title="Podklad k fakturaci se připravuje." className="text-xs text-muted" />
          )}
          {ownerContext && m.status !== 'uzavreno' && (
            <OwnerChange
              kind="milniky"
              itemId={m.id}
              itemLabel={`milník ${m.title}`}
              owner={{ id: m.owner_id, name: m.owner_id ? people.get(m.owner_id) ?? null : null }}
              deputy={{ id: m.deputy_id, name: m.deputy_id ? people.get(m.deputy_id) ?? null : null }}
              members={ownerContext.members}
              canChange={canChangeOwner('milniky', ownerContext.actor, { ownerId: m.owner_id, deputyId: m.deputy_id })}
            />
          )}
          {!accepted && (
            <button
              type="button"
              aria-expanded={editing}
              aria-label={editing ? `Zavřít úpravu milníku ${m.title}` : `Upravit milník ${m.title}`}
              className="text-sm underline text-ink"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? 'Zavřít úpravu' : 'Upravit'}
            </button>
          )}
          {!accepted && (
            <form
              action={delAction}
              onSubmit={(e) => {
                if (!window.confirm(`Smazat milník „${m.title}"? Termín a název změníš přes Upravit, vlastníka přes Změnit vlastníka.`)) e.preventDefault()
              }}
            >
              <SmallButton tone="neg">Smazat</SmallButton>
            </form>
          )}
        </div>
      </div>
      {delState?.error && <p role="alert" className="text-neg text-sm">{delState.error}</p>}
      {!accepted && editing && (
        <EditMilestoneForm
          accountId={accountId}
          engagementId={engagementId}
          m={m}
          members={members}
          ownerManaged={ownerContext !== undefined}
          onDone={() => setEditing(false)}
        />
      )}
      {!accepted && !editing && m.due_on === null && (
        <DueQuickForm accountId={accountId} engagementId={engagementId} m={m} />
      )}
      {accepted && invoicing.state === 'ok' && !invoiced && showInvoice && (
        <InvoiceDraftForm accountId={accountId} engagementId={engagementId} milestoneId={m.id} />
      )}
      {canAccept && showAccept && (
        <AcceptForm
          accountId={accountId}
          engagementId={engagementId}
          milestoneId={m.id}
          documents={documents}
          contacts={contacts}
          today={today}
        />
      )}
    </li>
  )
}

function AddMilestoneForm({
  accountId,
  engagementId,
  members,
}: {
  accountId: number
  engagementId: number
  /** Koho jde vybrat (u nového milníku jen aktivní člen týmu s interní rolí). */
  members: Person[]
}) {
  const [state, formAction] = useActionState(createMilestone.bind(null, accountId, engagementId), null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.success) ref.current?.reset()
  }, [state])
  return (
    <form ref={ref} id="novy-milnik" action={formAction} aria-label="Přidat milník" className={`${CARD} ${CARD_PAD} grid scroll-mt-6 gap-3 md:grid-cols-2`}>
      <h3 className="m-0 font-heading text-title2 font-bold md:col-span-2">Přidat milník</h3>
      <div className="md:col-span-2">
        <FormField label="Název milníku" error={state?.fieldErrors?.title}>
          <input name="title" required maxLength={300} placeholder="např. Procesní mapa" className="w-full" />
        </FormField>
      </div>
      <FormField label="Vlastník" error={state?.fieldErrors?.owner_id}>
        <select name="owner_id" defaultValue="" className="w-full">
          <option value="">—</option>
          {members.map((p) => (
            <option key={p.id} value={p.id}>{p.full_name}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Zástupce" error={state?.fieldErrors?.deputy_id}>
        <select name="deputy_id" defaultValue="" className="w-full">
          <option value="">—</option>
          {members.map((p) => (
            <option key={p.id} value={p.id}>{p.full_name}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Termín" error={state?.fieldErrors?.due_on}>
        <input name="due_on" type="date" className="w-full" />
      </FormField>
      <div className="md:col-span-2 flex items-center gap-3">
        <SubmitButton>Přidat milník</SubmitButton>
        {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      </div>
    </form>
  )
}

export function MilestoneList({
  accountId,
  engagementId,
  state,
  milestones,
  members,
  contacts,
  documents,
  today,
  invoicing = { state: 'hidden' },
  ownerContext,
  acceptedVersions = {},
}: {
  accountId: number
  engagementId: number
  invoicing?: MilestoneInvoicing
  /** Změna vlastníka tlačítkem na řádku milníku (viz MilestoneOwnerContext). */
  ownerContext?: MilestoneOwnerContext
  /** Milník → číslo verze dokumentu, kterou klient přijal (0094). */
  acceptedVersions?: Record<number, string | null>
  /** Všichni členové (i deaktivovaní) — jména stávajících vlastníků. */
  members: Person[]
  contacts: ContactOption[]
  documents: EngagementDocument[]
  today: string
} & (
  | { state: 'missing_migration'; milestones?: undefined }
  | { state: 'error'; milestones?: undefined }
  | { state: 'ok'; milestones: EngagementMilestone[] }
)) {
  if (state === 'missing_migration') {
    return (
      <FeaturePending card variant="compact" migration="0042">
        Pak tu půjde plánovat milníky a zapisovat akceptaci.
      </FeaturePending>
    )
  }
  if (state === 'error') {
    return <WorkNotice title="Milníky se nepodařilo načíst">Zkus to prosím později.</WorkNotice>
  }
  const people = new Map(members.map((p) => [p.id, p.full_name]))
  const withoutDue = milestonesWithoutDue(milestones)
  return (
    <div className="flex flex-col gap-4">
      {withoutDue.length > 0 && (
        <div role="status" className="rounded-card bg-[color:var(--c-warn-soft)] px-5 py-4 text-sm">
          <p className="m-0 font-semibold text-[color:var(--c-warn)]">{missingDueHeadline(withoutDue.length)}</p>
          <p className="m-0 mt-1 text-[color:#3A424E]">
            U každého z nich vyber datum a klikni Doplnit termín. Název a termín změníš přes Upravit, vlastníka a zástupce přes Změnit vlastníka.
          </p>
        </div>
      )}
      {milestones.length === 0 ? (
        <WorkNotice title="Zatím žádné milníky" action={{ href: '#novy-milnik', label: 'Přidat milník' }}>
          Milník uzavírá až potvrzená akceptace klientem — odesláno není přijato.
        </WorkNotice>
      ) : (
        <ul className={`${CARD} m-0 list-none px-5`}>
          {milestones.map((m) => (
            <MilestoneRow
              key={m.id}
              accountId={accountId}
              engagementId={engagementId}
              m={m}
              people={people}
              members={members}
              documents={documents}
              contacts={contacts}
              today={today}
              invoicing={invoicing}
              ownerContext={ownerContext}
              acceptedVersion={acceptedVersions[m.id]}
            />
          ))}
        </ul>
      )}
      <AddMilestoneForm
        accountId={accountId}
        engagementId={engagementId}
        members={ownerContext ? ownerContext.members.map((p) => ({ id: p.id, full_name: p.name })) : members}
      />
    </div>
  )
}
