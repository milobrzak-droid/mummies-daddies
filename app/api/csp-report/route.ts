import { NextRequest, NextResponse } from 'next/server'
import { logWarn } from '@/lib/log'
import { readLimitedBody } from '@/lib/httpBody'

// Reporting target for both CSP headers (see next.config.ts: `report-uri` +
// `report-to csp` / Reporting-Endpoints): the enforced Content-Security-Policy
// (disposition "enforce" = the browser BLOCKED something) and the stricter
// Content-Security-Policy-Report-Only candidate (disposition "report" = would
// be blocked after the next tightening step).
// Unauthenticated by design — the browser sends these without any app
// session, and lib/supabase/middleware.ts carves this path out of the auth
// gate. Not cached (POST handlers never are, see route-handlers.md), and not
// treated as a Server Action since it lives under /api.
//
// Limits: request bodies over 16 KB are rejected with 413. Per server
// instance, at most 60 reports/minute are logged — this is an in-memory
// counter, not a shared/distributed limiter, so a multi-instance deployment
// gets roughly 60/min per instance, not globally. Reports beyond the limit
// are silently dropped (still 204) rather than erroring, since the client
// can't do anything useful with a rate-limit failure for a fire-and-forget
// report.
//
// Only these fields are ever logged, and each is stripped before logging:
//   - directive       the violated/effective CSP directive (e.g. "script-src")
//   - blockedOrigin    blocked-uri, reduced to just its origin
//   - documentPath     document-uri, reduced to just its path (no query)
//   - disposition      "enforce" | "report"
// No cookies, no IP, no query strings, no full URLs — those can carry
// tokens or other PII, which is exactly what CSP reports like to include in
// the blocked/document URI.

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 16 * 1024
const RATE_LIMIT_PER_MINUTE = 60
const RATE_WINDOW_MS = 60_000

// Per-instance, in-memory. Resets on cold start/deploy; that's fine, this is
// a flood guard, not an accounting system.
let windowStart = Date.now()
let windowCount = 0

function withinRateLimit(): boolean {
  const now = Date.now()
  if (now - windowStart >= RATE_WINDOW_MS) {
    windowStart = now
    windowCount = 0
  }
  windowCount += 1
  return windowCount <= RATE_LIMIT_PER_MINUTE
}

// Strips a blocked-uri/blockedURL down to just its origin, dropping any
// path/query that might contain a token. Special CSP values like "inline",
// "eval", "data", "about" are not URLs and are passed through as-is.
function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  if (!value.includes('://')) return value.slice(0, 64)
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

// Strips a document-uri/documentURL down to just its path, dropping query
// string and fragment (which may carry auth tokens, e.g. OAuth redirects).
function safePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return new URL(value).pathname
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

// Disposition and directive come straight from the reporting browser (i.e.
// from whoever can trigger a CSP violation), so they're logged through
// logWarn's context. lib/log.ts now JSON.stringify's context string values,
// which already blocks newline-based log-line forgery, but we additionally
// allow-list these two fields to keep the log genuinely useful (an
// attacker-chosen 10 KB "directive" is still noise even quoted).
const DISPOSITIONS = new Set(['enforce', 'report'])
function safeDisposition(value: unknown): string {
  const s = str(value)
  return s !== undefined && DISPOSITIONS.has(s) ? s : 'unknown'
}

const DIRECTIVE_RE = /^[a-z-]{1,40}$/
function safeDirective(value: unknown): string {
  const s = str(value)
  return s !== undefined && DIRECTIVE_RE.test(s) ? s : 'unknown'
}

type ParsedReport = {
  directive?: string
  blockedOrigin?: string
  documentPath?: string
  disposition?: string
}

// application/csp-report body: { "csp-report": { ...fields } }
function fromCspReport(body: unknown): ParsedReport | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const outer = (body as Record<string, unknown>)['csp-report']
  if (typeof outer !== 'object' || outer === null) return undefined
  const r = outer as Record<string, unknown>
  return {
    directive: safeDirective(r['effective-directive'] ?? r['violated-directive']),
    blockedOrigin: safeOrigin(r['blocked-uri']),
    documentPath: safePath(r['document-uri']),
    disposition: safeDisposition(r['disposition']),
  }
}

// application/reports+json body: an array of generic Reporting API entries;
// we only care about ones with type "csp-violation".
function fromReportsJson(body: unknown): ParsedReport[] {
  if (!Array.isArray(body)) return []
  const out: ParsedReport[] = []
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'csp-violation') continue
    if (typeof e.body !== 'object' || e.body === null) continue
    const r = e.body as Record<string, unknown>
    out.push({
      directive: safeDirective(r['effectiveDirective']),
      blockedOrigin: safeOrigin(r['blockedURL']),
      documentPath: safePath(r['documentURL']),
      disposition: safeDisposition(r['disposition']),
    })
  }
  return out
}

const noContent = () => new NextResponse(null, { status: 204 })

export async function POST(req: NextRequest) {
  const contentLength = req.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
  }

  // Veřejná cesta bez autentizace: tělo se čte po částech a přeruší na stropu
  // (Content-Length odesílatel zamlčí, u chunked těla vůbec nepřijde).
  const body = await readLimitedBody(req, MAX_BODY_BYTES)
  if (!body.ok) {
    return body.status === 413 ? NextResponse.json({ error: 'payload_too_large' }, { status: 413 }) : noContent()
  }
  const raw = body.text

  // Garbage bodies (not valid JSON, or valid JSON in a shape we don't
  // recognize) are swallowed as 204: the sender is the browser, not a client
  // we want to signal errors back to, and a malformed report is not worth a
  // log line of its own.
  if (raw === '') return noContent()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return noContent()
  }

  if (!withinRateLimit()) return noContent()

  const contentType = req.headers.get('content-type') ?? ''
  const reports = contentType.includes('application/reports+json')
    ? fromReportsJson(parsed)
    : (() => {
        const single = fromCspReport(parsed)
        return single ? [single] : []
      })()

  for (const r of reports) {
    logWarn('csp-report', 'violation', {
      directive: r.directive,
      blockedOrigin: r.blockedOrigin,
      documentPath: r.documentPath,
      disposition: r.disposition,
    })
  }

  return noContent()
}
