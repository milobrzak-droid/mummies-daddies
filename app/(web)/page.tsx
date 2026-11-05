import Link from 'next/link'
import { COMPANY } from '@/config'

// Zástupná úvodní stránka veřejného webu. Celý web (úvod, catering,
// cheesecaky, formulář poptávky, objednávka) dodá balík P6.
export default function WebHome() {
  const brand = COMPANY.brand
  return (
    <main id="main" className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={brand?.logo ?? '/logo.svg'} alt={brand?.logoAlt ?? COMPANY.name} className="h-8 w-auto self-start" />
      <h1 className="m-0 text-title1">{brand?.tagline ?? COMPANY.name}</h1>
      <p className="m-0 text-body text-muted">
        Nový web se připravuje. Poptávku cateringu nebo objednávku cheesecaku zatím pošlete na{' '}
        <a href="mailto:info@mummiesdaddies.com">info@mummiesdaddies.com</a>.
      </p>
      <p className="m-0 text-footnote text-muted">
        <Link href="/cockpit">Vstup pro tým</Link>
      </p>
    </main>
  )
}
