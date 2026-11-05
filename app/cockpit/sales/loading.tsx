import { LoadingStatus, SkeletonHeader } from '@/components/Skeleton'

// /sales je jen redirect na "/?view=byznys" (žádné vlastní datové načítání),
// ale segment loading.tsx tu má být pro konzistenci a pro krátký okamžik
// mezi navigací a přesměrováním.
export default function Loading() {
  return (
    <LoadingStatus>
      <SkeletonHeader eyebrow />
    </LoadingStatus>
  )
}
