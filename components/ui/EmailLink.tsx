import { safeMailtoHref } from '@/lib/mailto'

// E-mail z dat jako odkaz jen tehdy, když je to prostá adresa (bez parametrů
// mailto, viz lib/mailto.ts). Jinak se zobrazí jen jako text.
export function EmailLink({ email }: { email: string | null | undefined }) {
  if (!email) return <span className="text-muted">—</span>
  const href = safeMailtoHref(email)
  return href ? <a href={href}>{email}</a> : <span>{email}</span>
}
