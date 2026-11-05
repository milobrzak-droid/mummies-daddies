import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

// Případy: souhrn podle oblastí, řádek segmentů a nástěnka podle stavu.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow actions />
      <Skeleton className="mb-6 h-10 w-full max-w-xl rounded-full" />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[112px] rounded-card" />
        ))}
      </div>
      <Skeleton className="mb-6 h-10 w-full max-w-lg rounded-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[280px] rounded-card" />
        ))}
      </div>
    </LoadingStatus>
  )
}
