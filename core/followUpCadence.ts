// Kontrakt balíku P4 (follow-up cadence): tvar nastavení připomínek
// neodpovězených nabídek. Zmrazený základovým balíkem; hodnoty má firma
// v config/ (capabilities.followUpCadence). Vlastník souboru po rozvětvení:
// P4 — změna tvaru jen dohodou. Žádné hodnoty firmy (lint).

/**
 * Okno odesílání v místním čase firmy. `days` = dny v týdnu ISO
 * (1 = pondělí … 7 = neděle), hodiny jsou [fromHour, toHour).
 */
export interface PragueWindow {
  days: readonly number[]
  fromHour: number
  toHour: number
}

export interface FollowUpStep {
  /** Kolik pracovních dnů (Po–Pá bez státních svátků) po předchozím kroku. */
  afterBusinessDays: number
  /** Klíč šablony z `templates`. */
  template: string
}

export interface FollowUpCadenceConfig<N extends string = string> {
  /** Fáze pilíře (deal.phase), ve kterých cadence běží (typicky 'nabidka'). */
  appliesToPhases: readonly string[]
  steps: readonly FollowUpStep[]
  /** Nejvýš tolik připomínek na jeden obchod. */
  maxAttempts: number
  sendWindow: PragueWindow
  /** Nejvýš tolik připomínek za pražský den celkem. */
  dailyLimit: number
  /** Co po vyčerpání: případ pro uzel, prohráno s důvodem, nebo nic. */
  onExhausted: 'case' | 'lost' | 'none'
  /** Kód důvodu prohry (z lostReasons) pro onExhausted 'lost'. */
  lostReasonKey: string
  /** Uzel pro případ po vyčerpání (onExhausted 'case'). */
  escalateNode: N
  /** Šablony textů; `{jmeno}`, `{akce}`, `{datum}` doplní P4. Bez osobních údajů v šabloně. */
  templates: Readonly<Record<string, { subject: string; body: string }>>
}
