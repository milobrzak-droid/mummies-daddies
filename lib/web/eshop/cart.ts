/**
 * Košík cheesecaků v localStorage (jen v prohlížeči návštěvníka).
 *
 * - Každé čtení i zápis je v try/catch: v anonymním okně, se zablokovaným
 *   úložištěm nebo při plném kvótě košík funguje dál v paměti stránky.
 * - Data z úložiště se vždy znovu ověří (sanitizeCart): neznámé produkty,
 *   nesmyslné počty a cizí příchutě se zahodí, nápis se zkrátí na 25 znaků.
 *   Ceny se v košíku NEUKLÁDAJÍ – počítají se z options.ts (a mock je přepočítá).
 * - Odběr změn pro React (useSyncExternalStore): subscribeCart / getCartSnapshot /
 *   getServerCartSnapshot. Změna v jiné záložce přijde přes událost „storage“.
 *
 * Bez JSON a node:fs → bezpečné pro klientské komponenty.
 */
import type { CartItem } from '../api'
import { INSCRIPTION_MAX, MINI_FLAVORS, MINI_PIECES, type MiniFlavor } from '../options'
import { isCheesecakeSlug, isMini, allowsInscription } from './catalog'

export interface CartLine extends CartItem {
  /** Stabilní id řádku (pro klíče v Reactu a úpravy). */
  id: string
}

export interface CartState {
  lines: CartLine[]
  /** Preferovaný termín (YYYY-MM-DD) vybraný u produktu; v košíku jde změnit. */
  date: string | null
}

export const CART_STORAGE_KEY = 'md-web:kosik:v1'
/** Vlastní událost pro změny v téže záložce (storage event chodí jen z jiných záložek). */
export const CART_EVENT = 'md-web:kosik'
export const MAX_QUANTITY = 99

export const EMPTY_CART: CartState = Object.freeze({ lines: [], date: null }) as CartState

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Záložní úložiště, když localStorage nejde (anonymní režim, zákaz cookies, kvóta). */
let memoryRaw: string | null = null
/** true = localStorage selhalo; dál se čte i píše jen z paměti. */
let storageBroken = false

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

function readRaw(): string | null {
  if (!storageBroken) {
    try {
      const s = storage()
      if (s) return s.getItem(CART_STORAGE_KEY)
    } catch {
      storageBroken = true
    }
  }
  return memoryRaw
}

function writeRaw(raw: string | null): void {
  memoryRaw = raw
  if (!storageBroken) {
    try {
      const s = storage()
      if (s) {
        if (raw === null) s.removeItem(CART_STORAGE_KEY)
        else s.setItem(CART_STORAGE_KEY, raw)
      }
    } catch {
      // kvóta / zákaz → od teď jen paměť stránky (čtení musí jít ze stejného místa)
      storageBroken = true
    }
  }
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CART_EVENT))
  } catch {
    /* bez window (testy na serveru) */
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 12)
  } catch {
    /* starý prohlížeč */
  }
  return Math.random().toString(36).slice(2, 14)
}

function clampQuantity(q: unknown): number {
  const n = typeof q === 'number' ? q : Number(q)
  if (!Number.isFinite(n)) return 0
  return Math.min(MAX_QUANTITY, Math.max(0, Math.floor(n)))
}

/** Ověří a vyčistí data košíku (z úložiště nebo z formuláře). */
export function sanitizeCart(raw: unknown): CartState {
  if (!raw || typeof raw !== 'object') return { lines: [], date: null }
  const r = raw as { lines?: unknown; date?: unknown }
  const lines: CartLine[] = []
  for (const l of Array.isArray(r.lines) ? r.lines : []) {
    if (!l || typeof l !== 'object') continue
    const x = l as Record<string, unknown>
    if (!isCheesecakeSlug(x.slug)) continue
    const quantity = clampQuantity(x.quantity)
    if (quantity < 1) continue
    const line: CartLine = { id: typeof x.id === 'string' && x.id ? x.id.slice(0, 40) : newId(), slug: x.slug, quantity }
    if (allowsInscription(x.slug) && typeof x.inscription === 'string' && x.inscription.trim()) {
      line.inscription = x.inscription.slice(0, INSCRIPTION_MAX)
    }
    if (isMini(x.slug)) {
      const fl = Array.isArray(x.miniFlavors)
        ? x.miniFlavors.filter((f): f is MiniFlavor => (MINI_FLAVORS as readonly string[]).includes(f as string))
        : []
      line.miniFlavors = fl.slice(0, MINI_PIECES)
    }
    lines.push(line)
  }
  const date = typeof r.date === 'string' && ISO_DATE.test(r.date) ? r.date : null
  return { lines, date }
}

/** Přečte košík (nikdy nespadne; poškozená data = prázdný košík). */
export function readCart(): CartState {
  const raw = readRaw()
  if (!raw) return { lines: [], date: null }
  try {
    return sanitizeCart(JSON.parse(raw))
  } catch {
    return { lines: [], date: null }
  }
}

export function writeCart(state: CartState): void {
  const clean = sanitizeCart(state)
  writeRaw(clean.lines.length || clean.date ? JSON.stringify(clean) : null)
}

export function clearCart(): void {
  writeRaw(null)
}

// ── čisté operace nad stavem ────────────────────────────────────────────────

function sameFlavors(a: readonly MiniFlavor[] | null | undefined, b: readonly MiniFlavor[] | null | undefined): boolean {
  const x = [...(a ?? [])].sort()
  const y = [...(b ?? [])].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** Stejný produkt se stejným nápisem a příchutěmi se sloučí do jednoho řádku. */
export function sameConfiguration(a: CartItem, b: CartItem): boolean {
  return a.slug === b.slug && (a.inscription ?? '').trim() === (b.inscription ?? '').trim() && sameFlavors(a.miniFlavors, b.miniFlavors)
}

export function addItem(state: CartState, item: CartItem): CartState {
  const quantity = clampQuantity(item.quantity)
  if (quantity < 1 || !isCheesecakeSlug(item.slug)) return state
  const existing = state.lines.find((l) => sameConfiguration(l, item))
  if (existing) {
    return {
      ...state,
      lines: state.lines.map((l) => (l === existing ? { ...l, quantity: Math.min(MAX_QUANTITY, l.quantity + quantity) } : l)),
    }
  }
  const line: CartLine = { id: newId(), slug: item.slug, quantity }
  if (item.inscription?.trim()) line.inscription = item.inscription.trim().slice(0, INSCRIPTION_MAX)
  if (item.miniFlavors) line.miniFlavors = [...item.miniFlavors]
  return { ...state, lines: [...state.lines, line] }
}

export function updateLine(state: CartState, id: string, patch: Partial<Omit<CartLine, 'id' | 'slug'>>): CartState {
  return {
    ...state,
    lines: state.lines.map((l) => {
      if (l.id !== id) return l
      const next: CartLine = { ...l, ...patch }
      if ('quantity' in patch) next.quantity = Math.max(1, clampQuantity(patch.quantity))
      if ('inscription' in patch) next.inscription = patch.inscription ? patch.inscription.slice(0, INSCRIPTION_MAX) : null
      return next
    }),
  }
}

export function removeLine(state: CartState, id: string): CartState {
  return { ...state, lines: state.lines.filter((l) => l.id !== id) }
}

export function setDate(state: CartState, date: string | null): CartState {
  return { ...state, date: date && ISO_DATE.test(date) ? date : null }
}

/** Počet kusů v košíku (pro odznak u ikony košíku). */
export function cartCount(state: CartState): number {
  return state.lines.reduce((n, l) => n + l.quantity, 0)
}

/** Položky pro kontrakt submitOrder (bez interního id). */
export function toOrderItems(state: CartState): CartItem[] {
  return state.lines.map((line) => {
    const item: Omit<CartLine, 'id'> & { id?: string } = { ...line }
    delete item.id
    return {
      ...item,
      inscription: item.inscription?.trim() ? item.inscription.trim() : null,
      miniFlavors: item.miniFlavors ?? null,
    }
  })
}

// ── napojení na React (useSyncExternalStore) ────────────────────────────────

let cachedRaw: string | null | undefined
let cachedState: CartState = EMPTY_CART

/** Snímek košíku; stejný objekt, dokud se data nezmění (požadavek useSyncExternalStore). */
export function getCartSnapshot(): CartState {
  const raw = readRaw()
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedState = raw ? readCart() : EMPTY_CART
  }
  return cachedState
}

/** Na serveru (a při hydrataci) je košík prázdný; skutečný obsah se načte po připojení. */
export function getServerCartSnapshot(): CartState {
  return EMPTY_CART
}

export function subscribeCart(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === CART_STORAGE_KEY) onChange()
  }
  window.addEventListener(CART_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CART_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Úprava košíku jednou funkcí: updateCart((s) => addItem(s, item)). */
export function updateCart(fn: (state: CartState) => CartState): CartState {
  const next = fn(readCart())
  writeCart(next)
  return getCartSnapshot()
}

/** Jen pro testy: zapomene záložní paměť a mezipaměť snímku. */
export function __resetCartForTests(): void {
  memoryRaw = null
  storageBroken = false
  cachedRaw = undefined
  cachedState = EMPTY_CART
}
