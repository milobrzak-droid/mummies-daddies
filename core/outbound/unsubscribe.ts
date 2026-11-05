// Odhlášení z obchodních sdělení (§ 7 odst. 4 zák. 480/2004 Sb.): každý
// e-mail outbound agenta nese odkaz s podepsaným tokenem. Token obsahuje
// jen otisk adresy a id oslovení — žádný e-mail v URL ani v logu.
// Otisk = sha256 normalizované adresy (stejně jako SQL outbound_email_hash v 0107).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex')
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`outbound-unsubscribe:${payload}`).digest('base64url')
}

/** Minimální délka tajemství (env OUTBOUND_UNSUBSCRIBE_SECRET). */
export const UNSUBSCRIBE_SECRET_MIN = 32

export function unsubscribeToken(input: { emailHash: string; outreachId: number }, secret: string): string {
  if (secret.length < UNSUBSCRIBE_SECRET_MIN) throw new Error('unsubscribe_secret_too_short')
  const payload = b64(`v1.${input.emailHash}.${input.outreachId}`)
  return `${payload}.${sign(payload, secret)}`
}

export type UnsubscribeClaim = { emailHash: string; outreachId: number }

/** Ověří token (konstantní čas); null = neplatný nebo podvržený. */
export function verifyUnsubscribeToken(token: string | null | undefined, secret: string | undefined): UnsubscribeClaim | null {
  if (!token || !secret || secret.length < UNSUBSCRIBE_SECRET_MIN || token.length > 400) return null
  const [payload, sig, ...rest] = token.split('.')
  if (!payload || !sig || rest.length) return null
  const expected = Buffer.from(sign(payload, secret))
  const got = Buffer.from(sig)
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null
  const m = /^v1\.([0-9a-f]{64})\.([0-9]{1,15})$/.exec(Buffer.from(payload, 'base64url').toString('utf8'))
  if (!m) return null
  return { emailHash: m[1], outreachId: Number(m[2]) }
}

export function unsubscribeLink(baseUrl: string, token: string): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`
}
