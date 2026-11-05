import { LoadingStatus, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

// Seznam partnerů: dvě tabulky (partneři, registrace v programech).
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow actions />
      <SkeletonTable rows={6} cols={4} />
    </LoadingStatus>
  )
}
