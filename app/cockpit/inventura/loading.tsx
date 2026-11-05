import { LoadingStatus, SkeletonCard, SkeletonHeader } from '@/components/Skeleton'

// Inventura: sloupec karet obchodů s formulářem.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle actions />
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} className="h-[140px]" />
        ))}
      </div>
    </LoadingStatus>
  )
}
