/**
 * Fakta o firmě (obchodní rejstřík + kontaktní stránka v copy.json).
 * Samostatný modul bez JSON importů → bezpečný i pro klientské komponenty
 * (Header). Re-exportuje ho i lib/web/content.ts.
 */
export const COMPANY = {
  brand: 'Mummies & Daddies',
  legalName: 'Mummies and Daddies s.r.o.',
  street: 'Varšavská 715',
  zip: '120 00',
  city: 'Praha 2',
  country: 'CZ',
  ico: '17957524',
  dic: 'CZ17957524',
  registry: 'Spisová značka C 379274 vedená u Městského soudu v Praze',
  founded: 2018,
  email: 'info@mummiesdaddies.com',
  /** Hlavní telefon (nabídky, Monika). */
  phone: '+420 737 818 694',
  phoneHref: 'tel:+420737818694',
  people: [
    { name: 'Bc. Monika Jožková', role: '[DOPLNÍ KLIENT: role]', phone: '+420 737 818 694', phoneHref: 'tel:+420737818694', email: 'info@mummiesdaddies.com' },
    { name: 'Rudolf Nikolai', role: 'majitel a šéfkuchař', phone: '+420 737 301 679', phoneHref: 'tel:+420737301679', email: 'rudolf.nikolai@mummiesdaddies.com' },
  ],
  socials: [
    { network: 'instagram', label: 'Instagram @mummiesdaddies1', handle: '@mummiesdaddies1', href: 'https://www.instagram.com/mummiesdaddies1/' },
    { network: 'instagram', label: 'Instagram @mummiesdaddies.catering', handle: '@mummiesdaddies.catering', href: 'https://www.instagram.com/mummiesdaddies.catering/' },
    { network: 'facebook', label: 'Facebook mummiesdaddies2', handle: 'mummiesdaddies2', href: 'https://www.facebook.com/mummiesdaddies2' },
  ],
  /** LinkedIn: [DOPLNÍ KLIENT: odkaz] – zatím neuvádět. */
  linkedin: null as string | null,
  /** Kanonická doména nového webu (strategy.redirects). */
  siteUrl: 'https://www.mummiesdaddies.com',
} as const

export type Company = typeof COMPANY
