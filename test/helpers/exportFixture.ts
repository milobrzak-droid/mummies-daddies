// Testovací data exportů (P9): obchody, verze nabídek a klienti s českými
// jmény (diakritika ve všech výstupech). Vymyšlená data, žádná síť.
import type { SalesDealLike } from '@/domain/crm/sales'
import type { OfferExportRow } from '@/domain/crm/exports'
import type { AccountListRow } from '@/domain/crm/queries/accountList'
import type { Contact, DealStage } from '@/lib/types'

export const OWNER_JANA = { id: '11111111-1111-4111-8111-111111111111', full_name: 'Jana Dvořáková', email: 'jana@example.cz' }
export const OWNER_PETR = { id: '22222222-2222-4222-8222-222222222222', full_name: 'Petr Šťastný', email: 'petr@example.cz' }

export function deal(p: Partial<SalesDealLike> & { id: number; stage: DealStage }): SalesDealLike {
  return {
    account_id: p.id * 10,
    title: `Obchod ${p.id}`,
    revenue_line: 'catering_firemni',
    revenue_category: 'one_time',
    probability_pct: null,
    amount_one_time: 100_000,
    cogs_one_time: null,
    expected_mrr: null,
    currency: 'CZK',
    amount_one_time_original: null,
    fx_rate: null,
    subsidy_program: null,
    subsidy_pct: null,
    sourced_by_partner: null,
    expected_close: null,
    won_at: null,
    client_paid_one_time: null,
    pillar: 'b2b_akce',
    phase: null,
    delivery_team: null,
    note: null,
    status_done: null,
    status_next: null,
    status_blocker: null,
    dev_team: [],
    estimate_md: null,
    delivery_lane: null,
    source_pdf_path: null,
    owner_id: OWNER_JANA.id,
    primary_contact_id: null,
    next_step: 'Zavolat a potvrdit menu',
    next_step_due: '2026-11-12',
    no_next_step_reason: null,
    deal_kind: 'implementace',
    lost_reason: null,
    closed_at: null,
    last_activity_at: '2026-11-03T13:45:00Z',
    forecast_category: 'pipeline',
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-11-03T13:45:00Z',
    account: { id: p.id * 10, name: `Firma ${p.id}` },
    owner: OWNER_JANA,
    primary_contact: null,
    ...p,
  } as SalesDealLike
}

/** Týden 45/2026: po 2. 11. – ne 8. 11. (pražský čas). */
export const WEEK_45 = {
  since: new Date('2026-11-01T23:00:00Z'),
  until: new Date('2026-11-08T23:00:00Z'),
  label: 'za týden 45: po 2. 11. až ne 8. 11.',
}

export const SAMPLE_DEALS: SalesDealLike[] = [
  deal({ id: 1, stage: 'kvalifikace', title: 'Vánoční večírek — 120 hostů', account: { id: 10, name: 'Účetní kancelář Šťastná s.r.o.' }, amount_one_time: 186_000, created_at: '2026-11-03T09:10:00Z', pillar: 'b2b_akce', next_step: 'Poslat návrh menu a ověřit bezlepkové porce', next_step_due: '2026-11-10' }),
  deal({ id: 2, stage: 'rozsah_nabidka', title: 'Svatební hostina Novákovi', account: { id: 20, name: 'Kateřina Nováková' }, amount_one_time: 245_500, pillar: 'b2c_oslavy', deal_kind: 'implementace', owner_id: OWNER_PETR.id, owner: OWNER_PETR, next_step: 'Degustace v pátek', next_step_due: '2026-11-07', source_pdf_path: 'nabidky/novakovi.pdf' }),
  deal({ id: 3, stage: 'rozhodovani', title: 'Coffee break na konferenci', account: { id: 30, name: 'Žlutý kůň, a.s.' }, amount_one_time: 64_000, created_at: '2026-11-05T12:00:00Z', deal_kind: 'workshop' }),
  deal({ id: 4, stage: 'vyhráno', title: 'Firemní oběd — 80 hostů', account: { id: 40, name: 'Říčany Logistika s.r.o.' }, amount_one_time: 96_750, won_at: '2026-11-04', closed_at: '2026-11-04', next_step: null, next_step_due: null }),
  deal({ id: 5, stage: 'prohráno', title: 'Grilování pro tým', account: { id: 50, name: 'Ďáblice Development' }, amount_one_time: 52_000, closed_at: '2026-11-06', lost_reason: 'cena', next_step: null, next_step_due: null, deal_kind: null, sourced_by_partner: 7 }),
  deal({ id: 6, stage: 'prohráno', title: 'Starý lead', amount_one_time: 10_000, closed_at: '2026-10-01', lost_reason: 'Jiný termín, ozvou se na jaře' }),
  deal({ id: 7, stage: 'odloženo', title: 'Piknik na jaře', amount_one_time: 20_000, lost_reason: 'termin' }),
]

export function offer(p: Partial<OfferExportRow> & { id: number }): OfferExportRow {
  return {
    deal_id: 2,
    version: 1,
    scope: 'Svatební hostina pro 120 hostů: předkrm, polévka, hlavní chod, večerní raut, obsluha 6 číšníků.',
    amount_one_time: 245_500,
    expected_mrr: 0,
    currency: 'CZK',
    status: 'sent',
    sent_at: '2026-11-04T10:00:00Z',
    decided_at: null,
    evidence_id: null,
    created_by: OWNER_PETR.id,
    created_at: '2026-11-04T09:00:00Z',
    deal: { id: 2, title: 'Svatební hostina Novákovi', account: { id: 20, name: 'Kateřina Nováková' } },
    ...p,
  }
}

export const SAMPLE_OFFERS: OfferExportRow[] = [
  offer({ id: 101 }),
  offer({ id: 102, version: 2, status: 'draft', sent_at: null, created_at: '2026-11-06T09:00:00Z', amount_one_time: 238_000 }),
  offer({ id: 103, deal_id: 1, status: 'superseded', sent_at: '2026-10-10T09:00:00Z', created_at: '2026-10-10T08:00:00Z', deal: { id: 1, title: 'Vánoční večírek — 120 hostů', account: { id: 10, name: 'Účetní kancelář Šťastná s.r.o.' } } }),
]

export function account(p: Partial<AccountListRow> & { id: number; name: string }): AccountListRow {
  return {
    ico: null, industry: 'Gastronomie', region: 'Praha', client_since: null, owner_id: OWNER_JANA.id,
    last_inbound_at: '2026-11-02T10:00:00Z', last_outbound_at: '2026-11-03T10:00:00Z',
    owner: { id: OWNER_JANA.id, full_name: OWNER_JANA.full_name }, referred_by: null,
    ...p,
  }
}

export function contact(p: Partial<Contact> & { id: number; full_name: string }): Contact {
  return {
    account_id: null, partner_id: null, role: null, email: null, phone: null, notes: null,
    is_champion: false, created_at: '2026-09-01T08:00:00Z', ...p,
  }
}
