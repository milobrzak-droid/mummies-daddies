// Čtení pro karty „Nové poptávky" (obrazovka Dnes) a štítek na kartě klienta:
// poptávky, které Cockpit založil sám z e-mailu a člověk je nevrátil, a počet
// návrhů nižší jistoty, které čekají na rozhodnutí. Jen metadata (název firmy,
// časy, další krok) — nic z obsahu zprávy. RLS: jen obchodní role (0081).
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import { AUTO_INTAKE_CAPABILITY } from '@/domain/crm/autoIntake'

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

export type AutoIntakeItem = {
  id: number
  accountId: number
  accountName: string
  /** Kdy Cockpit klienta založil. */
  createdAt: string
  /** Kdy e-mail přišel. */
  occurredAt: string
  nextStep: string | null
  nextStepDue: string | null
}

export type AutoIntakeCard =
  | { state: 'ok'; items: AutoIntakeItem[]; pendingProposals: number }
  | { state: 'missing_migration' }
  | { state: 'error' }

const SELECT =
  'id, account_id, created_at, occurred_at, account:account!auto_intake_account_id_fkey(name), deal:deal!auto_intake_deal_id_fkey(next_step, next_step_due)'

type Raw = {
  id: number; account_id: number | null; created_at: string; occurred_at: string
  account: Joined<{ name: string | null }>; deal: Joined<{ next_step: string | null; next_step_due: string | null }>
}

function toItem(r: Raw): AutoIntakeItem | null {
  if (r.account_id === null) return null
  const deal = one(r.deal)
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: one(r.account)?.name?.trim() || 'firma',
    createdAt: r.created_at,
    occurredAt: r.occurred_at,
    nextStep: deal?.next_step ?? null,
    nextStepDue: deal?.next_step_due ?? null,
  }
}

/** Aktivní automatická založení z posledních `days` dní (výchozí 3) a počet čekajících návrhů. */
export async function getRecentAutoIntakes(now: Date, opts: { days?: number; limit?: number } = {}): Promise<AutoIntakeCard> {
  const since = new Date(now.getTime() - (opts.days ?? 3) * 86_400_000).toISOString()
  try {
    const s = await createClient()
    const [list, pending] = await Promise.all([
      s.from('auto_intake').select(SELECT).eq('status', 'active').not('account_id', 'is', null)
        .gte('created_at', since).order('created_at', { ascending: false }).limit(opts.limit ?? 10),
      s.from('case_proposal').select('id', { count: 'exact', head: true }).eq('capability', AUTO_INTAKE_CAPABILITY).eq('status', 'pending'),
    ])
    if (isMissingRelation(list.error)) return { state: 'missing_migration' }
    if (list.error) throw list.error
    const items = ((list.data ?? []) as unknown as Raw[]).map(toItem).filter((i): i is AutoIntakeItem => i !== null)
    // Návrhy jsou od 0067; bez nich se jen nepočítají.
    const pendingProposals = pending.error ? 0 : (pending.count ?? 0)
    return { state: 'ok', items, pendingProposals }
  } catch (e) {
    logError('autoIntake.recent', e)
    return { state: 'error' }
  }
}

/** Aktivní automatické založení klienta (pro štítek na jeho kartě), nebo null. Nevyhazuje. */
export async function getAutoIntakeForAccount(accountId: number): Promise<AutoIntakeItem | null> {
  try {
    const s = await createClient()
    const { data, error } = await s.from('auto_intake').select(SELECT).eq('status', 'active').eq('account_id', accountId).maybeSingle()
    if (error) {
      if (!isMissingRelation(error)) logError('autoIntake.account', error)
      return null
    }
    return data ? toItem(data as unknown as Raw) : null
  } catch (e) {
    logError('autoIntake.account', e)
    return null
  }
}
