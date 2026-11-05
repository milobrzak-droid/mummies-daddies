# Provoz — Mummies and Daddies

Stručný provozní návod jedné aplikace „web + Cockpit". Systém je samostatný:
vlastní repozitář, vlastní Supabase projekt, vlastní nasazení.

## Architektura

Vrstvy: `lib` ← `core` ← `domain` ← `app`. Konektory (`connectors/`) vidí jen
`lib` a `core` a importují se přes `@/connectors/<jméno>`. Konfigurace firmy
se čte jen přes `@/config`. Hranice hlídá ESLint (`eslint.config.mjs`).

Do auditu, logů ani statistik úloh nikdy nejde text e-mailů, zpráv z webu
ani osobní údaje (jména, e-maily, telefony, adresy).

## Směrování

Pravidla jsou v `lib/routes.ts` a v bráně `lib/supabase/middleware.ts`:

| Cesta | Kdo | Poznámka |
| --- | --- | --- |
| `/` a vše mimo níže uvedené | kdokoli | veřejný web (`app/(web)/`) |
| `/cockpit`, `/cockpit/**` | přihlášený člen týmu s MFA (AAL2) | interní Cockpit (`app/cockpit/`) |
| `/login`, `/auth/**` | kdokoli / přihlášený | přihlášení a MFA |
| `/api/web/**` | kdokoli | formuláře webu; každá routa ověřuje Turnstile a limit |
| `/api/v1/**`, `/api/mcp` | API klíč | ověřuje routa |
| `/api/cron/**` | Vercel Cron | `Authorization: Bearer CRON_SECRET`, bez přepínače 404 |
| ostatní `/api/**` | přihlášený | |

Server Actions smí nepřihlášený spustit jen na `/login` (signIn). Veřejný web
proto formuláře posílá na route handlery `/api/web/**`.

## 1. Databáze a migrace

Migrace jsou v `supabase/migrations/` (číslované, souvislé). Spouští je
`scripts/migrate.mjs` (lokálně z `.env.local`, v CI workflow
`.github/workflows/migrate.yml`).

### 1a. Připojení

- `STAGING_DB_URL` — staging (Session pooler).
- `SUPABASE_DB_URL` — produkce.
- `PRODUCTION_PROJECT_REFS` — ref(y) produkčního projektu (čárkami); staging
  na ně nesmí ukazovat. V repozitáři žádný ref není.
- Certifikáty pro ověření TLS jsou v `supabase/certs/`.

```bash
node scripts/migrate.mjs --target=staging            # plán (nic nemění)
node scripts/migrate.mjs --target=staging --apply    # aplikace
```

### 1b. První uživatel a správce

1. Supabase → Authentication → Users → Add user (vznikne řádek `team_member`).
2. Prvního správce nastav v SQL editoru (service role):
   `UPDATE team_member SET is_admin = true WHERE lower(email) = '<e-mail>';`
3. Vlastníky uzlů Loop Core (`obchod`, `eventy`, `vedeni`) nastav:
   `UPDATE loop_node SET owner_id = '<team_member.id>' WHERE node = 'obchod';`
4. Při prvním přihlášení si každý nastaví dvoufázové ověření.

### 1c. Ukázková data

`supabase/seed.sql` obsahuje vymyšlené zákazníky a obchody. Jen pro vývoj
a staging, nikdy na produkci.

## 2. Proměnné prostředí

Úplný seznam s účelem, zdrojem a výchozí hodnotou je v
[NASAZENI.md](NASAZENI.md#tabulka-proměnných-prostředí) (zdroj pravdy
`scripts/env-catalog.mjs`, vzor `.env.example`). Všechny přepínače `*_ENABLED`
jsou ve výchozím stavu vypnuté; integrace bez nich nic neodesílá ani nevolá.
Kontrola nastavení bez vypsání tajemství: `node scripts/setup-check.mjs`.

Pošta M&D je Google Workspace (Gmail API). Proměnné Microsoft 365
(`MS_*`, `OUTLOOK_*`, `DIGEST_SEND_*`, `SHAREPOINT_*`, `MAIL_CONTENT_*`) se
nenastavují. iDoklad zůstává vypnutý (`IDOKLAD_SYNC_ENABLED` nenastavovat).

## 3. Agent a odesílání

Odeslání nabídky bez člověka je vypnuté na třech úrovních: přepínač v env,
pravomoc `send_standard_offer` = L4 v tabulce `authority_policy` a schválená
cenová mapa (verze nesmí začínat `ilustracni`). Dokud kterákoli brána chybí,
nabídka čeká na schválení obchodem.

## 4. Import zakázek

Cockpit → Obchody → Import (`/cockpit/import/zakazky`): CSV se středníkem
nebo PDF nabídky. Každý řádek potvrdí člověk; dávku jde vrátit tlačítkem
„Vrátit import" (migrace 0098). U vyhrané zakázky z importu se úkol
„Naplánovat realizaci akce" nezakládá. Čtení PDF používá model
(`ANTHROPIC_API_KEY`).

Sloupce CSV:

| Sloupec | Povinný | Popis |
| --- | --- | --- |
| klient | ano | název firmy |
| IČO | ne | 8 číslic; pomůže spárovat klienta |
| název zakázky | ano | jak se zakázka jmenuje |
| cena | ano | naše cena bez DPH |
| měna | ne | CZK (výchozí) nebo EUR |
| stav | ano | vyhráno a běží / nabídka odeslána / rozjednáno |
| začátek | ne | kdy zakázka začala |
| termín | ne | kdy má skončit |
| vlastník | ne | e-mail člena týmu |
| fakturováno | ne | kolik už je vyfakturováno |
| přijato | ne | kolik už zákazník zaplatil |
| typ | ne | firemni / oslava / svatba / cheesecaky / pravidelny / pronajem |

## 5. Nasazení

Postup založení všech účtů a služeb: [NASAZENI.md](NASAZENI.md). Náklady:
[NAKLADY.md](NAKLADY.md).

Vercel (plán Pro, region `fra1` u Supabase ve Frankfurtu): `buildCommand =
npm run build:release` (typy, lint, testy, build). Crony ve `vercel.json`
bez zapnutého přepínače vracejí 404. GitHub CI (`.github/workflows/ci.yml`)
pouští tutéž bránu u každého push / PR, bez tajemství.

## 6. Monitoring a alarm

Tři vrstvy, každá nezávislá na té předchozí:

| Vrstva | Co hlídá | Kam hlásí | Zpoždění |
| --- | --- | --- | --- |
| **Uptime monitor** (Better Stack / UptimeRobot, účet M&D) na `GET /api/health?strict=1` | aplikace neběží, databáze neodpovídá, aktivní provozní problém | e-mail + SMS správci (nastavení monitoru) | 1–5 min |
| **Alarm** `GET /api/cron/ops-alarm` (každých 5 min, `OPS_ALARM_ENABLED=true`) | neplatný OAuth token Gmailu, vyčerpaný kredit Anthropic, selhaná / visící / umlklá úloha, stojící fronta | `ALERT_WEBHOOK_URL` → e-mail / SMS | do 10 min |
| **Stav úloh** v Cockpitu (Nastavení) a ranní přehled | historie běhů za 7 dní | obrazovka / e-mail | denně |

**`/api/health`** — veřejná odpověď je jen `{"status":"ok"|"degraded"|"down","checkedAt":…}`,
bez jakýchkoli dat. `down` (DB neodpovídá) = HTTP 503 vždy; `degraded` = 503
jen s `?strict=1`. Seznam signálů (kódy, názvy úloh / front) vrátí jen
s `Authorization: Bearer $HEALTH_TOKEN`. Necachuje se.

**Signály** (`domain/ops/opsHealth.ts`):

| Kód | Kdy | Co udělat |
| --- | --- | --- |
| `gmail_oauth` | chyba úlohy obsahuje `gmail_oauth` / `invalid_grant` / `unauthorized_client` | vlastník schránky se znovu přihlásí v Cockpitu (Nastavení → Gmail); pokud odvolal správce, zkontrolovat Admin konzoli → API controls (aplikace *Trusted*) |
| `model_credit` | chyba úlohy obsahuje `model_credit` / „credit balance is too low“ / billing | dobít kredit v console.anthropic.com → Billing, případně zvýšit spend limit; poptávky mezitím čekají (viz 7) |
| `job_failed` | poslední dokončený běh úlohy selhal | Vercel → Logs (filtr na cestu cronu), Cockpit → Nastavení → Stav úloh |
| `job_stuck` | běh visí `running` po vypršení zámku (funkci zabil limit) | uzavře se sám (denní kontrola / další běh); opakuje-li se, zkrátit dávku úlohy |
| `job_silent` | sledovaná úloha (`OPS_EXPECTED_JOBS`, výchozí agent a outbox) neběžela > 20 min, ač za 24 h běžela | Vercel → Cron Jobs (nevypnul se cron? nevypadl deploy?) |
| `queue_stuck` | `web_inquiry` nová > 20 min, `inquiry_agent_run` pending > 60 min / processing > 30 min, `agent_outbox` claimed > 15 min | podle tabulky — zastavený agent / outbox, výpadek Gmailu nebo modelu |

Konvence pro úlohy agenta a pošty (balíky P2, P3): při chybě tokenu Google
zapsat do `job_run.error` kód `gmail_oauth`, při vyčerpaném kreditu
`model_credit` (bez dalších údajů — nikdy text e-mailu ani adresu).

Alarm se neopakuje pro stejnou sadu problémů dřív než za
`OPS_ALARM_REPEAT_MINUTES` (výchozí 180) a jednou oznámí vyřešení. Záznam
odeslaného alarmu je v `job_run` (úloha `ops-alarm`, jen statistiky).
Zkouška: dočasně nastavit `ALERT_WEBHOOK_URL` na testovací webhook
(webhook.site) a ručně vyvolat cron ve Vercelu (*Cron Jobs → Run*).

## 7. Výpadky: Gmail, Anthropic, Supabase, Vercel

Zásada: **výpadek nesmí vést k odeslání špatné odpovědi ani k lavině případů
pro CSO.** Fronty drží stav, nic se neztratí, po obnově se dožene.

**Gmail nedostupný / token neplatný**
- Čtení: `inquiry-agent` nenačte nové zprávy; protože se čte podle
  historie / data, po obnově dožene zameškané (Gmail drží poštu dál —
  zákazník nic nepozná, jen odpověď přijde později).
- Odesílání: `agent_outbox` nechá položky `queued` / vrátí `claimed` do fronty;
  odeslání je idempotentní podle `source_ref` a potvrzuje se podle id zprávy
  vráceného Gmailem — po obnově se nic nepošle dvakrát.
- Alarm `gmail_oauth` / `queue_stuck`. Při výpadku > 2 h v pracovní době
  CSO odpovídá ručně z Gmailu a v Cockpitu označí poptávku jako vyřízenou.

**Anthropic nedostupný / vyčerpaný kredit**
- Běh agenta, který model nezavolá, nechá zprávu ve stavu `pending`
  s odkladem (backoff 5 → 15 → 60 min) a počítadlem pokusů; **eskalace na
  člověka až po N = 3 neúspěšných pokusech**, ne po prvním — jinak by
  hodinový výpadek vyrobil desítky případů.
- **Denní strop volání modelu** `MODEL_DAILY_CALL_LIMIT` (výchozí 200): nad
  ním se poptávky jen zařadí k ručnímu zpracování. Webové poptávky model
  nepotřebují a běží dál.
- Alarm `model_credit`, příp. `queue_stuck` (pending > 60 min).
- (Backoff, počítadlo a strop implementuje balík P2; tady je dohodnuté
  chování a hodnoty.)

**Supabase nedostupná** — web i Cockpit hlásí chybu, formuláře vrací chybu
(zákazník vidí výzvu zavolat / napsat e-mail). `/api/health` = `down` → uptime
monitor. Stav: <https://status.supabase.com>.

**Vercel nedostupný** — uptime monitor. Stav: <https://www.vercel-status.com>.
Pošta (Gmail) funguje dál, jen bez agenta.

## 8. Rotace klíčů

Rotovat **při odchodu člověka s přístupem**, při podezření na únik a
pravidelně jednou ročně. Postup vždy: nový klíč → Vercel *Environment
Variables* (Production) → *Redeploy* → ověřit `setup-check` → zneplatnit
starý.

| Klíč | Kde vytvořit nový | Kde zneplatnit starý | Pozor |
| --- | --- | --- | --- |
| `SUPABASE_SECRET_KEY` | Supabase → API Keys → *Create new secret key* | tamtéž, *Delete* starého | publishable klíč se rotuje stejně |
| heslo DB (`SUPABASE_DB_URL`) | Supabase → Database → *Reset password* | — | aktualizovat GitHub secrets |
| `CRON_SECRET` | `openssl rand -hex 32` | přepsáním | Vercel ho cronům posílá sám po redeployi |
| `ANTHROPIC_API_KEY` | Anthropic → API Keys | *Disable* / *Delete* | |
| `GMAIL_CLIENT_SECRET` | Google Cloud → Clients → *Add secret* | po přepnutí *Disable* starého | refresh tokeny schránek zůstávají platné |
| refresh token schránky | — | Google účet → Zabezpečení → Aplikace třetích stran → *Odebrat přístup* (nebo Admin konzole) | schránku pak znovu připojit v Cockpitu |
| `MAPY_API_KEY` | developer.mapy.com → API klíče | *Smazat* | |
| `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → *Rotate secret key* | automaticky po 2 h | |
| `HEALTH_TOKEN`, `ALERT_WEBHOOK_URL` | vygenerovat / nový webhook | přepsáním | aktualizovat uptime monitor |

Odebrání Enteru po ukončení spolupráce: GitHub, Vercel, Supabase, Google Cloud
IAM, Anthropic → odebrat člena, pak rotovat všechny klíče výše.

## 9. Zálohy a obnova

- **Supabase Pro**: denní zálohy, uchovávané 7 dní (*Database → Backups*).
  S doplňkem PITR obnova k libovolné sekundě v okně (NAKLADY.md).
- **Ruční záloha před rizikovým krokem** (migrace, hromadný import, výmaz):
  `pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --file=md-$(date +%F).dump`
  — soubor obsahuje osobní údaje: uložit jen na šifrované úložiště M&D
  (Google Drive M&D s omezeným sdílením), po 30 dnech smazat. Do GitHubu ani
  e-mailem nikdy.
- **Obnova** — Supabase obnoví zálohu do **téhož** projektu (přepíše data).
  Proto zkouška obnovy jde přes staging:
  1. `pg_dump` produkce (výše) → `pg_restore --clean --no-owner -d "$STAGING_DB_URL" md-….dump`,
  2. `node scripts/db-bootstrap.mjs --target=staging` (kontrola ledgeru a RLS),
  3. přihlášení do staging Cockpitu, kontrola počtu obchodů / poptávek,
  4. zápis výsledku a doby obnovy do změnového deníku.
  Zkoušku udělat před pilotem a pak jednou za půl roku. Po zkoušce staging
  vyčistit (obsahuje produkční osobní údaje) — smazat a znovu založit podle
  NASAZENI.md krok 3.
- Ostrá obnova: Supabase → *Database → Backups → Restore* (výpadek několik
  minut až desítky minut podle velikosti); před ní vypnout přepínače agenta
  a outboxu, ať se po obnově nic neodešle podruhé, a po obnově zkontrolovat
  `agent_outbox` (položky `sent` po času zálohy se v Gmailu dohledají
  v Odeslané poště).

## 10. GDPR a retence

M&D je správce osobních údajů, Enter zpracovatel (zpracovatelská smlouva),
poskytovatelé (Vercel, Supabase, Anthropic, Google, Seznam) další
zpracovatelé — jejich DPA uložit k záznamům o zpracování.

- **Těla e-mailů: retence 0.** Systém z pošty ukládá jen metadata
  (Message-ID, id vlákna Gmailu, čas, schránka, stav, rozhodnutí agenta,
  kódy důvodů, částka nabídky). Text e-mailu se zpracuje v paměti běhu (model)
  a nikam se neukládá; zůstává jen v Gmailu M&D. Do auditu a logů nikdy text
  ani osobní údaje.
- Webová poptávka (`web_inquiry`) a objednávka (`shop_order`) nesou kontakt
  zákazníka — nutné pro vyřízení.
- **Retence** (návrh k odsouhlasení CEO, mazání dodá balík retence):

  | Data | Doba |
  | --- | --- |
  | Prohraná / nevyřízená B2C poptávka (web_inquiry, kontakt) | 12 měsíců |
  | Nabídky a obchody (B2B i B2C) | 3 roky od poslední aktivity |
  | Realizované zakázky, faktury | 10 let (účetní předpisy) |
  | `inquiry_agent_run`, `agent_outbox` (metadata) | 12 měsíců |
  | `shop_order` vyřízená | 3 roky (reklamace), pak anonymizovat |
  | `job_run` | 90 dní |
  | Runtime logy Vercelu | podle plánu Vercel (dny), bez osobních údajů |

- **Marketingový souhlas** se ukládá se zněním, verzí, časem a zdrojem
  (formulář webu).
- **Výmaz na žádost** (do 30 dní): Cockpit → Klient / Kontakt → *Smazat*
  (kontakt, obchody bez zákonné povinnosti uchování); webové poptávky
  a objednávky se smažou podle e-mailu v SQL editoru správcem
  (`DELETE FROM web_inquiry WHERE email = lower('<e-mail>')`, totéž
  `shop_order`, pokud nejde o objednávku v zákonné lhůtě); e-maily smaže
  vlastník schránky v Gmailu. Zápis „kdy, kdo, co“ (bez údajů žadatele) do
  změnového deníku. Zálohy obsahující smazané údaje vyprší do 7 dní (PITR
  podle okna).
- **Přístupy**: Cockpit jen se dvoufázovým přihlášením (AAL2), RLS na všech
  tabulkách, servisní klíč jen na serveru.

## 11. Odpovědnosti M&D × Enter

| Oblast | M&D (klient) | Enter (dodavatel) |
| --- | --- | --- |
| Účty a platby (Vercel, Supabase, Google, Anthropic, Mapy, Cloudflare, GitHub) | vlastní, platí, spravuje členy | člen s omezenou rolí |
| Google Workspace, souhlas správce, schránky | ano | návod, podpora |
| DNS a doména | vlastní, schvaluje změny | připraví a provede přepnutí spolu s M&D |
| Kód, migrace, nasazení | schvaluje změny do `main` (review) | vyvíjí, testuje, migruje (staging → produkce) |
| Monitoring a alarm | příjemce alarmu (správce), první reakce na `gmail_oauth` a `model_credit` | nastavení, reakce na `job_*` a `queue_stuck` dle smlouvy (SLA) |
| Cenová mapa, VOP, texty nabídek, limity agenta | rozhoduje a schvaluje | promítne do konfigurace |
| Zapnutí samostatného odeslání (L4) | rozhodnutí CEO | technická příprava |
| GDPR: žádosti subjektů, retence, DPA | správce | zpracovatel: technický výmaz, součinnost |
| Rotace klíčů | při odchodu zaměstnance M&D | při odchodu člověka Enteru, ročně |
| Zálohy | rozhodnutí o PITR | ruční zálohy před rizikem, zkouška obnovy |

**Změnový deník** (níže): každé zapnutí přepínače, změna limitu, rotace,
obnova, výmaz — datum, kdo, co (bez osobních údajů).

| Datum | Kdo | Změna |
| --- | --- | --- |
| | | |
