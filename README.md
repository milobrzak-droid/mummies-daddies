# Mummies and Daddies — web a Cockpit

Jedna Next.js aplikace pro cateringovou firmu Mummies and Daddies:

- **veřejný web** na `/` (catering, eventy, cheesecaky, formulář nezávazné
  poptávky, objednávka cheesecaků),
- **interní Cockpit** pod `/cockpit` za přihlášením a dvoufázovým ověřením
  (zákazníci, poptávky a obchody, nabídky, realizace akcí, objednávky,
  přehled agenta),
- **agent příchozích poptávek**: poptávku z e-mailu nebo z webu zařadí,
  založí v CRM a podle schválené cenové mapy připraví standardní nabídku;
  nestandardní případy předá obchodu.

Technologie: Next.js 16 (App Router, `proxy.ts`), React 19, TypeScript,
Supabase (Postgres + Auth), Tailwind CSS 3, Vitest (+ PGlite pro testy SQL).

## Rychlý start

```bash
npm ci
cp .env.example .env.local   # doplň SUPABASE_URL a klíče
npm run dev                  # http://localhost:3000 (web), /cockpit (Cockpit)
```

Kontrola před nasazením (stejná jako build ve Vercelu):

```bash
npx tsc --noEmit && npx eslint . && npm run test:release
```

## Kde co je

| Cesta | Obsah |
| --- | --- |
| `config/mummiesDaddies.ts` | jediná konfigurace firmy (uzly, pilíře, cenová mapa, e-shop, moduly) |
| `core/` | pravidla bez hodnot firmy (nabídka z mapy, agent, kontrakty balíků) |
| `domain/` | doménová logika a dotazy |
| `connectors/` | napojení na Microsoft Graph, Anthropic, ARES, ČNB, iDoklad |
| `app/(web)/` | veřejný web |
| `app/cockpit/` | interní Cockpit |
| `supabase/migrations/` | schéma databáze (číslované migrace) |
| `supabase/seed.sql` | ukázková data (jen vývoj a staging) |

Provoz, proměnné prostředí, migrace a směrování: [docs/PROVOZ.md](docs/PROVOZ.md).

Všechno, co jde ven (odeslání e-mailu, volání modelu, geokódování), je za
přepínačem `*_ENABLED` a ve výchozím stavu vypnuté.
