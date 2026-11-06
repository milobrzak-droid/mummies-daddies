# Mummies & Daddies – značka (logo 2026)

Koncept **„Sticker pills“**: dvě nálepky ve tvaru pilulky – **MUMMIES** malinová, **DADDIES**
modrá – mírně natočené proti sobě (−3° / +3°), spojené mincí s ručně psaným ampersandem.
Tvrdý tmavý obrys (5 px při výšce pilulky 112 px) a plný posunutý stín (5 px) = neo-brutalistní
jazyk webu (pilulková tlačítka s offset stínem, rámované panely).

Příběh barev: maminky = malina, tatínci = modrá. Modrá je převzatá a zesílená z dosavadního
loga klienta (Wix, `#4669A6`), malina z našeho webu – a stejně se jmenují cheesecaky
„Mummy“ a „Daddy“.

## Soubory

| Soubor | Použití |
| --- | --- |
| `logo.svg` | Hlavní horizontální logo – header, dokumenty, e-mail podpis. Na krémové/světlé ploše. |
| `logo-light.svg` | Horizontální logo pro tmavé pozadí (kakao, tmavá fotka) – obrys a stín krémové. |
| `logo-stacked.svg` | Dvouřádkové logo – hero, plakáty, obaly cheesecaků, sociální sítě. |
| `logo-stacked-light.svg` | Dvouřádkové logo pro tmavé pozadí. |
| `mark.svg` | Samostatná značka (monogram M♥D v půleném kruhu) – avatar, razítko, víčko krabice. |
| `apple-icon-512.png` | Monogram 512 × 512 na krémovém podkladu (kopie `app/(web)/apple-icon.png`). |
| `app/(web)/icon.svg` | Favicon veřejného webu (Next 16 konvence `icon.svg`, platí jen pro route group `(web)`, Cockpit dál používá `app/favicon.ico`). |
| `app/(web)/apple-icon.png` | Apple touch icon 512 × 512. |

Text je převedený na křivky (žádné písmo za běhu, CSP-safe). Zdrojová písma pro tvorbu:
**Anton** (verzálky, OFL) a **Pacifico** (ampersand, OFL). Pro nadpisy webu ve stylu loga
doporučujeme Anton přes `next/font/google` (self-hosted při buildu).

## Paleta

| Token | Hex | Role |
| --- | --- | --- |
| Krém (`cream`) | `#FBF3E6` | Podklad stránky a loga, text na malině/modré. |
| Kakao / ink (`cocoa`) | `#2B1810` | Text, nadpisy, obrysy, linky mřížky, offset stíny. |
| Malina „Mummy“ (`raspberry`) | `#D23F6B` | Pilulka MUMMIES, akcent, CTA plocha, zvýrazněné slovo v nadpisu (≥ 24 px). |
| Malina text (`raspberry-ink`) | `#B8305A` | Malinový text menší než 24 px na krému, pozadí CTA (AA 5,3 : 1). |
| Modrá „Daddy“ (`daddy`) | `#4669A6` | Pilulka DADDIES, druhý akcent – původní modrá loga klienta (AA 5,0 : 1 na krému). |
| Nebeská (`daddy-tint`) | `#D3E0F2` | Pruhy nadpisů sekcí (jako modrý pruh v referenci); původní světle modrá klienta. |
| Růžová pastelová (`raspberry-tint`) | `#F7D6DF` | Plochy karet, aktivní řádky, podklady štítků. |

Kontrasty (WCAG): kakao/krém 15,4 · modrá/krém 5,0 · malina-ink/krém 5,3 · malina/krém 4,1
(jen velký text a plochy) · kakao/nebeská 12,7 · kakao/růžová 12,6.

Paleta je sjednocená s tokeny webu v2 (`lib/web/tokens.ts`, `docs/web-v2-design.md` §1);
logo je ve webu vykreslené inline z `components/web/LogoArt.tsx` (vygenerováno z těchto SVG).

## Pravidla

- **Ochranná zóna:** kolem loga volný prostor alespoň **výška mince s ampersandem** (≈ 0,8 ×
  výška pilulky); u `mark.svg` alespoň ¼ průměru kruhu. Do zóny nesahá text, hrana fotky ani linka mřížky.
- **Minimální velikost:** horizontální logo 28 px na výšku (web), 20 mm v tisku;
  stacked 56 px; značka 16 px (favicon), od 32 px čitelná včetně srdce.
- Barvy pilulek se **nikdy neprohazují** (MUMMIES vždy malina, DADDIES vždy modrá).
- Na krému/světlých plochách `logo.svg`, na kakau a tmavých fotkách `logo-light.svg`.
  Na rušné fotce logo neumisťovat bez klidné plochy.
- Logo se nenatáčí, nedeformuje, nepřebarvuje ani se mu neodebírá obrys či stín;
  sklon pilulek je součástí kresby.
- Jednobarevná verze (razítko, ražba, fax) zatím není – v případě potřeby udělat
  kakao/krém variantu ze stejných křivek.
