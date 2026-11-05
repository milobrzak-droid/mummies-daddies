import type { Metadata, Viewport } from 'next'
import './globals.css'

// Kořenový layout JEN pro samostatnou vývojovou aplikaci. V hlavním systému
// tuto roli má jeho app/layout.tsx (html lang="cs" + body); web žije celý
// v app/(web)/layout.tsx, který html/body nevykresluje.
export const metadata: Metadata = {
  metadataBase: new URL('https://www.mummiesdaddies.com'),
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  )
}
