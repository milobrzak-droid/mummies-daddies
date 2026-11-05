// Kapacity lidí a alokace (kapitola 10 plánu přestavby, část 1: „alokace
// lidí a zastupitelnost; plán vs. kapacita"). Tabulky a RPC jsou
// v migraci 0062_capacity.sql.
//
// Čistá logika bez I/O: týdenní zatížení člověka v ISO týdnech, přetížení,
// kdo koho zastupuje a varování o zástupu. Stránka /kapacity, sekce „Kdo na
// tom pracuje" u dodávky i server akce počítají odsud.
//
// DNY A TÝDNY: den je kalendářní den v pásmu firmy (COMPANY.timeZone přes
// lib/pragueDate) jako řetězec YYYY-MM-DD. Aritmetika běží nad kalendářními
// dny, ne nad okamžiky, takže přechod na letní/zimní čas týden nezkrátí ani
// neprodlouží (týden s 29. 3. má pořád pět pracovních dnů). Pásmo hraje roli
// jen ve chvíli, kdy se z okamžiku určuje „dnes" (planWeeks → pragueToday):
// neděle 22:30 UTC je v létě v Praze už pondělí nového týdne.
//
// PRORATA: alokace je v hodinách za celý pracovní týden (Po–Pá). Týden, do
// kterého zasahuje jen částečně (začíná ve středu, končí v úterý), se počítá
// poměrem pracovních dnů, které pokrývá: 3 z 5 dnů = 3/5 hodin. Víkend se
// nepočítá. Státní svátky zatím také ne — kapacita je týdenní průměr, ne
// rozvrh; svátek řeší člověk tím, že v takovém týdnu počítá s rezervou.
//
// KAPACITA: team_member.weekly_capacity_hours (0–80, výchozí 40). Dokud
// migrace 0062 neběží, sloupec chybí a počítá se s výchozími 40 h.
// 0 = člověk je dlouhodobě mimo; každá jeho alokace je pak přetížení.

import { z } from 'zod'
import { addDaysToPragueDay, daysBetweenPragueDays, pragueToday } from '@/lib/pragueDate'

export const DEFAULT_WEEKLY_CAPACITY = 40
export const MAX_WEEKLY_HOURS = 80
export const WORKDAYS_PER_WEEK = 5
/** Kolik týdnů dopředu ukazuje plán na /kapacity (včetně aktuálního). */
export const PLAN_WEEKS = 8
export const NOTE_MAX = 500

// Tolerance porovnání hodin (zaokrouhlení na setiny při prorata).
const EPS = 0.005

// ---------------------------------------------------------------------------
// Kalendářní dny a ISO týdny

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Platný kalendářní den ve tvaru YYYY-MM-DD (2026-02-30 neprojde). */
export function isIsoDay(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = ISO_DAY_RE.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** ISO den v týdnu: pondělí 1 … neděle 7. */
export function isoWeekday(day: string): number {
  const dow = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))).getUTCDay()
  return dow === 0 ? 7 : dow
}

export type IsoWeek = {
  /** Např. „2026-W40". Rok je ISO rok (týden s 1. 1. může patřit k předchozímu). */
  key: string
  year: number
  week: number
  /** Pondělí (YYYY-MM-DD). */
  start: string
  /** Neděle (YYYY-MM-DD). */
  end: string
}

/** ISO 8601 týden, do kterého den patří (týden začíná pondělím, týden 1 obsahuje první čtvrtek roku). */
export function isoWeekOf(day: string): IsoWeek {
  if (!isIsoDay(day)) throw new Error(`Neplatný den: ${day}`)
  const start = addDaysToPragueDay(day, 1 - isoWeekday(day))
  const thursday = addDaysToPragueDay(start, 3)
  const year = Number(thursday.slice(0, 4))
  const week = 1 + Math.floor(daysBetweenPragueDays(`${year}-01-01`, thursday) / 7)
  return { key: `${year}-W${String(week).padStart(2, '0')}`, year, week, start, end: addDaysToPragueDay(start, 6) }
}

/** `count` po sobě jdoucích ISO týdnů; první je týden, do kterého patří `day`. */
export function weeksFrom(day: string, count: number): IsoWeek[] {
  const first = isoWeekOf(day)
  const n = Math.max(0, Math.floor(count))
  return Array.from({ length: n }, (_, i) => isoWeekOf(addDaysToPragueDay(first.start, i * 7)))
}

/** Týdny plánu od aktuálního pražského týdne (z okamžiku `now`). */
export function planWeeks(now: Date = new Date(), count: number = PLAN_WEEKS): IsoWeek[] {
  return weeksFrom(pragueToday(now), count)
}

// ---------------------------------------------------------------------------
// Alokace a zatížení

export type AllocationPeriod = { starts_on: string; ends_on: string | null }

export type AllocationLike = AllocationPeriod & {
  id: number
  member_id: string
  hours_per_week: number | string
  substitute_id: string | null
}

export type MemberLike = { id: string; weekly_capacity_hours?: number | string | null }

/** Číslo hodin z DB (numeric může přijít jako číslo i jako text); jinak null. */
export function toHours(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** Týdenní kapacita člověka; chybějící/neplatná hodnota → výchozích 40 h. */
export function capacityOf(m: MemberLike): number {
  const h = toHours(m.weekly_capacity_hours)
  return h === null || h < 0 ? DEFAULT_WEEKLY_CAPACITY : h
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Zasahuje alokace do kalendářního týdne (včetně víkendu)? */
export function overlapsWeek(a: AllocationPeriod, week: IsoWeek): boolean {
  return a.starts_on <= week.end && (a.ends_on === null || a.ends_on >= week.start)
}

/** Kolik pracovních dnů (Po–Pá) týdne alokace pokrývá: 0–5. */
export function workdaysCovered(a: AllocationPeriod, week: IsoWeek): number {
  if (!overlapsWeek(a, week)) return 0
  const from = a.starts_on > week.start ? a.starts_on : week.start
  const to = a.ends_on !== null && a.ends_on < week.end ? a.ends_on : week.end
  const first = daysBetweenPragueDays(week.start, from)
  const last = Math.min(daysBetweenPragueDays(week.start, to), WORKDAYS_PER_WEEK - 1)
  return last >= first ? last - first + 1 : 0
}

/** Hodiny alokace v daném týdnu (poměrem pokrytých pracovních dnů). */
export function allocationHoursInWeek(a: AllocationLike, week: IsoWeek): number {
  const hours = toHours(a.hours_per_week)
  if (hours === null || hours <= 0) return 0
  return round2((hours * workdaysCovered(a, week)) / WORKDAYS_PER_WEEK)
}

/** Přetížení = plán nad kapacitou (rovnost je ještě v pořádku). */
export function isOverloaded(load: number, capacity: number): boolean {
  return load - capacity > EPS
}

export type WeekLoad = {
  week: IsoWeek
  load: number
  capacity: number
  /** capacity − load; záporné = přetížení o tolik hodin. */
  free: number
  /** load / capacity; null při kapacitě 0. */
  utilization: number | null
  overloaded: boolean
}

export type MemberPlan<M extends MemberLike = MemberLike> = {
  member: M
  capacity: number
  weeks: WeekLoad[]
  overloadedWeeks: number
}

function weekLoad(week: IsoWeek, load: number, capacity: number): WeekLoad {
  const l = round2(load)
  return {
    week,
    load: l,
    capacity,
    free: round2(capacity - l),
    utilization: capacity > 0 ? l / capacity : null,
    overloaded: isOverloaded(l, capacity),
  }
}

/** Zatížení jednoho člověka po týdnech (jen jeho vlastní alokace, ne zástupy). */
export function memberWeekLoads(member: MemberLike, allocations: readonly AllocationLike[], weeks: readonly IsoWeek[]): WeekLoad[] {
  const capacity = capacityOf(member)
  const own = allocations.filter((a) => a.member_id === member.id)
  return weeks.map((w) => weekLoad(w, own.reduce((sum, a) => sum + allocationHoursInWeek(a, w), 0), capacity))
}

/** Plán proti kapacitě pro celý tým, v pořadí `members`. */
export function capacityPlan<M extends MemberLike>(
  members: readonly M[],
  allocations: readonly AllocationLike[],
  weeks: readonly IsoWeek[],
): MemberPlan<M>[] {
  return members.map((member) => {
    const loads = memberWeekLoads(member, allocations, weeks)
    return {
      member,
      capacity: capacityOf(member),
      weeks: loads,
      overloadedWeeks: loads.filter((l) => l.overloaded).length,
    }
  })
}

// ---------------------------------------------------------------------------
// Stav alokace a ukončení

export type AllocationStatus = 'planned' | 'active' | 'ended'

export const ALLOCATION_STATUS_LABEL: Record<AllocationStatus, string> = {
  planned: 'Naplánováno',
  active: 'Běží',
  ended: 'Skončilo',
}

/** Naplánováno (začne později), běží, nebo skončilo (poslední den je před dneškem). */
export function allocationStatus(a: AllocationPeriod, today: string): AllocationStatus {
  if (a.starts_on > today) return 'planned'
  if (a.ends_on !== null && a.ends_on < today) return 'ended'
  return 'active'
}

/** Platí alokace dnes nebo někdy v budoucnu? */
export function isCurrentOrFuture(a: AllocationPeriod, today: string): boolean {
  return a.ends_on === null || a.ends_on >= today
}

export type EndPlan = { kind: 'set_end'; ends_on: string } | { kind: 'delete' } | { kind: 'already_ended' }

/**
 * Co znamená „Ukončit" k dnešku:
 *   - už skončila nebo dnes končí → nic (already_ended),
 *   - ještě nezačala → smazat (nikdy neplatila; ends_on = dnes by porušil
 *     CHECK ends_on >= starts_on),
 *   - běží → poslední den = dnes (dnešek se ještě počítá).
 */
export function planAllocationEnd(a: AllocationPeriod, today: string): EndPlan {
  if (a.ends_on !== null && a.ends_on <= today) return { kind: 'already_ended' }
  if (a.starts_on > today) return { kind: 'delete' }
  return { kind: 'set_end', ends_on: today }
}

// ---------------------------------------------------------------------------
// Zastupitelnost

export type SubstituteEdge = { memberId: string; substituteId: string; allocationIds: number[] }

/**
 * Kdo koho zastupuje: dvojice (člověk → zástup) z alokací, které platí dnes
 * nebo později. Víc alokací se stejnou dvojicí se sloučí.
 */
export function substitutionEdges(allocations: readonly AllocationLike[], today: string): SubstituteEdge[] {
  const byPair = new Map<string, SubstituteEdge>()
  for (const a of allocations) {
    if (!a.substitute_id || a.substitute_id === a.member_id || !isCurrentOrFuture(a, today)) continue
    const key = `${a.member_id}|${a.substitute_id}`
    const edge = byPair.get(key) ?? { memberId: a.member_id, substituteId: a.substitute_id, allocationIds: [] }
    edge.allocationIds.push(a.id)
    byPair.set(key, edge)
  }
  return [...byPair.values()].sort((x, y) =>
    x.memberId === y.memberId ? x.substituteId.localeCompare(y.substituteId) : x.memberId.localeCompare(y.memberId),
  )
}

export type SubstitutionSummary = {
  memberId: string
  /** Kdo zastupuje tohoto člověka. */
  substitutes: string[]
  /** Koho tento člověk zastupuje. */
  substitutesFor: string[]
  /** Kolik jeho platných alokací zástup nemá. */
  withoutSubstitute: number
}

/** Zastupitelnost po lidech (v pořadí `members`). */
export function substitutionSummary(
  members: readonly MemberLike[],
  allocations: readonly AllocationLike[],
  today: string,
): SubstitutionSummary[] {
  const edges = substitutionEdges(allocations, today)
  return members.map((m) => ({
    memberId: m.id,
    substitutes: edges.filter((e) => e.memberId === m.id).map((e) => e.substituteId),
    substitutesFor: edges.filter((e) => e.substituteId === m.id).map((e) => e.memberId),
    withoutSubstitute: allocations.filter(
      (a) => a.member_id === m.id && isCurrentOrFuture(a, today) && !a.substitute_id,
    ).length,
  }))
}

export type CapacityWarning =
  | { kind: 'overload'; memberId: string; weekKeys: string[]; peakLoad: number; capacity: number }
  | {
      kind: 'substitute_no_room'
      allocationId: number
      memberId: string
      substituteId: string
      weekKey: string
      /** Hodiny, které by zástup musel převzít. */
      needed: number
      /** Kolik má zástup v tom týdnu volna (může být záporné). */
      free: number
    }
  | { kind: 'no_substitute'; allocationId: number; memberId: string }

const WARNING_ORDER: Record<CapacityWarning['kind'], number> = { overload: 0, substitute_no_room: 1, no_substitute: 2 }

/**
 * Varování pro plán v týdnech `weeks`:
 *   overload            — člověk má v některém týdnu víc hodin než kapacitu,
 *   substitute_no_room  — zástup by práci nepřevzal: jeho vlastní plán +
 *                         hodiny zastupované alokace přesáhnou jeho kapacitu
 *                         (hlásí se první takový týden),
 *   no_substitute       — alokace v plánu nemá zástup.
 * Alokace lidí mimo `members` se ignorují. Varování o zástupu se týkají
 * jen alokací platných dnes nebo později (isCurrentOrFuture) — alokace, která
 * skončila začátkem tohoto týdne, už zástup nepotřebuje a v seznamu ani
 * v zastupitelnosti vidět není.
 */
export function capacityWarnings(
  members: readonly MemberLike[],
  allocations: readonly AllocationLike[],
  weeks: readonly IsoWeek[],
  today: string,
): CapacityWarning[] {
  const plans = new Map(capacityPlan(members, allocations, weeks).map((p) => [p.member.id, p]))
  const out: CapacityWarning[] = []

  for (const p of plans.values()) {
    const over = p.weeks.filter((w) => w.overloaded)
    if (over.length) {
      out.push({
        kind: 'overload',
        memberId: p.member.id,
        weekKeys: over.map((w) => w.week.key),
        peakLoad: Math.max(...over.map((w) => w.load)),
        capacity: p.capacity,
      })
    }
  }

  for (const a of allocations) {
    if (!plans.has(a.member_id) || !isCurrentOrFuture(a, today) || !weeks.some((w) => overlapsWeek(a, w))) continue
    if (!a.substitute_id || a.substitute_id === a.member_id) {
      out.push({ kind: 'no_substitute', allocationId: a.id, memberId: a.member_id })
      continue
    }
    const sub = plans.get(a.substitute_id)
    if (!sub) continue
    for (let i = 0; i < weeks.length; i++) {
      const needed = allocationHoursInWeek(a, weeks[i])
      if (needed <= 0) continue
      const w = sub.weeks[i]
      if (isOverloaded(w.load + needed, w.capacity)) {
        out.push({
          kind: 'substitute_no_room',
          allocationId: a.id,
          memberId: a.member_id,
          substituteId: a.substitute_id,
          weekKey: w.week.key,
          needed,
          free: w.free,
        })
        break
      }
    }
  }

  return out
    .map((w, i) => ({ w, i }))
    .sort((x, y) => WARNING_ORDER[x.w.kind] - WARNING_ORDER[y.w.kind] || x.i - y.i)
    .map((x) => x.w)
}

// ---------------------------------------------------------------------------
// Seznam alokací pro UI: jména, cíl a stav místo id

export type TargetInfo = { label: string; href: string | null }

export type AllocationTargeted = AllocationLike & { engagement_id: number | null; work_case_id: number | null }

export type DescribedAllocation<R extends AllocationTargeted> = R & {
  memberName: string
  substituteName: string | null
  target: TargetInfo
  status: AllocationStatus
  /** Dává „Ukončit" smysl? Ne u alokace, která skončila nebo dnes končí (planAllocationEnd). */
  canEnd: boolean
}

const STATUS_ORDER: Record<AllocationStatus, number> = { active: 0, planned: 1, ended: 2 }

/**
 * Alokace s lidskými popisky, seřazené: běží → naplánované → skončené,
 * uvnitř podle jména a začátku. Neznámý člověk / cíl (smazaný mezi dotazy,
 * nebo případ, který RLS nevrátí) dostane zástupný popisek, ne pád.
 */
export function describeAllocations<R extends AllocationTargeted>(
  rows: readonly R[],
  names: ReadonlyMap<string, string>,
  targets: ReadonlyMap<string, TargetInfo>,
  today: string,
): DescribedAllocation<R>[] {
  return rows
    .map((r) => {
      const ref: AllocationTargetRef | null =
        r.engagement_id !== null
          ? { engagement_id: r.engagement_id, work_case_id: null }
          : r.work_case_id !== null
            ? { engagement_id: null, work_case_id: r.work_case_id }
            : null
      const fallback: TargetInfo = { label: ref?.engagement_id != null ? 'Dodávka' : 'Případ', href: null }
      return {
        ...r,
        memberName: names.get(r.member_id) ?? 'Neznámý člen týmu',
        substituteName: r.substitute_id ? names.get(r.substitute_id) ?? 'Neznámý člen týmu' : null,
        target: (ref && targets.get(targetKey(ref))) || fallback,
        status: allocationStatus(r, today),
        canEnd: planAllocationEnd(r, today).kind !== 'already_ended',
      }
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.memberName.localeCompare(b.memberName, 'cs') ||
        a.starts_on.localeCompare(b.starts_on) ||
        a.id - b.id,
    )
}

// ---------------------------------------------------------------------------
// Kdo smí měnit kapacitu (zrcadlo set_weekly_capacity v 0062)

export type CapacityViewer = { id: string; teamRole: string | null; isAdmin: boolean }

/** Admin a vedení komukoli, ostatní jen sobě. SQL funkce to hlídá znovu. */
export function canSetCapacity(viewer: CapacityViewer | null, memberId: string): boolean {
  if (!viewer) return false
  return viewer.isAdmin || viewer.teamRole === 'vedeni' || viewer.id === memberId
}

// ---------------------------------------------------------------------------
// Cíl alokace: dodávka NEBO případ (CHECK allocation_one_target)

export type AllocationTargetRef =
  | { engagement_id: number; work_case_id: null }
  | { engagement_id: null; work_case_id: number }

const TARGET_RE = /^(engagement|case):([1-9]\d{0,15})$/

/** Hodnota pro <select>: „engagement:12" / „case:5". */
export function targetKey(ref: AllocationTargetRef): string {
  return ref.engagement_id !== null ? `engagement:${ref.engagement_id}` : `case:${ref.work_case_id}`
}

export function parseTargetKey(v: unknown): AllocationTargetRef | null {
  if (typeof v !== 'string') return null
  const m = TARGET_RE.exec(v.trim())
  if (!m) return null
  const id = Number(m[2])
  if (!Number.isSafeInteger(id)) return null
  return m[1] === 'engagement' ? { engagement_id: id, work_case_id: null } : { engagement_id: null, work_case_id: id }
}

// ---------------------------------------------------------------------------
// Vstupy formulářů (zod). Sdílí je server akce i testy.

const round1 = (n: number) => Math.round(n * 10) / 10

// „7,5" i „7.5"; prázdné = chybí; cokoli jiného NaN (→ chyba typu).
function hoursInput(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim().replace(',', '.')
  if (t === '') return undefined
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN
}

const blankToNull = (v: unknown) => (v === '' || v == null ? null : v)

const dayField = z.string({ error: 'Vyplň datum.' }).refine(isIsoDay, 'Neplatné datum.')
const optionalDay = z.preprocess(blankToNull, dayField.nullable())
const optionalUuid = z.preprocess(blankToNull, z.uuid('Neplatný člen týmu.').nullable())
const noteField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v ?? null),
  z.string().trim().max(NOTE_MAX, `Poznámka má nejvýš ${NOTE_MAX} znaků.`).nullable(),
)

const hoursPerWeekField = z.preprocess(
  hoursInput,
  z
    .number({ error: 'Zadej počet hodin týdně.' })
    .min(0.1, 'Alokace musí mít aspoň 0,1 hodiny týdně.')
    .max(MAX_WEEKLY_HOURS, `Nejvýš ${MAX_WEEKLY_HOURS} hodin týdně.`)
    .transform(round1),
)

const capacityField = z.preprocess(
  hoursInput,
  z
    .number({ error: 'Zadej kapacitu v hodinách týdně.' })
    .min(0, 'Kapacita nemůže být záporná.')
    .max(MAX_WEEKLY_HOURS, `Nejvýš ${MAX_WEEKLY_HOURS} hodin týdně.`)
    .transform(round1),
)

const periodFields = {
  hours_per_week: hoursPerWeekField,
  starts_on: dayField,
  ends_on: optionalDay,
  substitute_id: optionalUuid,
  note: noteField,
}

const updateSchema = z.object(periodFields)
const createSchema = z.object({ ...periodFields, member_id: z.uuid('Vyber člena týmu.') })
const capacitySchema = z.object({ weekly_capacity_hours: capacityField })

export type AllocationUpdate = z.infer<typeof updateSchema>
// Plochý tvar pro insert (supabase-js typy nesnesou union cíle); že je
// vyplněný právě jeden cíl, zaručuje parseAllocationCreate a CHECK v DB.
export type AllocationInsert = z.infer<typeof createSchema> & { engagement_id: number | null; work_case_id: number | null }

export type ParseResult<T> = { ok: true; data: T } | { ok: false; fieldErrors: Record<string, string> }

function fieldErrorsOf(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

function crossFieldErrors(v: { starts_on: string; ends_on: string | null; substitute_id: string | null }, memberId: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (v.ends_on !== null && v.ends_on < v.starts_on) out.ends_on = 'Konec nesmí být před začátkem.'
  if (memberId !== null && v.substitute_id === memberId) out.substitute_id = 'Zástup musí být jiný člověk než ten, kdo na tom pracuje.'
  return out
}

/**
 * Nová alokace z formuláře. `fixedTarget` = cíl daný stránkou (dodávka);
 * jinak se bere z pole `target` („engagement:12" / „case:5").
 */
export function parseAllocationCreate(
  input: Record<string, unknown>,
  fixedTarget: AllocationTargetRef | null = null,
): ParseResult<AllocationInsert> {
  const parsed = createSchema.safeParse(input)
  const errors = parsed.success ? {} : fieldErrorsOf(parsed.error)
  const target = fixedTarget ?? parseTargetKey(input.target)
  if (!target) errors.target = 'Vyber dodávku nebo případ.'
  if (parsed.success) Object.assign(errors, crossFieldErrors(parsed.data, parsed.data.member_id))
  if (!parsed.success || !target || Object.keys(errors).length) return { ok: false, fieldErrors: errors }
  return { ok: true, data: { ...parsed.data, ...target } }
}

/** Úprava alokace: člověk a cíl se nemění (pro jiného člověka = ukončit a přidat novou). */
export function parseAllocationUpdate(input: Record<string, unknown>, memberId: string): ParseResult<AllocationUpdate> {
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const errors = crossFieldErrors(parsed.data, memberId)
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors }
  return { ok: true, data: parsed.data }
}

export function parseCapacity(input: Record<string, unknown>): ParseResult<{ weekly_capacity_hours: number }> {
  const parsed = capacitySchema.safeParse(input)
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsOf(parsed.error) }
  return { ok: true, data: parsed.data }
}

// ---------------------------------------------------------------------------
// Formátování (bez Date — den je řetězec, pásmo serveru nehraje roli)

const hoursFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 })

/** 7.5 → „7,5" (bez jednotky, na desetiny). */
export function formatHoursValue(n: number): string {
  return hoursFmt.format(round1(n))
}

/** 7.5 → „7,5 h". */
export function formatHours(n: number): string {
  return `${formatHoursValue(n)} h`
}

/** Krátký popisek týdne: „T41". */
export function weekLabel(week: Pick<IsoWeek, 'week'>): string {
  return `T${week.week}`
}

/** „2026-10-01" → „1. 10. 2026". */
export function formatDay(day: string): string {
  return `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}. ${day.slice(0, 4)}`
}

/** Období alokace: „1. 10. 2026 – 30. 11. 2026" nebo „od 1. 10. 2026". */
export function formatPeriod(a: AllocationPeriod): string {
  return a.ends_on === null ? `od ${formatDay(a.starts_on)}` : `${formatDay(a.starts_on)} – ${formatDay(a.ends_on)}`
}

/** Rozsah týdne bez roku: „28. 9. – 4. 10.". */
export function formatWeekRange(week: IsoWeek): string {
  const d = (day: string) => `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}.`
  return `${d(week.start)} – ${d(week.end)}`
}
