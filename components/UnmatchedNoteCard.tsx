'use client'
import { useActionState } from 'react'
import { AccountPicker } from '@/components/AccountPicker'
import { SubmitButton } from '@/components/SubmitButton'
import {
  assignMeetingNote,
  discardMeetingNote,
  type MeetingNoteActionResult,
} from '@/domain/crm/actions/meetingIntake'
import { formatDate } from '@/lib/format'

// Jeden zápis z diktátu, který Cockpit nedokázal jistě spárovat na klienta.
// Člověk vybere klienta (Přiřadit) — vznikne aktivita schůzka a případný
// návrh kroků — nebo zápis zahodí (text se smaže). Text zápisu se vykresluje
// jako prostý text (React ho escapuje), nikdy ne jako HTML.

const PREVIEW_CHARS = 400

export type UnmatchedNote = {
  id: number
  title: string | null
  body: string
  client_hint: string | null
  occurred_at: string
  received_at: string
}

export function UnmatchedNoteCard({ note }: { note: UnmatchedNote }) {
  const [assignState, assign] = useActionState<MeetingNoteActionResult | null, FormData>(
    async (previous, formData) => assignMeetingNote(previous, formData), null,
  )
  const [discardState, discard] = useActionState<MeetingNoteActionResult | null, FormData>(
    async (previous, formData) => discardMeetingNote(previous, formData), null,
  )
  const long = note.body.length > PREVIEW_CHARS
  const error = assignState?.error ?? discardState?.error

  return (
    <li className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-base">{note.title ?? 'Zápis bez názvu'}</h3>
        <span className="text-xs text-muted">
          schůzka {formatDate(note.occurred_at)} · přijato {formatDate(note.received_at)}
        </span>
      </div>
      {note.client_hint && (
        <p className="mt-1 mb-0 text-xs text-muted">Nápověda klienta od odesílatele: <b>{note.client_hint}</b> (nenalezena jistě)</p>
      )}

      {long ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer whitespace-pre-wrap">{note.body.slice(0, PREVIEW_CHARS)}…</summary>
          <p className="mt-2 mb-0 whitespace-pre-wrap">{note.body}</p>
        </details>
      ) : (
        <p className="mt-3 mb-0 whitespace-pre-wrap text-sm">{note.body}</p>
      )}

      {error && (
        <p role="alert" className="mt-3 mb-0 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">{error}</p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <form action={assign} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="note_id" value={note.id} />
          <div className="w-72 max-w-full">
            <span className="block text-sm text-muted">Klient</span>
            <AccountPicker name="account_id" required placeholder="Začni psát název nebo IČO…" />
          </div>
          <SubmitButton>Přiřadit ke klientovi</SubmitButton>
        </form>
        <form action={discard}>
          <input type="hidden" name="note_id" value={note.id} />
          <button
            type="submit"
            className="rounded-btn border border-border px-4 py-2 text-sm"
            aria-label={`Zahodit zápis ${note.title ?? note.id} (smaže se jeho text)`}
          >
            Zahodit
          </button>
        </form>
      </div>
    </li>
  )
}
