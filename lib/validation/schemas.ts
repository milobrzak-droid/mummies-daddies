import { z } from 'zod'
import { DEAL_KIND_KEYS, DEAL_STAGE_KEYS, DO_NOT_CONTACT_REASON_MAX } from '@/lib/domain'

// helpers
const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v)
const optText = z.preprocess(emptyToNull, z.string().nullable())
const optInt = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : Number(v)),
  z.number().int().nullable(),
)
const optNum = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : Number(v)),
  z.number().nullable(),
)
const bool = z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean())
// Brány dodávky mají tři stavy: splněno, nesplněno a ještě nehodnoceno.
// `bool` výš mapuje cokoli jiného než true na false, čímž by se
// „nehodnoceno" tiše vydávalo za „nesplněno" — a to je u posuzování
// kvality dodávky ten podstatný rozdíl.
const triBool = z.preprocess(
  (v) => (v === '' || v === null || v === undefined
    ? null
    : v === true || v === 'true' || v === 'on' || v === 'yes'),
  z.boolean().nullable(),
)
// comma-separated text input → string[] (e.g. "Jirka, Vítek" → ['Jirka','Vítek'])
const strArray = z.preprocess(
  (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
  z.array(z.string()),
)

export const revenueLine = z.enum([
  'catering_firemni','oslava_soukroma','svatebni_hostina','cheesecaky_eshop',
  'firemni_pravidelny','pronajem_prostor','provize',
])
export const revenueCategory = z.enum(['one_time','recurring','royalty'])
// Klíče fází z DEAL_STAGES (lib/domain.ts) — žádná ručně psaná kopie.
export const dealStage = z.enum(DEAL_STAGE_KEYS)
export const deliveryPhase = z.enum([
  'sm_diagnostika','workshopy','analyza','pilot','implementace','podpora','mereni_6m','uzavreno',
])
export const partnerProgram = z.enum([
  'dodavatel_napoju','pronajem_vybaveni','eventova_agentura','svatebni_agentura',
  'pronajimatel_prostor','doporuceni','logistika',
])
export const registrationStatus = z.enum([
  'none','prospect','registered','certified','advanced','elite','cpor_claimed',
])
export const subsidyProgram = z.enum(['none','opz_plus','digi_pro_firmy','mpsv_rekvalifikace'])
export const dealCurrency = z.enum(['CZK','EUR'])
export const forecastCategory = z.enum(['pipeline','best_case','commit','closed'])
export const churnRisk = z.enum(['low','medium','high'])

export const accountSchema = z.object({
  name: z.string().min(1, 'Název je povinný.'),
  industry: optText,
  size_band: optText,
  is_reference: bool.default(false),
  ms_licenses: optInt,
  referred_by_partner_id: optInt,
  region: optText,
  web: optText,
  ico: optText,
  owner_id: optText,
  client_since: optText,
  notes: optText,
  // Čím firma je vlastními slovy — "co je to za firmu" z původního zadání.
  profile: optText,
  legal_form: optText,
  // Sloupec je date, ale formulář vždy posílá string; DB si to sama zparsuje.
  founded_on: optText,
  // nace je text[] plněné jen ARES prefillem (viz AccountForm) — pro ruční
  // zadávání pole kódů není smysluplné UI, proto tu záměrně není.
})
export type AccountInput = z.infer<typeof accountSchema>

// Kontakt patří buď klientovi, nebo partnerovi — id doplňuje server action
// podle toho, odkud se zakládá (viz DB CHECK contact_belongs_to_one).
// Nesouhlas s oslovením (0087): zaškrtávátko + krátký důvod (odkud/proč).
// Bez zaškrtnutí se důvod zahodí (DB by ho stejně vymazala triggerem).
// Kdy a kdo nesouhlas zapsal, doplňuje databáze — z formuláře to nejde.
export const contactSchema = z.object({
  full_name: z.string().min(1, 'Jméno je povinné.'),
  role: optText,
  email: optText,
  phone: optText,
  notes: optText,
  is_champion: bool.default(false),
  do_not_contact: bool.default(false),
  do_not_contact_reason: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.preprocess(emptyToNull, z.string().max(DO_NOT_CONTACT_REASON_MAX, `Důvod nesouhlasu může mít nejvýš ${DO_NOT_CONTACT_REASON_MAX} znaků.`).nullable()),
  ).optional().default(null),
}).transform((c) => (c.do_not_contact ? c : { ...c, do_not_contact_reason: null }))

// revenue_category is derived from revenue_line (schema note: "odvozeno od linky"),
// not user-chosen — this prevents a deal being saved with a mismatched category
// that would mis-bucket it in v_pipeline_by_line.
export const categoryForLine: Record<
  z.infer<typeof revenueLine>, z.infer<typeof revenueCategory>
> = {
  catering_firemni: 'one_time',
  oslava_soukroma: 'one_time',
  svatebni_hostina: 'one_time',
  cheesecaky_eshop: 'one_time',
  pronajem_prostor: 'one_time',
  firemni_pravidelny: 'recurring',
  provize: 'royalty',
}

// Výslovný důvod, proč otevřený obchod nemá další krok (migrace 0047).
const noNextStepReason = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
  z.string().max(500, 'Důvod může mít nejvýše 500 znaků.').nullable(),
)

// Pole příležitosti (migrace 0052). Prázdné = null, ořezané; délky stejné
// jako CHECKy v DB.
const boundedText = (max: number, label: string) => z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
  z.string().max(max, `${label} může mít nejvýše ${max} znaků.`).nullable(),
)
export const dealKind = z.enum(DEAL_KIND_KEYS)
const optDealKind = z.preprocess(
  (v) => (v === '' || v == null ? null : v),
  dealKind.nullable(),
)
const optIsoDate = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Zadej platné datum.').nullable(),
)

export const dealSchema = z.object({
  account_id: z.coerce.number().int(),
  title: z.string().min(1, 'Název je povinný.'),
  revenue_line: revenueLine,
  stage: dealStage.optional(),
  probability_pct: z.preprocess(
    (v) => (v === '' || v == null ? null : Number(v)),
    z.number().int().min(0).max(100).nullable(),
  ),
  amount_one_time: optNum,
  cogs_one_time: optNum,
  // Když currency = EUR, amount_one_time je ignorováno a přepočítá se ze
  // amount_one_time_original živým kurzem ČNB (viz domain/crm/actions/deals.ts).
  currency: dealCurrency.default('CZK'),
  amount_one_time_original: optNum,
  subsidy_program: subsidyProgram.default('none'),
  subsidy_pct: z.preprocess(
    (v) => (v === '' || v == null ? 0 : Number(v)),
    z.number().min(0).max(100),
  ),
  sourced_by_partner: optInt,
  expected_close: optText,
  won_at: optText,
  owner_id: optText,
  primary_contact_id: optInt,
  next_step: optText,
  next_step_due: optText,
  no_next_step_reason: noNextStepReason,
  // příležitost (0052)
  deal_kind: optDealKind,
  problem: boundedText(2000, 'Problém'),
  expected_outcome: boundedText(2000, 'Očekávaný výsledek'),
  decision_maker: boundedText(200, 'Rozhodovatel'),
  decision_process: boundedText(2000, 'Rozhodovací proces'),
  decision_due: optIsoDate,
  value_basis: boundedText(500, 'Zdroj odhadu hodnoty'),
  lost_reason: optText,
  forecast_category: forecastCategory.default('pipeline'),
  // pilíř + fáze + realizace
  pillar: optText,
  phase: optText,
  delivery_team: optText,
  // delivery
  note: optText,
  status_done: optText,
  status_next: optText,
  status_blocker: optText,
  dev_team: strArray,
  estimate_md: optInt,
  delivery_lane: optText,
}).superRefine((data, ctx) => {
  if (data.stage === 'prohráno' && !data.lost_reason) {
    ctx.addIssue({ code: 'custom', path: ['lost_reason'], message: 'U prohraného obchodu doplň důvod.' })
  }
})

export const dealPartnerSchema = z.object({
  deal_id: z.coerce.number().int(),
  partner_id: z.coerce.number().int(),
  program: partnerProgram,
  attribution_pct: optNum,
  is_sourcing: bool.default(false),
  nnpsa_target: optInt,
})

// seats má výchozí 1 (i prázdné pole je „aspoň jedno místo"), zatímco mrr
// je skutečně povinné — předplatné bez MRR by v Přehledu (v_mrr_health)
// tiše počítalo jako 0 Kč, což pro obchod není totéž jako „ještě nezadáno".
export const subscriptionSchema = z.object({
  account_id: z.coerce.number().int(),
  deal_id: optInt,
  product: z.string().min(1, 'Produkt je povinný.'),
  seats: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().min(0),
  ),
  // Prázdné pole (i jen mezery) = chybějící hodnota. Samotné z.coerce by
  // z '' / null udělalo Number('') = 0 a MRR by se tiše uložilo jako 0 Kč.
  mrr: z.preprocess(
    (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    z.coerce.number({ error: 'MRR je povinné.' }).min(0, 'MRR nemůže být záporné.'),
  ),
  started_on: optText,
  renewal_date: optText,
  ended_on: optText,
  churn_risk: churnRisk.default('low'),
  // DB CHECK health_score BETWEEN 0 AND 100 — ověřeno i tady, ať formulář
  // ohlásí chybu hned, ne až přes chybu z insertu.
  health_score: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? null : Number(v)),
    z.number().int().min(0).max(100).nullable(),
  ),
  is_ms_subsidized: bool.default(false),
})

export const engagementSchema = z.object({
  account_id: z.coerce.number().int(),
  deal_id: optInt,
  kind: z.string().min(1, 'Druh je povinný.'),
  phase: deliveryPhase,
  started_on: optText,
  due_on: optText,
  baseline_adoption_pct: optNum,
  baseline_captured_on: optText,
  copilot_licenses: optInt,
  post_adoption_pct: optNum,
  trained_count: optInt,
  time_saved_min_week: optInt,
  workshops_delivered: optInt,
  nnpsa: optInt,
  roi_czk_year: optNum,
  post_captured_on: optText,
  reference_worthy: bool.default(false),
  // ENTER DELIVERY STANDARD §13 — dodávka projde jen se všemi šesti.
  gate_outputs_captured: triBool.default(null),
  gate_ratios_respected: triBool.default(null),
  gate_peer_learning: triBool.default(null),
  gate_safety_followed: triBool.default(null),
  gate_next_steps_owned: triBool.default(null),
  gate_pack_delivered: triBool.default(null),
  deliverable_pack_url: optText,
  follow_up_checkpoint_on: optText,
})

export const referenceCardSchema = z.object({
  account_id: z.coerce.number().int(),
  engagement_id: optInt,
  headline: optText,
  approved_public: bool.default(false),
  is_ms_anchor: bool.default(false),
})

export const partnerSchema = z.object({
  name: z.string().min(1, 'Název je povinný.'),
  kind: optText,
  roles: strArray,
  via_partner_id: optInt,
})

export const partnerRegistrationSchema = z.object({
  partner_id: z.coerce.number().int(),
  program: partnerProgram,
  status: registrationStatus.default('none'),
  tier_note: optText,
  margin_pct: optNum,
})

export const teamRole = z.enum(['vedeni', 'obchodnik', 'projektak', 'lektor', 'partner'])
export const participantSchema = z.object({
  email: z.string().email('Neplatný e-mail.'),
  full_name: z.string().min(1, 'Jméno je povinné.'),
  password: z.string().min(8, 'Heslo musí mít aspoň 8 znaků.'),
  // Bez tiché výchozí hodnoty: role řídí viditelnost Byznysu a pravomoc
  // schvalování, admin ji musí vybrat vědomě (security review, migrace 0056).
  role: z.enum(teamRole.options, { error: 'Vyber roli.' }),
  is_admin: bool.default(false),
})
export type ParticipantInput = z.infer<typeof participantSchema>

export const resetPasswordSchema = z.object({
  password: z.string().min(8, 'Heslo musí mít aspoň 8 znaků.'),
})

// Zobrazované jméno — admin ho mění ostatním na /tym, každý sám sobě
// na /nastaveni. Ořezané mezery, 1..100 znaků (stejný horní limit jako
// jinde u volného textu v aplikaci, viz optText výše).
export const displayNameSchema = z.object({
  full_name: z.string().trim().min(1, 'Jméno je povinné.').max(100, 'Jméno je moc dlouhé (max 100 znaků).'),
})

export const taskStatus = z.enum(['todo', 'in_progress', 'blocked', 'done'])
export const taskPriority = z.enum(['low', 'normal', 'high'])

/** Skutečný kalendářní den YYYY-MM-DD v rozumném rozsahu (2026-02-30 ani 1900-01-01 neprojde). */
export function isRealDay(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return y >= 2000 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/** Termín úkolu pro posun (updateTaskDueOn): den, nebo null = bez termínu (Zpět u úkolu bez termínu). */
export const taskDueOn = z.union([
  z.null(),
  z.string().refine(isRealDay, 'Doplň platný termín.'),
])
export const taskSchema = z.object({
  title: z.string().min(1, 'Název je povinný.'),
  description: optText,
  status: taskStatus.default('todo'),
  priority: taskPriority.default('normal'),
  assignee_id: optText, // uuid or null
  due_on: optText,
  account_id: optInt,
  deal_id: optInt,
  engagement_id: optInt,
})

export const salesActivityKind = z.enum(['call', 'email', 'meeting', 'note', 'other'])
export const salesActivityOutcome = z.enum(['completed', 'no_answer', 'follow_up', 'cancelled'])
// Aktivita patří buď klientovi, nebo partnerovi — nikdy obojímu a nikdy
// ničemu (stejné pravidlo jako CHECK v migraci 0021 a jako v domain/crm/apiWrite.ts).
// Bez partnerské větve nešlo do CRM zapsat telefonát s BETA TRADEem nebo
// TAUPARTNERem, přes které chodí většina obchodů; obchodníkovi zbývalo nechat si
// to v hlavě.
export const salesActivitySchema = z.object({
  account_id: optInt,
  partner_id: optInt,
  deal_id: optInt,
  contact_id: optInt,
  kind: salesActivityKind,
  outcome: salesActivityOutcome.default('completed'),
  subject: z.string().trim().min(1, 'Předmět je povinný.'),
  body: optText,
  occurred_at: z.string().min(1, 'Datum aktivity je povinné.'),
  follow_up_on: optText,
}).refine(
  (v) => (v.account_id == null) !== (v.partner_id == null),
  { message: 'Vyber klienta, nebo partnera — právě jedno z toho.', path: ['account_id'] },
)

// Id entity předávané server akcím jako argument (accountId, aliasId,
// relationshipId). Server akce dostanou z klienta cokoli, TypeScript typ
// `number` za běhu nic nezaručuje, proto se před použitím v dotazu ověří:
// striktně číslo (žádné coerce z řetězce), celé, kladné, v bezpečném rozsahu.
export const entityId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

// Ověří najednou všechna id předaná akci — neplatné id nesmí dojít až k dotazu.
export function areEntityIds(...ids: unknown[]): boolean {
  return ids.every(id => entityId.safeParse(id).success)
}

// Počet dní odložení ve frontě oslovování (snoozeOutreach) — max. rok.
export const outreachSnoozeDays = z.number().int().min(1).max(365)

// Vstup foundAccountFromDomain (Firmy mimo CRM z importu schůzek). Doména je
// hostname (štítky z písmen/číslic/pomlček oddělené tečkou, max. 253 znaků),
// e-maily jsou jen skutečné adresy (max. 50 najednou) a zdroj je jen z hodnot,
// které appka opravdu posílá — jinak by šel do poznámky klienta libovolný text.
export const prospectSourceLabel = z.enum(['Wispr Flow'])
export const prospectFromDomainSchema = z.object({
  domain: z.string().trim().toLowerCase().max(253)
    .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Neplatná doména.'),
  emails: z.array(z.string().trim().pipe(z.email().max(320))).max(50),
  sourceLabel: prospectSourceLabel,
})

// Alias domény/názvu (0033) — aspoň jedna hodnota musí být vyplněná, jinak
// by řádek k ničemu neodkazoval (stejné pravidlo jako CHECK company_alias_has_value).
// Hodnoty se normalizují (trim + lowercase, prázdné/bílé znaky = null) a mají
// horní mez délky: doména max 253 (limit DNS), název max 200.
const aliasText = (max: number) => z.preprocess(
  (v) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v),
  z.string().trim().toLowerCase().max(max, `Nejvýše ${max} znaků.`).nullable(),
)
export const ALIAS_DOMAIN_MAX = 253
export const ALIAS_NAME_MAX = 200
export const companyAliasSchema = z.object({
  alias_domain: aliasText(ALIAS_DOMAIN_MAX),
  alias_name: aliasText(ALIAS_NAME_MAX),
}).refine(
  (v) => v.alias_domain != null || v.alias_name != null,
  { message: 'Vyplň doménu, nebo název.', path: ['alias_domain'] },
)

// Mateřský/dceřiný vztah (0033) — formulář se ptá na směr vůči aktuální
// firmě ("je mateřská pro" / "je dceřiná od") a druhou firmu; server action
// z toho dopočítá parent_account_id/child_account_id (viz
// domain/crm/actions/companyRelationships.ts).
export const relationshipDirection = z.enum(['parent_of', 'child_of'])
export const companyRelationshipSchema = z.object({
  direction: relationshipDirection,
  // Z formuláře přichází řetězec, proto coerce; kladné celé číslo vynucuje
  // i prázdnou hodnotu (Number('') = 0) a záporná id.
  other_account_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

// Id člena týmu (auth.users.id) — UUID, jinak akce nic nedělá.
export const teamMemberId = z.string().uuid()

// Název API klíče: ořezaný, 1–100 znaků.
export const apiKeyName = z
  .string()
  .trim()
  .min(1, 'Název je povinný.')
  .max(100, 'Název může mít nejvýš 100 znaků.')
