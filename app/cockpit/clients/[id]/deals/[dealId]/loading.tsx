import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow actions />
      <Skeleton className="h-24 mb-4" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-52" />
          <Skeleton className="h-36" />
        </div>
        <Skeleton className="h-64" />
      </div>
      <div className="mt-6 flex gap-2">
        {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-10 w-28 rounded-full" />)}
      </div>
    </LoadingStatus>
  )
}
