import { isMissingColumnError } from '@/domain/crm/dealInvariant'

// Zápis obchodu tolerantní k nenasazeným migracím 0047 a 0052. Když DB
// sloupec nezná (42703 / PGRST204), zopakuje se zápis postupně:
//   1. bez sloupců z 0052 (příležitost),
//   2. pak i bez no_next_step_reason (0047).
// Po krocích, aby se při aplikované 0047 a chybějící 0052 zbytečně neztratil
// důvod „proč bez dalšího kroku". Jiné chyby se neopakují.

export const DEAL_0052_COLUMNS = [
  'deal_kind', 'problem', 'expected_outcome', 'decision_maker',
  'decision_process', 'decision_due', 'value_basis',
] as const

export const DEAL_0047_COLUMNS = ['no_next_step_reason'] as const

type DbResult = { error: { code?: string; message?: string } | null }

function without(row: Record<string, unknown>, cols: readonly string[]): Record<string, unknown> | null {
  if (!cols.some((c) => c in row)) return null
  const next = { ...row }
  for (const c of cols) delete next[c]
  return next
}

export async function writeDealTolerant<R extends object>(
  row: R,
  write: (row: Partial<R>) => PromiseLike<DbResult>,
): Promise<DbResult> {
  let current = row as Record<string, unknown>
  let result = await write(current as Partial<R>)
  for (const cols of [DEAL_0052_COLUMNS, DEAL_0047_COLUMNS]) {
    if (!result.error || !isMissingColumnError(result.error)) return result
    const next = without(current, cols)
    if (!next) continue
    current = next
    result = await write(current as Partial<R>)
  }
  return result
}
