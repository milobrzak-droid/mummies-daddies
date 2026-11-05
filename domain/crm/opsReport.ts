// Provozní přehled firmy na jednom pohledu (pondělí a pátek; P2.2 revize
// 29. 9. 2026 — původní zakladatelská potřeba): nové a změněné obchody,
// dodávky podle milníků, co čeká na nás a co na klienta, Ke schválení,
// riziko termínů a kapacity, neověřené položky a stáří zdrojů.
//
// Čisté funkce bez I/O. Data dodávají EXISTUJÍCÍ dotazy: „Co se změnilo"
// (domain/crm/queries/changes.ts), portfolio dodávek, hlídání čekání na
// klienta, kapacity, Ke schválení, návrhy případů a týdenní přehled
// (digest: follow-upy, firmy k oslovení, blokované obchody, Stav zdrojů).
// domain/crm/queries/opsReport.ts je jen zavolá a předá sem. Zdroj pravdy
// je Cockpit; e-mail (opsReportEmail.ts) je jen doručovací kanál.
//
// ZÁSADA (jako changes.ts): každá položka nese odkaz na záznam (href)
// a označení důkazu (proof). Nic se nedopočítává ani neodhaduje; co v datech
// není, se neukáže. Zdroj, který se nepodařilo načíst, sekce přizná
// (`unavailable`) — prázdná sekce pak neříká „nic", když to nevíme.
//
// OKNO: nové a změněné obchody a posuny milníků za týden Po–Ne (weekWindow
// v changes.ts: v pondělí minulý týden, v pátek tento). Ostatní je stav
// k okamžiku vygenerování.
//
// OPRÁVNĚNÍ: obchodní položky (obchody, follow-upy po termínu, firmy
// k oslovení, blokované obchody, poptávky z e-mailu, zápisy schůzek,
// faktury po splatnosti, rozdíly z iDokladu) jen s canSeeSales — builder je
// bez oprávnění vyřadí, i kdyby je volající předal. Přehled neukazuje žádné
// částky, rozsah nabídky, měření dopadu ani kontakty klientů. Jde totiž i
// e-mailem a ten nesmí nést víc citlivých dat než dřív. Faktura po splatnosti
// (0090) proto nese jen firmu, číslo dokladu a data (splatnost, dny po
// splatnosti), nikdy částku. Sekce „Rozdíly v financích“ (P2.3, iDoklad) nese
// jen druh rozdílu, firmu a číslo dokladu — nikdy částku — a do e-mailu jde
// jen jako počet.

import type { InboxResult } from '@/core/loopQueries'
import type { BlockedDeal, DigestFollowUp, DigestSection } from '@/domain/crm/digest'
import type { OutreachCandidate } from '@/domain/crm/outreach'
import { DISCREPANCY_KIND_LABEL, type DiscrepancyKind } from '@/domain/finance/idoklad'
import { stamp, type ChangeItem, type ChangeKind, type ChangeSection, type ChangeWindow, type WeekChoice } from '@/domain/crm/changes'
import { plural } from '@/domain/crm/today'
import { capacityWarnings, formatHours, weeksFrom, type AllocationLike, type MemberLike } from '@/domain/delivery/capacity'
import { daysText, shortDay, type PortfolioItem, type RiskState } from '@/domain/delivery/portfolio'
import type { PortfolioResult } from '@/domain/delivery/queries/portfolio'
import type { Loaded } from '@/domain/delivery/queries/documents'
import { overdueLabel, waitingAgeLabel, type WaitingItem } from '@/domain/delivery/waiting'
import { daysBetweenPragueDays, pragueDayOf } from '@/lib/pragueDate'

// --- Sekce -------------------------------------------------------------------

export const OPS_SECTION_KEYS = ['obchody', 'dodavky', 'na-nas', 'na-klienta', 'ke-schvaleni', 'riziko', 'neovereno', 'finance-rozdily', 'agent'] as const
/** Klíč sekce je zároveň kotva na stránce (/prehled-tydne#riziko). */
export type OpsSectionKey = (typeof OPS_SECTION_KEYS)[number]

type SectionSpec = {
  key: OpsSectionKey
  title: string
  /** Krátký název do nadpisu přehledu a předmětu e-mailu („Riziko: 2"). */
  short: string
  lead: string
  /** Kde v Cockpitu je celý seznam (odkaz „a dalších N"). */
  path: string
  /** Klidná věta pro prázdnou sekci. */
  calm: string
  salesOnly: boolean
}

export const OPS_SECTIONS: readonly SectionSpec[] = [
  {
    key: 'obchody', title: 'Nové a změněné obchody', short: 'Obchody',
    lead: 'Nové obchody a posuny fáze za týden.',
    path: '/cockpit/pipeline', calm: 'Za týden žádný nový obchod ani posun fáze.', salesOnly: true,
  },
  {
    key: 'dodavky', title: 'Dodávky podle milníků', short: 'Dodávky',
    lead: 'Běžící dodávky: další milník a jeho termín, kolik milníků klient přijal a co se za týden pohnulo.',
    path: '/cockpit/dodavky', calm: 'Žádná běžící dodávka.', salesOnly: false,
  },
  {
    key: 'na-nas', title: 'Čeká na nás', short: 'Čeká na nás',
    lead: 'Naše milníky s termínem do 7 dní, follow-upy obchodů po termínu a firmy k oslovení.',
    path: '/cockpit/dodavky', calm: 'Na nás teď nic nečeká.', salesOnly: false,
  },
  {
    key: 'na-klienta', title: 'Čeká na klienta', short: 'Čeká na klienta',
    lead: 'Milníky, které čekají na podklady nebo na schválení klientem.',
    path: '/cockpit/dodavky?stav=ceka-na-klienta', calm: 'Nic nečeká na klienta.', salesOnly: false,
  },
  {
    key: 'ke-schvaleni', title: 'Ke schválení', short: 'Ke schválení',
    lead: 'Žádosti o schválení a otevřené otázky, které čekají na rozhodnutí.',
    path: '/cockpit/rozhodnuti', calm: 'Nic nečeká na rozhodnutí.', salesOnly: false,
  },
  {
    key: 'riziko', title: 'Riziko termínů a kapacity', short: 'Riziko',
    lead: 'Milníky a dodávky po termínu, blokace, přetížení lidí tento a příští týden, dodávky bez vlastníka a (jen obchodní role) nezaplacené faktury po splatnosti.',
    path: '/cockpit/dodavky?stav=po-terminu', calm: 'Nic není po termínu, nic neblokuje a nikdo není přetížený.', salesOnly: false,
  },
  {
    key: 'neovereno', title: 'Neověřené položky', short: 'Neověřené',
    lead: 'Co vzniklo automaticky a čeká na potvrzení člověkem, a dodávky, o jejichž stavu dlouho nic nevíme.',
    path: '/cockpit/dodavky', calm: 'Nic nečeká na ověření.', salesOnly: false,
  },
  // Jen s napojením na iDoklad (financeDiffs v OpsReportInput) a jen obchodní role.
  {
    key: 'finance-rozdily', title: 'Rozdíly v financích', short: 'Finance',
    lead: 'Faktury a úhrady z iDokladu, které se nepodařilo zapsat jednoznačně, a rozdíly proti záznamům v Cockpitu.',
    path: '/cockpit/finance#rozdily', calm: 'Mezi iDokladem a Cockpitem není žádný rozdíl.', salesOnly: true,
  },
  // Jen se zapnutým modulem agenta (agent v OpsReportInput) a jen obchodní role (P5).
  {
    key: 'agent', title: 'Agent na poptávky', short: 'Agent',
    lead: 'Poptávky, které agent za týden zpracoval, eskalace na obchod, odeslané zprávy a fronta, která čeká na člověka.',
    path: '/cockpit/agent', calm: 'Agent za týden nic nezpracoval a ve frontě nic nečeká.', salesOnly: true,
  },
]

/** Pořadí v nadpisu a předmětu e-mailu: od toho, co hoří. Dodávky jsou stav, ne úkol, v nadpisu nejsou. */
const HEADLINE_ORDER: readonly OpsSectionKey[] = ['riziko', 'ke-schvaleni', 'agent', 'na-nas', 'na-klienta', 'neovereno', 'finance-rozdily', 'obchody']
/** Sekce, které chtějí něčí pozornost (součet = „položek k pozornosti"). */
const ATTENTION_KEYS: readonly OpsSectionKey[] = ['riziko', 'ke-schvaleni', 'agent', 'na-nas', 'na-klienta', 'neovereno', 'finance-rozdily']

/** Naše milníky s termínem do tolika dní jsou „Čeká na nás". */
export const OURS_HORIZON_DAYS = 7
/** Kolik týdnů dopředu (včetně aktuálního) se hlídá přetížení. */
export const CAPACITY_WEEKS = 2
/** Od kolika dní čekání na rozhodnutí se položka zvýrazní. */
export const DECISION_WARN_DAYS = 3

export type OpsTone = 'neg' | 'warn' | 'ok' | 'info'

export type OpsItem = {
  key: string
  title: string
  detail: string
  /** Kam vede odkaz — záznam v Cockpitu (cesta od kořene, bez domény). */
  href: string
  /** Označení důkazu („Milník č. 12, termín 3. 10."). */
  proof: string
  tone: OpsTone
}

export type OpsSection = {
  key: OpsSectionKey
  title: string
  short: string
  lead: string
  path: string
  calm: string
  items: OpsItem[]
  /** Kolik položek sekce celkem má (zdroj může seznam zkrátit). */
  total: number
  /** Zdroje, které se nepodařilo načíst — prázdná sekce pak neříká „nic". */
  unavailable: string[]
}

export type OpsReport = {
  generatedAt: Date
  today: string
  window: ChangeWindow
  week: WeekChoice
  canSeeSales: boolean
  /** Sekce ve stálém pořadí; obchody jen s canSeeSales. */
  sections: OpsSection[]
  /** „Riziko: 2, Ke schválení: 1." nebo „Nic k řešení." */
  headline: string
  /** Kolik položek chce pozornost (riziko, Ke schválení, čeká na nás / na klienta, neověřené). */
  attention: number
  /** Nic k pozornosti ani žádná změna obchodů. */
  isEmpty: boolean
  /** Běžících dodávek (null = portfolio se nenačetlo). */
  activeDeliveries: number | null
  /** Stav zdrojů z týdenního přehledu; null = nenačteno. */
  sources: DigestSection | null
  sourceAlerts: number
  /** Všechno, co se nepodařilo načíst (bez duplicit). */
  unavailable: string[]
}

// --- Vstup -------------------------------------------------------------------

export type OpsCapacityPerson = MemberLike & { full_name: string }

/** Nezaplacená potvrzená faktura po splatnosti (0090). Bez částky: přehled jde i e-mailem. */
export type OpsOverdueInvoice = {
  id: number
  accountId: number
  accountName: string | null
  /** Číslo dokladu z účetnictví (potvrzená faktura ho má vždy). */
  externalRef: string | null
  /** Splatnost YYYY-MM-DD. */
  dueOn: string
  daysLate: number
}

export type OpsReportInput = {
  today: string
  generatedAt: Date
  window: ChangeWindow
  week: WeekChoice
  canSeeSales: boolean
  /** „Co se změnilo" za týden (stačí druhy stage, intake, milestone, delivery); null = nenačteno. */
  changes: { sections: readonly ChangeSection[]; unavailable: readonly ChangeKind[] } | null
  portfolio: PortfolioResult
  waiting: Loaded<{ items: WaitingItem[] }>
  capacity: Loaded<{ members: readonly OpsCapacityPerson[]; allocations: readonly AllocationLike[] }>
  inbox: InboxResult
  /** Návrhy případů čekající na přijetí; null = nejde zjistit. */
  pendingProposals: number | null
  /** Zápisy schůzek čekající na ruční přiřazení; null = nejde zjistit. */
  unmatchedNotes: number | null
  /**
   * Faktury po splatnosti bez záznamu o úhradě (jen obchodní role; builder je
   * bez canSeeSales vyřadí). Chybí (undefined) = nepočítá se, null = nejde zjistit
   * (dotaz selhal nebo čeká na migraci 0090) – sekce Riziko to přizná.
   */
  overdueInvoices?: readonly OpsOverdueInvoice[] | null
  /**
   * Rozdíly z iDokladu (P2.3): jen když je čtení z iDokladu zapnuté. `undefined` =
   * napojení vypnuté, sekce se neukáže; `{ state: 'error' }` = nejde načíst.
   * Bez částek — jen druh rozdílu, firma a číslo dokladu.
   */
  financeDiffs?: { state: 'ok'; items: readonly OpsFinanceDiff[]; total: number } | { state: 'error' }
  /**
   * Agent na poptávky (P5): jen se zapnutým modulem agent. `undefined` = modul
   * vypnutý, sekce se neukáže; `null` = nejde zjistit; `{ state: 'off' }` =
   * tabulky agenta zatím nejsou (sekce řekne, že agent neběží).
   */
  agent?: OpsAgentSummary | { state: 'off' } | null
  /**
   * Týdenní přehled (domain/crm/digest.ts): Stav zdrojů a obchodní seznamy
   * (follow-upy po termínu, firmy k oslovení, blokované obchody). null = nenačteno.
   */
  digest: {
    digest: { sources: DigestSection; sourceAlerts: number }
    source: { followUps: readonly DigestFollowUp[]; outreach: readonly OutreachCandidate[]; blockedDeals: readonly BlockedDeal[] }
  } | null
}

/** Souhrn agenta za týden (počty, bez textů a kontaktů). */
export type OpsAgentSummary = {
  state?: 'ok'
  inquiries: number
  escalations: number
  sent: number
  needsAttention: number
  blocked: number
}

// --- Pomocné -----------------------------------------------------------------

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}
const isDay = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)
const dayText = (d: string | null | undefined) => (isDay(d) ? shortDay(d) : 'bez data')

/** Cesta k obchodu: detail pod klientem, bez klienta tabule (jako e-mail přehledu). */
export function dealPath(dealId: number, accountId: number | null): string {
  return accountId != null ? `/cockpit/clients/${accountId}/deals/${dealId}` : `/cockpit/pipeline?deal=${dealId}`
}

/** „dnes", „zítra", „za 3 dny", „o 2 dny po termínu". */
export function dueWhen(days: number): string {
  if (days === 0) return 'dnes'
  if (days === 1) return 'zítra'
  if (days > 1) return `za ${daysText(days)}`
  return `o ${daysText(-days)} po termínu`
}

function ageText(days: number): string {
  return days <= 0 ? 'od dneška' : daysText(days)
}

const STATE_TONE: Record<RiskState, OpsTone> = { late: 'neg', blocked: 'neg', waiting: 'warn', stale: 'warn', ok: 'ok' }
const OUR_STATUSES = new Set(['pripraveno', 'v_praci'])

const fromChange = (i: ChangeItem, tone: OpsTone, detail = i.detail): OpsItem =>
  ({ key: i.key, title: i.title, detail, href: i.href, proof: i.proof, tone })

const changeItems = (changes: OpsReportInput['changes'], kind: ChangeKind): ChangeItem[] =>
  [...(changes?.sections.find((s) => s.kind === kind)?.items ?? [])]

const changeTotal = (changes: OpsReportInput['changes'], kind: ChangeKind): number =>
  changes?.sections.find((s) => s.kind === kind)?.total ?? 0

const changeFailed = (changes: OpsReportInput['changes'], kind: ChangeKind): boolean =>
  changes === null || changes.unavailable.includes(kind)

// --- Obchody -----------------------------------------------------------------

function dealTone(detail: string): OpsTone {
  if (detail === 'Nový obchod' || /→ Vyhráno$/.test(detail)) return 'ok'
  if (/→ (Prohráno|Odloženo)$/.test(detail)) return 'neg'
  return 'info'
}

/** Nové obchody a posuny fáze za týden (z auditu, přes „Co se změnilo"). */
export function dealItems(stage: readonly ChangeItem[]): OpsItem[] {
  return stage.map((i) => fromChange(i, dealTone(i.detail)))
}

// --- Dodávky podle milníků -----------------------------------------------------

function byNextMilestone(a: PortfolioItem, b: PortfolioItem): number {
  const ad = a.nextMilestone?.dueOn ?? null
  const bd = b.nextMilestone?.dueOn ?? null
  if (ad && bd && ad !== bd) return ad.localeCompare(bd)
  if (ad && !bd) return -1
  if (!ad && bd) return 1
  return b.riskScore - a.riskScore || a.accountName.localeCompare(b.accountName, 'cs') || a.id - b.id
}

/**
 * Každá běžící dodávka: nejzávažnější důvod rizika (když nějaký je), další
 * milník a jeho termín, kolik milníků klient přijal a kolik posunů milníků
 * bylo za týden (změny z „Co se změnilo" spárované podle id dodávky).
 * Řazeno podle termínu dalšího milníku.
 */
export function deliveryItems(portfolio: readonly PortfolioItem[], milestoneMoves: readonly ChangeItem[], newDeliveries: readonly ChangeItem[]): OpsItem[] {
  const moves = new Map<number, ChangeItem[]>()
  for (const c of milestoneMoves) {
    if (c.engagementId === undefined) continue
    moves.set(c.engagementId, [...(moves.get(c.engagementId) ?? []), c])
  }
  const fresh = new Set(newDeliveries.map((c) => c.engagementId).filter((id): id is number => id !== undefined))

  return [...portfolio].sort(byNextMilestone).map((item) => {
    const parts: string[] = []
    // Rizikovou dodávku uvede nejzávažnější důvod (podrobnosti jsou v sekci Riziko).
    if (item.state !== 'ok' && item.reasons[0]) parts.push(item.reasons[0].text)
    const nm = item.nextMilestone
    if (nm) {
      const due = isDay(nm.dueOn) && nm.daysToDue !== null ? `do ${shortDay(nm.dueOn)} (${dueWhen(nm.daysToDue)})` : 'bez termínu'
      parts.push(`Další milník „${nm.title}“ · ${nm.statusLabel} · ${due}`)
    } else {
      parts.push(item.progress.total === 0 ? 'Milníky nejsou zapsané' : 'Všechny milníky přijaté')
    }
    if (item.progress.total > 0) parts.push(`přijato ${item.progress.accepted} z ${item.progress.total}`)
    const own = [...(moves.get(item.id) ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    if (own.length > 0) parts.push(`za týden ${own.length} ${plural(own.length, 'změna milníku', 'změny milníků', 'změn milníků')}`)
    if (fresh.has(item.id)) parts.push('nová dodávka, založená automaticky')

    const proof = own[0]?.proof
      ?? `Dodávka č. ${item.id}, ${item.lastMove.at ? `poslední pohyb ${dayText(item.lastMove.at)}` : 'bez záznamu o pohybu'}`
    return {
      key: `dodavka-${item.id}`,
      title: `${item.accountName} · ${item.title}`,
      detail: parts.join(' · '),
      href: item.milestonesHref,
      proof,
      tone: STATE_TONE[item.state],
    }
  })
}

// --- Čeká na nás ---------------------------------------------------------------

/**
 * Co je na nás: follow-upy obchodů po termínu (jen obchodní role), naše
 * milníky (připraveno / v práci) s termínem do OURS_HORIZON_DAYS dní a jako
 * jeden řádek fronta firem k oslovení. Milníky už po termínu tu nejsou —
 * patří do „Riziko termínů".
 */
export function oursItems(args: {
  portfolio: readonly PortfolioItem[]
  followUps: readonly DigestFollowUp[]
  outreach: readonly OutreachCandidate[]
}): OpsItem[] {
  const out: OpsItem[] = []
  for (const f of args.followUps) {
    out.push({
      key: `followup-${f.deal_id}`,
      title: `${f.account_name?.trim() || 'Bez klienta'} · ${f.title}`,
      detail: `Další krok obchodu je po termínu o ${daysText(f.days_overdue)}${f.level === 'manager' ? ' · eskalováno' : ''}`,
      href: dealPath(f.deal_id, f.account_id),
      proof: `Obchod č. ${f.deal_id}, termín dalšího kroku ${dayText(f.due)}`,
      tone: 'neg',
    })
  }

  const soon: { item: OpsItem; days: number }[] = []
  for (const d of args.portfolio) {
    for (const m of d.openMilestones) {
      if (!OUR_STATUSES.has(m.status) || m.daysToDue === null || !isDay(m.dueOn)) continue
      if (m.daysToDue < 0 || m.daysToDue > OURS_HORIZON_DAYS) continue
      soon.push({
        days: m.daysToDue,
        item: {
          key: `nas-m${m.id}`,
          title: `${d.accountName} · ${m.title}`,
          detail: `${d.title} · ${m.statusLabel} · termín ${shortDay(m.dueOn)} (${dueWhen(m.daysToDue)}) · ${m.ownerName ? `vlastník ${m.ownerName}` : 'bez vlastníka'}`,
          href: d.milestonesHref,
          proof: `Milník č. ${m.id}, termín ${shortDay(m.dueOn)}`,
          tone: m.daysToDue <= 1 ? 'warn' : 'info',
        },
      })
    }
  }
  soon.sort((a, b) => a.days - b.days || a.item.key.localeCompare(b.item.key))
  out.push(...soon.map((s) => s.item))

  if (args.outreach.length > 0) {
    const n = args.outreach.length
    const longest = Math.max(...args.outreach.map((o) => o.days_silent))
    out.push({
      key: 'oslovovani',
      title: 'Firmy k oslovení',
      detail: `${n} ${plural(n, 'firma čeká', 'firmy čekají', 'firem čeká')} na naši další zprávu · nejdéle ${daysText(longest)} bez odpovědi`,
      href: '/cockpit/oslovovani',
      proof: 'Fronta oslovování, stav k dnešku',
      tone: 'info',
    })
  }
  return out
}

// --- Čeká na klienta -----------------------------------------------------------

/** Milníky, které čekají na podklady nebo schválení klientem (bez kontaktů klienta). */
export function clientItems(items: readonly WaitingItem[]): OpsItem[] {
  return items.map((w) => {
    const late = w.daysOverdue !== null
    const bits = [
      w.what.replace(/\.\s*$/, ''),
      waitingAgeLabel(w.daysWaiting),
      late && w.daysOverdue !== null ? overdueLabel(w.daysOverdue) : null,
      w.reminderOpen ? 'připomínka je založená' : null,
    ].filter((b): b is string => !!b)
    return {
      key: `klient-m${w.milestoneId}`,
      title: `${w.accountName} · ${w.title}`,
      detail: bits.join(' · '),
      href: w.href,
      proof: `Milník č. ${w.milestoneId}, čeká od ${stamp(w.since)}`,
      tone: late ? 'neg' : w.signals.includes('quiet') ? 'warn' : 'info',
    }
  })
}

// --- Ke schválení --------------------------------------------------------------

type OkInbox = Extract<InboxResult, { state: 'ok' }>

/** Kolik pražských kalendářních dní uplynulo od okamžiku do dneška (ne 24h bloky). */
function daysSince(iso: string, today: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : Math.max(0, daysBetweenPragueDays(pragueDayOf(iso), today))
}

/**
 * Čekající žádosti o schválení (bez vypršelých — o těch už rozhodnout nejde)
 * a otevřené otázky, nejstarší první. Pro přehled firmy všechny, ne jen ty,
 * o kterých smí rozhodnout ten, kdo se dívá. Stáří v kalendářních dnech.
 */
export function decisionItems(inbox: Pick<OkInbox, 'approvals' | 'decisions'>, today: string): OpsItem[] {
  const rows: { at: string; item: OpsItem }[] = []
  for (const a of inbox.approvals) {
    if (a.expired) continue
    const age = daysSince(a.created_at, today)
    rows.push({
      at: a.created_at,
      item: {
        key: `schvaleni-${a.id}`,
        title: clip(a.case_title?.trim() || 'Žádost o schválení', 120),
        detail: `Žádost o schválení · čeká ${ageText(age)}`,
        href: a.case_id ? `/cockpit/pripady/${a.case_id}` : '/cockpit/rozhodnuti',
        proof: `Žádost o schválení č. ${a.id}, založena ${stamp(a.created_at)}`,
        tone: age >= DECISION_WARN_DAYS ? 'warn' : 'info',
      },
    })
  }
  for (const d of inbox.decisions) {
    const age = daysSince(d.created_at, today)
    rows.push({
      at: d.created_at,
      item: {
        key: `otazka-${d.id}`,
        title: clip(d.question, 120),
        detail: `Otevřená otázka${d.case_title?.trim() ? ` · ${clip(d.case_title, 80)}` : ''} · čeká ${ageText(age)}`,
        href: d.case_id ? `/cockpit/pripady/${d.case_id}` : '/cockpit/rozhodnuti',
        proof: `Rozhodnutí č. ${d.id}, založeno ${stamp(d.created_at)}`,
        tone: age >= DECISION_WARN_DAYS ? 'warn' : 'info',
      },
    })
  }
  return rows
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || x.item.key.localeCompare(y.item.key))
    .map((r) => r.item)
}

// --- Riziko termínů a kapacity ------------------------------------------------

export type OpsOverload = { memberId: string; name: string; weekKeys: string[]; peakLoad: number; capacity: number }

/** „2026-W40" → „T40". */
function weekShort(key: string): string {
  const n = Number(key.split('-W')[1])
  return Number.isFinite(n) ? `T${n}` : key
}

/** Kdo je přetížený tento a příští týden (capacityWarnings z kapacit, jen druh overload). */
export function overloads(
  members: readonly OpsCapacityPerson[],
  allocations: readonly AllocationLike[],
  today: string,
): OpsOverload[] {
  const names = new Map(members.map((m) => [m.id, m.full_name?.trim() || 'Člen týmu']))
  return capacityWarnings(members, allocations, weeksFrom(today, CAPACITY_WEEKS), today)
    .flatMap((w) => (w.kind === 'overload'
      ? [{ memberId: w.memberId, name: names.get(w.memberId) ?? 'Člen týmu', weekKeys: w.weekKeys, peakLoad: w.peakLoad, capacity: w.capacity }]
      : []))
}

/**
 * Riziko: dodávky a milníky po termínu (i ty, které čekají na klienta),
 * blokované úkoly dodávek, blokované obchody (jen obchodní role), přetížení
 * lidé tento a příští týden a dodávky bez vlastníka. Nejzávažnější nahoře.
 */
export function riskItems(args: {
  today: string
  portfolio: readonly PortfolioItem[]
  blockedDeals: readonly BlockedDeal[]
  overloads: readonly OpsOverload[]
  /** Faktury po splatnosti (jen obchodní role; bez částky). */
  overdueInvoices?: readonly OpsOverdueInvoice[]
}): OpsItem[] {
  const rows: { weight: number; item: OpsItem }[] = []
  for (const inv of args.overdueInvoices ?? []) {
    rows.push({
      weight: 800 + Math.min(inv.daysLate, 99),
      item: {
        key: `faktura-${inv.id}`,
        title: `${inv.accountName?.trim() || 'Bez firmy'} · faktura${inv.externalRef ? ` ${inv.externalRef}` : ''}`,
        detail: `Splatnost byla ${dayText(inv.dueOn)}, faktura je o ${daysText(inv.daysLate)} po splatnosti a platba není zapsaná`,
        href: '/cockpit/finance?druh=invoiced&splatnost=po',
        proof: `Finance: vyfakturováno${inv.externalRef ? `, doklad ${inv.externalRef}` : ''}, splatnost ${dayText(inv.dueOn)}`,
        tone: 'neg',
      },
    })
  }
  for (const d of args.portfolio) {
    const name = `${d.accountName} · ${d.title}`
    if (isDay(d.dueOn) && d.dueOn < args.today) {
      const late = daysBetweenPragueDays(d.dueOn, args.today)
      rows.push({
        weight: 1000 + Math.min(late, 999),
        item: {
          key: `pozde-d${d.id}`,
          title: name,
          detail: `Termín dodávky byl ${shortDay(d.dueOn)}, je o ${daysText(late)} po termínu · ${d.ownerName ? `vlastník ${d.ownerName}` : 'bez vlastníka'}`,
          href: d.href,
          proof: `Dodávka č. ${d.id}, termín ${shortDay(d.dueOn)}`,
          tone: 'neg',
        },
      })
    }
    for (const m of d.openMilestones) {
      if (m.daysToDue === null || m.daysToDue >= 0 || !isDay(m.dueOn)) continue
      rows.push({
        weight: 1000 + Math.min(-m.daysToDue, 999),
        item: {
          key: `pozde-m${m.id}`,
          title: `${d.accountName} · ${m.title}`,
          detail: `Milník po termínu o ${daysText(-m.daysToDue)} · ${m.statusLabel} · ${d.title}${m.ownerName ? ` · vlastník ${m.ownerName}` : ''}`,
          href: d.milestonesHref,
          proof: `Milník č. ${m.id}, termín ${shortDay(m.dueOn)}`,
          tone: 'neg',
        },
      })
    }
    if (d.waits.blockedTasks > 0) {
      const n = d.waits.blockedTasks
      rows.push({
        weight: 500 + Math.min(n, 99),
        item: {
          key: `blok-d${d.id}`,
          title: name,
          detail: `${n} ${plural(n, 'blokovaný úkol', 'blokované úkoly', 'blokovaných úkolů')} u dodávky`,
          href: d.href,
          proof: `Dodávka č. ${d.id}: úkoly ve stavu Blokováno`,
          tone: 'neg',
        },
      })
    }
    if (!d.ownerId) {
      rows.push({
        weight: 100,
        item: {
          key: `bez-vlastnika-d${d.id}`,
          title: name,
          detail: 'Dodávka nemá vlastníka, za termíny nikdo neodpovídá',
          href: `${d.href}?zalozka=tym`,
          proof: `Dodávka č. ${d.id}, vlastník nevyplněný`,
          tone: 'warn',
        },
      })
    }
  }
  for (const b of args.blockedDeals) {
    rows.push({
      weight: 400,
      item: {
        key: `blok-o${b.id}`,
        title: `${b.account_name?.trim() || 'Bez klienta'} · ${b.title}`,
        detail: `Obchod blokuje: ${clip(b.status_blocker, 160)}`,
        href: dealPath(b.id, b.account_id),
        proof: `Obchod č. ${b.id}, blokace zapsaná u obchodu`,
        tone: 'neg',
      },
    })
  }
  for (const o of args.overloads) {
    const weeks = o.weekKeys.map(weekShort)
    rows.push({
      weight: 300,
      item: {
        key: `pretizeni-${o.memberId}`,
        title: o.name,
        detail: `Přetížení v ${weeks.join(' a ')} · nejvíc ${formatHours(o.peakLoad)} při kapacitě ${formatHours(o.capacity)}`,
        href: '/cockpit/kapacity',
        proof: `Kapacity: alokace na ${weeks[0] ?? 'tento týden'}`,
        tone: 'warn',
      },
    })
  }
  return rows
    .sort((a, b) => b.weight - a.weight || a.item.key.localeCompare(b.item.key))
    .map((r) => r.item)
}

// --- Neověřené položky --------------------------------------------------------

/**
 * Co zatím nepotvrdil člověk: poptávky, které Cockpit založil sám z e-mailu
 * (jen obchodní role), návrhy případů čekající na přijetí, zápisy schůzek
 * bez klienta (jen obchodní role), dodávky s nedokončeným předáním nebo bez
 * milníků, a dodávky bez pohybu (o jejich stavu dlouho nic nevíme).
 */
export function unverifiedItems(args: {
  intakes: readonly ChangeItem[]
  pendingProposals: number | null
  unmatchedNotes: number | null
  portfolio: readonly PortfolioItem[]
  /** Milníky se načetly (bez nich nejde říct, že dodávka žádné nemá). */
  milestonesKnown: boolean
}): OpsItem[] {
  const out: OpsItem[] = args.intakes.map((i) => fromChange(i, 'info', `${i.detail} · zkontroluj, že jde o poptávku`))
  const proposals = args.pendingProposals ?? 0
  if (proposals > 0) {
    out.push({
      key: 'navrhy',
      title: 'Návrhy případů z pošty',
      detail: `${proposals} ${plural(proposals, 'návrh čeká', 'návrhy čekají', 'návrhů čeká')} na přijetí nebo zamítnutí`,
      href: '/cockpit/pripady?view=navrhy',
      proof: 'Návrhy případů, stav k dnešku',
      tone: 'info',
    })
  }
  const notes = args.unmatchedNotes ?? 0
  if (notes > 0) {
    out.push({
      key: 'zapisy',
      title: 'Zápisy schůzek bez klienta',
      detail: `${notes} ${plural(notes, 'zápis čeká', 'zápisy čekají', 'zápisů čeká')} na ruční přiřazení`,
      href: '/cockpit/schuzky/nesparovane',
      proof: 'Příjem zápisů z diktátu, stav k dnešku',
      tone: 'info',
    })
  }
  for (const d of args.portfolio) {
    const name = `${d.accountName} · ${d.title}`
    if (d.handoff === 'pending') {
      out.push({
        key: `predani-d${d.id}`,
        title: name,
        detail: 'Předání do realizace není dokončené, rozsah a vlastníka zatím nikdo nepotvrdil',
        href: `${d.href}?zalozka=predani`,
        proof: `Dodávka č. ${d.id}, předávací balíček`,
        tone: 'warn',
      })
    }
    if (args.milestonesKnown && d.progress.total === 0) {
      out.push({
        key: `bez-milniku-d${d.id}`,
        title: name,
        detail: 'Milníky nejsou zapsané, plán dodávky nejde ověřit',
        href: d.milestonesHref,
        proof: `Dodávka č. ${d.id}, žádný milník`,
        tone: 'warn',
      })
    }
    if (d.flags.stale && d.lastMove.days !== null) {
      out.push({
        key: `bez-pohybu-d${d.id}`,
        title: name,
        detail: `Bez pohybu ${daysText(d.lastMove.days)}, stav je potřeba ověřit u vlastníka`,
        href: d.href,
        proof: `Dodávka č. ${d.id}, poslední pohyb ${dayText(d.lastMove.at)}`,
        tone: 'warn',
      })
    }
  }
  return out
}

// --- Rozdíly v financích (iDoklad) ----------------------------------------------

export type OpsFinanceDiff = {
  id: number
  kind: DiscrepancyKind
  document_number: string | null
  account_name: string | null
  first_seen_at: string
}

const DIFF_WARN_DAYS = 7

/** Otevřené rozdíly z iDokladu, nejstarší první. Bez částek a bez volného textu důvodu. */
export function financeDiffItems(diffs: readonly OpsFinanceDiff[], today: string): OpsItem[] {
  return [...diffs]
    .sort((a, b) => Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) || a.id - b.id)
    .map((d) => {
      const age = daysSince(d.first_seen_at, today)
      return {
        key: `finance-${d.id}`,
        title: `${d.account_name?.trim() || 'Firma neurčena'} · ${d.document_number?.trim() || 'záznam bez čísla dokladu'}`,
        detail: `${DISCREPANCY_KIND_LABEL[d.kind]} · čeká ${ageText(age)}`,
        href: '/cockpit/finance#rozdily',
        proof: `Rozdíl z iDokladu č. ${d.id}, nalezen ${stamp(d.first_seen_at)}`,
        tone: age >= DIFF_WARN_DAYS ? 'warn' as const : 'info' as const,
      }
    })
}

// --- Celý přehled -------------------------------------------------------------

/**
 * Položky sekce Agent: nahoře fronta, která chce člověka (zprávy k pozornosti,
 * zablokované, eskalace), pod tím klidný souhrn týdne. Součet (`total`) jsou
 * jen věci k řešení — souhrn sám pozornost nechce.
 */
export function agentItems(a: OpsAgentSummary | { state: 'off' }): { items: OpsItem[]; total: number } {
  if ('state' in a && a.state === 'off') {
    return { items: [{ key: 'agent-off', title: 'Agent zatím neběží', detail: 'Tabulky agenta ještě nejsou nasazené.', href: '/cockpit/agent', proof: 'Stav agenta', tone: 'info' }], total: 0 }
  }
  const s = a as OpsAgentSummary
  const items: OpsItem[] = []
  if (s.needsAttention > 0) {
    items.push({ key: 'agent-pozornost', title: `Zprávy k pozornosti: ${s.needsAttention}`, detail: 'Odchozí zprávy agenta čekají na kontrolu člověkem.', href: '/cockpit/agent#fronta', proof: 'Odchozí fronta agenta', tone: 'neg' })
  }
  if (s.blocked > 0) {
    items.push({ key: 'agent-blokovano', title: `Zablokované zprávy: ${s.blocked}`, detail: 'Brána odeslání zprávu zastavila; nabídku je potřeba schválit nebo poslat ručně.', href: '/cockpit/agent#fronta', proof: 'Odchozí fronta agenta', tone: 'warn' })
  }
  if (s.escalations > 0) {
    items.push({ key: 'agent-eskalace', title: `Eskalace na obchod: ${s.escalations}`, detail: 'Poptávky, které agent předal člověku (důvody na stránce agenta).', href: '/cockpit/agent#rozhodnuti', proof: 'Rozhodnutí agenta za týden', tone: 'warn' })
  }
  items.push({
    key: 'agent-souhrn', title: `Poptávek: ${s.inquiries}, odesláno zpráv: ${s.sent}`,
    detail: 'Souhrn agenta za týden.', href: '/cockpit/agent', proof: 'Rozhodnutí a odchozí fronta agenta', tone: 'info',
  })
  return { items, total: s.needsAttention + s.blocked + s.escalations }
}

function section(key: OpsSectionKey, items: OpsItem[], unavailable: string[], total = items.length): OpsSection {
  const spec = OPS_SECTIONS.find((s) => s.key === key)!
  return {
    key, title: spec.title, short: spec.short, lead: spec.lead, path: spec.path, calm: spec.calm,
    items, total: Math.max(total, items.length), unavailable: [...new Set(unavailable)],
  }
}

export function buildOpsReport(input: OpsReportInput): OpsReport {
  const sales = input.canSeeSales
  const portfolioOk = input.portfolio.state === 'ok'
  const portfolio = input.portfolio.state === 'ok' ? input.portfolio.items : []
  const portfolioGaps = input.portfolio.state === 'ok' ? input.portfolio.unavailable : []
  const milestonesKnown = portfolioOk && !portfolioGaps.includes('milníky')
  const noPortfolio = portfolioOk ? [] : ['dodávky']
  const noMilestones = portfolioOk && !milestonesKnown ? ['milníky'] : []
  // Obchodní seznamy z týdenního přehledu jen s oprávněním — i kdyby je volající předal.
  const src = sales && input.digest ? input.digest.source : { followUps: [], outreach: [], blockedDeals: [] }
  const noDigest = sales && !input.digest

  const sections: OpsSection[] = []

  if (sales) {
    sections.push(section('obchody', dealItems(changeItems(input.changes, 'stage')),
      changeFailed(input.changes, 'stage') ? ['obchody'] : [], changeTotal(input.changes, 'stage')))
  }

  sections.push(section('dodavky',
    deliveryItems(portfolio, changeItems(input.changes, 'milestone'), changeItems(input.changes, 'delivery')),
    [...noPortfolio, ...noMilestones, ...(changeFailed(input.changes, 'milestone') ? ['posuny milníků'] : [])]))

  sections.push(section('na-nas',
    oursItems({ portfolio, followUps: src.followUps, outreach: src.outreach }),
    [...noPortfolio, ...noMilestones, ...(noDigest ? ['follow-upy'] : [])]))

  sections.push(section('na-klienta',
    input.waiting.state === 'ok' ? clientItems(input.waiting.items) : [],
    input.waiting.state === 'error' ? ['čekání na klienta'] : []))

  sections.push(section('ke-schvaleni',
    input.inbox.state === 'ok' ? decisionItems(input.inbox, input.today) : [],
    input.inbox.state === 'error' ? ['Ke schválení'] : []))

  const people = input.capacity.state === 'ok' ? overloads(input.capacity.members, input.capacity.allocations, input.today) : []
  sections.push(section('riziko',
    riskItems({
      today: input.today, portfolio, blockedDeals: src.blockedDeals, overloads: people,
      overdueInvoices: sales ? input.overdueInvoices ?? [] : [],
    }),
    [
      ...noPortfolio, ...noMilestones,
      ...(sales && input.overdueInvoices === null ? ['faktury po splatnosti'] : []),
      ...(portfolioGaps.includes('úkoly') ? ['úkoly dodávek'] : []),
      ...(input.capacity.state === 'error' ? ['kapacity'] : []),
      ...(noDigest ? ['blokované obchody'] : []),
    ]))

  sections.push(section('neovereno',
    unverifiedItems({
      intakes: sales ? changeItems(input.changes, 'intake') : [],
      pendingProposals: input.pendingProposals,
      unmatchedNotes: sales ? input.unmatchedNotes : null,
      portfolio,
      milestonesKnown,
    }),
    [...noPortfolio, ...(sales && changeFailed(input.changes, 'intake') ? ['poptávky z e-mailu'] : [])]))

  // Rozdíly z iDokladu: jen s napojením (financeDiffs) a jen obchodní role.
  if (sales && input.financeDiffs) {
    const fd = input.financeDiffs
    sections.push(section('finance-rozdily',
      fd.state === 'ok' ? financeDiffItems(fd.items, input.today) : [],
      fd.state === 'error' ? ['rozdíly z iDokladu'] : [],
      fd.state === 'ok' ? fd.total : 0))
  }

  // Agent: jen s modulem (agent !== undefined) a jen obchodní role.
  if (sales && input.agent !== undefined) {
    const a = input.agent
    const built = a ? agentItems(a) : { items: [], total: 0 }
    // Souhrnná položka pozornost nechce: total jsou jen věci k řešení.
    sections.push({ ...section('agent', built.items, a === null ? ['agent'] : []), total: built.total })
  }

  const byKey = new Map(sections.map((s) => [s.key, s]))
  const clauses = HEADLINE_ORDER
    .map((k) => byKey.get(k))
    .filter((s): s is OpsSection => !!s && s.total > 0)
    .map((s) => `${s.short}: ${s.total}`)
  const attention = ATTENTION_KEYS.reduce((n, k) => n + (byKey.get(k)?.total ?? 0), 0)
  const deals = byKey.get('obchody')?.total ?? 0

  return {
    generatedAt: input.generatedAt,
    today: input.today,
    window: input.window,
    week: input.week,
    canSeeSales: sales,
    sections,
    headline: clauses.length > 0 ? `${clauses.join(', ')}.` : 'Nic k řešení.',
    attention,
    isEmpty: attention === 0 && deals === 0,
    activeDeliveries: portfolioOk ? portfolio.length : null,
    sources: input.digest?.digest.sources ?? null,
    sourceAlerts: input.digest?.digest.sourceAlerts ?? 0,
    unavailable: [...new Set(sections.flatMap((s) => s.unavailable))],
  }
}

/** Kolik položek přehled celkem nese (všechny sekce kromě dodávek, které jsou stav, ne úkol). */
export function opsReportItemCount(report: Pick<OpsReport, 'sections'>): number {
  return report.sections.filter((s) => s.key !== 'dodavky').reduce((n, s) => n + s.total, 0)
}
