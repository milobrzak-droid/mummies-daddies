import { CARD } from '@/components/ui/Card'
import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

// Detail případu: vlevo kroky, rozhodnutí a časová osa, vpravo souvislosti.
export default function Loading() {
  return (
    <LoadingStatus label="Načítám případ…">
      <SkeletonHeader eyebrow subtitle actions />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {[4, 2, 3].map((rows, i) => (
            <div key={i} className={`${CARD} p-5 sm:p-6`}>
              <Skeleton className="h-5 w-32 rounded-full" />
              <div className="mt-4 flex flex-col gap-3">
                {Array.from({ length: rows }).map((_, r) => (
                  <Skeleton key={r} className="h-11 w-full rounded-btn" />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className={`${CARD} p-5 sm:p-6`}>
          <Skeleton className="h-5 w-28 rounded-full" />
          <div className="mt-4 flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-20 rounded-full" />
                <Skeleton className="mt-1.5 h-4 w-40 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </LoadingStatus>
  )
}
