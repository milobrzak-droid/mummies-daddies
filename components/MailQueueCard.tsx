'use client'
import { useActionState } from 'react'
import Link from 'next/link'
import { AccountPicker } from '@/components/AccountPicker'
import { SubmitButton } from '@/components/SubmitButton'
import { Chip } from '@/components/Chip'
import { WorkStatus } from '@/components/WorkUi'
import { OfferProposalReview } from '@/components/OfferProposalReview'
import {
  assignMailContent,
  discardMailContent,
  type MailContentActionResult,
} from '@/domain/crm/actions/mailContent'
import { MAIL_SIGNAL_LABEL, MAIL_WAIT_REASON_TEXT } from '@/domain/crm/mailContentLabels'
import type { QueuedMail } from '@/domain/crm/queries/mailContent'
import { formatDate, formatOfferPrice } from '@/lib/format'
import { safeExternalHref, EXTERNAL_LINK_REL } from '@/core/untrusted'

// Jedna zpráva ze složky „Cockpit", kterou Cockpit nedokázal jistě zařadit.
// Člověk vybere klienta (a případně dodávku) — vznikne NÁVRH k potvrzení —
// nebo zprávu zahodí (smaže se předmět, úryvek a názvy příloh). Úryvek se
// vykresluje jako prostý text (React ho escapuje), nikdy ne jako HTML. Celé
// tělo zprávy Cockpit nemá; odkaz vede na zprávu v Outlooku.
//
// Zpráva s návrhem zakázky (PDF nabídka v příloze, MAIL_OFFER_ATTACHMENT_ENABLED)
// ukazuje klienta a cenu z PDF a formulář ke kontrole a potvrzení (stejný jako
// u ručního importu nabídky). Nic se nezaloží, dokud ho člověk nepotvrdí; cenu
// i klienta jde opravit. PDF v Cockpitu není, doklad je zpráva v Outlooku.

export function MailQueueCard({ mail }: { mail: QueuedMail }) {
  const [assignState, assign] = useActionState<MailContentActionResult | null, FormData>(
    async (previous, formData) => assignMailContent(previous, formData), null,
  )
  const [discardState, discard] = useActionState<MailContentActionResult | null, FormData>(
    async (previous, formData) => discardMailContent(previous, formData), null,
  )
  const error = assignState?.error ?? discardState?.error
  const title = mail.subject ?? 'Zpráva bez předmětu'
  const chooseTarget = mail.accountId !== null && mail.waitReason === 'ambiguous_target'
  const known = mail.accountId !== null
  const offer = mail.offer ?? null

  return (
    <li className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-base">{title}</h3>
        <span className="text-xs text-muted">přijato {formatDate(mail.receivedAt)}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <WorkStatus tone="wait">{offer ? 'Čeká na potvrzení' : 'Čeká na přiřazení'}</WorkStatus>
        {offer && <Chip tone="warn">Návrh zakázky</Chip>}
        {mail.signals.map((s) => <Chip key={s} tone="blue">{MAIL_SIGNAL_LABEL[s]}</Chip>)}
      </div>
      <p className="m-0 mt-2 text-callout text-muted">
        {mail.senderDomain ? `Od domény ${mail.senderDomain}. ` : ''}{MAIL_WAIT_REASON_TEXT[mail.waitReason]}
      </p>

      {offer && (
        <dl className="m-0 mt-3 grid gap-x-6 gap-y-1 rounded-btn bg-[color:var(--c-soft)] px-3 py-2.5 text-sm sm:grid-cols-[auto_1fr]" aria-label="Návrh zakázky z nabídky">
          <dt className="text-muted">Klient</dt>
          <dd className="m-0 font-semibold">{offer.fields.account_name}</dd>
          <dt className="text-muted">Cena bez DPH</dt>
          <dd className="m-0 font-semibold">{formatOfferPrice(offer.fields.amount_one_time, offer.fields.currency)}</dd>
          <dt className="text-muted">Projekt</dt>
          <dd className="m-0">{offer.fields.title}</dd>
        </dl>
      )}

      <blockquote className="mx-0 mb-0 mt-3 border-l-2 border-border pl-3 text-sm">
        <span className="eyebrow block">Úryvek ze zprávy</span>
        <span className="whitespace-pre-wrap">{mail.excerpt}</span>
      </blockquote>
      {mail.attachmentNames.length > 0 && (
        <p className="m-0 mt-2 text-xs text-muted">Přílohy (jen názvy): {mail.attachmentNames.join(', ')}</p>
      )}
      {mail.proposedDate && (
        <p className="m-0 mt-1 text-xs text-muted">Datum z textu: {formatDate(`${mail.proposedDate}T12:00:00Z`)} (ověř ve zprávě)</p>
      )}
      {safeExternalHref(mail.webLink) && (
        <p className="m-0 mt-2 text-sm">
          <a href={safeExternalHref(mail.webLink)!} target="_blank" rel={EXTERNAL_LINK_REL} className="underline underline-offset-2">Otevřít zprávu v Outlooku</a>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 mb-0 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">{error}</p>
      )}

      {offer && <OfferProposalReview as="div" source="mail" fileName={offer.fileName ?? 'nabídka.pdf'} proposal={offer} />}

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
        {!offer && <form action={assign} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="row_id" value={mail.id} />
          {known ? (
            <>
              <input type="hidden" name="account_id" value={mail.accountId ?? ''} />
              <p className="m-0 w-full text-sm">
                Klient: {mail.accountId && mail.accountName
                  ? <Link href={`/cockpit/clients/${mail.accountId}`} className="font-semibold underline underline-offset-2">{mail.accountName}</Link>
                  : <b>{mail.accountName ?? 'firma'}</b>}
              </p>
              {chooseTarget && (
                <div className="w-72 max-w-full">
                  <label htmlFor={`target-${mail.id}`} className="block text-sm text-muted">Dodávka nebo obchod</label>
                  <select id={`target-${mail.id}`} name="target" required defaultValue="">
                    <option value="" disabled>Vyber, kterého se zpráva týká…</option>
                    {mail.targets.map((t) => (
                      <option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
                        {t.kind === 'engagement' ? 'Dodávka' : 'Obchod'}: {t.label}
                      </option>
                    ))}
                    <option value="account">Jen klient, bez konkrétní dodávky</option>
                  </select>
                </div>
              )}
              <SubmitButton pendingLabel="Zakládám návrh…">{chooseTarget ? 'Založit návrh' : 'Zkusit znovu'}</SubmitButton>
            </>
          ) : (
            <>
              <div className="w-72 max-w-full">
                <span className="block text-sm text-muted">Klient</span>
                <AccountPicker name="account_id" required placeholder="Začni psát název nebo IČO…" />
              </div>
              <SubmitButton pendingLabel="Zakládám návrh…">Přiřadit ke klientovi</SubmitButton>
            </>
          )}
        </form>}
        <form action={discard}>
          <input type="hidden" name="row_id" value={mail.id} />
          <button
            type="submit"
            className="rounded-btn border border-border px-4 py-2 text-sm"
            aria-label={`Zahodit zprávu ${title} (${offer ? 'smaže se předmět, úryvek i návrh zakázky' : 'smaže se předmět a úryvek'})`}
          >
            Zahodit
          </button>
        </form>
      </div>
    </li>
  )
}
