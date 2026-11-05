import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, WORK_TABS } from '@/components/SectionTabs'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { COMPANY } from '@/config'
import {
  SHOP_ORDER_ACTION_LABELS, SHOP_ORDER_ERRORS, SHOP_ORDER_FILTER_LABELS, SHOP_ORDER_FILTERS, SHOP_ORDER_STATUS_LABELS,
  SHOP_ORDER_TRANSITIONS, listShopOrders, parseShopOrderFilter, summarizeShopOrders,
  type ShopOrderFilter, type ShopOrderReader, type ShopOrderRow, type ShopOrderStatus,
} from '@/domain/web/shopOrders'
import { formatCzk, formatDate } from '@/lib/format'
import { pragueToday } from '@/lib/pragueDate'
import { createClient } from '@/lib/supabase/server'
import { setShopOrderStatus } from './actions'

export const dynamic = 'force-dynamic'

// Objednávky cheesecaků z e-shopu webu (shop_order, migrace 0102 a 0106).
// Obsluha objednávku potvrdí (je závazná až po potvrzení), připraví
// a předá; stav mění databázová funkce s kontrolou člena týmu a AAL2.
// Seznam je seřazený podle dne předání, nejbližší nahoře.

const STATUS_TONE: Readonly<Record<ShopOrderStatus, string>> = {
  new: 'bg-[color:var(--c-warn-soft)] text-[color:var(--c-ink)]',
  confirmed: 'bg-[color:var(--c-info-soft)] text-[color:var(--c-ink)]',
  ready: 'bg-[color:var(--c-pos-soft)] text-[color:var(--c-ink)]',
  handed_over: 'bg-[color:var(--c-soft)] text-[color:var(--c-slate)]',
  cancelled: 'bg-[color:var(--c-soft)] text-[color:var(--c-slate)]',
}

function zoneLabel(key: string | null): string | null {
  if (!key) return null
  return COMPANY.shop.delivery.zones?.find((z) => z.key === key)?.label ?? key
}

function OrderCard({ o, back, today }: { o: ShopOrderRow; back: string; today: string }) {
  const next = SHOP_ORDER_TRANSITIONS[o.status]
  const isToday = o.fulfilment_date === today
  return (
    <li className={`${CARD} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-footnote text-muted">
            Objednávka č. {o.id} · přijata {formatDate(o.received_at.slice(0, 10))}
          </p>
          <h2 className="m-0 mt-1 text-title2">
            {o.fulfilment === 'delivery' ? 'Doručení' : 'Vyzvednutí'} {formatDate(o.fulfilment_date)}
            {isToday && <span className="ml-2 text-callout font-semibold text-[color:var(--c-accent-text)]">dnes</span>}
          </h2>
        </div>
        <span className={`rounded-full px-3 py-1 text-footnote font-semibold ${STATUS_TONE[o.status]}`}>{SHOP_ORDER_STATUS_LABELS[o.status]}</span>
      </div>

      <ul className="m-0 mt-3 list-none p-0 text-body">
        {o.items.map((it, i) => (
          <li key={i} className="flex flex-wrap justify-between gap-2 border-t border-[color:var(--c-line-2)] py-1.5 first:border-t-0">
            <span>
              {it.quantity}× {it.label}
              {it.inscription && <span className="text-muted"> · nápis „{it.inscription}“</span>}
              {it.mini_flavors?.length ? <span className="text-muted"> · {it.mini_flavors.join(', ')}</span> : null}
            </span>
            <span className="tabular-nums">{formatCzk(it.total_czk)}</span>
          </li>
        ))}
        {o.delivery_czk > 0 && (
          <li className="flex justify-between gap-2 border-t border-[color:var(--c-line-2)] py-1.5">
            <span>Doprava{zoneLabel(o.delivery_zone) ? ` (${zoneLabel(o.delivery_zone)})` : ''}</span>
            <span className="tabular-nums">{formatCzk(o.delivery_czk)}</span>
          </li>
        )}
        <li className="flex justify-between gap-2 border-t border-[color:var(--c-line)] pt-2 font-semibold">
          <span>Celkem vč. DPH{o.payment_method ? ` · ${o.payment_method === 'karta' ? 'kartou' : 'převodem'}` : ''}</span>
          <span className="tabular-nums">{formatCzk(o.total_czk)}</span>
        </li>
      </ul>

      <dl className="m-0 mt-3 grid gap-x-6 gap-y-1 text-callout sm:grid-cols-2">
        <div><dt className="inline text-muted">Zákazník: </dt><dd className="inline">{o.customer_name}{o.company_name ? ` (${o.company_name}${o.ico ? `, IČO ${o.ico}` : ''})` : ''}</dd></div>
        <div><dt className="inline text-muted">Kontakt: </dt><dd className="inline"><a href={`tel:${o.phone.replace(/\s/g, '')}`}>{o.phone}</a> · <a href={`mailto:${o.email}`}>{o.email}</a></dd></div>
        {o.fulfilment === 'delivery' && o.delivery_address && <div className="sm:col-span-2"><dt className="inline text-muted">Adresa: </dt><dd className="inline">{o.delivery_address}</dd></div>}
        {o.dedication && <div className="sm:col-span-2"><dt className="inline text-muted">Nápis: </dt><dd className="inline">{o.dedication}</dd></div>}
        {o.note && <div className="sm:col-span-2"><dt className="inline text-muted">Poznámka: </dt><dd className="inline whitespace-pre-line">{o.note}</dd></div>}
      </dl>

      {next.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {next.map((to) => (
            <form key={to} action={setShopOrderStatus}>
              <input type="hidden" name="order_id" value={o.id} />
              <input type="hidden" name="status" value={to} />
              <input type="hidden" name="expected_status" value={o.status} />
              <input type="hidden" name="back" value={back} />
              <button type="submit" className={`btn btn-sm ${to === next[0] && to !== 'cancelled' && to !== 'new' ? 'btn-primary' : 'btn-secondary'}`}>
                {SHOP_ORDER_ACTION_LABELS[to]}
              </button>
            </form>
          ))}
        </div>
      )}
    </li>
  )
}

export default async function ShopOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ stav?: string | string[]; chyba?: string | string[] }>
}) {
  const sp = await searchParams
  const filter: ShopOrderFilter = parseShopOrderFilter(sp.stav)
  const errorCode = Array.isArray(sp.chyba) ? sp.chyba[0] : sp.chyba
  const errorText = errorCode ? SHOP_ORDER_ERRORS[errorCode] ?? 'Stav se nepodařilo změnit. Zkus to prosím znovu.' : null
  const today = pragueToday()
  const supabase = await createClient()
  const result = await listShopOrders(supabase as unknown as ShopOrderReader, filter)
  const back = `?stav=${filter}`

  const summary = result.state === 'ok' ? summarizeShopOrders(result.rows, today) : null
  const subtitle = summary && (summary.waiting || summary.today)
    ? [summary.waiting ? `${summary.waiting} čeká na potvrzení` : null, summary.today ? `${summary.today} na dnešek` : null].filter(Boolean).join(' · ')
    : 'Objednávky cheesecaků z webu. Objednávka je závazná až po potvrzení.'

  return (
    <>
      <PageHeader title="Objednávky" eyebrow="Práce" subtitle={subtitle} />
      <SectionTabs tabs={WORK_TABS} label="Práce" />

      <nav aria-label="Stav objednávek" className="mb-4">
        <div className="seg">
          {SHOP_ORDER_FILTERS.map((f) => (
            <Link key={f} href={`/cockpit/objednavky?stav=${f}`} className="seg-item" aria-current={f === filter ? 'page' : undefined}>
              {SHOP_ORDER_FILTER_LABELS[f]}
            </Link>
          ))}
        </div>
      </nav>

      {errorText && (
        <p role="alert" className="mb-4 rounded-tile bg-[color:var(--c-neg-soft)] px-4 py-3 text-callout text-ink">{errorText}</p>
      )}

      {result.state === 'error' ? (
        <div className={CARD}>
          <EmptyState title="Objednávky se nepodařilo načíst" action={{ href: `/cockpit/objednavky${back}`, label: 'Zkusit znovu' }}>
            Zkus to prosím za chvíli znovu.
          </EmptyState>
        </div>
      ) : result.rows.length === 0 ? (
        <div className={CARD}>
          <EmptyState title={filter === 'aktivni' ? 'Nic nečeká na vyřízení' : 'Žádné objednávky'} tone={filter === 'aktivni' ? 'calm' : 'neutral'}>
            Nové objednávky z e-shopu na webu se objeví tady.
          </EmptyState>
        </div>
      ) : (
        <>
          <ul className="m-0 grid list-none gap-3 p-0">
            {result.rows.map((o) => <OrderCard key={o.id} o={o} back={back} today={today} />)}
          </ul>
          {result.truncated && <p className="mt-3 text-footnote text-muted">Zobrazeno prvních 200 objednávek.</p>}
        </>
      )}
    </>
  )
}
