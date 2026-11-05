import { redirect } from 'next/navigation'

// Přehled prodeje byl sloučen do Dashboardu — dvě stránky se stejnými čísly
// jen nutily hádat, které z nich věřit. Přesměrování drží staré odkazy.
export default function SalesRedirect() {
  redirect('/cockpit?view=byznys')
}
