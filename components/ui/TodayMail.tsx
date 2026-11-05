import Link from 'next/link'
import { plural } from '@/domain/crm/today'
import { MAIL_WAIT_REASON_TEXT } from '@/domain/crm/mailContentLabels'
import type { MailContentCard } from '@/domain/crm/queries/mailContent'
import { formatDate, formatOfferPrice } from '@/lib/format'
import { TodayCount, TodayStatus } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'

// Karta „Pošta k zařazení" na obrazovce Dnes: zprávy, které člověk přesunul do
// složky „Cockpit" a Cockpit je nedokázal jistě přiřadit (klient, dodávka), a
// návrhy z pošty, které čekají na potvrzení. Bez zpráv a bez návrhů se karta
// nevykreslí vůbec (nic k hlášení). Nese jen předmět a doménu odesílatele,
// úryvek je až ve frontě. Čistě prezentační server komponenta.

export function hasMailContent(card: MailContentCard): boolean {
  return card.state === 'ok' && (card.queued > 0 || card.pendingProposals > 0)
}

export function TodayMail({ card }: { card: MailContentCard }) {
  if (card.state !== 'ok' || !hasMailContent(card)) return null
  const { queued, items, pendingProposals } = card
  return (
    <Card
      title="Pošta k zařazení"
      sub={queued > 0 ? 'Zprávy ze složky Cockpit, které čekají na tebe' : 'Návrhy ze složky Cockpit čekají na potvrzení'}
      badge={<TodayCount n={queued + pendingProposals} />}
      href={queued > 0 ? '/cockpit/pripady?view=posta' : '/cockpit/pripady?view=navrhy'}
      hrefLabel={queued > 0 ? 'Otevřít poštu k zařazení' : 'Otevřít návrhy'}
    >
      {queued > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((item) => (
            <li key={item.id} className="rounded-tile border border-border p-3.5">
              <span className="block font-heading text-[16px] font-bold leading-tight tracking-tight text-ink">
                {item.subject ?? 'Zpráva bez předmětu'}
              </span>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <TodayStatus tone="wait">{item.offer ? 'čeká na potvrzení' : 'čeká na přiřazení'}</TodayStatus>
              </div>
              {item.offer ? (
                <p className="m-0 mt-2 text-callout text-muted">
                  Návrh zakázky z nabídky v příloze: klient <b className="text-ink">{item.offer.clientName}</b>, cena{' '}
                  <b className="text-ink">{formatOfferPrice(item.offer.amount, item.offer.currency)}</b> bez DPH.
                  Nic není založené, dokud ho nepotvrdíš. Přijato {formatDate(item.receivedAt)}.
                </p>
              ) : (
                <p className="m-0 mt-2 text-callout text-muted">
                  {item.accountName ? `Klient ${item.accountName}. ` : item.senderDomain ? `Od domény ${item.senderDomain}. ` : ''}
                  {MAIL_WAIT_REASON_TEXT[item.waitReason]} Přijato {formatDate(item.receivedAt)}.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {queued > 0 && (
        <p className="m-0 mt-3 text-callout text-muted">
          {queued > items.length
            ? `A dalších ${queued - items.length} ${plural(queued - items.length, 'zpráva', 'zprávy', 'zpráv')}. `
            : ''}
          <Link href="/cockpit/pripady?view=posta" className="font-semibold text-ink underline">
            {queued > items.length ? 'Otevřít frontu' : 'Přiřadit zprávy'}
          </Link>
        </p>
      )}
      {pendingProposals > 0 && (
        <p className={`m-0 text-callout text-muted ${queued > 0 ? 'mt-3' : ''}`}>
          {pendingProposals} {plural(pendingProposals, 'návrh z pošty čeká', 'návrhy z pošty čekají', 'návrhů z pošty čeká')} na tvoje potvrzení.{' '}
          <Link href="/cockpit/pripady?view=navrhy" className="font-semibold text-ink underline">Otevřít návrhy</Link>
        </p>
      )}
    </Card>
  )
}
