'use client'
import { useRouter } from 'next/navigation'
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import { ImportReviewTable, type RowPatch } from '@/components/ImportReviewTable'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { CrossIcon } from '@/components/ui/Icons'
import { useUndoToast } from '@/components/ui/Toast'
import {
  confirmImportRow, openImportBatch, previewCsvImport, proposePdfImport, rejectPdfProposal, revertImportBatch,
} from '@/domain/crm/actions/bulkImport'
import {
  BULK_MAX_CSV_BYTES, BULK_MAX_CSV_ROWS, BULK_MAX_PDF_BYTES, BULK_MAX_PDFS, CSV_COLUMNS, type ImportMember,
} from '@/domain/crm/bulkImport'
import {
  isBulkConfirmable, isConfirmable, rowFromCsv, rowFromProposal, tally, toApplyInput, type ReviewRow,
} from '@/domain/crm/bulkImportReview'

// Hromadný import běžících zakázek: dva zdroje (víc PDF, tabulka CSV) a jedna
// kontrolní fronta „K potvrzení“. Postup: nahraj → zkontroluj → potvrď. Nic se
// nezaloží dřív, než člověk řádek potvrdí; zápis jednoho řádku je jedna
// transakce v databázi. Bez klíče ke službě Anthropic je část s PDF skrytá
// (vysvětluje proč) a tabulka funguje dál.

type Source = 'csv' | 'pdf'
type Failure = { fileName: string; error: string }

const MB = 1024 * 1024

export function BulkImport({ pdfEnabled, members, meId, isAdmin = false }: {
  pdfEnabled: boolean
  members: ImportMember[]
  meId: string
  /** Správce vidí i technický důvod (chybějící klíč); ostatní lidskou větu. */
  isAdmin?: boolean
}) {
  const router = useRouter()
  const toast = useUndoToast()
  const [source, setSource] = useState<Source>('csv')
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [failures, setFailures] = useState<Failure[]>([])
  const [ignored, setIgnored] = useState<string[]>([])
  const [csvError, setCsvError] = useState<string | null>(null)
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null)
  const [confirming, setConfirming] = useState<{ done: number; total: number } | null>(null)
  const [checking, setChecking] = useState(false)
  const batchRef = useRef<{ id: number; source: Source } | null>(null)
  const rowsRef = useRef<ReviewRow[]>([])
  const busy = reading !== null || confirming !== null || checking

  const setAll = useCallback((next: ReviewRow[] | ((prev: ReviewRow[]) => ReviewRow[])) => {
    setRows((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      rowsRef.current = value
      return value
    })
  }, [])
  const patch = useCallback((id: string, p: RowPatch) => {
    setAll((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)))
  }, [setAll])

  const counts = useMemo(() => tally(rows), [rows])

  function resetQueue(nextSource: Source) {
    setAll([])
    setFailures([])
    setIgnored([])
    setCsvError(null)
    batchRef.current = null
    setSource(nextSource)
  }

  // ------------------------------------------------------------ zdroj B: CSV
  const csvInput = useRef<HTMLInputElement>(null)
  const [csvName, setCsvName] = useState<string | null>(null)

  async function checkCsv() {
    const file = csvInput.current?.files?.[0]
    if (!file) { setCsvError('Vyber soubor CSV.'); return }
    if (file.size > BULK_MAX_CSV_BYTES) { setCsvError(`Soubor je moc velký (nejvýš ${BULK_MAX_CSV_BYTES / MB} MB).`); return }
    setChecking(true)
    setCsvError(null)
    setFailures([])
    batchRef.current = null
    const fd = new FormData()
    fd.set('csv', file)
    let res: Awaited<ReturnType<typeof previewCsvImport>>
    try {
      res = await previewCsvImport(fd)
    } catch {
      res = { ok: false, error: 'Spojení selhalo. Zkus to znovu.' }
    }
    setChecking(false)
    if (!res.ok) { setCsvError(res.error); setAll([]); return }
    setIgnored(res.ignoredColumns)
    setAll(res.rows.map(rowFromCsv))
  }

  // ------------------------------------------------------------ zdroj A: PDF
  const pdfInput = useRef<HTMLInputElement>(null)
  const [pdfFiles, setPdfFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  function takeFiles(list: FileList | File[]) {
    const incoming = Array.from(list)
    const pdfs = incoming.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
    const problems: string[] = []
    if (pdfs.length < incoming.length) problems.push(`${incoming.length - pdfs.length} souborů není PDF a vynechalo se.`)
    const small = pdfs.filter((f) => f.size <= BULK_MAX_PDF_BYTES)
    if (small.length < pdfs.length) problems.push(`${pdfs.length - small.length} PDF je větších než ${BULK_MAX_PDF_BYTES / MB} MB a vynechalo se.`)
    const merged = [...pdfFiles, ...small.filter((f) => !pdfFiles.some((p) => p.name === f.name && p.size === f.size))]
    if (merged.length > BULK_MAX_PDFS) problems.push(`Najednou jde nejvýš ${BULK_MAX_PDFS} PDF, ostatní se vynechala.`)
    setPdfFiles(merged.slice(0, BULK_MAX_PDFS))
    setPdfError(problems.length > 0 ? problems.join(' ') : null)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    takeFiles(e.dataTransfer.files)
  }

  async function readPdfs() {
    const files = pdfFiles
    if (files.length === 0) return
    setFailures([])
    setPdfFiles([])
    batchRef.current = null
    setReading({ done: 0, total: files.length })
    const failed: Failure[] = []
    for (let i = 0; i < files.length; i++) {
      const fd = new FormData()
      fd.set('pdf', files[i])
      let res: Awaited<ReturnType<typeof proposePdfImport>>
      try {
        res = await proposePdfImport(fd)
      } catch {
        res = { ok: false, fileName: files[i].name, error: 'Spojení selhalo. Zkus to znovu.' }
      }
      if (res.ok) {
        const row = rowFromProposal(res.proposal)
        setAll((prev) => [...prev, row])
      } else {
        failed.push({ fileName: res.fileName || files[i].name, error: res.error })
        setFailures([...failed])
        // Bez klíče, migrace nebo po vyčerpání denního limitu čtení PDF nemá smysl pokračovat.
        if (res.code === 'no_key' || res.code === 'unavailable' || res.code === 'quota') break
      }
      setReading({ done: i + 1, total: files.length })
    }
    setReading(null)
  }

  // ------------------------------------------------------------ potvrzení
  // „Potvrdit vše“ zapisuje do VLASTNÍ nové dávky, aby tlačítko Zpět v hlášce vrátilo
  // jen to, co právě proběhlo. Potvrzení po jednom sdílí jednu dávku (bez tlačítka Zpět:
  // vrátit jde v historii pod tabulkou), ať se z nich nedělá třicet dávek.
  async function batchFor(fresh: boolean): Promise<number | null> {
    const existing = batchRef.current
    if (!fresh && existing && existing.source === source) return existing.id
    const label = source === 'csv' ? (csvName ?? 'tabulka') : `PDF nabídky (${rowsRef.current.filter((r) => r.source === 'pdf').length})`
    const res = await openImportBatch(source, label)
    if (!res.ok) return null
    if (!fresh) batchRef.current = { id: res.batchId, source }
    return res.batchId
  }

  async function confirmRows(ids: string[], fresh: boolean): Promise<{ ok: number; failed: number; batchId: number | null; okIds: string[] }> {
    const batchId = await batchFor(fresh)
    if (batchId === null) {
      ids.forEach((id) => patch(id, { state: 'error', message: 'Dávku importu se nepodařilo otevřít. Zkus to znovu.' }))
      return { ok: 0, failed: ids.length, batchId: null, okIds: [] }
    }
    let ok = 0
    let failed = 0
    const okIds: string[] = []
    setConfirming({ done: 0, total: ids.length })
    for (let i = 0; i < ids.length; i++) {
      const row = rowsRef.current.find((r) => r.id === ids[i])
      if (!row) continue
      patch(row.id, { state: 'saving', message: null })
      let res: Awaited<ReturnType<typeof confirmImportRow>>
      try {
        res = await confirmImportRow(toApplyInput(row, batchId))
      } catch {
        res = { ok: false, error: 'Spojení selhalo. Zkontroluj, jestli zakázka vznikla, a zkus to znovu.' }
      }
      if (res.ok) {
        ok++
        okIds.push(row.id)
        const extra = [
          res.duplicate ? 'Stejná zakázka už v Cockpitu byla, nic se nezaložilo podruhé.' : null,
          res.accountCreated ? 'Založen nový klient.' : null,
          res.records > 0 ? `Finanční záznamy: ${res.records}.` : null,
          ...res.warnings,
        ].filter(Boolean).join(' ')
        patch(row.id, { state: 'done', message: extra || null, result: { dealId: res.dealId, accountId: res.accountId } })
      } else {
        failed++
        patch(row.id, { state: 'error', message: res.error })
      }
      setConfirming({ done: i + 1, total: ids.length })
    }
    setConfirming(null)
    return { ok, failed, batchId, okIds }
  }

  function finish(result: { ok: number; failed: number; batchId: number | null; okIds: string[] }, withUndo: boolean) {
    router.refresh()
    if (result.ok === 0) return
    const batchId = result.batchId
    const doneIds = new Set(result.okIds)
    toast.show({
      message: result.failed > 0
        ? `Zapsáno ${result.ok}, ${result.failed} se nepovedlo.`
        : result.ok === 1 ? 'Zakázka je zapsaná.' : `Zapsáno ${result.ok} zakázek.`,
      duration: 10_000,
      undo: withUndo && batchId
        ? async () => {
          const res = await revertImportBatch(batchId)
          if (!res.ok) throw new Error(res.error)
          router.refresh()
          toast.show({ message: res.message })
          setAll((prev) => prev.map((r) => (doneIds.has(r.id) && r.state === 'done'
            ? { ...r, state: 'rejected', message: 'Import vrácen.', result: null }
            : r)))
        }
        : undefined,
    })
  }

  async function confirmAll() {
    const ids = rowsRef.current.filter(isBulkConfirmable).map((r) => r.id)
    if (ids.length === 0) return
    finish(await confirmRows(ids, true), true)
  }

  async function confirmOne(id: string) {
    const row = rowsRef.current.find((r) => r.id === id)
    if (!row || !isConfirmable(row)) return
    finish(await confirmRows([id], false), false)
  }

  async function reject(id: string) {
    const row = rowsRef.current.find((r) => r.id === id)
    if (!row) return
    if (row.source === 'pdf' && row.proposalId) {
      patch(id, { state: 'saving', message: null })
      const res = await rejectPdfProposal(row.proposalId)
      if (!res.ok) { patch(id, { state: 'error', message: res.error ?? 'Zamítnutí se nepovedlo.' }); return }
      patch(id, { state: 'rejected', message: 'PDF i návrh jsou smazané.' })
    } else {
      patch(id, { state: 'rejected', message: null })
    }
  }

  async function rejectRest() {
    const ids = rowsRef.current.filter((r) => r.state === 'pending' || r.state === 'error').map((r) => r.id)
    for (const id of ids) await reject(id)
  }

  const showQueue = rows.length > 0

  return (
    <div className="space-y-6">
      <Card
        title="1. Odkud zakázky nahrát"
        sub="Tabulka je nejrychlejší, když máš zakázky v Excelu. PDF nabídky přečte umělá inteligence a navrhne údaje."
      >
        <div className="seg mb-5" role="group" aria-label="Zdroj zakázek">
          <button type="button" className="seg-item" aria-pressed={source === 'csv'} disabled={busy} onClick={() => resetQueue('csv')}>
            Tabulka (CSV)
          </button>
          <button type="button" className="seg-item" aria-pressed={source === 'pdf'} disabled={busy} onClick={() => resetQueue('pdf')}>
            Více PDF nabídek
          </button>
        </div>

        {source === 'csv' && (
          <div className="space-y-4">
            <div className="text-callout text-muted">
              <p className="m-0">
                V Excelu zvol <b className="text-ink">Soubor, Uložit jako, CSV UTF-8</b>. Sloupce:{' '}
                {CSV_COLUMNS.filter((c) => c.required).map((c) => c.header).join(', ')} (povinné);{' '}
                {CSV_COLUMNS.filter((c) => !c.required).map((c) => c.header).join(', ')} (nepovinné).
              </p>
              <p className="m-0 mt-2">
                <a href="/cockpit/import/zakazky/sablona" className="font-semibold underline" download>Stáhnout šablonu CSV</a>
                {' '}(nejvýš {BULK_MAX_CSV_ROWS} řádků najednou).
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block text-callout font-semibold text-[color:#39414D]">Soubor CSV
                <input
                  ref={csvInput} type="file" accept=".csv,text/csv,text/plain" disabled={busy}
                  onChange={(e) => { setCsvName(e.target.files?.[0]?.name.slice(0, 120) ?? null); setCsvError(null) }}
                />
              </label>
              <Button variant="outline" onClick={checkCsv} disabled={busy}>{checking ? 'Kontroluji…' : 'Zkontrolovat tabulku'}</Button>
            </div>
            {csvError && <p role="alert" className="m-0 text-callout text-neg">{csvError}</p>}
            {ignored.length > 0 && (
              <p className="m-0 text-footnote text-muted">Sloupce, které Cockpit nezná a nepoužil: {ignored.join(', ')}.</p>
            )}
          </div>
        )}

        {source === 'pdf' && !pdfEnabled && (
          <EmptyState title="Čtení PDF není zapnuté" compact>
            {isAdmin
              ? 'Chybí klíč ke službě Anthropic (ANTHROPIC_API_KEY). Bez něj Cockpit PDF přečíst neumí.'
              : 'Čtení PDF zatím není zapnuté. Zapnout ho může správce týmu.'}{' '}
            Zakázky nahraj přes tabulku CSV, ta funguje dál.
          </EmptyState>
        )}

        {source === 'pdf' && pdfEnabled && (
          <div className="space-y-4">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => pdfInput.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pdfInput.current?.click() } }}
              role="button"
              tabIndex={0}
              aria-label="Vybrat PDF nabídky"
              className={`cursor-pointer rounded-[14px] border-2 border-dashed px-4 py-8 text-center text-callout transition-colors ${
                dragOver ? 'border-[color:var(--c-accent)] bg-[color:var(--c-accent-soft)]' : 'border-border text-muted'
              }`}
            >
              {pdfFiles.length > 0 ? (
                <ul className="m-0 list-none space-y-1 p-0 text-ink">{pdfFiles.map((f) => <li key={`${f.name}-${f.size}`}>{f.name}</li>)}</ul>
              ) : (
                <>Přetáhni sem PDF nabídek (až {BULK_MAX_PDFS}, každé do {BULK_MAX_PDF_BYTES / MB} MB), nebo klikni pro výběr</>
              )}
            </div>
            <input
              ref={pdfInput} type="file" accept="application/pdf" multiple className="hidden"
              onChange={(e) => { if (e.target.files) takeFiles(e.target.files); e.target.value = '' }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={readPdfs} disabled={busy || pdfFiles.length === 0}>
                {reading ? 'Čtu nabídky…' : pdfFiles.length > 0 ? `Přečíst ${pdfFiles.length} PDF` : 'Přečíst PDF'}
              </Button>
              {pdfFiles.length > 0 && !busy && <Button variant="quiet" onClick={() => setPdfFiles([])}>Vyprázdnit výběr</Button>}
              <span className="text-footnote text-muted">Každé PDF trvá řádově desítky sekund. Nic se nezaloží, dokud nepotvrdíš.</span>
            </div>
            {pdfError && <p role="alert" className="m-0 text-callout text-neg">{pdfError}</p>}
          </div>
        )}

        <div aria-live="polite" className="mt-4">
          {reading && <p role="status" className="m-0 text-callout text-muted">Přečteno {reading.done} z {reading.total}…</p>}
          {failures.length > 0 && (
            <ul aria-label="Soubory, které se nepodařilo přečíst" className="m-0 mt-2 list-none space-y-2 p-0">
              {failures.map((f) => (
                <li key={f.fileName} className="rounded-btn border border-border p-3 text-callout">
                  <CrossIcon className="mr-0.5 inline-block align-[-3px] text-neg" /><span className="sr-only">Chyba:</span> <b>{f.fileName}</b>: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {showQueue && (
        <Card
          title="2. K potvrzení"
          sub="Zkontroluj klienta, cenu a stav. Nic se nezaloží, dokud řádek nepotvrdíš. Klienta, který v Cockpitu není, založíš jen výslovným tlačítkem."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="quiet" onClick={rejectRest} disabled={busy || counts.pending + counts.error === 0}>Zamítnout zbylé</Button>
              <Button variant="primary" onClick={confirmAll} disabled={busy || counts.ready === 0}>
                {confirming ? `Zapisuji ${confirming.done}/${confirming.total}…` : `Potvrdit vše (${counts.ready})`}
              </Button>
            </div>
          }
        >
          <p role="status" className="m-0 mb-4 text-callout text-muted">
            K potvrzení {counts.pending}, z toho připraveno {counts.ready}
            {counts.blocked > 0 && `, čeká na tebe ${counts.blocked}`}. Zapsáno {counts.done}
            {counts.error > 0 && `, s chybou ${counts.error}`}
            {counts.rejected > 0 && `, zamítnuto ${counts.rejected}`}.
            {counts.blocked > 0 && ' „Potvrdit vše“ zapíše jen připravené řádky, ostatní potvrď jednotlivě.'}
          </p>
          <ImportReviewTable
            rows={rows} members={members} meId={meId} busy={busy}
            onPatch={patch} onConfirm={confirmOne} onReject={reject}
          />
        </Card>
      )}
    </div>
  )
}
