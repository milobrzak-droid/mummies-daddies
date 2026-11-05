'use client'
import { useActionState } from 'react'
import { SubmitButton } from '@/components/SubmitButton'
import { snoozeOutreach, markOutreachNudged } from '@/domain/crm/actions/outreach'

// Řádkové akce fronty oslovování — malá klientská komponenta na řádek, každá
// akce vlastní useActionState, žádný sdílený stav mezi řádky.
//
// Tlačítko pro nudged_on se schválně nejmenuje "Vyřešeno" — domain/crm/outreach.ts
// (dueForOutreach) bere nudged_on jako shodu jen s DNEŠNÍM dnem, takže po
// půlnoci se firma bez dalšího zásahu vrátí do fronty. Popisek tomu
// odpovídá, ať tlačítko neslibuje trvalé vyřízení, které nedělá.
export function OutreachRowActions({ accountId, accountName }: { accountId: number; accountName: string }) {
  const [snoozed, snoozeAction] = useActionState<boolean>(async () => {
    await snoozeOutreach(accountId, 30)
    return true
  }, false)
  const [hiddenToday, hideAction] = useActionState<boolean>(async () => {
    await markOutreachNudged(accountId)
    return true
  }, false)

  if (snoozed) return <span role="status" className="text-footnote text-muted">Odloženo o 30 dní.</span>
  if (hiddenToday) return <span role="status" className="text-footnote text-muted">Skryto do zítřka.</span>

  return (
    <div className="flex flex-wrap justify-end gap-2">
      <form action={hideAction}>
        <SubmitButton variant="soft" size="sm" aria-label={`Skrýt ${accountName} do zítřka`}>Skrýt do zítřka</SubmitButton>
      </form>
      <form action={snoozeAction}>
        <SubmitButton variant="soft" size="sm" aria-label={`Odložit ${accountName} o 30 dní`}>Odložit o 30 dní</SubmitButton>
      </form>
    </div>
  )
}
