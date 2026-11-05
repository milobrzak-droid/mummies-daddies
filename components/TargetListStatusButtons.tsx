'use client'
import { useState, useTransition } from 'react'
import { setTargetItemStatus } from '@/domain/crm/actions/targetLists'
import { buttonClass } from '@/components/ui/Button'
import { allowedTransitions, TARGET_STATUS_LABEL, type TargetStatus } from '@/domain/crm/targetLists'

export function TargetListStatusButtons({ itemId, status, itemLabel }:
  { itemId: number; status: TargetStatus; itemLabel?: string }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="flex flex-wrap items-center gap-2">
      {allowedTransitions(status).map((to) => (
        <button
          key={to}
          type="button"
          disabled={pending}
          className={buttonClass('outline', 'sm')}
          title={to === 'osloveno' ? 'Zapíše aktivitu na firmu. Obchod nevzniká.' : undefined}
          aria-label={itemLabel ? `${TARGET_STATUS_LABEL[to]} — ${itemLabel}` : undefined}
          onClick={() => start(async () => {
            const r = await setTargetItemStatus(itemId, to)
            setError(r.success ? null : r.error ?? 'Nepodařilo se uložit.')
          })}
        >
          → {TARGET_STATUS_LABEL[to]}
        </button>
      ))}
      {error && <span role="alert" className="text-footnote text-neg">{error}</span>}
    </span>
  )
}
