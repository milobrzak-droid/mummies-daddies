import type { Metadata } from 'next'
import { preload } from 'react-dom'
import './globals.css'
import { COMPANY } from '@/config'

export const metadata: Metadata = {
  title: COMPANY.productName,
  description: COMPANY.productDescription,
}

const FONT_PRELOADS = ['/fonts/FiraMono-Medium.woff2'] as const

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Nadpisy používají systémové písmo (CompanyConfig.brand.headingFont = null),
  // nadtitulek Fira Mono z @font-face v globals.css — je nad ohybem na každé
  // stránce, proto ho prohlížeč stahuje hned s HTML, ne až po CSS.
  for (const f of FONT_PRELOADS) preload(f, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' })
  return (
    <html lang="cs" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}
