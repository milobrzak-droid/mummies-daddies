'use client'
import { useEffect } from 'react'
import { touchChangesView } from '@/domain/crm/actions/changesView'

// Po vykreslení obrazovky Dnes zapíše, že ji člověk otevřel (okno „Co se
// změnilo" se příště počítá od tohohle otevření). Nic nevykresluje a seznam
// změn nepřekresluje: okno pro tuhle návštěvu už server spočítal.
export function ChangesSeen() {
  useEffect(() => {
    void touchChangesView()
  }, [])
  return null
}
