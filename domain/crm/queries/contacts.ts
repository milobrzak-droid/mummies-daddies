import { createClient } from '@/lib/supabase/server'
import type { Contact } from '@/lib/types'

// Kontakt sám o sobě, bez ohledu na to, jestli visí na klientovi nebo na
// partnerovi — obojí umí (viz CHECK v migraci 0019). Dotazy vázané na jednu
// stranu jsou v accounts.ts a partners.ts; tenhle potřebuje stránka úpravy,
// která se otevírá z obou míst.
export async function getContactById(id: number): Promise<Contact | null> {
  const s = await createClient()
  const { data, error } = await s.from('contact').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}
