import { LoadingStatus, Skeleton } from '@/components/Skeleton'
import { SettingsLoadingHeader } from '@/components/ui/SettingsParts'

export default function Loading() {
  return (
    <LoadingStatus label="Hledám…">
      <SettingsLoadingHeader />
      <Skeleton className="mb-6 h-12 w-full max-w-2xl !rounded-full" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-52 rounded-[24px]" />
        <Skeleton className="h-52 rounded-[24px]" />
      </div>
    </LoadingStatus>
  )
}
