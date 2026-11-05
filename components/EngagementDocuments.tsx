'use client'
import { useActionState, useEffect, useRef, useState, useTransition } from 'react'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { useFormStatus } from 'react-dom'
import { WorkNotice, WorkStatus, type WorkStatusTone } from '@/components/WorkUi'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useUndoToast } from '@/components/ui/Toast'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { Chip, toneForKey } from '@/components/Chip'
import {
  createEngagementDocument,
  deleteEngagementDocument,
  reapproveDocument,
  refreshEngagementDocument,
  setDocumentStatus,
  type DocumentActionResult,
} from '@/domain/delivery/actions/documents'
import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABEL,
  DOCUMENT_STATUS_LABEL,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABEL,
  isWatchedStatus,
  type DocumentStatus,
} from '@/domain/delivery/documents'
import { versionName, versionSummary } from '@/domain/delivery/documentWatch'
import type { EngagementDocument } from '@/domain/delivery/queries/documents'
import { EXTERNAL_LINK_REL, safeExternalHref } from '@/core/untrusted'
import { formatDate } from '@/lib/format'

// Milník k navázání dokumentu (plan kap. 8: „vazba na milník").
export type DocumentMilestoneOption = { id: number; title: string }

// Stav dokumentu jako stavová pilulka (barva nese význam, slovo je vždy): koncept
// šedý, schváleno modré (informace), odesláno jantarové (čeká na klienta),
// přijato zelené (docs/PROVOZ.md §4).
const STATUS_TONE: Record<DocumentStatus, WorkStatusTone> = { draft: 'idle', approved: 'info', sent: 'wait', accepted: 'done' }

function RemoveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label="Odebrat dokument"
      className="text-neg text-sm underline disabled:opacity-60"
    >
      {pending ? 'Odebírám…' : 'Odebrat'}
    </button>
  )
}

const dateOf = (iso: string | null) => (iso ? formatDate(iso) : null)

function Callout({ tone, children, actions }: { tone: 'problem' | 'hint'; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div
      role={tone === 'problem' ? 'alert' : 'status'}
      className={`flex flex-wrap items-center justify-between gap-2 rounded-btn px-3 py-2 text-callout text-ink ${
        tone === 'problem' ? 'bg-[color:var(--c-neg-soft)]' : 'bg-[color:var(--c-soft)]'
      }`}
    >
      <span className="min-w-0">{children}</span>
      {actions && <span className="flex flex-wrap items-center gap-2">{actions}</span>}
    </div>
  )
}

function DocumentRow({
  accountId, engagementId, doc, milestoneTitle, metadataEnabled, memberNames,
}: {
  accountId: number
  engagementId: number
  doc: EngagementDocument
  milestoneTitle: string | null
  metadataEnabled: boolean
  memberNames: Record<string, string>
}) {
  const [removeState, removeAction] = useActionState(deleteEngagementDocument.bind(null, accountId, engagementId, doc.id), null)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const toast = useUndoToast()

  // Stránku po akci obnoví server (revalidatePath v akci); tady jen hlášky.
  function run(action: () => Promise<DocumentActionResult>, after?: (r: DocumentActionResult) => void) {
    setMessage(null)
    startTransition(async () => {
      const r = await action()
      if (!r.success) setMessage({ error: true, text: r.error ?? 'Nepodařilo se uložit. Zkus to znovu.' })
      else {
        if (r.notice) setMessage({ error: false, text: r.notice })
        after?.(r)
      }
    })
  }

  const setStatus = (to: DocumentStatus, after?: (r: DocumentActionResult) => void) =>
    run(() => setDocumentStatus(accountId, engagementId, doc.id, to), after)

  const approve = () =>
    setStatus('approved', () =>
      toast.show({
        message: `Dokument „${doc.title.length > 40 ? `${doc.title.slice(0, 39)}…` : doc.title}“ je schválený.`,
        undo: async () => { await setDocumentStatus(accountId, engagementId, doc.id, 'draft') },
      }))

  const href = safeExternalHref(doc.url)
  const watched = isWatchedStatus(doc.status)
  const who = (id: string | null) => (id ? memberNames[id] ?? 'člen týmu' : null)
  const changed = doc.changed_since_approval || doc.findings.includes('changed')
  const missing = doc.source_state === 'missing' || doc.findings.includes('missing')
  const noAccess = doc.source_state === 'no_access' || doc.findings.includes('no_access')
  const unpinned = watched && doc.approved_version_id === null
  const current = { versionLabel: doc.version_label }

  const versionLine = versionSummary({ versionLabel: doc.version_label, modifiedAt: doc.last_modified_at, modifiedBy: doc.last_modified_by })
  const statusBy = who(doc.status_changed_by)
  const statusLine = watched
    ? [`${DOCUMENT_STATUS_LABEL[doc.status]}`, [statusBy, dateOf(doc.status_changed_at)].filter(Boolean).join(', ')].filter(Boolean).join(': ')
    : null
  const approvedLine = watched && doc.approved_at
    ? `Schválil(a) ${who(doc.approved_by) ?? 'člen týmu'} ${dateOf(doc.approved_at)}${doc.approved_version?.version_label ? ` · schválená verze ${doc.approved_version.version_label}` : ''}`
    : null

  const reapprove = () => run(() => reapproveDocument(accountId, engagementId, doc.id))
  const backToDraft = () => setStatus('draft')

  return (
    <li className="flex flex-col gap-2 border-b border-[color:var(--c-line-2)] py-4 last:border-0" aria-busy={pending}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={toneForKey(doc.doc_type)}>{DOCUMENT_TYPE_LABEL[doc.doc_type]}</Chip>
            <WorkStatus tone={STATUS_TONE[doc.status]}>{DOCUMENT_STATUS_LABEL[doc.status]}</WorkStatus>
            {href ? (
              <a href={href} target="_blank" rel={EXTERNAL_LINK_REL} className="font-medium text-ink truncate">
                {doc.title}
              </a>
            ) : (
              <span className="font-medium text-ink truncate">{doc.title}</span>
            )}
          </div>
          <p className="m-0 mt-1 text-footnote text-muted">
            {DOCUMENT_KIND_LABEL[doc.kind]}
            {milestoneTitle ? ` · Milník: ${milestoneTitle}` : ''}
          </p>
          {versionLine && <p className="m-0 text-footnote text-muted">{versionLine}{doc.source_checked_at ? ` · zkontrolováno ${dateOf(doc.source_checked_at)}` : ''}</p>}
          {statusLine && <p className="m-0 text-footnote text-muted">{statusLine}</p>}
          {approvedLine && <p className="m-0 text-footnote text-muted">{approvedLine}</p>}
          <p className="m-0 truncate text-footnote text-muted">{doc.url}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {doc.status === 'draft' && <Button variant="secondary" size="sm" disabled={pending} onClick={approve}>Schválit</Button>}
          {doc.status === 'approved' && (
            <Button variant="secondary" size="sm" disabled={pending || changed} onClick={() => setStatus('sent')}>Označit jako odesláno</Button>
          )}
          {(doc.status === 'approved' || doc.status === 'sent') && (
            <Button variant="quiet" size="sm" disabled={pending} onClick={backToDraft}>Vrátit do konceptu</Button>
          )}
          {metadataEnabled && <Button variant="quiet" size="sm" disabled={pending} onClick={() => run(() => refreshEngagementDocument(accountId, engagementId, doc.id))}>Načíst znovu</Button>}
          <form action={removeAction}>
            <RemoveButton />
          </form>
        </div>
      </div>

      {changed && (
        <Callout
          tone="problem"
          actions={
            <>
              <Button variant="secondary" size="sm" disabled={pending} onClick={reapprove}>Schválit aktuální verzi</Button>
              {doc.status !== 'accepted' && <Button variant="quiet" size="sm" disabled={pending} onClick={backToDraft}>Vrátit do konceptu</Button>}
            </>
          }
        >
          Od schválení se soubor změnil: schválená {versionName({ versionLabel: doc.approved_version?.version_label ?? null })}, teď {versionName(current)}.
          {doc.status === 'sent' ? ' Klientovi mohla odejít jiná verze.' : ''}
          {doc.status === 'accepted' ? ' Klient přijal dřívější verzi.' : ''}
        </Callout>
      )}
      {missing && (
        <Callout tone="problem">
          Soubor ze SharePointu zmizel. Oprav odkaz (odeber dokument a vlož ho znovu) nebo ho odeber.
        </Callout>
      )}
      {noAccess && !missing && (
        <Callout tone="problem">
          Kontrola nemá k souboru přístup: buď byl přístup odebrán, nebo chybí oprávnění Files.Read.All.
        </Callout>
      )}
      {unpinned && !changed && (
        <Callout
          tone="hint"
          actions={metadataEnabled
            ? <Button variant="outline" size="sm" disabled={pending} onClick={reapprove}>Zaznamenat aktuální verzi jako schválenou</Button>
            : undefined}
        >
          Schváleno bez zaznamenané verze, proto se změny souboru nehlídají.
        </Callout>
      )}
      {removeState?.error && <p role="alert" className="m-0 text-neg text-sm">{removeState.error}</p>}
      {message && (
        <p role={message.error ? 'alert' : 'status'} className={`m-0 text-callout ${message.error ? 'text-neg' : 'text-muted'}`}>{message.text}</p>
      )}
    </li>
  )
}

function AddDocumentForm({
  accountId, engagementId, milestones, metadataEnabled,
}: { accountId: number; engagementId: number; milestones: DocumentMilestoneOption[]; metadataEnabled: boolean }) {
  const [state, formAction] = useActionState(createEngagementDocument.bind(null, accountId, engagementId), null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.success) ref.current?.reset()
  }, [state])
  return (
    <form ref={ref} action={formAction} className={`${CARD} ${CARD_PAD} grid gap-3 md:grid-cols-2`}>
      <FormField
        label="Název dokumentu"
        error={state?.fieldErrors?.title}
        hint={metadataEnabled ? 'Nech prázdné a doplní se ze SharePointu.' : undefined}
      >
        <input name="title" required={!metadataEnabled} maxLength={200} className="w-full" />
      </FormField>
      <FormField label="Typ dokumentu" error={state?.fieldErrors?.doc_type}>
        <select name="doc_type" required defaultValue="jine" className="w-full">
          {DOCUMENT_TYPES.map((t) => (
            <option key={t} value={t}>{DOCUMENT_TYPE_LABEL[t]}</option>
          ))}
        </select>
      </FormField>
      <FormField label="K čemu slouží" error={state?.fieldErrors?.kind}>
        <select name="kind" required defaultValue="jine" className="w-full">
          {DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>{DOCUMENT_KIND_LABEL[k]}</option>
          ))}
        </select>
      </FormField>
      {milestones.length > 0 && (
        <FormField label="Milník (nepovinné)" error={state?.fieldErrors?.milestone_id}>
          <select name="milestone_id" defaultValue="" className="w-full">
            <option value="">— bez milníku —</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.title}</option>
            ))}
          </select>
        </FormField>
      )}
      <div className="md:col-span-2">
        <FormField
          label="Odkaz na dokument"
          error={state?.fieldErrors?.url}
          hint="SharePoint, OneDrive nebo soubor v Teams (Kopírovat odkaz). Ukládá se jen odkaz a údaje o souboru (verze, kdo a kdy ho změnil) — obsah zůstává v SharePointu."
        >
          <input name="url" type="url" required placeholder="https://mummiesdaddies.sharepoint.com/…" className="w-full" />
        </FormField>
      </div>
      <div className="md:col-span-2 flex flex-wrap items-center gap-3">
        <SubmitButton>Přidat dokument</SubmitButton>
        {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
        {state?.success && state.notice && <p role="status" className="text-muted text-sm m-0">{state.notice}</p>}
      </div>
    </form>
  )
}

export function EngagementDocuments({
  accountId,
  engagementId,
  milestones = [],
  metadataEnabled = false,
  watchEnabled = false,
  syncProblem = null,
  memberNames = {},
  state,
  documents,
}: {
  accountId: number
  engagementId: number
  milestones?: DocumentMilestoneOption[]
  /** Zapnuté načítání metadat ze SharePointu (GRAPH_FILES_SCOPE_ENABLED). */
  metadataEnabled?: boolean
  /** Zapnutá denní kontrola změn (SHAREPOINT_DOC_SYNC_ENABLED). */
  watchEnabled?: boolean
  /** Poslední chyba denní kontroly (stav konektoru graph_files): chybí oprávnění, token, přístup. */
  syncProblem?: string | null
  /** Jména členů týmu podle id (kdo změnil stav). */
  memberNames?: Record<string, string>
} & (
  | { state: 'missing_migration'; documents?: undefined }
  | { state: 'error'; documents?: undefined }
  | { state: 'ok'; documents: EngagementDocument[] }
)) {
  if (state === 'missing_migration') {
    return (
      <FeaturePending card variant="compact" migration="0051">
        Pak se tu zobrazí odkazy na dokumenty v SharePointu.
      </FeaturePending>
    )
  }
  if (state === 'error') {
    return <WorkNotice title="Dokumenty se nepodařilo načíst">Zkus to prosím později.</WorkNotice>
  }
  const milestoneTitles = new Map(milestones.map((m) => [m.id, m.title]))
  return (
    <div className="flex flex-col gap-4">
      {watchEnabled && syncProblem && (
        <Callout tone="problem">Denní kontrola dokumentů hlásí problém: {syncProblem}</Callout>
      )}
      {documents.length === 0 ? (
        <WorkNotice title="Zatím žádné dokumenty">Odkazy vedou vždy na SharePoint — obsah zůstává tam. Přidáš je formulářem níže.</WorkNotice>
      ) : (
        <ul className={`${CARD} m-0 list-none px-5`}>
          {documents.map((d) => (
            <DocumentRow
              key={d.id}
              accountId={accountId}
              engagementId={engagementId}
              doc={d}
              milestoneTitle={d.milestone_id !== null ? milestoneTitles.get(d.milestone_id) ?? null : null}
              metadataEnabled={metadataEnabled}
              memberNames={memberNames}
            />
          ))}
        </ul>
      )}
      <p className="m-0 text-footnote text-muted">
        {watchEnabled
          ? 'Schválené, odeslané a přijaté dokumenty se denně kontrolují: změna souboru od schválení, zmizení nebo ztráta přístupu vytvoří úkol pro vlastníka dodávky. Cockpit čte jen údaje o souboru, ne jeho obsah.'
          : 'Denní kontrola změn souborů je vypnutá. Verze se zaznamenají při přidání, schválení a načtení znovu.'}
      </p>
      <AddDocumentForm accountId={accountId} engagementId={engagementId} milestones={milestones} metadataEnabled={metadataEnabled} />
    </div>
  )
}
