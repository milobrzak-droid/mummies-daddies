// Pevná ukázková mapa standardních nabídek pro testy VÝPOČTU (core/
// standardOffer.ts, extrakce poptávky). Je nezávislá na mapě firmy
// v config/ — ta se bude měnit se schválením klienta, kdežto tyhle testy
// hlídají pravidla výpočtu na známých číslech. Mapu firmy hlídá
// test/company-config.test.ts (priceMapProblems) a test/standard-offer-company.test.ts.
import type { StandardOfferConfig } from '@/core/tenant'

export const FIXTURE_COMPANY_NAME = 'Ukázkový catering'

export const FIXTURE_OFFER: StandardOfferConfig = {
  escalationNode: 'obchod',
  signature: 'Obchodní oddělení\nUkázkový catering',
  priceMap: {
    version: 'ilustracni-2026-11',
    approvedAt: '2026-11-05',
    validUntil: '2027-06-30',
    currency: 'CZK',
    vatRate: 0.12,
    offerValidityDays: 14,
    minLeadDays: 5,
    maxLeadDays: 365,
    segments: [
      {
        key: 'b2b',
        label: 'Firemní akce',
        eventTypes: [
          { key: 'coffee_break', label: 'Coffee break', packages: ['coffee_break'], defaultPackage: 'coffee_break' },
          { key: 'raut', label: 'Firemní raut', packages: ['raut_standard', 'raut_premium', 'finger_food'], defaultPackage: 'raut_standard' },
          { key: 'konference', label: 'Konference', packages: ['coffee_break', 'raut_standard', 'finger_food'], defaultPackage: 'raut_standard' },
          { key: 'teambuilding', label: 'Teambuilding', packages: ['grill', 'raut_standard'], defaultPackage: 'grill' },
        ],
      },
      {
        key: 'b2c',
        label: 'Soukromé oslavy',
        eventTypes: [
          { key: 'oslava', label: 'Oslava', packages: ['oslava_raut', 'rozvoz_box'], defaultPackage: 'oslava_raut' },
          { key: 'svatba', label: 'Svatba', packages: ['svatebni_menu'], defaultPackage: 'svatebni_menu' },
          { key: 'rozvoz', label: 'Rozvoz bez obsluhy', packages: ['rozvoz_box'], defaultPackage: 'rozvoz_box' },
        ],
      },
    ],
    packages: [
      { key: 'coffee_break', label: 'Coffee break', pricePerGuest: 180, minGuests: 10, maxGuests: 400, service: false, includes: ['káva, čaj, voda', 'sladké a slané pečivo', 'ovoce'] },
      { key: 'raut_standard', label: 'Raut Standard', pricePerGuest: 590, minGuests: 20, maxGuests: 300, service: true, includes: ['studený a teplý raut', 'dezerty', 'nealkoholické nápoje', 'inventář'] },
      { key: 'raut_premium', label: 'Raut Premium', pricePerGuest: 890, minGuests: 20, maxGuests: 200, service: true, includes: ['rozšířený raut s live stanicí', 'dezertní bar', 'nealkoholické nápoje', 'inventář'] },
      { key: 'finger_food', label: 'Finger food', pricePerGuest: 450, minGuests: 15, maxGuests: 300, service: true, includes: ['8 druhů jednohubek na osobu', 'nealkoholické nápoje'] },
      { key: 'grill', label: 'Grill party', pricePerGuest: 690, minGuests: 20, maxGuests: 150, service: true, includes: ['grilované maso a zelenina', 'přílohy a saláty', 'nealkoholické nápoje'] },
      { key: 'oslava_raut', label: 'Raut na oslavu', pricePerGuest: 520, minGuests: 15, maxGuests: 120, service: true, includes: ['studený a teplý raut', 'dezerty', 'inventář'] },
      { key: 'svatebni_menu', label: 'Svatební menu', pricePerGuest: 1190, minGuests: 30, maxGuests: 150, service: true, includes: ['předkrm, polévka, hlavní chod', 'večerní raut', 'inventář a výzdoba stolů'] },
      { key: 'rozvoz_box', label: 'Rozvoz – party box', pricePerGuest: 390, minGuests: 10, maxGuests: 80, service: false, includes: ['studené občerstvení v jednorázových boxech', 'doručení na místo'] },
    ],
    extras: [
      { key: 'napoje_alko', label: 'Víno a pivo', unit: 'guest', price: 220 },
      { key: 'barman', label: 'Barman', unit: 'hour', price: 550 },
      { key: 'dort', label: 'Dort', unit: 'event', price: 1900 },
      { key: 'pronajem_stanu', label: 'Pronájem stanu', unit: 'event', price: 6500 },
    ],
    dietary: [
      { key: 'vegetarian', label: 'vegetariánská varianta', surchargePerGuest: 0 },
      { key: 'vegan', label: 'veganská varianta', surchargePerGuest: 60 },
      { key: 'bezlepkove', label: 'bezlepková varianta', surchargePerGuest: 80 },
    ],
    weekendSurchargePct: 10,
    delivery: { includedKm: 20, pricePerKm: 28, maxKm: 120 },
    staff: { guestsPerWaiter: 25, pricePerWaiterHour: 450, minHours: 4, defaultHours: 5 },
    autoSendMaxTotal: 150_000,
  },
}
