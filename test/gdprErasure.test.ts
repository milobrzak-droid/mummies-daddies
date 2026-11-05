import { expect, test } from 'vitest'
import { redactPersonalData, redactionSummary, nameTokensOf, REDACTION_PLACEHOLDER } from '@/domain/crm/gdprErasure'

test('email appearing once gets replaced with the placeholder', () => {
  const out = redactPersonalData('Volali jsme s jan.novak@firma.cz ohledně nabídky.', { email: 'jan.novak@firma.cz' })
  expect(out).toBe(`Volali jsme s ${REDACTION_PLACEHOLDER} ohledně nabídky.`)
})

test('email appearing multiple times gets replaced everywhere', () => {
  const text = 'Kontakt: jan.novak@firma.cz. Potvrzeno i přes jan.novak@firma.cz v CC.'
  const out = redactPersonalData(text, { email: 'jan.novak@firma.cz' })
  expect(out).toBe(`Kontakt: ${REDACTION_PLACEHOLDER}. Potvrzeno i přes ${REDACTION_PLACEHOLDER} v CC.`)
})

test('email matching is case-insensitive', () => {
  const out = redactPersonalData('Psal JAN.NOVAK@FIRMA.CZ včera.', { email: 'jan.novak@firma.cz' })
  expect(out).toBe(`Psal ${REDACTION_PLACEHOLDER} včera.`)
})

test('email not present in text is a no-op', () => {
  const text = 'Schůzka proběhla bez problémů, klient souhlasí s nabídkou.'
  expect(redactPersonalData(text, { email: 'jan.novak@firma.cz' })).toBe(text)
})

test('does not redact a longer email that merely contains the local part as a substring', () => {
  // "jan.novak@firma.cz" nesmí "ukousnout" kus z delší/jiné adresy.
  const text = 'Omylem napsáno xjan.novak@firma.cz a taky jan.novak@firma.czech'
  expect(redactPersonalData(text, { email: 'jan.novak@firma.cz' })).toBe(text)
})

test('does not redact when the email is only a substring without the local part boundary', () => {
  const text = 'Adresa novak@firma.cz je jiná osoba než jan.novak@firma.cz'
  const out = redactPersonalData(text, { email: 'novak@firma.cz' })
  // "novak@firma.cz" se nesmí trefit uvnitř "jan.novak@firma.cz" (boundary hlídá i tečku před tokenem).
  expect(out).toBe(`Adresa ${REDACTION_PLACEHOLDER} je jiná osoba než jan.novak@firma.cz`)
})

test('name present in text gets redacted as a whole phrase', () => {
  const out = redactPersonalData('Domluvili jsme se s Jan Novák na dalším kroku.', { name: 'Jan Novák' })
  expect(out).toBe(`Domluvili jsme se s ${REDACTION_PLACEHOLDER} na dalším kroku.`)
})

test('common first name alone is NOT touched — only the full name phrase is redacted', () => {
  // "Jan" je běžné křestní jméno, které se může týkat úplně jiného člověka —
  // viz zdůvodnění v domain/crm/gdprErasure.ts. Redaguje se jen celá fráze "Jan Novák",
  // samotné "Jan" zůstává netknuté.
  const text = 'Jan z účetní firmy potvrdil platbu, ale s Jan Novák jsme se ještě nespojili.'
  const out = redactPersonalData(text, { name: 'Jan Novák' })
  expect(out).toBe(`Jan z účetní firmy potvrdil platbu, ale s ${REDACTION_PLACEHOLDER} jsme se ještě nespojili.`)
})

test('name is not redacted as a substring of a different, longer name', () => {
  const text = 'S Jan Nováková jsme mluvili o smlouvě, s Jan Novák zatím ne.'
  const out = redactPersonalData(text, { name: 'Jan Novák' })
  expect(out).toBe(`S Jan Nováková jsme mluvili o smlouvě, s ${REDACTION_PLACEHOLDER} zatím ne.`)
})

test('name not present in text is a no-op', () => {
  const text = 'Schůzka s klientem proběhla bez problémů.'
  expect(redactPersonalData(text, { name: 'Jan Novák' })).toBe(text)
})

test('email and name combined redact both, independently of order in text', () => {
  const text = 'Poznámka: Jan Novák (jan.novak@firma.cz) potvrdil zájem, kontakt jan.novak@firma.cz uložen.'
  const out = redactPersonalData(text, { email: 'jan.novak@firma.cz', name: 'Jan Novák' })
  expect(out).toBe(
    `Poznámka: ${REDACTION_PLACEHOLDER} (${REDACTION_PLACEHOLDER}) potvrdil zájem, kontakt ${REDACTION_PLACEHOLDER} uložen.`,
  )
})

test('missing identifiers (no email, no name) is a no-op', () => {
  const text = 'Obecná poznámka bez osobních údajů.'
  expect(redactPersonalData(text, {})).toBe(text)
})

test('empty/whitespace-only identifiers are ignored, not treated as real values', () => {
  const text = 'Text beze změny.'
  expect(redactPersonalData(text, { email: '  ', name: '' })).toBe(text)
})

test('empty input text is returned unchanged', () => {
  expect(redactPersonalData('', { email: 'jan.novak@firma.cz', name: 'Jan Novák' })).toBe('')
})

test('redactionSummary reports no change when text is untouched', () => {
  const original = 'Beze změny.'
  expect(redactionSummary(original, original)).toEqual({ changed: false, placeholderCount: 0 })
})

test('redactionSummary counts how many placeholders ended up in the redacted text', () => {
  const original = 'Kontakt jan.novak@firma.cz i jan.novak@firma.cz znovu.'
  const redacted = redactPersonalData(original, { email: 'jan.novak@firma.cz' })
  expect(redactionSummary(original, redacted)).toEqual({ changed: true, placeholderCount: 2 })
})

test('one-word name is left alone (would blank every standalone occurrence)', () => {
  const text = 'Jan z účetní volal, Jan potvrdil platbu.'
  expect(redactPersonalData(text, { name: 'Jan' })).toBe(text)
})

test('very short name is left alone', () => {
  const text = 'a pak jsme se domluvili a šli dál'
  expect(redactPersonalData(text, { name: 'a' })).toBe(text)
})

test('two tokens where one is a single character are left alone', () => {
  const text = 'Petr J přišel, Petr J. taky.'
  expect(redactPersonalData(text, { name: 'Petr J' })).toBe(text)
})

test('one-word name does not stop e-mail redaction', () => {
  const out = redactPersonalData('Jan (jan.novak@firma.cz) volal.', { email: 'jan.novak@firma.cz', name: 'Jan' })
  expect(out).toBe(`Jan (${REDACTION_PLACEHOLDER}) volal.`)
})

test('name matching tolerates repeated whitespace, tabs and newlines between tokens', () => {
  const out = redactPersonalData('Volal Jan   Novák a Jan\tNovák a Jan\nNovák.', { name: 'Jan Novák' })
  expect(out).toBe(`Volal ${REDACTION_PLACEHOLDER} a ${REDACTION_PLACEHOLDER} a ${REDACTION_PLACEHOLDER}.`)
})

test('name stored with repeated whitespace still matches single-spaced text', () => {
  const out = redactPersonalData('Volal Jan Novák.', { name: '  Jan    Novák ' })
  expect(out).toBe(`Volal ${REDACTION_PLACEHOLDER}.`)
})

test('name matching is case-insensitive, including Czech letters', () => {
  const out = redactPersonalData('Volal JAN NOVÁK a jan novák.', { name: 'Jan Novák' })
  expect(out).toBe(`Volal ${REDACTION_PLACEHOLDER} a ${REDACTION_PLACEHOLDER}.`)
})

test('diacritics are NOT folded (no fuzzy matching)', () => {
  const text = 'Volal Jan Novak.'
  expect(redactPersonalData(text, { name: 'Jan Novák' })).toBe(text)
})

test('regex metacharacters in a name are escaped', () => {
  const text = 'Volal J.R. Smith.'
  expect(redactPersonalData(text, { name: 'JxR. Smith' })).toBe(text)
  expect(redactPersonalData(text, { name: 'J.R. Smith' })).toBe(`Volal ${REDACTION_PLACEHOLDER}.`)
})

test('nameTokensOf accepts only >= 2 tokens of length >= 2', () => {
  expect(nameTokensOf('Jan Novák')).toEqual(['Jan', 'Novák'])
  expect(nameTokensOf('  Jan   Novák  ')).toEqual(['Jan', 'Novák'])
  expect(nameTokensOf('Jan')).toBeNull()
  expect(nameTokensOf('a')).toBeNull()
  expect(nameTokensOf('Petr J')).toBeNull()
  expect(nameTokensOf('')).toBeNull()
  expect(nameTokensOf(null)).toBeNull()
})
