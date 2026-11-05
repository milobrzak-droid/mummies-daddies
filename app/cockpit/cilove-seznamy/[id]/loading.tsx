import { LoadingStatus, Skeleton, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

// Detail cílového seznamu: záložky Obchody, dvě karty (stav firem, proč
// tenhle seznam) a tabulka firem v seznamu.
export default function Loading() {
  return (
    <LoadingStatus label="Načítám cílový seznam…">
      <SkeletonHeader eyebrow subtitle actions />
      <div className="mb-6 flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-24 rounded-full" />
        ))}
      </div>
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Skeleton className="h-[188px] rounded-card" />
          <Skeleton className="h-[188px] rounded-card" />
        </div>
        <SkeletonTable rows={6} cols={4} />
      </div>
    </LoadingStatus>
  )
}
