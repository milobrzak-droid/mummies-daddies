import { requireModule } from '@/app/cockpit/moduleGuard'

// Modul „meetings" jde u firmy vypnout (CompanyConfig.modules) — pak 404.
export default function ModuleLayout({ children }: { children: React.ReactNode }) {
  requireModule('meetings')
  return children
}
