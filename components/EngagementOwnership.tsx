'use client'
// Vlastnictví dodávky jménem a se zástupcem (kap. 6, 0061). Vlastníka
// a zástupce mění tlačítko „Změnit vlastníka" (audit, „Co se změnilo", Zpět;
// 0093); formulář níž ukládá jen realizační tým. Bez kontextu (starší
// volající) zůstávají výběry vlastníka a zástupce ve formuláři jako dřív.
import { useActionState } from 'react'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { updateEngagementOwnership } from '@/domain/delivery/actions/impact'
import { COMPANY } from '@/config'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { OwnerChange } from '@/components/OwnerChange'
import { canChangeOwner, type OwnerActor, type OwnerPerson } from '@/lib/ownerChange'

export function EngagementOwnership({
  accountId, engagementId, members, ownerId, deputyId, deliveryTeam, available, ownerContext, closed = false,
}: {
  accountId: number
  engagementId: number
  members: { id: string; full_name: string }[]
  ownerId: string | null
  deputyId: string | null
  deliveryTeam: string | null
  /** false = sloupce z 0061 v DB ještě nejsou. */
  available: boolean
  /** Kdo se dívá a koho jde vybrat (lib/queries/ownerChange.ts). */
  ownerContext?: { actor: OwnerActor | null; members: OwnerPerson[] }
  /** Uzavřená dodávka: vlastníka už nejde předat. */
  closed?: boolean
}) {
  const [state, formAction] = useActionState(updateEngagementOwnership.bind(null, accountId, engagementId), null)
  if (!available) {
    return (
      <FeaturePending card variant="compact" migration="0061">
        Pak tu půjde určit vlastníka, zástupce a realizační tým.
      </FeaturePending>
    )
  }
  const fe = state?.fieldErrors ?? {}
  const name = (id: string | null) => (id ? members.find((m) => m.id === id)?.full_name ?? null : null)
  const managed = ownerContext !== undefined
  const team = (
    <FormField label="Realizační tým" error={fe.delivery_team}>
      <select name="delivery_team" defaultValue={deliveryTeam ?? ''} className="w-full">
        <option value="">Neurčeno</option>
        {COMPANY.deliveryTeams.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
    </FormField>
  )
  const status = (
    <div className="md:col-span-3 flex items-center gap-3">
      <SubmitButton>{managed ? 'Uložit realizační tým' : 'Uložit vlastnictví'}</SubmitButton>
      {state?.success && <p role="status" className="text-sm text-muted">Uloženo.</p>}
      {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
    </div>
  )
  if (managed) {
    // Tlačítko „Změnit vlastníka" má vlastní formulář, proto stojí mimo <form> týmu
    // (vnořené formuláře se nesmí). Formulář týmu nese vlastníka a zástupce beze změny.
    return (
      <div className={`${CARD} ${CARD_PAD} flex flex-col gap-4`}>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="m-0 text-body">
            <span className="text-muted">Vlastník</span> <b className="font-semibold">{name(ownerId) ?? 'nepřiřazen'}</b>
            <span className="mx-2 text-muted">·</span>
            <span className="text-muted">Zástupce</span> <b className="font-semibold">{name(deputyId) ?? 'nepřiřazen'}</b>
          </p>
          {!closed && (
            <div>
              <OwnerChange
                kind="dodavky"
                itemId={engagementId}
                itemLabel="dodávka"
                owner={{ id: ownerId, name: name(ownerId) }}
                deputy={{ id: deputyId, name: name(deputyId) }}
                members={ownerContext.members}
                canChange={canChangeOwner('dodavky', ownerContext.actor, { ownerId, deputyId })}
              />
            </div>
          )}
        </div>
        <form action={formAction} className="grid gap-3 md:grid-cols-3">
          <input type="hidden" name="owner_id" value={ownerId ?? ''} />
          <input type="hidden" name="deputy_id" value={deputyId ?? ''} />
          {team}
          {status}
        </form>
      </div>
    )
  }
  return (
    <form action={formAction} className={`${CARD} ${CARD_PAD} grid gap-3 md:grid-cols-3`}>
      <FormField label="Vlastník" error={fe.owner_id}>
        <select name="owner_id" defaultValue={ownerId ?? ''} className="w-full">
          <option value="">Nikdo</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
        </select>
      </FormField>
      <FormField label="Zástupce" error={fe.deputy_id} hint="Jiný člověk než vlastník.">
        <select name="deputy_id" defaultValue={deputyId ?? ''} className="w-full">
          <option value="">Nikdo</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
        </select>
      </FormField>
      {team}
      {status}
    </form>
  )
}
