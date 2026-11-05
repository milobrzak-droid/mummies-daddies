// Živý kurz ČNB (denní fixing) — jediný zdroj pravdy pro EUR→Kč převod
// napříč celou appkou (ruční formulář i automatický import nabídek), aby se
// kurz nelišil projekt od projektu podle toho, co si kdo napsal do PDF.
const CNB_DAILY_URL =
  'https://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt'

// Kurz Kč za 1 EUR. Vyhodí chybu, pokud ČNB feed je nedostupný nebo EUR chybí.
export async function czkPerEur(): Promise<number> {
  const res = await fetch(CNB_DAILY_URL, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!res.ok) throw new Error(`ČNB kurzovní lístek nedostupný (${res.status})`)
  const text = await res.text()

  const line = text.split('\n').find((l) => l.startsWith('EMU|'))
  if (!line) throw new Error('EUR kurz nenalezen v ČNB kurzovním lístku')

  const [, , amountStr, , rateStr] = line.split('|')
  const amount = Number(amountStr)
  const rate = Number(rateStr)
  if (!Number.isFinite(amount) || !Number.isFinite(rate) || amount <= 0) {
    throw new Error('ČNB kurzovní lístek má neočekávaný formát')
  }
  return rate / amount
}
