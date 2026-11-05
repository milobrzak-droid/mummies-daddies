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

Úplný seznam je v `.env.example`. Všechny přepínače `*_ENABLED` jsou ve
výchozím stavu vypnuté; integrace bez nich nic neodesílá ani nevolá.

- Supabase: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`.
- Aplikace: `APP_URL` (veřejná adresa), `CRON_SECRET`, Turnstile klíče.
- Microsoft 365 (pošta a kalendář): `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
  `MS_TENANT_ID`, `MS_REDIRECT_URI` (`https://<doména>/api/ms/callback`).
- Model (čtení poptávek a PDF): `ANTHROPIC_API_KEY`.
- iDoklad zůstává vypnutý (`IDOKLAD_SYNC_ENABLED` nenastavovat).

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

Vercel: `buildCommand = npm run build:release` (typy, lint, testy, build).
Crony ve `vercel.json` bez zapnutého přepínače vracejí 404.
