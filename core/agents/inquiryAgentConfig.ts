// Kontrakt balíku P2 (inbound agent): nastavení příjmu poptávek. Tvar je
// zmrazený základovým balíkem; hodnoty má firma v config/ (capabilities.
// inquiryAgent). Vlastník souboru po rozvětvení: P2 — změna tvaru jen
// dohodou s P3–P6.
//
// Zdroje poptávek: e-mail (schránky vedení a obchodu) a webový formulář
// (core/webInquiry.ts). Obě cesty končí stejným rozhodnutím
// (core/agents/inquiryToOffer.ts, evaluateStandardOffer); webový formulář
// jde bez modelu, protože pole už jsou strukturovaná.

/** Druh odpovědi, kterou agent smí poslat sám (přes frontu agent_outbox, P3). */
export type AutoSendKind = 'send_offer' | 'ask_info'

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
}
