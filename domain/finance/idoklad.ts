// Čtení z iDokladu (P2.3, migrace 0092) — ČISTÁ logika párování a rozdílů.
//
// Vstup: vydané faktury a úhrady z iDokladu (connectors/idoklad), firmy
// a finanční záznamy Cockpitu, dosavadní fronta rozdílů. Výstup: PLÁN — co
// zapsat (nové záznamy, spárování, splatnost), jaké rozdíly hlásit a které
// staré rozdíly zmizely. Žádné I/O; zápisy dělá domain/finance/idokladSync.ts.
//
// PRAVIDLA (proč tak):
//  * Zapisuje se jen JEDNOZNAČNÁ shoda. Co jednoznačné není (neznámá firma,
//    víc kandidátů, jiná částka, jiná firma u stejného čísla dokladu), jde do
//    fronty „Rozdíly k vyřešení" a nic se nemění.
//  * Faktura se páruje se záznamem „vyfakturováno": 1) podle čísla dokladu
//    nebo variabilního symbolu v `external_ref`, 2) když číslo chybí, podle
//    firmy + měny + částky u otevřeného podkladu k fakturaci (návrh bez
//    čísla, typicky z přijatého milníku). Firmu určí IČO, jinak přesný název
//    (jen u firmy bez IČO — firma s jiným IČO je jiný subjekt).
//  * Částka „vyfakturováno" = základ bez DPH (jako částky obchodů). Za shodu
//    se bere i částka s DPH (kdo doklad opsal celý). „Přijato" je úhrada
//    přepočtená na základ bez DPH podle poměru faktury (TotalWithoutVat /
//    TotalWithVat), ať jde porovnat s „vyfakturováno"; u neplátce je poměr 1.
//  * Zrušený záznam (člověk ho zrušil vědomě) se z iDokladu nevytváří znovu.
//  * Nic se nezapisuje do iDokladu. Nic tu neodhaduje: co v datech není,
//    se nedopočítává.
import type { IdokladInvoice, IdokladPayment } from '@/connectors/idoklad'
import type { Currency, FinancialKind, FinancialStatus } from '@/domain/finance/records'

// ---------------------------------------------------------------- konstanty

export const IDOKLAD_SYNC_JOB_NAME = 'idoklad-sync'
/** Zámek musí přežít nejdelší běh (rozpočet ~45 s + zápisy). */
export const IDOKLAD_SYNC_JOB_TTL_SECONDS = 120
export const IDOKLAD_SYNC_ACTOR_ID = 'job:idoklad-sync'
/** Klíč v connector_state (Stav zdrojů, čerstvost posledního běhu). */
export const IDOKLAD_CONNECTOR = 'idoklad'

export const IDOKLAD_DEFAULT_DAYS = 90
export const IDOKLAD_MAX_DAYS = 365
// Tolerance: částka faktury 1 haléř, součet úhrad 5 haléřů (zaokrouhlení
// přepočtu na základ bez DPH po jednotlivých úhradách) — viz within().
/** Kolik ověřovacích dotazů „existuje faktura s tímto číslem?" jeden běh nejvýš udělá. */
export const MAX_VERIFY_LOOKUPS = 20

export const SUPPORTED_CURRENCIES: readonly Currency[] = ['CZK', 'EUR']

/** Počet dní zpětně z proměnné IDOKLAD_SYNC_DAYS (celé 1–365, jinak výchozí 90). */
export function syncDaysFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.IDOKLAD_SYNC_DAYS)
  return Number.isInteger(n) && n >= 1 && n <= IDOKLAD_MAX_DAYS ? n : IDOKLAD_DEFAULT_DAYS
}

// ---------------------------------------------------------------- rozdíly

export const DISCREPANCY_KINDS = ['amount_mismatch', 'payment_mismatch', 'invoice_without_record', 'record_without_invoice'] as const
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number]

export const DISCREPANCY_KIND_LABEL: Record<DiscrepancyKind, string> = {
  amount_mismatch: 'Jiná částka',
  payment_mismatch: 'Jiná úhrada',
  invoice_without_record: 'Faktura bez záznamu',
  record_without_invoice: 'Záznam bez faktury',
}

export const DISCREPANCY_STATUSES = ['open', 'resolved', 'dismissed'] as const
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number]

export const DISCREPANCY_RESOLUTIONS = ['applied', 'dismissed', 'auto'] as const
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number]

export type IdokladDocKind = 'invoice' | 'payment'

export type DiscrepancyDraft = {
  kind: DiscrepancyKind
  reason: string
  idoklad_kind: IdokladDocKind | null
  idoklad_id: number | null
  document_number: string | null
  account_id: number | null
  record_id: number | null
  currency: string | null
  idoklad_amount: number | null
  record_amount: number | null
  fingerprint: string
}

/** Klíč rozdílu — MUSÍ sedět s vygenerovaným sloupcem dedupe_key v migraci 0092. */
export function dedupeKey(d: Pick<DiscrepancyDraft, 'kind' | 'idoklad_kind' | 'idoklad_id' | 'record_id'>): string {
  return `${d.kind}:${d.idoklad_kind ?? '-'}:${d.idoklad_id ?? '-'}:${d.record_id ?? '-'}`
}

export type ExistingDiscrepancy = {
  id: number
  kind: DiscrepancyKind
  status: DiscrepancyStatus
  idoklad_kind: IdokladDocKind | null
  idoklad_id: number | null
  record_id: number | null
  fingerprint: string
  resolution: DiscrepancyResolution | null
}

// ---------------------------------------------------------------- vstupy

export type SyncAccount = { id: number; name: string; ico: string | null }

export type SyncRecord = {
  id: number
  account_id: number
  kind: FinancialKind
  amount: number | string
  currency: Currency
  period_month: string
  status: FinancialStatus
  source: string
  external_ref: string | null
  idoklad_kind: IdokladDocKind | null
  idoklad_id: number | null
  idoklad_due_on: string | null
}

// ---------------------------------------------------------------- výstupy

export type RecordInsert = {
  account_id: number
  kind: 'invoiced' | 'received'
  amount: number
  currency: Currency
  period_month: string
  status: 'confirmed'
  source: 'idoklad'
  external_ref: string
  idoklad_kind: IdokladDocKind
  idoklad_id: number
  idoklad_due_on: string | null
}

export type RecordPatch = {
  id: number
  patch: {
    status?: 'confirmed'
    external_ref?: string
    idoklad_kind?: IdokladDocKind
    idoklad_id?: number
    idoklad_due_on?: string | null
    amount?: number
    currency?: Currency
  }
}

export type SyncStats = {
  invoicesRead: number
  paymentsRead: number
  recordsCreated: number
  recordsLinked: number
  dueDatesUpdated: number
  discrepanciesOpen: number
  discrepanciesReopened: number
  discrepanciesResolvedAuto: number
  conflicts: number
  truncated: boolean
}

export type SyncPlan = {
  inserts: RecordInsert[]
  patches: RecordPatch[]
  discrepancies: DiscrepancyDraft[]
  /** Doklady, které tento běh vyhodnotil (`invoice:12`, `payment:7`) — jen u nich smí rozdíl sám zmizet. */
  evaluatedDocs: Set<string>
  /** Záznamy „vyfakturováno", u kterých zbývá ověřit, že faktura v iDokladu je. */
  verifyCandidates: SyncRecord[]
}

// ---------------------------------------------------------------- pomocné

const round2 = (n: number) => Math.round(n * 100) / 100
/** Rozdíl částek v haléřích (celá čísla — bez plovoucí čárky) nejvýš `tol` haléřů? */
const within = (a: number, b: number, tol: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= tol
const num = (v: number | string) => Number(v)
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** IČO bez mezer a „CZ", doplněné nulami na 8 číslic. */
export function canonicalIco(ico: string): string {
  const clean = ico.replace(/\s/g, '').replace(/^CZ/i, '')
  return /^\d{1,8}$/.test(clean) ? clean.padStart(8, '0') : clean
}

const LEGAL_FORM = /\b(s\s*\.?\s*r\s*\.?\s*o|spol\s*\.?\s*s\s*r\s*\.?\s*o|a\s*\.?\s*s|v\s*\.?\s*o\s*\.?\s*s|k\s*\.?\s*s|z\s*\.?\s*s|se|ltd|gmbh|inc)\b\.?/g

/** Název bez diakritiky, velikosti písmen a právní formy — jen ke srovnání. */
export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(LEGAL_FORM, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
}

export function periodOfDay(day: string): string {
  return `${day.slice(0, 7)}-01`
}

/** Poměr základu bez DPH k částce s DPH (1 u neplátce nebo při chybějících číslech). */
export function netRatio(inv: Pick<IdokladInvoice, 'totalNet' | 'totalGross'>): number {
  return inv.totalGross > 0 && inv.totalNet > 0 ? inv.totalNet / inv.totalGross : 1
}

/** Úhrada přepočtená na základ bez DPH (zaokrouhleno na haléře). */
export function netPaymentAmount(payment: Pick<IdokladPayment, 'amount'>, inv: Pick<IdokladInvoice, 'totalNet' | 'totalGross'>): number {
  return round2(payment.amount * netRatio(inv))
}

/** Sedí částka záznamu se základem faktury (nebo s částkou s DPH)? */
export function amountMatchesInvoice(amount: number | string, inv: Pick<IdokladInvoice, 'totalNet' | 'totalGross'>): boolean {
  const a = num(amount)
  return within(a, inv.totalNet, 1) || within(a, inv.totalGross, 1)
}

function supportedCurrency(c: string | null): c is Currency {
  return c !== null && (SUPPORTED_CURRENCIES as readonly string[]).includes(c)
}

// ---------------------------------------------------------------- firma

export type AccountMatch =
  | { ok: true; account: SyncAccount; how: 'ico' | 'nazev' }
  | { ok: false; reason: string }

export function buildAccountIndex(accounts: readonly SyncAccount[]) {
  const byIco = new Map<string, SyncAccount[]>()
  const byName = new Map<string, SyncAccount[]>()
  for (const a of accounts) {
    if (a.ico) {
      const k = canonicalIco(a.ico)
      byIco.set(k, [...(byIco.get(k) ?? []), a])
    } else {
      const n = normalizeName(a.name)
      if (n) byName.set(n, [...(byName.get(n) ?? []), a])
    }
  }
  return { byIco, byName }
}
export type AccountIndex = ReturnType<typeof buildAccountIndex>

/** Firma k faktuře: IČO (jednoznačně), jinak přesný název u firmy bez IČO. */
export function matchAccount(inv: Pick<IdokladInvoice, 'partnerIco' | 'partnerName'>, idx: AccountIndex): AccountMatch {
  if (inv.partnerIco) {
    const found = idx.byIco.get(canonicalIco(inv.partnerIco)) ?? []
    if (found.length === 1) return { ok: true, account: found[0], how: 'ico' }
    if (found.length > 1) return { ok: false, reason: 'IČO odběratele patří víc firmám v Cockpitu.' }
  }
  if (inv.partnerName) {
    const found = idx.byName.get(normalizeName(inv.partnerName)) ?? []
    if (found.length === 1) return { ok: true, account: found[0], how: 'nazev' }
    if (found.length > 1) return { ok: false, reason: 'Název odběratele odpovídá víc firmám bez IČO.' }
  }
  return {
    ok: false,
    reason: inv.partnerIco
      ? 'Firma s IČO odběratele v Cockpitu není.'
      : 'Odběratel nemá IČO a jeho název v Cockpitu nesedí na žádnou firmu.',
  }
}

// ---------------------------------------------------------------- plán

export type PlanInput = {
  /** Faktury vystavené nebo změněné v okně. */
  invoices: readonly IdokladInvoice[]
  /** Úhrady v okně. */
  payments: readonly IdokladPayment[]
  /** Faktury k úhradám, které nejsou mezi `invoices` (starší); klíč = id faktury. */
  extraInvoices: readonly IdokladInvoice[]
  accounts: readonly SyncAccount[]
  /** Záznamy „vyfakturováno" a „přijato": nezrušené a všechny s odkazem na iDoklad. */
  records: readonly SyncRecord[]
  /** První den okna (YYYY-MM-DD). */
  since: string
  /** Načetly se všechny úhrady okna? Když ne (chyba, ořez), stav úhrad se nehodnotí. */
  paymentsComplete: boolean
}

const draftBase = (): Pick<DiscrepancyDraft, 'currency' | 'idoklad_amount' | 'record_amount' | 'account_id' | 'record_id' | 'document_number' | 'idoklad_kind' | 'idoklad_id'> => ({
  currency: null, idoklad_amount: null, record_amount: null, account_id: null, record_id: null,
  document_number: null, idoklad_kind: null, idoklad_id: null,
})

function invoiceDraft(kind: DiscrepancyKind, inv: IdokladInvoice, reason: string, extra: Partial<DiscrepancyDraft> & { fingerprint: string }): DiscrepancyDraft {
  return {
    ...draftBase(), kind, reason,
    idoklad_kind: 'invoice', idoklad_id: inv.id, document_number: inv.documentNumber,
    currency: inv.currency, idoklad_amount: inv.totalNet,
    ...extra,
  }
}

/** Kdo se hlásí k číslu dokladu: external_ref shodný s číslem dokladu nebo variabilním symbolem. */
function refMatches(rec: Pick<SyncRecord, 'external_ref'>, inv: Pick<IdokladInvoice, 'documentNumber' | 'variableSymbol'>): boolean {
  if (!rec.external_ref) return false
  const r = norm(rec.external_ref)
  return r === norm(inv.documentNumber) || (inv.variableSymbol !== null && r === norm(inv.variableSymbol))
}

export function planSync(input: PlanInput): SyncPlan {
  const idx = buildAccountIndex(input.accounts)
  const inserts: RecordInsert[] = []
  const patches: RecordPatch[] = []
  const discrepancies: DiscrepancyDraft[] = []
  const evaluatedDocs = new Set<string>()
  const matchedRecordIds = new Set<number>()

  const byDoc = new Map<string, SyncRecord>()
  for (const r of input.records) if (r.idoklad_kind && r.idoklad_id) byDoc.set(`${r.idoklad_kind}:${r.idoklad_id}`, r)
  const live = input.records.filter((r) => r.status !== 'cancelled')
  const openInvoiced = live.filter((r) => r.kind === 'invoiced' && !r.idoklad_id)
  const openReceived = live.filter((r) => r.kind === 'received' && !r.idoklad_id)

  // Jedna faktura → nejvýš jeden záznam; druhá stejné číslo/firma už nedostane totéž.
  const claimed = new Set<number>()
  const pushPatch = (id: number, patch: RecordPatch['patch']) => patches.push({ id, patch })

  const invoiceById = new Map<number, IdokladInvoice>()
  for (const i of [...input.extraInvoices, ...input.invoices]) invoiceById.set(i.id, i)

  // ---- faktury -------------------------------------------------------------
  for (const inv of input.invoices) {
    evaluatedDocs.add(`invoice:${inv.id}`)
    const linked = byDoc.get(`invoice:${inv.id}`)
    if (linked) {
      matchedRecordIds.add(linked.id)
      if (linked.status === 'cancelled') continue // zrušil člověk — nevracíme
      if (linked.idoklad_due_on !== inv.dueOn) pushPatch(linked.id, { idoklad_due_on: inv.dueOn })
      if (!(linked.currency === inv.currency && amountMatchesInvoice(linked.amount, inv))) {
        discrepancies.push(invoiceDraft('amount_mismatch', inv,
          `Faktura ${inv.documentNumber} má v iDokladu jinou částku nebo měnu než záznam v Cockpitu.`, {
            account_id: linked.account_id, record_id: linked.id, record_amount: num(linked.amount),
            fingerprint: `${inv.totalNet}|${inv.totalGross}|${inv.currency}|${num(linked.amount)}|${linked.currency}`,
          }))
      }
      continue
    }

    const account = matchAccount(inv, idx)
    const byRef = openInvoiced.filter((r) => !claimed.has(r.id) && refMatches(r, inv))

    if (byRef.length > 1) {
      discrepancies.push(invoiceDraft('invoice_without_record', inv,
        `Číslu dokladu ${inv.documentNumber} odpovídá víc záznamů v Cockpitu, nejde vybrat ten správný.`,
        { account_id: account.ok ? account.account.id : null, fingerprint: `ref-multi|${byRef.map((r) => r.id).join(',')}` }))
      continue
    }
    if (byRef.length === 1) {
      const rec = byRef[0]
      if (account.ok && account.account.id !== rec.account_id) {
        discrepancies.push(invoiceDraft('invoice_without_record', inv,
          `Číslo dokladu ${inv.documentNumber} sedí se záznamem u jiné firmy, než je odběratel faktury.`,
          { account_id: rec.account_id, record_id: rec.id, record_amount: num(rec.amount), fingerprint: `ref-account|${rec.account_id}|${account.account.id}` }))
        continue
      }
      if (rec.currency === inv.currency && amountMatchesInvoice(rec.amount, inv)) {
        claimed.add(rec.id)
        matchedRecordIds.add(rec.id)
        pushPatch(rec.id, linkPatch(rec, inv))
      } else {
        discrepancies.push(invoiceDraft('amount_mismatch', inv,
          `Faktura ${inv.documentNumber} má v iDokladu jinou částku nebo měnu než záznam v Cockpitu.`, {
            account_id: rec.account_id, record_id: rec.id, record_amount: num(rec.amount),
            fingerprint: `${inv.totalNet}|${inv.totalGross}|${inv.currency}|${num(rec.amount)}|${rec.currency}`,
          }))
      }
      continue
    }

    // Bez shody podle čísla: firma → podklad k fakturaci, jinak nový záznam.
    if (!account.ok) {
      discrepancies.push(invoiceDraft('invoice_without_record', inv, `${account.reason} Fakturu ${inv.documentNumber} je potřeba přiřadit ručně.`,
        { fingerprint: `no-account|${inv.partnerIco ?? ''}|${inv.partnerName ?? ''}` }))
      continue
    }
    if (!supportedCurrency(inv.currency)) {
      discrepancies.push(invoiceDraft('invoice_without_record', inv,
        `Faktura ${inv.documentNumber} je v měně ${inv.currency ?? 'neznámé'}, kterou Cockpit u finančních záznamů nepodporuje (jen CZK a EUR).`,
        { account_id: account.account.id, fingerprint: `currency|${inv.currency ?? ''}` }))
      continue
    }
    const cur = inv.currency
    const drafts = openInvoiced.filter((r) => r.account_id === account.account.id && r.status === 'draft' && !r.external_ref && !claimed.has(r.id))
    const exact = drafts.filter((r) => r.currency === cur && amountMatchesInvoice(r.amount, inv))
    if (exact.length === 1) {
      claimed.add(exact[0].id)
      matchedRecordIds.add(exact[0].id)
      pushPatch(exact[0].id, linkPatch(exact[0], inv))
    } else if (exact.length > 1) {
      discrepancies.push(invoiceDraft('invoice_without_record', inv,
        `Firma má víc podkladů k fakturaci se stejnou částkou, faktura ${inv.documentNumber} nejde přiřadit jednoznačně.`,
        { account_id: account.account.id, fingerprint: `draft-multi|${exact.map((r) => r.id).join(',')}` }))
    } else if (drafts.length === 1) {
      discrepancies.push(invoiceDraft('amount_mismatch', inv,
        `Faktura ${inv.documentNumber} nejspíš patří k podkladu k fakturaci u téže firmy, ale částka se liší.`, {
          account_id: account.account.id, record_id: drafts[0].id, record_amount: num(drafts[0].amount),
          fingerprint: `${inv.totalNet}|${inv.totalGross}|${inv.currency}|${num(drafts[0].amount)}|${drafts[0].currency}`,
        }))
    } else if (drafts.length > 1) {
      discrepancies.push(invoiceDraft('invoice_without_record', inv,
        `Firma má víc otevřených podkladů k fakturaci s jinou částkou, faktura ${inv.documentNumber} nejde přiřadit jednoznačně.`,
        { account_id: account.account.id, fingerprint: `draft-many|${drafts.map((r) => r.id).join(',')}` }))
    } else if (inv.totalNet > 0) {
      inserts.push(newRecordFromInvoice(account.account.id, inv, cur))
    }
  }

  // ---- úhrady --------------------------------------------------------------
  const paymentsByInvoice = new Map<number, IdokladPayment[]>()
  for (const p of input.payments) {
    evaluatedDocs.add(`payment:${p.id}`)
    paymentsByInvoice.set(p.invoiceId, [...(paymentsByInvoice.get(p.invoiceId) ?? []), p])
  }
  const cockpitReceivedByInvoice = new Map<number, number>()
  const addCockpit = (invoiceId: number, amount: number) =>
    cockpitReceivedByInvoice.set(invoiceId, round2((cockpitReceivedByInvoice.get(invoiceId) ?? 0) + amount))

  for (const [invoiceId, payments] of paymentsByInvoice) {
    const inv = invoiceById.get(invoiceId)
    if (!inv) continue // faktura se nenačetla — úhradu nejde přiřadit; příští běh to zkusí znovu
    evaluatedDocs.add(`invoice:${inv.id}`)
    const account = matchAccount(inv, idx)
    const manual = openReceived.filter((r) => !claimed.has(r.id) && refMatches(r, inv))
    let manualLeft = [...manual]
    const toCreate: IdokladPayment[] = []

    for (const p of payments) {
      const linked = byDoc.get(`payment:${p.id}`)
      if (linked) {
        matchedRecordIds.add(linked.id)
        if (linked.status !== 'cancelled') addCockpit(inv.id, num(linked.amount))
        continue
      }
      const net = netPaymentAmount(p, inv)
      // Ruční záznam „přijato" k téže faktuře se stejnou částkou = ta samá úhrada.
      const hit = manualLeft.filter((r) => r.currency === inv.currency
        && (within(num(r.amount), net, 5) || within(num(r.amount), p.amount, 1)))
      if (hit.length >= 1 && (!account.ok || hit[0].account_id === account.account.id)) {
        const rec = hit[0]
        manualLeft = manualLeft.filter((r) => r.id !== rec.id)
        claimed.add(rec.id)
        matchedRecordIds.add(rec.id)
        pushPatch(rec.id, {
          ...(rec.status === 'draft' ? { status: 'confirmed' as const } : {}),
          idoklad_kind: 'payment', idoklad_id: p.id,
        })
        addCockpit(inv.id, num(rec.amount))
      } else {
        toCreate.push(p)
      }
    }

    if (toCreate.length === 0) continue
    if (manualLeft.length > 0) {
      // Ručně zapsaná úhrada, která nesedí na žádnou úhradu v iDokladu: nezdvojovat.
      discrepancies.push({
        ...draftBase(), kind: 'payment_mismatch',
        reason: `K faktuře ${inv.documentNumber} je v Cockpitu ručně zapsaná úhrada, která nesedí s úhradami v iDokladu. Nové úhrady se nezapsaly, aby se nezdvojily.`,
        idoklad_kind: 'invoice', idoklad_id: inv.id, document_number: inv.documentNumber,
        account_id: manualLeft[0].account_id, record_id: manualLeft[0].id, currency: inv.currency,
        idoklad_amount: round2(inv.totalPaid * netRatio(inv)), record_amount: num(manualLeft[0].amount),
        fingerprint: `manual-payment|${manualLeft.map((r) => `${r.id}:${num(r.amount)}`).join(',')}|${toCreate.map((p) => p.id).join(',')}`,
      })
      continue
    }
    if (!account.ok || !supportedCurrency(inv.currency)) {
      discrepancies.push({
        ...draftBase(), kind: 'payment_mismatch',
        reason: !account.ok
          ? `Úhradu faktury ${inv.documentNumber} nejde zapsat: ${account.reason}`
          : `Úhrada faktury ${inv.documentNumber} je v měně ${inv.currency ?? 'neznámé'}, kterou Cockpit u finančních záznamů nepodporuje.`,
        idoklad_kind: 'invoice', idoklad_id: inv.id, document_number: inv.documentNumber,
        currency: inv.currency, idoklad_amount: round2(inv.totalPaid * netRatio(inv)),
        fingerprint: `pay-skip|${account.ok ? 'currency' : 'account'}|${toCreate.map((p) => p.id).join(',')}`,
      })
      continue
    }
    for (const p of toCreate) {
      const net = netPaymentAmount(p, inv)
      if (net <= 0) continue
      inserts.push({
        account_id: account.account.id, kind: 'received', amount: net, currency: inv.currency,
        period_month: periodOfDay(p.paidOn), status: 'confirmed', source: 'idoklad',
        external_ref: inv.documentNumber, idoklad_kind: 'payment', idoklad_id: p.id, idoklad_due_on: null,
      })
      addCockpit(inv.id, net)
    }
  }

  // ---- stav úhrady: součet „přijato" × zaplaceno v iDokladu ------------------
  // Jen u faktur vystavených v okně: všechny jejich úhrady jsou po vystavení,
  // tedy v načteném okně. U starších faktur by chyběly úhrady před oknem.
  for (const inv of input.paymentsComplete ? input.invoices : []) {
    if (inv.issuedOn < input.since) continue
    const account = matchAccount(inv, idx)
    if (!account.ok || !supportedCurrency(inv.currency)) continue
    const already = discrepancies.some((d) => d.idoklad_kind === 'invoice' && d.idoklad_id === inv.id && d.kind === 'payment_mismatch')
    if (already) continue
    const unlinkedManual = openReceived.filter((r) => !claimed.has(r.id) && refMatches(r, inv))
    const manualSum = round2(unlinkedManual.reduce((s, r) => s + num(r.amount), 0))
    const cockpit = round2((cockpitReceivedByInvoice.get(inv.id) ?? 0) + manualSum)
    const paidNet = round2(inv.totalPaid * netRatio(inv))
    const okNet = within(cockpit, paidNet, 5)
    const okGross = within(cockpit, inv.totalPaid, 5)
    if (okNet || okGross) continue
    // Nezaplacená faktura bez jakékoli úhrady na obou stranách rozdíl nemá.
    if (cockpit === 0 && inv.totalPaid === 0) continue
    discrepancies.push({
      ...draftBase(), kind: 'payment_mismatch',
      reason: inv.totalPaid === 0
        ? `Faktura ${inv.documentNumber} je v iDokladu neuhrazená, v Cockpitu je u ní zapsaná úhrada.`
        : `Úhrady faktury ${inv.documentNumber} v Cockpitu a v iDokladu se liší (stav v iDokladu: ${paymentStatusLabel(inv.paymentStatus)}).`,
      idoklad_kind: 'invoice', idoklad_id: inv.id, document_number: inv.documentNumber,
      account_id: account.account.id, currency: inv.currency, idoklad_amount: paidNet, record_amount: cockpit,
      fingerprint: `paid|${paidNet}|${cockpit}|${inv.paymentStatus}`,
    })
  }

  // ---- záznam bez faktury: kandidáti k ověření -------------------------------
  const windowStart = firstOfNextMonth(input.since)
  const inWindowRefs = input.invoices
  const verifyCandidates = live.filter((r) => {
    if (r.kind !== 'invoiced' || r.status !== 'confirmed' || matchedRecordIds.has(r.id) || claimed.has(r.id)) return false
    if (r.period_month < windowStart) return false // hraniční měsíc okna se nehodnotí
    if (r.idoklad_kind === 'invoice') return !input.invoices.some((i) => i.id === r.idoklad_id)
    if (r.source === 'nabidka' || r.source === 'milnik' || !r.external_ref) return false
    return !inWindowRefs.some((i) => refMatches(r, i))
  })
  for (const r of verifyCandidates) evaluatedDocs.add(`record:${r.id}`)
  for (const r of live) if (r.kind === 'invoiced' && matchedRecordIds.has(r.id)) evaluatedDocs.add(`record:${r.id}`)

  return { inserts, patches, discrepancies, evaluatedDocs, verifyCandidates }
}

/** Nový potvrzený záznam „vyfakturováno“ z faktury (základ bez DPH, splatnost z iDokladu). */
export function newRecordFromInvoice(accountId: number, inv: IdokladInvoice, currency: Currency): RecordInsert {
  return {
    account_id: accountId, kind: 'invoiced', amount: inv.totalNet, currency,
    period_month: periodOfDay(inv.issuedOn), status: 'confirmed', source: 'idoklad',
    external_ref: inv.documentNumber, idoklad_kind: 'invoice', idoklad_id: inv.id, idoklad_due_on: inv.dueOn,
  }
}

/**
 * Úprava záznamu, který člověk v „Rozdílech k vyřešení“ převzal z iDokladu:
 * částka a měna podle faktury, doklad a splatnost, návrh se potvrdí. Číslo
 * dokladu se doplní jen když chybí (ruční zápis podle VS si své drží).
 */
export function invoiceApplyPatch(rec: Pick<SyncRecord, 'status' | 'external_ref' | 'idoklad_id'>, inv: IdokladInvoice, currency: Currency): RecordPatch['patch'] {
  return {
    amount: inv.totalNet,
    currency,
    ...(rec.status === 'draft' ? { status: 'confirmed' as const } : {}),
    ...(rec.external_ref ? {} : { external_ref: inv.documentNumber }),
    idoklad_kind: 'invoice',
    idoklad_id: inv.id,
    idoklad_due_on: inv.dueOn,
  }
}

function linkPatch(rec: SyncRecord, inv: IdokladInvoice): RecordPatch['patch'] {
  return {
    ...(rec.status === 'draft' ? { status: 'confirmed' as const } : {}),
    ...(rec.external_ref ? {} : { external_ref: inv.documentNumber }),
    idoklad_kind: 'invoice',
    idoklad_id: inv.id,
    idoklad_due_on: inv.dueOn,
  }
}

export function paymentStatusLabel(s: IdokladInvoice['paymentStatus']): string {
  return { unpaid: 'neuhrazeno', paid: 'uhrazeno', partial: 'částečně uhrazeno', overpaid: 'přeplaceno', unknown: 'neznámý' }[s]
}

/** První den měsíce po datu (YYYY-MM-DD → YYYY-MM-01 následujícího měsíce). */
export function firstOfNextMonth(day: string): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  const idx = y * 12 + (m - 1) + 1
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`
}

/** Rozdíl „záznam bez faktury" pro záznam, jehož fakturu se v iDokladu nepodařilo najít. */
export function recordWithoutInvoiceDraft(rec: SyncRecord): DiscrepancyDraft {
  return {
    ...draftBase(), kind: 'record_without_invoice',
    reason: `Potvrzený záznam „vyfakturováno“ s dokladem ${rec.external_ref ?? `č. ${rec.id}`} nemá v iDokladu odpovídající vydanou fakturu.`,
    document_number: rec.external_ref, account_id: rec.account_id, record_id: rec.id, currency: rec.currency,
    record_amount: num(rec.amount), fingerprint: `no-invoice|${num(rec.amount)}|${rec.currency}|${rec.external_ref ?? ''}`,
  }
}

// ---------------------------------------------------------------- fronta

export type QueueOps = {
  inserts: DiscrepancyDraft[]
  /** Otevřený rozdíl viděn znovu (aktualizace), nebo znovu otevřený uzavřený. */
  updates: { id: number; draft: DiscrepancyDraft; reopen: boolean }[]
  /** Rozdíl sám zmizel: id k uzavření s rozhodnutím „auto". */
  autoResolve: number[]
}

/**
 * Srovná nově zjištěné rozdíly s frontou. Odložený rozdíl se stejným otiskem
 * se nevrací; uzavřený s jiným otiskem (nebo vyřešený, který se objevil znovu)
 * se otevře znovu. Otevřený rozdíl, jehož doklad tento běh vyhodnotil a už
 * ho nehlásí, se uzavře sám. Rozdíly dokladů mimo okno se nedotknou.
 */
export function reconcileQueue(
  existing: readonly ExistingDiscrepancy[],
  drafts: readonly DiscrepancyDraft[],
  evaluatedDocs: ReadonlySet<string>,
  /** Druhy, které tento běh nevyhodnotil (např. úhrady se nenačetly) — sám nezmizí. */
  skipKinds: readonly DiscrepancyKind[] = [],
): QueueOps {
  const byKey = new Map(existing.map((e) => [dedupeKey(e), e]))
  const seen = new Set<string>()
  const ops: QueueOps = { inserts: [], updates: [], autoResolve: [] }
  for (const d of drafts) {
    const key = dedupeKey(d)
    if (seen.has(key)) continue
    seen.add(key)
    const e = byKey.get(key)
    if (!e) ops.inserts.push(d)
    else if (e.status === 'open') ops.updates.push({ id: e.id, draft: d, reopen: false })
    else if (e.status === 'dismissed' && e.fingerprint === d.fingerprint) continue
    else ops.updates.push({ id: e.id, draft: d, reopen: true })
  }
  for (const e of existing) {
    if (e.status !== 'open' || seen.has(dedupeKey(e)) || skipKinds.includes(e.kind)) continue
    const subject = e.idoklad_kind && e.idoklad_id ? `${e.idoklad_kind}:${e.idoklad_id}` : e.record_id ? `record:${e.record_id}` : null
    if (subject && evaluatedDocs.has(subject)) ops.autoResolve.push(e.id)
  }
  return ops
}
