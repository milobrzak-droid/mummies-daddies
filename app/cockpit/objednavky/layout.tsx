import { requireModule } from '../moduleGuard'

// Objednávky cheesecaků z webu (modul shopOrders, CompanyConfig.modules).
export default function ShopOrdersLayout({ children }: { children: React.ReactNode }) {
  requireModule('shopOrders')
  return children
}
