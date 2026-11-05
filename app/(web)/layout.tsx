import type { Metadata, Viewport } from 'next'
import { Footer, Header } from '@/components/web'
import { PriceGuideProvider } from '@/components/web/system/PriceGuideProvider'
import { companyPriceGuide } from '@/domain/web/priceGuide'
import { pragueToday } from '@/lib/pragueDate'
import { COMPANY, getPage, stripPlaceholders } from '@/lib/web/content'
import { webFontVariables } from '@/lib/web/fonts'
import { ogImage } from '@/lib/web/photos'
import { colors } from '@/lib/web/tokens'
import './web.css'

/**
 * Layout veřejného webu (route group (web) → URL bez prefixu).
 * NEVYKRESLUJE <html>/<body>: ty má kořenový app/layout.tsx. Stránky webu jsou
 * veřejné (proxy je pouští bez přihlášení, lib/routes.ts#isPublicWebPath);
 * formuláře posílají data na route handlery /api/web/** (lib/web/api.ts). Písma se nastavují na obal .md-web.
 */
const home = getPage('/')
const og = ogImage('og.default')

export const metadata: Metadata = {
  metadataBase: new URL(COMPANY.siteUrl),
  title: {
    default: stripPlaceholders(home.metaTitle),
    template: `%s | ${COMPANY.brand}`,
  },
  description: stripPlaceholders(home.metaDescription),
  applicationName: COMPANY.brand,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'cs_CZ',
    siteName: COMPANY.brand,
    title: stripPlaceholders(home.metaTitle),
    description: stripPlaceholders(home.metaDescription),
    images: og ? [og] : undefined,
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
  formatDetection: { telephone: true, email: true, address: false },
}

export const viewport: Viewport = {
  themeColor: colors.cream,
  colorScheme: 'light',
}

const organizationLd = {
  '@context': 'https://schema.org',
  '@type': 'FoodEstablishment',
  '@id': `${COMPANY.siteUrl}/#firma`,
  name: COMPANY.brand,
  legalName: COMPANY.legalName,
  url: COMPANY.siteUrl,
  email: COMPANY.email,
  telephone: COMPANY.phone,
  foundingDate: String(COMPANY.founded),
  taxID: COMPANY.dic,
  vatID: COMPANY.dic,
  address: {
    '@type': 'PostalAddress',
    streetAddress: COMPANY.street,
    postalCode: COMPANY.zip,
    addressLocality: 'Praha',
    addressCountry: COMPANY.country,
  },
  areaServed: 'CZ',
  servesCuisine: 'Catering',
  sameAs: COMPANY.socials.map((s) => s.href),
}

export default function WebLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className={`md-web ${webFontVariables}`}>
      {/* Napojení na systém (P6): orientační ceník z cenové mapy firmy pro estimatePrice. */}
      <PriceGuideProvider guide={companyPriceGuide(pragueToday())} />
      <a href="#obsah" className="md-skip">
        Přeskočit na obsah
      </a>
      <Header />
      <main id="obsah" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <Footer />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationLd).replace(/</g, '\\u003c') }} />
    </div>
  )
}
