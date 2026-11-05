# Fotobrief: produktové focení pro nový web Mummies and Daddies

**Pro:** Mummies and Daddies s.r.o. (Rudolf Nikolai, Monika Jožková) a fotografa, kterého si vyberete
**Účel:** nahradit provizorní fotky na novém webu vlastními záběry v jednotném stylu. Na prvním místě je jídlo na akci, cheesecaky až potom.
**Stav webu:** web už běží na nejlepších vlastních fotkách, které máte. 48 míst je ale označených jako `provisional` (viz `public/web/photos/manifest.json`). Každý záběr níže říká, která místa nahradí.

---

## 1. Styl: jak mají fotky vypadat

Vizuální vzor je světlý, „redakční“ styl s pastelovými pozadími. Produkt je vždy hlavní téma a kolem něj je hodně vzduchu.

| Prvek | Zadání |
|---|---|
| **Hlavní téma** | Jídlo. Na každé fotce je na první pohled jasné, co se jí. Lidé jsou ve službě jídla (ruce, obsluha, kuchař), ne naopak. |
| **Světlo** | Měkké denní světlo z boku (okno, venku stín nebo zataženo). Žádný přímý blesk ani zářivky. Jemný stín listí nebo okenního rámu přes pozadí je vítaný, ve vzoru je to podpisový prvek. |
| **Pozadí** | Jednobarevné pastelové plochy (zeď, papír, deska, ubrus) z palety webu: pudrová růžová `#F2D4D2`, šalvějová máta `#BCD9D3`, vanilková `#F6E7C8`, pistáciová `#D5E3C3`, dále krémová a bílá. Žádné černé, tmavě modré ani syté červené pozadí. |
| **Barvy jídla** | Přirozené. Bez filtrů a bez přesycení. Teplota barev neutrální až mírně teplá a jednotná napříč sadou. |
| **Rekvizity** | Bílé nebo krémové talíře, lněný ubrousek v přírodní barvě, stříbrný příbor, pár kusů suroviny (maliny, bylinky, citron). Maximálně 2 až 3 rekvizity na záběr. |
| **Kompozice** | Produkt mimo střed (pravá nebo dolní třetina), volná plocha pro nadpis. Úhel 30–45° pro dorty, bufety a talíře, přímo shora (90°) pro flat-lay a boxy. |
| **Co nesmí být v záběru** | Cedulky s cenami a ceníky (ceny se na webu mění, fotka ne). Cizí značky (lahve, obaly, loga dodavatelů). Lednice, kartony, papírové utěrky, igelit, hasicí přístroj, kabely. Rozpoznatelné osoby bez písemného souhlasu. Děti v hlavní roli. |
| **Značka** | Kde to jde, ať je vidět zástěra s logem M&D (obsluha, kuchař). Funguje to jako doklad, že jde o vaši akci. |

**Kontrolní otázka ke každému záběru:** pozná host do tří vteřin, co dostane na talíř, a chce to?

---

## 2. Formáty a technické požadavky

Web každou fotku ořízne do pevného poměru stran. Foťte proto se **zálohou kolem motivu** (10–15 % na každé straně), aby šel stejný záběr použít v několika ořezech.

| Použití na webu | Poměr | Min. rozměr | Volná plocha pro text |
|---|---|---|---|
| Hero stránky (desktop) | 16:9 | 3000 × 1688 px | levých 40 % (nadpis a tlačítko) |
| Hero mobil / rozdělený layout | 4:5 | 1600 × 2000 px | horní pětina |
| Dlaždice sekce (formáty, karty) | 4:5 | 1600 × 2000 px | žádná, produkt na střed |
| Galerie, reference | 3:2 nebo 4:3 | 2400 px delší strana | žádná |
| Z naší kuchyně, cheesecaky | 1:1 | 2000 × 2000 px | žádná |
| Portrét | 4:5 a 2:3 | 2000 × 2500 px | nad hlavou trochu prostoru |
| Banner | 21:9 | 3000 px šířka | střed (text přes fotku) |
| Sdílení na sociálních sítích (OG) | 1,91:1 | 1200 × 630 px (z hera) | levých 40 % pro logo |

**Dodávka:**
- RAW a k tomu upravený JPEG v sRGB s plným rozlišením (delší strana minimálně 3000 px). Web si zmenšení a ořezy udělá sám: `scripts/web/build-photos.cjs` zmenší na 2400 a 1200 px, odstraní EXIF a uloží s kvalitou 80.
- Každý motiv nafoťte **na šířku i na výšku** (16:9 a 4:5 ze stejného nastavení).
- Názvy souborů: `<sekce>-<motiv>-<číslo>.jpg`, např. `snidane-bufet-01.jpg`, `cheesecake-daddy-vanilkovy-cely-01.jpg`.
- Úprava celé sady najednou (stejný preset), žádné výrazné filtry ani vinětace.

---

## 3. Seznam záběrů (podle priority)

Priorita **A** = nahrazuje fotky na úvodní stránce nebo v heru. **B** = nahrazuje provizorní fotky na podstránkách. **C** = doplňuje obsah, který dnes chybí úplně.

### A1. Hero úvodní stránky
- **Záběr:** raut nebo servírovaná tabule na pudrově růžovém či krémovém pozadí. Jídlo v pravé dolní třetině, vlevo volná plocha pro nadpis. Měkké denní světlo, stín listí.
- **Formát:** 16:9, minimálně 2400 px (raději 3000+), a k tomu verze 4:5 pro mobil.
- **Nahradí:** `home.hero`, `home.hero.mobile`, `og.default`. Dnešní fotka ze svatby J&R funguje, ale vlevo je pod nadpisem rušná.

### A2. Signature jídla, sekce „Z naší kuchyně“ (6 × 1:1)
Světlé pozadí, denní světlo, jeden talíř nebo porce na záběr, úhel 45° a k tomu detail.
1. Sous-vide krkovice s bylinkami
2. Chobotnice v červeném víně
3. Kachní rillettes
4. Grilované krevety v bazalkovém pestu
5. Panna cotty a makronky
6. Mini cheesecaky v jednotném stylu
- **Nahradí:** `home.kitchen.1`–`6` (dnes terina, kuře s pestem, předkrm v nízkém rozlišení, přesycený chlebíček, dort a cupcaky).

### A3. Cheesecaky: všech 7 jednotně
- **Sada:** Daddy pistáciovo-malinový, Daddy čokoládovo-lískooříškový, Mummy vanilkovo-ovocný, Daddy krémový vanilkovo-karamelový, Daddy vanilkový, Mini cheesecaky mix 10 ks, Mummy vanilkovo-pomerančový vánoční (sezónní).
- **Ke každému:** (a) celý dort z úhlu 30°, (b) dort s vykrojeným dílkem, (c) detail řezu. Stejný talíř, stejné světlo, stejná výška kamery.
- **Pozadí podle příchutě** (návrh): pistáciový → pistáciová, čokoládový → vanilková, vanilkovo-ovocný → pudrová růžová, karamelový → vanilková, vanilkový → šalvějová máta, mini mix → pudrová růžová, vánoční → krémová s minimem dekorace (bez umělých ozdob).
- **Formát:** 1:1 a 4:5.
- **Nahradí:** `cheesecaky.*.main`, `home.cheesecakes.*`. Nejvíc to potřebují Daddy vanilkový (amatérská fotka), vanilkovo-karamelový (černé pozadí), Mummy vanilkovo-ovocný (u fotky nevíme, jestli není ze stocku) a vánoční (kýčovité ozdoby).
- **Navíc:** desítky mini cheesecaků připravené na akci, na šířku 21:9 (`cheesecaky.na-akci-banner`).

### A4. Rudolf a Monika
- **Záběry:** společný portrét v kuchyni (4:5 a 16:9) a samostatný profesionální portrét každého z nich (4:5). Pracovní oblečení se zástěrou s logem, světlá a uklizená kuchyně.
- **Nahradí:** `home.team`, `o-nas.monika`, doplní `o-nas.rudolf`. Na dnešní fotce není potvrzené, že jde o Moniku.

### B1. Firemní catering mimo Vánoce
- Oběd nebo board meeting v kanceláři (raut na stole v zasedačce), konference, coffee break na školení.
- Bez rozpoznatelných osob, nebo se souhlasem (ruce, záda, rozostřené pozadí).
- **Nahradí:** `home.grid.firemni`, `catering.firemni.hero`, `catering.firemni.gallery.3`, `catering.formats.bufet`, `poptavka.trust`.

### B2. Snídaně
- Snídaňový bufet, americká snídaně, zdravá snídaně (ovesné kaše, smoothie, ovocné mísy). Produktové fotky na světlém pozadí, na šířku i na výšku.
- **Nahradí:** `home.grid.snidane`, `catering.snidane.hero`, `catering.snidane.gallery.1`–`2` (dnes fotky z mobilu, tmavé pozadí, přeostřené).

### B3. Coffee break
- Minisendviče, mini dezerty, mini cheesecaky a káva na jednom stole.
- K tomu coffee break se sushi a s kurzem vaření.
- **Nahradí:** `home.grid.coffee-break`, `catering.coffee-break.hero` (dnes 837 px, příliš malé), `catering.coffee-break.gallery`.

### B4. Obědy
- Obědové boxy grab-and-go a teplé obědy s rozvozem (box, salát, bowl). Flat-lay shora na pastelovém pozadí, k tomu záběr boxů naskládaných „k převzetí“.
- **Doplní:** `catering.obedy.*`. Boxy dnes na webu nemají žádnou fotku, `catering.obedy.gallery` je focená v tvrdém světle.

### B5. Večeře a bankety
- Sharing table a servírovaná večeře s párováním vín (formát pro 8–30 osob). Dlouhý stůl, sdílené mísy, ruce podávající talíře.
- **Nahradí:** `catering.vecere-a-bankety.gallery.1` (dnes v nízkém rozlišení).

### B6. Teambuilding
- Tým vaří se šéfkuchařem, sushi workshop, food stations. Ruce u prkének, šéfkuchař ukazuje postup. Lidé jen se souhlasem.
- **Nahradí:** `home.grid.teambuilding`, `catering.teambuilding.hero` (dnes BBQ, týmové vaření chybí).

### B7. Oslavy a piknik
- Narozeniny a křtiny s vaším jídlem (bez dětí v hlavní roli, nebo se souhlasem rodičů).
- Piknikový koš a party box jako produkt (flat-lay na dece, 1:1 a 4:5).
- **Nahradí:** `catering.oslavy-a-piknik.gallery.1`–`2` (dítě v záběru, silný filtr, v záběru je rámeček s menu).

### B8. Nápoje a bary
- Gentlemanský klub (rumy, whisky, doutníky bez viditelných cizích značek), fresh a smoothie bar, mobilní bar a welcome drink.
- **Doplní:** sekce svateb a společenských akcí. Nahradí `catering.spolecenske-akce.gallery.1`–`2` (šum, vánoční výzdoba, osoba bez souhlasu).

### B9. BVLGARI (jen se souhlasem klienta)
- Fotky jídla a servisu z akce v Pařížské. Dnes máme jen interiér butiku.
- **Nahradí:** `home.references.bvlgari`, `catering.spolecenske-akce.bvlgari`, `reference.bvlgari.cover`. Bez souhlasu klienta reference na webu zůstane bez fotky.

### C1. Vánoce
- Vánoční cukroví na objednávku (krabička, flat-lay na krémovém pozadí) a firemní dárkový balíček.
- **Nahradí:** `vanoce.gallery.1` (amatérská fotka na červeném pozadí).

### C2. Partnerské prostory
- Oficiální fotky od prostorů, se svolením: Hudlická Stodola, Statek Starý Týn, U Dvou Stodol, Na Veselce Řitka. K tomu písemně potvrdit, která fotka patří ke kterému prostoru.
- **Nahradí:** `home.venues.*`, `prostory.*` (dnes nejisté přiřazení, nízké rozlišení, u paláce nevíme, o jaký prostor jde).

### C3. Grafika a loga (není focení, ale je potřeba ve stejném termínu)
- Logo M&D ve vektoru (SVG). Nahradí provizorní text v `og.default.brand`.
- Loga klientů ve vektoru, se souhlasem.
- Nový grafický návrh dárkového poukazu (stávající grafiky nevyhovují).

---

## 4. Práva a souhlasy (bez toho nic nespouštět)

- [ ] Originály ve plném rozlišení všech fotek, které web používá. Z Wixu máme jen náhledy s 900 px a méně.
- [ ] Písemné potvrzení práv od svatebních fotografů (svatby J&R a K&J, bufet ve stodole, kuchař s dortem, Rudolf u grilu).
- [ ] Souhlas párů J&R a K&J se zveřejněním.
- [ ] Souhlas obsluhy a hostů, kteří jsou na fotkách rozpoznatelní (servírka s talířem, obsluha u bufetu, hosteska u šampaňského, cukrářka, hostka s burgerem a dítě).
- [ ] Souhlas klienta BVLGARI.
- [ ] Potvrzení původu u fotek, které mohou být ze stocku: studený bufet (`catering.firemni.hero`), mini cheesecake na tyrkysovém pozadí (`home.cheesecakes.mini-10ks`), Mummy vanilkovo-ovocný, terina (starý blog).
- [ ] U nového focení: licence pro web, sociální sítě a tisk bez časového omezení, model release od všech rozpoznatelných osob.

---

## 5. Organizace focení (návrh)

- **Den 1, studio nebo světlá kuchyně (produkt):** A2 signature jídla, A3 cheesecaky, B2 snídaně, B3 coffee break, B4 obědové boxy, B7 piknikový koš a party box, C1 cukroví a dárkový balíček. Připravit 4 pastelová pozadí (papír nebo malované desky ve 4 barvách palety) a jeden zdroj měkkého denního světla.
- **Den 2, kuchyně a lidé:** A4 portréty Rudolfa a Moniky, B6 teambuilding (s vlastním týmem nebo modely se souhlasem), B5 sharing table.
- **Na reálné akci (podle kalendáře):** A1 hero rautu, B1 firemní oběd nebo konference, B8 bary, B9 BVLGARI. Fotograf přijde 30 minut před příchodem hostů a nafotí nedotčený raut, potom obsluhu v akci.

Po dodání fotek stačí doplnit nové soubory do `content.json` (`pick.slots`, pole `original`, `provisional: false`), u slotu případně upravit fokus ořezu v `SPEC` ve skriptu `scripts/web/build-photos.cjs` a skript znovu spustit (`node scripts/web/build-photos.cjs`). Ořezy, velikosti a manifest se vygenerují znovu.
