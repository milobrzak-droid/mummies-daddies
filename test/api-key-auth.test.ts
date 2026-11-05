import { expect, test } from 'vitest'
import { generateApiKey, hashApiKey } from '@/lib/apiKeyAuth'

test('generated key starts with the cockpit_ prefix', () => {
  const { plaintext } = generateApiKey()
  expect(plaintext.startsWith('cockpit_')).toBe(true)
})

test('prefix is a 16-character slice of the plaintext, from the start', () => {
  const { plaintext, prefix } = generateApiKey()
  expect(prefix.length).toBe(16)
  expect(plaintext.startsWith(prefix)).toBe(true)
})

test('two generated keys are never the same', () => {
  const a = generateApiKey()
  const b = generateApiKey()
  expect(a.plaintext).not.toBe(b.plaintext)
})

test('hash is deterministic for the same input', () => {
  expect(hashApiKey('cockpit_abc123')).toBe(hashApiKey('cockpit_abc123'))
})

test('hash differs for different input', () => {
  expect(hashApiKey('cockpit_abc')).not.toBe(hashApiKey('cockpit_xyz'))
})

test('the hash returned by generateApiKey matches hashApiKey(plaintext)', () => {
  const { plaintext, hash } = generateApiKey()
  expect(hash).toBe(hashApiKey(plaintext))
})
