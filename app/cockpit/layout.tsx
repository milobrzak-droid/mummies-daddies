import { redirect } from 'next/navigation'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { Sidebar } from '@/components/Sidebar'
import { AppProviders } from '@/components/AppProviders'
import { isInternalRole, seesByznys } from '@/lib/domain'
import { signOut } from '@/app/login/actions'
import { PageHeader } from '@/components/PageHeader'
import { buttonClass } from '@/components/ui/Button'
import { COMPANY } from '@/config'

// Interní Cockpit (/cockpit/**): přihlášení hlídá proxy (lib/supabase/middleware.ts)
// a znovu tenhle layout; veřejný web je v app/(web).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, member } = await getCurrentMember()
  if (!user) redirect('/login')
  // Role Partner (externí účet) a člen bez řádku v team_member nemají přístup
  // k interní evidenci (RLS je odmítá od migrace 0082, server akce od
  // requireUser). Sem se nedostane žádná stránka ani menu — jen tohle sdělení.
  if (!isInternalRole(member?.role)) {
    return (
      <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
        <PageHeader
          eyebrow={COMPANY.productName}
          title="Bez přístupu"
          subtitle={<>Tenhle účet ({user.email}) nemá přístup do interní evidence {COMPANY.name}. Pokud ho potřebuješ,
            napiš správci týmu, ať ti nastaví roli.</>}
        />
        <div className="flex flex-wrap gap-2">
          <a href="/auth/mfa/enroll" className={buttonClass('outline')}>Zabezpečení (2FA)</a>
          <form action={signOut}>
            <button type="submit" className={buttonClass('secondary')}>Odhlásit se</button>
          </form>
        </div>
      </main>
    )
  }
  const canSeeSales = seesByznys(member?.role)
  return (
    <AppProviders
      canSeeSales={canSeeSales}
      isAdmin={member?.is_admin ?? false}
      showTechDetail={(member?.is_admin ?? false) || member?.role === 'vedeni'}
    >
    <div className="min-h-screen flex bg-bg">
      {/* Odkaz „přeskočit na obsah“: první prvek pro Tab, viditelný jen při fokusu.
          Klávesnice tak nemusí na každé stránce projít celou navigaci. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-btn focus:bg-cta-bg focus:px-4 focus:py-2 focus:text-sm focus:text-cta-fg"
      >
        Přeskočit na obsah
      </a>
      <Sidebar
        name={member?.full_name ?? user.email ?? ''}
        isAdmin={member?.is_admin ?? false}
        canSeeSales={canSeeSales}
      />
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none space-y-8 px-4 pb-28 pt-5 sm:px-6 md:space-y-10 md:px-8 md:py-8">{children}</main>
    </div>
    </AppProviders>
  )
}
