// Kvalitativní brány dodávky podle ENTER DELIVERY STANDARD v1.1, §13.
//
// Dodávka projde jen tehdy, když platí všech šest. Vaše vlastní formulace:
// „Rule: If the closing does not produce ownership + next step, it's not done."
//
// Držíme rozdíl mezi „nesplněno" a „nehodnoceno" (null). Spočítat z toho
// jediný boolean by ten rozdíl zahodil — a přesně ten je u dodávky, která
// se teprve rozjíždí, ta podstatná informace.

export type GateKey =
  | 'gate_outputs_captured'
  | 'gate_ratios_respected'
  | 'gate_peer_learning'
  | 'gate_safety_followed'
  | 'gate_next_steps_owned'
  | 'gate_pack_delivered'

export const DELIVERY_GATES: { key: GateKey; label: string; hint: string }[] = [
  {
    key: 'gate_outputs_captured',
    label: 'Výstupy v šablonách',
    hint: 'Každý modul má hotový výstup uložený v odsouhlasené šabloně.',
  },
  {
    key: 'gate_ratios_respected',
    label: 'Účastníci hlavně pracovali',
    hint: 'Facilitátor mluvil 15–30 %, účastníci pracovali 40–60 % času.',
  },
  {
    key: 'gate_peer_learning',
    label: 'Účastníci se učili navzájem',
    hint: 'Účastníci si ukázali, co sami vytvořili, a vysvětlili to ostatním.',
  },
  {
    key: 'gate_safety_followed',
    label: 'Bezpečnost dat',
    hint: 'Žádná citlivá data v neschválených nástrojích, ověřování bylo součástí práce.',
  },
  {
    key: 'gate_next_steps_owned',
    label: 'Další kroky s vlastníky',
    hint: 'Ze závěru vyšel konkrétní další krok a kdo ho má.',
  },
  {
    key: 'gate_pack_delivered',
    label: 'Balíček výstupů předán',
    hint: 'Klient dostal výstupy, shrnutí, další kroky a jejich vlastníky na dohodnuté místo.',
  },
]

export type GateValues = Partial<Record<GateKey, boolean | null>>

export type GateSummary = {
  passed: number
  failed: number
  unrated: number
  /** Dodávka prošla jen když je splněno všech šest. */
  overall: 'passed' | 'failed' | 'incomplete'
}

export function summarizeGates(e: GateValues): GateSummary {
  let passed = 0
  let failed = 0
  let unrated = 0
  for (const g of DELIVERY_GATES) {
    const v = e[g.key]
    if (v === true) passed++
    else if (v === false) failed++
    else unrated++
  }
  // Jedna nesplněná brána stačí na neprošlo — i kdyby zbytek nebyl hodnocený.
  // Naopak „nehodnoceno" nikdy nevydává za splněno.
  const overall = failed > 0 ? 'failed' : unrated > 0 ? 'incomplete' : 'passed'
  return { passed, failed, unrated, overall }
}

// ---------------------------------------------------------------------------
// Milníky vedle bran (kap. 6) — pohled „na první pohled", ne vazba.
//
// 0042 (viz hlavička domain/delivery/milestone.ts) záměrně nedává milníku
// a bráně žádný datový vztah: brány hodnotí dodávku jako celek (workshop,
// jeho rytmus, jak se předal balíček), milník je jednotlivá dodaná věc
// s vlastním schvalovacím kolečkem. Který milník „by zavřel" kterou bránu
// je obchodní úsudek, ne něco odvoditelné ze sloupců — proto tu není žádné
// mapování milestone → gate. Tohle je jen souhrn skutečných dat milníků,
// zobrazený vedle bran, ať je stav dodávky vidět na jednom místě.

export type MilestoneForGateSummary = {
  status: string
  accepted_at: string | null
}

export type MilestoneGateContext = {
  total: number
  accepted: number
  /** ve stavu čeká na vstup / čeká na schválení / v práci / připraveno. */
  pending: number
  /** Datum (YYYY-MM-DD) posledního přijetí, nebo null když žádný milník ještě nebyl přijat. */
  lastAcceptedOn: string | null
}

export function summarizeMilestonesForGates(milestones: MilestoneForGateSummary[]): MilestoneGateContext {
  const accepted = milestones.filter((m) => m.status === 'prijato' || m.status === 'uzavreno')
  const lastAcceptedOn = accepted
    .map((m) => m.accepted_at)
    .filter((d): d is string => d !== null)
    .map((d) => d.slice(0, 10))
    .sort()
    .at(-1) ?? null
  return {
    total: milestones.length,
    accepted: accepted.length,
    pending: milestones.length - accepted.length,
    lastAcceptedOn,
  }
}

/**
 * Krátká poznámka k bránám podle skutečného stavu milníků — ne hodnocení,
 * jen orientace („kde dodávka stojí s klientem"). Prázdné pole milníků
 * nevydává žádnou poznámku (zatím se nemá k čemu vztahovat).
 */
export function describeMilestoneContext(ctx: MilestoneGateContext): string | null {
  if (ctx.total === 0) return null
  const parts: string[] = []
  if (ctx.pending > 0) {
    parts.push(`${ctx.pending} ${milestonesWord(ctx.pending)} čeká na akceptaci klienta`)
  }
  if (ctx.lastAcceptedOn) {
    parts.push(`poslední milník přijat ${formatCzechDate(ctx.lastAcceptedOn)}`)
  }
  if (parts.length === 0) return null
  return parts.join(' · ')
}

function milestonesWord(n: number): string {
  if (n === 1) return 'milník'
  if (n >= 2 && n <= 4) return 'milníky'
  return 'milníků'
}

function formatCzechDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}
