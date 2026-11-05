import { createClient } from '@/lib/supabase/server'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import { dueForOutreach, type OutreachAccount, type OutreachCandidate } from '@/domain/crm/outreach'
import { applyOutreachOptOut } from '@/domain/crm/outreachContacts'
import { loadAccountOptOut } from '@/domain/crm/queries/outreachOptOut'

// Firmy tady jen se sloupci, které dueForOutreach potřebuje — žádný embed
// navíc, ať se dotaz nezpomaluje daty, která fronta k oslovení nepoužije.
type OutreachAccountRow = {
  id: number
  name: string
  last_inbound_at: string | null
  last_outbound_at: string | null
  nudged_on: string | null
  snooze_until: string | null
  notes: string | null
}

export type OutreachQueue = {
  queue: OutreachCandidate[]
  /** Firmy, které by na řadě byly, ale nesouhlasí s oslovením (všichni jejich lidé, nebo poznámka firmy). */
  excludedOptOut: number
}

export async function getOutreachQueue(today = new Date()): Promise<OutreachCandidate[]> {
  return (await getOutreachQueueDetail(today)).queue
}

export async function getOutreachQueueDetail(today = new Date()): Promise<OutreachQueue> {
  const s = await createClient()

  const [{ data: accountRows, error: accountErr }, { data: dealRows, error: dealErr }] = await Promise.all([
    // Firmu, které jsme nikdy nepsali, dueForOutreach stejně přeskočí — do
    // paměti ji netaháme (po importu radaru jde o stovky řádků).
    s.from('account').select('id, name, last_inbound_at, last_outbound_at, nudged_on, snooze_until, notes')
      .not('last_outbound_at', 'is', null),
    // Otevřený obchod = fáze z OPEN_DEAL_STAGES (domain/crm/sales.ts) — stejné
    // pravidlo jako v domain/crm/queries/followUps.ts, ať se pojem „otevřený
    // obchod" nepočítá na dvou místech dvěma různými způsoby.
    s.from('deal').select('account_id').in('stage', OPEN_DEAL_STAGE_FILTER),
  ])

  if (accountErr) throw new Error(`Načtení firem selhalo: ${accountErr.message}`)
  if (dealErr) throw new Error(`Načtení obchodů selhalo: ${dealErr.message}`)

  const accountIdsWithOpenDeal = new Set((dealRows ?? []).map((d) => d.account_id as number))

  const accounts: OutreachAccount[] = ((accountRows ?? []) as OutreachAccountRow[]).map((a) => ({
    id: a.id,
    name: a.name,
    last_inbound_at: a.last_inbound_at,
    last_outbound_at: a.last_outbound_at,
    nudged_on: a.nudged_on,
    snooze_until: a.snooze_until,
    has_open_deal: accountIdsWithOpenDeal.has(a.id),
  }))

  // Čistá logika „kdo je na řadě" žije v domain/crm/outreach.ts a je otestovaná
  // — tady se jen sesbírají data do tvaru, který čeká.
  const due = dueForOutreach(accounts, today)

  // Nesouhlas s oslovením (0087 + poznámka): firma, kde nesouhlasí všichni,
  // se nenabízí; u ostatních se ukáže štítek. Čte se jen pro firmy na řadě.
  const notes = new Map(((accountRows ?? []) as OutreachAccountRow[]).map((a) => [a.id, a.notes ?? null]))
  const optOut = await loadAccountOptOut(s, due.map((c) => c.account_id), notes)
  const { queue, excluded } = applyOutreachOptOut(due, optOut)
  return { queue, excludedOptOut: excluded }
}
