import { WorkGateGauge } from '@/components/WorkGateGauge'
import { WorkStatus } from '@/components/WorkUi'
import {
  DELIVERY_GATES,
  describeMilestoneContext,
  summarizeGates,
  summarizeMilestonesForGates,
  type GateValues,
  type MilestoneForGateSummary,
} from '@/domain/delivery/deliveryGates'

// Stav kvalitativních bran jedné dodávky (EDS §13), jako půlkruh.
//
// Rozlišujeme tři stavy vizuálně, ne jen textem: nesplněná brána musí být
// vidět na první pohled, protože jedna stačí na to, aby dodávka neprošla.
//
// `milestones` je nepovinný — jen souhrn skutečných dat milníků (kap. 6),
// žádná vazba mezi konkrétním milníkem a konkrétní bránou (viz zdůvodnění
// v domain/delivery/deliveryGates.ts u summarizeMilestonesForGates).
export function DeliveryGates({
  engagement,
  milestones,
}: {
  engagement: GateValues
  milestones?: MilestoneForGateSummary[]
}) {
  const s = summarizeGates(engagement)
  const headline = s.overall === 'passed'
    ? <WorkStatus tone="done">Prošlo — všech 6 bran</WorkStatus>
    : s.overall === 'failed'
      ? <WorkStatus tone="fail">Neprošlo — {s.failed}× nesplněno</WorkStatus>
      : <WorkStatus tone="wait">Nedokončeno — {s.passed}/6 posouzeno</WorkStatus>
  const milestoneNote = milestones ? describeMilestoneContext(summarizeMilestonesForGates(milestones)) : null
  const states = DELIVERY_GATES.map((g) => engagement[g.key])

  return (
    <div className="flex flex-col gap-4">
      <div>{headline}</div>
      <WorkGateGauge states={states} />
      <ul className="list-none p-0 m-0">
        {DELIVERY_GATES.map((g) => {
          const v = engagement[g.key]
          const color = v === true ? 'var(--d-turquoise)' : v === false ? 'var(--d-red)' : 'var(--c-hatch-line)'
          return (
            <li key={g.key} className="flex items-center gap-2.5 py-2 border-t border-[color:var(--c-line)] first:border-t-0 text-sm">
              <i aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
              <span className={v === null || v === undefined ? 'text-muted' : 'text-ink font-semibold'}>{g.label}</span>
              <span className={`ml-auto text-[13px] font-bold whitespace-nowrap ${v === false ? 'text-neg' : v === true ? 'text-pos' : 'text-muted'}`}>
                {v === true ? 'splněno' : v === false ? 'nesplněno' : 'nehodnoceno'}
              </span>
            </li>
          )
        })}
      </ul>
      {milestoneNote && <p className="tile tile-sun text-sm m-0">{milestoneNote}</p>}
    </div>
  )
}
