// E-maily účastníků schůzky z volného textu formuláře (plánování schůzky).
// Čistá funkce mimo 'use server' soubor, ať jde testovat.

// Nejvýš tolik účastníků a jen tvarově platná adresa: text z formuláře jde do
// pozvánky v Outlooku i do kontaktů, `includes('@')` by pustilo cokoli.
const MAX_ATTENDEES = 30
const EMAIL_SHAPE = /^[^\s@<>"',;()]{1,64}@[^\s@<>"',;()]{1,255}\.[^\s@<>"',;()]{2,}$/

export function parseEmails(raw: string | null | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_SHAPE.test(e)))]
    .slice(0, MAX_ATTENDEES)
}
