import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow />
      <div className="mb-6 flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-32 rounded-full" />)}
      </div>
      <div className="mb-8 grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[220px]" />)}
      </div>
      <Skeleton className="h-64" />
    </LoadingStatus>
  )
}
