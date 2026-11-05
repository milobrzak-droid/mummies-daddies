import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow />
      <div className="mb-6 flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-32 rounded-full" />)}
      </div>
      <Skeleton className="mb-6 h-[260px]" />
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[220px]" />)}
      </div>
      <Skeleton className="h-64" />
    </LoadingStatus>
  )
}
