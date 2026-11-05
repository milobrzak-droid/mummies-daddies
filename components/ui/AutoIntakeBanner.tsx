import { formatDate } from '@/lib/format'
import { dismissAutoIntake, undoAutoIntake } from '@/domain/crm/actions/autoIntake'
import type { AutoIntakeItem } from '@/domain/crm/queries/autoIntake'
import { IntakeUndoButton } from '@/components/ui/IntakeUndoButton'

// Štítek na kartě klienta, kterého Cockpit založil sám z příchozího e-mailu:
// říká to jasně a nabízí „Není poptávka". Dokud u klienta není lidská práce,
// smaže, co vzniklo; potom nabídne uzavření bez mazání (obchod do Prohráno,
// firma odložená). Server komponenta; data dodá stránka.
export function AutoIntakeBanner({ item }: { item: AutoIntakeItem }) {
  return (
    <section aria-label="Vzniklo automaticky z e-mailu" className="tile tile-mint mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1">
        <p className="m-0 font-heading text-[16px] font-bold text-ink">Vzniklo automaticky z e-mailu</p>
        <p className="m-0 mt-1 text-[13px] text-[color:#3A424E]">
          E-mail přišel {formatDate(item.occurredAt)}. Název firmy, kontakt, obchod a úkol vytvořil Cockpit sám z hlavičky
          zprávy (obsah nečte) — ověř je a doplň. Není to poptávka? Klikni Není poptávka: když se s firmou ještě nepracovalo,
          všechno se smaže; jinak obchod uzavřeš jako Prohráno a nic nezmizí.
        </p>
      </div>
      <IntakeUndoButton
        action={undoAutoIntake.bind(null, item.id)}
        dismiss={dismissAutoIntake.bind(null, item.id)}
        label={item.accountName}
        doneHref="/cockpit"
        doneLabel="Zpět na Dnes"
      />
    </section>
  )
}
