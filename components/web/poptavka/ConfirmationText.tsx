'use client'

import { useEffect, useState } from 'react'
import { CONFIRMATION_STORAGE_KEY, type StoredConfirmation } from '@/lib/web/poptavka/types'
import { UI_TEXT, fillText } from '@/lib/web/poptavka/ui-text'
import { PlaceholderText } from '../PlaceholderText'
import { EstimateCard } from './EstimateCard'

/**
 * Text potvrzení s doplněným e-mailem a orientačním rozpětím z poslední
 * odeslané poptávky (sessionStorage z průvodce). Bez uložených údajů
 * (přímá návštěva, jiná záložka) se místo e-mailu ukáže „váš e-mail“.
 */
export function ConfirmationText({ template, showEstimate = true }: { template: string; showEstimate?: boolean }) {
  const [stored, setStored] = useState<StoredConfirmation | null>(null)
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(CONFIRMATION_STORAGE_KEY)
      if (raw) setStored(JSON.parse(raw) as StoredConfirmation)
    } catch {
      /* bez úložiště jen obecný text */
    }
  }, [])
  const text = fillText(template, { 'e-mail': stored?.email || UI_TEXT.yourEmail })
  return (
    <>
      <p className="md-pretty mt-6 max-w-2xl text-lead text-cocoa">
        <PlaceholderText text={text} />
      </p>
      {showEstimate && stored?.estimate ? <EstimateCard estimate={stored.estimate} guests={stored.guests || null} className="mt-8 max-w-md" /> : null}
    </>
  )
}
