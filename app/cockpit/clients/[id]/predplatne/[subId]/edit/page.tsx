import { notFound, redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { BackLink, FormCard, REST_BTN_DANGER } from '@/components/ui/RestForm'
import { SubscriptionForm } from '@/components/SubscriptionForm'
import { endSubscription, updateSubscription } from '@/domain/finance/actions/subscriptions'
import { getSubscriptionsForAccount } from '@/domain/finance/queries/subscriptions'
import { canCurrentUserSeeSales } from '@/lib/queries/access'

export default async function EditSubscription({ params }:
  { params: Promise<{ id: string; subId: string }> }) {
  const { id, subId } = await params
  const accountId = Number(id)
  // Předplatné (MRR) je obchodní údaj — jen obchodní role (0058).
  if (!await canCurrentUserSeeSales()) redirect(`/cockpit/clients/${accountId}`)
  const subscription = (await getSubscriptionsForAccount(accountId))
    .find((s) => s.id === Number(subId))
  if (!subscription) notFound()

  async function end() {
    'use server'
    await endSubscription(accountId, Number(subId))
    redirect(`/cockpit/clients/${accountId}`)
  }

  return (
    <>
      <PageHeader title="Upravit předplatné" eyebrow={subscription.product}>
        <BackLink href={`/cockpit/clients/${accountId}`}>Zpět na klienta</BackLink>
      </PageHeader>
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />

      <FormCard id="predplatne" title="Údaje o předplatném" description="Produkt, počet licencí, měsíční částka a obnova." className="max-w-2xl">
        <SubscriptionForm
          action={updateSubscription.bind(null, accountId, subscription.id)}
          accountId={accountId}
          initial={subscription}
          submitLabel="Uložit změny"
        />
      </FormCard>

      {!subscription.ended_on && (
        <FormCard
          id="ukoncit-predplatne"
          title="Ukončit předplatné"
          description="Záznam zůstane, jen se od dneška přestane počítat do měsíční opakované tržby. Smazáním by se zpětně změnily už vykázané měsíce."
          tone="danger"
          className="mt-6 max-w-2xl"
        >
          <form action={end}>
            <button type="submit" className={REST_BTN_DANGER}>
              Ukončit k dnešku
            </button>
          </form>
        </FormCard>
      )}
    </>
  )
}
