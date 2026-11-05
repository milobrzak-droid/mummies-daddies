import { requireModule } from '@/app/cockpit/moduleGuard'

// Modul „targetLists" jde u firmy vypnout (CompanyConfig.modules) — pak 404.
export default function ModuleLayout({ children }: { children: React.ReactNode }) {
  requireModule('targetLists')
  return children
}
