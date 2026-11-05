// Tvar nastavení outbound agenta (balík P7): zdroje signálů, kvalifikace
// (ICP), lead do CRM a právně omezené oslovení. Jen TVAR, žádné hodnoty
// konkrétní firmy (lint) — hodnoty jsou v config/ (capabilities.outboundAgent).
import type { PragueWindow } from '@/core/followUpCadence'

/** Zdroj signálu = hodnota outbound_signal.source (CHECK v 0107). */
export const OUTBOUND_SOURCES = ['ares', 'vvz', 'feed', 'jobs', 'crm'] as const
export type OutboundSource = (typeof OUTBOUND_SOURCES)[number]

export const OUTBOUND_SOURCE_LABELS: Readonly<Record<OutboundSource, string>> = {
  ares: 'ARES (změny firem)',
  vvz: 'Veřejné zakázky',
  feed: 'Akce a eventy (RSS/iCal)',
  jobs: 'Inzeráty na pozice',
  crm: 'Stávající klienti v CRM',
}

/** Zdroj RSS/Atom nebo iCal zadaný firmou. Jen veřejná URL bez přihlášení. */
export interface OutboundFeedSource {
  key: string
  label: string
  url: string
  format: 'rss' | 'ical'
}

/** Veřejný zdroj inzerátů (RSS/Atom nebo JSON). Žádné scrapování za přihlášením. */
export interface OutboundJobSource {
  key: string
  label: string
  url: string
  format: 'rss' | 'json'
}

/** Sezóna (vánoční večírky, letní party …) pro signály z CRM. Data MM-DD. */
export interface OutboundSeason {
  key: string
  label: string
  /** Od kdy se signál „blíží se sezóna" vytváří (MM-DD). */
  promptFrom: string
  /** Do kdy (MM-DD, včetně). */
  promptTo: string
  /** Klíč šablony oslovení stávajících klientů. */
  template: string
}

/** Schválená šablona oslovení. Zástupné symboly jen z OVĚŘENÝCH faktů signálu. */
export interface OutreachTemplate {
  subject: string
  body: string
  /** Segment mapy, pro který šablona platí (b2b …). */
  segment: string
  /** Pro koho: stávající klient (§ 7 odst. 3) nebo kontakt s doloženým souhlasem. */
  audience: 'existing_customer' | 'consent'
}

export interface OutboundIcp {
  /** Segment mapy, do kterého lead patří (outbound míří jen na firmy). */
  segment: string
  /**
   * Region: obec nebo kraj sídla z ARESu (porovnání bez diakritiky,
   * „začíná na"). Firma mimo region jde na review, ne pryč (pobočky).
   */
  regions: readonly string[]
  /** Nejmenší velikost firmy podle počtu zaměstnanců (kategorie ARES/RES); null = neřeší se. */
  minEmployees: number | null
  /** NACE (prefixy), které se neoslovují vůbec (např. konkurence — stravování). */
  excludedNacePrefixes: readonly string[]
  /** IČO firem, které se nikdy neoslovují (dohoda, konkurence, spor). */
  excludedIcos: readonly string[]
  /** Slova v názvu, kvůli kterým se firma neoslovuje (bez diakritiky, malými). */
  excludedNameKeywords: readonly string[]
}

export interface OutboundScoring {
  /** Od tohoto skóre (0–100) agent sám založí lead. */
  leadThreshold: number
  /** Od tohoto skóre do leadThreshold jde signál na review; pod ním se odloží. */
  reviewThreshold: number
}

export interface OutboundAgentConfig<N extends string = string> {
  /** Uzel, kam míří review (nejasné signály, návrhy oslovení). */
  reviewNode: N
  icp: OutboundIcp
  scoring: OutboundScoring
  /** Nejvýš tolik nových signálů za jeden běh (všechny zdroje dohromady). */
  maxSignalsPerRun: number
  sources: {
    vvz: {
      /** Klíčová slova v názvu/předmětu zakázky (bez diakritiky, malými). */
      keywords: readonly string[]
      /** CPV kódy (prefixy) cateringu a stravování. */
      cpvPrefixes: readonly string[]
    }
    feeds: readonly OutboundFeedSource[]
    /** Klíčová slova v názvu/popisu akce, kvůli kterým má smysl oslovit. */
    feedKeywords: readonly string[]
    jobs: readonly OutboundJobSource[]
    /** Pozice, jejichž inzerát je signálem (office manager, event, HR …). */
    jobKeywords: readonly string[]
    crm: {
      /** Kolik dní před výročím poslední akce vznikne signál. */
      anniversaryLeadDays: number
      seasons: readonly OutboundSeason[]
      /** Šablona k výročí poslední akce. */
      anniversaryTemplate: string
    }
  }
  outreach: {
    /**
     * Team_member.email ODDĚLENÉ odesílací schránky (subdoména kvůli
     * reputaci hlavní domény). Outbound nikdy neodchází z hlavní schránky.
     */
    senderMailboxEmail: string
    /** Nejvýš tolik automatických oslovení za pražský den. */
    dailyLimit: number
    sendWindow: PragueWindow
    /** Kolik dní po posledním oslovení stejné firmy se nesmí oslovit znovu. */
    cooldownDays: number
    /** Veřejná adresa odhlášení (…/api/web/odhlaseni). Token se připojí jako ?t=. */
    unsubscribeUrl: string
    /** Patička s identifikací odesílatele (obchodní sdělení musí být označené). */
    footer: string
    templates: Readonly<Record<string, OutreachTemplate>>
  }
}
