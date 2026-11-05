'use client'
// Záložní „Založit dodávku" u vyhraného obchodu, ke kterému dodávka chybí
// (běžně vzniká sama, viz DealDeliveryCard). Zavolá stejné jádro jako
// automatika a přesměruje na založenou dodávku.
import { useActionState } from 'react'
import { SubmitButton } from '@/components/SubmitButton'
import { createDeliveryForDeal } from '@/domain/delivery/actions/autoDelivery'

export function CreateDeliveryButton({ accountId, dealId }: { accountId: number; dealId: number }) {
  const [state, formAction] = useActionState(createDeliveryForDeal.bind(null, accountId, dealId), null)
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <SubmitButton variant="coral">Založit dodávku</SubmitButton>
      {state?.error && <span role="alert" className="text-sm text-neg">{state.error}</span>}
    </form>
  )
}
