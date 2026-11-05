import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  APPROVAL_STATUSES,
  DEFAULT_LEVEL,
  EXTERNAL_COMMITMENT,
  LEVELS,
  APPROVER_ROLES,
  canActorApprove,
  canTransitionApproval,
  decideApproval,
  isApprovalStatus,
  isLevel,
  isTerminalApproval,
  levelRank,
  minLevel,
  nodeRoleFor,
  needsApproval,
  requiredLevel,
  shouldExpire,
  type ApprovalRequestState,
  type ApprovalStatus,
  type AuthorityPolicy,
  type LoopNodeRow,
} from '@/core/authority'

const sql = readFileSync('supabase/migrations/0039_loop_core.sql', 'utf8')

function checkValues(name: string): string[] {
  const m = sql.match(new RegExp(`CONSTRAINT ${name}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)`))
  if (!m) throw new Error(`CHECK ${name} nenalezen`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

describe('synchronizace s migrací 0039', () => {
  test('úrovně', () => {
    expect(checkValues('approval_request_level_check')).toEqual([...LEVELS])
    expect(checkValues('authority_policy_level_check')).toEqual([...LEVELS])
  })
  test('stavy požadavku', () => {
    expect(checkValues('approval_request_status_check')).toEqual([...APPROVAL_STATUSES])
  })
  test('seed external_commitment = L2', () => {
    expect(sql).toMatch(/SELECT 'external_commitment', 'L2', true/)
  })
})

describe('úrovně', () => {
  test('guardy', () => {
    expect(isLevel('L3')).toBe(true)
    expect(isLevel('L5')).toBe(false)
    expect(isLevel('l2')).toBe(false)
    expect(isApprovalStatus('expired')).toBe(true)
    expect(isApprovalStatus('done')).toBe(false)
  })
  test('pořadí a minimum', () => {
    expect(levelRank('L1')).toBe(1)
    expect(levelRank('L4')).toBe(4)
    expect(minLevel('L3', 'L2')).toBe('L2')
    expect(minLevel('L1', 'L4')).toBe('L1')
  })
  test('schválení potřebuje jen L2', () => {
    expect(LEVELS.map(needsApproval)).toEqual([false, true, false, false])
  })
})

describe('requiredLevel', () => {
  const p = (action_kind: string, level: string, active = true): AuthorityPolicy => ({ action_kind, level, active })

  test('bez pravidel je externí závazek L2', () => {
    expect(requiredLevel([], EXTERNAL_COMMITMENT)).toBe('L2')
    expect(DEFAULT_LEVEL).toBe('L2')
  })
  test('neznámá činnost spadne na L2', () => {
    expect(requiredLevel([p('log_activity', 'L3')], 'neco_noveho')).toBe('L2')
  })
  test('aktivní pravidlo platí', () => {
    expect(requiredLevel([p('log_activity', 'L3')], 'log_activity')).toBe('L3')
    expect(requiredLevel([p('notify', 'L1')], 'notify')).toBe('L1')
  })
  test('pravomoc jde změnit daty (bez deploye)', () => {
    const before = [p(EXTERNAL_COMMITMENT, 'L2')]
    const after = [p(EXTERNAL_COMMITMENT, 'L2', false), p(EXTERNAL_COMMITMENT, 'L1')]
    expect(requiredLevel(before, EXTERNAL_COMMITMENT)).toBe('L2')
    expect(requiredLevel(after, EXTERNAL_COMMITMENT)).toBe('L1')
  })
  test('neaktivní pravidlo se ignoruje', () => {
    expect(requiredLevel([p('log_activity', 'L4', false)], 'log_activity')).toBe('L2')
  })
  test('neplatná úroveň = jako by pravidlo nebylo', () => {
    expect(requiredLevel([p('log_activity', 'L9')], 'log_activity')).toBe('L2')
    expect(requiredLevel([p('log_activity', '')], 'log_activity')).toBe('L2')
  })
  test('víc aktivních pravidel → nejnižší', () => {
    expect(requiredLevel([p('x', 'L4'), p('x', 'L1'), p('x', 'L3')], 'x')).toBe('L1')
  })
  test('shoda názvu činnosti je přesná', () => {
    expect(requiredLevel([p('log_activity', 'L3')], 'LOG_ACTIVITY')).toBe('L2')
  })
})

describe('stavový automat požadavku', () => {
  const allowed: [ApprovalStatus, ApprovalStatus][] = [
    ['pending', 'approved'], ['pending', 'rejected'], ['pending', 'expired'],
  ]
  test('úplná matice', () => {
    for (const from of APPROVAL_STATUSES) {
      for (const to of APPROVAL_STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to)
        expect(canTransitionApproval(from, to), `${from}→${to}`).toBe(expected)
      }
    }
  })
  test('konečné stavy', () => {
    expect(isTerminalApproval('pending')).toBe(false)
    for (const s of ['approved', 'rejected', 'expired'] as const) expect(isTerminalApproval(s)).toBe(true)
  })
})

describe('decideApproval', () => {
  const now = new Date('2026-09-28T10:00:00Z')
  const base: ApprovalRequestState = {
    status: 'pending',
    requested_level: 'L2',
    requested_by: 'system:agent',
    expires_at: null,
  }
  const boss = { id: 'user:1', role: 'vedeni' }

  test('vedení schválí L2', () => {
    expect(decideApproval(base, 'approved', boss, now)).toEqual({ ok: true, status: 'approved' })
  })
  test('zamítnutí', () => {
    expect(decideApproval(base, 'rejected', boss, now)).toEqual({ ok: true, status: 'rejected' })
  })
  test('konečný stav se nemění', () => {
    const r = decideApproval({ ...base, status: 'approved' }, 'rejected', boss, now)
    expect(r.ok).toBe(false)
  })
  test('po expiraci je výsledek expired', () => {
    const r = decideApproval({ ...base, expires_at: new Date('2026-09-28T09:00:00Z') }, 'approved', boss, now)
    expect(r).toEqual({ ok: true, status: 'expired' })
  })
  test('expirace přesně v okamžiku now', () => {
    expect(decideApproval({ ...base, expires_at: now }, 'approved', boss, now)).toEqual({ ok: true, status: 'expired' })
  })
  test('před expirací lze schválit', () => {
    const r = decideApproval({ ...base, expires_at: new Date('2026-09-29T00:00:00Z') }, 'approved', boss, now)
    expect(r).toEqual({ ok: true, status: 'approved' })
  })
  test('čtyři oči: žadatel si neschvaluje', () => {
    const r = decideApproval({ ...base, requested_by: 'user:1' }, 'approved', boss, now)
    expect(r).toEqual({ ok: false, reason: 'žadatel nesmí rozhodovat o vlastním požadavku' })
  })
  test('nedostatečná role', () => {
    const r = decideApproval({ ...base, requested_level: 'L3' }, 'approved', { id: 'user:2', role: 'node_deputy' }, now)
    expect(r.ok).toBe(false)
  })
  test('systém nerozhoduje', () => {
    expect(decideApproval(base, 'approved', { id: 'system:x', role: 'system' }, now).ok).toBe(false)
  })
})

describe('shouldExpire', () => {
  const now = new Date('2026-09-28T10:00:00Z')
  test('pending po termínu', () => {
    expect(shouldExpire({ status: 'pending', expires_at: new Date('2026-09-27T00:00:00Z') }, now)).toBe(true)
  })
  test('bez termínu nikdy', () => {
    expect(shouldExpire({ status: 'pending', expires_at: null }, now)).toBe(false)
  })
  test('rozhodnutý nevyprší', () => {
    expect(shouldExpire({ status: 'approved', expires_at: new Date(0) }, now)).toBe(false)
  })
  test('před termínem ne', () => {
    expect(shouldExpire({ status: 'pending', expires_at: new Date('2026-10-01T00:00:00Z') }, now)).toBe(false)
  })
})

describe('canActorApprove (model rolí, rozhodnuto 2026-09-28)', () => {
  const table: Record<string, boolean[]> = {
    vedeni: [true, true, true, true],
    node_owner: [true, true, true, true],
    node_deputy: [true, true, false, false],
    member: [true, false, false, false],
    system: [false, false, false, false],
  }
  test('matice role × úroveň', () => {
    for (const role of APPROVER_ROLES) {
      expect(LEVELS.map((l) => canActorApprove(l, role)), role).toEqual(table[role])
    }
  })
  test('neznámá role nesmí nic', () => {
    for (const l of LEVELS) expect(canActorApprove(l, 'admin')).toBe(false)
    expect(canActorApprove('L1', '')).toBe(false)
  })
  test('neplatná úroveň nesmí nic', () => {
    expect(canActorApprove('L5' as never, 'vedeni')).toBe(false)
  })
})

describe('nodeRoleFor (role pro uzel z loop_node)', () => {
  const VIKTOR = 'viktor-uuid'
  const rows: LoopNodeRow[] = [
    { node: 'obchod', owner_id: VIKTOR, deputy_id: 'dep-uuid' },
    { node: 'vedeni', owner_id: VIKTOR, deputy_id: null },
    { node: 'eventy', owner_id: null, deputy_id: null },
  ]
  test('vlastník → node_owner', () => {
    expect(nodeRoleFor({ id: VIKTOR, teamRole: 'vedeni' }, 'obchod', rows)).toBe('node_owner')
  })
  test('zástupce → node_deputy (i když je vedení)', () => {
    expect(nodeRoleFor({ id: 'dep-uuid', teamRole: 'obchodnik' }, 'obchod', rows)).toBe('node_deputy')
    expect(nodeRoleFor({ id: 'dep-uuid', teamRole: 'vedeni' }, 'obchod', rows)).toBe('node_deputy')
  })
  test('vazba je per uzel', () => {
    expect(nodeRoleFor({ id: 'dep-uuid', teamRole: 'obchodnik' }, 'vedeni', rows)).toBe('member')
  })
  test('vedení bez vazby na uzel → vedeni', () => {
    expect(nodeRoleFor({ id: 'x', teamRole: 'vedeni' }, 'eventy', rows)).toBe('vedeni')
  })
  test('ostatní → member', () => {
    expect(nodeRoleFor({ id: 'x', teamRole: 'projektak' }, 'obchod', rows)).toBe('member')
    expect(nodeRoleFor({ id: 'x', teamRole: null }, 'vedeni', rows)).toBe('member')
  })
  test('NULL vlastník nesedí na prázdné id', () => {
    expect(nodeRoleFor({ id: '', teamRole: null }, 'eventy', rows)).toBe('member')
  })
  test('neznámý uzel / žádné řádky → podle team role', () => {
    expect(nodeRoleFor({ id: VIKTOR, teamRole: 'vedeni' }, 'neexistuje', rows)).toBe('vedeni')
    expect(nodeRoleFor({ id: VIKTOR, teamRole: null }, 'obchod', [])).toBe('member')
  })
  test('odvozená role vede k rozhodnutému stropu schvalování', () => {
    const dep = nodeRoleFor({ id: 'dep-uuid', teamRole: null }, 'obchod', rows)
    expect(canActorApprove('L2', dep)).toBe(true)
    expect(canActorApprove('L3', dep)).toBe(false)
    expect(canActorApprove('L4', nodeRoleFor({ id: VIKTOR, teamRole: null }, 'obchod', rows))).toBe(true)
  })
})

describe('loop_node v migraci 0039', () => {
  test('tabulka, uzly a nullable vlastník/zástupce', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS loop_node/)
    expect(sql).toMatch(/owner_id\s+uuid REFERENCES team_member\(id\)/)
    expect(sql).toMatch(/deputy_id\s+uuid REFERENCES team_member\(id\)/)
    expect(sql).not.toMatch(/owner_id\s+uuid NOT NULL/)
  })
  test('RLS: loop_node je v DO smyčce a není zapisovatelný pro tým', () => {
    const arr = sql.match(/FOREACH t IN ARRAY ARRAY\[([^\]]*)\]/)
    expect(arr?.[1]).toContain("'loop_node'")
    expect(sql).toMatch(/IF t IN \('work_case', 'case_step'\) THEN/)
  })
  test('seed uzlů firmy bez vlastníka a bez e-mailu v migraci', () => {
    expect(sql).toMatch(/INSERT INTO loop_node \(node, owner_id, deputy_id\)\s+SELECT n\.node, NULL, NULL\s+FROM \(VALUES \('obchod'\), \('eventy'\), \('vedeni'\)\) AS n\(node\)/)
    expect(sql).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}'/)
    // Guard na 0038 zůstává jako jediná RAISE EXCEPTION mimo RPC chyby.
    expect(sql).toMatch(/0039 vyžaduje tabulku public\.evidence/)
  })
})
