'use client'
import { useActionState, useRef, useState, type DragEvent } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { OfferProposalReview } from '@/components/OfferProposalReview'
import { proposeOffersFromPdfs, type ProposedOfferResult } from '@/domain/crm/actions/offers'
import { OFFER_UPLOAD_MAX_BYTES, SERVER_ACTION_BODY_LIMIT_BYTES } from '@/domain/crm/offerProposal'

const MAX_MB = Math.floor(SERVER_ACTION_BODY_LIMIT_BYTES / 1024 / 1024)

type Proposed = Extract<ProposedOfferResult, { success: true }>

// Krok 1 importu: PDF → návrh AI. Samotné založení klienta a obchodu dělá
// až potvrzení v OfferProposalReview (krok 2).
export function ImportOfferForm() {
  const [state, formAction] = useActionState(proposeOffersFromPdfs, null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileNames, setFileNames] = useState<string[]>([])
  // Všechna PDF jdou jedním odesláním a Next tělo nad 4 MB odmítne dřív, než
  // akce poběží — proto se součet hlídá už tady (server ho hlídá taky).
  const [tooBig, setTooBig] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [discarded, setDiscarded] = useState<Set<string>>(() => new Set())

  function syncNames() {
    const files = inputRef.current?.files
    const list = files ? Array.from(files) : []
    setFileNames(list.map((f) => f.name))
    setTooBig(list.reduce((sum, f) => sum + f.size, 0) > OFFER_UPLOAD_MAX_BYTES)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (!inputRef.current) return
    inputRef.current.files = e.dataTransfer.files
    syncNames()
  }

  const generalError = state?.results?.find((r) => !r.success && !r.fileName)
  const failures = state?.results?.filter((r) => !r.success && r.fileName) ?? []
  const proposals = state?.results?.filter((r): r is Proposed => r.success && !discarded.has(r.proposal.proposalId)) ?? []

  return (
    <div className="space-y-6">
      <form
        action={formAction}
        onSubmit={(e) => { if (tooBig) e.preventDefault() }}
        className="space-y-4 max-w-md"
      >
        {generalError && !generalError.success && (
          <p role="alert" className="text-neg text-sm">{generalError.error}</p>
        )}
        {tooBig && (
          <p role="alert" className="text-neg text-sm">
            Soubory mají dohromady víc než {MAX_MB} MB. Nahraj je po menších skupinách.
          </p>
        )}

        <FormField label="PDF nabídky (z Coworku) — jedna nebo víc najednou">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            className={`rounded-[14px] border-2 border-dashed px-4 py-8 text-center text-sm cursor-pointer transition-colors ${
              dragOver ? 'border-[color:var(--c-accent)] bg-[color:var(--c-accent-soft)]' : 'border-border text-muted'
            }`}
          >
            {fileNames.length > 0 ? (
              <div className="space-y-1 text-ink">{fileNames.map((n) => <div key={n}>{n}</div>)}</div>
            ) : (
              <>Přetáhni sem PDF nabídky (i víc najednou), nebo klikni pro výběr</>
            )}
          </div>
          <input
            ref={inputRef}
            name="pdf"
            type="file"
            accept="application/pdf"
            multiple
            required
            onChange={syncNames}
            className="hidden"
          />
        </FormField>

        <SubmitButton variant="coral">Nahrát a připravit návrh</SubmitButton>

        {/* Živá oblast je v DOM trvale, aby čtečka ohlásila chyby, až dorazí. */}
        <div aria-live="polite">
          {failures.length > 0 && (
            <ul aria-label="Chyby nahrání" className="space-y-2 pt-2">
              {failures.map((r) => (
                <li key={r.fileName} className="text-sm border border-border rounded-[10px] p-3">
                  <span aria-hidden="true" className="text-neg">✗</span><span className="sr-only">Chyba:</span> {r.fileName}: {!r.success && r.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>

      {proposals.length > 0 && (
        <section className="max-w-3xl space-y-3">
          <h2 className="m-0 text-title2">Zkontroluj návrh a potvrď</h2>
          <ul className="space-y-4 p-0 list-none">
            {proposals.map((r) => (
              <OfferProposalReview
                key={r.proposal.proposalId}
                fileName={r.fileName}
                proposal={r.proposal}
                onDiscard={() => setDiscarded((prev) => new Set(prev).add(r.proposal.proposalId))}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
