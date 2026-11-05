# Měsíční náklady provozu — Mummies and Daddies

Odhad nákladů služeb na účtech M&D (bez práce dodavatele). **Ceny ověřeny
5. 11. 2026** na webech poskytovatelů (odkazy u každé položky). Kurz ČNB
k 5. 11. 2026: **1 USD = 21,646 Kč**, 1 EUR = 24,290 Kč. Ceny v USD jsou bez
DPH (služby ze zahraničí — M&D odvádí DPH v režimu přenesení daňové
povinnosti; ověřit s účetní). Mapy.com je v Kč bez DPH.

## Souhrn

| Služba | Plán | USD / měs. | Kč / měs. |
| --- | --- | ---: | ---: |
| Vercel | Pro, 1 místo (vlastník M&D) | 20 | 433 |
| Supabase — produkce | Pro (Micro compute v ceně) | 25 | 541 |
| Supabase — staging | 2. projekt v Pro organizaci (Micro) | 10 | 216 |
| Anthropic API | dle spotřeby, střední odhad (níže) | 14 | 303 |
| Mapy.com | Basic, v bezplatném limitu | 0 | 0 |
| Google Workspace / Gmail API / Google Cloud projekt | už placené / zdarma | 0 | 0 |
| Cloudflare Turnstile | Free | 0 | 0 |
| GitHub | Free organizace (Actions v limitu) | 0 | 0 |
| **Celkem — doporučená varianta** | | **≈ 69** | **≈ 1 500 Kč** |

Volitelné navýšení:

| Položka | USD / měs. | Kč / měs. | Kdy |
| --- | ---: | ---: | --- |
| Druhé místo ve Vercelu (Enter nasazuje přímo) | +20 | +433 | jinak Enter nasazuje přes GitHub (CI → Vercel Git integrace) bez vlastního místa |
| Supabase PITR (obnova k okamžiku, 7 dní) | +100 | +2 165 | když M&D nesnese ztrátu dat do 24 h; jinak denní zálohy v ceně Pro |
| Anthropic — vysoký provoz (1 500 e-mailů měs.) | +20 | +430 | sezóna svateb / Vánoce |
| Uptime monitor a SMS alarmu | 0–10 | 0–220 | bezplatné tarify stačí na e-mail; SMS se platí za kus (neověřeno, orientačně) |

**Rozpětí: ≈ 1 100 Kč (klidný měsíc, staging ve Free) až ≈ 4 800 Kč
(2 místa, PITR, sezóna, placené SMS).** Doporučený start bez PITR a s jedním místem:
**≈ 1 500 Kč měsíčně**.

## Položky podrobně

### Vercel — <https://vercel.com/pricing>, <https://vercel.com/docs/cron-jobs/usage-and-pricing>

- **Pro: 20 USD / měsíc za místo**, v ceně **kredit 20 USD** na spotřebu
  (funkce, přenosy). 1 TB Fast Data Transfer v ceně.
- Spotřeba nad kredit: Fluid Active CPU od 0,128 USD/h, provisioned memory od
  0,0106 USD/GB-h, vyvolání funkcí od 0,60 USD / 1 M.
- **Crony:** Pro až 100 cronů, minimální interval 1 minuta, přesnost na minutu.
  Hobby jen 1× denně (± 59 min) — proto Pro.
- Odhad spotřeby: 3 úlohy po 5 minutách = 3 × 12 × 24 × 30 ≈ **25 900 vyvolání
  měsíčně** + web. Úlohy většinu času čekají na síť (Gmail, model, DB), aktivní
  CPU ≈ 0,3–1 s na běh → **2–7 h aktivního CPU ≈ 0,3–0,9 USD**. Vše se vejde
  do kreditu 20 USD; i crony po 1 minutě (≈ 130 000 vyvolání) zůstanou pod
  kreditem.

### Supabase — <https://supabase.com/pricing>

- **Pro: od 25 USD / měsíc** za organizaci, v ceně **kredit 10 USD na compute**
  = jedna instance **Micro**. 8 GB disku na projekt (pak 0,125 USD/GB),
  250 GB egress (pak 0,09 USD/GB).
- **Zálohy:** denní, uchovávané 7 dní — v ceně.
- **PITR:** 100 USD / měsíc za 7 dní retence (doplněk).
- Staging jako druhý projekt v Pro organizaci = další Micro ≈ 10 USD
  (kredit pokrývá jen jednu instanci). Úspornější varianta: staging ve
  zvláštní Free organizaci (0 USD, po týdnu nečinnosti se uspí — před testem
  ručně probudit).
- Data M&D (CRM, poptávky, objednávky, metadata pošty) se vejdou do stovek MB;
  limit 8 GB je daleko.

### Anthropic API — <https://platform.claude.com/docs/en/about-claude/pricing>

| Model | Vstup | Zápis cache (5 min) | Čtení cache | Výstup | Použití |
| --- | ---: | ---: | ---: | ---: | --- |
| Claude Opus 5.5 (`claude-opus-5-5`) | 4 USD / MTok | 5 USD / MTok | 0,20 USD / MTok | 20 USD / MTok | čtení poptávky agentem |
| Claude Sonnet 5 (`claude-sonnet-5`) | 2 USD / MTok | 2,50 USD / MTok | 0,20 USD / MTok | 10 USD / MTok | import PDF nabídek |

PDF import Sonnetem 5: ≈ 10 000 vstupních a 1 000 výstupních tokenů ≈ 0,03 USD.
Výpočet na jedno vytěžení e-mailu Opusem 5.5: ≈ 3 000 vstupních tokenů
(instrukce, cenová mapa, text e-mailu) a ≈ 500 výstupních →
3 000 × 4 / 1 M + 500 × 20 / 1 M = 0,012 + 0,010 = **≈ 0,022 USD (≈ 0,48 Kč)**.
S cache instrukcí (≈ 2 000 tokenů čteno z cache) ≈ 0,014 USD.

| Scénář | E-mailů a webových poptávek modelem / měs. | PDF importů | USD | Kč |
| --- | ---: | ---: | ---: | ---: |
| Klidný měsíc | 150 | 10 | ≈ 4 | ≈ 90 |
| **Střední (odhad)** | 600 | 40 | ≈ 14 | ≈ 300 |
| Sezóna | 1 500 | 80 | ≈ 35 | ≈ 770 |

Web poptávky model nepotřebují (`webInquiryToOfferInquiry` jde rovnou do
výpočtu nabídky); model čte jen e-maily. Pojistky proti lavině: denní strop
`MODEL_DAILY_CALL_LIMIT` v aplikaci a měsíční spend limit v konzoli Anthropic
(doporučeno 50 USD, NASAZENI.md krok 6). Skutečný počet poptávek
změřit v prvním měsíci pilotu a odhad upravit.

### Mapy.com — <https://developer.mapy.com/pricing/>

- Tarif **Basic: 250 000 kreditů měsíčně zdarma**; geokódování = **4 kredity**
  za dotaz → zdarma ≈ 62 500 geokódování měsíčně.
- Nad limit 1,60 Kč za 1 000 kreditů (od 5 M kreditů levněji).
- M&D: stovky adres měsíčně (≈ 1 200–6 000 kreditů) → **0 Kč**.

### Ostatní (bez dodatečných nákladů)

- **Google Workspace** — M&D už platí; Gmail API a Google Cloud projekt bez
  fakturace jsou zdarma (limity Gmail API jsou pro tři schránky
  nedosažitelné).
- **Cloudflare Turnstile** — Free tarif.
- **GitHub** — Free organizace; soukromé repozitáře s 2 000 minutami Actions
  měsíčně. CI ≈ 6–8 min na běh, ≈ 60 běhů měsíčně ≈ 450 min → zdarma
  (počet minut neověřen k datu, orientačně).
- **Doména** — stávající registrace (Wix / registrátor), beze změny.
- **Uptime monitor** (Better Stack / UptimeRobot) a **příjemce webhooku
  alarmu** (Make / Zapier) — bezplatné tarify stačí pro e-mailová upozornění;
  SMS je zpoplatněná podle brány. Ceny těchto služeb **nebyly ověřeny** —
  doplnit po výběru.

## Co náklady zvedá a jak to hlídat

| Riziko | Pojistka |
| --- | --- |
| Smyčka agenta / lavina e-mailů volá model | `MODEL_DAILY_CALL_LIMIT`, spend limit Anthropic, upozornění 50/80/100 % |
| Útok na formuláře webu | Turnstile + limit 5 poptávek / adresu / 24 h (WI001, SO001) |
| Přenosy ve Vercelu (obrázky webu) | Spend Management ve Vercelu (*Settings → Billing → Spend Management*) — doporučený strop 50 USD nad kredit |
| Růst databáze | retence (PROVOZ.md „GDPR“), upozornění Supabase na 80 % disku |
