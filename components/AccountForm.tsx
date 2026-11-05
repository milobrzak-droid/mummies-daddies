'use client'
import { useActionState, useState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { buttonClass } from '@/components/ui/Button'
import type { ActionResult } from '@/lib/actionResult'
import type { Account, Partner, TeamMember } from '@/lib/types'
import type { AresCompany } from '@/connectors/ares'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

export function AccountForm({
  action, initial, partners = [], members = [],
}: { action: Action; initial?: Account; partners?: Partner[]; members?: TeamMember[] }) {
  const [state, formAction] = useActionState(action, null)
  const fe = state?.fieldErrors ?? {}

  // ARES-napojená pole jsou řízená, ať je lookup může předvyplnit.
  const [ico, setIco] = useState(initial?.ico ?? '')
  const [industry, setIndustry] = useState(initial?.industry ?? '')
  const [region, setRegion] = useState(initial?.region ?? '')
  const [q, setQ] = useState(initial?.ico || initial?.name || '')
  const [candidates, setCandidates] = useState<AresCompany[]>([])
  const [ares, setAres] = useState<AresCompany | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  function apply(c: AresCompany) {
    setIco(c.ico)
    if (c.industry) setIndustry(c.industry)
    if (c.city) setRegion(c.city)
    setAres(c)
    setCandidates([])
  }

  async function lookup() {
    const term = q.trim()
    if (term.length < 2) return
    setLoading(true); setErr(''); setCandidates([]); setAres(null)
    try {
      const isIco = /^\d{2,8}$/.test(term.replace(/\s/g, ''))
      const res = await fetch(`/api/ares?${isIco ? 'ico=' : 'q='}${encodeURIComponent(term)}`)
      const data = await res.json()
      if (isIco) {
        if (data.company) apply(data.company)
        else setErr('Firma s tímto IČO nenalezena.')
      } else {
        if (data.candidates?.length) setCandidates(data.candidates)
        else setErr('Nic nenalezeno.')
      }
    } catch {
      setErr('ARES je nedostupný, zkus to znovu.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <p role="alert" className="text-neg text-sm rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-3 m-0">{state.error}</p>}

      <div className="tile tile-sky p-4 md:p-5">
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor="ares-lookup" className="eyebrow block mb-1.5 !text-[color:#39414D]">Načíst z ARES (IČO nebo název)</label>
            <input
              id="ares-lookup"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup() } }}
              placeholder="25352628 nebo Servis Climax"
            />
          </div>
          <button type="button" onClick={lookup} disabled={loading} aria-busy={loading} className={buttonClass('secondary')}>
            {loading ? 'Hledám…' : 'Načíst'}
          </button>
        </div>
        {err && <p role="alert" className="text-neg text-sm mt-2 mb-0">{err}</p>}
        {ares && (
          <p role="status" className="text-sm text-[color:#39414D] mt-2 mb-0">
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mr-1 inline-block align-[-3px] text-pos"><path d="m5 12 5 5 9-10" /></svg>
            <span className="text-ink font-semibold">{ares.legalName}</span> · IČO {ares.ico}
            {ares.address ? ` · ${ares.address}` : ''}{ares.founded ? ` · vznik ${ares.founded}` : ''}
          </p>
        )}
        {candidates.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {candidates.map((c) => (
              <button key={c.ico} type="button" onClick={() => apply(c)}
                      className="text-left text-sm bg-surface border border-border rounded-btn px-3 py-2.5 hover:bg-[color:var(--c-soft)] min-h-[44px] md:min-h-0">
                <span className="text-ink font-medium">{c.legalName}</span>
                <span className="text-[color:#39414D]"> · IČO {c.ico} · {[c.city, c.region].filter(Boolean).join(', ')}{c.industry ? ` · ${c.industry}` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <FormField label="Název" error={fe.name}>
        <input name="name" defaultValue={initial?.name ?? ''} required />
      </FormField>
      <div className="grid md:grid-cols-2 gap-x-4 gap-y-4">
        <FormField label="Obor" error={fe.industry}>
          <input name="industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        </FormField>
        <FormField label="Region / sídlo" error={fe.region}>
          <input name="region" value={region} onChange={(e) => setRegion(e.target.value)} />
        </FormField>
        <FormField label="Velikost (SME / enterprise / holding / veřejný sektor)" error={fe.size_band}>
          <input name="size_band" defaultValue={initial?.size_band ?? ''} />
        </FormField>
        <FormField label="Web" error={fe.web}>
          <input name="web" defaultValue={initial?.web ?? ''} placeholder="example.cz" />
        </FormField>
        <FormField label="IČO" error={fe.ico}>
          <input name="ico" value={ico} onChange={(e) => setIco(e.target.value)} />
        </FormField>
        <FormField label="Doporučil (partner)" error={fe.referred_by_partner_id}>
          <select name="referred_by_partner_id" defaultValue={initial?.referred_by_partner_id ?? ''}>
            <option value="">— přímý (bez partnera) —</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.is_referrer ? ' · doporučovatel' : ''}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Vlastník (kdo to u nás vede)" error={fe.owner_id}>
          <select name="owner_id" defaultValue={initial?.owner_id ?? ''}>
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Klient od" error={fe.client_since}>
          <input name="client_since" type="date" defaultValue={initial?.client_since ?? ''} />
        </FormField>
        <FormField label="Právní forma" error={fe.legal_form}>
          <input name="legal_form" defaultValue={initial?.legal_form ?? ''} placeholder="s.r.o., a.s., …" />
        </FormField>
        <FormField label="Datum založení" error={fe.founded_on}>
          <input name="founded_on" type="date" defaultValue={initial?.founded_on ?? ''} />
        </FormField>
      </div>
      <FormField label="Profil firmy" hint="Co dělá a jak je velká — vlastními slovy, ne z rejstříku." error={fe.profile}>
        <textarea name="profile" rows={3} defaultValue={initial?.profile ?? ''} />
      </FormField>
      <FormField label="Poznámky" error={fe.notes}>
        <textarea name="notes" rows={3} defaultValue={initial?.notes ?? ''} />
      </FormField>
      <FormField label="Referenční klient" checkbox>
        <input name="is_reference" type="checkbox" defaultChecked={initial?.is_reference ?? false} />
      </FormField>
      <div className="pt-1"><SubmitButton variant="coral">{initial ? 'Uložit změny' : 'Založit klienta'}</SubmitButton></div>
    </form>
  )
}
