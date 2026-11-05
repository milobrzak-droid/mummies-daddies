// Doménová logika firmy: pilíře, jejich fáze, realizační týmy a role partnerů.
// Pilíře, fáze, „vyhrané" fáze a realizační týmy jsou konfigurace firmy
// (config/, kapitola 11); tady zůstávají pomocníky nad nimi.
import { isLegacyDealStage, LEGACY_DEAL_STAGE_PROBABILITY, normalizeDealStage } from '@/lib/dealStageLegacy'
import { COMPANY } from '@/config'

// Jedno místo pravdy pro UI (popisky) i validaci. Fáze se ladí tady, ne v DB.

export type Pillar = (typeof COMPANY.pillars)[number]['key']

// Barvy pilířů (validovaná kategorická sada — CVD-safe light i dark).
export const PILLARS: readonly { key: Pillar; label: string; sub: string; color: string }[] = COMPANY.pillars

export type Phase = { key: string; label: string }

// Sada fází pro každý pilíř. Pořadí = časová osa.
export const PHASES: Readonly<Record<Pillar, readonly Phase[]>> = COMPANY.phases

export const DELIVERY_TEAMS: readonly { key: string; label: string }[] = COMPANY.deliveryTeams

// Role členů organizace (viz migrace 0014). Řídí, kdo vidí Byznys tab.
// sees_byznys MUSÍ sedět s can_see_sales() v SQL, SALES_ROLES (lib/apiKeyAuth.ts)
// a DIGEST_ALLOWED_ROLES (domain/crm/digestDelivery.ts) — test/sales-roles.test.ts.
export const TEAM_ROLES: { key: string; label: string; sees_byznys: boolean }[] = [
  { key: 'vedeni', label: 'Vedení', sees_byznys: true },
  { key: 'obchodnik', label: 'Obchodník', sees_byznys: true },
  { key: 'projektak', label: 'Projekťák / IT', sees_byznys: false },
  { key: 'lektor', label: 'Lektor', sees_byznys: false },
  { key: 'partner', label: 'Partner', sees_byznys: false },
]
// Interní role = ty, které smějí číst a zapisovat interní evidenci. Role Partner
// (externí účet) je mimo: migrace 0082 ji vylučuje v is_team_member()/is_admin()
// a aplikace jí po přihlášení ukáže jen obrazovku „bez přístupu“. Allowlist, ne
// výčet zakázaných — nová role je vyloučená, dokud ji někdo výslovně nepřidá.
// MUSÍ sedět se seznamem v is_team_member() v 0082 (test/hardening-0082.test.ts).
export const INTERNAL_ROLES: readonly string[] = ['vedeni', 'obchodnik', 'projektak', 'lektor']
export function isInternalRole(role?: string | null): boolean {
  return typeof role === 'string' && INTERNAL_ROLES.includes(role)
}
export function seesByznys(role?: string | null): boolean {
  return TEAM_ROLES.find((r) => r.key === role)?.sees_byznys ?? false
}

// Fáze obchodu (kapitola 5, rozhodnutí vedení 28. 9. 2026). Jediný zdroj
// pravdy pro klíče, popisky, příznak „otevřená" (= patří do pipeline)
// a výchozí pravděpodobnost. Pořadí = postup obchodu.
// Fáze odráží důkaz v rozhodování klienta, ne naši aktivitu:
//   kvalifikace     — víme, že je o čem mluvit (dřív „lead" i „po jednání")
//   diagnostika     — rozumíme problému a výsledku, který klient chce
//   rozsah_nabidka  — rozsah/nabídka je na stole (dřív „nabídka")
//   rozhodovani     — klient rozhoduje (dřív „vyjednávání")
// `odloženo` je ZAVŘENÁ fáze — do pipeline se nepočítá.
// Staré hodnoty enumu (lead, proběhlo_jednání, nabídka, vyjednávání) v DB
// zůstávají (Postgres hodnotu enumu odebrat neumí), ale nepoužívají se;
// převod starých hodnot při čtení je v lib/dealStageLegacy.ts.
// `tone` = datová barva fáze (tokeny --d-* z app/globals.css, docs/PROVOZ.md §4):
// barva nese význam fáze, ne pořadí – modrá probíhá, žlutá čeká (nabídka na
// stole), fialová rozhodnutí, tyrkysová hotovo, červená problém, šedá bez významu.
// Popisky bere z COMPANY.dealStageLabels (klíče enumu v DB se nemění).
const STAGE_LABELS: Readonly<Partial<Record<string, string>>> = COMPANY.dealStageLabels ?? {}
const stageLabel = <K extends string>(key: K, fallback: string): string => STAGE_LABELS[key] ?? fallback
export const DEAL_STAGES = [
  { key: 'kvalifikace', open: true, label: stageLabel('kvalifikace', 'Kvalifikace'), probability: 10, tone: 'var(--d-neutral)' },
  { key: 'diagnostika', open: true, label: stageLabel('diagnostika', 'Diagnostika'), probability: 30, tone: 'var(--d-blue)' },
  { key: 'rozsah_nabidka', open: true, label: stageLabel('rozsah_nabidka', 'Rozsah / nabídka'), probability: 55, tone: 'var(--d-yellow)' },
  { key: 'rozhodovani', open: true, label: stageLabel('rozhodovani', 'Rozhodování'), probability: 75, tone: 'var(--d-violet)' },
  { key: 'vyhráno', open: false, label: stageLabel('vyhráno', 'Vyhráno'), probability: 100, tone: 'var(--d-turquoise)' },
  { key: 'prohráno', open: false, label: stageLabel('prohráno', 'Prohráno'), probability: 0, tone: 'var(--d-red)' },
  { key: 'odloženo', open: false, label: stageLabel('odloženo', 'Odloženo'), probability: 0, tone: 'var(--d-neutral)' },
] as const

export type DealStageKey = (typeof DEAL_STAGES)[number]['key']

// Všechny klíče v pořadí definice — pro z.enum a <select>.
export const DEAL_STAGE_KEYS = DEAL_STAGES.map((item) => item.key) as unknown as
  readonly [DealStageKey, ...DealStageKey[]]

// Fáze nového obchodu (i výchozí hodnota sloupce deal.stage od migrace 0050).
export const DEFAULT_DEAL_STAGE: DealStageKey = 'kvalifikace'

// Jediný zdroj pravdy pro „otevřené" fáze obchodu (příznak `open` výše).
// test/stage-lists.test.ts hlídá, že nikde jinde nevznikne natvrdo psaná
// kopie seznamu.
export const OPEN_DEAL_STAGE_KEYS: DealStageKey[] = DEAL_STAGES
  .filter((item) => item.open)
  .map((item) => item.key)

export function isDealStageKey(v: unknown): v is DealStageKey {
  return typeof v === 'string' && DEAL_STAGES.some((item) => item.key === v)
}

// Popisek i pravděpodobnost snesou i starou hodnotu z DB (před migrací 0050).
export function dealStageLabel(stage?: string | null): string {
  const key = normalizeDealStage(stage)
  return DEAL_STAGES.find((item) => item.key === key)?.label ?? stage ?? '—'
}

// Stará hodnota vrací výchozí pravděpodobnost STARÉ fáze (stejně jako ji
// 0050 zmrazí do probability_pct) — vážená pipeline se převodem nepohne.
export function defaultProbabilityForStage(stage?: string | null): number {
  if (stage && isLegacyDealStage(stage)) return LEGACY_DEAL_STAGE_PROBABILITY[stage]
  return DEAL_STAGES.find((item) => item.key === stage)?.probability ?? 0
}

// Typ obchodu (sloupec deal.deal_kind, migrace 0052; nullable bez výchozí
// hodnoty: NULL = zatím neroztříděno). Klíče jsou historické a drží je CHECK
// v DB i šablony realizace (0080): workshop = degustace, implementace =
// jednorázová akce, provoz = pravidelný catering.
export const DEAL_KINDS = [
  { key: 'workshop', label: 'Degustace' },
  { key: 'implementace', label: 'Jednorázová akce' },
  { key: 'provoz', label: 'Pravidelný catering' },
  { key: 'jine', label: 'Jiné' },
] as const

export type DealKind = (typeof DEAL_KINDS)[number]['key']

export const DEAL_KIND_KEYS = DEAL_KINDS.map((item) => item.key) as unknown as
  readonly [DealKind, ...DealKind[]]

export function isDealKind(v: unknown): v is DealKind {
  return typeof v === 'string' && DEAL_KINDS.some((item) => item.key === v)
}

export function dealKindLabel(kind?: string | null): string | null {
  if (!kind) return null
  return DEAL_KINDS.find((item) => item.key === kind)?.label ?? kind
}

export const PARTNER_ROLES: { key: string; label: string }[] = [
  { key: 'referrer', label: 'Doporučovatel' },   // přivede zákazníka (agentura, salon)
  { key: 'distributor', label: 'Zprostředkovatel' }, // dohazuje akce a dodavatele
  { key: 'supplier', label: 'Dodavatel' },        // nápoje, vybavení, prostory
  { key: 'vendor', label: 'Výrobce' },            // suroviny a zboží
]

// Obchodní linky (enum revenue_line) z konfigurace firmy.
export const REVENUE_LINES: readonly { key: string; label: string; category: string }[] = COMPANY.revenueLines ?? []
export function revenueLineLabel(key: string | null | undefined): string {
  if (!key) return '—'
  return REVENUE_LINES.find((l) => l.key === key)?.label ?? key
}
export const DEFAULT_REVENUE_LINE: string = REVENUE_LINES[0]?.key ?? 'catering_firemni'

const PILLAR_MAP = Object.fromEntries(PILLARS.map((p) => [p.key, p]))
const TEAM_MAP = Object.fromEntries(DELIVERY_TEAMS.map((t) => [t.key, t.label]))
const ROLE_MAP = Object.fromEntries(PARTNER_ROLES.map((r) => [r.key, r.label]))

export function isPillar(v: unknown): v is Pillar {
  return PILLARS.some((p) => p.key === v)
}
export function pillarLabel(k?: string | null): string {
  return (k && PILLAR_MAP[k]?.label) || '—'
}
export function pillarSub(k?: string | null): string {
  return (k && PILLAR_MAP[k]?.sub) || ''
}
export function phasesFor(pillar?: string | null): readonly Phase[] {
  return isPillar(pillar) ? PHASES[pillar] : []
}
export function phaseLabel(pillar?: string | null, phaseKey?: string | null): string {
  if (!phaseKey) return '—'
  return phasesFor(pillar).find((p) => p.key === phaseKey)?.label ?? phaseKey
}
// 0-based index of the current phase within its pillar (−1 if unknown).
export function phaseIndex(pillar?: string | null, phaseKey?: string | null): number {
  return phasesFor(pillar).findIndex((p) => p.key === phaseKey)
}
export function teamLabel(k?: string | null): string {
  return (k && TEAM_MAP[k]) || '—'
}

// Odvození hrubého deal_stage z fáze (drží ekonomické view: nasmlouváno = „vyhráno").
// Projekt je „vyhráno" jakmile reálně běží dodávka; ranější fáze jsou pipeline.
const WON_PHASES: Readonly<Record<Pillar, readonly string[]>> = COMPANY.wonPhases
export function stageForPhase(pillar?: string | null, phase?: string | null): DealStageKey | null {
  if (!isPillar(pillar) || !phase) return null
  // Fáze musí patřit danému pilíři, jinak nevíme, co znamená.
  if (!PHASES[pillar].some((p) => p.key === phase)) return null
  if (WON_PHASES[pillar].includes(phase)) return 'vyhráno'
  return phase === 'poptavka' ? 'kvalifikace' : 'rozsah_nabidka'
}

export function roleLabel(k: string): string {
  return ROLE_MAP[k] ?? k
}

// Marže projektu = amount_one_time − cogs_one_time. null, pokud náklady
// ještě nejsou vyplněné (0 by tichě předstíralo 100% marži) nebo je částka 0.
export function dealMargin(
  amount: number | string | null | undefined,
  cogs: number | string | null | undefined,
): { czk: number; pct: number } | null {
  if (amount == null || cogs == null) return null
  // Prázdný / mezerový řetězec z formuláře = náklady nevyplněné, ne 0.
  if (typeof amount === 'string' && amount.trim() === '') return null
  if (typeof cogs === 'string' && cogs.trim() === '') return null
  const a = Number(amount)
  const c = Number(cogs)
  if (!Number.isFinite(a) || !Number.isFinite(c) || a === 0) return null
  return { czk: a - c, pct: Math.round(((a - c) / a) * 100) }
}

// Fáze dodávky (engagement.phase, enum delivery_phase z 0001) a druh dodávky
// (engagement.kind) — popisky pro přehled Projekty u rolí bez obchodu.
// Klíče enumu jsou historické; popisky odpovídají realizaci akce.
export const DELIVERY_PHASES: readonly { key: string; label: string }[] = [
  { key: 'sm_diagnostika', label: 'Příprava' },
  { key: 'workshopy', label: 'Degustace' },
  { key: 'analyza', label: 'Plánování akce' },
  { key: 'pilot', label: 'Zkouška menu' },
  { key: 'implementace', label: 'Realizace' },
  { key: 'podpora', label: 'Pravidelné dodávky' },
  { key: 'mereni_6m', label: 'Vyhodnocení' },
  { key: 'uzavreno', label: 'Uzavřeno' },
]
export function deliveryPhaseLabel(key: string | null | undefined): string {
  return DELIVERY_PHASES.find((p) => p.key === key)?.label ?? key ?? '—'
}
const ENGAGEMENT_KIND_LABELS: Record<string, string> = { edu: 'Firemní akce', it: 'Akce', platform: 'Pravidelný catering' }
export function engagementKindLabel(kind: string | null | undefined): string {
  return (kind && ENGAGEMENT_KIND_LABELS[kind]) ?? kind ?? '—'
}

// Nesouhlas s oslovením (contact.do_not_contact_reason, 0087): nejdelší
// „odkud / proč" — CHECK contact_do_not_contact_reason_len v databázi.
export const DO_NOT_CONTACT_REASON_MAX = 300
