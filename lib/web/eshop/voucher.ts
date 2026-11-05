/**
 * Dárkový poukaz: hodnoty a validace (stejná pravidla jako mock submitVoucherOrder
 * v lib/web/api.ts). Bez JSON → bezpečné pro klienta.
 *
 * Hodnoty doslova z copy /darkovy-poukaz › hodnoty („1 000 Kč … 5 000 Kč“, test to hlídá).
 * Minimum vlastní částky klient nedodal („Zadejte částku od [DOPLNÍ KLIENT] Kč.“) →
 * VOUCHER_MIN_CUSTOM = null a vlastní částka musí být jen kladné celé číslo.
 */
import type { FieldErrors, VoucherField, VoucherOrder } from '../api'
import { PAYMENT_METHODS } from '../options'
import { isEmail, MESSAGES } from '../validation'

export const VOUCHER_PRESETS = [1000, 1500, 2000, 2500, 5000] as const
/** Minimum vlastní částky v Kč (null = klient zatím nedodal). */
export const VOUCHER_MIN_CUSTOM: number | null = null
/** Horní mez vlastní částky jen jako pojistka proti překlepu (není to obchodní pravidlo). */
export const VOUCHER_MAX_CUSTOM = 100_000

export const VOUCHER_MESSAGES = {
  /** Mikrotext „POUKAZ — chyba částka“ (doslova, se zástupcem). */
  amount: 'Zadejte částku od [DOPLNÍ KLIENT] Kč.',
} as const

export function isValidVoucherAmount(amount: unknown): amount is number {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return false
  if (amount < Math.max(1, VOUCHER_MIN_CUSTOM ?? 1)) return false
  return amount <= VOUCHER_MAX_CUSTOM
}

export function validateVoucher(v: Partial<VoucherOrder>): FieldErrors<VoucherField> {
  const e: FieldErrors<VoucherField> = {}
  if (!isValidVoucherAmount(v.amount)) e.amount = VOUCHER_MESSAGES.amount
  if (!v.recipientName?.trim()) e.recipientName = MESSAGES.required
  if (!v.deliveryEmail?.trim()) e.deliveryEmail = MESSAGES.required
  else if (!isEmail(v.deliveryEmail)) e.deliveryEmail = MESSAGES.email
  if (!v.payment || !PAYMENT_METHODS.some((p) => p.value === v.payment)) e.payment = MESSAGES.required
  if (v.consent !== true) e.consent = MESSAGES.orderConsent
  return e
}
