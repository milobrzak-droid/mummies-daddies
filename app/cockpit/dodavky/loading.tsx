import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

// Portfolio dodávek: záložky, klávesy se souhrnem a karty dodávek.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow />
      <div className="flex flex-wrap gap-2 mb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-24 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-5 mb-6 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px]" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-[520px]" />
        ))}
      </div>
    </LoadingStatus>
  )
}
