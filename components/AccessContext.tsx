'use client'
import { createContext, useContext, type ReactNode } from 'react'

// Co smí přihlášený člověk vidět v navigaci (záložky sekcí apod.) a zda vidí
// technické detaily (číslo chybějící migrace u FeaturePending). Hodnotu
// předá layout (server) přes AppProviders. Je to jen pro zobrazení — oprávnění
// vždy hlídá server (stránka sama přesměruje, RLS). Výchozí hodnota mimo
// provider je „nic navíc“, aby se obchodní odkazy omylem neukázaly.
export interface Access {
  canSeeSales: boolean
  isAdmin: boolean
  /** Vedení a správce: technický detail (např. „chybí migrace 0062“). */
  showTechDetail: boolean
}

const NO_ACCESS: Access = { canSeeSales: false, isAdmin: false, showTechDetail: false }

const AccessContext = createContext<Access>(NO_ACCESS)

export function AccessProvider({ value, children }: { value: Access; children: ReactNode }) {
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
}

export function useAccess(): Access {
  return useContext(AccessContext)
}
