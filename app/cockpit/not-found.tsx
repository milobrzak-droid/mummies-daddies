import Link from 'next/link'
import { StatusPanel, STATUS_TITLE, STATUS_BODY, STATUS_PRIMARY, STATUS_SECONDARY } from '@/components/ui/StatusPanel'

// 404 uvnitř aplikace: žádná slepá ulička – Dnes a hledání (docs/PROVOZ.md §11).
export default function NotFound() {
  return (
    <div className="py-8">
      <StatusPanel eyebrow="404"
        actions={(
          <>
            <Link href="/cockpit" className={STATUS_PRIMARY}>Zpět na Dnes</Link>
            <Link href="/cockpit/hledat" className={STATUS_SECONDARY}>Hledat</Link>
          </>
        )}>
        <h1 className={STATUS_TITLE}>Stránka nenalezena.</h1>
        <div className={STATUS_BODY}>
          <p className="m-0">Hledaná stránka neexistuje nebo byla přesunuta. Záznam najdeš přes hledání (⌘K).</p>
        </div>
      </StatusPanel>
    </div>
  )
}
