import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow actions />
      <div className="mb-6 flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-32 rounded-full" />)}
      </div>
      <Skeleton className="mb-6 h-[150px]" />
      <Skeleton className="mb-4 h-10 w-full max-w-3xl rounded-full" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[420px] rounded-card" />
        ))}
      </div>
    </LoadingStatus>
  )
}
