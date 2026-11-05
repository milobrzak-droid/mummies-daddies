'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isTypingTarget } from '@/lib/commands'

// Toast se „Zpět“ (docs/PROVOZ.md §9, §11). Vratná akce se provede hned
// a toast nabídne vrácení; potvrzovací dialog zůstává jen u nevratných akcí.
//
//   const toast = useUndoToast()
//   toast.show({ message: 'Úkol je hotový.', undo: () => updateTaskStatus(id, 'todo') })
//
// Vrácení volá tutéž serverovou akci s předchozí hodnotou, pravidla na serveru
// se nemění. Jeden toast najednou (nový nahradí starý), zmizí po 6 s; když na
// něm je myš nebo fokus, čas se zastaví (WCAG 2.2.1). ⌘Z / Ctrl+Z vrací, dokud
// je toast vidět. Oblast má role="status", takže čtečka text přečte.

export const TOAST_DURATION_MS = 6000

export interface ToastOptions {
  message: string
  /** Když je zadané, toast ukáže tlačítko „Zpět“. */
  undo?: () => void | Promise<void>
  /** Výchozí 6 s. */
  duration?: number
}

interface ToastApi {
  show: (options: ToastOptions) => void
  dismiss: () => void
}

interface ActiveToast extends ToastOptions { id: number }

// Bez provideru (izolované testy komponent) je toast tichý no-op, ne pád.
const NOOP: ToastApi = { show: () => {}, dismiss: () => {} }
const ToastContext = createContext<ToastApi>(NOOP)

export function useUndoToast(): ToastApi {
  return useContext(ToastContext)
}

export function UndoToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | null>(null)
  const idRef = useRef(0)

  const dismiss = useCallback(() => setToast(null), [])
  const show = useCallback((options: ToastOptions) => {
    idRef.current += 1
    setToast({ ...options, id: idRef.current })
  }, [])
  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss])

  const runUndo = useCallback(async (t: ActiveToast) => {
    setToast(null)
    try {
      await t.undo?.()
    } catch {
      show({ message: 'Vrácení se nepovedlo. Zkus to znovu ručně.' })
    }
  }, [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toast={toast} onDismiss={dismiss} onUndo={runUndo} />
    </ToastContext.Provider>
  )
}

function ToastViewport({ toast, onDismiss, onUndo }: {
  toast: ActiveToast | null
  onDismiss: () => void
  onUndo: (t: ActiveToast) => void
}) {
  // Oblast role="status" je v DOM stále, i když je prázdná: čtečky hlásí jen
  // změnu obsahu už existující živé oblasti.
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[80] flex justify-center px-4 md:bottom-6" >
      <div role="status" aria-live="polite" aria-atomic="true" className="contents">
        {toast && <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} onUndo={onUndo} />}
      </div>
    </div>
  )
}

function ToastCard({ toast, onDismiss, onUndo }: {
  toast: ActiveToast
  onDismiss: () => void
  onUndo: (t: ActiveToast) => void
}) {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(toast.duration ?? TOAST_DURATION_MS)
  const startedAt = useRef(0)

  // Odpočet: při najetí/fokusu se zbývající čas uloží, při odchodu pokračuje.
  useEffect(() => {
    if (paused) return
    startedAt.current = Date.now()
    const timer = setTimeout(onDismiss, remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt.current))
    }
  }, [paused, onDismiss])

  // ⌘Z / Ctrl+Z vrací poslední akci, dokud je toast vidět; Esc ho zavře.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        // Otevřená modální vrstva (paleta, nápověda) si Esc bere pro sebe.
        if (!document.querySelector('[aria-modal="true"]')) onDismiss()
        return
      }
      if (!toast.undo || e.altKey || e.shiftKey) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !isTypingTarget(e.target)) {
        e.preventDefault()
        onUndo(toast)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toast, onDismiss, onUndo])

  return (
    <div
      className="float-in pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-3 rounded-full bg-navy py-2 pl-5 pr-2 text-body text-white shadow-e3"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="min-w-0 flex-1 py-1">{toast.message}</span>
      {toast.undo && (
        <button
          type="button"
          onClick={() => onUndo(toast)}
          className="inline-flex min-h-[36px] shrink-0 items-center rounded-full bg-white/15 px-4 text-callout font-semibold text-white hover:bg-white/25"
        >
          Zpět
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Zavřít oznámení"
        className="-my-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  )
}
