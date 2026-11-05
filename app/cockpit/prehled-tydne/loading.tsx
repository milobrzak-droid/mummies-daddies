import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

// Kostra přehledu týdne: záložky, přepínač týdne, klávesy se souhrnem
// a karty sekcí ve dvou sloupcích.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle />
      <Skeleton className="mb-4 h-10 w-80 max-w-full rounded-full" />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-[96px] rounded-card" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-card" />
        ))}
      </div>
    </LoadingStatus>
  )
}
