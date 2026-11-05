import type { DealKind, DealStageKey, Pillar } from '@/lib/domain'

export type RevenueCategory = 'one_time' | 'recurring' | 'royalty'
export type RevenueLine =
  | 'catering_firemni' | 'oslava_soukroma' | 'svatebni_hostina' | 'cheesecaky_eshop'
  | 'firemni_pravidelny' | 'pronajem_prostor' | 'provize'
// Fáze obchodu — odvozeno z DEAL_STAGES (lib/domain.ts), jediný zdroj pravdy.
export type DealStage = DealStageKey
export type ForecastCategory = 'pipeline' | 'best_case' | 'commit' | 'closed'
export type DeliveryPhase =
  | 'sm_diagnostika' | 'workshopy' | 'analyza' | 'pilot' | 'implementace'
  | 'podpora' | 'mereni_6m' | 'uzavreno'
export type PartnerProgram =
  | 'dodavatel_napoju' | 'pronajem_vybaveni' | 'eventova_agentura' | 'svatebni_agentura'
  | 'pronajimatel_prostor' | 'doporuceni' | 'logistika'
export type RegistrationStatus =
  | 'none' | 'prospect' | 'registered' | 'certified' | 'advanced' | 'elite' | 'cpor_claimed'
export type SubsidyProgram = 'none' | 'opz_plus' | 'digi_pro_firmy' | 'mpsv_rekvalifikace'
export type DealCurrency = 'CZK' | 'EUR'
export type ChurnRisk = 'low' | 'medium' | 'high'
export type TeamRole = 'vedeni' | 'obchodnik' | 'projektak' | 'lektor' | 'partner'

// numeric columns come back as strings from PostgREST; keep them as string|number.
type Num = number | string | null

export interface Account {
  id: number; name: string; raynet_id: number | null; industry: string | null
  size_band: string | null; is_reference: boolean; ms_licenses: number | null
  referred_by_partner_id: number | null
  region: string | null; web: string | null; ico: string | null
  owner_id: string | null; client_since: string | null; notes: string | null
  // Karta firmy (0030): profile/legal_form/founded_on ručně nebo z ARES,
  // nace jen jako fakt z rejstříku (viz komentář v migraci a v AccountForm).
  profile: string | null; legal_form: string | null; founded_on: string | null
  nace: string[] | null
  created_at: string; updated_at: string
}
// Account with its referring partner + owner embedded (PostgREST to-one joins).
export type AccountWithReferrer = Account & {
  referred_by: { id: number; name: string } | null
  owner: { id: string; full_name: string } | null
}
export interface Contact {
  id: number; account_id: number | null; partner_id: number | null
  full_name: string; role: string | null
  email: string | null; phone: string | null; notes: string | null
  is_champion: boolean; created_at: string
  /** Nesouhlasí s oslovením (0087). Před migrací sloupce chybí → undefined. */
  do_not_contact?: boolean
  do_not_contact_at?: string | null
  do_not_contact_reason?: string | null
  do_not_contact_by?: string | null
}
export interface Partner { id: number; name: string; kind: string | null; is_referrer: boolean; roles: string[]; via_partner_id: number | null; created_at: string }
// Partner s embednutým „přes koho" (self-join přes via_partner_id).
export type PartnerWithVia = Partner & { via: { id: number; name: string } | null }
export interface PartnerRegistration {
  id: number; partner_id: number; program: PartnerProgram; status: RegistrationStatus
  tier_note: string | null; margin_pct: Num; updated_at: string
}
export interface Deal {
  id: number; account_id: number; title: string; revenue_line: RevenueLine
  revenue_category: RevenueCategory; stage: DealStage; probability_pct: number | null
  amount_one_time: Num; cogs_one_time: Num; expected_mrr: Num
  // amount_one_time je vždy v Kč (kanonická měna pro rollupy). Když byl
  // projekt zadaný v EUR, currency/original/fx_rate drží audit trail.
  currency: DealCurrency; amount_one_time_original: Num; fx_rate: Num
  subsidy_program: SubsidyProgram; subsidy_pct: Num
  sourced_by_partner: number | null; expected_close: string | null; won_at: string | null
  client_paid_one_time: Num
  // pilíř + fáze + realizace
  pillar: Pillar | null; phase: string | null; delivery_team: string | null
  // delivery (ported from the pipeline board)
  note: string | null; status_done: string | null; status_next: string | null
  status_blocker: string | null; dev_team: string[]; estimate_md: number | null
  delivery_lane: string | null
  source_pdf_path: string | null
  // sales CRM
  owner_id: string | null; primary_contact_id: number | null
  next_step: string | null; next_step_due: string | null
  // 0047; před nasazením migrace chybí (undefined) → bere se jako null.
  no_next_step_reason?: string | null
  // 0052 (příležitost); před nasazením migrace chybí (undefined).
  deal_kind?: DealKind | null
  problem?: string | null; expected_outcome?: string | null
  decision_maker?: string | null; decision_process?: string | null
  decision_due?: string | null; value_basis?: string | null
  lost_reason: string | null; closed_at: string | null
  last_activity_at: string | null; forecast_category: ForecastCategory
  created_at: string; updated_at: string
}
// Deal s embednutým kanálem (sourced_by_partner = přes koho/dodavatel).
export type DealWithChannel = Deal & { channel: { id: number; name: string } | null }
export interface DealPartner {
  deal_id: number; partner_id: number; program: PartnerProgram
  attribution_pct: Num; is_sourcing: boolean; nnpsa_target: number | null
}
export interface Subscription {
  id: number; account_id: number; deal_id: number | null; product: string
  seats: number; mrr: Num; started_on: string | null; renewal_date: string | null
  // null = běží. Ukončené předplatné se nemaže, jen se přestane počítat do
  // běžícího MRR — smazáním by se zpětně změnily už vykázané měsíce.
  ended_on: string | null
  churn_risk: ChurnRisk; health_score: number | null; is_ms_subsidized: boolean
  created_at: string
}
export interface Engagement {
  id: number; account_id: number; deal_id: number | null; kind: string
  phase: DeliveryPhase; started_on: string | null; due_on: string | null
  baseline_adoption_pct: Num; baseline_captured_on: string | null; copilot_licenses: number | null
  post_adoption_pct: Num; trained_count: number | null; time_saved_min_week: number | null
  workshops_delivered: number | null; nnpsa: number | null; roi_czk_year: Num
  post_captured_on: string | null; adoption_delta_pp: Num
  reference_worthy: boolean; created_at: string; updated_at: string
  // Kvalitativní brány podle ENTER DELIVERY STANDARD §13 — null znamená
  // „ještě nehodnoceno", což je jiná informace než „nesplněno".
  gate_outputs_captured: boolean | null
  gate_ratios_respected: boolean | null
  gate_peer_learning: boolean | null
  gate_safety_followed: boolean | null
  gate_next_steps_owned: boolean | null
  gate_pack_delivered: boolean | null
  deliverable_pack_url: string | null
  follow_up_checkpoint_on: string | null
  // Vlastnictví dodávky (0061). Volitelné: před nasazením 0061 sloupce chybí.
  owner_id?: string | null
  deputy_id?: string | null
  delivery_team?: string | null
  // Odkud dodávka vznikla (0080): 'manual' | 'auto_deal_won'. Před nasazením 0080 sloupec chybí.
  origin?: string | null
  // Hlavní metrika dopadu (0088). Před nasazením 0088 sloupce chybí.
  impact_metric_key?: string | null
  impact_metric_label?: string | null
  impact_metric_unit?: string | null
  impact_unmeasurable_reason?: string | null
  impact_unmeasurable_at?: string | null
  impact_unmeasurable_by?: string | null
}
export interface ReferenceCard {
  id: number; account_id: number; engagement_id: number | null; headline: string | null
  approved_public: boolean; used_in_deals: number; is_ms_anchor: boolean; created_at: string
  // Doložený souhlas klienta (0061). Před nasazením 0061 sloupce chybí.
  consent_evidence_id?: number | null
  consent_at?: string | null
}
export interface TeamMember {
  id: string; full_name: string; email: string; role: TeamRole; is_admin: boolean; created_at: string
}

export type SalesActivityKind = 'call' | 'email' | 'meeting' | 'note' | 'other'
export type SalesActivityOutcome = 'completed' | 'no_answer' | 'follow_up' | 'cancelled'
export interface SalesActivity {
  // Aktivita patří buď klientovi, nebo partnerovi (viz migrace 0021) —
  // velká část schůzek je s kanálem (BETA TRADE, TAUPARTNER), ne s koncovým klientem.
  id: number; account_id: number | null; partner_id: number | null
  deal_id: number | null; contact_id: number | null
  source: string | null; external_id: string | null
  kind: SalesActivityKind; outcome: SalesActivityOutcome
  subject: string; body: string | null; occurred_at: string; follow_up_on: string | null
  created_by: string | null; created_at: string
}
export interface ApiKey {
  id: number
  name: string
  key_prefix: string
  created_by: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  /** read / full / intake (0043, 0079); chybí u řádků načtených bez sloupce. */
  scope?: string
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done'
export type TaskPriority = 'low' | 'normal' | 'high'
export interface Task {
  id: number; title: string; description: string | null
  status: TaskStatus; priority: TaskPriority
  assignee_id: string | null; created_by: string | null; due_on: string | null
  account_id: number | null; deal_id: number | null; engagement_id: number | null
  ms_event_id: string | null; created_at: string; updated_at: string
  account?: { id: number; name: string } | null
  deal?: { id: number; title: string } | null
}
// Od 0031 se access_token/refresh_token v DB drží jen šifrované
// (access_token_encrypted/refresh_token_encrypted, bytea) — appka je nikdy
// nečte/nezapisuje přímo přes .select()/.update(), ale přes SECURITY
// DEFINER RPC calendar_token_get_decrypted/_upsert_encrypted/_update_tokens
// (viz connectors/graph/token.ts). Tenhle typ proto odpovídá návratové hodnotě
// calendar_token_get_decrypted, ne syrovému řádku tabulky.
export interface CalendarToken {
  provider: string; access_token: string | null
  refresh_token: string | null; expires_at: string | null; account_email: string | null
}

// Alias domény/názvu na kanonický účet (0033) — stejná firma pod jinou
// e-mailovou doménou (koupená značka, dceřinka s vlastní doménou), aniž by
// se řádky account slučovaly.
export interface CompanyAlias {
  id: number; account_id: number
  alias_domain: string | null; alias_name: string | null
  created_at: string
}
// Mateřský/dceřiný (nebo jiný směrovaný) vztah mezi dvěma účty (0033).
export interface Relationship {
  id: number; parent_account_id: number; child_account_id: number
  relationship_type: string; created_at: string
}
