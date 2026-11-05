import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  exchangeCodeForToken,
  filesScopeEnabled,
  getAuthUrl,
  GRAPH_SCOPES,
  graphScopes,
  missingGraphScopes,
  normalizeGrantedScopes,
  refreshAccessToken,
  refreshAccessTokenForFiles,
} from '@/connectors/graph'

describe('Graph delegované scope', () => {
  it('obsahuje Mail.Read i Mail.Send a zachovává původní práva', () => {
    const scopes = GRAPH_SCOPES.split(' ')
    expect(scopes).toEqual(expect.arrayContaining(['offline_access', 'Calendars.ReadWrite', 'User.Read', 'Mail.Read', 'Mail.Send']))
    expect(scopes).toHaveLength(5)
  })

  it('autorizační URL žádá Mail.Read i Mail.Send, bez prompt', () => {
    const u = new URL(getAuthUrl('https://app.example/api/ms/callback', 'st', 'ch'))
    expect(u.searchParams.get('scope')).toBe(GRAPH_SCOPES)
    expect(u.searchParams.get('scope')).toContain('Mail.Read')
    expect(u.searchParams.get('scope')).toContain('Mail.Send')
    expect(u.searchParams.has('prompt')).toBe(false)
  })

  it('prompt=consent jen na vyžádání (znovupřipojení)', () => {
    const u = new URL(getAuthUrl('https://app.example/api/ms/callback', 'st', 'ch', 'consent'))
    expect(u.searchParams.get('prompt')).toBe('consent')
  })
})

describe('udělená oprávnění (pole scope z tokenové odpovědi)', () => {
  it('normalizuje prefix zdroje, duplicity a odpad', () => {
    expect(normalizeGrantedScopes('https://graph.microsoft.com/Mail.Read User.Read  Mail.Read openid'))
      .toBe('Mail.Read User.Read openid')
    expect(normalizeGrantedScopes('Mail.Send <script> a"b')).toBe('Mail.Send')
    expect(normalizeGrantedScopes('')).toBeNull()
    expect(normalizeGrantedScopes(undefined)).toBeNull()
    expect(normalizeGrantedScopes(null)).toBeNull()
  })

  it('chybějící oprávnění z GRAPH_SCOPES (bez offline_access), case-insensitive', () => {
    expect(missingGraphScopes('Calendars.ReadWrite User.Read')).toEqual(['Mail.Read', 'Mail.Send'])
    expect(missingGraphScopes('calendars.readwrite user.read mail.read')).toEqual(['Mail.Send'])
    expect(missingGraphScopes('Calendars.ReadWrite User.Read Mail.Read Mail.Send openid profile email')).toEqual([])
    expect(missingGraphScopes('https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send'))
      .toEqual([])
  })

  it('neznámá udělená práva = null (nic netvrdíme)', () => {
    expect(missingGraphScopes(null)).toBeNull()
    expect(missingGraphScopes(undefined)).toBeNull()
    expect(missingGraphScopes('   ')).toBeNull()
  })
})

describe('Files.Read.All (plan kap. 8) — jen s GRAPH_FILES_SCOPE_ENABLED=true', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('výchozí GRAPH_SCOPES Files.Read.All neobsahují', () => {
    expect(GRAPH_SCOPES).not.toContain('Files.')
    expect(filesScopeEnabled()).toBe(false)
    expect(graphScopes()).toBe(GRAPH_SCOPES)
  })

  it('jen přesně „true" zapíná', () => {
    for (const v of ['1', 'TRUE', 'yes', ' true', '']) {
      vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', v)
      expect(filesScopeEnabled(), v).toBe(false)
    }
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', 'true')
    expect(filesScopeEnabled()).toBe(true)
    expect(graphScopes()).toBe(`${GRAPH_SCOPES} Files.Read.All`)
  })

  it('zapnuto: přihlášení (i Znovu připojit) žádá Files.Read.All', () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', 'true')
    const u = new URL(getAuthUrl('https://app.example/api/ms/callback', 'st', 'ch', 'consent'))
    expect(u.searchParams.get('scope')!.split(' ')).toContain('Files.Read.All')
    expect(u.searchParams.get('prompt')).toBe('consent')
  })

  it('zapnuto: kontrola udělených práv hlásí Files.Read.All jako chybějící', () => {
    const all = 'Calendars.ReadWrite User.Read Mail.Read Mail.Send'
    expect(missingGraphScopes(all)).toEqual([])
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', 'true')
    expect(missingGraphScopes(all)).toEqual(['Files.Read.All'])
    expect(missingGraphScopes(`${all} https://graph.microsoft.com/Files.Read.All`)).toEqual([])
  })

  it('zapnuto: výměna kódu žádá Files.Read.All, obnova tokenu dál jen GRAPH_SCOPES (subset pravidlo)', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', 'true')
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 })
    }))
    await exchangeCodeForToken('code', 'https://app.example/api/ms/callback', 'ver')
    await refreshAccessToken('r')
    expect(new URLSearchParams(bodies[0]).get('scope')).toBe(`${GRAPH_SCOPES} Files.Read.All`)
    expect(new URLSearchParams(bodies[1]).get('scope')).toBe(GRAPH_SCOPES)
  })

  it('refreshAccessTokenForFiles: vypnuto = obyčejná obnova, jedno volání bez Files.Read.All', async () => {
    const seen: (string | undefined)[] = []
    const tok = { access_token: 'a', refresh_token: 'r', expires_in: 1 }
    const r = await refreshAccessTokenForFiles('r', async (_rt, scope) => { seen.push(scope); return tok })
    expect(r).toEqual(tok)
    expect(seen).toEqual([undefined])
  })

  it('refreshAccessTokenForFiles: zapnuto = nejdřív s Files.Read.All, když ho člen nemá, obnoví se bez něj', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', 'true')
    const seen: (string | undefined)[] = []
    const tok = { access_token: 'a', refresh_token: 'r', expires_in: 1 }
    const ok = await refreshAccessTokenForFiles('r', async (_rt, scope) => { seen.push(scope); return tok })
    expect(ok).toEqual(tok)
    expect(seen).toEqual([`${GRAPH_SCOPES} Files.Read.All`])

    seen.length = 0
    const fallback = await refreshAccessTokenForFiles('r', async (_rt, scope) => { seen.push(scope); return scope ? null : tok })
    expect(fallback).toEqual(tok)
    expect(seen).toEqual([`${GRAPH_SCOPES} Files.Read.All`, undefined])
  })
})
