import { afterEach, describe, expect, test, vi } from 'vitest'
import { logError, logWarn } from '@/lib/log'

// Bezpečnostní revize S4: details a hint z chyb PostgREST nesmí skončit v logu.
// U porušení CHECK / NOT NULL / UNIQUE obsahují celý řádek dat.

afterEach(() => vi.restoreAllMocks())

const PII = 'jan.novak@example.cz'
const pgError = {
  code: '23514',
  message: 'new row for relation "sales_activity" violates check constraint "x"',
  details: `Failing row contains (1, ${PII}, +420 777 123 456, text zápisu).`,
  hint: `Zkus jiný záznam ${PII}`,
}
const line = (spy: ReturnType<typeof vi.spyOn>) => String(spy.mock.calls[0]![0])

describe('logError: details a hint se nelogují', () => {
  test('prostý objekt z PostgREST: zůstane kód a zpráva', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('api.activity', pgError, { accountId: 7 })
    const l = line(spy)
    expect(l).toBe(
      '[api.activity] code="23514" message="new row for relation \\"sales_activity\\" violates check constraint \\"x\\"" · accountId=7',
    )
    expect(l).not.toContain(PII)
    expect(l).not.toContain('Failing row')
    expect(l).not.toContain('Zkus jiný')
  })

  test('Error s vlastnostmi details/hint (PostgrestError): jen jméno a zpráva', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = Object.assign(new Error('duplicate key value'), { name: 'PostgrestError', code: '23505', details: `Key (email)=(${PII}) already exists.`, hint: 'h' })
    logError('x', e)
    expect(line(spy)).toBe('[x] PostgrestError: duplicate key value')
  })

  test('objekt bez code/message: JSON bez klíčů details a hint (i vnořených)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', { status: 400, nested: { details: PII, ok: 1 }, hint: PII })
    const l = line(spy)
    expect(l).not.toContain(PII)
    expect(l).toContain('"status":400')
    expect(l).toContain('"ok":1')
  })

  test('chyba předaná v kontextu se také očistí', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', new Error('boom'), { dbError: pgError })
    const l = line(spy)
    expect(l).not.toContain(PII)
    expect(l).toContain('"code":"23514"')
    expect(l).toContain('violates check constraint')
  })

  test('logWarn kontext s details také', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logWarn('x', 'msg', { error: pgError })
    expect(line(spy)).not.toContain(PII)
  })

  test('zpráva s novým řádkem nerozseká log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', { code: '1', message: 'a\n[fake] b' })
    expect(line(spy).split('\n')).toHaveLength(1)
  })

  test('Error, string a neznámé hodnoty fungují jako dřív', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('a', new Error('boom'))
    logError('b', 'text')
    logError('c', 42)
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['[a] Error: boom', '[b] text', '[c] 42'])
  })
})

describe('logError: hodnota z „invalid input …" se nelogují (kolo 2)', () => {
  test.each([
    ['invalid input syntax for type uuid: "jan.novak@example.cz"', 'invalid input syntax for type uuid: "…"'],
    ['invalid input value for enum sales_activity_kind: "text zápisu, +420 777 123 456"', 'invalid input value for enum sales_activity_kind: "…"'],
  ])('%s', (message, expected) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', { code: '22P02', message })
    expect(String(spy.mock.calls[0]![0])).toBe(`[x] code="22P02" message=${JSON.stringify(expected)}`)
    spy.mockClear()
    logError('x', new Error(message))
    expect(String(spy.mock.calls[0]![0])).toBe(`[x] Error: ${expected}`)
    expect(String(spy.mock.calls[0]![0])).not.toContain('novak')
  })

  test('běžná zpráva bez vloženého vstupu zůstává beze změny', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', { code: '23505', message: 'duplicate key value violates unique constraint "account_pkey"' })
    expect(String(spy.mock.calls[0]![0])).toContain('duplicate key value violates unique constraint \\"account_pkey\\"')
  })
})
