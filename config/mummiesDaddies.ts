// Konfigurace firmy Mummies and Daddies s.r.o. — jediná instance
// CompanyConfig (core/tenant.ts). Všechno, čím se firma liší od obecného
// Cockpitu, je tady jako data. Nikdo neimportuje tenhle soubor přímo;
// vstup je `@/config`.
//
// SQL má vlastní kopie některých hodnot (migrace jsou psané přímo pro tuto
// firmu); změna tady = změna migrace a testy u každé kopie hlídají shodu:
//   nodes            CHECK work_case_node_check, loop_node_node_check,
//                    approval_request_node_check a seed loop_node
//                    (0039, 0057; test/work-case.test.ts)
//   pillars          CHECK deal.pillar (0010)
//   deliveryTeams    CHECK deal.delivery_team (0010) a engagement (0061)
//   revenueLines     enum revenue_line (0001); kategorie v
//                    lib/validation/schemas.ts#categoryForLine
//   sharepointHosts  CHECK engagement_document_url_host_check (0053)
//   autoDelivery     funkce auto_delivery_* (0080; test/auto-delivery-migration.test.ts)
//   approvalActions  funkce approval_action_settings (0084;
//                    test/approval-executor-0084.test.ts)
//
// CENOVÁ MAPA JE ILUSTRAČNÍ (verze 'ilustracni-…'): typy akcí odpovídají
// nabídce firmy, ceny jsou v rozpětí, které firma uvádí (300–2 000 Kč
// za osobu), ale klient je zatím neschválil. Dokud verze začíná
// 'ilustracni', samostatné odeslání nabídky je technicky blokované (brána
// v P3) a každá nabídka jde ke schválení obchodu.
//
// Body k ověření s klientem jsou označené OVĚŘIT.
import type { CompanyConfig } from '@/core/tenant'

const NODES = ['obchod', 'eventy', 'vedeni'] as const
type MdNode = (typeof NODES)[number]

type MdPillar = 'b2b_akce' | 'b2c_oslavy' | 'cheesecaky'

// Prodejní fáze (deal.phase) — stejné pro všechny pilíře. KPI agenta se
// počítají z nich (P5).
const SALES_PHASES = [
  { key: 'poptavka', label: 'Poptávka' },
  { key: 'nabidka', label: 'Nabídka odeslána' },
  { key: 'potvrzeno', label: 'Potvrzeno' },
  { key: 'realizovano', label: 'Realizováno' },
] as const

const WON = ['potvrzeno', 'realizovano'] as const

export const MUMMIES_DADDIES = {
  id: 'mummiesdaddies',
  name: 'Mummies and Daddies',
  productName: 'Mummies and Daddies Cockpit',
  productDescription: 'Catering, eventy a cheesecaky Mummies and Daddies — poptávky, nabídky a objednávky',
  emailDomain: 'mummiesdaddies.com',
  digestSender: 'cockpit@mummiesdaddies.com', // OVĚŘIT: servisní schránka pro přehledy
  // SharePoint firma zatím nepoužívá; hosty jen pro tvar odkazů na dokumenty. OVĚŘIT.
  sharepointHosts: ['mummiesdaddies', 'mummiesdaddies-my'],
  timeZone: 'Europe/Prague',
  // Účetnictví vede firma mimo Cockpit; integrace s iDokladem zůstává vypnutá.
  accountingSystem: 'Účetnictví firmy',

  nodes: NODES,
  nodeLabels: {
    obchod: 'Obchod a marketing',
    eventy: 'Eventy a realizace',
    vedeni: 'Vedení a kuchyně',
  },
  caseTemplates: [
    {
      id: 'nestandardni_nabidka',
      label: 'Nestandardní poptávka → nabídka na míru',
      suggestedNode: 'obchod',
      steps: ['Posoudit výjimku', 'Připravit nabídku na míru', 'Schválit a odeslat'],
      decisions: [{ question: 'Nabídnout mimo standardní mapu?', options: ['ano', 'ne'] }],
    },
    {
      id: 'realizace_akce',
      label: 'Realizace akce',
      suggestedNode: 'eventy',
      steps: ['Potvrdit menu a počet hostů', 'Zajistit personál a inventář', 'Realizace akce', 'Vyúčtování a zpětná vazba'],
      decisions: [],
    },
  ],
  followUpNode: 'obchod',

  // Barvy pilířů (validovaná kategorická sada — CVD-safe light i dark).
  pillars: [
    { key: 'b2b_akce', label: 'Firemní akce', sub: 'B2B', color: '#3d8bfd' },
    { key: 'b2c_oslavy', label: 'Soukromé oslavy', sub: 'B2C', color: '#12b981' },
    { key: 'cheesecaky', label: 'Cheesecaky', sub: 'cukrárna a e-shop', color: '#f2683c' },
  ],
  phases: {
    b2b_akce: SALES_PHASES,
    b2c_oslavy: SALES_PHASES,
    cheesecaky: SALES_PHASES,
  },
  wonPhases: {
    b2b_akce: WON,
    b2c_oslavy: WON,
    cheesecaky: WON,
  },
  deliveryTeams: [
    { key: 'kuchyne', label: 'Kuchyně' },
    { key: 'cukrarna', label: 'Cukrárna' },
    { key: 'obsluha', label: 'Obsluha' },
    { key: 'logistika', label: 'Logistika a vybavení' },
    { key: 'externi', label: 'Externí spolupracovníci' },
  ],

  // Outbound (vyhledávání signálů, oslovování) je fáze 2 — segmenty doplníme s ICP.
  targetSegments: {},

  // Předání potvrzené akce do realizace (migrace 0080): trigger v DB založí
  // realizaci, milníky podle typu obchodu a úkol pro vlastníka. SQL má kopii
  // (auto_delivery_milestones) — test/auto-delivery-migration.test.ts.
  // Klíče typů obchodu (deal.deal_kind) jsou historické: workshop =
  // degustace, implementace = jednorázová akce, provoz = pravidelný catering.
  autoDelivery: {
    startTask: { title: 'Naplánovat realizaci akce', workingDays: 2 },
    milestoneTemplates: {
      workshop: ['Degustace', 'Potvrzení menu', 'Realizace akce'],
      implementace: ['Potvrzení menu a počtu hostů', 'Personál a inventář', 'Realizace akce', 'Vyúčtování a zpětná vazba'],
      provoz: ['Nastavení pravidelných dodávek', 'První dodávka', 'Vyhodnocení po měsíci'],
      jine: ['Potvrzení detailů', 'Realizace akce', 'Vyúčtování'],
    },
    deputyNodes: ['eventy', 'vedeni'],
  },

  // Schválení napojené na akci (migrace 0084). SQL kopie: approval_action_settings.
  approvalActions: {
    confirmNextStep: { validityDays: 7 },
    sendOffer: {
      node: 'obchod',
      // 0 Kč = schválení vždy (dokud klient neschválí mapu a pravomoc L4).
      requireApprovalFromCzk: 0,
      validityDays: 5,
      task: { title: 'Odeslat nabídku klientovi', workingDays: 1 },
    },
    returnTask: { workingDays: 1 },
  },

  // Hlavní metrika dopadu realizace (migrace 0088). Klíče jsou historické
  // (0088 převádí stará pole na klíč 'adopce' u druhu 'edu'); popisky a
  // nápovědy odpovídají cateringu.
  impactMetrics: {
    types: [
      { key: 'cas_na_ukon', label: 'Čas výdeje', unit: 'min', better: 'lower', hint: 'Jak dlouho trvá výdej jídla nebo obsloužení jednoho hosta.' },
      { key: 'pocet_polozek', label: 'Počet obsloužených hostů', unit: 'hostů', better: 'higher', hint: 'Kolik hostů nebo porcí se na akci obsloužilo.' },
      { key: 'chybovost', label: 'Reklamace', unit: '%', better: 'lower', hint: 'Podíl porcí nebo položek s reklamací či výhradou.' },
      { key: 'adopce', label: 'Opakované objednávky', unit: '%', better: 'higher', hint: 'Podíl zákazníků, kteří objednali znovu.' },
      { key: 'uspora_hodin', label: 'Úspora hodin', unit: 'h/měsíc', better: 'higher', hint: 'Kolik hodin práce za měsíc ušetří; výchozí stav bývá 0.' },
      { key: 'vlastni', label: 'Vlastní metrika', unit: null, better: null, hint: 'Vlastní název a jednotka, když se nic z nabídky nehodí.', custom: true },
    ],
    defaultByKind: { edu: 'adopce', it: 'cas_na_ukon', platform: 'pocet_polozek' },
    fallback: 'vlastni',
  },

  capabilities: {
    // Odpověď firmy na naši zprávu → návrh dalšího kroku. Nové poptávky vede
    // agent (inquiryAgent), proto tady žádná klíčová slova.
    mailToCase: {
      node: 'obchod',
      titleTemplate: 'Odpověď od {firma} — další krok',
      maxEventAgeDays: 3,
      replyWindowDays: 14,
      firstContact: false,
      keywords: [],
      steps: ['Přečíst odpověď a určit další krok', 'Domluvit další krok se zákazníkem'],
    },
    // Zápisy schůzek z diktátu firma nepoužívá.
    meetingNotes: null,
    // Pošta přesunutá do složky „Cockpit" → návrh k realizaci nebo k obchodu.
    mailContent: {
      node: 'eventy',
      dealNode: 'obchod',
    },
    // Automatické založení poptávky od neznámé firmy (jen za env
    // CAPABILITY_AUTO_INTAKE_ENABLED, výchozí vypnuto). Přednost má agent:
    // zprávy, které má agent ve frontě, autoIntake přeskočí (P2).
    autoIntake: {
      node: 'obchod',
      dailyLimit: 10,
      maxAgeDays: 3,
      maxAutoRecipients: 3,
      bulkRecipients: 8,
      internalDomains: [],
      automatedDomains: [
        'mailchimp.com', 'mcsv.net', 'mailchimpapp.com', 'sendgrid.net', 'sendgrid.com', 'amazonses.com', 'mandrillapp.com',
        'mailgun.org', 'mailgun.com', 'sparkpostmail.com', 'postmarkapp.com', 'hubspot.com', 'hubspotemail.net', 'klaviyomail.com',
        'ecomail.cz', 'smartemailing.cz', 'mailerlite.com', 'sendinblue.com', 'brevo.com', 'linkedin.com', 'facebookmail.com',
        'google.com', 'microsoft.com', 'microsoftonline.com', 'office365.com', 'github.com', 'atlassian.net', 'slack.com',
        'notion.so', 'zoom.us', 'stripe.com', 'paypal.com', 'vercel.com', 'supabase.io', 'supabase.com', 'calendly.com', 'zapier.com',
        'wix.com', 'wixsite.com',
      ],
      revenueLine: 'catering_firemni',
      dealTitleTemplate: 'Poptávka z e-mailu — {firma}',
      nextStep: 'Odpovědět na poptávku',
      nextStepBusinessDays: 1,
      taskTitleTemplate: 'Odpovědět na poptávku — {firma}',
      proposalTitleTemplate: 'Nová poptávka z domény {domena} — ověřit',
      proposalSteps: [
        'Ověřit, že jde o poptávku',
        'Založit zákazníka a obchod',
        'Odpovědět na poptávku do 1 pracovního dne',
      ],
    },

    standardOffer: {
      escalationNode: 'obchod',
      signature: 'Obchod a marketing\nMummies and Daddies s.r.o.\ninfo@mummiesdaddies.com · +420 737 818 694',
      priceMap: {
        version: 'ilustracni-2026-11',
        approvedAt: '2026-11-05',
        validUntil: '2027-06-30',
        currency: 'CZK',
        vatRate: 0.12, // OVĚŘIT: jídlo vs. služba obsluhy
        offerValidityDays: 14,
        minLeadDays: 3, // OVĚŘIT
        maxLeadDays: 365,
        segments: [
          {
            key: 'b2b',
            label: 'Firemní akce',
            eventTypes: [
              { key: 'snidane', label: 'Snídaně', packages: ['snidane_bufet'], defaultPackage: 'snidane_bufet' },
              { key: 'coffee_break', label: 'Coffee break', packages: ['coffee_break'], defaultPackage: 'coffee_break' },
              { key: 'obed', label: 'Oběd', packages: ['obed_raut', 'sefkucharovo_menu'], defaultPackage: 'obed_raut' },
              { key: 'business_banket', label: 'Business banket', packages: ['business_banket'], defaultPackage: 'business_banket' },
              { key: 'spolecenska_akce', label: 'Společenská akce (koktejl, networking)', packages: ['koktejl', 'odpoledni_caj'], defaultPackage: 'koktejl' },
              { key: 'firemni_catering', label: 'Firemní catering do kanceláře', packages: ['office_box', 'coffee_break'], defaultPackage: 'office_box' },
              { key: 'firemni_party', label: 'Firemní party a BBQ', packages: ['bbq_party', 'obed_raut'], defaultPackage: 'bbq_party' },
            ],
          },
          {
            key: 'b2c',
            label: 'Soukromé oslavy',
            eventTypes: [
              { key: 'svatba', label: 'Svatební hostina', packages: ['svatebni_hostina'], defaultPackage: 'svatebni_hostina' },
              { key: 'oslava', label: 'Oslava (narozeniny, křtiny)', packages: ['oslava_raut', 'bbq_party'], defaultPackage: 'oslava_raut' },
              { key: 'piknik', label: 'Piknik', packages: ['piknikovy_kos'], defaultPackage: 'piknikovy_kos' },
              { key: 'romanticka_vecere', label: 'Romantická večeře', packages: ['romanticka_vecere'], defaultPackage: 'romanticka_vecere' },
            ],
          },
        ],
        packages: [
          { key: 'snidane_bufet', label: 'Snídaňový bufet', pricePerGuest: 390, minGuests: 10, maxGuests: 200, service: false, includes: ['pečivo, vajíčka, sýry a šunka', 'jogurty, granola a ovoce', 'káva, čaj, džusy'] },
          { key: 'coffee_break', label: 'Coffee break', pricePerGuest: 320, minGuests: 10, maxGuests: 300, service: false, includes: ['káva, čaj, voda', 'sladké a slané pečivo', 'mini cheesecaky', 'ovoce'] },
          { key: 'obed_raut', label: 'Obědový raut', pricePerGuest: 690, minGuests: 20, maxGuests: 300, service: true, includes: ['studený a teplý raut', 'saláty', 'dezerty', 'nealkoholické nápoje', 'inventář'] },
          { key: 'sefkucharovo_menu', label: 'Šéfkuchařovo menu', pricePerGuest: 1290, minGuests: 10, maxGuests: 80, service: true, includes: ['tříchodové menu podle sezóny', 'nealkoholické nápoje', 'inventář'] },
          { key: 'business_banket', label: 'Business banket', pricePerGuest: 1590, minGuests: 20, maxGuests: 200, service: true, includes: ['servírované menu o čtyřech chodech', 'dezert', 'nealkoholické nápoje', 'inventář a prostírání'] },
          { key: 'koktejl', label: 'Koktejl a networking', pricePerGuest: 590, minGuests: 20, maxGuests: 300, service: true, includes: ['finger food (10 kusů na osobu)', 'přípitek', 'nealkoholické nápoje'] },
          { key: 'odpoledni_caj', label: 'Odpolední čaj', pricePerGuest: 450, minGuests: 10, maxGuests: 80, service: true, includes: ['výběr čajů a káva', 'sendvičky a scones', 'mini cheesecaky'] },
          { key: 'office_box', label: 'Grab-and-go do kanceláře', pricePerGuest: 340, minGuests: 10, maxGuests: 150, service: false, includes: ['saláty a sendviče v boxech', 'dezert', 'doručení do kanceláře'] },
          { key: 'bbq_party', label: 'BBQ party', pricePerGuest: 890, minGuests: 20, maxGuests: 200, service: true, includes: ['grilované maso a zelenina', 'přílohy a saláty', 'dezerty', 'nealkoholické nápoje'] },
          { key: 'svatebni_hostina', label: 'Svatební hostina', pricePerGuest: 1890, minGuests: 30, maxGuests: 200, service: true, includes: ['předkrm, polévka, hlavní chod', 'večerní raut', 'inventář a výzdoba stolů'] },
          { key: 'oslava_raut', label: 'Raut na oslavu', pricePerGuest: 790, minGuests: 15, maxGuests: 150, service: true, includes: ['studený a teplý raut', 'dezerty', 'inventář'] },
          { key: 'piknikovy_kos', label: 'Piknikový koš', pricePerGuest: 490, minGuests: 2, maxGuests: 60, service: false, includes: ['sendviče, saláty a sýry', 'dezert', 'limonáda', 'deka a nádobí do koše'] },
          { key: 'romanticka_vecere', label: 'Romantická večeře', pricePerGuest: 1990, minGuests: 2, maxGuests: 2, service: true, includes: ['pětichodové menu', 'servis číšníka', 'prostírání a svíčky'] },
        ],
        extras: [
          { key: 'napoje_alko', label: 'Víno, pivo a prosecco', unit: 'guest', price: 290 },
          { key: 'barman', label: 'Barman', unit: 'hour', price: 650 },
          { key: 'cheesecake_dort', label: 'Cheesecake dort', unit: 'event', price: 1290 },
          { key: 'dekorace', label: 'Dekorace a květiny', unit: 'event', price: 4900 },
          { key: 'ozvuceni', label: 'Ozvučení', unit: 'event', price: 3500 },
        ],
        dietary: [
          { key: 'vegetarian', label: 'vegetariánská varianta', surchargePerGuest: 0 },
          { key: 'vegan', label: 'veganská varianta', surchargePerGuest: 60 },
          { key: 'bezlepkove', label: 'bezlepková varianta', surchargePerGuest: 90 },
          { key: 'bez_laktozy', label: 'varianta bez laktózy', surchargePerGuest: 40 },
        ],
        weekendSurchargePct: 10,
        delivery: { includedKm: 15, pricePerKm: 30, maxKm: 100 },
        staff: { guestsPerWaiter: 20, pricePerWaiterHour: 490, minHours: 4, defaultHours: 5 },
        autoSendMaxTotal: 150_000, // OVĚŘIT
      },
    },

    // Kontrakt P2: příchozí poptávky (e-mail i web) → agent.
    inquiryAgent: {
      leadOwnerEmail: 'obchod@mummiesdaddies.com', // OVĚŘIT: schránka obchodu (CSO)
      escalationNode: 'obchod',
      replyFrom: 'lead_owner',
      ccEmails: [],
      maxPerRun: 10,
      dailyAutoSendLimit: 20,
      perRecipientDailyLimit: 2,
      // ask_info odchází sám jen u jasného segmentu; nejasný nebo rozporný
      // segment a nedohledatelné místo akce jdou na posouzení (P2).
      autoSendKinds: ['send_offer', 'ask_info'],
      // Provozovna = výchozí bod výpočtu vzdálenosti (Mapy.cz, za GEO_ENABLED).
      originAddress: 'Varšavská 715, 120 00 Praha 2',
      // Sdílené adresy poptávek: info@ (skupina nebo alias) a vyhrazená
      // schránka s přeposíláním. OVĚŘIT, která z nich u klienta existuje.
      inquiryAddresses: ['info@mummiesdaddies.com', 'poptavky@mummiesdaddies.com'],
      leadMapping: {
        b2b: { pillar: 'b2b_akce', revenueLine: 'catering_firemni' },
        b2c: { pillar: 'b2c_oslavy', revenueLine: 'oslava_soukroma', eventTypeRevenueLines: { svatba: 'svatebni_hostina' } },
        '*': { pillar: 'b2b_akce', revenueLine: 'catering_firemni' },
      },
      // Patičku (údaje firmy, nezávaznost, VOP, upozornění na automat) připojí
      // odchozí fronta při odeslání (P3, capabilities.agentOutbox) — tady žádná.
      dedupWindowDays: 14,
      maxMessageAgeDays: 3,
      modelDailyLimit: 100,
      modelMaxAttempts: 4,
      trustedAuthServId: 'mx.google.com',
    },

    // Kontrakt P4: připomínky neodpovězených nabídek. OVĚŘIT cadence a texty.
    followUpCadence: {
      appliesToPhases: ['nabidka'],
      steps: [
        { afterBusinessDays: 3, template: 'pripominka_1' },
        { afterBusinessDays: 5, template: 'pripominka_2' },
      ],
      maxAttempts: 2,
      sendWindow: { days: [1, 2, 3, 4, 5], fromHour: 9, toHour: 17 },
      dailyLimit: 20,
      onExhausted: 'case',
      lostReasonKey: 'bez_odpovedi',
      escalateNode: 'obchod',
      templates: {
        pripominka_1: {
          subject: 'Jak se vám líbí naše nabídka?',
          body: 'Dobrý den,\n\nposíláme malou připomínku k nabídce na {akce} ({datum}). Rádi cokoli upravíme — stačí odpovědět na tento e-mail.\n\nS pozdravem',
        },
        pripominka_2: {
          subject: 'Držíme vám termín',
          body: 'Dobrý den,\n\ntermín {datum} pro vaši akci zatím držíme. Dejte nám prosím vědět, jestli můžeme nabídku potvrdit, nebo co v ní změnit.\n\nS pozdravem',
        },
      },
    },
  },

  modules: {
    partners: false,
    deliveries: true,
    capacity: false,
    finance: false,
    targetLists: false,
    meetings: false,
    subscriptions: false,
    agent: true,
    web: true,
    shopOrders: true,
  },

  // Zástupná značka (logo dodá klient). Barevné tokeny jsou v app/globals.css.
  brand: {
    logo: '/logo.svg',
    logoAlt: 'Mummies and Daddies',
    symbol: '/symbol.svg',
    headingFont: null,
    tagline: 'Catering, eventy a cheesecaky s rodinnou péčí',
  },

  // Klíče MUSÍ sedět s enumem revenue_line v 0001_base_schema.sql.
  revenueLines: [
    { key: 'catering_firemni', label: 'Firemní catering a akce', category: 'one_time' },
    { key: 'oslava_soukroma', label: 'Soukromá oslava', category: 'one_time' },
    { key: 'svatebni_hostina', label: 'Svatební hostina', category: 'one_time' },
    { key: 'cheesecaky_eshop', label: 'Cheesecaky a e-shop', category: 'one_time' },
    { key: 'firemni_pravidelny', label: 'Pravidelný firemní catering', category: 'recurring' },
    { key: 'pronajem_prostor', label: 'Pronájem eventových prostor', category: 'one_time' },
    { key: 'provize', label: 'Provize a doporučení', category: 'royalty' },
  ],

  dealStageLabels: {
    kvalifikace: 'Poptávka',
    diagnostika: 'Upřesnění',
    rozsah_nabidka: 'Nabídka odeslána',
    rozhodovani: 'Zákazník rozhoduje',
    vyhráno: 'Vyhráno',
    prohráno: 'Prohráno',
    odloženo: 'Odloženo',
  },

  lostReasons: [
    { key: 'cena', label: 'Cena' },
    { key: 'termin', label: 'Termín' },
    { key: 'kapacita', label: 'Kapacita' },
    { key: 'bez_odpovedi', label: 'Bez odpovědi' },
    { key: 'jiny_dodavatel', label: 'Jiný dodavatel' },
    { key: 'jine', label: 'Jiné' },
  ],

  // E-shop cheesecaků (ceník webu, ceny vč. DPH). OVĚŘIT předstih a doručení.
  shop: {
    products: [
      { key: 'daddy_pistacie_malina', label: 'Daddy pistáciovo-malinový', description: 'Pistáciový cheesecake s malinami.', priceCzk: 1290, unit: 'dort', season: null, active: true },
      { key: 'daddy_cokolada_liskovy_orech', label: 'Daddy čokoládovo-lískooříškový', description: 'Čokoládový cheesecake s lískovými oříšky.', priceCzk: 1290, unit: 'dort', season: null, active: true },
      { key: 'mummy_vanilka_ovoce', label: 'Mummy vanilkovo-ovocný', description: 'Vanilkový cheesecake s čerstvým ovocem.', priceCzk: 1090, unit: 'dort', season: null, active: true },
      { key: 'daddy_vanilka_karamel', label: 'Daddy krémový vanilkovo-karamelový', description: 'Krémový vanilkový cheesecake se slaným karamelem.', priceCzk: 1290, unit: 'dort', season: null, active: true },
      { key: 'daddy_vanilka', label: 'Daddy vanilkový', description: 'Klasický americký vanilkový cheesecake.', priceCzk: 790, unit: 'dort', season: null, active: true },
      { key: 'mini_mix', label: 'Mini cheesecaky mix', description: 'Deset mini cheesecaků v různých příchutích.', priceCzk: 575, unit: 'balení 10 ks', season: null, active: true },
      { key: 'mummy_vanilka_pomeranc_vanocni', label: 'Mummy vanilkovo-pomerančový vánoční', description: 'Sezónní vánoční cheesecake s pomerančem.', priceCzk: 1290, unit: 'dort', season: { from: '11-01', to: '12-31' }, active: true },
    ],
    minLeadDays: 2,
    maxLeadDays: 60,
    maxQuantityPerItem: 10,
    pickupAddress: 'Varšavská 715, 120 00 Praha 2',
    delivery: { enabled: false, priceCzk: 0, note: 'Doručení domluvíme individuálně.' },
  },
} as const satisfies CompanyConfig<MdNode, MdPillar>
