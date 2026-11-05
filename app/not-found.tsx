import Link from 'next/link'
import { StatusPanel, STATUS_TITLE, STATUS_BODY, STATUS_PRIMARY } from '@/components/ui/StatusPanel'

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <StatusPanel eyebrow="404"
        actions={<Link href="/" className={STATUS_PRIMARY}>Zpět na úvodní stránku</Link>}>
        <h1 className={STATUS_TITLE}>Stránka nenalezena.</h1>
        <div className={STATUS_BODY}>
          <p className="m-0">Hledaná stránka neexistuje nebo byla přesunuta.</p>
        </div>
      </StatusPanel>
    </main>
  )
}
