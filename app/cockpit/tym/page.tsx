import { getCurrentMember } from '@/lib/queries/currentMember'
import Link from 'next/link'
import { getMfaStatusByMember, isCurrentUserAdmin, listTeamMembersWithStatus } from '@/lib/queries/team'
import { createParticipant } from '@/lib/actions/team'
import { PageHeader } from '@/components/PageHeader'
import { AddParticipantForm } from '@/components/AddParticipantForm'
import { ParticipantActions } from '@/components/ParticipantActions'
import { Avatar } from '@/components/Avatar'
import { Chip } from '@/components/Chip'
import { SettingsTabs } from '@/components/ui/SettingsTabs'
import { SettingsTile } from '@/components/ui/SettingsParts'
import { CARD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { buttonClass } from '@/components/ui/Button'
import { formatPersonName } from '@/lib/format'
import { TEAM_ROLES, seesByznys } from '@/lib/domain'

export default async function TeamPage() {
  const admin = await isCurrentUserAdmin()
  if (!admin) {
    return (
      <>
        <PageHeader title="Tým" eyebrow="Správa přístupů" />
        <div className={CARD}>
          <EmptyState title="Nemáš oprávnění zobrazit správu týmu." action={{ href: '/cockpit/nastaveni', label: 'Otevřít Nastavení' }}>
            Tým a API klíče spravují jen správci.
          </EmptyState>
        </div>
      </>
    )
  }

  const { user } = await getCurrentMember()
  // Stav 2FA je pomocný údaj: když ho Auth nevydá, stránka se ukáže bez něj.
  const [members, mfaByMember] = await Promise.all([listTeamMembersWithStatus(), getMfaStatusByMember()])
  const admins = members.filter((m) => m.is_admin).length
  const withSales = members.filter((m) => seesByznys(m.role)).length

  return (
    <>
      <PageHeader title="Tým" eyebrow="Správa přístupů" subtitle="Kdo má do Cockpitu přístup, jakou má roli a kdo je správce. Heslo, roli i dvoufázové ověření člena změníš pod Spravovat účet.">
        <a href="#pridat" className={buttonClass('primary')}>Přidat účastníka</a>
      </PageHeader>

      <SettingsTabs isAdmin />

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SettingsTile color="sky" label="Členů týmu" value={members.length} />
        <SettingsTile color="lav" label="Správců" value={admins} note="mohou spravovat tým a klíče" />
        <SettingsTile color="peach" label="Vidí obchody" value={withSales} note="Vedení a Obchodník" />
      </div>

      <section aria-label="Členové týmu" className="mb-5">
        {members.length === 0 ? (
          <div className={CARD}>
            <EmptyState title="Zatím tu nikdo není." action={{ href: '#pridat', label: 'Přidat účastníka' }}>
              Přidej prvního účastníka formulářem níže.
            </EmptyState>
          </div>
        ) : (
          <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 xl:grid-cols-2">
            {members.map((m) => {
              const name = formatPersonName(m.full_name, m.email)
              const roleLabel = TEAM_ROLES.find((r) => r.key === m.role)?.label ?? m.role
              const isSelf = m.id === user?.id
              const mfa = mfaByMember ? (mfaByMember.get(m.id) ?? false) : null
              return (
                <li key={m.id} className={`${CARD} p-5`}>
                  <div className="flex items-center gap-3">
                    <Avatar name={name} size={48} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="m-0 truncate font-heading text-title2 font-bold">{name}</h2>
                        {isSelf && <span className="st info">Ty</span>}
                      </div>
                      <p className="m-0 mt-0.5 truncate text-callout text-muted">{m.email}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Chip tone="neutral">{roleLabel}</Chip>
                    {m.is_admin && <Chip tone="ink">Admin</Chip>}
                    {mfa === true && <Chip tone="pos">2FA nastavené</Chip>}
                    {mfa === false && <Chip tone="warn">2FA zatím nenastavené</Chip>}
                    {m.deactivated_at && <Chip tone="neg">Deaktivovaný</Chip>}
                    <Link href={`/cockpit/tym/${m.id}/predat`} className={buttonClass('outline', 'sm', 'ml-auto')} aria-label={`Předat práci — ${name}`}>
                      Předat práci
                    </Link>
                  </div>
                  <details className="group mt-4 rounded-tile bg-[color:var(--c-soft)]">
                    <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 rounded-tile px-4 py-2 text-callout font-semibold text-ink [&::-webkit-details-marker]:hidden">
                      <span>Spravovat účet</span>
                      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted transition-transform duration-fast group-open:rotate-180"><path d="m6 9 6 6 6-6" /></svg>
                    </summary>
                    <div className="border-t border-border px-4 pb-4 pt-3">
                      <ParticipantActions
                        userId={m.id} isAdmin={m.is_admin} isSelf={isSelf} role={m.role} fullName={m.full_name}
                        displayName={name} mfa={mfa}
                        deactivated={m.deactivated_at !== null}
                      />
                    </div>
                  </details>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Card id="pridat" className="scroll-mt-6" title="Přidat účastníka" sub="Nový člen dostane přístup hned po založení. Heslo mu předej bezpečně, ať si ho změní v Nastavení.">
        <AddParticipantForm action={createParticipant} />
      </Card>
    </>
  )
}
