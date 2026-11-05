import { describe, expect, test } from 'vitest'
import {
  DOCUMENT_KINDS,
  SHAREPOINT_URL_RE,
  engagementDocumentSchema,
} from '@/domain/delivery/documents'

// Cockpit ukládá jen odkaz na SharePoint, nikdy obsah (rozhodnutí vlastníka
// 2026-09-28, plan kap. 8). Hlídáme hlavně URL validaci — musí propustit jen
// https://…sharepoint.com/… a nic jiného, včetně teams.microsoft.com, který
// je záměrně mimo (chat/kanály nejsou trvalý doklad).

describe('SHAREPOINT_URL_RE', () => {
  test('propustí SharePoint https odkaz', () => {
    expect(SHAREPOINT_URL_RE.test('https://mummiesdaddies.sharepoint.com/sites/projekt/doc.docx')).toBe(true)
  })

  test('odmítne teams.microsoft.com', () => {
    expect(SHAREPOINT_URL_RE.test('https://teams.microsoft.com/l/channel/xyz')).toBe(false)
  })

  test('odmítne http (bez s)', () => {
    expect(SHAREPOINT_URL_RE.test('http://mummiesdaddies.sharepoint.com/sites/projekt')).toBe(false)
  })

  test('odmítne jinou doménu', () => {
    expect(SHAREPOINT_URL_RE.test('https://drive.google.com/file/d/abc')).toBe(false)
    expect(SHAREPOINT_URL_RE.test('https://evil.com/sharepoint.com/')).toBe(false)
  })

  test('L4: jen firemní tenant mummiesdaddies / mummiesdaddies-my, ne cizí *.sharepoint.com', () => {
    expect(SHAREPOINT_URL_RE.test('https://mummiesdaddies-my.sharepoint.com/personal/viktor/doc.docx')).toBe(true)
    for (const bad of [
      'https://firma.sharepoint.com/sites/x',
      'https://evilmummiesdaddies.sharepoint.com/x',
      'https://mummiesdaddies.sharepoint.com.evil.com/x',
      'https://mummiesdaddies-myx.sharepoint.com/x',
      'https://MUMMIESDADDIES.sharepoint.com/x',
      'https://mummiesdaddies.sharepoint.com',
    ]) {
      expect(SHAREPOINT_URL_RE.test(bad), bad).toBe(false)
    }
  })
})

describe('engagementDocumentSchema', () => {
  const base = { engagement_id: '1', title: 'Smlouva o dílo', url: 'https://mummiesdaddies.sharepoint.com/sites/x', kind: 'smlouva' }

  test('přijme platná data', () => {
    const r = engagementDocumentSchema.safeParse(base)
    expect(r.success).toBe(true)
  })

  test('odmítne prázdný název', () => {
    const r = engagementDocumentSchema.safeParse({ ...base, title: '  ' })
    expect(r.success).toBe(false)
  })

  test('odmítne název nad 200 znaků', () => {
    const r = engagementDocumentSchema.safeParse({ ...base, title: 'x'.repeat(201) })
    expect(r.success).toBe(false)
  })

  test('L4: odmítne odkaz delší než 2000 znaků', () => {
    const long = 'https://mummiesdaddies.sharepoint.com/' + 'a'.repeat(2000)
    expect(engagementDocumentSchema.safeParse({ ...base, url: long }).success).toBe(false)
    const max = 'https://mummiesdaddies.sharepoint.com/' + 'a'.repeat(2000 - 'https://mummiesdaddies.sharepoint.com/'.length)
    expect(engagementDocumentSchema.safeParse({ ...base, url: max }).success).toBe(true)
  })

  test('odmítne odkaz mimo sharepoint.com', () => {
    const r = engagementDocumentSchema.safeParse({ ...base, url: 'https://teams.microsoft.com/l/channel/xyz' })
    expect(r.success).toBe(false)
  })

  test('odmítne neplatný kind', () => {
    const r = engagementDocumentSchema.safeParse({ ...base, kind: 'neexistuje' })
    expect(r.success).toBe(false)
  })

  test('milestone_id je nepovinný, prázdný řetězec = null', () => {
    const r = engagementDocumentSchema.safeParse({ ...base, milestone_id: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.milestone_id).toBeNull()
  })

  test('milestone_id přijme kladné celé číslo', () => {
    const r = engagementDocumentSchema.safeParse({ ...base, milestone_id: '5' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.milestone_id).toBe(5)
  })

  test('DOCUMENT_KINDS odpovídá DB CHECK v 0051_engagement_document.sql', () => {
    expect(DOCUMENT_KINDS).toEqual(['podklad', 'vystup', 'smlouva', 'jine'])
  })
})
