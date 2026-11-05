import { LoadingStatus, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle />
      <SkeletonTable rows={5} cols={4} />
    </LoadingStatus>
  )
}
