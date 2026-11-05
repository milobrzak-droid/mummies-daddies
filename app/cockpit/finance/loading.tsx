import { LoadingStatus, Skeleton, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

// Kostra ve tvaru stránky: filtr v řádku → čtyři karty → tabulka a boční sloupec.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle actions />
      <div className="flex flex-col gap-6">
        <Skeleton className="h-[76px]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[248px]" />
          ))}
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <SkeletonTable rows={5} cols={6} />
          <Skeleton className="h-[220px]" />
        </div>
      </div>
    </LoadingStatus>
  )
}
