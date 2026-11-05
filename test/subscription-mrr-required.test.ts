import { describe, expect, test } from 'vitest'
import { subscriptionSchema } from '@/lib/validation/schemas'

// Regrese: z.coerce.number() dělá z '' / '   ' / null nulu (Number('') === 0),
// takže předplatné s prázdným MRR prošlo validací a uložilo se jako 0 Kč —
// přesně to, před čím varuje komentář u subscriptionSchema (v_mrr_health by
// ho počítal jako 0, ne jako „nezadáno"). HTML `required` server nechrání.

describe('subscriptionSchema — MRR', () => {
  const base = { account_id: '4', product: 'Copilot', mrr: '1500' }

  test('MRR je povinné: prázdné pole ani mezery se nesmí tiše uložit jako 0 Kč', () => {
    for (const empty of ['', '   ', undefined, null]) {
      const r = subscriptionSchema.safeParse({ ...base, mrr: empty })
      expect(r.success, String(empty)).toBe(false)
      expect(r.error?.issues[0].path).toEqual(['mrr'])
      expect(r.error?.issues[0].message).toBe('MRR je povinné.')
    }
  })

  test('MRR 0 zadané výslovně projde, záporné ne', () => {
    expect(subscriptionSchema.parse({ ...base, mrr: '0' }).mrr).toBe(0)
    expect(subscriptionSchema.parse({ ...base, mrr: '1234.5' }).mrr).toBe(1234.5)
    expect(subscriptionSchema.safeParse({ ...base, mrr: 'abc' }).success).toBe(false)
    const neg = subscriptionSchema.safeParse({ ...base, mrr: '-5' })
    expect(neg.error?.issues[0].message).toBe('MRR nemůže být záporné.')
  })
})
