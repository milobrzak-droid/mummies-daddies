import { describe, expect, test } from 'vitest'
import {
  AUDIT_ACTOR_HEADER,
  AUDIT_ACTOR_RE,
  AUDIT_EVIDENCE_HEADER,
  AUDIT_INFO_STATE_HEADER,
  DB_AUDITED_TABLES,
  DEAL_AUDIT_0035_COLUMNS,
  NEVER_SAFE_COLUMNS,
  NEVER_SAFE_EXCEPTIONS,
  auditActorHeaderValue,
  auditContextHeaders,
  auditRowPayload,
  isAuditSafeColumn,
  isDbAuditedTable,
} from '@/core/auditCoverage'

// Čistá pravidla auditu řádkových změn (zrcadlo SQL audit_row_change z 0064):
// které hodnoty smí do audit_event, co je jen název sloupce a kdy se nic
// nezapisuje.

const tables = Object.entries(DB_AUDITED_TABLES)

describe('allow-listy hodnot', () => {
  test.each(tables)('%s: žádný osobní ani volný text, nic zároveň ignorované', (_t, cfg) => {
    // Výjimka jen tam, kde stejný název sloupce není volný text (team_member.role = enum oprávnění).
    for (const c of cfg.safe) if (!NEVER_SAFE_EXCEPTIONS[_t]?.includes(c)) expect(NEVER_SAFE_COLUMNS, c).not.toContain(c)
    for (const c of cfg.safe) expect(cfg.ignore, c).not.toContain(c)
    expect([...cfg.safe]).toEqual([...cfg.safe].sort())
    expect([...cfg.ignore]).toEqual([...cfg.ignore].sort())
    if (cfg.evidenceColumn) expect(cfg.safe).toContain(cfg.evidenceColumn)
  })

  test('kontakt, úkol a aktivita: jen id, stavy a data — jako 0037 a auditPayload.ts', () => {
    // 0087: nesouhlas s oslovením (příznak, kdy, kdo) s hodnotou; důvod nikdy.
    expect(DB_AUDITED_TABLES.contact.safe).toEqual(['account_id', 'do_not_contact', 'do_not_contact_at', 'do_not_contact_by', 'is_champion', 'partner_id'])
    expect(isAuditSafeColumn('contact', 'do_not_contact_reason')).toBe(false)
    for (const c of ['title', 'description']) expect(isAuditSafeColumn('task', c)).toBe(false)
    for (const c of ['subject', 'body', 'external_id']) expect(isAuditSafeColumn('sales_activity', c)).toBe(false)
  })

  test('isAuditSafeColumn: neznámá tabulka nebo sloupec = ne', () => {
    expect(isAuditSafeColumn('account', 'owner_id')).toBe(true)
    expect(isAuditSafeColumn('account', 'name')).toBe(false)
    expect(isAuditSafeColumn('account', 'nový_sloupec')).toBe(false)
    // team_member: oprávnění s hodnotou, e-mail a jméno nikdy (0082).
    expect(isAuditSafeColumn('team_member', 'role')).toBe(true)
    expect(isAuditSafeColumn('team_member', 'email')).toBe(false)
    expect(isAuditSafeColumn('team_member', 'full_name')).toBe(false)
    expect(isAuditSafeColumn('contact', 'role')).toBe(false)
    expect(isDbAuditedTable('audit_event')).toBe(false)
    expect(isDbAuditedTable('toString')).toBe(false)
  })

  test('obchod: obecný trigger jen na UPDATE a nikdy sloupce auditované 0034/0035 (nikdy obojí)', () => {
    const deal = DB_AUDITED_TABLES.deal
    expect(deal.ops).toEqual(['UPDATE'])
    for (const c of DEAL_AUDIT_0035_COLUMNS) {
      expect(deal.ignore).toContain(c)
      expect(deal.safe).not.toContain(c)
    }
  })

  test('peníze mimo obchodní tabulky nejdou jako hodnota (ROI dodávky, marže partnera)', () => {
    expect(isAuditSafeColumn('engagement', 'roi_czk_year')).toBe(false)
    expect(isAuditSafeColumn('partner_registration', 'margin_pct')).toBe(false)
  })
})

describe('auditRowPayload — zrcadlo audit_row_change', () => {
  test('vznik: hodnoty jen bezpečných sloupců, _columns = vyplněné sloupce bez id/created_at', () => {
    const p = auditRowPayload('contact', 'INSERT', null, {
      id: 42, account_id: 7, full_name: 'Jan Novák', email: 'jan@firma.cz', role: null, is_champion: false,
      partner_id: null, created_at: '2026-09-28',
    })
    expect(p).toEqual({
      action: 'contact.created',
      before: null,
      after: { account_id: 7, is_champion: false, _columns: ['account_id', 'email', 'full_name', 'is_champion'] },
    })
    expect(JSON.stringify(p)).not.toMatch(/Novák|jan@firma/)
  })

  test('nesouhlas s oslovením (0087): příznak, kdy a kdo s hodnotou, důvod jen jménem', () => {
    const before = { id: 42, account_id: 7, do_not_contact: false, do_not_contact_at: null, do_not_contact_by: null, do_not_contact_reason: null }
    const after = { ...before, do_not_contact: true, do_not_contact_at: '2026-09-29T10:00:00+00:00', do_not_contact_by: 'u-1',
      do_not_contact_reason: 'Paní Nováková to řekla na veletrhu' }
    const p = auditRowPayload('contact', 'UPDATE', before, after)
    expect(p).toEqual({
      action: 'contact.updated',
      before: { do_not_contact: false, do_not_contact_at: null, do_not_contact_by: null },
      after: {
        do_not_contact: true, do_not_contact_at: '2026-09-29T10:00:00+00:00', do_not_contact_by: 'u-1',
        _columns: ['do_not_contact', 'do_not_contact_at', 'do_not_contact_by', 'do_not_contact_reason'],
      },
    })
    expect(JSON.stringify(p)).not.toMatch(/Nováková|veletrhu/)
  })

  test('úprava: jen změněné sloupce; text jen jménem', () => {
    const before = { id: 3, title: 'Zavolat panu Novákovi', status: 'todo', due_on: null, updated_at: 'a' }
    const after = { id: 3, title: 'Zavolat paní Svobodové', status: 'done', due_on: null, updated_at: 'b' }
    expect(auditRowPayload('task', 'UPDATE', before, after)).toEqual({
      action: 'task.updated',
      before: { status: 'todo' },
      after: { status: 'done', _columns: ['status', 'title'] },
    })
  })

  test('úprava jen ignorovaných sloupců nezaloží událost', () => {
    expect(auditRowPayload('account', 'UPDATE',
      { id: 1, last_inbound_at: 'a', updated_at: 'a' },
      { id: 1, last_inbound_at: 'b', updated_at: 'b' })).toBeNull()
    expect(auditRowPayload('task', 'UPDATE', { id: 1, ms_event_id: null }, { id: 1, ms_event_id: 'AAMk' })).toBeNull()
    // GDPR redakce aktivity (jen subject/body) — zapisuje ji appka jako sales_activity.redacted
    expect(auditRowPayload('sales_activity', 'UPDATE',
      { id: 1, subject: 'Jan Novák', body: 'x' }, { id: 1, subject: '[odstraněno]', body: 'x' })).toBeNull()
  })

  test('obchod: cena/fáze nic (0034/0035), další krok jen jménem, termín s hodnotou', () => {
    expect(auditRowPayload('deal', 'UPDATE',
      { id: 5, stage: 'kvalifikace', amount_one_time: 1 }, { id: 5, stage: 'diagnostika', amount_one_time: 2 })).toBeNull()
    expect(auditRowPayload('deal', 'UPDATE',
      { id: 5, next_step: null, next_step_due: null, stage: 'kvalifikace' },
      { id: 5, next_step: 'zavolat panu Novákovi', next_step_due: '2026-10-01', stage: 'diagnostika' })).toEqual({
      action: 'deal.updated',
      before: { next_step_due: null },
      after: { next_step_due: '2026-10-01', _columns: ['next_step', 'next_step_due'] },
    })
    expect(auditRowPayload('deal', 'INSERT', null, { id: 5 })).toBeNull()
    expect(auditRowPayload('deal', 'DELETE', { id: 5 }, null)).toBeNull()
  })

  test('smazání: before s bezpečnými hodnotami a názvy vyplněných sloupců, after null', () => {
    expect(auditRowPayload('relationship', 'DELETE',
      { id: 9, parent_account_id: 1, child_account_id: 2, relationship_type: 'subsidiary', created_at: 'x' }, null)).toEqual({
      action: 'relationship.deleted',
      before: {
        child_account_id: 2, parent_account_id: 1, relationship_type: 'subsidiary',
        _columns: ['child_account_id', 'parent_account_id', 'relationship_type'],
      },
      after: null,
    })
  })

  test('nekrytá tabulka = žádná událost', () => {
    expect(auditRowPayload('audit_event', 'UPDATE', { id: 1, role: 'a' }, { id: 1, role: 'b' })).toBeNull()
  })
})

describe('hlavičky servisního zápisu', () => {
  test('aktér: typ:id, bez id jen typ; neplatné se vynechá', () => {
    expect(auditActorHeaderValue({ type: 'api_key', id: '3f2a-b' })).toBe('api_key:3f2a-b')
    expect(auditActorHeaderValue({ type: 'api_key', id: null })).toBe('api_key')
    expect(auditActorHeaderValue({ type: 'system', id: 'job:outlook-mail' })).toBe('system:job:outlook-mail')
    expect(auditActorHeaderValue({ type: 'user', id: 'x y' })).toBeNull()
    expect(auditActorHeaderValue({ type: 'user', id: 'a'.repeat(129) })).toBeNull()
    expect(AUDIT_ACTOR_RE.test('admin:root')).toBe(false)
  })

  test('evidence jen kladné celé číslo, stav jen jeden ze čtyř', () => {
    expect(auditContextHeaders({ actor: { type: 'user', id: 'u' }, evidenceId: 41, infoState: 'human_confirmed' })).toEqual({
      [AUDIT_ACTOR_HEADER]: 'user:u', [AUDIT_EVIDENCE_HEADER]: '41', [AUDIT_INFO_STATE_HEADER]: 'human_confirmed',
    })
    expect(auditContextHeaders({ actor: { type: 'user', id: 'u' }, evidenceId: 0 })).toEqual({ [AUDIT_ACTOR_HEADER]: 'user:u' })
    expect(auditContextHeaders({ actor: { type: 'user', id: 'u' }, evidenceId: -1, infoState: null })).toEqual({ [AUDIT_ACTOR_HEADER]: 'user:u' })
    expect(auditContextHeaders({
      actor: { type: 'user', id: 'x y' },
      infoState: 'bogus' as never,
    })).toEqual({})
  })
})
