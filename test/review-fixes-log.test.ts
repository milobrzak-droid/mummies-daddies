import { afterEach, describe, expect, test, vi } from 'vitest'
import { logError, logWarn } from '@/lib/log'

// lib/log.ts — context hodnoty teď vždy projdou JSON.stringify (i řetězce),
// takže \r/\n v hodnotě (typicky z externího vstupu, viz csp-report.ts) se
// escapuje na \\r/\\n a nemůže rozseknout jeden log řádek na víc řádků a
// předstírat vlastní `[scope] ...` záznam (log injection).

afterEach(() => vi.restoreAllMocks())

describe('logError/logWarn — context string values nemůžou vyrobit vlastní log řádek', () => {
  test('logError: newline v kontextu zůstane escapovaná uvnitř jednoho řádku', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('gdpr.export', new Error('db failed'), { note: 'ok\n[forged-scope] fake error: pwned' })
    expect(spy).toHaveBeenCalledOnce()
    const line = String(spy.mock.calls[0]![0])
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('note="ok\\n[forged-scope] fake error: pwned"')
  })

  test('logWarn: newline v kontextu zůstane escapovaná uvnitř jednoho řádku', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logWarn('csp-report', 'violation', { directive: 'report\n[csp-report] forged: pwned' })
    expect(spy).toHaveBeenCalledOnce()
    const line = String(spy.mock.calls[0]![0])
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('directive="report\\n[csp-report] forged: pwned"')
  })

  test('normální (bezpečné) hodnoty stále vypadají čitelně, jen v uvozovkách', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('action.contacts', new Error('boom'), { contactId: 7, table: 'contact' })
    const line = String(spy.mock.calls[0]![0])
    expect(line).toBe('[action.contacts] Error: boom · contactId=7 table="contact"')
  })

  test('undefined/null hodnoty se z kontextu vynechají jako dřív', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logWarn('x', 'msg', { a: undefined, b: null, c: 'kept' })
    const line = String(spy.mock.calls[0]![0])
    expect(line).toBe('[x] msg · c="kept"')
  })
})
