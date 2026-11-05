import { LoadingStatus, Skeleton, SkeletonCard } from '@/components/Skeleton'
import { SettingsLoadingHeader } from '@/components/ui/SettingsParts'

export default function Loading() {
  return (
    <LoadingStatus>
      <SettingsLoadingHeader />
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} className="!rounded-[24px]" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Skeleton className="h-[320px] rounded-[24px]" />
        <Skeleton className="h-[320px] rounded-[24px]" />
      </div>
    </LoadingStatus>
  )
}
