import Link from 'next/link'
import { notFound } from 'next/navigation'
import { isCurrentUserAdmin, listTeamMembersWithStatus } from '@/lib/queries/team'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { loadMemberOpenWork } from '@/lib/queries/memberWork'
import { WORK_KINDS, countLabel, workCounts, type WorkGroup } from '@/lib/memberWork'
import { teamMemberId } from '@/lib/validation/schemas'
import { TEAM_ROLES, isInternalRole } from '@/lib/domain'
import { formatPersonName } from '@/lib/format'
import { pragueToday } from '@/lib/pragueDate'
import { PageHeader } from '@/components/PageHeader'
import { Avatar } from '@/components/Avatar'
import { Chip } from '@/components/Chip'
import { SettingsTabs } from '@/components/ui/SettingsTabs'
import { SettingsTile } from '@/components/ui/SettingsParts'
import { CARD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { MemberHandoverForm } from '@/components/MemberHandoverForm'

// „Předat práci" (jen správce): přehled všeho otevřeného, co člověk vlastní
// nebo řeší, a hromadné předání jinému členovi týmu. Revize stavu 29. 9.
// (zastupitelnost): při odchodu nebo změně vlastníka nesmí zůstat osiřelé věci.

function GroupCard({ group }: { group: WorkGroup }) {
  const kind = WORK_KINDS.find((k) => k.key === group.kind)!
  const n = group.items.length
  return (
    <section className={`${CARD} p-5`} aria-label={kind.label}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 mr-auto font-heading text-title2 font-bold">{kind.label}</h2>
        {group.state === 'unavailable' ? (
          <span className="st">připravuje se</span>
        ) : group.state === 'error' ? (
          <span className="st fail">nepodařilo se načíst</span>
        ) : (
          <span className={n > 0 ? 'st' : 'st done'}>{n > 0 ? countLabel(group.kind, n) : 'nic otevřeného'}</span>
        )}
      </div>
      {group.hiddenTitles && <p className="m-0 mb-2 text-callout text-muted">Názvy obchodů a cílových seznamů vidí jen obchodní role; předat je jde i tak.</p>}
      {n > 0 && (
        <ul className="m-0 list-none p-0">
          {group.items.slice(0, 12).map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-[color:var(--c-line-2)] py-2 text-body first:border-t-0">
              {i.href ? (
                <Link href={i.href} className="min-w-0 font-semibold underline-offset-2">{i.title}</Link>
              ) : (
                <span className="min-w-0 font-semibold">{i.title}</span>
              )}
              <Chip tone={i.role === 'zástupce' || i.role === 'zástup' ? 'neutral' : 'ink'}>{i.role}</Chip>
              {i.detail && <span className="w-full text-footnote text-muted">{i.detail}</span>}
            </li>
          ))}
          {n > 12 && <li className="pt-2 text-callout text-muted">…a dalších {n - 12}</li>}
        </ul>
      )}
    </section>
  )
}

export default async function HandoverPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await isCurrentUserAdmin()
  if (!admin) {
    return (
      <>
        <PageHeader title="Předat práci" eyebrow="Tým a nastavení · Tým" />
        <div className={CARD}>
          <EmptyState title="Nemáš oprávnění zobrazit správu týmu." action={{ href: '/cockpit/nastaveni', label: 'Otevřít Nastavení' }}>
            Předávat práci mohou jen správci.
          </EmptyState>
        </div>
      </>
    )
  }

  const { id } = await params
  if (!teamMemberId.safeParse(id).success) notFound()
  const [members, canSeeSales] = await Promise.all([listTeamMembersWithStatus(), canCurrentUserSeeSales()])
  const member = members.find((m) => m.id === id)
  if (!member) notFound()

  const work = await loadMemberOpenWork(id, { canSeeSales, today: pragueToday() })
  const counts = workCounts(work)
  const name = formatPersonName(member.full_name, member.email)
  const roleLabel = TEAM_ROLES.find((r) => r.key === member.role)?.label ?? member.role
  const targets = members
    .filter((m) => m.id !== id && m.deactivated_at === null && isInternalRole(m.role))
    .map((m) => ({
      id: m.id,
      name: formatPersonName(m.full_name, m.email),
      roleLabel: TEAM_ROLES.find((r) => r.key === m.role)?.label ?? m.role,
    }))
  const unavailable = work.groups.filter((g) => g.state === 'unavailable').map((g) => g.kind)
  const nonEmpty = work.groups.filter((g) => g.items.length > 0 || g.state !== 'ok')

  return (
    <>
      <PageHeader
        title={`Předat práci: ${name}`}
        eyebrow="Tým a nastavení · Tým"
        back={{ href: '/cockpit/tym', label: 'Tým' }}
        subtitle="Všechno otevřené, co člověk vlastní, zastupuje nebo řeší. Při odchodu nebo změně vlastníka to předej jednomu člověku najednou — nic nezůstane osiřelé."
      />

      <SettingsTabs isAdmin />

      <section className={`${CARD} mb-5 flex flex-wrap items-center gap-3 px-5 py-4`} aria-label="Člen týmu">
        <Avatar name={name} size={44} />
        <div className="min-w-0">
          <b className="block font-heading text-title2">{name}</b>
          <span className="text-callout text-muted">{member.email}</span>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Chip tone="neutral">{roleLabel}</Chip>
          {member.is_admin && <Chip tone="ink">Admin</Chip>}
          {member.deactivated_at && <Chip tone="neg">Deaktivovaný</Chip>}
        </div>
      </section>

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SettingsTile color="peach" label="Otevřených věcí" value={work.total} note={work.incomplete ? 'část se nepodařilo načíst' : undefined} />
        <SettingsTile color="lav" label="Obchody, seznamy a klienti" value={counts.obchody + counts.seznamy + counts.klienti} />
        <SettingsTile color="mint" label="Dodávky a milníky" value={counts.dodavky + counts.milniky} />
        <SettingsTile color="sun" label="Úkoly a případy" value={counts.ukoly + counts.pripady} note={`${countLabel('alokace', counts.alokace)}, ${countLabel('oblasti', counts.oblasti)}`} />
      </div>

      <Card
        title="Předat práci"
        sub="Vyber, komu práci předáváš a které druhy. Předání proběhne najednou, zapíše se do auditu a objeví se v „Co se změnilo“."
        className="mb-5"
      >
        <MemberHandoverForm fromId={id} fromName={name} targets={targets} counts={counts} unavailable={unavailable} />
      </Card>

      {work.total === 0 && !work.incomplete ? (
        <div className={CARD}>
          <EmptyState title="Nic otevřeného" tone="calm">
            {`${name} nemá žádnou otevřenou práci — deaktivace nic neosiří.`}
          </EmptyState>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {nonEmpty.map((g) => <GroupCard key={g.kind} group={g} />)}
        </div>
      )}
    </>
  )
}
