import type { Photo } from '@/lib/web/photos'
import { toneAt } from '@/lib/web/tokens'
import { PhotoFrame } from '../PhotoFrame'
import { cx } from '../cx'

/**
 * Galerie fotek z akce: 2 sloupce na mobilu, 4 na desktopu, čtverce.
 * Fotky bez souboru se vykreslí jako pastelový zástupce s alt textem.
 */
export function Gallery({ photos, className }: { photos: readonly Photo[]; className?: string }) {
  if (!photos.length) return null
  const cols = photos.length >= 4 ? 'lg:grid-cols-4' : photos.length === 3 ? 'lg:grid-cols-3' : 'sm:grid-cols-2'
  return (
    <ul role="list" className={cx('grid grid-cols-2 gap-3 sm:gap-4', cols, className)}>
      {photos.map((p, i) => (
        <li key={`${p.slot}-${i}`}>
          <PhotoFrame photo={p} aspect="square" tone={toneAt(i)} sizes="(min-width: 1280px) 300px, (min-width: 1024px) 24vw, 46vw" />
        </li>
      ))}
    </ul>
  )
}
