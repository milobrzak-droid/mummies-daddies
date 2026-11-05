// Nastavení odchozí fronty agenta (balík P3). Tvar je Loop Core (bez hodnot
// firmy); hodnoty má firma v config/ (capabilities.agentOutbox). Chybějící
// nastavení = fronta nic neodesílá (domain/crm/agentOutboxService.ts).
//
// Limity a druhy zpráv, které smí odejít bez člověka, se berou z kontraktů
// P2 (inquiryAgent: dailyAutoSendLimit, perRecipientDailyLimit,
// autoSendKinds) a P4 (followUpCadence: dailyLimit, sendWindow); tady je jen
// to, co patří samotnému odeslání.

export interface AgentOutboxConfig {
  /** Zobrazované jméno odesílatele (hlavička From). */
  fromName: string
  /** Doména pravé strany vlastní hlavičky Message-ID (např. doména firmy). */
  messageIdDomain: string
  /**
   * Patička KAŽDÉ zprávy zákazníkovi: údaje firmy (IČO, sídlo, zápis
   * v rejstříku), odkaz na obchodní podmínky a informace, že zprávu
   * připravil automatický systém.
   */
  footer: string
  /**
   * Text připojený navíc u nabídky a připomínky nabídky (před patičku):
   * nezávazná kalkulace, smlouva vzniká až písemným potvrzením firmy,
   * storno podmínky a alergeny.
   */
  offerTerms: string
  /** Domény firmy: na vlastní adresu fronta nikdy neposílá (smyčka, přeposlání). */
  ownDomains: readonly string[]
  /**
   * Citlivé kontakty (celé adresy nebo '@doména'): zprávu jim vždy pošle
   * člověk, nikdy agent sám.
   */
  vipAddresses: readonly string[]
  /** Zpráva čekající ve frontě déle než tolik hodin už samostatně neodejde (zastaralá). */
  maxQueueAgeHours: number
  /** Rezervace (claimed) starší než tolik minut = nejisté odeslání (needs_attention). */
  staleClaimMinutes: number
  /** Po tolika dnech se smaže předmět, text a adresa koncových zpráv (řádek zůstává). */
  retentionDays: number
  /** Nejvýš tolik zpráv za jeden běh úlohy. */
  maxPerRun: number
  /** authserv-id hlavičky Authentication-Results, které věříme (přidává ji náš poštovní server). */
  trustedAuthServId: string
}
