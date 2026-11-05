// Podklady pro tlačítko „Změnit vlastníka" (components/OwnerChange.tsx): kdo se
// dívá (role, správce) a koho jde vybrat (aktivní člen s interní rolí).
// Čte se přihlášeným uživatelem; když se to nepodaří, tlačítko se prostě
// neukáže (bez aktéra se nic nenabízí) — stránka kvůli tomu nespadne.
import { getCurrentMember } from '@/lib/queries/currentMember'
import { listTeamMembersWithStatus } from '@/lib/queries/team'
import { logError } from '@/lib/log'
import { formatPersonName } from '@/lib/format'
import { ownerOptions, type OwnerActor, type OwnerPerson } from '@/lib/ownerChange'

export type OwnerChangeContext = {
  actor: OwnerActor | null
  /** Aktivní členové s interní rolí — z nich se vybírá. */
  members: OwnerPerson[]
  /**
   * Jméno kohokoli (i deaktivovaného) pro zobrazení stávajícího držitele.
   * POZOR: funkce, do klientských komponent se nepředává — tam jde jen
   * { actor, members } (viz clientOwnerContext).
   */
  nameOf: (id: string | null | undefined) => string | null
}

/** Serializovatelná část kontextu pro klientské komponenty. */
export function clientOwnerContext(ctx: OwnerChangeContext): { actor: OwnerActor | null; members: OwnerPerson[] } {
  return { actor: ctx.actor, members: ctx.members }
}

export async function loadOwnerChangeContext(): Promise<OwnerChangeContext> {
  try {
    const [{ user, member }, all] = await Promise.all([getCurrentMember(), listTeamMembersWithStatus()])
    const names = new Map(all.map((m) => [m.id, formatPersonName(m.full_name, m.email)]))
    return {
      actor: user && member ? { id: user.id, role: member.role, is_admin: member.is_admin } : null,
      members: ownerOptions(all),
      nameOf: (id) => (id ? names.get(id) ?? null : null),
    }
  } catch (e) {
    logError('ownerChange.context', e)
    return { actor: null, members: [], nameOf: () => null }
  }
}
