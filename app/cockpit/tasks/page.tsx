import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, WORK_TABS } from '@/components/SectionTabs'
import { TaskBoard } from '@/components/TaskBoard'
import { TaskForm, TASK_QUICK_ANCHOR } from '@/components/TaskForm'
import { WorkSegNav } from '@/components/WorkUi'
import { buttonClass } from '@/components/ui/Button'
import { ExportButtons } from '@/components/ExportButtons'
import { createTask, updateTaskDueOn, updateTaskStatus } from '@/domain/crm/actions/tasks'
import { getMyTasks, getTasks, listAssignableMembers } from '@/domain/crm/queries/tasks'
import { getSalesDeals } from '@/domain/crm/queries/sales'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { pragueToday } from '@/lib/pragueDate'

export default async function TasksPage({
  searchParams,
}: { searchParams: Promise<{ view?: string }> }) {
  const { view: rawView } = await searchParams
  const view = rawView === 'team' ? 'team' : 'mine'

  // Obchody jen pro obchodní role (rozhodnutí 2026-09-28, DB: 0058): ostatním
  // se deal nenačítá, výběr obchodu ve formuláři se skryje a u úkolu se název
  // obchodu neukáže (embed deal:… jim RLS vrací jako null).
  const canSeeSales = await canCurrentUserSeeSales()
  const [members, deals, allTasks, { user }] = await Promise.all([
    listAssignableMembers(),
    canSeeSales ? getSalesDeals() : Promise.resolve([] as Awaited<ReturnType<typeof getSalesDeals>>),
    view === 'mine' ? getMyTasks() : getTasks(),
    getCurrentMember(),
  ])
  // Pojistka i před nasazením 0058: název obchodu u úkolu jen obchodním rolím.
  const tasks = canSeeSales ? allTasks : allTasks.map((t) => ({ ...t, deal: null }))
  const memberOptions = members.map((m) => ({ id: m.id, full_name: m.full_name }))
  const open = tasks.filter((t) => t.status !== 'done').length

  return (
    <>
      <PageHeader
        title="Úkoly"
        eyebrow="Práce"
        subtitle={open === 0 ? 'Nic nečeká na dokončení.' : `Otevřených úkolů: ${open}. Hotovo odškrtneš přímo na kartě.`}
      >
        <WorkSegNav
          label="Čí úkoly"
          items={[
            { href: '/cockpit/tasks?view=mine', label: 'Moje', active: view === 'mine' },
            { href: '/cockpit/tasks?view=team', label: 'Tým', active: view === 'team' },
          ]}
        />
        <ExportButtons prehled="ukoly" label="Stáhnout úkoly" params={{ view }} />
        <a href={`#${TASK_QUICK_ANCHOR}`} className={buttonClass('primary')}>Založit úkol</a>
      </PageHeader>
      <SectionTabs tabs={WORK_TABS} label="Práce" />
      <TaskBoard
        tasks={tasks}
        members={memberOptions}
        updateStatus={updateTaskStatus}
        updateDueOn={updateTaskDueOn}
        today={pragueToday()}
        quickAdd={
          <TaskForm action={createTask} members={memberOptions} deals={deals} showDeals={canSeeSales} defaultAssigneeId={user?.id ?? null} />
        }
      />
    </>
  )
}
