/**
 * Tvary dat, která serverové stránky e-shopu předávají klientským komponentám
 * (hotové řetězce z copy.json a objekty Photo). Jen typy → bezpečné pro klienta.
 */
import type { Photo } from '../photos'
import type { CheesecakeSlug, DeliveryMethod, MiniFlavor, PaymentMethod } from '../options'
import type { PastelTone } from '../tokens'

export interface EshopLink {
  label: string
  href: string
}

export interface ProductSummary {
  slug: CheesecakeSlug
  name: string
  /** Cena v Kč z options.ts (pro výpočty). */
  price: number
  /** Cena doslova z copy („790 Kč“, „1 290 Kč [DOPLNÍ KLIENT: potvrdit cenu]“). */
  priceText: string
  href: string
  tone: PastelTone
  photo: Photo
}

/** Texty konfigurátoru na detailu produktu (mikrotexty KOŠÍK — …). */
export interface ConfiguratorLabels {
  add: string
  quantity: string
  inscription: string
  /** "{n}/25" */
  inscriptionCounter: string
  inscriptionError: string
  /** Nadpis a text sekce „volby“ (Nápis na přání / Vyberte příchutě). */
  optionsHeading: string | null
  optionsBody: string | null
  /** "Vyberte 10 příchutí. Zbývá vybrat {n}." */
  flavorsRemaining: string
  flavorsError: string
  flavors: { value: MiniFlavor; label: string }[]
  date: string
  /** "Tenhle termín už nestihneme upéct. Nejbližší možný je {datum}." */
  dateError: string
  added: string
  continueShopping: EshopLink
  goToCart: EshopLink
}

export interface CartDeliveryOption {
  value: DeliveryMethod
  label: string
  price: number
  /** Doplněk pod volbou (adresa výdejního místa se zástupcem). */
  note: string | null
}

export interface CartLabels {
  heading: string
  lead: string
  empty: string
  emptyCta: EshopLink
  remove: string
  quantity: string
  inscription: string
  inscriptionCounter: string
  inscriptionError: string
  flavorsError: string
  flavors: { value: MiniFlavor; label: string }[]
  subtotal: string
  delivery: string
  total: string
  deliveryHeading: string
  deliveryBody: string
  deliveryLegend: string
  deliveryOptions: CartDeliveryOption[]
  address: string
  date: string
  dateError: string
  contactHeading: string
  contactBody: string
  name: string
  email: string
  phone: string
  phoneHint: string
  company: string
  companyName: string
  ico: string
  paymentHeading: string
  paymentBody: string
  paymentLegend: string
  paymentOptions: { value: PaymentMethod; label: string }[]
  consentHeading: string
  consentBody: string
  consent: string
  legal: EshopLink[]
  submit: string
  sending: string
  offline: string
  upsell: EshopLink
  confirmationHeading: string
  /** "Číslo objednávky {číslo}. Potvrzení jsme poslali na {e-mail}. Pečeme na {datum}." */
  confirmationText: string
  /** "Pošlete prosím {částka} Kč na účet [DOPLNÍ KLIENT], variabilní symbol {číslo}. …" */
  transferText: string
}

export interface VoucherLabels {
  valuesHeading: string
  valuesLegend: string
  presets: { amount: number | null; label: string }[]
  custom: string
  amountError: string
  personalHeading: string
  personalBody: string
  recipient: string
  message: string
  email: string
  paymentLegend: string
  paymentBody: string
  paymentOptions: { value: PaymentMethod; label: string }[]
  consent: string
  legal: EshopLink[]
  submit: string
  sending: string
  offline: string
  /** "Hotovo! Poukaz odešel na {e-mail}. Udělali jste někomu radost." */
  confirmation: string
  transferText: string
  previewTitle: string
  brand: string
}
