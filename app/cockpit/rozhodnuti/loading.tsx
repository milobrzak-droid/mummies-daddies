import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

// Kostra ve tvaru stránky: souhrn (segment) → karty → historie.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle />
      <div className="flex max-w-[960px] flex-col gap-6">
        <Skeleton className="h-10 w-80 max-w-full rounded-full" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[280px]" />
          <Skeleton className="h-[280px]" />
        </div>
        <Skeleton className="h-[200px]" />
      </div>
    </LoadingStatus>
  )
}
