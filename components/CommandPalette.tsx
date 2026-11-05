'use client'
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { searchPalette } from '@/domain/crm/actions/paletteSearch'
import { useModal } from '@/components/ui/useModal'
import {
  filterCommands, isTypingTarget, visibleCommands, type Command,
} from '@/lib/commands'
import type { SearchResult } from '@/domain/crm/queries/search'

// Paleta příkazů ⌘K (docs/PROVOZ.md §11): jedno místo, odkud se dá dojít
// kamkoli a založit cokoli. Otevře ji ⌘K / Ctrl+K (i z pole), `/` mimo pole,
// tlačítko Hledat v postranním panelu a `C` (jen akce zakládání).
// Přístupnost: role="dialog" + aria-modal, vstup je combobox nad listboxem
// (aria-activedescendant), šipky vybírají, Enter otevře, Esc zavře; fokus se
// při otevření zachytí a po zavření vrátí (components/ui/useModal.ts).
// Hledání záznamů jde přes serverovou akci se stejným oprávněním jako stránka
// Hledat; obchody vidí jen obchodní role.

export interface PaletteOpenOptions {
  /** `create` = jen akce zakládání (klávesa C); výchozí `all`. */
  mode?: 'all' | 'create'
}

interface PaletteApi {
  open: (options?: PaletteOpenOptions) => void
  close: () => void
  toggle: () => void
  isOpen: boolean
}

// Bez provideru (izolované testy komponent) je paleta tichý no-op.
const NOOP: PaletteApi = { open: () => {}, close: () => {}, toggle: () => {}, isOpen: false }
const PaletteContext = createContext<PaletteApi>(NOOP)

export function useCommandPalette(): PaletteApi {
  return useContext(PaletteContext)
}

/** Zkratka pro tlačítko: „⌘K“ na Macu, „Ctrl K“ jinde (na serveru Mac). */
export function usePaletteShortcutLabel(): string {
  const mac = useSyncExternalStore(
    () => () => {},
    () => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent),
    () => true,
  )
  return mac ? '⌘K' : 'Ctrl K'
}

export function CommandPaletteProvider({ canSeeSales, isAdmin, children }: {
  canSeeSales: boolean
  isAdmin: boolean
  children: ReactNode
}) {
  const [state, setState] = useState<{ open: boolean; mode: 'all' | 'create'; session: number }>({ open: false, mode: 'all', session: 0 })

  const open = useCallback((options?: PaletteOpenOptions) => {
    setState((s) => ({ open: true, mode: options?.mode ?? 'all', session: s.open ? s.session : s.session + 1 }))
  }, [])
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), [])
  const toggle = useCallback(() => {
    setState((s) => (s.open ? { ...s, open: false } : { open: true, mode: 'all', session: s.session + 1 }))
  }, [])
  const api = useMemo<PaletteApi>(() => ({ open, close, toggle, isOpen: state.open }), [open, close, toggle, state.open])

  // ⌘K / Ctrl+K funguje všude (i v poli); `/` jen mimo pole a bez modifikátoru.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        toggle()
        return
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)
        && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault()
        open()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, toggle])

  return (
    <PaletteContext.Provider value={api}>
      {children}
      {state.open && (
        <PaletteDialog key={state.session} mode={state.mode} canSeeSales={canSeeSales} isAdmin={isAdmin} onClose={close} />
      )}
    </PaletteContext.Provider>
  )
}

// ── obsah palety ─────────────────────────────────────────────────────────

interface Row {
  key: string
  label: string
  detail?: string | null
  href: string
  /** SVG path ikony (příkazy); záznamy mají iniciálu. */
  icon?: string
  initial?: string
  tone?: string
}
interface Section { id: string; heading: string; rows: Row[] }

const SEARCH_DEBOUNCE_MS = 200
const MAX_COMMAND_MATCHES = 8

const KIND_HEADING: Record<SearchResult['kind'], string> = {
  account: 'Firmy', contact: 'Kontakty', deal: 'Obchody', partner: 'Partneři',
}
// Barva = druh záznamu, stejně jako na stránce Hledat (§4: obchod žlutý, ne červený).
const KIND_TONE: Record<SearchResult['kind'], string> = {
  account: 'tile-sky', contact: 'tile-lav', deal: 'tile-sun', partner: 'tile-mint',
}
const KIND_ORDER: SearchResult['kind'][] = ['account', 'contact', 'deal', 'partner']

function commandRow(c: Command): Row {
  return { key: c.id, label: c.label, detail: c.hint, href: c.href, icon: c.icon }
}

function recordSections(records: SearchResult[]): Section[] {
  return KIND_ORDER.flatMap((kind) => {
    const rows = records.filter((r) => r.kind === kind).map<Row>((r) => ({
      key: `${r.kind}-${r.id}`, label: r.title, detail: r.subtitle, href: r.href,
      initial: (r.title.trim()[0] ?? '?').toUpperCase(), tone: KIND_TONE[r.kind],
    }))
    return rows.length ? [{ id: `rec-${kind}`, heading: KIND_HEADING[kind], rows }] : []
  })
}

type SearchState = { status: 'idle' | 'loading' | 'done' | 'error'; records: SearchResult[]; error?: string }
const IDLE: SearchState = { status: 'idle', records: [] }

function PaletteDialog({ mode, canSeeSales, isAdmin, onClose }: {
  mode: 'all' | 'create'
  canSeeSales: boolean
  isAdmin: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [found, setFound] = useState<SearchState>(IDLE)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const requestId = useRef(0)

  useModal(true, dialogRef, onClose, inputRef)
  useEffect(() => () => clearTimeout(timer.current), [])

  const trimmed = query.trim()
  const canSearch = mode === 'all' && trimmed.length >= 2 && trimmed.length <= 100

  const sections = useMemo<Section[]>(() => {
    const pool = visibleCommands({ canSeeSales, isAdmin }).filter((c) => mode === 'all' || c.group === 'action')
    const matched = filterCommands(pool, query)
    const out: Section[] = []
    if (!trimmed) {
      const actions = matched.filter((c) => c.group === 'action').map(commandRow)
      const nav = matched.filter((c) => c.group === 'nav').map(commandRow)
      if (actions.length) out.push({ id: 'actions', heading: 'Akce', rows: actions })
      if (nav.length) out.push({ id: 'nav', heading: 'Přejít na', rows: nav })
      return out
    }
    const shown = matched.slice(0, MAX_COMMAND_MATCHES)
    const actions = shown.filter((c) => c.group === 'action').map(commandRow)
    const nav = shown.filter((c) => c.group === 'nav').map(commandRow)
    if (actions.length) out.push({ id: 'actions', heading: 'Akce', rows: actions })
    if (nav.length) out.push({ id: 'nav', heading: 'Přejít na', rows: nav })
    if (canSearch) {
      out.push(...recordSections(found.records))
      out.push({
        id: 'fulltext', heading: 'Hledání',
        rows: [{ key: 'fulltext', label: `Hledat „${trimmed}“ ve všech záznamech`, detail: 'Hledat', href: `/cockpit/hledat?q=${encodeURIComponent(trimmed)}`,
          icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5' }],
      })
    }
    return out
  }, [query, trimmed, mode, canSeeSales, isAdmin, canSearch, found.records])

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0))
  const optionId = (i: number) => `${listId}-o${i}`

  useEffect(() => {
    document.getElementById(`${listId}-o${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, listId, rows.length])

  function onQueryChange(value: string) {
    setQuery(value)
    setActive(0)
    clearTimeout(timer.current)
    requestId.current += 1
    const v = value.trim()
    if (mode !== 'all' || v.length < 2 || v.length > 100) { setFound(IDLE); return }
    const mine = requestId.current
    setFound((f) => ({ status: 'loading', records: f.records }))
    timer.current = setTimeout(async () => {
      let result: Awaited<ReturnType<typeof searchPalette>>
      try {
        result = await searchPalette(v)
      } catch {
        result = { ok: false, error: 'Hledání se nepovedlo. Zkus to znovu.' }
      }
      if (mine !== requestId.current) return // odpověď na starší dotaz
      setFound(result.ok
        ? { status: 'done', records: result.items }
        : { status: 'error', records: [], error: result.error })
    }, SEARCH_DEBOUNCE_MS)
  }

  function go(row: Row | undefined) {
    if (!row) return
    onClose()
    router.push(row.href)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(rows.length ? (activeIndex + 1) % rows.length : 0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(rows.length ? (activeIndex - 1 + rows.length) % rows.length : 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(rows[activeIndex])
    }
  }

  // Věta pro čtečku: co se právě děje a kolik je možností.
  const announce = found.status === 'loading' ? 'Hledám…'
    : found.status === 'error' ? (found.error ?? 'Hledání se nepovedlo.')
    : rows.length === 0 ? 'Žádná shoda.'
    : `${rows.length} ${rows.length === 1 ? 'možnost' : rows.length < 5 ? 'možnosti' : 'možností'}`

  // Pořadí řádku napříč skupinami (pro aria-activedescendant a šipky).
  const starts = sections.reduce<number[]>((acc, sec, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + sections[i - 1].rows.length)
    return acc
  }, [])
  const noMatch = trimmed.length > 0 && sections.every((s) => s.id === 'fulltext') && found.status === 'done'

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pb-4 pt-[10vh] md:pt-[14vh]">
      <div className="fade-in absolute inset-0 bg-[rgba(23,32,46,.38)] backdrop-blur-[2px]" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Paleta příkazů"
        className="float-in relative flex max-h-[min(72vh,560px)] w-full max-w-[640px] flex-col overflow-hidden rounded-card bg-surface shadow-e3"
      >
        <div className="flex items-center gap-3 border-b border-line px-4 focus-within:border-navy">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? optionId(activeIndex) : undefined}
            aria-label={mode === 'create' ? 'Co chceš založit?' : 'Hledat nebo spustit příkaz'}
            placeholder={mode === 'create' ? 'Co chceš založit?' : canSeeSales ? 'Firma, kontakt, obchod, stránka nebo akce…' : 'Firma, kontakt, stránka nebo akce…'}
            value={query}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            className="!min-h-[56px] !flex-1 !rounded-none !border-0 !bg-transparent !px-0 text-[16px] !shadow-none !outline-none focus:!shadow-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[32px] shrink-0 items-center rounded-full px-2.5 text-footnote font-semibold text-muted hover:bg-soft hover:text-ink"
          >
            <span className="sr-only">Zavřít paletu</span>
            <kbd aria-hidden="true">Esc</kbd>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div id={listId} role="listbox" aria-label="Výsledky">
            {sections.map((section, si) => (
              <div key={section.id} role="group" aria-labelledby={`${listId}-${section.id}`} className="mb-1 last:mb-0">
                <div id={`${listId}-${section.id}`} className="eyebrow px-3 pb-1 pt-2">{section.heading}</div>
                {section.rows.map((row, ri) => {
                  const i = starts[si] + ri
                  const selected = i === activeIndex
                  return (
                    <div
                      key={row.key}
                      id={optionId(i)}
                      role="option"
                      aria-selected={selected}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => { if (!selected) setActive(i) }}
                      onClick={() => go(row)}
                      className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-btn px-3 py-2 ${selected ? 'bg-soft' : ''}`}
                    >
                      {row.icon ? (
                        <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-xs bg-soft text-ink">
                          <svg focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={row.icon} /></svg>
                        </span>
                      ) : (
                        <span aria-hidden="true" className={`tile ${row.tone ?? ''} inline-grid !h-8 !w-8 shrink-0 place-items-center !p-0 font-heading text-[13px] font-bold text-ink`}>
                          {row.initial}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-headline text-ink">{row.label}</span>
                      {row.detail && (
                        /^G [A-Z]$/.test(row.detail)
                          ? <span aria-hidden="true" className="flex shrink-0 gap-1"><kbd>G</kbd><kbd>{row.detail.slice(2)}</kbd></span>
                          : <span className="max-w-[40%] shrink-0 truncate text-callout text-muted">{row.detail}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          {found.status === 'loading' && <p aria-hidden="true" className="m-0 px-3 py-2 text-callout text-muted">Hledám…</p>}
          {found.status === 'error' && <p className="m-0 px-3 py-2 text-callout text-neg">{found.error}</p>}
          {noMatch && <p className="m-0 px-3 py-2 text-callout text-muted">Nic jsme nenašli pro „{trimmed}“. Zkus kratší nebo jinak napsaný výraz.</p>}
          {!trimmed && rows.length === 0 && <p className="m-0 px-3 py-6 text-center text-callout text-muted">Nic k zobrazení.</p>}
          {trimmed.length === 1 && mode === 'all' && <p className="m-0 px-3 py-2 text-callout text-muted">Pro hledání záznamů napiš aspoň 2 znaky.</p>}
        </div>

        <div role="status" className="sr-only">{announce}</div>

        <div aria-hidden="true" className="hidden items-center gap-4 border-t border-line bg-soft/60 px-4 py-2 text-footnote text-muted md:flex">
          <span className="inline-flex items-center gap-1.5"><kbd>↑</kbd><kbd>↓</kbd> vybrat</span>
          <span className="inline-flex items-center gap-1.5"><kbd>↵</kbd> otevřít</span>
          <span className="inline-flex items-center gap-1.5"><kbd>Esc</kbd> zavřít</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
