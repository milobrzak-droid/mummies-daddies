import type { Metadata } from 'next'
import { COMPANY } from '@/config'

// Veřejný web firmy (balík P6). Všechno v app/(web)/ je dostupné BEZ
// přihlášení (lib/routes.ts#isPublicWebPath). Formuláře posílají data na
// route handlery /api/web/** — nikdy přes Server Actions.
export const metadata: Metadata = {
  title: { default: COMPANY.name, template: `%s · ${COMPANY.name}` },
  description: COMPANY.brand?.tagline ?? COMPANY.productDescription,
}

export default function WebLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-surface">{children}</div>
}
