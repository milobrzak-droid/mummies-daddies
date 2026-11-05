import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle />
      <div className="flex flex-wrap gap-2 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-24 rounded-full" />
        ))}
      </div>
      <Skeleton className="mb-8 h-[132px] rounded-card" />
      <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-6 items-start">
        <Skeleton className="h-[420px] rounded-card" />
        <Skeleton className="h-[420px] rounded-card" />
      </div>
    </LoadingStatus>
  )
}
