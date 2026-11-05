import { LoadingStatus, Skeleton, SkeletonCard, SkeletonHeader } from '@/components/Skeleton'

// Tvar detailu klienta: záhlaví, záložky, obsah a vpravo Souvislosti.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle actions />
      <Skeleton className="h-10 w-[28rem] max-w-full rounded-full mb-6" />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Skeleton className="h-28 rounded-card" />
          <div className="grid md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
          <Skeleton className="h-40 rounded-card" />
        </div>
        <div className="space-y-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    </LoadingStatus>
  )
}
