import { LoadingStatus, SkeletonHeader, SkeletonTable } from '@/components/Skeleton'

export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow />
      <SkeletonTable rows={7} cols={4} />
    </LoadingStatus>
  )
}
