// Statická kontrola 0053_security_hardening.sql (bez DB): SQL pravomoc
// schvalování musí sedět s core/authority.ts, RPC si drží signatury a granty
// z 0039, digest_send_log je jen pro service_role a URL dokumentu má stejný
// regex jako domain/delivery/documents.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { APPROVER_ROLES, LEVELS, canActorApprove, nodeRoleFor } from '@/core/authority'
import { SHAREPOINT_URL_RE, DOCUMENT_URL_MAX } from '@/domain/delivery/documents'

const raw = readFileSync('supabase/migrations/0053_security_hardening.sql', 'utf8')
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const sql0039 = readFileSync('supabase/migrations/0039_loop_core.sql', 'utf8').replace(/--[^\n]*/g, '')

/** Tělo funkce mezi `AS $$` a `$$;`. */
function fnBody(name: string, source = sql): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(source)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return m[2]
}

/** Hlavička funkce (parametry + atributy) až po `AS $$`. */
function fnHeader(name: string, source = sql): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)AS \\$\\$`).exec(source)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return m[1]
}

/** Parametry funkce, normalizované (bez mezer navíc). */
function fnParams(name: string, source: string): string {
  const header = fnHeader(name, source)
  return header.slice(0, header.indexOf('\n)')).replace(/\s+/g, ' ').trim()
}

describe('0053 — prerekvizity', () => {
  test('guard jmenuje chybějící migrace 0039 a 0051', () => {
    expect(sql).toMatch(/to_regclass\('public\.approval_request'\) IS NULL/)
    expect(sql).toMatch(/to_regprocedure\('public\.loop_actor\(\)'\) IS NULL/)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0039_loop_core\.sql'/)
    expect(sql).toMatch(/to_regclass\('public\.engagement_document'\) IS NULL/)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0051_engagement_document\.sql'/)
    // guard je první příkaz souboru
    expect(sql.trim().startsWith('DO $$')).toBe(true)
  })

  test('schema_migration nese 0053', () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0053'/)
  })
})

describe('H1 — tabulka maxim rolí SQL == TS (musí zůstat synchronní)', () => {
  const body = fnBody('loop_role_max_level')
  const sqlTable = Object.fromEntries(
    [...body.matchAll(/WHEN '(\w+)' THEN '(L\d)'/g)].map((m) => [m[1], m[2]]),
  )

  // Maximum role podle TS: nejvyšší úroveň, kterou canActorApprove pustí.
  const tsMax = (role: string): string | null => {
    let max: string | null = null
    for (const l of LEVELS) if (canActorApprove(l, role)) max = l
    return max
  }

  test('každá role z APPROVER_ROLES má v SQL stejné maximum (system = žádné)', () => {
    const tsTable: Record<string, string> = {}
    for (const role of APPROVER_ROLES) {
      const m = tsMax(role)
      if (m !== null) tsTable[role] = m
    }
    expect(sqlTable).toEqual(tsTable)
    expect(sqlTable).toEqual({ vedeni: 'L4', node_owner: 'L4', node_deputy: 'L2', member: 'L1' })
    expect(body).toMatch(/ELSE NULL/)
  })

  test('TS je monotónní (maximum = souvislý rozsah L1..max), takže tabulka maxim stačí', () => {
    for (const role of APPROVER_ROLES) {
      const max = tsMax(role)
      for (const l of LEVELS) {
        expect(canActorApprove(l, role)).toBe(max !== null && l <= max)
      }
    }
  })

  test('odvození role: pořadí node_owner → node_deputy → vedeni → member jako nodeRoleFor', () => {
    const b = fnBody('loop_approver_role')
    const order = [...b.matchAll(/RETURN '(\w+)'/g)].map((m) => m[1])
    expect(order).toEqual(['node_owner', 'node_deputy', 'vedeni', 'member'])
    expect(b).toMatch(/ln\.owner_id = p_member/)
    expect(b).toMatch(/ln\.deputy_id = p_member/)
    expect(b).toMatch(/tm\.role::text/)
    // TS se chová stejně: zástupce uzlu, který je zároveň vedeni, je node_deputy.
    const rows = [{ node: 'obchod', owner_id: 'o', deputy_id: 'd' }]
    expect(nodeRoleFor({ id: 'o', teamRole: 'vedeni' }, 'obchod', rows)).toBe('node_owner')
    expect(nodeRoleFor({ id: 'd', teamRole: 'vedeni' }, 'obchod', rows)).toBe('node_deputy')
    expect(nodeRoleFor({ id: 'x', teamRole: 'vedeni' }, 'obchod', rows)).toBe('vedeni')
    expect(nodeRoleFor({ id: 'x', teamRole: 'obchodnik' }, 'obchod', rows)).toBe('member')
  })

  test('neznámý uzel (case NULL / případ neexistuje) → jen vedeni, jinak žádná role', () => {
    const b = fnBody('loop_approver_role')
    expect(b).toMatch(/IF v_node IS NULL THEN\s+RETURN CASE WHEN v_team_role = 'vedeni' THEN 'vedeni' END;/)
    // nečlen týmu = žádná role
    expect(b).toMatch(/IF NOT FOUND THEN\s+RETURN NULL;/)
  })
})

describe('H1 — decide_approval', () => {
  const b = fnBody('decide_approval')

  test('role se kontroluje až po zámku FOR UPDATE a před UPDATE', () => {
    const lock = b.indexOf('FOR UPDATE')
    const role = b.indexOf('loop_approver_role(auth.uid(), v_req.case_id)')
    const update = b.indexOf('UPDATE approval_request')
    expect(lock).toBeGreaterThan(-1)
    expect(role).toBeGreaterThan(lock)
    expect(update).toBeGreaterThan(role)
  })

  test('překročení úrovně → 42501 s českou hláškou', () => {
    expect(b).toMatch(
      /loop_level_rank\(v_req\.requested_level\) > loop_level_rank\(v_max\) THEN\s+RAISE EXCEPTION 'Nemáš oprávnění schválit tuto úroveň' USING ERRCODE = '42501'/,
    )
    expect(b).toMatch(/IF v_max IS NULL/)
  })

  test('původní kontroly zůstaly: loop_actor (AAL2 + členství), pending, expirace, čtyři oči', () => {
    expect(b).toMatch(/v_actor text := loop_actor\(\)/)
    expect(b).toMatch(/v_req\.status <> 'pending'/)
    expect(b).toMatch(/v_req\.expires_at <= now\(\)/)
    expect(b).toMatch(/v_req\.requested_by = v_actor/)
  })
})

describe('H1 — request_approval nikdy nesnižuje úroveň', () => {
  const b = fnBody('request_approval')

  test('bere aktivní politiku (nejnižší), bez politiky L2, a ukládá max', () => {
    expect(b).toMatch(/FROM authority_policy ap\s+WHERE ap\.action_kind = p_action_kind AND ap\.active/)
    expect(b).toMatch(/ORDER BY loop_level_rank\(ap\.level\) ASC/)
    expect(b).toMatch(/v_policy := coalesce\(v_policy, 'L2'\)/)
    expect(b).toMatch(/loop_level_rank\(p_requested_level\) >= loop_level_rank\(v_policy\) THEN p_requested_level\s+ELSE v_policy/)
    expect(b).toMatch(/VALUES \(p_case_id, p_action_kind, v_level,/)
  })

  // Tatáž logika v JS nad SQL literály — ochrana proti obrácenému porovnání.
  test('simulace: max(požadovaná, politika | L2)', () => {
    const rank = (l: string) => Number(l.slice(1))
    const stored = (req: string | null, policy: string | null) => {
      const p = policy ?? 'L2'
      return req === null ? p : rank(req) >= rank(p) ? req : p
    }
    expect(stored('L1', null)).toBe('L2')
    expect(stored('L1', 'L3')).toBe('L3')
    expect(stored('L4', 'L2')).toBe('L4')
    expect(stored(null, 'L1')).toBe('L1')
  })
})

describe('H1 — resolve_decision / record_decision', () => {
  test('resolve: zámek, kontrola oprávnění, 42501', () => {
    const b = fnBody('resolve_decision')
    expect(b).toMatch(/FROM decision WHERE id = p_decision_id FOR UPDATE/)
    expect(b).toMatch(/IF NOT loop_can_resolve_case\(auth\.uid\(\), v_dec\.case_id\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = '42501'/)
    expect(b.indexOf('loop_can_resolve_case')).toBeLessThan(b.indexOf('UPDATE decision'))
  })

  test('record s p_chosen: kontrola oprávnění před INSERT', () => {
    const b = fnBody('record_decision')
    expect(b).toMatch(/IF p_chosen IS NOT NULL AND NOT loop_can_resolve_case\(auth\.uid\(\), p_case_id\) THEN/)
    expect(b.indexOf('loop_can_resolve_case')).toBeLessThan(b.indexOf('INSERT INTO decision'))
  })

  test('kdo smí: vedeni, vlastník/zástupce případu, vlastník/zástupce uzlu', () => {
    const b = fnBody('loop_can_resolve_case')
    expect(b).toMatch(/tm\.role::text = 'vedeni'/)
    expect(b).toMatch(/v_case\.lead_owner_id = p_member OR v_case\.deputy_id = p_member/)
    expect(b).toMatch(/ln\.owner_id = p_member OR ln\.deputy_id = p_member/)
  })
})

describe('H1 — signatury, SECURITY DEFINER, search_path a granty jako v 0039', () => {
  const rpcs: [string, string][] = [
    ['request_approval', 'text, text, bigint, timestamptz'],
    ['decide_approval', 'bigint, boolean, text'],
    ['record_decision', 'bigint, text, jsonb, text, bigint'],
    ['resolve_decision', 'bigint, text, bigint'],
  ]

  test.each(rpcs)('%s', (name, types) => {
    expect(fnParams(name, sql)).toBe(fnParams(name, sql0039))
    const header = fnHeader(name)
    expect(header).toMatch(/SECURITY DEFINER/)
    expect(header).toMatch(/SET search_path = public, pg_temp/)
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${name}(${types}) FROM PUBLIC, anon;`)
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${name}(${types}) TO authenticated;`)
  })

  test('pomocné funkce nejsou pro klienty', () => {
    for (const f of ['loop_level_rank(text)', 'loop_role_max_level(text)', 'loop_approver_role(uuid, bigint)', 'loop_can_resolve_case(uuid, bigint)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`)
    }
  })
})

describe('L1 — digest_send_log', () => {
  test('PK (prague_day, kind), jen service_role', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS digest_send_log \(\s+prague_day\s+date NOT NULL,\s+kind\s+text NOT NULL,\s+sent_at\s+timestamptz/)
    expect(sql).toMatch(/PRIMARY KEY \(prague_day, kind\)/)
    expect(sql).toMatch(/ALTER TABLE digest_send_log ENABLE ROW LEVEL SECURITY/)
    expect(sql).toContain('REVOKE ALL ON digest_send_log FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('GRANT SELECT, INSERT, DELETE ON digest_send_log TO service_role;')
    // žádná permisivní politika (jen RESTRICTIVE AAL2)
    const policies = [...sql.matchAll(/CREATE POLICY (\w+) ON digest_send_log\s+(AS RESTRICTIVE)?/g)]
    expect(policies.map((p) => [p[1], Boolean(p[2])])).toEqual([['require_aal2', true]])
  })
})

describe('L2 — engagement_document.created_by', () => {
  test('DEFAULT auth.uid() a trigger pro INSERT i UPDATE', () => {
    expect(sql).toContain('ALTER TABLE engagement_document ALTER COLUMN created_by SET DEFAULT auth.uid();')
    expect(sql).toMatch(/CREATE TRIGGER engagement_document_created_by\s+BEFORE INSERT OR UPDATE ON engagement_document/)
    const b = fnBody('engagement_document_enforce_created_by')
    // service_role (bez auth.uid()) vyjmutá
    expect(b).toMatch(/IF auth\.uid\(\) IS NULL THEN\s+RETURN NEW;/)
    expect(b).toMatch(/NEW\.created_by IS DISTINCT FROM auth\.uid\(\)/)
    expect(b).toMatch(/ERRCODE = '42501'/)
  })
})

describe('L4 — engagement_document.url', () => {
  const pattern = /CHECK \(url ~ '([^']+)'\) NOT VALID/.exec(sql)?.[1]

  test('regex v SQL je shodný se SHAREPOINT_URL_RE', () => {
    expect(pattern).toBeDefined()
    expect(SHAREPOINT_URL_RE.source.replace(/\\\//g, '/')).toBe(pattern)
    // a validace stávajících řádků používá týž regex
    expect(sql).toContain(`url !~ '${pattern}'`)
  })

  test('SQL regex se chová jako TS regex', () => {
    const re = new RegExp(pattern!)
    for (const url of [
      'https://mummiesdaddies.sharepoint.com/sites/x',
      'https://mummiesdaddies-my.sharepoint.com/personal/x',
      'https://firma.sharepoint.com/x',
      'https://mummiesdaddies.sharepoint.com.evil.com/x',
      'http://mummiesdaddies.sharepoint.com/x',
    ]) {
      expect(re.test(url), url).toBe(SHAREPOINT_URL_RE.test(url))
    }
  })

  test('délka ≤ 2000 shodně se zod', () => {
    expect(DOCUMENT_URL_MAX).toBe(2000)
    expect(sql).toMatch(/CHECK \(char_length\(url\) <= 2000\) NOT VALID/)
  })

  test('NOT VALID idempotentně, pak VALIDATE jen bez porušení (jinak NOTICE)', () => {
    for (const c of ['engagement_document_url_length_check', 'engagement_document_url_host_check']) {
      expect(sql).toContain(`AND conname = '${c}'`)
      expect(sql).toContain(`VALIDATE CONSTRAINT ${c};`)
    }
    expect(sql).toMatch(/RAISE NOTICE '0053: engagement_document má odkazy delší/)
    expect(sql).toMatch(/RAISE NOTICE '0053: engagement_document má odkazy mimo/)
  })
})
