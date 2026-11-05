// Příznaky zprávy a důvody, proč zpráva čeká ve frontě, s českými popisky.
// Jen konstanty a typy, žádné importy ze serveru: čte je i klientská karta
// fronty (components/MailQueueCard.tsx), takže sem nesmí nic, co táhne Graph
// nebo databázi. Hodnoty musí sedět s CHECKy v 0091_mail_content_intake.sql
// a 0099_mail_offer_attachment.sql (hlídá test/mail-content-migration.test.ts).

export const MAIL_SIGNALS = ['approval', 'schedule', 'change', 'attachment'] as const
export type MailSignal = (typeof MAIL_SIGNALS)[number]

export const MAIL_SIGNAL_LABEL: Record<MailSignal, string> = {
  approval: 'schválení',
  schedule: 'posun termínu',
  change: 'požadavek na změnu',
  attachment: 'přílohy',
}

export const MAIL_WAIT_REASONS = ['no_match', 'ambiguous', 'ambiguous_target', 'proposal_pending', 'assign_failed', 'offer_draft'] as const
export type MailWaitReason = (typeof MAIL_WAIT_REASONS)[number]

/** Věta pro člověka: proč zpráva čeká ve frontě. */
export const MAIL_WAIT_REASON_TEXT: Record<MailWaitReason, string> = {
  no_match: 'Klienta jsme nenašli podle odesílatele ani podle předmětu.',
  ambiguous: 'Odesílatel patří k víc klientům, Cockpit nechce hádat.',
  ambiguous_target: 'Klient je jasný, ale má víc dodávek nebo obchodů. Vyber, kterého se zpráva týká.',
  proposal_pending: 'U klienta už čeká návrh stejného druhu. Vyřiď ho a zkus to znovu, nebo zprávu zahoď.',
  assign_failed: 'Návrh se nepodařilo založit. Zkus to znovu.',
  offer_draft: 'V příloze je nabídka. Cockpit z ní vytáhl návrh zakázky: zkontroluj klienta a cenu a potvrď, nebo zprávu zahoď.',
}

