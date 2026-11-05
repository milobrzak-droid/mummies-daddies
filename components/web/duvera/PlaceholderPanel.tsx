import type { ReactNode } from 'react'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'

/**
 * Panel pro obsah, který dodá klient (loga, citace, galerie bez souhlasu…):
 * jemný přerušovaný rámeček na papíru, uvnitř text z copy se zástupcem.
 */
export function PlaceholderPanel({ text, className, children }: { text: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cx('rounded-soft border border-dashed border-cocoa/30 bg-paper/70 px-6 py-8 text-center sm:px-10', className)}>
      <p className="md-pretty mx-auto max-w-2xl text-copy text-cocoa-soft">
        <PlaceholderText text={text} />
      </p>
      {children}
    </div>
  )
}
