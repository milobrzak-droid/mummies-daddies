'use client'
import { useRouter } from 'next/navigation'
import { ContactForm } from '@/components/ContactForm'
import { useUndoToast } from '@/components/ui/Toast'
import type { ActionResult } from '@/lib/actionResult'
import type { Contact } from '@/lib/types'

// Úprava kontaktu v bočním panelu na detailu klienta. Po uložení se panel
// zavře (URL bez ?kontakt=) a tichý toast potvrdí uložení. Server akce
// (updateContact) je stejná jako na samostatné stránce /kontakty/[id]/edit.
export function ClientsContactEditor({ action, contact, optOutInfo, closeHref }: {
  action: (prev: unknown, formData: FormData) => Promise<ActionResult>
  contact: Contact
  optOutInfo?: string
  closeHref: string
}) {
  const router = useRouter()
  const toast = useUndoToast()
  return (
    <ContactForm
      action={action}
      initial={contact}
      submitLabel="Uložit změny"
      optOutInfo={optOutInfo}
      onSaved={() => {
        toast.show({ message: 'Kontakt je uložený.' })
        router.replace(closeHref, { scroll: false })
      }}
    />
  )
}
