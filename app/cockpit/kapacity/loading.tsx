import { LoadingStatus, Skeleton, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

// Kapacity: záložky Práce, pruh upozornění, využití týmu vedle plánu na
// 8 týdnů, pak tabulka alokací.
export default function Loading() {
  return (
    <LoadingStatus label="Načítám kapacity…">
      <SkeletonHeader eyebrow subtitle actions />
      <div className="mb-6 flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-24 rounded-full" />
        ))}
      </div>
      <div className="flex flex-col gap-8">
        <Skeleton className="h-[64px] w-full rounded-card" />
        <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <Skeleton className="h-[300px] rounded-card" />
          <Skeleton className="h-[300px] rounded-card" />
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Skeleton className="h-[260px] rounded-card" />
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[76px] rounded-tile" />
            ))}
          </div>
        </div>
        <SkeletonTable rows={5} cols={5} />
      </div>
    </LoadingStatus>
  )
}
