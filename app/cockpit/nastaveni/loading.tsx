import { LoadingStatus, Skeleton } from '@/components/Skeleton'
import { SettingsLoadingHeader } from '@/components/ui/SettingsParts'

export default function Loading() {
  return (
    <LoadingStatus>
      <SettingsLoadingHeader subtitle />
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <Skeleton className="h-40 rounded-[24px]" />
          <Skeleton className="h-56 rounded-[24px]" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-52 rounded-[24px]" />
          <Skeleton className="h-40 rounded-[24px]" />
        </div>
      </div>
    </LoadingStatus>
  )
}
