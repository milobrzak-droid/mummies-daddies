import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { createAuditedAdminClient } from '@/core/auditDb'
import { runIdokladLive, MISSING_CREDENTIALS_MESSAGE } from '@/domain/finance/idokladLive'
import * as sync from '@/domain/finance/idokladSync'

vi.mock('@/core/connectorState', () => ({ recordConnectorError: vi.fn(async () => undefined), recordConnectorSuccess: vi.fn(async () => undefined) }))
vi.mock('@/core/auditDb', () => ({ createAuditedAdminClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ENV = { IDOKLAD_CLIENT_ID: 'cid', IDOKLAD_CLIENT_SECRET: 'sekret', IDOKLAD_SYNC_DAYS: '30' }

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('runIdokladLive', () => {
  it('bez přihlašovacích údajů se nic nerozbije: srozumitelná chyba, stav konektoru, žádný klient DB', async () => {
    await expect(runIdokladLive({ IDOKLAD_CLIENT_ID: 'cid' })).rejects.toThrow(MISSING_CREDENTIALS_MESSAGE)
    expect(recordConnectorError).toHaveBeenCalledWith('idoklad', MISSING_CREDENTIALS_MESSAGE)
    expect(createAuditedAdminClient).not.toHaveBeenCalled()
  })

  it('zápisy nesou aktéra system:job:idoklad-sync a stav údaje source_fact; úspěch se zapíše do stavu konektoru', async () => {
    const spy = vi.spyOn(sync, 'runIdokladSync').mockResolvedValue({ invoicesRead: 1 } as never)
    await expect(runIdokladLive(ENV)).resolves.toMatchObject({ invoicesRead: 1 })
    expect(createAuditedAdminClient).toHaveBeenCalledWith({ actor: { type: 'system', id: 'job:idoklad-sync' }, infoState: 'source_fact' })
    expect(spy.mock.calls[0][0].days).toBe(30)
    expect(recordConnectorSuccess).toHaveBeenCalledWith('idoklad', expect.any(String))
  })

  it('chybějící migrace 0092 = srozumitelná věta a chyba konektoru (ne pád s názvem sloupce)', async () => {
    vi.spyOn(sync, 'runIdokladSync').mockRejectedValue(Object.assign(new Error('column financial_record.idoklad_id does not exist'), { code: '42703' }))
    await expect(runIdokladLive(ENV)).rejects.toThrow('migraci 0092')
    expect(recordConnectorError).toHaveBeenCalledWith('idoklad', expect.stringContaining('migraci 0092'))
  })
})
