/**
 * Články blogu (/blog/[slug]).
 *
 * Šablona stránky je v copy.json (/blog/[slug]: článek, „Hodí se k tomu“,
 * autor, CTA, související). Copy ale nemá samotné texty článků, proto jsou tady
 * TŘI články převzaté ze starého webu (audit, strategy.redirects) a přepsané
 * do tónu nového webu (strategy.positioning: hravý, rodinný, věcný). Obsah
 * drží zdrojové články, nic nového nepřidává:
 *   /post/svatba-catering                         → jak-vybrat-svatebni-catering (Monika Jožková, 7. 4. 2021)
 *   /post/luxusní-večírek-ve-velkém-stylu         → raut-banket-nebo-servirovana-vecere (Týna, 27. 9. 2021)
 *   /post/6-simple-steps-to-plan-a-fantastic-corporate-party → jak-naplanovat-firemni-vecirek (15. 10. 2023, EN → CZ)
 *
 * Ostatní doporučené články z copy (/blog, sekce „doporucene“) zatím text nemají:
 * na výpisu jsou jako karty bez odkazu se zástupcem [DOPLNÍ KLIENT: text článku].
 *
 * Bez JSON importů → bezpečné i pro klienta.
 */
import type { EventType } from '../options'

export type ArticleBlock =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'steps'; items: readonly { title: string; text: string }[] }
  | { type: 'contact' }

export interface BlogArticle {
  slug: string
  title: string
  /** Meta description a perex na výpisu (do 155 znaků). */
  excerpt: string
  /** Štítek = jedna z položek copy /blog → „stitky“. */
  tag: string
  /** Datum původního vydání (ISO). */
  published: string
  modified?: string
  author: { name: string; role: string }
  photoSlot: string
  /** Související služba (box „Hodí se k tomu“) a typ akce pro poptávku. */
  service: { href: string; eventType: EventType }
  blocks: readonly ArticleBlock[]
}

export const CLIENT_ARTICLE_PLACEHOLDER = '[DOPLNÍ KLIENT: text článku]'

export const BLOG_ARTICLES: readonly BlogArticle[] = [
  {
    slug: 'jak-vybrat-svatebni-catering',
    title: 'Jak vybrat svatební catering',
    excerpt: 'Šest rad, jak vybrat svatební catering: jídlo, které chutná vám, rozpočet, včasný výběr, prohlídka místa a plán přípravy, průběhu i úklidu.',
    tag: 'Svatby',
    published: '2021-04-07',
    author: { name: 'Bc. Monika Jožková', role: '[DOPLNÍ KLIENT: role]' },
    photoSlot: 'blog.svatebni-catering',
    service: { href: '/catering/svatby', eventType: 'svatba' },
    blocks: [
      {
        type: 'p',
        text: 'Co ano a co ne? Kdo má co rád, kdo má jakou alergii a bude toho jídla dost? Před svatbou vám hlavou běží milion otázek. Tady je to, co radíme párům, které se na nás obrátí.',
      },
      { type: 'h2', text: 'Svatební jídlo musí chutnat hlavně vám' },
      {
        type: 'p',
        text: 'Vyberte jídlo, které sami milujete. Takové, které vám připomene vaše začátky, první dovolenou a vůně a chutě, které jste objevili spolu. Všem se nezavděčíte nikdy, tak v tenhle den myslete hlavně na to, co máte rádi vy.',
      },
      { type: 'h2', text: 'Šest rad, jak vybrat catering' },
      {
        type: 'steps',
        items: [
          { title: 'Nemějte přehnané nároky', text: 'Všechno mít nejde, pokud zrovna neplánujete svatbu za miliony. Vyberte si, na čem vám záleží nejvíc.' },
          {
            title: 'Řekněte, co máte rádi',
            text: 'Milujete Itálii, Francii nebo Španělsko? Řekněte to rovnou. Nabídku vám připravíme na míru a nebudete mít pocit, že vám nikdo nerozumí.',
          },
          {
            title: 'Určete si rozpočet',
            text: 'Catering není zadarmo. Vycházejte z toho, kolik byste za stejné jídlo zaplatili v restauraci. Pak vás nepřekvapí přemrštěná cena a nepřekvapíte ani sami sebe.',
          },
          {
            title: 'Nenechávejte výběr na poslední chvíli',
            text: 'Cateringovou firmu začněte hledat aspoň půl roku před svatbou. Všechno je potřeba schválit, ochutnat, naplánovat a mít plán B.',
          },
          {
            title: 'Projděte si místo se zástupcem cateringu',
            text: 'Kdo je připraven, není překvapen. Prohlídka ukáže zázemí pro catering, vybavení, vzdálenosti i dopravu, takže v den D neuslyšíte „to jste nám ale neřekli“. Profesionální catering si o prohlídku řekne sám.',
          },
          {
            title: 'Naplánujte přípravu, průběh i úklid',
            text: 'Tyhle tři fáze musí mít jasný plán a vy ho musíte schválit.',
          },
        ],
      },
      { type: 'h2', text: 'Jak svatbu plánujeme my' },
      {
        type: 'p',
        text: 'Když připravuji nabídku, projdu s párem celý průběh a plán svatby. Podle velikosti svatby a počtu svatebčanů plánujeme i den předem nebo víc dní dopředu, abychom včas zajistili třeba i občerstvení pro dodavatele, kteří se starají o techniku nebo zábavu. Pak spolu projdeme svatební den, který se řídí časem obřadu, a probereme i den po svatbě, jestli chcete catering i na první den manželský.',
      },
      {
        type: 'p',
        text: 'Profesionalita cateringových firem se liší stejně jako v každém jiném oboru. Nenechte proto nic bez povšimnutí.',
      },
      { type: 'h2', text: 'Je toho na vás moc?' },
      {
        type: 'p',
        text: 'Zavolejte nebo napište. Konzultace jsou zdarma. Poradíme vám s výběrem jídla, s tím, co je důležité a co ne, a co je pro vás to nejlepší.',
      },
      { type: 'contact' },
      {
        type: 'p',
        text: 'Váš svatební den doplníme tím nejlepším jídlem a pitím, milou a profesionální obsluhou a klidem, protože vaše důvěra je pro nás to nejdůležitější.',
      },
    ],
  },
  {
    slug: 'raut-banket-nebo-servirovana-vecere',
    title: 'Raut, banket, nebo servírovaná večeře?',
    excerpt: 'Opening party, firemní večírek nebo galavečer: kdy zvolit studený či teplý raut, banket, nebo servírovanou večeři a na co myslet u baru.',
    tag: 'Firemní akce',
    published: '2021-09-27',
    modified: '2021-10-27',
    author: { name: 'Týna', role: 'z týmu Mummies & Daddies' },
    photoSlot: 'home.hero.alt-1',
    service: { href: '/catering/spolecenske-akce', eventType: 'spolecenska-akce' },
    blocks: [
      {
        type: 'p',
        text: 'Firemní večírek, velké životní jubileum, opening party nebo svatební hostina. Každá velká událost si zaslouží catering, který vypadá luxusně, chutná a je krásně naaranžovaný. Všechno začíná výběrem prostoru, počtem hostů a stylem akce. Podle nich se vybírá i typ jídla a pití.',
      },
      { type: 'h2', text: 'Opening party a firemní večírky' },
      {
        type: 'p',
        text: 'Otevření nové firmy, restaurace nebo hotelu je chvíle, kdy ukazujete to nejlepší. Hodí se slavnostní raut, který se dobře jí a hosté si u něj nezamažou sváteční oblečení. Proto se nejčastěji volí jednohubky, minidezerty, ovoce, mini řízečky, kanapky a lehká jídla. Vegetariánská nebo bezlepková jídla dnes nejsou problém a častou součástí je i teplý servírovaný raut. Obrázek večera dotvoří dobrá vína a koktejly.',
      },
      { type: 'h2', text: 'Galavečer' },
      {
        type: 'p',
        text: 'Většinou formální akce s předepsaným dress codem: pro pány smoking a motýlek, pro dámy velká večerní. Součástí bývá koncert nebo ples a jídlo odpovídá důležitosti večera. Skvěle se hodí raut, na přání i banket.',
      },
      { type: 'h2', text: 'Banket: nejvyšší forma pohoštění' },
      {
        type: 'p',
        text: 'Banket je luxusní večeře servírovaná u stolů. Jídelní lístek musí být promyšlený do detailu, chody na sebe navazují a k jídlu se párují vína a další nápoje. Na galavečer proto potřebujete zkušenou cateringovou firmu.',
      },
      { type: 'h2', text: 'Teplý raut' },
      {
        type: 'p',
        text: 'U teplého rautu je důležitý zkušený personál, který pomáhá se servírováním a hostům se vším, co potřebují. Jídlo musí mít správnou teplotu v čistých rautových vařičích. Oblíbená jsou masa upravená sous-vide, omáčky, asijská jídla, těstoviny, řízky, ryby nebo losos s citrusy či rajčatovou omáčkou.',
      },
      { type: 'h2', text: 'Studený raut' },
      {
        type: 'p',
        text: 'U studeného rautu si hosté nabírají sami podle chuti a nehrozí polití omáčkou ani opaření horkým jídlem. Je pestrý a každý si v něm vybere. Ideální jsou miniporce, protože na večírku se jí hlavně při konverzaci. Oblíbený je uzený losos, tatarák z telecího masa, grilované krevety, parmská šunka s čerstvým fíkem, sýry z celého světa, čerstvé ovoce a zelenina nebo prosciutto s melounem.',
      },
      { type: 'h2', text: 'Servírovaná večeře' },
      {
        type: 'p',
        text: 'Chcete galavečer dotáhnout k dokonalosti? Pak se hodí slavnostní servírovaná večeře. Každý host má své místo u slavnostně prostřeného stolu s dlouhými bílými ubrusy. Na přípravu je to nejnáročnější forma. Jako hostitel musíte myslet na alergie a výživová omezení hostů, proto je praktické poslat jim menu předem, ať si vyberou.',
      },
      { type: 'h2', text: 'Bar a nápoje' },
      {
        type: 'p',
        text: 'Nemá chybět welcome drink a přípitek, nejlépe šampaňským nebo proseccem. Oblíbené jsou i míchané koktejly a speciality. Přemýšlejte, jak se nápoje hodí k jídlu. Ideální je mobilní bar s alkoholickými i nealkoholickými nápoji.',
      },
      { type: 'h2', text: 'Jsme tu pro vás' },
      {
        type: 'p',
        text: 'U každé akce vycházíme z jejího tématu a důvodu. Podle nich volíme dekorace, program, jídlo i formu cateringu.',
      },
    ],
  },
  {
    slug: 'jak-naplanovat-firemni-vecirek',
    title: 'Jak naplánovat firemní večírek',
    excerpt: 'Šest kroků k povedenému firemnímu večírku: místo, téma, jídlo a pití, program, dárky a ceny, foto a video. Na co nezapomenout.',
    tag: 'Firemní akce',
    published: '2023-10-15',
    author: { name: 'Mummies & Daddies', role: 'tým cateringu' },
    photoSlot: 'vanoce.hero',
    service: { href: '/catering/firemni', eventType: 'firemni' },
    blocks: [
      {
        type: 'p',
        text: 'Konec roku nepřináší jen zimní radosti, ale i příležitost uspořádat skvělý firemní večírek. Je to způsob, jak týmu poděkovat za celoroční práci, oslavit úspěchy firmy, posílit vztahy s klienty a vytvořit v týmu přátelskou atmosféru.',
      },
      { type: 'h2', text: 'Šest věcí, na které při plánování myslete' },
      {
        type: 'steps',
        items: [
          { title: 'Místo', text: 'Prostor musí být dost velký pro všechny hosty a mít zázemí, jako je parkování a toalety.' },
          {
            title: 'Téma',
            text: 'Vymyslete téma podle toho, co baví váš tým, nebo podle sezóny, třeba vánoční. Navodí slavnostní atmosféru a večírek bude originální.',
          },
          {
            title: 'Jídlo a pití',
            text: 'Nezapomeňte na kvalitní catering s pestrým výběrem jídel a nápojů. A myslete na hosty se zvláštními požadavky na stravu.',
          },
          { title: 'Program', text: 'Připravte program, který lidi zabaví a stmelí. Třeba živou hudbu, karaoke nebo profesionálního DJ.' },
          {
            title: 'Dárky a ceny',
            text: 'Malé poděkování za odvedenou práci nebo soutěž o hezké ceny potěší a lidé uvidí, že si jejich práce vážíte.',
          },
          {
            title: 'Foto a video',
            text: 'Fotograf nebo kameraman zachytí vzpomínky a připraví obsah pro sociální sítě nebo firemní intranet.',
          },
        ],
      },
      {
        type: 'p',
        text: 'Firemní večírek je skvělá příležitost stmelit tým a oslavit úspěchy. S pečlivou přípravou, pozorností k detailům a spolehlivými dodavateli bude večírek nezapomenutelný.',
      },
    ],
  },
]

export function blogArticle(slug: string): BlogArticle | undefined {
  return BLOG_ARTICLES.find((a) => a.slug === slug)
}

/** Slug článku z odkazu v copy („… → /blog/sous-vide-v-praxi“). */
export function blogSlugFromHref(href: string | null | undefined): string | null {
  const m = /^\/blog\/([a-z0-9-]+)$/.exec(href ?? '')
  return m ? m[1] : null
}

/**
 * Štítky doporučených článků, které zatím nemají text (redakční zařazení
 * do štítků z copy /blog → „stitky“, aby filtr nebyl prázdný).
 */
export const PLANNED_ARTICLE_TAGS: Readonly<Record<string, string>> = {
  'catering-na-tiskovku-networking-a-roadshow': 'Firemní akce',
  'garden-party-a-grilovani': 'Oslavy',
  'catering-na-oslavu-narozenin': 'Oslavy',
  'finger-food-na-vecirek': 'Oslavy',
  'sous-vide-v-praxi': 'Z kuchyně',
  'terina-z-kachnich-jater': 'Z kuchyně',
  'cheesecake-jako-zazitek': 'Cheesecaky',
}

/** Jiné články (stejný štítek napřed), max. `limit`. */
export function relatedArticles(slug: string, limit = 3): BlogArticle[] {
  const me = blogArticle(slug)
  const others = BLOG_ARTICLES.filter((a) => a.slug !== slug)
  return [...others.filter((a) => a.tag === me?.tag), ...others.filter((a) => a.tag !== me?.tag)].slice(0, limit)
}
