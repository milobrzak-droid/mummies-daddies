import { notFound } from 'next/navigation'
import { COMPANY } from '@/config'
import { isModuleOn } from '@/core/modules'
import type { ModuleKey } from '@/core/tenant'

// Brána vypnutého modulu (CompanyConfig.modules): stránka modulu vrátí 404.
// Volá se z layout.tsx modulu, takže platí pro všechny jeho podstránky.
export function requireModule(key: ModuleKey): void {
  if (!isModuleOn(COMPANY.modules, key)) notFound()
}
