# Nasazení na účty klienta — Mummies and Daddies

Návod krok za krokem pro **klienta** (Mummies and Daddies s.r.o., dále „M&D“)
i pro **dodavatele** (Enter). Všechno běží na účtech M&D: Vercel, Supabase,
Google Workspace / Google Cloud, Anthropic, Mapy.com, Cloudflare (Turnstile)
a GitHub. Enter má jen přístup člena týmu, který M&D kdykoli odebere.

Na konci každého kroku je **kontrola**. Celek ověří `node scripts/setup-check.mjs`
(krok 9). Provoz po spuštění popisuje [PROVOZ.md](PROVOZ.md), náklady
[NAKLADY.md](NAKLADY.md).

> Značky: **[M&D]** dělá klient (vlastník účtu, platební karta, souhlas
> správce), **[Enter]** dělá dodavatel, **[spolu]** na společném hovoru.

## Přehled pořadí

| # | Krok | Kdo | Doba |
| --- | --- | --- | --- |
| 0 | Účty, vlastnictví, přístupy | M&D | 1 h |
| 1 | GitHub repozitář a CI | M&D + Enter | 30 min |
| 2 | Supabase projekty (staging + produkce, EU Frankfurt, Pro, zálohy) | M&D + Enter | 1 h |
| 3 | Založení databáze od nuly (migrace, kontrola, první správce) | Enter | 1 h |
| 4 | Vercel projekt (Pro, fra1, proměnné, crony) | M&D + Enter | 1 h |
| 5 | Google Cloud projekt a interní OAuth aplikace pro Gmail | M&D (správce Workspace) + Enter | 1–2 h |
| 6 | Anthropic účet, API klíč, limit útraty | M&D | 20 min |
| 7 | Mapy.com API klíč, Cloudflare Turnstile | M&D | 20 min |
| 8 | DNS: přepnutí z Wixu, DKIM, DMARC, přesměrování | spolu | 2 h + čekání na DNS |
| 9 | Kontrola nasazení (`setup-check`), alarm, uptime monitor | Enter | 30 min |
| 10 | Pilot: zapínání přepínačů po jednom | spolu | 2–4 týdny |

---

## 0. Účty a vlastnictví [M&D]

1. Pro všechny služby použít **firemní** e-mail M&D, ne osobní (doporučení:
   `it@mummiesdaddies.com` jako skupina / alias v Google Workspace, do které
   chodí CEO i CSO — účty pak nezávisí na jednom člověku).
2. Platební karta / fakturace na M&D s.r.o. (IČO na faktuře kvůli DPH; Vercel,
   Supabase a Anthropic fakturují v USD bez DPH, M&D odvádí DPH v režimu
   reverse charge — ověřit s účetní).
3. Zapnout dvoufázové ověření u všech účtů.
4. Enter pozvat jako člena (ne vlastníka) do: GitHub organizace, Vercel týmu,
   Supabase organizace, Google Cloud projektu (role *Editor* jen na projekt),
   Anthropic organizace (role *Developer*, ne *Admin*/*Billing*).
5. Hesla a klíče se **nikdy neposílají e-mailem ani chatem**. Hodnoty vkládá
   ten, kdo je vygeneroval, přímo do Vercelu / GitHubu, nebo se předávají přes
   sdílený trezor (1Password / Bitwarden organizace M&D).

## 1. GitHub repozitář a CI [M&D + Enter]

1. **[M&D]** založí GitHub organizaci (např. `mummiesdaddies`, plán Free stačí)
   a pozve Enter jako člena.
2. **[Enter]** přenese repozitář do organizace (*Settings → Transfer*), nebo ho
   tam pushne. Výchozí větev `main`.
3. CI `.github/workflows/ci.yml` běží samo na každý push a PR: typy (`tsc`),
   lint (`eslint`), testy (`vitest`, bez sítě a bez tajemství) a `next build`.
   Žádné secrets nepotřebuje.
4. Ochrana větve `main` (*Settings → Branches → Add rule*): require status
   check **CI / check**, require PR, zakázat force push.
5. Migrace přes GitHub (`.github/workflows/migrate.yml`): *Settings →
   Environments* založit `staging` a `production`; u `production` nastavit
   *Deployment branches = main* a *Required reviewers* (CEO nebo Enter).
   Secrets: `STAGING_DB_URL` (prostředí staging), `SUPABASE_DB_URL`
   (prostředí production), volitelně `PRODUCTION_PROJECT_REFS`.

**Kontrola:** zelené CI u posledního commitu na `main`.

## 2. Supabase [M&D + Enter]

1. **[M&D]** <https://supabase.com/dashboard> → *New organization* (M&D
   s.r.o.) → plán **Pro**. Pozvat Enter (*Organization → Team*, role
   *Developer*).
2. Dva projekty, oba **Region: Central EU (Frankfurt) — eu-central-1**:
   - `md-staging` (může běžet i ve Free organizaci, ale pak se po týdnu
     nečinnosti uspí),
   - `md-produkce`.
   Heslo databáze vygenerovat dlouhé, uložit do trezoru.
3. **Zálohy:** Pro má denní zálohy s retencí 7 dní automaticky. **PITR**
   (obnova k libovolnému okamžiku) je doplněk za 100 USD/měs. za 7 dní — na
   start nedoporučujeme (viz NAKLADY.md); rozhodnutí M&D. Bez PITR je ztráta
   dat nejvýš 24 h; zálohu navíc dělá postup v PROVOZ.md („Zálohy a obnova“).
4. **Auth** (*Authentication → Sign In / Providers*): Email zapnout, *Allow new
   users to sign up* **vypnout** (uživatele zakládá správce), *Site URL* =
   `https://www.mummiesdaddies.com`, *Redirect URLs* = `https://www.mummiesdaddies.com/auth/**`.
   MFA (TOTP) zapnuté (aplikace ho vynucuje).
5. *Authentication → Emails → SMTP*: vlastní SMTP přes Google Workspace
   (`smtp-relay.gmail.com` nebo aplikační heslo schránky `info@`), ať pozvánky
   a reset hesla chodí z domény M&D a ne s limitem vestavěného SMTP.
6. Klíče (*Project Settings → API Keys*): **Publishable** a **Secret** →
   do Vercelu (krok 4). Starý `anon` / `service_role` JWT nepoužívat.
7. Připojovací řetězec (*Connect → Session pooler*) → GitHub secret (krok 1.5).

**Kontrola:** projekt je ve Frankfurtu (*Project Settings → General → Region*),
plán Pro, v *Database → Backups* je vidět denní záloha.

## 3. Založení databáze od nuly [Enter]

Migrace jsou v `supabase/migrations/` (0001–0106, záměrné mezery 0076, 0077,
0097). Spouští je vždy běhač `scripts/migrate.mjs` (každá migrace ve vlastní
transakci, evidence v `schema_migration`).

**a) Ověření na počítači, bez sítě (PGlite):**

```bash
npm ci
node scripts/db-bootstrap.mjs --pglite --seed
```

Pustí celý řetěz od nuly tímtéž běhačem (včetně 0031/0032 s Vaultem a
pgcrypto), nahraje ukázková data a zkontroluje: úplný ledger, RLS na všech
tabulkách, uzly `obchod/eventy/vedeni` a enum obchodních linek proti
`config/mummiesDaddies.ts`, žádný předem nastavený správce. Totéž hlídá
`test/db-bootstrap-pglite.test.ts` v CI.

**b) Staging** (z GitHubu: *Actions → Migrace databáze → staging → plan*, pak
*apply*; nebo lokálně s `STAGING_DB_URL` v `.env.local`):

```bash
node scripts/migrate.mjs --target=staging            # plán, nic nemění
node scripts/migrate.mjs --target=staging --apply    # založí 0001–0106
node scripts/db-bootstrap.mjs --target=staging --seed # ukázková data + kontrola
```

Na skutečném Supabase existuje Vault i `extensions.pgcrypto`, 0031/0032 proběhnou
normálně. Historické výjimky `LEGACY_*` ve `scripts/migrate-lib.mjs` (0029/0030
bez řádku v ledgeru, 0031/0032 s vlastní transakcí) běhač na prázdném projektu
zvládne sám — ověřeno během (a).

**c) Produkce** — až po ověření stagingu, **nikdy se seedem**:

```bash
node scripts/migrate.mjs --target=production                         # plán (kontroluje, že staging už vše má)
node scripts/migrate.mjs --target=production --apply --yes-production
node scripts/db-bootstrap.mjs --target=production                    # kontrola, odhalí i omylem nahraný seed
```

**d) První uživatel a správce** (Supabase → *Authentication → Users → Invite
user*, e-mail CEO; řádek `team_member` vznikne triggerem). V *SQL Editor*:

```sql
UPDATE team_member SET is_admin = true WHERE lower(email) = lower('<e-mail CEO>');
-- vlastníci uzlů Loop Core (po pozvání CSO a vedoucího eventů):
UPDATE loop_node SET owner_id = (SELECT id FROM team_member WHERE lower(email) = lower('<e-mail CSO>')) WHERE node = 'obchod';
```

Ostatní zve správce z Cockpitu. Každý si při prvním přihlášení nastaví TOTP.

**e) Zkouška obnovy** (před pilotem, jednou): postup v PROVOZ.md „Zálohy a obnova“.

**Kontrola:** `db-bootstrap --target=production` vypíše „Kontrola po založení prošla“.

## 4. Vercel [M&D + Enter]

1. **[M&D]** <https://vercel.com> → tým M&D, plán **Pro** (minutové crony a
   delší funkce jsou jen na Pro; Hobby navíc zakazuje komerční použití).
   Pozvat Enter jako *Member* (platí se za nasazující místa — viz NAKLADY.md;
   alternativně Enter jen jako *Viewer* a nasazuje se z GitHubu).
2. *Add New → Project → Import Git Repository* → repozitář z kroku 1.
   Framework Next.js se pozná sám; `buildCommand` (`npm run build:release`),
   **region `fra1`** a crony bere z `vercel.json`.
3. *Settings → Functions*: Fluid compute zapnuté (výchozí), *Function Region*
   musí ukazovat **Frankfurt (fra1)** — stejné místo jako Supabase.
   Úlohy agenta (`/api/cron/inquiry-agent`, `/api/cron/agent-outbox`) mají
   `export const maxDuration = 300` přímo v kódu routy (hlídá
   `test/ops-alarm.test.ts`).
4. *Settings → Environment Variables*: všechny povinné proměnné z tabulky
   níže pro **Production**; pro **Preview** jen hodnoty stagingu (jiný
   Supabase projekt!) a všechny přepínače `*_ENABLED` vypnuté.
5. *Settings → Deployment Protection*: Vercel Authentication pro Preview
   zapnout (náhledy nejsou veřejné).
6. Crony (`vercel.json`, čas UTC):

   | Cesta | Plán | Účel |
   | --- | --- | --- |
   | `/api/cron/inquiry-agent` | každých 5 min | čtení pošty (Gmail) a rozhodnutí agenta (P2) |
   | `/api/cron/agent-outbox` | každých 5 min (+2) | odeslání schválených odpovědí přes Gmail (P3) |
   | `/api/cron/ops-alarm` | každých 5 min (+4) | alarm správci do 15 minut |
   | `/api/cron/follow-ups` | denně 06:00 | hlídač follow-upů, vypršení schválení |
   | `/api/cron/weekly-digest` | denně 05:00 | přehled e-mailem (zatím přes Graph — vypnuto) |
   | `/api/cron/ares-enrich` | denně 04:00 | doplnění IČO z ARES |
   | `/api/cron/outlook-mail` | denně 04:00 | původní sync Microsoft 365 — u M&D vypnuto |

   Každý cron bez svého přepínače vrací 404 a ověřuje `Authorization: Bearer
   CRON_SECRET` (Vercel ho posílá sám, když je proměnná nastavená).
   Kdo chce rychlejší odezvu agenta, zkrátí plán na `* * * * *` (Pro to
   dovoluje; náklad viz NAKLADY.md).

**Kontrola:** deploy z `main` je zelený, `https://<projekt>.vercel.app/api/health`
vrací `{"status":"ok"}`.

## 5. Google Workspace: Gmail přes interní OAuth aplikaci [M&D správce + Enter]

Pošta M&D je **Google Workspace** (ověřeno v MX záznamech), proto Gmail API,
ne Microsoft Graph. Aplikace je **interní** (jen pro uživatele domény
mummiesdaddies.com): nepotřebuje ověření od Googlu a refresh tokeny nevyprší
po 7 dnech jako u externích aplikací v režimu testování.

1. **[M&D správce]** <https://console.cloud.google.com> přihlášený účtem
   z domény → *Select project → New project*: název `md-cockpit`,
   **Organization = mummiesdaddies.com** (ne „No organization“). Fakturace
   není potřeba (Gmail API je zdarma).
2. *IAM & Admin → IAM → Grant access*: Enter (e-mail z jeho domény) s rolí
   *Editor* jen na tento projekt (lze odebrat po spuštění).
3. *APIs & Services → Library* → **Gmail API** → *Enable*.
4. *APIs & Services → OAuth consent screen* (Google Auth Platform):
   - *User type*: **Internal**,
   - název aplikace „Mummies and Daddies Cockpit“, support e-mail `it@…`,
     logo volitelné, *Authorized domains*: `mummiesdaddies.com`,
   - *Data access → Add scopes*: `https://www.googleapis.com/auth/gmail.readonly`
     a `https://www.googleapis.com/auth/gmail.send` — **nic víc** (ne
     `gmail.modify`, ne `mail.google.com`).
5. *Clients → Create client → Web application*: Client ID →
   `GMAIL_OAUTH_CLIENT_ID`, Client secret → `GMAIL_OAUTH_CLIENT_SECRET`
   (rovnou do Vercelu; tajemství Google ukáže jen jednou). Aplikace nemá
   vlastní návratovou adresu — refresh tokeny schránek se získají jednorázově
   (bod 7) a uloží do proměnné, ne do databáze.
6. **[M&D správce] Souhlas správce** — <https://admin.google.com> →
   *Security → Access and data control → API controls → Manage App Access →
   Configure new app* → vyhledat Client ID → *Trusted* (uživatelé pak nejsou
   blokováni zásadami pro aplikace třetích stran a nevidí varování).
7. **Které schránky:**

   | Schránka | Čtení (`gmail.readonly`) | Odesílání (`gmail.send`) | Proč |
   | --- | --- | --- | --- |
   | `info@mummiesdaddies.com` | ano | ne | sem chodí většina poptávek z webu a e-mailů |
   | CSO (`obchod@…`, vlastník leadu — OVĚŘIT adresu) | ano | **ano** | `replyFrom: 'lead_owner'` — odpovědi agenta jdou jejím jménem a do jejího vlákna |
   | CEO | ano | ne | poptávky přeposílané CEO → CSO (deduplikace) |

   Pokud `info@` je skupina (Google Group), ne schránka, čte se doručená kopie
   ve schránce CSO a `info@` se nepřipojuje — ověřit v Admin konzoli
   (*Directory → Groups*).
   Každý vlastník schránky jednou udělí souhlas interní aplikaci (např.
   v OAuth 2.0 Playground s vlastním Client ID, rozsahy z bodu 4, *Access
   type: offline*). Refresh tokeny všech schránek jdou do jediné tajné
   proměnné `GMAIL_REFRESH_TOKENS` jako JSON `{"adresa schránky": "token"}`.
   Čtení (agent poptávek, P2) i odesílání (odchozí fronta P3, outbound P7)
   berou token ze stejného místa — společný modul `connectors/gmail`
   (token.ts). Čtené schránky: `INQUIRY_AGENT_MAILBOXES` (adresy čárkou).
   Odesílací schránka fronty je e-mail člena týmu v Cockpitu a musí mít
   token v `GMAIL_REFRESH_TOKENS`; oddělená schránka outboundu
   (`nabidky@info.…`, config) taky.
8. Kontrola tokenu: `setup-check` ověří první token z `GMAIL_REFRESH_TOKENS`
   (nebo `GMAIL_CHECK_REFRESH_TOKEN`, je-li nastavený) a rozsahy
   gmail.readonly + gmail.send; zkontroluje i to, že každá schránka
   z `INQUIRY_AGENT_MAILBOXES` token má.

> Alternativa bez osobní autorizace (service account s delegací v rámci
> domény) je možná, ale dává aplikaci přístup ke **všem** schránkám domény;
> pro tři schránky ji nedoporučujeme.

**Kontrola:** `setup-check` → „Gmail OAuth: klient platí“ (a s testovacím tokenem
„rozsahy gmail.readonly + gmail.send“).

## 6. Anthropic [M&D]

1. <https://console.anthropic.com> → organizace „Mummies and Daddies s.r.o.“
   (firemní e-mail), *Billing*: karta M&D, **předplacený kredit** (ne
   automatické dobíjení bez limitu) — doporučení 50 USD na start.
2. *Settings → Limits → Spend limit*: měsíční strop **50 USD** (s rezervou
   několikanásobku odhadu v NAKLADY.md); *Notifications*: upozornění na 50 %,
   80 % a 100 % na `it@…`.
3. *Settings → Workspaces*: workspace `cockpit-produkce` (a zvlášť
   `cockpit-staging` s nízkým limitem, např. 5 USD). Limit útraty jde nastavit
   i na workspace.
4. *API Keys → Create key* ve workspace produkce, název `vercel-produkce` →
   `ANTHROPIC_API_KEY` ve Vercelu. Klíč pro staging zvlášť.
5. Agent používá model `claude-opus-5-5` (čtení poptávky), import PDF
   `claude-sonnet-5`. Denní strop volání modelu agentem je v konfiguraci firmy
   (`config/mummiesDaddies.ts`, `inquiryAgent.modelDailyLimit`), ne v proměnné.
6. Data: API Anthropic ve výchozím stavu neučí modely na datech zákazníků
   (obchodní podmínky API); retence logů je omezená — M&D si uloží DPA
   (Anthropic → *Settings → Privacy / Legal*) do dokumentace GDPR.

**Kontrola:** `setup-check --live` → „Anthropic: klíč platí, model claude-opus-5-5 odpovídá“.

## 7. Mapy.com a Cloudflare Turnstile [M&D]

**Mapy.com** (geokódování místa akce → vzdálenost pro dopravu):
1. <https://developer.mapy.com> → přihlásit firemním Seznam účtem → *Můj účet
   → Projekty → Nový projekt* „md-cockpit“ (tarif Basic, 250 000 kreditů
   měsíčně zdarma).
2. *API klíče → Vytvořit*; v *Zabezpečení klíče* omezit na REST API.
   → `MAPY_API_KEY` ve Vercelu. Přepínač `GEO_ENABLED=true` až v pilotu.
3. Platba nad bezplatný limit jde přes Seznam Peněženku — nastavit, nebo nechat
   jen bezplatný limit (při vyčerpání agent eskaluje na člověka, nic neodejde).

**Cloudflare Turnstile** (ochrana formulářů a přihlášení před roboty, zdarma):
1. <https://dash.cloudflare.com> (účet M&D; doména na Cloudflare být nemusí) →
   *Turnstile → Add widget*: název „mummiesdaddies.com“, hostnames
   `mummiesdaddies.com`, `www.mummiesdaddies.com` (a staging doména), mode
   *Managed*.
2. Site key → `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, Secret key → `TURNSTILE_SECRET_KEY`.

**Kontrola:** `setup-check` → „Turnstile: tajný klíč přijat“; `--live` → „Mapy.com: klíč platí“.

## 8. DNS: přepnutí z Wixu [spolu]

Dnes web běží na Wixu. Cíl: web a Cockpit na Vercelu, **pošta beze změny**
na Google Workspace. Nejdřív zjistit, **kde je doména registrovaná** (`whois
mummiesdaddies.com`, pole *Registrar*): Wix (doména koupená přes Wix), nebo
jiný registrátor s DNS u Wixu.

**Checklist před přepnutím (den předem):**

- [ ] **Export všech DNS záznamů** z Wixu (*Domains → … → Manage DNS
      Records*) — snímek obrazovky a přepis do tabulky (typ, název, hodnota,
      TTL). Kontrola z venku: `dig mummiesdaddies.com ANY`, `dig MX`, `dig TXT`,
      `dig TXT _dmarc.mummiesdaddies.com`, `dig TXT google._domainkey.mummiesdaddies.com`,
      a všechny subdomény (`www`, `cs`, `en`, …).
- [ ] Zapsat a **zachovat beze změny**:
  - **MX** Google Workspace (`smtp.google.com` priorita 1, nebo starší sada
    `aspmx.l.google.com` …),
  - **SPF** TXT na kořeni (`v=spf1 include:_spf.google.com ~all` — pokud
    obsahuje i Wix nebo jiné služby, které posílají poštu, ponechat),
  - **google-site-verification** TXT (ověření domény ve Workspace — bez něj
    hrozí ztráta správy domény),
  - případné další TXT/CNAME (Seznam, Facebook, Mailchimp, …).
- [ ] Snížit TTL záznamů `@` a `www` na 300 s (den předem).
- [ ] Seznam starých URL webu na Wixu (sitemap `https://www.mummiesdaddies.com/sitemap.xml`)
      → tabulka přesměrování 301 na nové adresy (dodává balík P6 do
      konfigurace webu / `next.config.ts` `redirects()`); obzvlášť e-shop
      cheesecaků a stránky, na které vedou reklamy a Google Maps.

**Přepnutí:**

1. Ve Vercelu *Project → Settings → Domains*: přidat `mummiesdaddies.com`
   a `www.mummiesdaddies.com` (primární `www`, kořen přesměrovat 308 na `www`),
   a `cs.mummiesdaddies.com` s *Redirect to* `https://www.mummiesdaddies.com`
   (301/308 — trvalé).
2. Varianta A — **DNS zůstává u Wixu/registrátora**: upravit jen
   `A @ → 76.76.21.21` a `CNAME www → cname.vercel-dns.com` (přesné hodnoty
   ukáže Vercel u domény), `CNAME cs → cname.vercel-dns.com`. Ostatní
   záznamy nechat.
   Varianta B — **DNS do Vercelu** (nameservery `ns1/ns2.vercel-dns.com`):
   nejdřív ve Vercelu ručně založit **všechny** exportované záznamy (MX, SPF,
   google-site-verification, DKIM, DMARC, ostatní), teprve pak změnit
   nameservery u registrátora. Doporučujeme **variantu A** (menší riziko pro
   poštu).
3. Odpojit doménu od Wix webu (ale nerušit Wix doménu, pokud je tam
   registrovaná — jen převést správu / prodloužit).

**Doplnění DKIM a DMARC** (pošta odchozí od agenta musí projít u příjemců):

1. **DKIM** — Admin konzole Google → *Apps → Google Workspace → Gmail →
   Authenticate email* → *Generate new record*, délka **2048**, selektor
   **`google`** → přidat TXT `google._domainkey` s vygenerovanou hodnotou
   (u Wixu případně rozdělit dlouhý řetězec podle jejich návodu) → po
   propagaci *Start authentication*.
2. **DMARC** — TXT `_dmarc`:
   `v=DMARC1; p=none; rua=mailto:dmarc@mummiesdaddies.com; fo=1`
   Po 2–4 týdnech bez problémů v reportech přejít na `p=quarantine`, později
   `p=reject`. Adresa `dmarc@` = skupina / alias ve Workspace.
3. **Kontrola:** poslat zkušební e-mail z Gmailu M&D na externí adresu
   (např. Seznam, Gmail) → *Zobrazit originál*: `SPF: PASS`, `DKIM: PASS`
   (d=mummiesdaddies.com), `DMARC: PASS`. Nástroj: <https://toolbox.googleapps.com/apps/checkmx/>.

**Kontrola po přepnutí:** `https://www.mummiesdaddies.com` ukazuje nový web,
`https://cs.mummiesdaddies.com/cokoli` → 301 na `www`, staré URL → 301,
MX se nezměnily (`dig MX`), pošta chodí oběma směry, ve Workspace *Domains*
je doména stále ověřená.

## 9. Kontrola nasazení, alarm, uptime monitor [Enter]

```bash
vercel env pull .env.production.local --environment=production
node scripts/setup-check.mjs --env-file=.env.production.local          # proměnné, Supabase, Turnstile, Gmail
node scripts/setup-check.mjs --env-file=.env.production.local --live   # + Anthropic (1 token) a Mapy.com (1 dotaz)
rm .env.production.local
```

Skript nevypisuje žádné tajemství (jen „nastaveno“ / chyba a kde hodnotu vzít).
Návratový kód 1 = je co opravit.

**Alarm do 15 minut** (podrobnosti v PROVOZ.md):
1. Založit příjemce alarmu, např. scénář Make / Zapier „Custom webhook →
   e-mail správci + SMS (SMS brána / Twilio)“, nebo Slack/Teams incoming
   webhook. URL → `ALERT_WEBHOOK_URL`, pak `OPS_ALARM_ENABLED=true`.
2. **Uptime monitor** (Better Stack / UptimeRobot / Checkly, účet M&D):
   HTTP kontrola `https://www.mummiesdaddies.com/api/health?strict=1` každé
   1–3 min, alarm při ne-200 e-mailem + SMS na správce. Volitelně hlavička
   `Authorization: Bearer <HEALTH_TOKEN>` pro detail v těle odpovědi.
   Druhý monitor na úvodní stránku webu a na `/poptavka` (formulář).

## 10. Pilot — zapínání po jednom [spolu]

Každý přepínač zvlášť, s den až týden pozorování:

1. `FOLLOWUP_WATCH_ENABLED`, `ARES_ENRICH_ENABLED`, `OPS_ALARM_ENABLED`.
2. `INQUIRY_AGENT_ENABLED` (agent čte a navrhuje; všechno jde na schválení).
3. `AGENT_OUTBOX_ENABLED` (odchází jen schválené odpovědi).
4. `GEO_ENABLED`, `FOLLOWUP_CADENCE_ENABLED`, `WEB_INTAKE_ENABLED`,
   `WEB_RETENTION_ENABLED`; outbound (`OUTBOUND_AGENT_ENABLED` a zdroje) až
   po odsouhlasení ICP a šablon (docs/OUTBOUND.md).
5. Samostatné odeslání bez člověka (`AGENT_AUTOSEND_ENABLED`,
   `OUTBOUND_AUTOSEND_ENABLED`): až po schválení cenové mapy (verze nezačíná
   `ilustracni`), pravomoci L4 v `authority_policy` a snížení
   `autoSendMaxTotal` na hodnotu dohodnutou s CEO — rozhodnutí CEO, zapisuje
   se do PROVOZ.md (změnový deník).

Microsoft 365 přepínače (`OUTLOOK_*`, `MS_*`, `DIGEST_SEND_*`,
`SHAREPOINT_*`, `MAIL_CONTENT_*`, `MAIL_OFFER_*`) zůstávají **vypnuté** —
M&D nemá Microsoft 365.

---

## Tabulka proměnných prostředí

Úplný seznam je ve `scripts/env-catalog.mjs` (z něj se generuje `.env.example`
a kontroluje `setup-check`; test hlídá, že kód nečte nic, co tu chybí).
🔒 = tajemství (jen ve Vercelu / GitHub secrets / trezoru, nikdy v repozitáři).
„Zavádí“: *základ* = už v kódu, *P2–P8* = balík, který proměnnou čte
(po integraci jsou názvy sjednocené se skutečným kódem).
Proměnné původních integrací Microsoft 365 a iDokladu jsou v `.env.example`
v oddílu „Původní“ — u M&D se nenastavují.

**Supabase**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `SUPABASE_URL` | Adresa projektu Supabase (https://<ref>.supabase.co) | Supabase → Project Settings → API → Project URL | ano | — | základ |
| `SUPABASE_PUBLISHABLE_KEY` | Veřejný klíč (sb_publishable_…) pro přihlášení a dotazy s RLS | Supabase → Project Settings → API Keys → Publishable key | ano | — | základ |
| `SUPABASE_SECRET_KEY` 🔒 | Servisní klíč (sb_secret_…), obchází RLS — jen server, crony, RPC webu | Supabase → Project Settings → API Keys → Secret key | ano | — | základ |
| `NEXT_PUBLIC_SUPABASE_URL` | Starší název SUPABASE_URL (záložní čtení) — nenastavovat | — | ne | — | základ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Starší název publishable klíče (záložní čtení) — nenastavovat | — | ne | — | základ |
| `SUPABASE_SERVICE_ROLE_KEY` 🔒 | Starší název servisního klíče (záložní čtení) — nenastavovat | — | ne | — | základ |

**Migrace (GitHub)**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `SUPABASE_DB_URL` 🔒 | Připojovací řetězec produkční DB pro scripts/migrate.mjs (Session pooler) | Supabase → Connect → Session pooler; GitHub secret prostředí production | ne | — | základ |
| `STAGING_DB_URL` 🔒 | Připojovací řetězec stagingu | Staging projekt Supabase → Connect → Session pooler; GitHub secret | ne | — | základ |
| `PRODUCTION_PROJECT_REFS` | Ref(y) produkčního projektu, na které staging nesmí ukazovat | Supabase → Project Settings → General → Reference ID | ne | — | základ |
| `MIGRATE_DB_TLS_INSECURE` | Jen lokální zkouška proti jinému Postgresu (=1 neověřuje TLS). Nikdy proti Supabase | — | ne | — | základ |

**Aplikace**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `APP_URL` | Veřejná adresa (https://www.mummiesdaddies.com) — odkazy v e-mailech, OAuth | Doména projektu ve Vercelu | ano | — | základ |
| `CRON_SECRET` 🔒 | Bearer tajemství, kterým Vercel Cron volá /api/cron/* | Vygenerovat: openssl rand -hex 32 (Vercel ho posílá sám) | ano | — | základ |
| `MFA_ENFORCED` | false vypne povinné dvoufázové přihlášení — v produkci NIKDY | — | ne | zapnuto | základ |
| `OAUTH_REDIRECT_HOSTS` | Další povolené hosty pro OAuth klienty MCP (čárkou) | Jen při napojení dalšího AI klienta | ne | — | základ |
| `TURNSTILE_SECRET_KEY` 🔒 | Ověření Cloudflare Turnstile (přihlášení, formuláře webu /api/web/*) | Cloudflare → Turnstile → Add widget (doména mummiesdaddies.com) → Secret key | ano | — | základ |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Veřejný klíč widgetu Turnstile v prohlížeči | Cloudflare → Turnstile → Site key | ano | — | základ |

**Provoz a alarm**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `OPS_ALARM_ENABLED` | true zapne cron /api/cron/ops-alarm (alarm do 15 minut) | Zapnout po nastavení ALERT_WEBHOOK_URL | ne | vypnuto | P8 |
| `ALERT_WEBHOOK_URL` 🔒 | HTTPS webhook, který alarm přepošle e-mailem / SMS správci | Make/Zapier scénář „Webhook → e-mail + SMS“, Slack/Teams incoming webhook | při OPS_ALARM_ENABLED=true | — | P8 |
| `OPS_ALARM_REPEAT_MINUTES` | Za jak dlouho připomenout trvající problém (15–1440) | — | ne | 180 | P8 |
| `OPS_EXPECTED_JOBS` | Úlohy hlídané na „přestala běžet“ (název:minuty) | — | ne | inquiry-agent:20,agent-outbox:20 | P8 |
| `HEALTH_TOKEN` 🔒 | Bearer pro detail /api/health (bez něj jen ok/degraded/down) | Vygenerovat: openssl rand -hex 24; vložit do uptime monitoru | ne | — | P8 |

**Gmail**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `GMAIL_OAUTH_CLIENT_ID` | OAuth klient interní aplikace v Google Cloud projektu klienta (čtení i odesílání) | Google Cloud → APIs & Services → Credentials → OAuth client ID (Web) | při INQUIRY_AGENT_ENABLED=true | — | P2/P3 |
| `GMAIL_OAUTH_CLIENT_SECRET` 🔒 | Tajemství OAuth klienta | Tamtéž (Client secret) | při INQUIRY_AGENT_ENABLED=true | — | P2/P3 |
| `GMAIL_REFRESH_TOKENS` 🔒 | Refresh tokeny schránek jako JSON {"adresa schránky": "refresh token"} (rozsahy gmail.readonly + gmail.send) | Jednorázová autorizace každé schránky (docs/NASAZENI.md, Gmail); vložit do Vercelu | při INQUIRY_AGENT_ENABLED=true | — | P2/P3 |
| `GMAIL_CHECK_REFRESH_TOKEN` 🔒 | Jen pro setup-check: refresh token jedné schránky k ověření (do Vercelu nedávat) | Jednorázově z autorizace schránky; po kontrole smazat z .env.local | ne | první z GMAIL_REFRESH_TOKENS | P8 |

**Agent**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `INQUIRY_AGENT_ENABLED` | true zapne cron /api/cron/inquiry-agent (čtení pošty a rozhodnutí) | Zapnout až po pilotu se schválením | ne | vypnuto | P2 |
| `INQUIRY_AGENT_MAILBOXES` | Čtené schránky (adresy čárkou); každá musí mít token v GMAIL_REFRESH_TOKENS | Schránky vedení / obchodu / poptavky@ v Google Workspace | při INQUIRY_AGENT_ENABLED=true | — | P2 |
| `AGENT_OUTBOX_ENABLED` | true zapne cron /api/cron/agent-outbox (odesílání přes Gmail; jen schválené zprávy) | Zapnout až po pilotu | ne | vypnuto | P3 |
| `AGENT_AUTOSEND_ENABLED` | true dovolí odeslání bez člověka (navíc L4 v Cockpitu a schválená mapa) | Až po dohodě s vedením (pravomoc L4) | ne | vypnuto | P3 |
| `ANTHROPIC_API_KEY` 🔒 | Klíč Anthropic API (čtení poptávek, PDF nabídek) | console.anthropic.com → organizace klienta → API Keys (s limitem útraty) | při INQUIRY_AGENT_ENABLED=true | — | základ |
| `AI_PDF_DAILY_LIMIT` | Denní strop čtení PDF modelem (import nabídek) | — | ne | 40 | základ |
| `GEO_ENABLED` | true zapne geokódování místa akce (vzdálenost pro dopravu, Mapy.com) | — | ne | vypnuto | P2 |
| `MAPY_API_KEY` 🔒 | Klíč Mapy.com API (geokódování adresy akce) | developer.mapy.com → účet klienta → projekt → API klíč | při GEO_ENABLED=true | — | P2 |
| `FOLLOWUP_CADENCE_ENABLED` | true zapne připomínky neodpovězených nabídek přes odchozí frontu (cron /api/cron/follow-ups) | Zapnout s FOLLOWUP_WATCH_ENABLED | ne | vypnuto | P4 |

**Outbound agent**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `OUTBOUND_AGENT_ENABLED` | true zapne cron /api/cron/outbound-agent (signály, leady, oslovení) | Až po odsouhlasení ICP a šablon s CSO | ne | vypnuto | P7 |
| `OUTBOUND_AUTOSEND_ENABLED` | true dovolí oslovení bez člověka (jen stávající zákazníci a doložený souhlas) | — | ne | vypnuto | P7 |
| `OUTBOUND_UNSUBSCRIBE_SECRET` 🔒 | Podpis odkazu na odhlášení (min. 32 znaků); bez něj žádné oslovení neodejde | Vygenerovat: openssl rand -hex 32 | při OUTBOUND_AGENT_ENABLED=true | — | P7 |
| `OUTBOUND_ARES_ENABLED` | Zdroj signálů ARES (nové firmy) | — | ne | vypnuto | P7 |
| `OUTBOUND_FEEDS_ENABLED` | Zdroj signálů z RSS/iCal kalendářů akcí | — | ne | vypnuto | P7 |
| `OUTBOUND_JOBS_ENABLED` | Zdroj signálů z inzerátů práce | — | ne | vypnuto | P7 |
| `VVZ_ENABLED` | Zdroj signálů z veřejných zakázek (ISVZ) | — | ne | vypnuto | P7 |
| `VVZ_OPEN_DATA_URL` | Adresa JSON exportu otevřených dat veřejných zakázek | Portál ISVZ → otevřená data (OVĚŘIT) | při VVZ_ENABLED=true | — | P7 |

**Veřejný web**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `WEB_INTAKE_ENABLED` | true zapne příjem poptávek a objednávek z webu (/api/web/*); bez něj 503 | Až po smlouvě o zpracování a zveřejnění informací | ne | vypnuto | P6 |
| `WEB_RETENTION_ENABLED` | true zapne denní retenci údajů z webu (/api/cron/web-retention) | — | ne | vypnuto | P6 |
| `NEXT_PUBLIC_WEB_INSTANT_OFFER_CLAIM` | true = web slibuje nabídku do pár minut (jen když agent opravdu odesílá sám) | — | ne | vypnuto | P6 |

**Ostatní úlohy**

| Proměnná | Účel | Kde se získá | Povinná | Výchozí | Zavádí |
| --- | --- | --- | --- | --- | --- |
| `FOLLOWUP_WATCH_ENABLED` | true zapne denní cron /api/cron/follow-ups (hlídač follow-upů, vypršení schválení) | Zapnout po prvním uživateli | ne | vypnuto | základ |
| `ARES_ENRICH_ENABLED` | true zapne denní doplňování IČO z ARES (veřejný registr, bez klíče) | — | ne | vypnuto | základ |
| `IDOKLAD_SYNC_ENABLED` | Sync iDokladu (modul finance je vypnutý) | — | ne | vypnuto | základ |
| `IDOKLAD_CLIENT_ID` | iDoklad API klient | iDoklad → Nastavení → API | při IDOKLAD_SYNC_ENABLED=true | — | základ |
| `IDOKLAD_CLIENT_SECRET` 🔒 | iDoklad API tajemství | iDoklad → Nastavení → API | při IDOKLAD_SYNC_ENABLED=true | — | základ |
| `TURBOPACK_ROOT` | Jen vývoj: kořen Turbopacku při běhu z git worktree | — | ne | — | P6 |
| `IDOKLAD_SYNC_DAYS` | Kolik dní zpět číst faktury | — | ne | 90 | základ |
