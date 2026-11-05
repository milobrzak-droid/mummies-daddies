import { describe, expect, test } from 'vitest'
import {
  DOCUMENT_LINK_ERROR,
  parseDocumentLink,
  parseStrictHttpsUrl,
  storableSharePointUrl,
  TEAMS_LINK_ERROR,
} from '@/domain/delivery/documentLink'

// domain/delivery/documentLink.ts — co smí člen vložit do dokumentů dodávky
// (a co tedy smí jít do Graphu) vs. co smí Cockpit uložit (plan kap. 8).

const SP = 'https://mummiesdaddies.sharepoint.com/sites/Projekt/Sdilene%20dokumenty/Nabidka.docx'
const teams = (objectUrl: string) =>
  `https://teams.microsoft.com/l/file/ABC-123?tenantId=t&fileType=docx&objectUrl=${encodeURIComponent(objectUrl)}&baseUrl=x&serviceName=teams`

describe('povolené odkazy', () => {
  test('firemní SharePoint — jde poslat do Graphu i uložit', () => {
    expect(parseDocumentLink(SP)).toEqual({ ok: true, source: 'sharepoint', url: SP, resolveUrl: SP, storableUrl: SP })
  })

  test('OneDrive for Business (-my) a sdílecí odkaz /:w:/', () => {
    const od = 'https://mummiesdaddies-my.sharepoint.com/:w:/g/personal/viktor_mummiesdaddies_cz/EabcDEF?e=xyz'
    expect(parseDocumentLink(od)).toMatchObject({ ok: true, source: 'sharepoint', storableUrl: od })
  })

  test('cizí tenant *.sharepoint.com: do Graphu ano, uložit jako takový ne', () => {
    const r = parseDocumentLink('https://contoso.sharepoint.com/sites/x/a.docx')
    expect(r).toMatchObject({ ok: true, source: 'sharepoint', storableUrl: null })
  })

  test('soubor v Teams: do Graphu jde vnitřní objectUrl, a ten jde i uložit', () => {
    const r = parseDocumentLink(teams(SP))
    expect(r).toMatchObject({ ok: true, source: 'teams_file', resolveUrl: SP, storableUrl: SP })
  })

  test('1drv.ms a onedrive.live.com: do Graphu ano, uložit ne (osobní OneDrive)', () => {
    for (const u of ['https://1drv.ms/w/s!AbCdEf', 'https://onedrive.live.com/redir?resid=123!12&authkey=!x']) {
      expect(parseDocumentLink(u), u).toMatchObject({ ok: true, source: 'onedrive_personal', resolveUrl: u, storableUrl: null })
    }
  })

  test('velká písmena v hostu a okolní mezery se normalizují', () => {
    const r = parseDocumentLink('  https://MummiesDaddies.SharePoint.com/sites/x  ')
    expect(r).toMatchObject({ ok: true, url: 'https://mummiesdaddies.sharepoint.com/sites/x', storableUrl: 'https://mummiesdaddies.sharepoint.com/sites/x' })
  })
})

describe('pokusy o obejití', () => {
  const rejected: [string, string][] = [
    ['http místo https', 'http://mummiesdaddies.sharepoint.com/a'],
    ['userinfo před povoleným hostem', 'https://mummiesdaddies.sharepoint.com@evil.example/a'],
    ['userinfo s heslem', 'https://user:pass@mummiesdaddies.sharepoint.com/a'],
    ['povolený host jako userinfo', 'https://evil.example@mummiesdaddies.sharepoint.com/a'],
    ['zpětné lomítko (WHATWG z něj udělá /)', 'https://evil.example\\@mummiesdaddies.sharepoint.com/a'],
    ['zpětné lomítko v cestě', 'https://mummiesdaddies.sharepoint.com\\..\\a'],
    ['host jen jako poddoména cizí domény', 'https://mummiesdaddies.sharepoint.com.evil.example/a'],
    ['sharepoint.com v cestě', 'https://evil.example/mummiesdaddies.sharepoint.com/a'],
    ['podobný host', 'https://mummiesdaddies.sharepoint.co/a'],
    ['holé sharepoint.com', 'https://sharepoint.com/a'],
    ['víc labelů před sharepoint.com', 'https://a.mummiesdaddies.sharepoint.com/a'],
    ['koncová tečka v hostu', 'https://mummiesdaddies.sharepoint.com./a'],
    ['explicitní port', 'https://mummiesdaddies.sharepoint.com:443/a'],
    ['jiný port', 'https://mummiesdaddies.sharepoint.com:8443/a'],
    ['IDN homoglyf (cyrilské е)', 'https://\u0435nterai.sharepoint.com/a'],
    ['punycode label', 'https://xn--nterai-4ve.sharepoint.com/a'],
    ['full-width tečka', 'https://mummiesdaddies\u3002sharepoint.com/a'],
    ['procenta v hostu', 'https://mummiesdaddies%2esharepoint.com/a'],
    ['mezera uvnitř', 'https://mummiesdaddies.sharepoint.com/a b'],
    ['řídicí znak', 'https://mummiesdaddies.sharepoint.com/a\u0000'],
    ['tab v hostu', 'https://enter\tai.sharepoint.com/a'],
    ['javascript:', 'javascript:alert(1)//mummiesdaddies.sharepoint.com/'],
    ['data:', 'data:text/html,https://mummiesdaddies.sharepoint.com/'],
    ['protokolově relativní', '//mummiesdaddies.sharepoint.com/a'],
    ['jen jedno lomítko', 'https:/mummiesdaddies.sharepoint.com/a'],
    ['bez schématu', 'mummiesdaddies.sharepoint.com/a'],
    ['jiný Microsoft host', 'https://login.microsoftonline.com/a'],
    ['Google Drive', 'https://drive.google.com/file/d/abc'],
    ['onedrive.live.com jako poddoména', 'https://onedrive.live.com.evil.example/a'],
    ['1drv.ms s userinfo', 'https://1drv.ms@evil.example/a'],
    ['prázdné', ''],
  ]
  for (const [why, url] of rejected) {
    test(why, () => {
      expect(parseDocumentLink(url)).toEqual({ ok: false, error: DOCUMENT_LINK_ERROR })
    })
  }

  test('příliš dlouhý odkaz', () => {
    expect(parseDocumentLink(`https://mummiesdaddies.sharepoint.com/${'a'.repeat(2000)}`).ok).toBe(false)
  })

  test('Teams chat/kanál (ne soubor) je odmítnutý', () => {
    expect(parseDocumentLink('https://teams.microsoft.com/l/channel/19%3Aabc/General?groupId=x')).toEqual({ ok: false, error: TEAMS_LINK_ERROR })
    expect(parseDocumentLink('https://teams.microsoft.com/l/message/19:abc/123')).toEqual({ ok: false, error: TEAMS_LINK_ERROR })
  })

  test('Teams soubor bez objectUrl nebo s objectUrl mimo SharePoint je odmítnutý', () => {
    expect(parseDocumentLink('https://teams.microsoft.com/l/file/ABC?fileType=docx').ok).toBe(false)
    for (const inner of [
      'https://evil.example/a.docx',
      'http://mummiesdaddies.sharepoint.com/a.docx',
      'https://mummiesdaddies.sharepoint.com@evil.example/a.docx',
      'https://onedrive.live.com/redir?resid=1',
      teams(SP),
    ]) {
      expect(parseDocumentLink(teams(inner)), inner).toEqual({ ok: false, error: TEAMS_LINK_ERROR })
    }
  })
})

describe('storableSharePointUrl — co smí do DB (shodné s 0053)', () => {
  test('firemní SharePoint projde normalizovaný', () => {
    expect(storableSharePointUrl('https://mummiesdaddies.sharepoint.com/sites/x')).toBe('https://mummiesdaddies.sharepoint.com/sites/x')
    expect(storableSharePointUrl('https://mummiesdaddies-my.sharepoint.com/personal/x')).toBe('https://mummiesdaddies-my.sharepoint.com/personal/x')
  })

  test('cizí tenant, OneDrive osobní i obcházení neprojdou', () => {
    for (const u of [
      'https://contoso.sharepoint.com/a',
      'https://onedrive.live.com/a',
      'https://mummiesdaddies.sharepoint.com@evil.example/',
      'https://mummiesdaddies.sharepoint.com:443/a',
    ]) {
      expect(storableSharePointUrl(u), u).toBeNull()
    }
  })

  test('parseStrictHttpsUrl vrací URL jen pro čisté https odkazy', () => {
    expect(parseStrictHttpsUrl('https://mummiesdaddies.sharepoint.com/a')?.hostname).toBe('mummiesdaddies.sharepoint.com')
    expect(parseStrictHttpsUrl('https://a@b.c/')).toBeNull()
  })
})
