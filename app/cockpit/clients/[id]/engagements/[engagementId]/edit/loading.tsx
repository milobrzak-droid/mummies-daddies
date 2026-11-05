import { LoadingStatus, Skeleton, SkeletonHeader } from '@/components/Skeleton'

// Dodávka: hlavička, pás s lidmi a termíny, záložky, časová osa + kvalita.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow actions />
      <Skeleton className="h-[76px] mb-5" />
      <div className="flex flex-wrap gap-2 mb-6">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-24 rounded-full" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] mb-5">
        <Skeleton className="h-[340px]" />
        <Skeleton className="h-[340px]" />
      </div>
      <Skeleton className="h-[180px]" />
    </LoadingStatus>
  )
}
