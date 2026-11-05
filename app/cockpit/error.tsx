'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { StatusPanel, STATUS_TITLE, STATUS_BODY, STATUS_PRIMARY, STATUS_SECONDARY } from '@/components/ui/StatusPanel'

// retry() (Next 16.3) znovu načte serverová data segmentu; reset() by jen
// překreslil tutéž chybu, pokud selhal serverový dotaz.
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="py-8">
      <StatusPanel eyebrow="Chyba" tone="error" alert
        actions={(
          <>
            <button onClick={() => retry()} className={STATUS_PRIMARY}>Zkusit znovu</button>
            <Link href="/cockpit" className={STATUS_SECONDARY}>Zpět na Dnes</Link>
          </>
        )}>
        <h1 className={STATUS_TITLE}>Něco se pokazilo.</h1>
        <div className={STATUS_BODY}>
          <p className="m-0">Stránku se nepodařilo načíst. Zkus to znovu, nebo se vrať na Dnes.</p>
          {error.digest && (
            <p className="m-0 text-footnote">
              Kód chyby: <span className="font-mono">{error.digest}</span>
            </p>
          )}
        </div>
      </StatusPanel>
    </div>
  )
}
