import type { ElementType, ReactNode } from 'react'
import { cx } from './cx'

// Jedna mřížka pro celý web (web v2): header, hero i obsah sekcí začínají na stejné svislé
// hraně (px-gutter v max-w-web-wide). `default` je proto stejně široký jako `wide`.
const WIDTH = {
  default: 'max-w-web-wide',
  wide: 'max-w-web-wide',
  prose: 'max-w-web-prose',
} as const

/** Obsahový kontejner: max. šířka + boční okraj (16 px na mobilu → 40 px). */
export function Container({
  as: Tag = 'div',
  width = 'default',
  className,
  children,
}: {
  as?: ElementType
  width?: keyof typeof WIDTH
  className?: string
  children: ReactNode
}) {
  return <Tag className={cx('mx-auto w-full px-gutter', WIDTH[width], className)}>{children}</Tag>
}
