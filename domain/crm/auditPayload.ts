// Neosobní kostry pro audit_event. Čisté funkce bez I/O; žijí mimo
// domain/crm/actions/*.ts, protože ty mají 'use server' (každý export by byl
// Server Akce).
//
// Proč: audit_event nemá retenci ani možnost výmazu, takže osobní údaj, který
// se do něj zapíše, tam zůstane napořád. Právo na výmaz (GDPR) by pak bylo
// jen přesunem údaje ze sales_activity/contact do auditu. Ukládáme proto jen
// to, že událost proběhla, nad čím a v jakém rozsahu.
//
// TVARY MUSÍ ODPOVÍDAT migraci supabase/migrations/0037_scrub_pii_from_audit.sql
// (ta přepisuje historické řádky), aby staré a nové řádky vypadaly stejně.
// Při změně tvaru tady je nutné změnit i tu migraci (a naopak).

export type ContactDeletedAudit = {
  account_id: number | null
  had_email: boolean
  pii_scrubbed: true
}

// `account_id` je null u partnerského kontaktu (tam se account_id nečte);
// 0037 dělá totéž (`before -> 'account_id'` z řádku bez toho klíče = null).
// Jméno, e-mail ani role se neukládají (role bývá jmenná, např. „paní Dvořáková").
export function contactDeletedAuditBefore(existing: {
  email: string | null
  account_id?: number | null
}): ContactDeletedAudit {
  return {
    account_id: existing.account_id ?? null,
    had_email: (existing.email ?? '').trim() !== '',
    pii_scrubbed: true,
  }
}

export type SalesActivityRedactedAudit = {
  had_subject: boolean
  had_body: boolean
  subject_length: number
  body_length: number
  pii_scrubbed: true
}

// Délka ve znacích (kódových bodech) jako char_length() v Postgresu, ne v
// UTF-16 jednotkách jako String.length.
function charLength(value: string): number {
  return Array.from(value).length
}

// Použije se pro `before` (původní text) i `after` (text po redakci).
// Samotný subject/body se nikdy neukládá, ani zredigovaný — může pořád nést
// kontext o osobě.
export function salesActivityRedactedAudit(text: {
  subject: string | null
  body: string | null
}): SalesActivityRedactedAudit {
  const subject = text.subject ?? ''
  const body = text.body ?? ''
  return {
    had_subject: subject !== '',
    had_body: body !== '',
    subject_length: charLength(subject),
    body_length: charLength(body),
    pii_scrubbed: true,
  }
}

// Název úkolu bývá volný text a často nese jméno („Zavolat panu Novákovi").
// Ukládá se jen stav a řešitel (uuid člena týmu) — stejný tvar, na jaký
// 0037 přepisuje staré task.deleted řádky, včetně značky pii_scrubbed.
export function taskDeletedAuditBefore(existing: {
  status: string
  assignee_id: string | null
}): { status: string; assignee_id: string | null; pii_scrubbed: true } {
  return { status: existing.status, assignee_id: existing.assignee_id, pii_scrubbed: true }
}
