// Konfigurace firmy pro Loop Core („konfigurace firmy jako data"). Tady je
// jen TVAR, žádná hodnota: core/ nesmí obsahovat nic, co patří konkrétní
// firmě (hlídá lint v eslint.config.mjs a test/company-config.test.ts).
// Jediná instance firmy žije v config/ a všechny vrstvy ji
// čtou jen přes `@/config`.
//
// Generika N (uzly) a P (pilíře) drží literální typy instance, takže
// `Node` v core/workCase.ts zůstává úzký union, ne obecný string.

import type { InquiryAgentConfig } from './agents/inquiryAgentConfig'
import type { FollowUpCadenceConfig } from './followUpCadence'
import type { AgentOutboxConfig } from './agents/outboxConfig'

/** Šablona pracovního případu: předvyplní kroky a otevřená rozhodnutí. */
export interface CaseTemplate<N extends string = string> {
  id: string
  label: string
  suggestedNode: N | null
  steps: readonly string[]
  decisions: readonly { question: string; options: readonly string[] }[]
}

/** Pilíř nabídky firmy (obchodní linie). */
export interface PillarConfig<P extends string = string> {
  key: P
  label: string
  sub: string
  color: string
}

export interface PhaseConfig {
  key: string
  label: string
}

/**
 * Vztah firmy k nám pro automatické návrhy do cílových seznamů. Počítá se
 * z dat (domain/crm/targetSegments.ts#accountRelationship), není to sloupec:
 *   klient          — má vyhraný obchod, dodávku, běžící předplatné,
 *                     vyplněné „klient od" nebo je reference
 *   aktivni_obchod  — má otevřený obchod v pipeline
 *   prospekt        — nic z toho
 */
export type TargetAccountStatus = 'prospekt' | 'aktivni_obchod' | 'klient'

/**
 * Pravidlo segmentu cílového seznamu: které firmy navrhnout do seznamu,
 * jehož `target_list.segment` je klíč pravidla. Porovnání oboru i regionu
 * je bez ohledu na velikost písmen a diakritiku.
 */
export interface TargetSegmentRule {
  /** Popisek segmentu do UI. */
  label: string
  /** Obor (account.industry) ZAČÍNÁ některou z hodnot (i část slova: „Kovo" → „Kovovýroba"). */
  industryPrefixes: readonly [string, ...string[]]
  /** Volitelně: obor obsahuje slovo začínající některou z hodnot (kdekoli v textu). */
  industryKeywords?: readonly string[]
  /**
   * Volitelný filtr regionu (account.region, volný text — kraj i obec):
   * kraje ve tvaru z ARESu, případně obce. Vynechá se jen firma, jejíž
   * region jistě leží v jiném kraji (název kraje, okresní město); firma
   * bez regionu nebo s obcí, kterou neumíme zařadit, projde s poznámkou
   * „region neověřen".
   */
  regions?: readonly string[]
  /** Vztahy, které se nenavrhují (typicky klienti a rozjednané obchody). */
  excludeStatuses: readonly TargetAccountStatus[]
}

/**
 * Schopnost „příchozí e-mail → doložený návrh pracovního případu"
 * (core/agents/mailToCase.ts, kapitola 11). Kód schopnosti je společný;
 * firma tu volí jen uzel, texty a pravidla.
 */
export interface MailToCaseConfig<N extends string = string> {
  /** Uzel, do kterého návrh míří (musí být v `nodes`). */
  node: N
  /** Název navrženého případu; `{firma}` se nahradí jménem firmy z CRM. */
  titleTemplate: string
  /** Starší zprávy se nenavrhují — první synchronizace stáhne celou historii schránky. */
  maxEventAgeDays: number
  /** Pravidlo „odpověď na naši zprávu": příchozí nejvýš N dní po naší odchozí téže firmě. null = vypnuto. */
  replyWindowDays: number | null
  /** Pravidlo „první zpráva od firmy": s firmou dosud žádná pošta (v obou směrech). */
  firstContact: boolean
  /**
   * Pravidlo „klíčová slova" nad krátkým titulkem události. Běží jen u
   * konektoru, který smí titulek předat (ConnectorDescriptor.content);
   * Outlook nese jen metadata (0041), takže u něj nic nenajde. [] = vypnuto.
   */
  keywords: readonly string[]
  /** Kroky, které dostane případ po přijetí návrhu (1–10, každý nejvýš 300 znaků). */
  steps: readonly string[]
}

/**
 * Návrh kroků ze zápisu schůzky (domain/crm/meetingIntake.ts). Zápis
 * z diktátu (Wispr Flow) po spárování na firmu založí aktivitu; jsou-li
 * v textu úkoly, vznikne z nich NÁVRH pracovního případu (case_proposal),
 * který přijme nebo zamítne člověk. Firma tu volí jen uzel a název.
 */
export interface MeetingNotesConfig<N extends string = string> {
  /** Uzel, do kterého návrh míří (musí být v `nodes`). */
  node: N
  /** Název navrženého případu; `{firma}` se nahradí jménem firmy z CRM. */
  titleTemplate: string
}

/**
 * Obsahový vstup pošty (domain/crm/mailContent*.ts, migrace 0091). Zprávy,
 * které člověk vědomě přesune do složky „Cockpit", vedou k NÁVRHU pracovního
 * případu (case_proposal). Firma tu volí jen uzly: kam míří návrh k dodávce
 * a kam návrh k obchodu nebo jen ke klientovi (bez dodávky).
 */
export interface MailContentConfig<N extends string = string> {
  /** Uzel pro návrhy k dodávce (musí být v `nodes`). */
  node: N
  /** Uzel pro návrhy k obchodu, nebo když dodávka není určená (musí být v `nodes`). */
  dealNode: N
}

/**
 * Předání vyhraného obchodu do dodávky (migrace 0080). Kód je společný
 * (trigger v DB), firma tu volí šablonu milníků, úkol a uzly, ze kterých se
 * bere zástup vlastníka. SQL má vlastní kopii hodnot (funkce
 * auto_delivery_milestones, konstanty úkolu) — kopie hlídá
 * test/auto-delivery-migration.test.ts.
 */
export interface AutoDeliveryConfig<N extends string = string> {
  /** Úkol, který po založení dodávky dostane vlastník: název a termín v pracovních dnech (Po–Pá). */
  startTask: { title: string; workingDays: number }
  /**
   * Výchozí milníky podle typu obchodu (deal.deal_kind). Klíč `jine` je
   * výchozí šablona pro ostatní i neroztříděné typy — musí existovat vždy.
   */
  milestoneTemplates: Readonly<Record<string, readonly [string, ...string[]]>> & { jine: readonly [string, ...string[]] }
  /** Uzly Loop Core, ze kterých se bere zástupce vlastníka dodávky (v pořadí přednosti). */
  deputyNodes: readonly N[]
}

/**
 * Automatické založení poptávky z příchozího e-mailu (domain/crm/autoIntake.ts,
 * migrace 0081, docs/PROVOZ.md). Když napíše neznámá firma
 * přímo na schránku, Cockpit u VYSOKÉ jistoty sám založí klienta, kontakt,
 * alias domény, obchod a úkol; u nižší jistoty jen navrhne případ ke
 * schválení (case_proposal). Firma tu volí uzel, texty a mantinely; kód
 * pravidel je společný.
 */
export interface AutoIntakeConfig<N extends string = string> {
  /** Uzel, do kterého míří návrhy nižší jistoty (musí být v `nodes`). */
  node: N
  /** Kolik automatických založení za pražský den nejvýš (výchozí; env AUTO_INTAKE_DAILY_LIMIT ho přebije). */
  dailyLimit: number
  /** Starší zprávy se neberou — první synchronizace stáhne celou historii schránky. */
  maxAgeDays: number
  /** Nejvýš tolik příjemců (To + Cc) u zprávy, kterou lze založit automaticky. */
  maxAutoRecipients: number
  /** Víc příjemců než tohle = hromadná zpráva; ta nevyvolá ani návrh. */
  bulkRecipients: number
  /** Další domény firmy (mimo `emailDomain`), jejichž odesílatel nikdy není poptávka. */
  internalDomains: readonly string[]
  /** Domény odesílatelů hromadné pošty, notifikací a platforem — nikdy poptávka. */
  automatedDomains: readonly string[]
  /** Obchodní linie nového obchodu (hodnota revenue_line; kategorie se odvodí z ní). */
  revenueLine: string
  /** Název obchodu; `{firma}` = název nové firmy. */
  dealTitleTemplate: string
  /** Další krok obchodu (a název úkolu je z něj odvozený přes taskTitleTemplate). */
  nextStep: string
  /** Termín dalšího kroku: tolik pracovních dnů od založení (po–pá; státní svátky se nepočítají). */
  nextStepBusinessDays: number
  /** Název úkolu; `{firma}` = název nové firmy. */
  taskTitleTemplate: string
  /** Název návrhu nižší jistoty; `{domena}` = doména odesílatele. */
  proposalTitleTemplate: string
  /** Kroky případu po přijetí návrhu (1–10, každý nejvýš 300 znaků). */
  proposalSteps: readonly string[]
}

/**
 * Schválení napojené na akci (migrace 0084, core/approvalActions.ts). Žádost
 * nese druh akce, cíl, otisk parametrů, platnost a jediný povolený přechod;
 * po schválení executor v DB provede bezpečný interní zápis, nebo u nevratné
 * externí akce jen založí úkol pro člověka. SQL má kopii hodnot (funkce
 * approval_action_settings) — kopii hlídá test/approval-executor-0084.test.ts.
 */
export interface ApprovalActionsConfig<N extends string = string> {
  /** „Potvrdit další krok" (krok případu + úkol řešiteli): výchozí platnost žádosti ve dnech. */
  confirmNextStep: { validityDays: number }
  /** „Odeslat nabídku klientovi": Cockpit nic neodesílá, jen označí verzi a založí úkol. */
  sendOffer: {
    /** Uzel, podle kterého se určí, kdo smí schválit (musí být v `nodes`). */
    node: N
    /**
     * Od jaké hodnoty nabídky (jednorázově + 12 × měsíčně, v Kč) nejde verzi
     * označit „odesláno" bez schválené žádosti. 0 = vždy, null = šablona
     * procesu schválení nevyžaduje. Verze v jiné měně než Kč vždy (bez kurzu).
     */
    requireApprovalFromCzk: number | null
    /** Výchozí platnost žádosti ve dnech. */
    validityDays: number
    /** Úkol pro vlastníka obchodu po schválení: název (doplní se „(verze N)") a termín v pracovních dnech. */
    task: { title: string; workingDays: number }
  }
  /** Úkol po zamítnutí, vypršení nebo když se schválená akce neprovede: termín v pracovních dnech. */
  returnTask: { workingDays: number }
}

/** Typ hlavní metriky dopadu dodávky (migrace 0088, domain/delivery/impactMetric.ts). */
export type ImpactMetricType = {
  /** Klíč = engagement.impact_metric_key / metric_observation.metric_key (tvar ^[a-z][a-z0-9_]{0,39}$). */
  key: string
  label: string
  /** Výchozí jednotka; null = zadá ji člověk (vlastní metrika). Nikdy měna. */
  unit: string | null
  /** Co je zlepšení: nižší (čas, chybovost), vyšší (počet, adopce), nebo neznámé. */
  better: 'lower' | 'higher' | null
  /** Nápověda do formuláře (co a jak měřit). */
  hint: string
  /** Vlastní metrika: název a jednotku zadá člověk. */
  custom?: boolean
}

export interface ImpactMetricsConfig {
  /** Nabídka typů metriky; aspoň jeden, klíče unikátní. */
  types: readonly [ImpactMetricType, ...ImpactMetricType[]]
  /** Výchozí typ podle druhu dodávky (engagement.kind); jinak `fallback`. */
  defaultByKind: Readonly<Record<string, string>>
  fallback: string
}

/**
 * Schválená mapa standardních nabídek (ceník + pravidla), ze které agent
 * počítá nabídku (core/standardOffer.ts). Cenu NIKDY nepočítá model: model
 * z poptávky jen vytáhne parametry (OfferInquiry), cenu spočítá kód z mapy.
 * Co mapa nepokrývá, je výjimka a jde člověku. Všechny částky jsou celé
 * koruny bez DPH. Změna mapy = nová `version` se schválením (nikdy za běhu).
 */
export interface PriceMapPackage {
  /** Klíč balíčku (tvar ^[a-z][a-z0-9_]{0,39}$). */
  key: string
  label: string
  /** Cena za hosta bez DPH v Kč. */
  pricePerGuest: number
  minGuests: number
  maxGuests: number
  /** Balíček s obsluhou: k ceně se připočítá personál podle `staff`. */
  service: boolean
  /** Co balíček obsahuje (do textu nabídky). */
  includes: readonly string[]
}

export interface PriceMapEventType {
  key: string
  label: string
  /** Balíčky, které jsou pro tento typ akce standardní (klíče z `packages`). */
  packages: readonly [string, ...string[]]
  /** Balíček, když poptávka žádný nejmenuje. */
  defaultPackage: string
}

export interface PriceMapSegment<S extends string = string> {
  key: S
  label: string
  eventTypes: readonly PriceMapEventType[]
  /** Ceny v textu nabídky včetně DPH (spotřebitelé, B2C). Výpočet zůstává bez DPH. */
  pricesIncludeVat?: boolean
}

/** Druh plnění pro sazbu DPH řádku nabídky (P3). */
export type VatClass = 'food' | 'service' | 'delivery' | 'rental' | 'alcohol'

export interface PriceMapExtra {
  key: string
  label: string
  /** Za hosta, za akci, nebo za hodinu trvání akce. */
  unit: 'guest' | 'event' | 'hour'
  price: number
  /** Druh plnění pro DPH (chybí = jídlo). */
  vatClass?: VatClass
}

export interface PriceMapConfig<S extends string = string> {
  /** Verze mapy, kterou schválil klient (nabídka ji nese pro audit). */
  version: string
  /** Den schválení (YYYY-MM-DD). */
  approvedAt: string
  /** Mapa platí do (YYYY-MM-DD včetně); po tomto dni agent nic sám nespočítá. */
  validUntil: string
  currency: 'CZK'
  /** Sazba DPH jako zlomek (0.12 = 12 %) — výchozí pro druh plnění bez vlastní sazby. */
  vatRate: number
  /**
   * Sazby DPH podle druhu plnění (jídlo, obsluha, doprava, pronájem,
   * alkohol). Chybějící druh = `vatRate`. DPH se počítá ze součtu základů
   * každé sazby.
   */
  vatRates?: Readonly<Partial<Record<VatClass, number>>>
  /** Platnost nabídky ve dnech od vystavení. */
  offerValidityDays: number
  /** Akce dřív než za tolik dní od dneška = výjimka (kapacita, nákup). */
  minLeadDays: number
  /** Akce později než za tolik dní = výjimka (ceny na příští sezónu). */
  maxLeadDays: number
  segments: readonly PriceMapSegment<S>[]
  packages: readonly PriceMapPackage[]
  extras: readonly PriceMapExtra[]
  /** Dietní varianty bez příplatku nebo s příplatkem za hosta; jiné = výjimka. */
  dietary: readonly { key: string; label: string; surchargePerGuest: number }[]
  /** Víkendový příplatek v procentech z ceny jídla (sobota, neděle). */
  weekendSurchargePct: number
  /** Doprava: v ceně do `includedKm` (jedna cesta), pak za km tam i zpět; nad `maxKm` výjimka. */
  delivery: { includedKm: number; pricePerKm: number; maxKm: number }
  /** Obsluha u balíčků se `service`: 1 číšník na N hostů, hodinová sazba, minimum hodin. */
  staff: { guestsPerWaiter: number; pricePerWaiterHour: number; minHours: number; defaultHours: number }
  /** Nad tuto částku bez DPH agent nabídku sám neodešle (eskalace). */
  autoSendMaxTotal: number
}

/**
 * Schopnost „standardní nabídka z mapy" (core/standardOffer.ts). Firma volí
 * mapu, uzel pro eskalace a podpis do textu nabídky.
 */
export interface StandardOfferConfig<N extends string = string, S extends string = string> {
  /** Uzel, který dostane výjimky (typicky obchod / CSO). Musí být v `nodes`. */
  escalationNode: N
  /** Podpis pod nabídkou. */
  signature: string
  priceMap: PriceMapConfig<S>
}

// --- Kontrakt pro paralelní balíky (P2–P6) -------------------------------
// Volitelná pole níž jsou zmrazený kontrakt: změna jen dohodou všech balíků.

/**
 * Moduly Cockpitu, které jde u firmy vypnout. Vypnutý modul zmizí z navigace
 * a jeho stránky vrací notFound() (core/modules.ts#isModuleOn). Chybějící
 * `modules` = vše zapnuto.
 */
export interface ModulesConfig {
  /** Partneři a dodavatelé (/cockpit/partners). */
  partners: boolean
  /** Dodávky / realizace akcí (/cockpit/dodavky). */
  deliveries: boolean
  /** Kapacity týmu (/cockpit/kapacity). */
  capacity: boolean
  /** Finance (/cockpit/finance). */
  finance: boolean
  /** Cílové seznamy a oslovování (outbound — fáze 2). */
  targetLists: boolean
  /** Schůzky (/cockpit/schuzky). */
  meetings: boolean
  /** Předplatné / opakované služby. */
  subscriptions: boolean
  /** Přehled agenta (/cockpit/agent, dodá P5). */
  agent: boolean
  /** Veřejný web na / (dodá P6). */
  web: boolean
  /** Objednávky cheesecaků z webu (/cockpit/objednavky, dodá P6). */
  shopOrders: boolean
}

export type ModuleKey = keyof ModulesConfig

/** Značka v UI: logo, název, písmo nadpisů. */
export interface BrandConfig {
  /** Cesta k logu v public/ (např. '/brand/logo.svg'). */
  logo: string
  logoAlt: string
  /** Malý symbol (favicon, sbalená navigace); null = jen logo. */
  symbol: string | null
  /** Písmo nadpisů (CSS font-family); null = systémové písmo. */
  headingFont: string | null
  /** Krátký slogan do veřejného webu a e-mailů. */
  tagline: string
}

/** Obchodní linka (hodnota enumu revenue_line) a její kategorie. */
export interface RevenueLineConfig {
  key: string
  label: string
  category: 'one_time' | 'recurring' | 'royalty'
}

/** Důvod prohry (kód se ukládá jako prefix 'kod: poznámka' do deal.lost_reason). */
export interface LostReasonConfig {
  key: string
  label: string
}

/** Produkt e-shopu (cheesecaky). Ceny v celých Kč VČETNĚ DPH (ceník webu). */
export interface ShopProductConfig {
  /** Klíč produktu (tvar ^[a-z][a-z0-9_]{0,39}$). */
  key: string
  label: string
  description: string
  priceCzk: number
  /** Jednotka do UI (např. 'dort', 'balení 10 ks'). */
  unit: string
  /** Sezónní produkt: nabízí se jen mezi daty (MM-DD, včetně). null = celoročně. */
  season: { from: string; to: string } | null
  active: boolean
}

/** Objednávky z e-shopu (core/cheesecakeOrder.ts). */
export interface ShopConfig {
  products: readonly ShopProductConfig[]
  /** Nejkratší předstih objednávky ve dnech (příprava dortu). */
  minLeadDays: number
  /** Nejvzdálenější termín vyzvednutí / doručení ve dnech. */
  maxLeadDays: number
  /** Nejvýš kusů jednoho produktu v jedné objednávce (víc = poptávka, ne objednávka). */
  maxQuantityPerItem: number
  /** Způsoby předání: osobní odběr na adrese provozovny, nebo doručení. */
  pickupAddress: string
  delivery: {
    enabled: boolean
    priceCzk: number
    note: string
    /**
     * Pásma doručení (P6, nepovinné). Když jsou vyplněná, doručení vyžaduje
     * klíč pásma (ShopOrder.deliveryZone) a cena dopravy je cena pásma;
     * priceCzk se pak nepoužije.
     */
    zones?: readonly ShopDeliveryZone[]
  }
}

/** Pásmo doručení e-shopu (např. Praha, Praha + 30 km). Cena v celých Kč vč. DPH. */
export interface ShopDeliveryZone {
  key: string
  label: string
  priceCzk: number
}

export interface CompanyConfig<N extends string = string, P extends string = string> {
  /** Stabilní identifikátor tenantu (malá písmena, bez mezer). */
  id: string
  /** Krátké jméno firmy do UI. */
  name: string
  /** Jméno produktu v UI a exportech. */
  productName: string
  /** Popis do <meta name="description">. */
  productDescription: string
  /** Firemní e-mailová doména bez „@" (interní adresy, příjemci přehledu). */
  emailDomain: string
  /** Výchozí odesílatel přehledu (servisní schránka), když chybí env DIGEST_SENDER. */
  digestSender: string
  /** Povolené SharePoint tenanty: `https://<host>.sharepoint.com/…`. */
  sharepointHosts: readonly [string, ...string[]]
  /** IANA časové pásmo firmy — kalendářní dny, plánovač, celodenní události. */
  timeZone: string
  /** Název účetního systému (zdroj 'ucetnictvi' u finančních záznamů, 0063). */
  accountingSystem: string

  // --- Loop Core --------------------------------------------------------
  /** Vedoucí uzly (kompetence). Obsazení je data v tabulce loop_node. */
  nodes: readonly [N, ...N[]]
  nodeLabels: Readonly<Record<N, string>>
  caseTemplates: readonly CaseTemplate<N>[]
  /** Uzel, do kterého follow-up hlídač zakládá případy „Follow-up: <obchod>". */
  followUpNode: N

  // --- Obchodní číselník -------------------------------------------------
  pillars: readonly PillarConfig<P>[]
  /** Fáze pro každý pilíř; pořadí = časová osa. */
  phases: Readonly<Record<P, readonly PhaseConfig[]>>
  /** Fáze pilíře, od kterých je obchod „vyhráno" (běží dodávka). */
  wonPhases: Readonly<Record<P, readonly string[]>>
  deliveryTeams: readonly { key: string; label: string }[]

  // --- Oslovování -------------------------------------------------------
  /** Pravidla pro návrhy firem do cílových seznamů; klíč = target_list.segment. */
  targetSegments: Readonly<Record<string, TargetSegmentRule>>

  // --- Schopnosti Loop Core (kapitola 11) ------------------------------------
  /** Nastavení schopností; null = schopnost u firmy vypnutá. */
  capabilities: {
    mailToCase: MailToCaseConfig<N> | null
    /** Volitelné: chybí nebo null = firma z diktátu zápisů návrhy kroků nedělá. */
    meetingNotes?: MeetingNotesConfig<N> | null
    /** Volitelné: chybí nebo null = firma poptávky z e-mailu automaticky nezakládá. */
    autoIntake?: AutoIntakeConfig<N> | null
    /** Volitelné: chybí nebo null = firma pošta s obsahem (složka „Cockpit") nečte. */
    mailContent?: MailContentConfig<N> | null
    /** Volitelné: chybí nebo null = firma standardní nabídky z mapy nepočítá. */
    standardOffer?: StandardOfferConfig<N> | null
    /** Volitelné (kontrakt P2): příchozí poptávky e-mailem i z webu → agent. */
    inquiryAgent?: InquiryAgentConfig<N> | null
    /** Volitelné (kontrakt P4): follow-up neodpovězených nabídek. */
    followUpCadence?: FollowUpCadenceConfig<N> | null
    /** Volitelné (P3): odchozí fronta agenta. Chybí nebo null = fronta nic neodesílá. */
    agentOutbox?: AgentOutboxConfig | null
  }

  // --- Kontrakt pro paralelní balíky ------------------------------------------
  /** Volitelné: chybí = všechny moduly zapnuté. */
  modules?: ModulesConfig
  /** Volitelné: chybí = výchozí logo Cockpitu. */
  brand?: BrandConfig
  /** Obchodní linky (revenue_line); klíče MUSÍ sedět s enumem v 0001_base_schema.sql. */
  revenueLines?: readonly RevenueLineConfig[]
  /** Popisky fází obchodu (deal.stage); klíče enumu zůstávají, mění se jen popisek. */
  dealStageLabels?: Readonly<Partial<Record<'kvalifikace' | 'diagnostika' | 'rozsah_nabidka' | 'rozhodovani' | 'vyhráno' | 'prohráno' | 'odloženo', string>>>
  /** Číselník důvodů prohry (P5: LostReasonSelect, P4: auto-lost). */
  lostReasons?: readonly LostReasonConfig[]
  /** E-shop cheesecaků (P6 zapisuje objednávky, Cockpit je zobrazuje). */
  shop?: ShopConfig | null

  // --- Předání obchodu do dodávky (migrace 0080) -----------------------------
  /** Volitelné: chybí nebo null = firma dodávky po vyhrání obchodu sama nezakládá. */
  autoDelivery?: AutoDeliveryConfig<N> | null

  // --- Schválení napojené na akci (migrace 0084) ------------------------------
  /** Volitelné: chybí nebo null = firma typované žádosti (s provedením) nepoužívá. */
  approvalActions?: ApprovalActionsConfig<N> | null

  // --- Dopad dodávky (migrace 0088) ----------------------------------------
  /** Volitelné: chybí nebo null = jen vlastní metrika (domain/delivery/impactMetric.ts). */
  impactMetrics?: ImpactMetricsConfig | null
}
