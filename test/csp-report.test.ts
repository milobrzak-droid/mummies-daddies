// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn }))

import { POST } from '@/app/api/csp-report/route'

const ORIGIN = 'http://localhost:3000'

function req(body: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL('/api/csp-report', ORIGIN), {
    method: 'POST',
    body,
    headers: { 'content-length': String(Buffer.byteLength(body)), ...headers },
  })
}

beforeEach(() => { logWarn.mockClear() })
afterEach(() => { vi.useRealTimers() })

describe('POST /api/csp-report', () => {
  it('accepts application/csp-report (legacy format) and strips PII', async () => {
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://crm.example.cz/klienti/42?token=secret',
        referrer: '',
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'original-policy': 'default-src self',
        disposition: 'report',
        'blocked-uri': 'https://evil.example/x/y?z=1',
        'status-code': 200,
      },
    })
    const res = await POST(req(body, { 'content-type': 'application/csp-report' }))
    expect(res.status).toBe(204)
    expect(logWarn).toHaveBeenCalledTimes(1)
    const [scope, , context] = logWarn.mock.calls[0]
    expect(scope).toBe('csp-report')
    expect(context).toEqual({
      directive: 'script-src-elem',
      blockedOrigin: 'https://evil.example',
      documentPath: '/klienti/42',
      disposition: 'report',
    })
    // no cookie, IP, query string or full URL ever reaches the log call
    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('?')
  })

  it('accepts application/reports+json (Reporting API format)', async () => {
    const body = JSON.stringify([
      {
        type: 'csp-violation',
        age: 10,
        url: 'https://crm.example.cz/dashboard',
        user_agent: 'test',
        body: {
          documentURL: 'https://crm.example.cz/dashboard?x=1',
          blockedURL: 'inline',
          effectiveDirective: 'style-src-attr',
          disposition: 'report',
        },
      },
      { type: 'deprecation', body: {} },
    ])
    const res = await POST(req(body, { 'content-type': 'application/reports+json' }))
    expect(res.status).toBe(204)
    expect(logWarn).toHaveBeenCalledTimes(1)
    const [, , context] = logWarn.mock.calls[0]
    expect(context).toEqual({
      directive: 'style-src-attr',
      blockedOrigin: 'inline',
      documentPath: '/dashboard',
      disposition: 'report',
    })
  })

  it('rejects an oversize body with 413 via Content-Length', async () => {
    const big = 'a'.repeat(20 * 1024)
    const res = await POST(req(big, { 'content-type': 'application/csp-report' }))
    expect(res.status).toBe(413)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('rejects an oversize body with 413 even with a lying Content-Length', async () => {
    const big = JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(20 * 1024) } })
    const request = new NextRequest(new URL('/api/csp-report', ORIGIN), {
      method: 'POST',
      body: big,
      headers: { 'content-type': 'application/csp-report' }, // no content-length header
    })
    const res = await POST(request)
    expect(res.status).toBe(413)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('ignores garbage/non-JSON bodies (204, not 400)', async () => {
    const res = await POST(req('not json at all', { 'content-type': 'application/csp-report' }))
    expect(res.status).toBe(204)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('ignores well-formed JSON that does not match either report shape', async () => {
    const res = await POST(req(JSON.stringify({ hello: 'world' }), { 'content-type': 'application/csp-report' }))
    expect(res.status).toBe(204)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('ignores an empty body', async () => {
    const res = await POST(req('', { 'content-type': 'application/csp-report' }))
    expect(res.status).toBe(204)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('allow-lists disposition: unrecognized value becomes "unknown"', async () => {
    const body = JSON.stringify({
      'csp-report': { 'effective-directive': 'script-src', disposition: 'enforce\n[fake-scope] forged line', 'blocked-uri': 'inline' },
    })
    await POST(req(body, { 'content-type': 'application/csp-report' }))
    const [, , context] = logWarn.mock.calls[0]
    expect(context.disposition).toBe('unknown')
  })

  it('allow-lists disposition: "enforce" and "report" pass through unchanged', async () => {
    for (const disposition of ['enforce', 'report']) {
      logWarn.mockClear()
      const body = JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src', disposition, 'blocked-uri': 'inline' } })
      await POST(req(body, { 'content-type': 'application/csp-report' }))
      const [, , context] = logWarn.mock.calls[0]
      expect(context.disposition).toBe(disposition)
    }
  })

  it('restricts directive to /^[a-z-]{1,40}$/: anything else becomes "unknown"', async () => {
    const cases = [
      'script-src', // valid, unchanged
      'SCRIPT-SRC', // uppercase rejected
      'script-src; DROP TABLE x', // injection-shaped payload rejected
      'a'.repeat(41), // too long
      '',
    ]
    for (const directive of cases) {
      logWarn.mockClear()
      const body = JSON.stringify({ 'csp-report': { 'effective-directive': directive, disposition: 'report', 'blocked-uri': 'inline' } })
      await POST(req(body, { 'content-type': 'application/csp-report' }))
      const [, , context] = logWarn.mock.calls[0]
      expect(context.directive).toBe(directive === 'script-src' ? 'script-src' : 'unknown')
    }
  })

  it('a bogus directive/disposition never reaches the logged context as a raw string, closing the newline log-forging path', async () => {
    const body = JSON.stringify({
      'csp-report': {
        'effective-directive': 'not a directive\n[csp-report] forged: pwned',
        disposition: 'report\n[csp-report] forged: pwned',
        'blocked-uri': 'inline',
      },
    })
    await POST(req(body, { 'content-type': 'application/csp-report' }))
    const [, , context] = logWarn.mock.calls[0]
    expect(context).toEqual({ directive: 'unknown', blockedOrigin: 'inline', documentPath: undefined, disposition: 'unknown' })
  })

  it('rate-limits after 60 reports in the same window (still 204, but stops logging)', async () => {
    // The route's rate-limit counter is module-scoped and shared across every
    // test in this file. Jump the clock forward so this test starts its own
    // fresh window, regardless of what earlier tests already ticked up.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 120_000)
    const body = JSON.stringify({ 'csp-report': { 'blocked-uri': 'https://evil.example/a', 'effective-directive': 'img-src', disposition: 'report' } })
    for (let i = 0; i < 60; i++) {
      const res = await POST(req(body, { 'content-type': 'application/csp-report' }))
      expect(res.status).toBe(204)
    }
    expect(logWarn).toHaveBeenCalledTimes(60)
    logWarn.mockClear()
    const res = await POST(req(body, { 'content-type': 'application/csp-report' }))
    expect(res.status).toBe(204)
    expect(logWarn).not.toHaveBeenCalled()
  })
})
