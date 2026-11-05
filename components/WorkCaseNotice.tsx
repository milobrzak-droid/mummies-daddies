import type { ReactNode } from 'react'
import { CARD } from '@/components/ui/Card'
import { FeaturePending } from '@/components/ui/FeaturePending'

// Klidná hláška pro stav „připravuje se“ / chybu načtení (Loop Core).
// Stejná karta jako prázdné stavy jinde (docs/PROVOZ.md §9).
export function WorkCaseNotice({ children }: { children: ReactNode }) {
  return <div className={`${CARD} px-5 py-6 text-callout text-muted`}>{children}</div>
}

// Pracovní případy, dokud databáze nemá migraci 0039 (lidská věta pro všechny).
export function MigrationPendingNotice() {
  return (
    <FeaturePending card migration="0039">
      Pak tu půjde zakládat a vést pracovní případy.
    </FeaturePending>
  )
}
