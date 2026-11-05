'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { AccountPicker } from '@/components/AccountPicker'
import { planMeeting, type PlanMilestoneOutcome, type PlanResult } from '@/domain/crm/actions/planMeeting'
import { findMeetingMilestones, type MeetingMilestoneOption } from '@/domain/crm/actions/meetingMilestones'
import { EXTERNAL_LINK_REL, safeExternalHref } from '@/core/untrusted'

// Formulář pro naplánování schůzky.
//
// Proč vlastní formulář a ne jen kalendář: schůzka založená tady rovnou
// vzniká i v Cockpitu a hlídá se termín dalšího kontaktu. Když se schůzka
// domluví „mimo systém", nikdo ji nepohlídá. Posun nebo zrušení v Outlooku
// Cockpit promítne sám (kontrola kalendáře).
//
// Milník dodávky (volitelně, jen u existujícího klienta s dodávkou): schůzka
// k němu patří. Milník bez termínu dostane termín podle schůzky a bude se
// s ní posouvat; vlastní termín milníku se nemění. Když název schůzky
// obsahuje název právě jednoho otevřeného milníku („Workshop …"), formulář
// ho předvybere — dokud člověk nezvolí sám.

const nowForInput = () => {
  const now = new Date()
  // datetime-local čte lokální čas, toISOString vrací UTC — proto posun.
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset())
  return now.toISOString().slice(0, 16)
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const dayLabel = (day: string) => `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}.`

/** Milník, jehož název je v názvu schůzky — jen když je jediný. */
export function suggestMilestone(title: string, options: readonly MeetingMilestoneOption[]): number | null {
  const t = ` ${fold(title)} `
  const hits = options.filter((o) => {
    const k = fold(o.title)
    return k.length >= 3 && t.includes(` ${k} `)
  })
  return hits.length === 1 ? hits[0].id : null
}

function milestoneHint(o: MeetingMilestoneOption | undefined): string {
  if (!o) return 'Když schůzka patří k milníku dodávky (třeba Workshop), vyber ho — posun schůzky pak Cockpit promítne i do milníku.'
  if (!o.dueOn) return 'Milník nemá termín: dostane den schůzky a bude se s ní posouvat.'
  if (o.dueFromMeeting) return `Termín milníku (${dayLabel(o.dueOn)}) je převzatý z jiné schůzky; pokud ta už neplatí, převezme ho tahle.`
  return `Milník má vlastní termín ${dayLabel(o.dueOn)} a ten se nezmění. Když se schůzka posune, vlastník milníku dostane úkol ke kontrole.`
}

function milestoneSentence(m: PlanMilestoneOutcome): string {
  if (m.dueFromMeeting && m.dueOn) return `Milník „${m.title}“ má termín podle schůzky (${dayLabel(m.dueOn)}) a bude se s ní posouvat.`
  if (m.dueOn) return `Schůzka patří k milníku „${m.title}“; jeho termín ${dayLabel(m.dueOn)} zůstává.`
  return `Schůzka patří k milníku „${m.title}“.`
}

export function PlanMeetingForm() {
  // Nevybraná firma znamená „nový klient" — server action tak dostane
  // prázdné account_id a použije new_account_name. Existující klient se
  // hledá (AccountPicker), ne vybírá ze seznamu všech ~663 firem.
  const [accountId, setAccountId] = useState('')
  const [title, setTitle] = useState('')
  const [milestones, setMilestones] = useState<{ accountId: string; options: MeetingMilestoneOption[] }>({ accountId: '', options: [] })
  // null = člověk milník nevolil (platí návrh podle názvu); '' = výslovně bez milníku.
  const [milestoneChoice, setMilestoneChoice] = useState<string | null>(null)
  const [state, formAction] = useActionState<PlanResult | null, FormData>(
    async (previous, formData) => {
      const result = await planMeeting(previous, formData)
      // Po úspěchu React formulář vyprázdní — volba milníku a název (pro
      // návrh milníku) jdou s ním.
      if (result.ok) {
        setTitle('')
        setMilestoneChoice(null)
      }
      return result
    },
    null,
  )

  // Milníky dodávek vybraného klienta. Bez migrace 0085 nebo bez dodávky
  // prázdný seznam — výběr se neukáže.
  useEffect(() => {
    if (accountId === '') return
    let cancelled = false
    findMeetingMilestones(Number(accountId))
      .then((r) => {
        if (!cancelled) setMilestones({ accountId, options: r.ok && r.available ? r.options : [] })
      })
      .catch(() => {
        if (!cancelled) setMilestones({ accountId, options: [] })
      })
    return () => { cancelled = true }
  }, [accountId])

  const options = useMemo(
    () => (accountId !== '' && milestones.accountId === accountId ? milestones.options : []),
    [accountId, milestones],
  )
  const suggested = useMemo(() => suggestMilestone(title, options), [title, options])
  const selected = milestoneChoice ?? (suggested != null ? String(suggested) : '')
  const selectedOption = options.find((o) => String(o.id) === selected)

  return (
    <form action={formAction} aria-label="Naplánovat schůzku">
      {state && !state.ok && (
        <p role="alert" className="mb-4 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-callout text-neg">
          {state.error}
        </p>
      )}

      {state?.ok && (
        <div role="status" className="mb-4 space-y-1 rounded-btn bg-[color:var(--c-pos-soft)] px-3 py-2 text-callout text-pos">
          <p className="m-0">Schůzka je naplánovaná, pozvánka odešla z Outlooku účastníkům.</p>
          {state.createdAccount && <p className="m-0">Klient v Cockpitu ještě nebyl — založili jsme ho.</p>}
          {state.milestone && <p className="m-0">{milestoneSentence(state.milestone)}</p>}
          <p className="m-0 flex flex-wrap gap-x-3">
            <Link href={`/cockpit/clients/${state.accountId}`} className="underline">Otevřít klienta</Link>
            {safeExternalHref(state.joinUrl) && (
              <a href={safeExternalHref(state.joinUrl)!} target="_blank" rel={EXTERNAL_LINK_REL} className="underline">Odkaz na Teams</a>
            )}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Klient" hint="Nech prázdné pro nového klienta.">
          <AccountPicker
            name="account_id"
            // Volba klienta (dřív řízený select) přežije reset formuláře,
            // který React dělá po každém odeslání.
            keepOnReset
            placeholder="Existující klient — začni psát název či IČO…"
            onChange={(option) => {
              setAccountId(option ? String(option.id) : '')
              // Jiný klient = jiné milníky; volba se vrací k návrhu podle názvu.
              setMilestoneChoice(null)
            }}
          />
        </FormField>
        {accountId === '' ? (
          <FormField label="Název nového klienta">
            <input name="new_account_name" placeholder="Např. Sigmaform CZ s.r.o." autoComplete="off" required />
          </FormField>
        ) : (
          <div aria-hidden="true" className="hidden sm:block" />
        )}
      </div>

      <div className="mt-3">
        <FormField label="Název schůzky">
          <input
            name="title"
            placeholder="Např. Úvodní jednání o AI školení"
            autoComplete="off"
            required
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
      </div>

      {options.length > 0 && (
        <div className="mt-3">
          <FormField label="Milník dodávky (volitelné)">
            <select
              name="milestone_id"
              value={selected}
              onChange={(e) => setMilestoneChoice(e.target.value)}
            >
              <option value="">Bez milníku</option>
              {options.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.title} · {o.engagementLabel} · {o.dueOn ? `termín ${dayLabel(o.dueOn)}` : 'bez termínu'}
                </option>
              ))}
            </select>
          </FormField>
          <p className="m-0 mt-1 text-footnote text-muted">{milestoneHint(selectedOption)}</p>
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FormField label="Termín">
          <input name="start" type="datetime-local" defaultValue={nowForInput()} required />
        </FormField>
        <FormField label="Délka">
          <select name="duration_min" defaultValue="60">
            <option value="30">30 minut</option>
            <option value="60">60 minut</option>
            <option value="90">90 minut</option>
          </select>
        </FormField>
      </div>

      <div className="mt-3">
        <FormField label="Účastníci (e-maily oddělené čárkou)">
          <input name="attendees" placeholder="jan.novak@firma.cz, sekretariat@firma.cz" autoComplete="off" />
        </FormField>
        <p className="m-0 mt-1 text-footnote text-muted">
          Adresy, které v CRM ještě nemáme, se založí jako kontakty u klienta.
        </p>
      </div>

      <div className="mt-3">
        <FormField label="Další kontakt nejpozději do (dnů po schůzce)">
          <input name="follow_up_days" type="number" min={1} max={180} defaultValue={10} />
        </FormField>
        <p className="m-0 mt-1 text-footnote text-muted">
          Po tomto termínu obchod začne svítit jako zanedbaný — proto sem patří reálná lhůta, ne zbožné přání.
        </p>
      </div>

      <div className="mt-3">
        <FormField label="Poznámka (volitelné)">
          <textarea name="note" rows={3} placeholder="Kontext do pozvánky — cíl schůzky, na co se ptát…" />
        </FormField>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="m-0 max-w-sm text-footnote text-muted">
          Vznikne událost v Outlooku s Teams odkazem. Když ji v Outlooku posuneš nebo zrušíš, Cockpit to promítne sám.
          Zápis po schůzce pošli z Wispr Flow (návod docs/PROVOZ.md) — doplní tuhle schůzku.
        </p>
        <SubmitButton pendingLabel="Plánuji…">Naplánovat schůzku</SubmitButton>
      </div>
    </form>
  )
}
