// Předání práce člověka (změna vlastníka, odchod z týmu) — čistá logika bez I/O.
// Revize stavu 29. 9. 2026, „Týmový provoz a zastupitelnost": při odchodu
// nebo změně vlastníka nesmí zůstat osiřelé věci.
//
// Druhy práce drží ručně synchronně funkce transfer_member_work v migraci
// 0093 (nová verze 0088: v_allowed a podmínky „otevřené"); test/member-work.test.ts
// je porovnává. Jednotlivou změnu vlastníka řeší lib/ownerChange.ts. Načtení přehledu je v lib/queries/memberWork.ts, zápis v
// lib/actions/team.ts (transferMemberWork, deactivateParticipant).
//
// Leží v lib/ (ne v domain/), protože ji potřebuje deaktivace člena
// v lib/actions/team.ts a lib/ nesmí importovat domain/.
import { z } from 'zod'

export const WORK_KINDS = [
  { key: 'klienti', label: 'Klienti', role: 'vlastník firmy', forms: ['klient', 'klienti', 'klientů'] },
  { key: 'obchody', label: 'Otevřené obchody', role: 'obchodník', forms: ['obchod', 'obchody', 'obchodů'] },
  { key: 'seznamy', label: 'Cílové seznamy', role: 'vlastník seznamu', forms: ['seznam', 'seznamy', 'seznamů'] },
  { key: 'dodavky', label: 'Dodávky', role: 'vlastník nebo zástupce', forms: ['dodávka', 'dodávky', 'dodávek'] },
  { key: 'milniky', label: 'Milníky', role: 'vlastník nebo zástupce', forms: ['milník', 'milníky', 'milníků'] },
  { key: 'ukoly', label: 'Úkoly', role: 'řešitel', forms: ['úkol', 'úkoly', 'úkolů'] },
  { key: 'pripady', label: 'Případy', role: 'vlastník nebo zástupce', forms: ['případ', 'případy', 'případů'] },
  { key: 'alokace', label: 'Alokace', role: 'běžící a budoucí, i zástup', forms: ['alokace', 'alokace', 'alokací'] },
  { key: 'oblasti', label: 'Vlastnictví oblastí', role: 'vlastník nebo zástupce oblasti', forms: ['oblast', 'oblasti', 'oblastí'] },
] as const

export type WorkKind = (typeof WORK_KINDS)[number]['key']
export const WORK_KIND_KEYS = WORK_KINDS.map((k) => k.key) as unknown as readonly [WorkKind, ...WorkKind[]]

export function isWorkKind(v: unknown): v is WorkKind {
  return typeof v === 'string' && WORK_KINDS.some((k) => k.key === v)
}

function plural(n: number, [one, few, many]: readonly [string, string, string]): string {
  const abs = Math.abs(n)
  return abs === 1 ? one : abs >= 2 && abs <= 4 ? few : many
}

/** „3 obchody" */
export function countLabel(kind: WorkKind, n: number): string {
  const k = WORK_KINDS.find((x) => x.key === kind)!
  return `${n} ${plural(n, k.forms)}`
}

// --- Přehled otevřené práce --------------------------------------------------

export type WorkItem = {
  /** Klíč v rámci druhu (id řádku nebo kód oblasti). */
  id: string
  title: string
  href: string | null
  /** V jaké roli tam člověk je (vlastník, zástupce, řešitel, zástup…). */
  role: string
  detail?: string | null
}

export type WorkGroup = {
  kind: WorkKind
  /** 'unavailable' = tabulka/sloupec ještě není (migrace), 'error' = nepodařilo se načíst. */
  state: 'ok' | 'unavailable' | 'error'
  items: WorkItem[]
  /** Názvy skryté (obchody a cílové seznamy bez obchodní role) — vidět je jen počet. */
  hiddenTitles?: boolean
}

export type MemberWork = {
  groups: WorkGroup[]
  total: number
  /** Něco se nepodařilo načíst — počet nemusí být úplný. */
  incomplete: boolean
}

export function buildMemberWork(groups: readonly WorkGroup[]): MemberWork {
  const ordered = WORK_KINDS.map((k) => groups.find((g) => g.kind === k.key) ?? { kind: k.key, state: 'ok' as const, items: [] })
  return {
    groups: ordered,
    total: ordered.reduce((n, g) => n + g.items.length, 0),
    incomplete: ordered.some((g) => g.state === 'error'),
  }
}

/** „2 obchody, 1 úkol" — jen neprázdné druhy, v pořadí WORK_KINDS. */
export function workSummary(counts: Partial<Record<string, number>>): string {
  const parts = WORK_KINDS.filter((k) => (counts[k.key] ?? 0) > 0).map((k) => countLabel(k.key, counts[k.key]!))
  return parts.length === 0 ? 'nic otevřeného' : parts.join(', ')
}

export function workCounts(work: MemberWork): Record<WorkKind, number> {
  return Object.fromEntries(work.groups.map((g) => [g.kind, g.items.length])) as Record<WorkKind, number>
}

// Otevřené = co ještě někdo musí dotáhnout. Stejné podmínky jako 0088.
export const CLOSED_DEAL_STAGES: readonly string[] = ['vyhráno', 'prohráno', 'odloženo']
export const CLOSED_ENGAGEMENT_PHASE = 'uzavreno'
export const CLOSED_MILESTONE_STATUS = 'uzavreno'
export const DONE_TASK_STATUS = 'done'
export const OPEN_CASE_STATUSES: readonly string[] = ['open', 'in_progress', 'waiting']

/** Alokace se počítá, když ještě běží nebo začne (konec chybí nebo je dnes a později). */
export function allocationIsOpen(a: { ends_on: string | null }, today: string): boolean {
  return a.ends_on === null || a.ends_on >= today
}

// --- Předání ------------------------------------------------------------------

export const transferSchema = z.object({
  to_member_id: z.string().uuid('Vyber, komu práci předáváš.'),
  kinds: z.array(z.enum(WORK_KIND_KEYS)).min(1, 'Vyber aspoň jeden druh práce.'),
})
export type TransferInput = z.infer<typeof transferSchema>

export function parseTransferForm(formData: FormData) {
  return transferSchema.safeParse({
    to_member_id: formData.get('to_member_id') ?? '',
    kinds: formData.getAll('kinds').map(String),
  })
}

/** Chyby funkce transfer_member_work (0088, od 0093 i cílové seznamy) česky. */
export const TRANSFER_ERRORS: Readonly<Record<string, string>> = {
  TW001: 'Práci nejde předat témuž člověku.',
  TW002: 'Práci jde předat jen aktivnímu členovi týmu s interní rolí (ne Partnerovi ani deaktivovanému).',
  TW003: 'Předat práci smí jen aktivní správce týmu.',
  TW004: 'Neznámý druh práce.',
}

/** Databáze bez 0093 nezná druh „seznamy" (TW004 z 0088). */
export const TRANSFER_SEZNAMY_PENDING = 'Předání cílových seznamů čeká na migraci 0093. Odškrtni je, nebo migraci nejdřív aplikuj.'

export type TransferCounts = Partial<Record<WorkKind | 'bez_zastupce', number>>

/** Věta do potvrzení po předání. */
export function transferResultMessage(counts: TransferCounts, toName: string): string {
  const moved = workSummary(counts)
  const total = WORK_KINDS.reduce((n, k) => n + (counts[k.key] ?? 0), 0)
  if (total === 0) return `Nebylo co předat — ${toName} nic nepřevzal(a).`
  const freed = counts.bez_zastupce ?? 0
  const tail = freed > 0
    ? ` U ${freed} ${freed === 1 ? 'věci' : 'věcí'} byl(a) ${toName} zároveň zástupcem — zástupce se uvolnil, doplň nového.`
    : ''
  return `Předáno: ${moved} → ${toName}.${tail}`
}

// --- Deaktivace ---------------------------------------------------------------

/** Pole formuláře, kterým správce výslovně potvrdí deaktivaci i s otevřenou prací. */
export const CONFIRM_OPEN_WORK_FIELD = 'confirm_open_work'

/**
 * Smí se člen deaktivovat? Blokuje, dokud má otevřenou práci (nebo ji nešlo
 * spočítat) a správce výslovně nepotvrdil. Vrací hlášku, nebo null = smí.
 */
export function deactivationBlock(work: MemberWork | null, confirmed: boolean): string | null {
  if (confirmed) return null
  if (work === null) {
    return 'Nepodařilo se ověřit, jestli člověk nemá otevřenou práci. Nejdřív ji zkontroluj v „Předat práci“, nebo deaktivaci výslovně potvrď.'
  }
  if (work.total === 0 && !work.incomplete) return null
  const summary = workSummary(workCounts(work))
  return work.total > 0
    ? `Člověk má otevřenou práci (${summary}). Nejdřív ji předej v „Předat práci“, nebo deaktivaci výslovně potvrď — věci pak zůstanou bez vlastníka.`
    : 'Část otevřené práce se nepodařilo načíst. Zkontroluj ji v „Předat práci“, nebo deaktivaci výslovně potvrď.'
}
