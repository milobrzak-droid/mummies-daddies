# Web v2 — design spec (Mummies and Daddies)

> Podklad pro přestavbu veřejného webu `app/(web)/` a `components/web/`. Cockpit (`app/cockpit`) se **nemění**.
> Autor: UX/art direction. Stav: k implementaci. Datum: 2026-11-06.

**Zadání:** layout a typografický charakter reference *Sliced Bakery Website Landing Page* (Behance 217603763), ale v barvách **Mummies and Daddies**, s novým logem. Obsah zůstává **catering-first**, cheesecaky jsou druhá řada.

**Neměnná pravidla (platí pro celý web):**
- Nic nevymýšlet. Žádné ceny, reference, recenze, počty akcí ani hodnocení, které nejsou v `lib/web/data/*.json`, `lib/web/options.ts` nebo `lib/web/navigation.ts`. Kde údaj chybí, zůstává viditelný zástupce `[DOPLNÍ KLIENT: …]` (`.md-fill` / `PlaceholderText`), jak je dnes.
- CSP: písma a obrázky jen z `'self'`. Písma přes `next/font/google` (self-hosting při buildu), žádné CDN za běhu. Výřezy produktů jsou soubory v `public/web/`.
- Text česky, verzálky jen přes CSS (`text-transform: uppercase`), v DOM zůstávají normální věty (čtečky, SEO, kopírování).
- Tokeny dál žijí v `lib/web/tokens.ts` (jediný zdroj pravdy) a kontrast hlídá `test/web/tokens.test.ts`. Ten test se rozšíří o nové páry z §1.3.
- Next.js 16: před změnou `next/font`, `next/image` a metadat si přečti `node_modules/next/dist/docs/` (AGENTS.md).

---

## 0. Koncept v jedné větě

**„Mummy růžová + Daddy modrá na krémové kuchyňské tabuli“:** krémové pozadí, tmavě kakaová „ink“ na text, 2px linky mřížky a tvrdé offset stíny. Nadpisy jsou obří úzké verzálky (Anton). Jedno slovo v nadpisu svítí malinově (Mummy), nebo modře (Daddy). Produkty „levitují“ jako nalepené samolepky.

### Proč tyhle barvy (rešerše značky)
- **Původní web (mummiesdaddies.com, Wix):** logo je ručně psané písmo (script) v modré **#4669A6** s černým podtitulem „Delicious food and cheesecakes“. Ve Wix motivu jsou dál modrá `#C9D8ED` (světlá), `#4669A6`, `#2F466F` a máta `#9FD3CB` / `#4DAA9A`. Modrá je tedy **původní, nejstarší barva značky**.
- **Náš dosavadní web v1 (`lib/web/tokens.ts`):** malina `#D9466F` / `#C23560`, krém `#FBF6EE`, kakao `#3B2418` a pastely (blush, sage, vanilla, pistachio).
- **Unikátní kombinace = obě dohromady:** *Mummy = malina, Daddy = modrá.* Pojmenování řad cheesecaků to přímo nabízí a v pražském cateringu takovou dvojici nikdo nemá. Kombinace odkazuje na americký diner a pekárnu 50. let, což sedí k „americkým cheesecakům podle originálního receptu“. Světle modrá plocha z reference se tím nahradí **vlastní modrou M&D** (`#D3E0F2`, odvozenou z jejich `#C9D8ED`). Reference tu barvu nemá jen tak: je to barva značky.
- Pastely v1 (sage, pistachio) se **ruší**. Zůstává jen „butter“ (máslová sušenka, korpus cheesecaku) jako třetí, doplňková barva pro štítky.

---

## 1. Paleta (tokeny)

### 1.1 Tokeny

Nahradí objekt `colors` v `lib/web/tokens.ts`. Jména se nesmí potkat s Cockpitem (`ink` je v Cockpitu obsazené), proto má web prefix `md`. Tailwind třídy: `bg-md-cream`, `text-md-ink`…

| Token | Hex | Role |
|---|---|---|
| `md.cream` | `#FBF3E6` | Podklad stránky (krém jako v referenci, teplejší než v1). |
| `md.paper` | `#FFFDF8` | Karty a pole formuláře, buňky mřížky, které potřebují „vystoupit“. |
| `md.ink` | `#2B1810` | Text, nadpisy, **všechny linky (2px)**, obrysy, offset stíny. Tmavé kakao, ne černá. |
| `md.ink-soft` | `#5E4636` | Sekundární text (perexy, popisky). |
| `md.rasp` | `#D23F6B` | **Mummy / hlavní akcent.** Zvýrazněné slovo v nadpisu (≥ 24 px), ikony, tečky, aktivní podtržení. Na krému 4,09 : 1 → **jen velký text a grafika**. |
| `md.rasp-ink` | `#B8305A` | Pozadí primárního tlačítka (krémový text), malinový text pod 24 px, aktivní řádek seznamu. |
| `md.rasp-deep` | `#962248` | Hover / active primárního tlačítka. |
| `md.rasp-tint` | `#F7D6DF` | Růžová plocha (pruhy, štítky, „Mummy“ karty). |
| `md.blue` | `#4669A6` | **Daddy / druhý akcent** (původní barva loga M&D). Zvýrazněné slovo, ikony. |
| `md.blue-ink` | `#36568F` | Modrý text pod 24 px, sekundární plné tlačítko (krémový text). |
| `md.blue-deep` | `#27406E` | Hover sekundárního tlačítka. |
| `md.blue-tint` | `#D3E0F2` | **Náhrada světle modré z reference.** Pruh nadpisu sekce, pozadí „Daddy“ karet, marquee pruh. |
| `md.butter` | `#F6DF9E` | Třetí, doplňková barva: plovoucí štítky, „&“ v logu, badge „Nově“. Nikdy ne na velké plochy. |
| `md.danger` | `#A3261F` | Chyba formuláře (text + 2px rámeček pole). |
| `md.success` | `#2F6B4F` | Úspěch (odeslaná poptávka). |
| `md.warning` | `#8A5A00` | Upozornění (např. termín je za méně než 7 dní). |
| `md.focus` | `#36568F` | Prstenec fokusu (modrý, aby se odlišil od malinových CTA). |

Tmavé verze pro patičku / marquee na ink: `md.rasp-on-ink` `#F48AA8`, `md.blue-on-ink` `#A9C2EA`, text `md.cream`.

**Poměr ploch na stránce (orientačně):** krém 65 % · ink (text, linky, patička) 15 % · blue-tint 8 % · rasp-tint 5 % · plná malina / modrá (CTA, akcentová slova) 5 % · butter 2 %.

### 1.2 Pravidla použití
- **Malina = akce.** Primární CTA („Chci nabídku“) je vždy malinové. Modrá nikdy není primární CTA. Je to druhý hlas (Daddy, informace, sekundární tlačítko, fokus).
- **Akcentové slovo:** v každém H1/H2 nejvýš **jedno** zvýrazněné slovo nebo spojení. Catering sekce → malina, cheesecakové a „o nás“ sekce → střídat malina / modrá podle řady (Mummy malina, Daddy modrá).
- Na `blue-tint` a `rasp-tint` je text vždy `ink` nebo `ink-soft`. Malinový text na blue-tint jen ≥ 24 px (4,35 : 1).
- Linky a obrysy jsou vždy `ink`, 2px (mřížka) / 2.5px (tlačítka, štítky, samolepky). Žádné šedé hairline jako ve v1.

### 1.3 Kontrast (WCAG 2.1 AA, ověřeno výpočtem relativní luminance)

| Popředí / pozadí | Poměr | Použití | AA |
|---|---|---|---|
| ink / cream | 15,36 | text | ✔ |
| ink / paper | 16,65 | text | ✔ |
| ink-soft / cream | 7,93 | sekundární text | ✔ |
| ink / blue-tint | 12,66 | text v pruzích | ✔ |
| ink-soft / blue-tint | 6,53 | perex v pruhu | ✔ |
| ink / rasp-tint | 12,60 | text | ✔ |
| ink-soft / rasp-tint | 6,50 | perex | ✔ |
| ink / butter | 12,87 | text štítku | ✔ |
| cream / rasp-ink | 5,28 | **primární tlačítko** | ✔ |
| paper / rasp-ink | 5,72 | tlačítko na kartě | ✔ |
| cream / rasp-deep | 7,28 | hover tlačítka | ✔ |
| rasp-ink / cream | 5,28 | malý malinový text, odkaz | ✔ |
| rasp / cream | 4,09 | **jen ≥ 24 px / 19 px tučně**, grafika | ✔ velký |
| blue / cream | 4,98 | akcentové slovo, text | ✔ |
| blue-ink / cream | 6,61 | modrý text, sek. tlačítko | ✔ |
| cream / blue-ink | 6,61 | text na sek. tlačítku | ✔ |
| rasp-ink / blue-tint | 4,35 | jen velký text | ✔ velký |
| blue-ink / rasp-tint | 5,42 | text | ✔ |
| danger / cream | 6,68 | chyba | ✔ |
| success / cream | 5,71 | úspěch | ✔ |
| warning / cream | 5,38 | upozornění | ✔ |
| cream / ink | 15,36 | patička | ✔ |
| ink / rasp | 3,76 | **nepoužívat pro text** (ani tmavý text na plné malině) | ✘ |
| ink / blue | 3,09 | **nepoužívat pro text** | ✘ |

Netextové prvky (1.4.11): 2px ink linka na krému 15:1 ✔, prstenec fokusu blue-ink na krému 6,6:1 ✔.

---

## 2. Logo (nové)

Soubory (vektorové cesty, žádné runtime písmo, CSP-safe): `docs/web-v2-logo/`. Náhled je `nahled.png`.

| Soubor | Použití |
|---|---|
| `md-logo-horizontal.svg` | Header (desktop i mobil), e-maily, PDF nabídky. |
| `md-logo-horizontal-dark.svg` | Na `ink` (patička, marquee na tmavé). |
| `md-logo-stacked.svg` | Hero patičky, OG obrázek, tisk, zástěry a krabice. Obsahuje podtitul „CATERING · CHEESECAKY · PRAHA“. |
| `md-badge.svg` | Kulatá „samolepka“ (ikona + offset stín): avatar na sociálních sítích, razítko na krabici cheesecaku. |
| `md-favicon.svg` | Favicon / apple-touch-icon (převést na `app/icon.svg` + PNG 180 px **jen pro web route group**, Cockpit si nechá svůj). |

**Konstrukce:**
- **Slovní značka:** „MUMMIES“ malinově `#D23F6B`, „DADDIES“ modře `#4669A6`, obojí Anton (stejné písmo jako nadpisy webu → logo a web drží pohromadě). Mezi nimi je ručně psaný „&“ (Yellowtail, převedený na křivky) v ink. Je to přímá **pocta původnímu ručně psanému logu** M&D a zároveň jediný ručně psaný prvek na celém webu.
- **Symbol:** dílek cheesecaku ve 3/4 pohledu: máslový korpus (butter), krémové tělo, malinová poleva se stékajícími kapkami a „třešeň“ ve tvaru srdce (mummies & daddies = rodina). Obrys je 2.6px ink, stejný jazyk jako tlačítka a mřížka.
- **Stacked verze:** dvě řádky nad sebou, „&“ v kulaté máslové samolepce s ink offset stínem, která přesahuje konec řádku DADDIES.
- **Ochranná zóna:** výška písmene „M“ ze všech stran. **Minimum:** horizontální 120 px šířky (v headeru bude 200–240 px), favicon 16 px (jen symbol).
- **Zakázáno:** přebarvit „MUMMIES“ a „DADDIES“ na jednu barvu (výjimka: monochromní ink pro razítka a fax), dávat logo na fotku bez krémového podkladu, deformovat.
- **Implementace:** `components/web/Logo.tsx` vykreslí inline SVG z `md-logo-horizontal.svg` (cesty zkopírovat, `aria-label="Mummies and Daddies – úvod"`, `<title>`). Na mobilu se používá stejné horizontální logo (při výšce 32 px má šířku ~188 px a vejde se). Samotný symbol jen jako favicon. Starý `public/logo.svg` (oranžové kolečko, systémové písmo) patří Cockpitu, **neměnit**.
- Symbol je kreslený ručně ve 64×64 mřížce. Pokud ho bude klient chtít doladit grafikem, zachovat: 3/4 pohled, 3 vrstvy (korpus / krém / poleva) a srdíčko navrchu.

---

## 3. Typografie

### 3.1 Volba písma — test češtiny (Playwright, Chromium, Google Fonts latin + latin-ext)

Testováno „NEZAPOMÍNÁ ŘÍZEK ŽŮŽO · ĚŠČŘŽÝÁÍÉŮÚ ĎŤŇ Ó“ a víceřádkové „ŘÍZEK / ŽŮŽO / ĎÁBEL“ při 96–110 px. Snímky: `docs/web-v2-logo/test-diakritika-fonty.png`, `test-diakritika-radkovani.png`.

| Písmo | Glyfy CZ | Výsledek |
|---|---|---|
| **Anton 400** | všechny ✔ (latin-ext) | Nejbližší referenci (velmi tučné, úzké). **Pozor:** verzálky mají vysokou výšku a háčky / kroužky leží nad ascenderem. Při `line-height` 0,95 se háček „Ž“ **srazí** s řádkem nad ním a při 1,1 se dotýká. **Při 1,15+ je čisto.** Akcenty navíc přesahují box řádku nahoru, takže v kontejneru s `overflow:hidden` je useknou. |
| Bebas Neue 400 | všechny ✔ | Čisté i při 0,88, ale je jen jeden řez a působí tenčí, „plakátově“ ne „pekařsky“. Záloha. |
| Oswald 700 | všechny ✔ | Kolize při 1,0. Je širší a méně charakterní. |
| League Gothic / Antonio / Barlow Cond. 800 / Archivo 62 % | všechny ✔ | Funkční, ale slabší výraz než Anton. |

**Rozhodnutí:**
- **Display: Anton 400** (`next/font/google`, `subsets: ['latin','latin-ext']`, `weight: '400'`, `display: 'swap'`, `variable: '--font-md-display'`). Fallback stack: `'Anton', 'Bebas Neue', 'Arial Narrow', Impact, sans-serif`. `adjustFontFallback` nechat výchozí.
- **Text: Manrope** (už ho máme: `--font-md-text`, latin-ext, variabilní 200–800). Je čitelný, moderní, s geometrií, která k Antonu sedí. Pro UI a text 400/500, pro štítky a tlačítka 700.
- **Cormorant Garamond se ruší** (odstranit z `lib/web/fonts.ts`). Ušetří ~60 kB.
- Yellowtail se **nenačítá**. Je jen v logu jako křivky.

### 3.2 Pravidla pro Anton (povinná)
1. `line-height` víceřádkových nadpisů ≥ **1.12** (hero 1.12, h1/h2 1.15). Nikdy pod 1.1.
2. Kontejner s `overflow:hidden` (marquee, karty s ořezem) musí mít `padding-block-start: 0.18em`, jinak se usekne háček nad Ř/Ž/Ď.
3. `letter-spacing: 0.005em` (Anton je sám dost těsný). Žádné prostrkání jako ve v1.
4. `text-wrap: balance`, `hyphens: manual`. Na mobilu nesmí žádné slovo přetéct. Nejdelší česká slova v nadpisech („NEZAPOMÍNÁ“, „OCHUTNÁVKA“, „TEAMBUILDING“) **otestovat při 360 px**, případně snížit min. clamp.
5. Anton má jen 400: nikdy `font-bold` (prohlížeč by dělal falešné tučné).
6. Malá písmena Antonem nepsat (jen verzálky). Text, perexy a UI jsou Manrope.

### 3.3 Stupnice (fluidní 360 → 1440 px)

| Token | Písmo | Velikost | line-height | Pozn. |
|---|---|---|---|---|
| `mega` | Anton | `clamp(3.25rem, 1.2rem + 9vw, 9.5rem)` | 1.12 | Hero H1, marquee |
| `h1` | Anton | `clamp(2.5rem, 1.4rem + 4.8vw, 5.5rem)` | 1.15 | H1 podstránek |
| `h2` | Anton | `clamp(2rem, 1.3rem + 3vw, 4rem)` | 1.15 | Pruh nadpisu sekce |
| `h3` | Anton | `clamp(1.375rem, 1.15rem + 1vw, 1.875rem)` | 1.2 | Karta, řádek seznamu |
| `label` | Manrope 700 | `0.8125rem` | 1.2 | Štítky, eyebrow; verzálky, tracking 0.08em |
| `lead` | Manrope 400 | `clamp(1.0625rem, 1rem + 0.35vw, 1.3125rem)` | 1.55 | Perex |
| `copy` | Manrope 400 | `1rem` (17 px od lg: `1.0625rem`) | 1.65 | Text |
| `small` | Manrope 500 | `0.875rem` | 1.5 | Popisky |
| `btn` | Manrope 700 | `1rem` | 1 | Tlačítka (bez verzálek) |

Max. šířka textu je 62ch (`web-prose`).

---

## 4. Rámování, mřížka, stíny, pohyb (globální systém)

- **Mřížka panelů („rámovaný layout“):** stránka je jeden rám s 2px ink linkami. Sekce se oddělují `border-top: 2px solid ink`. Buňky uvnitř sekcí (karty, sloupce) se dělí 2px linkami **sdílenými** (žádné dvojité čáry): grid s `gap: 2px` na pozadí `ink` a buňky s vlastním pozadím (cream/paper/tint). To je nejjednodušší způsob, jak dostat přesné jednoduché linky.
- **Kontejner:** max. šířka 90rem (`web-wide`). Na ≥ 1440 px má rám po stranách svislé 2px linky (`border-inline: 2px solid ink`) a mimo něj je krém. Uvnitř buňky padding `clamp(1.25rem, 0.8rem + 2vw, 3rem)`.
- **Zaoblení:** tlačítka a štítky jsou pilulka (`9999px`). Buňky mřížky a fotky ve mřížce mají **0** (ostré, jako reference). Fotky „samolepky“ a výřezy mají 1.25rem nebo kruh.
- **Offset stín (neo-brutalist):** `box-shadow: 4px 4px 0 0 var(--md-ink)` pro tlačítka a štítky, `6px 6px 0 0` pro karty a samolepky, `8px 8px 0 0` pro formulář. Žádné rozmazané stíny (`shadow.lift/float` z v1 zrušit).
- **Obrysy:** tlačítka a štítky 2.5px ink, pole formuláře 2px ink.
- **Pohyb:**
  - *Levitace výřezů:* `@keyframes md-float { 0%,100% { transform: translateY(0) rotate(var(--r)) } 50% { transform: translateY(-10px) rotate(calc(var(--r) + 1.5deg)) } }`, 5–7 s, `ease-in-out`, infinite. Každý výřez má jiné `--r` (−14° až +12°) a `animation-delay` (0 / −1.7 / −3.1 s), aby se nehýbaly unisono.
  - *Marquee:* `translateX(-50%)` za 28 s linear infinite. Obsah je v DOM dvakrát, druhá kopie má `aria-hidden`. **Pozastavit na hover a focus-within.**
  - *Stisk tlačítka:* hover `translate(-2px,-2px)` a stín 6px. Active `translate(4px,4px)` a stín 0 (tlačítko se „zamáčkne“ do stínu). 120 ms.
  - *Vstup sekcí:* jen `md-rise` z v1, žádný parallax.
  - `prefers-reduced-motion: reduce`: levitace a marquee **vypnuté** (marquee se změní na statický řádek, který se zalomí), stisk bez posunu, jen změna barvy. Stávající globální pravidlo v `web.css` zůstává, levitace a marquee navíc dostanou explicitní `animation: none`.
- **Fokus:** `outline: 3px solid md.focus; outline-offset: 3px` a u pilulek `border-radius` dědí. Na tmavé ploše `outline-color: md.butter`.

---

## 5. Komponenty

Pro každou: anatomie → stavy → mobil (390 px). Názvy souborů jsou návrh v `components/web/v2/` (nebo přepsat stávající se stejným API, viz §7).

### 5.1 Horní lišta (TopBar)
- Pruh 36 px, pozadí `ink`, text `cream` Manrope 500 14 px, na střed: „Nabídku cateringu dostanete do 1 pracovního dne · +420 737 818 694“ (text už je z `REALISTIC_RESPONSE`, telefon z `COMPANY`). Telefon je `tel:` odkaz.
- **Mobil:** jen „Nabídka do 1 pracovního dne“ a ikona telefonu vpravo (tap target 44 px).

### 5.2 Header
- Výška 80 px (desktop), pozadí `cream`, spodní 2px ink linka, sticky. Při scrollu > 8 px se pozadí změní na `paper` (bez stínu, linka stačí).
- Vlevo `md-logo-horizontal` (výška 40 px). Uprostřed navigace Manrope 600 16 px ink (Catering ▾, Svatby, Reference, Prostory, Cheesecaky, O nás). Hover je 3px malinové podtržení s offsetem 6 px, aktivní stránka má trvalé podtržení a `aria-current="page"`.
- Vpravo ikona telefonu, ikona košíku (s počtem v butter kolečku s ink obrysem) a **pilulkové CTA „Chci nabídku“**: `rasp-ink` pozadí, cream text, obrys 2.5px ink, stín 4px ink, výška 48 px, padding-x 24 px.
- **Mega-menu Catering:** panel `paper`, 2px ink rám, stín 8px. Uvnitř mřížka 4×2 buněk oddělených 2px linkami: název (Anton h3), popis (small), `meta` (štítek, např. „od 15 osob“, z `navigation.ts`). Hover buňky = `blue-tint`.
- **Mobil:** výška 64 px, logo 32 px vysoké, vpravo košík + CTA „Nabídka“ (`mobileLabel`, 44 px) + hamburger (44×44, 2px ink obrys, kruh). Menu je fullscreen krém. Položky Anton 2.5rem s 2px linkami mezi řádky a šipkou → vpravo, dole velké CTA přes celou šířku.

### 5.3 Tlačítka
| Varianta | Pozadí | Text | Obrys | Stín |
|---|---|---|---|---|
| `primary` | rasp-ink → hover rasp-deep | cream | 2.5px ink | 4px ink |
| `secondary` | blue-ink → hover blue-deep | cream | 2.5px ink | 4px ink |
| `outline` | cream → hover butter | ink | 2.5px ink | 4px ink |
| `link` | — | ink, podtržení 2px rasp | — | — |

Výška 52 px (lg), 44 px (sm, minimum dotyku). Ikona šipky → za textem se na hover posune o 4 px. Disabled: pozadí `#E6DACB`, text ink-soft, bez stínu, `cursor:not-allowed`. Loading: spinner 16 px vlevo, text zůstává, `aria-busy`.

### 5.4 Štítky (Pill / FloatingTag)
- Pilulka: Manrope 700 13–15 px, padding 8×14, obrys 2px ink, stín 3px ink. Pozadí `paper`, `butter`, `rasp-tint` nebo `blue-tint`. Volitelná ikona 16 px nebo emoji-free piktogram (žádné emoji).
- *Plovoucí štítek* = štítek s `position:absolute`, natočením −6° až +6° a levitací se zpožděním. Text **jen z faktů** (viz §6).
- Mobil: max. 2 plovoucí štítky na obrázek, ostatní se vyrovnají pod obrázek do řádku (`flex-wrap`).

### 5.5 Hero (homepage)
**Desktop (≥ 1024 px):** buňka přes celou šířku, krém, min-height `calc(100svh - 116px)` (max 860 px).
- Uprostřed 3 řádky `mega` Anton, centrované:
  „KAŽDÁ AKCE SI ZASLOUŽÍ“ / „<span rasp>POŘÁDNÝ</span> CATERING“. Alternativa ke schválení klientem: „CATERING, NA KTERÝ SE / <rasp>NEZAPOMÍNÁ</rasp>“ (dnešní claim, doporučuji ponechat kvůli kontinuitě). Akcentové slovo je vždy jen jedno.
- Pod tím `lead` (max. 46ch, centrovaný): dnešní perex z `heroData()` (firemní akce, svatby a oslavy v Praze i po celé ČR, šéfkuchařská kuchyně z fine diningu, cheesecaky podle amerického receptu).
- Dvě tlačítka: `primary` „Chci nabídku do 1 pracovního dne“ → `/poptavka` a `outline` „Prohlédnout menu a ceny“ → `/catering`.
- Řádek důvěry (small, ink-soft): „Vaříme od roku 2018 · [DOPLNÍ KLIENT: počet akcí za rok] akcí ročně“ (ponechat zástupce).
- **Plovoucí výřezy (5–6 ks) kolem nadpisu**, absolutně, jako v referenci. Rozložení (procenta šířky / výšky hero):
  1. vlevo nahoře (x 4 %, y 8 %, w 15 %, r −12°): výřez **Mummy vanilkovo-ovocný** (kruh nebo samolepka)
  2. vpravo nahoře (x 80 %, y 6 %, w 16 %, r +10°): **Daddy pistáciovo-malinový**, pohled shora (kruh)
  3. vlevo dole (x 6 %, y 62 %, w 17 %, r +8°): **chlebíčky / jednohubky** (samolepka se zaoblením)
  4. vpravo dole (x 76 %, y 60 %, w 18 %, r −8°): **mini cheesecake** (výřez)
  5. drobnosti (w 5–7 %): **malina, borůvka, plátek citronu, lístek bazalky**. Jsou to výřezy z fotek cheesecaků a caprese, nebo jednoduché SVG ilustrace v duchu loga (obrys 2px ink).
  Výřezy se nesmí překrýt s textem: textový blok má `position:relative; z-index:2` a pod ním je neviditelná „safe zone“ (max-width 70 %).
- Pod hero je **rychlý start (QuickStartCard)** jako orámovaný panel přes celou šířku (viz §5.12, kompaktní varianta): typ akce · datum · počet osob · tlačítko „Spočítat nabídku“.

**Mobil (390 px):** nadpis `mega` při 360–390 px vychází ~52 px na 4 řádky, zarovnaný vlevo. Výřezy: jen 3, menší (w 28–34 %). Jeden vpravo nahoře nad nadpisem (částečně přes okraj, `right:-6%`), dva pod tlačítky v řadě, natočené, s levitací. Drobnosti zmizí. Tlačítka jsou pod sebou, přes celou šířku, 52 px. Hero nemá min-height, obsah určuje výšku.

**LCP:** první výřez (vpravo nahoře) `priority`, ostatní `loading="lazy"`. Výřezy jsou WebP s alfou a mají dané `width/height` (žádný CLS).

### 5.6 Pruh nadpisu sekce (SectionBand)
- Buňka přes celou šířku, pozadí `blue-tint` (výchozí) nebo `rasp-tint` / `cream`, 2px ink linky nahoře i dole.
- Uvnitř: vlevo `h2` Anton s jedním akcentovým slovem, vpravo (desktop) krátký perex `lead` max. 38ch a / nebo `outline` tlačítko „Vše →“. Padding-y `clamp(2rem, 1.4rem + 2.5vw, 3.5rem)`.
- **Mobil:** všechno pod sebou, zarovnané vlevo, tlačítko je pod perexem.
- Komponenta: `<SectionBand title="Na jakou akci vaříme?" accent="akci" tone="blue" lead="…" action={…} />`. `accent` je podřetězec titulku, který se obalí `<span class="text-md-rasp">`.

### 5.7 Karty kategorií cateringu (CategoryGrid)
- Reference: řada 3 orámovaných buněk s produktem a malým popiskem. U nás je to **9 typů akcí** z `CATERING_MENU` + Svatby: desktop 3 sloupce × 3 řádky, buňky dělené 2px linkami (grid gap 2px na ink).
- Buňka (pozadí cream, hover `rasp-tint` u lichých / `blue-tint` u sudých):
  - nahoře `label` štítek s `meta` („od 15 osob“), vlevo nahoře,
  - uprostřed **produkt jako samolepka/výřez** (fotka v kruhu nebo zaobleném čtverci s 2.5px ink obrysem a 6px stínem, natočená −4°/+4°), poměr 1:1, šířka 62 % buňky,
  - dole `h3` Anton („FIREMNÍ CATERING“) a `small` popis (z `navigation.ts`), vpravo kruhové tlačítko → 44 px (ink obrys).
  - Celá buňka je jeden odkaz (`<a>` přes kartu, nadpis je jeho text). Hover: samolepka se narovná (rotate 0) a zvedne o 6 px, šipka se posune.
- **Mobil:** 1 sloupec, ale **kompaktní řádky**: samolepka 88 px vlevo, vpravo název + meta + šipka. Linky mezi řádky zůstávají. 9 řádků × ~112 px. Varianta „karusel“ se nepoužívá (horší dohledatelnost).

### 5.8 Seznam formátů + velký produkt (FormatExplorer) — náhrada sekce „Awesome flavors“
**Desktop:** buňka rozdělená 5/12 : 7/12 svislou 2px linkou.
- **Vlevo seznam** řádků (každý 72–84 px, 2px linky mezi řádky): Anton h3 název + vpravo šipka →. Aktivní řádek: pozadí `rasp-ink`, text cream, šipka cream a otočená o 0° (jinak −45°). Hover neaktivního = `rasp-tint`.
  Řádky (pořadí): **Snídaně · Coffee break · Oběd · Raut · Finger food · BBQ & live cooking · Svatba**.
- **Vpravo** velká fotka vybraného formátu (samolepka s 2.5px obrysem a 8px stínem, rotate −2°, zaoblení 1.25rem) a kolem ní **3–4 plovoucí štítky** s fakty (viz tabulka). Pod fotkou je krátký popis (`copy`, 2–3 věty z copy.json dané podstránky) a odkaz „Více o formátu →“.
- **Přístupnost:** je to **tablist** (`role="tablist"`, `aria-orientation="vertical"`). Řádky jsou `role="tab"` s `aria-controls`, ovládání šipkami ↑/↓ a Home/End, panel `role="tabpanel"`. Bez JS se vykreslí všechny panely pod sebou (progressive enhancement), nebo se použije `<details>`.
- Výměna obsahu: crossfade 220 ms, štítky „přiletí“ se staggerem 60 ms. Při reduced motion okamžitě.

| Formát | Fotka (velká) | Plovoucí štítky (jen fakta) | Odkaz |
|---|---|---|---|
| Snídaně | `home-grid-snidane.jpg` | „Snídaňový bufet od 15 osob“, „Americká snídaně od 10 osob“, „Zdravá snídaně od 2 osob“ | `/catering/snidane` |
| Coffee break | `catering-coffee-break-gallery.jpg` | „Od 15 osob“, „15–45 minut“, „Mini dezerty a minisendviče“, „I s rolováním sushi“ | `/catering/coffee-break` |
| Oběd | `catering-obedy-hero.jpg` | „Bufet nebo Šéfkuchařovo menu“, „Dovezeme až na místo“, „Firemní obědy od 4 osob“ | `/catering/obedy` |
| Raut | `catering-formats-raut.jpg` | „Studený i teplý“, „Profesionální obsluha“, „[DOPLNÍ KLIENT: minimum osob pro raut]“ | `/catering/spolecenske-akce` |
| Finger food | `catering-formats-finger-food.jpg` | „Jednohubky ve skleničkách“, „Na opening i networking“, „Od 15 osob“ | `/catering/spolecenske-akce` |
| BBQ & live cooking | `catering-formats-bbq-live-cooking.jpg` | „Šéfkuchař griluje na místě“, „Teambuilding od 8 osob“ | `/catering/teambuilding` |
| Svatba | `catering-svatby-hero.jpg` | „Svatební hostina“, „Sladký bar a dort“, „Prostory na výběr“ | `/catering/svatby` |

(Minima jsou z `lib/web/data/facts.json` a `navigation.ts`. Co tam není, zůstane jako zástupce.)

**Mobil:** seznam zůstává nahoře jako **vodorovně rolovatelný pás pilulek** (scroll-snap, 2px obrys, aktivní je plná malina). Pod ním fotka přes celou šířku (poměr 4:5), 2 štítky na fotce, zbytek pod ní v řádku, potom popis a odkaz. Pás pilulek má na okrajích fade (maska) a má `aria` stejné jako tablist (horizontal).

### 5.9 Cheesecaky Mummy & Daddy (CheesecakeExplorer)
Stejná komponenta jako 5.8, ale s **druhou barvou**:
- Pruh nadpisu `rasp-tint`: „<rasp>MUMMY</rasp> & <blue>DADDY</blue> CHEESECAKY“. Tady **výjimečně dvě akcentová slova**, protože jsou to jména řad. Perex z copy.json („Pečeme podle originálního amerického receptu…“) včetně `[DOPLNÍ KLIENT: čím se řady Daddy a Mummy liší]`.
- Vlevo seznam příchutí ze `CHEESECAKES` (`lib/web/options.ts`), seskupený podle řady se dvěma mezititulky (`label`): **DADDY** (modrá tečka) a **MUMMY** (malinová tečka) a **MINI**. Aktivní řádek Daddy = `blue-ink` plocha, Mummy = `rasp-ink`.
- Vpravo je **výřez produktu** (bez pozadí, levituje) na kruhovém „talíři“ `blue-tint` / `rasp-tint` s 2px ink obrysem. Kolem něj jsou plovoucí **štítky ingrediencí odvozené jen z názvu příchuti** (Daddy vanilkový → „Vanilka“, „Máslové sušenky“ (z copy.json); pistáciovo-malinový → „Pistácie“, „Maliny“; čokoládovo-lískooříškový → „Čokoláda“, „Lískové oříšky“; vanilkovo-karamelový → „Vanilka“, „Karamel“; Mummy vanilkovo-ovocný → „Vanilka“, „Ovoce“; vánoční → „Vanilka“, „Pomeranč“, „Sezónní“; Mini → „10 ks“, „Mix příchutí“). Cena je jen z `options.ts` a jen jako `PriceTag` pod produktem. Tlačítka `primary` „Do košíku“ (QuickAddButton) a `link` „Detail“.
- Pod sekcí je řádek „Cheesecaky i na vaši akci → coffee break / sweet bar“ (odkaz na `/catering/coffee-break`).
- **Mobil:** stejné jako 5.8 (pilulky, každá pilulka má barevnou tečku řady).

### 5.10 Recenze / reference (Testimonials) — BEZ vymýšlení
- Reference má hvězdičky a fotky lidí. **My hvězdičky nepoužíváme** (nemáme ověřené hodnocení). Sekce se jmenuje „CO ŘÍKAJÍ <rasp>HOSTÉ</rasp>“.
- Mřížka 3 buněk (2px linky). Každá buňka má velké uvozovky „ Anton 6rem v `rasp`, citát a jméno.
- **Obsah:** jen skutečné texty z `copy.json` / `lib/web/duvera` (reference Jitka & Rostislav, Katka & Jirka, Bvlgari). Pokud k nim citát **není**, buňka obsahuje `[DOPLNÍ KLIENT: citát klienta + souhlas se zveřejněním]` a místo fotky osoby kruh `rasp-tint` s ikonou příboru (žádné fiktivní iniciály ani tváře). Fotky akcí, které máme (`home-references-*.jpg`), se dají použít jako kruhové „avatary akce“ s 2.5px obrysem.
- CTA pod mřížkou: `outline` „Všechny reference →“ `/reference`.
- **Mobil:** 1 sloupec, max. 3 položky, bez karuselu.

### 5.11 Obří typografický marquee (BigMarquee)
- Buňka přes celou šířku, 2px linky. **Pod textem je fotka** (`catering-formats-raut.jpg` nebo `home-hero.jpg`, `object-fit:cover`, výška `clamp(18rem, 12rem + 20vw, 34rem)`), přes ni překryv `ink` 35 %.
- Text: `mega` × 1.3, Anton, cream, opakovaně „CATERING • CHEESECAKY • CATERING • CHEESECAKY •“. Oddělovač „•“ v `rasp-on-ink`. Každé druhé slovo jako obrysové písmo (`-webkit-text-stroke: 2px cream; color: transparent`). Pozor, u Antonu otestovat čitelnost háčků (u CATERING / CHEESECAKY žádné nejsou, OK).
- Plovoucí štítky (jen fakta) přes fotku: „Nabídka do 1 pracovního dne“ (butter), „Praha i celá ČR“ (paper), „Vaříme od roku 2018“ (rasp-tint), „Cheesecaky podle amerického receptu“ (blue-tint).
- `overflow:hidden` + `padding-block-start: 0.18em` (viz §3.2). Pro čtečky `aria-hidden="true"` na pohyblivý pruh a vedle `sr-only` věta „Catering a cheesecaky“.
- **Mobil:** výška 15rem, text 4.5rem, štítky jen 2, pod sebou vlevo dole. Při reduced motion statický, zalomený text.

### 5.12 Poptávkový formulář (InquiryWizard / QuickStart / FinalInquiry)
- Panel `paper`, 2px ink rám, 8px ink stín, zaoblení 0 (desktop) / 0 (mobil). Nadpis panelu Anton h2 „SPOČÍTEJTE SI <rasp>NABÍDKU</rasp>“.
- **Pole:** výška 52 px, 2px ink obrys, pozadí cream, radius 0.75rem, label nad polem Manrope 700 14 px (ne placeholder místo labelu). Focus = obrys `blue-ink` 3px + vnější prstenec. Chyba = obrys `danger`, ikona a text chyby pod polem (`aria-describedby`, `aria-invalid`). Úspěch kroku = zelená fajfka v kroužku.
- **Volba typu akce:** místo selectu dlaždice-pilulky (radio group): 2px ink obrys, vybraná = `rasp-ink` výplň, cream text, 3px stín.
- **Kroky wizardu:** horní ukazatel jako řada 2px orámovaných buněk „1 Akce · 2 Termín a hosté · 3 Menu · 4 Kontakt“. Aktivní buňka `blue-tint`, hotová má ✓.
- `EstimateCard` (orientační cena): **jen z `companyPriceGuide`**, jinak zástupce. Vizuál: butter buňka, cena Anton h2.
- Turnstile zůstává (CSP už je vyřešená v1).
- **FinalInquiry na konci homepage:** 2 sloupce, vlevo pruh `rasp-tint` s nadpisem „POPIŠTE NÁM SVOU AKCI, DO <rasp>1 PRACOVNÍHO DNE</rasp> MÁTE NABÍDKU“ + kontakty (Monika, Ruda – jen fakta z COMPANY) a fotka týmu jako samolepka (`o-nas-team-1.jpg`). Vpravo QuickStart formulář.
- **Mobil:** jeden sloupec, pole 100 %, tlačítko odeslat přes celou šířku, sticky spodní lišta s „Odeslat poptávku“ jen ve wizardu na `/poptavka` (respektuje safe-area).

### 5.13 Footer
- Pozadí `ink`, text cream, horní 2px linka. Nahoře velký pruh: `md-logo-stacked` v inverzní variantě (MUMMIES `rasp-on-ink`, DADDIES `blue-on-ink`, podtitul cream) a vedle CTA `primary` „Chci nabídku“ a telefon a e-mail velkým Manrope 700.
- Pod tím mřížka 4 sloupců oddělených 1px linkami `cream/20 %`: Catering · Mummies & Daddies · Cheesecaky · Kontakt (z `FOOTER_NAV`). Sociální sítě jsou kruhy 44 px s cream obrysem.
- Spodní řádek: právní údaje z COMPANY (IČO, sídlo, spisová značka), Obchodní podmínky, Ochrana osobních údajů, Nastavení cookies.
- **Mobil:** sloupce jako akordeony (`<details>`), kontakt vždy rozbalený, logo stacked 220 px.

### 5.14 Ostatní stavy
- **Odkazy v textu:** ink, podtržení 2px `rasp`, offset 0.2em. Hover: podtržení `rasp-ink` 3px.
- **Zástupce `[DOPLNÍ KLIENT: …]`:** zůstává čárkovaný rámeček, ale 2px `rasp-ink` čárkovaný a pozadí `butter` 40 %. Musí být vidět, nesmí působit jako hotový obsah.
- **Prázdný košík, 404:** velký Anton nadpis + jeden výřez cheesecaku levitující + `primary` CTA.
- **Skeleton / loading obrázků:** pozadí `rasp-tint` / `blue-tint` podle sekce (žádná šedá).

---

## 6. Homepage — pořadí sekcí

Každá sekce začíná 2px linkou a celá stránka je jeden rám.

| # | Sekce | Komponenta | Pozadí | Obsah (zdroj) |
|---|---|---|---|---|
| 0 | Horní lišta | TopBar | ink | `REALISTIC_RESPONSE`, telefon |
| 1 | Header | Header | cream | nav z `navigation.ts`, CTA |
| 2 | **Hero** s plovoucími výřezy | Hero v2 | cream | `heroData()` |
| 3 | Rychlý start (kompaktní formulář) | QuickStartCard v2 | paper | `quickStartData()` |
| 4 | Pruh „NA JAKOU <rasp>AKCI</rasp> VAŘÍME?“ + mřížka 9 typů akcí | SectionBand (blue) + CategoryGrid | blue-tint / cream | `eventGridData()` |
| 5 | Pruh „VYBERTE SI <rasp>FORMÁT</rasp>“ + seznam formátů s produktem | SectionBand (cream) + FormatExplorer | cream | §5.8 |
| 6 | **Marquee** „CATERING • CHEESECAKY“ přes fotku se štítky | BigMarquee | foto + ink | §5.11 |
| 7 | Proč my (4 buňky: šéfkuchařská kuchyně, nabídka do 1 prac. dne, servis, zážitek navíc) | SectionBand (rasp-tint) + 4-sloupcová mřížka s ikonami v kruhu 2px | rasp-tint / cream | `whyUsData()` |
| 8 | Vařili jsme pro… (reference) + citáty | SectionBand (cream) + Testimonials | cream | `referencesData()`, §5.10 |
| 9 | Z naší kuchyně (galerie 6 samolepek v mřížce, různě natočených) | Kitchen v2 | blue-tint | `kitchenData()` |
| 10 | Jak to funguje (4 kroky: velká čísla Anton v `rasp` v orámovaných buňkách, mezi nimi šipky) | HowItWorks v2 | cream | `howItWorksData()` |
| 11 | **Mummy & Daddy cheesecaky** | SectionBand (rasp-tint) + CheesecakeExplorer | rasp-tint / cream | §5.9 |
| 12 | Prostory (3 buňky s fotkami, ostrý ořez, popisky v pilulce) | Venues v2 | cream | `venuesData()` |
| 13 | Tým (fotka Moniky a Rudy jako 2 samolepky + text, podpis „Vaše Mummy & Daddy“ v `rasp` Anton) | Team v2 | blue-tint | `teamData()` |
| 14 | FAQ (akordeon: řádky s 2px linkami, ikona + v kruhu 2px se otáčí na ×) | Faq v2 | cream | `faqData()` |
| 15 | Závěrečná poptávka | FinalInquiry v2 | rasp-tint / paper | §5.12 |
| 16 | Footer | Footer v2 | ink | §5.13 |

Pořadí oproti v1 se mění takto: přibyl *Formáty* (5) a *Marquee* (6), cheesecaky se posunuly blíž ke konci (catering-first) a reference jsou hned za „Proč my“.

---

## 7. Mapování na stránky a soubory

### 7.1 Globální soubory
| Soubor | Změna |
|---|---|
| `lib/web/tokens.ts` | Nové `colors` (§1), `fontSize` (§3.3), `radius` (pill / 0 / sticker 1.25rem), `shadow` (`hard-sm 3px`, `hard 4px`, `hard-md 6px`, `hard-lg 8px` – všechno `0 0 0 ink`), keyframes `md-float`, `md-marquee`. Staré pastely (`blush`, `sage`, `vanilla`, `pistachio`) a `PASTEL_TONES` buď odstranit, nebo **namapovat** (blush→rasp-tint, sage/pistachio→blue-tint, vanilla→butter), aby nespadly e-shop karty (`PRODUCT_TONE` v `lib/web/eshop/catalog.ts`). Doporučuji namapovat a pak postupně uklidit. |
| `lib/web/fonts.ts` | Anton (display) + Manrope (text), Cormorant pryč. |
| `app/(web)/web.css` | Fokus, `.md-caps` → Anton pravidla (§3.2), `.md-fill` nový vzhled, utility `.md-frame` (2px grid), `.md-sticker`, `.md-float`, reduced motion. |
| `test/web/tokens.test.ts` | Páry z §1.3, včetně negativních (ink/rasp nesmí být text). |
| `components/web/Logo.tsx` | Inline SVG nového loga. |
| `components/web/Button.tsx`, `Badge.tsx`, `PastelCard.tsx`, `Section.tsx`, `SectionHeading.tsx`, `PhotoFrame.tsx`, `Hero.tsx`, `Header.tsx`, `Footer.tsx`, `Faq.tsx`, `Cta.tsx`, `PriceTag.tsx` | Přestylovat podle §5, **API zachovat** (props), ať se nemusí přepisovat stránky. `SectionHeading` dostane prop `accent`. `PastelCard` → „FrameCell“ (tone mapovaný). |
| nové | `components/web/v2/FloatingCutout.tsx`, `FloatingTag.tsx`, `BigMarquee.tsx`, `FormatExplorer.tsx` (+ cheesecake varianta), `SectionBand.tsx`, `TopBar.tsx`. |

### 7.2 Stránky
| Stránka | Hero | Hlavní sekce a fotky |
|---|---|---|
| `/` (`app/(web)/page.tsx`) | §5.5, výřezy viz §8 | §6 |
| `/catering` (`CateringOverview`) | SectionBand-hero: „CATERING <rasp>NA MÍRU</rasp>“, vpravo samolepka `home-hero-mobile.jpg` (raut na etažérách) + 3 plovoucí štítky z metas | CategoryGrid (9 typů), FormatExplorer, ceník: tabulka v orámované mřížce (jen data z `lib/web/catering.ts`), FinalInquiry |
| `/catering/firemni` | `catering-firemni-hero.jpg` jako velká samolepka vpravo, H1 „FIREMNÍ <rasp>CATERING</rasp>“ | galerie: `catering-firemni-gallery-1/2/3.jpg`, `home-grid-firemni.jpg` |
| `/catering/snidane` | `home-grid-snidane.jpg` | `catering-snidane-gallery-1.jpg` (avokádo), `catering-snidane-gallery-2.jpg` |
| `/catering/coffee-break` | `catering-coffee-break-gallery.jpg` (mini cheesecaky, jasné a ostré; dnešní hero 816×408 je malé) | `catering-coffee-break-hero.jpg`, `cheesecaky-na-akci-banner.jpg` |
| `/catering/obedy` | `catering-obedy-hero.jpg` | `home-grid-obedy.jpg`, `catering-obedy-gallery.jpg` (malé 671 px, jen jako malá samolepka) |
| `/catering/vecere-a-bankety` | `home-hero-alt-1.jpg` (parmazán na rizoto) | `catering-vecere-a-bankety-gallery-1/2.jpg`, `home-kitchen-1.jpg`, `catering-formats-banket.jpg` |
| `/catering/spolecenske-akce` | `home-grid-spolecenske-akce.jpg` | `catering-spolecenske-akce-gallery-1/2.jpg`, `catering-formats-finger-food.jpg`, `catering-spolecenske-akce-bvlgari.jpg` |
| `/catering/teambuilding` | `catering-teambuilding-hero.jpg` | `catering-formats-bbq-live-cooking.jpg` |
| `/catering/oslavy-a-piknik` | `home-hero-alt-2.jpg` (hortenzie) | `catering-oslavy-a-piknik-gallery-1/2.jpg`, `home-kitchen-6.jpg` (cupcaky) |
| `/catering/svatby` | `catering-svatby-hero.jpg` (kuchař s dortem), pruh `rasp-tint` | `catering-svatby-sweet-bar.jpg`, `home-kitchen-5.jpg`, `home-grid-svatby.jpg`, `catering-svatby-gallery-3.jpg`, `home-references-jitka-rostislav.jpg` |
| `/cheesecaky` | H1 „<rasp>MUMMY</rasp> & <blue>DADDY</blue> CHEESECAKY“, výřezy 4 cheesecaků kolem nadpisu (jako homepage hero) | mřížka produktů = FrameCell s výřezem na kruhovém talíři v barvě řady (Daddy blue-tint, Mummy rasp-tint, Mini butter), `cheesecaky-na-akci-banner.jpg` v marquee „CHEESECAKY NA VAŠI AKCI“ |
| `/cheesecaky/[slug]` | 2 sloupce: vlevo výřez produktu (levituje) na talíři, štítky ingrediencí; vpravo název Anton, cena, konfigurátor | ProductConfigurator přestylovat (pilulky) |
| `/poptavka` | pruh `blue-tint` „POPTÁVKA <rasp>CATERINGU</rasp>“ | InquiryWizard §5.12, vedle samolepka `catering-formats-bufet.jpg` (poptavka.trust) |
| `/o-nas` | `o-nas-team-1.jpg` samolepka + H1 „MUMMY <rasp>&</rasp> DADDY“ | `o-nas-rudolf.jpg`, `o-nas-monika.jpg`, `o-nas-team-2.jpg`, `home-team.jpg` |
| `/reference` (+ detail) | `reference-katka-jirka-cover.jpg` | `home-references-*.jpg`. Citáty jen ze zdrojů, jinak zástupce |
| `/prostory` | `prostory-hero.jpg` | `prostory-*.jpg`, `home-venues-*.jpg` (ostré buňky mřížky, ne samolepky – architektura se nenaklání) |
| `/vanoce` | `vanoce-hero.jpg`, pruh `rasp-tint`, marquee „VÁNOCE • VEČÍRKY • CUKROVÍ“ | `vanoce-gallery-1.jpg`, `catering-firemni-gallery-2.jpg`, výřez `cheesecaky-mummy-vanilkovo-pomerancovy-vanocni` |
| `/kontakt`, `/caste-dotazy`, `/blog`, `/darkovy-poukaz`, `/kosik`, právní stránky, 404 | SectionBand-hero bez fotky | jen přestylování komponent |

**Pravidlo pro fotky lidí a prostorů:** nenaklánět a nevyřezávat (lidé a architektura). Jsou v ostrých buňkách mřížky nebo jako rovné samolepky (rotate 0, obrys + stín). Natáčí a „levituje“ se **jen jídlo**.

---

## 8. Výřezy bez pozadí (cutouts)

Prošel jsem všech 75 originálů v `public/web/photos/`. Fotky jsou **reportážní, produkt je často useknutý okrajem**, takže plnohodnotný výřez jde jen u několika. Proto jsou dvě techniky:

**A) Skutečný výřez (alfa):** offline zpracování (`rembg` / Photoshop / Canva Remove background), výstup `public/web/cutouts/<slug>.webp` (alfa, 1200 px delší strana + `-600.webp`) a ruční kontrola hran. **Nic se neodstraňuje za běhu.** Každý výřez dostane záznam v `public/web/photos/manifest.json` (`cutout.<slug>`, alt, rozměry, `source`).

**B) „Samolepka“ (bez odstranění pozadí):** fotka oříznutá do kruhu nebo zaobleného čtverce (CSS `border-radius` / `clip-path`), 2.5px ink obrys, 6px tvrdý stín, natočení. Funguje s každou fotkou a v referenčním stylu vypadá záměrně. **Výchozí pro všechny ostatní fotky jídla.**

| Priorita | Soubor | Technika | Co vyříznout | Kam |
|---|---|---|---|---|
| ★★★ | `home-cheesecakes-mini-10ks.jpg` | A | přední čokoládový mini cheesecake (celý v záběru, jednolité tyrkysové pozadí, snadná maska) | hero (4), CheesecakeExplorer: Mini |
| ★★★ | `home-cheesecakes-daddy-pistaciovo-malinovy.jpg` | A (kruh) | celý dort shora (kruh; okraje skoro celé v záběru, dořezat do kruhu) | hero (2), Daddy pistáciovo-malinový |
| ★★★ | `cheesecaky-daddy-cokoladovo-liskooriskovy-main.jpg` | A (kruh) | dort shora i se zlatým podnosem (kruh) | Daddy čokoládovo-lískooříškový |
| ★★★ | `catering-coffee-break-gallery.jpg` / `home-grid-coffee-break.jpg` | A | 1–3 jednotlivé mini cheesecaky v papírových košíčcích (černé pozadí, kontrastní hrana) | drobné levitující prvky, Coffee break |
| ★★ | `cheesecaky-mummy-vanilkovo-ovocny-main.jpg` | A, ořez dole | bok dortu s ovocem. Bílé pozadí, ale levý, pravý i horní okraj je useknutý → výřez jako „výseč“ (polokruh se spodní hranou), nebo samolepka B | hero (1), Mummy vanilkovo-ovocný |
| ★★ | `cheesecaky-daddy-vanilkovo-karamelovy-main.jpg` | A, ořez po stranách | bílý dort na černém pozadí, výborný kontrast. Boky useknuté → použít jako „řez“ přes celou šířku buňky (oříznutý záměrně) | Daddy vanilkovo-karamelový |
| ★★ | `catering-snidane-gallery-1.jpg` | A | jedna půlka avokáda s cottage (celá v záběru vpravo dole) | Snídaně, drobný prvek v hero na /catering |
| ★★ | `home-kitchen-5.jpg` | A | třípatrový svatební dort s růžemi (světlé pozadí, celý v záběru) | Svatby hero, FormatExplorer: Svatba |
| ★★ | `home-kitchen-6.jpg` | A | jeden cupcake vpředu (s cedulkou) | Oslavy a piknik |
| ★ | `cheesecaky-hero.jpg` | A | jednotlivé maliny, plátky pistácií, granátové jablko = „konfety“ pro hero (5) | hero drobnosti |
| ★ | `catering-obedy-hero.jpg` / `catering-formats-banket.jpg` | A (kruh) | jeden talíř caprese (bílý kulatý talíř) | Oběd |
| ★ | `home-kitchen-1.jpg` | A (kruh) | talíř s terinou (velký světlý talíř shora, okraj useknutý → dořezat kruh) | Večeře a bankety |
| ★ | `catering-svatby-sweet-bar.jpg` | A | 1–2 pohárky panna cotty | Svatby, sweet bar |
| B | `home-kitchen-2.jpg`, `home-kitchen-4.jpg`, `catering-snidane-gallery-2.jpg`, `catering-firemni-gallery-3.jpg`, `catering-formats-finger-food.jpg`, `catering-formats-raut.jpg`, `home-hero-mobile.jpg` | B | samolepky (chlebíčky, břidlice, etažéry – výřez by vypadal špatně) | Kategorie, Formáty |
| — | `cheesecaky-mummy-vanilkovo-pomerancovy-vanocni-main.jpg` | B (A jen s retuší) | dekorace přesahují, pozadí s rozmazanými světly | Vánoce, Mummy vánoční |

**Malé zdroje (nepoužívat přes ~400 px):** `catering-coffee-break-hero.jpg` (816×408), `catering-obedy-gallery.jpg` (671×447), `catering-svatby-gallery-3.jpg` (611×764), `o-nas-team-2.jpg` (672×840), `home-kitchen-3.jpg` (667×667), `home-kitchen-1.jpg` (710×710 – výřez jen do 320 px).

**Nejlepší fotky celkově (vybrané pro velké plochy):** `home-hero.jpg` (raut na břidlici, marquee), `catering-formats-raut.jpg`, `catering-svatby-hero.jpg`, `home-cheesecakes-daddy-pistaciovo-malinovy.jpg`, `cheesecaky-mummy-vanilkovo-ovocny-main.jpg`, `cheesecaky-daddy-vanilkovo-karamelovy-main.jpg`, `catering-formats-bbq-live-cooking.jpg`, `home-kitchen-5.jpg`, `catering-svatby-sweet-bar.jpg` (růžová paleta přesně sedí k rasp-tint).

**Fallback, dokud výřezy nejsou hotové:** FloatingCutout přijme `variant="sticker"` a použije techniku B. Layout se nemění, jen vizuál. Implementace proto může začít hned.

---

## 9. Mobil 390 px — souhrn a kontrolní seznam

| Sekce | 390 px |
|---|---|
| TopBar | 1 řádek, zkrácený text + ikona telefonu |
| Header | 64 px, logo 32 px, košík + „Nabídka“ + hamburger |
| Hero | nadpis vlevo ~52 px na 4 řádky, 3 výřezy (1 nahoře vpravo přes okraj, 2 pod CTA), CTA přes celou šířku pod sebou |
| QuickStart | pole pod sebou, tlačítko přes celou šířku |
| SectionBand | nadpis, perex, tlačítko pod sebou, vlevo |
| CategoryGrid | řádky: samolepka 88 px + text + šipka, 2px linky |
| FormatExplorer / Cheesecake | vodorovný pás pilulek (scroll-snap) → fotka 4:5 → 2 štítky na fotce, ostatní pod ní |
| Marquee | výška 15rem, text 4.5rem, 2 štítky |
| Proč my | 1 sloupec, ikona vlevo + text |
| Testimonials | 1 sloupec, max. 3 položky |
| Kitchen | mřížka 2 sloupce, samolepky střídavě ±3° |
| HowItWorks | svislá osa: číslo vlevo, text vpravo, 2px svislá linka |
| Prostory | 1 sloupec, poměr 4:3 |
| Tým | samolepky vedle sebe 2×, text pod nimi |
| FAQ | akordeon přes celou šířku |
| FinalInquiry | pruh s nadpisem → formulář → kontakty |
| Footer | logo stacked, CTA, akordeony |

**Kontrola:** žádný horizontální scroll (výřezy přesahující okraj mají rodiče s `overflow-x: clip`, ne `hidden`, kvůli sticky), gutter 16 px, dotykové cíle ≥ 44 px, nejdelší česká slova Antonem se nezalomí uprostřed (360 i 390 px), plovoucí štítky nepřekrývají text ani CTA.

---

## 10. Akceptační kritéria (pro implementujícího agenta)

1. Playwright screenshoty desktop 1440 a mobil 390 všech stránek z §7.2 (navázat na `/home/user/md-screens/`) a vizuální kontrola diakritiky v nadpisech (Ř, Ž, Ů, Ď nesmí být useknuté ani se srážet).
2. `test/web/tokens.test.ts` je zelený s novými páry. Axe bez chyb kontrastu a ARIA (tablist, marquee).
3. Lighthouse mobil: LCP < 2,5 s (výřezy WebP, první s `priority`), CLS < 0,05.
4. Žádný nový externí zdroj v CSP. `next build` projde. Cockpit beze změny (`git diff --stat app/cockpit` je prázdný).
5. Žádný nový text s číslem, cenou, hodnocením nebo jménem klienta, který není ve zdrojích v `lib/web`. Zástupci `[DOPLNÍ KLIENT: …]` jsou vidět.
6. `prefers-reduced-motion`: nic se nehýbe, marquee je statické.
