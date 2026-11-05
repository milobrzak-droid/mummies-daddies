import { LoadingStatus, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow subtitle actions />
      <SkeletonTable rows={8} cols={5} />
    </LoadingStatus>
  )
}
