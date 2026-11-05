// Statická kontrola migrace 0085 (schůzky podle Outlooku) — bez databáze.
// Obecné konvence (číslování, ledger, search_path) hlídá
// test/migrations-lint.test.ts; tady jde o to, co 0085 slibuje v hlavičce.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { DB_AUDITED_TABLES } from '@/core/auditCoverage'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const sql = strip(readFileSync('supabase/migrations/0085_meeting_calendar_sync.sql', 'utf8'))

describe('0085 — schůzky podle Outlooku', () => {
  test('guard je první příkaz a jmenuje závislosti', () => {
    expect(sql.trim().startsWith('DO $$')).toBe(true)
    for (const dep of ['0020_core_sales_crm.sql', '0022_planned_meetings.sql', '0042_engagement_milestone.sql', '0026_migration_ledger.sql']) {
      expect(sql).toContain(dep)
    }
  })

  test('jen nové sloupce (IF NOT EXISTS), žádná nová tabulka, žádné přepisování dat', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i)
    expect(sql).not.toMatch(/\bUPDATE\s+(sales_activity|engagement_milestone)\b/i)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).toMatch(/ALTER TABLE sales_activity\s+ADD COLUMN IF NOT EXISTS milestone_id bigint REFERENCES engagement_milestone\(id\) ON DELETE SET NULL/)
    expect(sql).toMatch(/ALTER TABLE sales_activity\s+ADD COLUMN IF NOT EXISTS note_received_at timestamptz/)
    expect(sql).toMatch(/ALTER TABLE engagement_milestone\s+ADD COLUMN IF NOT EXISTS due_from_activity_id bigint REFERENCES sales_activity\(id\) ON DELETE SET NULL/)
  })

  test('převzatý termín milníku musí existovat (CHECK přidaný jen jednou)', () => {
    expect(sql).toMatch(/conname = 'engagement_milestone_due_from_activity_check'/)
    expect(sql).toMatch(/CHECK \(due_from_activity_id IS NULL OR due_on IS NOT NULL\)/)
  })

  test('indexy jsou idempotentní a kryjí cizí klíče', () => {
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?(\w+)/g)]
    expect(indexes.map((m) => m[2]).sort()).toEqual([
      'engagement_milestone_due_from_activity_idx',
      'sales_activity_milestone_idx',
      'sales_activity_note_received_idx',
      'sales_activity_planned_event_idx',
    ])
    for (const idx of indexes) expect(idx[1], idx[2]).toBeTruthy()
  })

  test('strážce původu: člověk vazbu nenastaví, změnou termínu ji zruší; server smí vše', () => {
    const m = /CREATE OR REPLACE FUNCTION engagement_milestone_due_source_guard\(\)([\s\S]*?)AS \$\$([\s\S]*?)\$\$;/.exec(sql)
    expect(m).not.toBeNull()
    const [, header, body] = m!
    expect(header).not.toMatch(/SECURITY DEFINER/)
    expect(header).toMatch(/SET search_path = public, pg_temp/)
    expect(body).toMatch(/IF auth\.uid\(\) IS NULL THEN\s+RETURN NEW;/)
    expect(body).toMatch(/TG_OP = 'INSERT'[\s\S]*?NEW\.due_from_activity_id IS NOT NULL[\s\S]*?RAISE EXCEPTION/)
    expect(body).toMatch(/NEW\.due_from_activity_id IS DISTINCT FROM OLD\.due_from_activity_id[\s\S]*?RAISE EXCEPTION/)
    expect(body).toMatch(/NEW\.due_on IS DISTINCT FROM OLD\.due_on THEN\s+NEW\.due_from_activity_id := NULL;/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION engagement_milestone_due_source_guard\(\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toContain('DROP TRIGGER IF EXISTS engagement_milestone_due_source_guard ON engagement_milestone;')
    expect(sql).toMatch(/CREATE TRIGGER engagement_milestone_due_source_guard\s+BEFORE INSERT OR UPDATE ON engagement_milestone/)
  })

  test('ledger nese 0085 a opakovaný běh nic nezdvojí', () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0085'/)
    expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
  })

  test('audit: hodnoty, na kterých stojí „Co se změnilo", jsou v allow-listu 0064', () => {
    for (const col of ['occurred_at', 'outcome', 'follow_up_on']) expect(DB_AUDITED_TABLES.sales_activity.safe).toContain(col)
    expect(DB_AUDITED_TABLES.engagement_milestone.safe).toContain('due_on')
    // Nové sloupce se do auditu zapisují jen názvem (nejsou v allow-listu).
    expect(DB_AUDITED_TABLES.sales_activity.safe).not.toContain('note_received_at')
  })
})
