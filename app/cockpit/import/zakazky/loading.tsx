import { CARD } from '@/components/ui/Card'
import { LoadingStatus, Skeleton, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

// Hromadný import: karta „Odkud zakázky nahrát“ (přepínač zdroje a plocha
// pro soubor), pod ní dřívější importy.
export default function Loading() {
  return (
    <LoadingStatus label="Načítám import zakázek…">
      <SkeletonHeader eyebrow subtitle actions />
      <div className="space-y-6">
        <div className={`${CARD} p-5 sm:p-6`}>
          <Skeleton className="h-5 w-56 rounded-full" />
          <Skeleton className="mt-2 h-4 w-full max-w-lg rounded-full" />
          <Skeleton className="mt-5 h-10 w-72 max-w-full rounded-full" />
          <Skeleton className="mt-5 h-[148px] w-full rounded-tile" />
        </div>
        <SkeletonTable rows={4} cols={4} />
      </div>
    </LoadingStatus>
  )
}
