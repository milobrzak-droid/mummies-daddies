'use server'
// Hledání pro paletu příkazů ⌘K (components/CommandPalette.tsx). Tenká vrstva
// nad stejným hledáním jako stránka Hledat (domain/crm/queries/search.ts):
// stejná normalizace dotazu, stejné oprávnění, data jdou přes RLS klienta
// uživatele. Action je globálně volatelná POSTem, proto si sama ověří
// přihlášení s AAL2 (test/auth-actions-guard.test.ts). Obchody se hledají jen
// pro obchodní role (rozhodnutí 2026-09-28, DB: 0058), ostatním se dotaz na
// obchody vůbec nespouští.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { logError } from '@/lib/log'
import { normalizeSearchQuery, search, type SearchResult } from '@/domain/crm/queries/search'

/** Kolik záznamů z každé skupiny paleta ukáže (celá skupina je na /hledat). */
const PALETTE_GROUP_LIMIT = 4

export type PaletteSearchResult =
  | { ok: true; items: SearchResult[] }
  | { ok: false; error: string }

export async function searchPalette(query: unknown): Promise<PaletteSearchResult> {
  if (!await tryRequireUser({ aal2: true })) return { ok: false, error: AUTH_ERROR_MESSAGE }
  const q = normalizeSearchQuery(typeof query === 'string' ? query : null)
  if (!q) return { ok: true, items: [] }
  try {
    const canSeeSales = await canCurrentUserSeeSales()
    const found = await search(q, { includeDeals: canSeeSales })
    const items = [
      ...found.accounts.slice(0, PALETTE_GROUP_LIMIT),
      ...found.contacts.slice(0, PALETTE_GROUP_LIMIT),
      ...(canSeeSales ? found.deals.slice(0, PALETTE_GROUP_LIMIT) : []),
      ...found.partners.slice(0, PALETTE_GROUP_LIMIT),
    ]
    return { ok: true, items }
  } catch (error) {
    logError('action.paletteSearch', error)
    return { ok: false, error: 'Hledání se nepovedlo. Zkus to znovu.' }
  }
}
