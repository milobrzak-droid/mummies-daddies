// Omezená souběžnost pro síťová volání po dávkách (ARES a spol.).
//
// Promise.all nad stovkami položek pošle stovky požadavků najednou — přesně
// tak stránka /clients/doplnit-ico kdysi narazila na limit ARESu a timeout
// Vercelu (640 dotazů při každém zobrazení). Tady běží nejvýš `limit`
// položek současně; další začne, až jedna doběhne.

/**
 * Zpracuje položky v pořadí s nejvýš `limit` souběžnými úlohami.
 * `canStart` se ptá před KAŽDOU další položkou; vrátí-li false, nové
 * položky se už nezačínají (rozběhnuté doběhnou) — tak se drží časový
 * rozpočet. Vrací počet zahájených položek. Výjimka z `worker` se nechytá:
 * kdo chce pokračovat i po chybě, musí ji ošetřit ve workeru sám.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  canStart: () => boolean = () => true,
): Promise<{ started: number }> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  let stopped = false
  async function lane(): Promise<void> {
    while (!stopped && next < items.length) {
      if (!canStart()) {
        stopped = true
        return
      }
      const index = next++
      await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : width }, lane))
  return { started: next }
}

/** Jako Promise.all(items.map(fn)), ale nejvýš `limit` současně; pořadí výsledků odpovídá vstupu. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  await runPool(items, limit, async (item, index) => {
    out[index] = await fn(item, index)
  })
  return out
}
