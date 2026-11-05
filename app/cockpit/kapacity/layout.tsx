import { requireModule } from '@/app/cockpit/moduleGuard'

// Modul „capacity" jde u firmy vypnout (CompanyConfig.modules) — pak 404.
export default function ModuleLayout({ children }: { children: React.ReactNode }) {
  requireModule('capacity')
  return children
}
