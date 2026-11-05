'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useCommandPalette } from '@/components/CommandPalette'
import { useModal } from '@/components/ui/useModal'
import { GO_SHORTCUTS, goTarget, isTypingTarget } from '@/lib/commands'

// Klávesové zkratky a jejich přehled (docs/PROVOZ.md §11). Jen pár
// věcí, které se dají zapamatovat: `?` přehled, `G` a písmeno přejde na
// sekci, `C` otevře zakládání. ⌘K, `/` a ⌘Z řeší paleta a toast.
// Zkratky bez modifikátoru se nikdy nespouštějí při psaní do pole, pod
// otevřenou modální vrstvou ani při skládání znaků (IME).

const GO_WINDOW_MS = 1200

interface HelpApi { open: () => void; close: () => void }
const NOOP: HelpApi = { open: () => {}, close: () => {} }
const HelpContext = createContext<HelpApi>(NOOP)

export function useShortcutsHelp(): HelpApi {
  return useContext(HelpContext)
}

export function ShortcutsProvider({ canSeeSales, children }: { canSeeSales: boolean; children: ReactNode }) {
  const router = useRouter()
  const palette = useCommandPalette()
  const [helpOpen, setHelpOpen] = useState(false)
  const openHelp = useCallback(() => setHelpOpen(true), [])
  const closeHelp = useCallback(() => setHelpOpen(false), [])
  const api = useMemo<HelpApi>(() => ({ open: openHelp, close: closeHelp }), [openHelp, closeHelp])
  const goPending = useRef<number | null>(null)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) {
        goPending.current = null
        return
      }
      const key = e.key
      // druhá klávesa sekvence G + písmeno
      if (goPending.current !== null) {
        const fresh = Date.now() - goPending.current <= GO_WINDOW_MS
        goPending.current = null
        if (fresh && !e.shiftKey) {
          const href = goTarget(key, canSeeSales)
          if (href) {
            e.preventDefault()
            router.push(href)
            return
          }
        }
      }
      if (key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      } else if ((key === 'g' || key === 'G') && !e.shiftKey) {
        goPending.current = Date.now()
      } else if ((key === 'c' || key === 'C') && !e.shiftKey) {
        e.preventDefault()
        palette.open({ mode: 'create' })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [canSeeSales, palette, router])

  return (
    <HelpContext.Provider value={api}>
      {children}
      {helpOpen && <ShortcutsHelp canSeeSales={canSeeSales} onClose={closeHelp} />}
    </HelpContext.Provider>
  )
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden="true" className="text-footnote text-muted">pak</span>}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  )
}

function ShortcutsHelp({ canSeeSales, onClose }: { canSeeSales: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useModal(true, ref, onClose, closeRef)

  const groups: { title: string; rows: { keys: string[]; label: string }[] }[] = [
    {
      title: 'Všude',
      rows: [
        { keys: ['⌘K'], label: 'Paleta příkazů: hledat a přejít kamkoli (Ctrl+K mimo Mac)' },
        { keys: ['/'], label: 'Hledat' },
        { keys: ['C'], label: 'Založit úkol, klienta, obchod…' },
        { keys: ['⌘Z'], label: 'Vrátit poslední akci, dokud je vidět oznámení' },
        { keys: ['?'], label: 'Tenhle přehled' },
        { keys: ['Esc'], label: 'Zavřít paletu, přehled nebo oznámení' },
      ],
    },
    {
      title: 'Přejít na',
      rows: GO_SHORTCUTS.filter((s) => !s.salesOnly || canSeeSales).map((s) => ({ keys: ['G', s.key.toUpperCase()], label: s.label })),
    },
  ]

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pb-4 pt-[10vh] md:pt-[14vh]">
      <div className="fade-in absolute inset-0 bg-[rgba(23,32,46,.38)] backdrop-blur-[2px]" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="float-in relative flex max-h-[min(80vh,620px)] w-full max-w-[520px] flex-col overflow-hidden rounded-card bg-surface shadow-e3"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id="shortcuts-title" className="m-0 text-title2">Klávesové zkratky</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Zavřít přehled zkratek"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-soft hover:text-ink"
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-3">
          {groups.map((g) => (
            <section key={g.title} aria-labelledby={`sc-${g.title}`} className="mb-3 last:mb-0">
              <h3 id={`sc-${g.title}`} className="eyebrow m-0 pb-1 pt-2 font-mono font-medium">{g.title}</h3>
              <ul className="m-0 list-none p-0">
                {g.rows.map((r) => (
                  <li key={r.keys.join('+')} className="flex min-h-[40px] items-center justify-between gap-4 border-b border-[color:var(--c-line-2)] py-2 last:border-b-0">
                    <span className="text-body text-ink">{r.label}</span>
                    <Keys keys={r.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="m-0 pb-2 pt-1 text-callout text-muted">Zkratky bez ⌘ nefungují, když píšeš do pole.</p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
