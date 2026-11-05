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

// ---------------------------------------------------------------------------
// Kontrola nastavení a doplnění šablon (balík P4). Čisté funkce, bez hodnot firmy.

/** Zástupné symboly, které umí doplnit renderFollowUpTemplate. */
export const FOLLOW_UP_PLACEHOLDERS = ['jmeno', 'akce', 'datum'] as const
export type FollowUpPlaceholder = (typeof FOLLOW_UP_PLACEHOLDERS)[number]

const PLACEHOLDER_RE = /\{([^{}]*)\}/g
const SUBJECT_MAX = 200
const BODY_MAX = 4000
const MAX_STEP_GAP = 60

/** Zástupné symboly použité v textu (bez opakování, v pořadí výskytu). */
export function templatePlaceholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/**
 * Problémy nastavení cadence (česky, pro test configu a pro odmítnutí běhu).
 * Prázdné pole = v pořádku. `lostReasonKeys` (číselník důvodů prohry firmy)
 * se kontroluje jen u onExhausted 'lost', a jen když je zadaný.
 */
export function validateFollowUpCadence(
  cfg: FollowUpCadenceConfig,
  opts: { lostReasonKeys?: readonly string[] } = {},
): string[] {
  const issues: string[] = []
  const int = (n: number) => Number.isInteger(n)
  if (cfg.appliesToPhases.length === 0) issues.push('Cadence nemá žádnou fázi (appliesToPhases).')
  if (cfg.steps.length === 0) issues.push('Cadence nemá žádný krok.')
  cfg.steps.forEach((s, i) => {
    if (!int(s.afterBusinessDays) || s.afterBusinessDays < 1 || s.afterBusinessDays > MAX_STEP_GAP) {
      issues.push(`Krok ${i + 1}: afterBusinessDays musí být celé číslo 1–${MAX_STEP_GAP}.`)
    }
    if (!Object.prototype.hasOwnProperty.call(cfg.templates, s.template)) {
      issues.push(`Krok ${i + 1}: šablona „${s.template}" neexistuje.`)
    }
  })
  if (!int(cfg.maxAttempts) || cfg.maxAttempts < 1) issues.push('maxAttempts musí být kladné celé číslo.')
  if (!int(cfg.dailyLimit) || cfg.dailyLimit < 1) issues.push('dailyLimit musí být kladné celé číslo.')
  const w = cfg.sendWindow
  if (w.days.length === 0 || w.days.some((d) => !int(d) || d < 1 || d > 7) || new Set(w.days).size !== w.days.length) {
    issues.push('sendWindow.days musí být neprázdný seznam různých dnů ISO 1–7.')
  }
  if (!int(w.fromHour) || !int(w.toHour) || w.fromHour < 0 || w.toHour > 24 || w.fromHour >= w.toHour) {
    issues.push('sendWindow: musí platit 0 ≤ fromHour < toHour ≤ 24 (celé hodiny).')
  }
  if (!['case', 'lost', 'none'].includes(cfg.onExhausted)) issues.push('onExhausted musí být case, lost nebo none.')
  if (cfg.onExhausted === 'lost') {
    if (!cfg.lostReasonKey.trim()) issues.push('onExhausted lost potřebuje lostReasonKey.')
    else if (opts.lostReasonKeys && !opts.lostReasonKeys.includes(cfg.lostReasonKey)) {
      issues.push(`lostReasonKey „${cfg.lostReasonKey}" není v číselníku důvodů prohry.`)
    }
  }
  for (const [key, t] of Object.entries(cfg.templates)) {
    if (!t.subject.trim() || t.subject.length > SUBJECT_MAX || /[\r\n]/.test(t.subject)) {
      issues.push(`Šablona „${key}": předmět musí být jeden neprázdný řádek do ${SUBJECT_MAX} znaků.`)
    }
    if (!t.body.trim() || t.body.length > BODY_MAX) issues.push(`Šablona „${key}": text musí mít 1–${BODY_MAX} znaků.`)
    for (const p of [...templatePlaceholders(t.subject), ...templatePlaceholders(t.body)]) {
      if (!(FOLLOW_UP_PLACEHOLDERS as readonly string[]).includes(p)) {
        issues.push(`Šablona „${key}": neznámý zástupný symbol {${p}}.`)
      }
    }
  }
  return issues
}

export type FollowUpTemplateValues = Partial<Record<FollowUpPlaceholder, string | null>>

/**
 * Doplní šablonu. Když šablona potřebuje symbol, pro který chybí hodnota,
 * vrátí `missing` (nic se neodešle — radši žádná připomínka než děravá).
 */
export function renderFollowUpTemplate(
  t: { subject: string; body: string },
  values: FollowUpTemplateValues,
): { ok: true; subject: string; body: string } | { ok: false; missing: string[] } {
  const missing: string[] = []
  const fill = (text: string) => text.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const v = (values as Record<string, string | null | undefined>)[name]
    if (v == null || v === '') {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return v
  })
  const subject = fill(t.subject)
  const body = fill(t.body)
  return missing.length > 0 ? { ok: false, missing } : { ok: true, subject, body }
}
