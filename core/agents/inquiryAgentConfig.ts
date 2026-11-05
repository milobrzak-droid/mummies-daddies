// Kontrakt balíku P2 (inbound agent): nastavení příjmu poptávek. Tvar je
// zmrazený základovým balíkem; hodnoty má firma v config/ (capabilities.
// inquiryAgent). Vlastník souboru po rozvětvení: P2 — změna tvaru jen
// dohodou s P3–P6. P2 přidal jen VOLITELNÁ pole (zpětně kompatibilní):
// originAddress, inquiryAddresses, leadMapping, replyFooter, dedupWindowDays,
// maxMessageAgeDays, modelDailyLimit, modelMaxAttempts, trustedAuthServId.
//
// Zdroje poptávek: e-mail (schránky vedení a obchodu, Gmail) a webový formulář
// (core/webInquiry.ts). Obě cesty končí stejným rozhodnutím
// (core/agents/inquiryToOffer.ts, evaluateStandardOffer); webový formulář
// jde bez modelu, protože pole už jsou strukturovaná.

/** Druh odpovědi, kterou agent smí poslat sám (přes frontu agent_outbox, P3). */
export type AutoSendKind = 'send_offer' | 'ask_info'

/** Kam patří nový lead podle segmentu mapy (pilíř a obchodní linka firmy). */
export interface InquiryLeadMapping {
  pillar: string
  revenueLine: string
  /** Výjimky obchodní linky podle typu akce (např. svatba → svatební hostina). */
  eventTypeRevenueLines?: Readonly<Record<string, string>>
}

export interface InquiryAgentConfig<N extends string = string> {
  /** E-mail člena týmu, který je výchozím vlastníkem leadu (team_member.email). */
  leadOwnerEmail: string
  /** Uzel, do kterého jdou eskalace (nestandardní poptávka, selhání extrakce). */
  escalationNode: N
  /**
   * Z jaké schránky se odpovídá: 'receiving_mailbox' = ze schránky, kam
   * poptávka přišla; 'lead_owner' = vždy ze schránky vlastníka leadu.
   * Poptávka z webu nemá „přijímací schránku" a jde vždy jako 'lead_owner'.
   */
  replyFrom: 'receiving_mailbox' | 'lead_owner'
  /** Adresy v kopii každé odpovědi agenta (typicky vedení). */
  ccEmails: readonly string[]
  /** Nejvýš tolik zpráv zpracuje jeden běh úlohy inquiry-agent. */
  maxPerRun: number
  /** Nejvýš tolik samostatných odeslání za pražský den (kontroluje RPC v DB). */
  dailyAutoSendLimit: number
  /** Nejvýš tolik samostatných odeslání jednomu příjemci za pražský den. */
  perRecipientDailyLimit: number
  /** Které druhy odpovědí smí odejít bez člověka (když jsou splněné všechny brány). */
  autoSendKinds: readonly AutoSendKind[]

  // --- Volitelná pole P2 (bez nich platí bezpečné výchozí hodnoty) ---------

  /** Adresa provozovny = výchozí bod výpočtu vzdálenosti místa akce. Bez ní se vzdálenost neurčí (→ eskalace). */
  originAddress?: string
  /**
   * Sdílené adresy poptávek (skupina, alias, vyhrazená schránka s přeposíláním).
   * Zpráva doručená přes skupinu (List-Id / Delivered-To s touto adresou) se
   * nepovažuje za hromadnou poštu.
   */
  inquiryAddresses?: readonly string[]
  /** Segment mapy → pilíř a obchodní linka nového leadu. Klíč '*' = segment neznámý. */
  leadMapping?: Readonly<Record<string, InquiryLeadMapping>>
  /** Patička každé odpovědi agenta (údaje firmy, VOP, upozornění na automat). */
  replyFooter?: string
  /** Okno (dny), ve kterém se další poptávka stejného kontaktu připojí k otevřenému obchodu. Výchozí 14. */
  dedupWindowDays?: number
  /** Starší zprávy agent nezpracuje (první načtení schránky). Výchozí 3. */
  maxMessageAgeDays?: number
  /** Nejvýš tolik volání modelu za pražský den. Výchozí 100. */
  modelDailyLimit?: number
  /** Po tolika neúspěšných pokusech o přečtení modelem jde zpráva člověku. Výchozí 4. */
  modelMaxAttempts?: number
  /** authserv-id hlavičky Authentication-Results, které věříme (přidává ji náš poštovní server). Výchozí 'mx.google.com'. */
  trustedAuthServId?: string
}
