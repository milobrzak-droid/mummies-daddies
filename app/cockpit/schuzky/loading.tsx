import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

// Schůzky: zápisy vlevo, formulář Naplánovat schůzku vpravo (pod sebou na mobilu).
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle actions />
      <div className="flex flex-wrap gap-2 mb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-24 rounded-full" />
        ))}
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Skeleton className="h-[420px] rounded-card" />
        <Skeleton className="h-[520px] rounded-card" />
      </div>
    </LoadingStatus>
  )
}
