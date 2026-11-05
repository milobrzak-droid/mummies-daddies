import { requireModule } from '@/app/cockpit/moduleGuard'

// Signály outbound agenta (P7) patří k modulu „agent" (CompanyConfig.modules) — vypnutý = 404.
export default function ModuleLayout({ children }: { children: React.ReactNode }) {
  requireModule('agent')
  return children
}
