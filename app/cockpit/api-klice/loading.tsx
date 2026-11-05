import { LoadingStatus, Skeleton } from '@/components/Skeleton'
import { SettingsLoadingHeader } from '@/components/ui/SettingsParts'

export default function Loading() {
  return (
    <LoadingStatus>
      <SettingsLoadingHeader subtitle />
      <Skeleton className="mb-6 h-11 w-72 max-w-full !rounded-full" />
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[112px] rounded-[20px]" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-[24px]" />
        ))}
      </div>
    </LoadingStatus>
  )
}
