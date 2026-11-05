// Konfigurace firmy — jediný vstup do config/. Systém slouží jediné firmě
// (Mummies and Daddies); vrstvy čtou `COMPANY` odsud, nikdy ze souboru
// config/mummiesDaddies.ts přímo (lint).
//
// config/ smí z core/ jen typy (CompanyConfig) a nic jiného neimportuje —
// je to data pod všemi vrstvami, včetně lib/.
import { MUMMIES_DADDIES } from './mummiesDaddies'

export const COMPANY = MUMMIES_DADDIES

export type Company = typeof COMPANY
