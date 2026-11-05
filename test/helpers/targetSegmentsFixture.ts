// Ukázková pravidla segmentů cílových seznamů pro testy (firma zatím žádné
// segmenty nemá — outbound je fáze 2).
import type { TargetSegmentRule } from '@/core/tenant'

export const TARGET_SEGMENTS_FIXTURE: Readonly<Record<string, TargetSegmentRule>> = {
  'vyroba-praha': {
    label: 'Výroba kolem Prahy',
    industryPrefixes: [
      'Výrob', 'Průmysl', 'Zpracovatelsk', 'Strojírens', 'Automotive', 'Automobil',
      'Elektrotechn', 'Elektronik', 'Chemi', 'Farmac', 'Potravin', 'Plast', 'Kovo', 'Kovy',
      'Hutn', 'Slévár', 'Textil', 'Nábyt', 'Dřev', 'Sklo', 'Sklář', 'Papír', 'Obal',
    ],
    industryKeywords: ['strojírens', 'kovovýrob', 'kovoobráb', 'obráběn', 'lisován', 'slévár', 'svařov'],
    regions: ['Hlavní město Praha', 'Praha', 'Středočeský kraj'],
    excludeStatuses: ['klient', 'aktivni_obchod'],
  },
  'logistika-doprava': {
    label: 'Logistika a doprava',
    industryPrefixes: ['Logisti', 'Doprav', 'Přeprav', 'Spedi', 'Sklad', 'Zasílatel', 'Kurýr', 'Transport'],
    industryKeywords: ['logisti', 'spedi', 'přeprav', 'zasílatel', 'skladov', 'kurýr', 'nákladní doprav', 'kamionov'],
    excludeStatuses: ['klient', 'aktivni_obchod'],
  },
}
