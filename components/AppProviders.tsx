'use client'
import type { ReactNode } from 'react'
import { CommandPaletteProvider } from '@/components/CommandPalette'
import { ShortcutsProvider } from '@/components/Shortcuts'
import { UndoToastProvider } from '@/components/ui/Toast'
import { AccessProvider } from '@/components/AccessContext'

// Klientské vrstvy celé aplikace: toast se „Zpět“ a paleta příkazů ⌘K a klávesové zkratky.
// Layout (server) jen předá, co smí člověk vidět; oprávnění vždy hlídá server.
// Jeden kontext AccessContext nese vše, co řídí zobrazení podle role
// (záložky sekcí, technický detail u „Tahle část se připravuje“).
export function AppProviders({ canSeeSales, isAdmin, showTechDetail = false, children }: {
  canSeeSales: boolean
  isAdmin: boolean
  /** Vedení a správce vidí u „Tahle část se připravuje“ i číslo migrace. */
  showTechDetail?: boolean
  children: ReactNode
}) {
  return (
    <AccessProvider value={{ canSeeSales, isAdmin, showTechDetail }}>
      <UndoToastProvider>
        <CommandPaletteProvider canSeeSales={canSeeSales} isAdmin={isAdmin}>
          <ShortcutsProvider canSeeSales={canSeeSales}>
            {children}
          </ShortcutsProvider>
        </CommandPaletteProvider>
      </UndoToastProvider>
    </AccessProvider>
  )
}
