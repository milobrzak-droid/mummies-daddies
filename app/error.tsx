'use client'

import { useEffect } from 'react'
import { StatusPanel, STATUS_TITLE, STATUS_BODY, STATUS_PRIMARY } from '@/components/ui/StatusPanel'

// Chybová hranice pro stránky mimo přihlášenou aplikaci (/login, /auth/…).
// Stránky v app/cockpit mají vlastní error.tsx s odkazem zpět na přehled;
// tady by vedl na chráněnou stránku, proto nabízíme jen „Zkusit znovu“.
export default function RootError({
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
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <StatusPanel eyebrow="Chyba" tone="error" alert
        actions={<button onClick={() => retry()} className={STATUS_PRIMARY}>Zkusit znovu</button>}>
        <h1 className={STATUS_TITLE}>Něco se pokazilo.</h1>
        <div className={STATUS_BODY}>
          <p className="m-0">Stránku se nepodařilo načíst. Zkus to znovu.</p>
          {error.digest && (
            <p className="m-0 text-footnote">
              Kód chyby: <span className="font-mono">{error.digest}</span>
            </p>
          )}
        </div>
      </StatusPanel>
    </main>
  )
}
