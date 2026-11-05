'use client'
import { useActionState } from 'react'
import { setAccountIco } from '@/domain/crm/actions/accounts'
import { SubmitButton } from '@/components/SubmitButton'
import type { AresCompany } from '@/connectors/ares'

// Jeden řádek stránky /clients/doplnit-ico: buď klikni na kandidáta z ARESu,
// nebo zadej IČO ručně (typicky u zahraniční firmy s českou pobočkou).
// Obě cesty vedou do stejné server akce, která si číslo znovu ověří.
export function IcoPicker({
  accountId,
  candidates,
  lookupFailed = false,
  tooMany = false,
}: {
  accountId: number
  candidates: AresCompany[]
  /** ARES teď neodpověděl (timeout, limit) — prázdný seznam pak neznamená „nic nenašel". */
  lookupFailed?: boolean
  /** ARES hledání odmítl — shod je přes 1000; prázdný seznam neznamená „nic nenašel". */
  tooMany?: boolean
}) {
  const [state, formAction] = useActionState(setAccountIco.bind(null, accountId), null)

  return (
    <div className="flex flex-col gap-2">
      {candidates.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {candidates.map((c) => (
            <form key={c.ico} action={formAction}>
              <input type="hidden" name="ico" value={c.ico} />
              <button
                type="submit"
                className="w-full text-left text-sm bg-surface border border-border rounded-btn px-3.5 py-2.5 hover:bg-[color:var(--c-soft)] hover:border-[color:var(--c-slate-2)] min-h-[44px] md:min-h-0"
              >
                <span className="text-ink font-semibold">{c.legalName}</span>
                <span className="text-[color:#39414D]"> · IČO {c.ico} · {[c.city, c.region].filter(Boolean).join(', ') || '—'}</span>
              </button>
            </form>
          ))}
        </div>
      ) : lookupFailed ? (
        // Výpadek nebo limit ARESu není „nic nenašel" — ať člověk nezačne
        // hledat chybu v názvu firmy, když stačí stránku za chvíli obnovit.
        <p className="text-sm text-muted">
          ARES teď neodpověděl. Zkus stránku za chvíli obnovit, nebo zadej IČO ručně.
        </p>
      ) : tooMany ? (
        <p className="text-sm text-muted">
          Tomu názvu odpovídá v ARESu přes tisíc firem. Zadej IČO ručně, nebo název u klienta upřesni.
        </p>
      ) : (
        // Prázdný seznam kandidátů není chyba — ARES je jen český rejstřík,
        // takže u zahraničních firem tu legitimně nic nebude. Řekni to na
        // rovinu, ať to nevypadá jako rozbitá stránka.
        <p className="text-sm text-muted">
          ARES pro tento název nic nenašel. U zahraniční firmy je to očekávané — český rejstřík ji nezná.
        </p>
      )}

      <form action={formAction} className="flex items-center gap-2 flex-wrap">
        <label htmlFor={`ico-${accountId}`} className="sr-only">IČO zadané ručně</label>
        <input
          id={`ico-${accountId}`}
          name="ico"
          aria-label="IČO"
          inputMode="numeric"
          placeholder="Zadat IČO ručně (např. u české pobočky)"
          maxLength={8}
          className="text-sm max-w-[280px] rounded-full !px-4"
        />
        <SubmitButton variant="soft">Uložit</SubmitButton>
      </form>

      {state?.error && <p role="alert" className="text-neg text-sm m-0">{state.error}</p>}
      {state?.success && <p role="status" className="text-pos text-sm m-0"><span className="st done">Uloženo</span></p>}
    </div>
  )
}
