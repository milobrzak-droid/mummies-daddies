# Outbound agent (balík P7)

Druhý agent ze zadání (kap. 3–4, varianta B): **signály → kvalifikace → lead do CRM → legální oslovení**.
Agent hledá příležitosti, ale **novým firmám nic neposílá** — připraví lead, kontext a návrh osobního
oslovení pro člověka. E-mail smí odejít jen stávajícím zákazníkům (u obdobných služeb) a kontaktům
s doloženým souhlasem, vždy s odkazem na odhlášení a přes odchozí frontu `agent_outbox`.

Vše je za přepínačem `OUTBOUND_AGENT_ENABLED` (výchozí vypnuto). Samostatné odeslání je navíc za
`OUTBOUND_AUTOSEND_ENABLED`; bez něj agent připravuje jen koncepty ke schválení.

## Tok

```
zdroje (konektory za přepínači)      CRM (výročí, sezóna)
            │                                 │
            └────────► outbound_signal ◄──────┘   idempotentně (source + external_ref)
                              │
                 kvalifikace podle ICP (core/outbound/qualify.ts)
                 ARES + CRM kontext → skóre 0–100 a kódy důvodů
                              │
     blocked / dismissed ◄────┼────► review (rozhodne CSO na /cockpit/signaly)
                              ▼
                     lead: obchod ve fázi „Poptávka", pilíř firemních akcí,
                     deal.source = 'agent:outbound:<zdroj>' (štítek „Agent")
                              │
                 právní brána (core/outbound/outreachPolicy.ts)
          ┌───────────────────┼──────────────────────┐
     manual               review_email            auto_email
  návrh pro člověka     koncept ke schválení    schválený pravidlem
  (telefon, osobně,     (CSO „Schválit")        (jen s OUTBOUND_AUTOSEND_ENABLED)
   LinkedIn ručně)               └──────────┬───────────┘
   nic se neodesílá                         ▼
                         agent_outbox_enqueue (kind 'outreach', source_ref 'outreach:<id>')
                         jen v okně odesílání, do denního limitu, z ODDĚLENÉ schránky
```

Úloha: `GET /api/cron/outbound-agent` (Bearer `CRON_SECRET`, zámek `runJob('outbound-agent')`,
`maxDuration` 300 s, cron ve všední dny 08:45 UTC — `vercel.json`).

## Zdroje signálů

| Zdroj | Konektor | Přepínač | Poznámka |
|---|---|---|---|
| ARES — údaje o firmě | `connectors/ares` (už v repu) | `OUTBOUND_ARES_ENABLED` | Obohacení: IČO, sídlo, NACE, právní forma. Podle jména jen jednoznačná shoda (`pickAresMatch`). |
| Veřejné zakázky | `connectors/vvz` | `VVZ_ENABLED` + `VVZ_OPEN_DATA_URL` | Otevřená data Portálu ISVZ (Registr VZ s údaji z Věstníku, NEN…; JSON od 2/2024). Filtr CPV (catering 5552…, 5532…) a klíčová slova. **OVĚŘIT** adresu exportu a strukturu; parser je obranný. Limit 2 MB na odpověď — ukazujte na filtrovaný/měsíční export. |
| Akce a eventy | `connectors/feeds` | `OUTBOUND_FEEDS_ENABLED` | RSS 2.0, Atom, iCal z `outboundAgent.sources.feeds` (konfigurace). Jen veřejné URL. |
| Inzeráty office manager / event / HR | `connectors/jobs` | `OUTBOUND_JOBS_ENABLED` | Veřejný RSS/JSON výpis z `outboundAgent.sources.jobs`. Bez přihlášení a bez scrapování HTML. Z inzerátu se nebere jméno ani e-mail náboráře — jen firma a pozice. |
| Stávající klienti | `core/outbound/crmSignals.ts` | (součást agenta) | Výročí poslední vyhrané akce (45 dní předem) a sezóny (vánoční večírky 1. 9.–31. 10., letní party 1. 4.–31. 5.). Jen firmy bez otevřeného obchodu, jen pilíř firemních akcí. |

Všechny konektory: timeout, `credentials: 'omit'`, URL s přihlašovacími údaji odmítnuta, chyba zdroje
se zapíše kódem a ostatní zdroje běží dál. Obsah zdrojů je nedůvěryhodný — ukládá se zkrácený jako
**ověřená fakta** (`facts`: co přesně zdroj uvádí + odkaz).

## Kvalifikace (ICP)

Pravidla v `COMPANY.capabilities.outboundAgent.icp` a `scoring`:

- **Tvrdé vyloučení (blocked):** vyloučené IČO, slovo v názvu (např. konkurence), NACE konkurence
  (56.21, 56.29), firma/kontakty nesouhlasí s oslovením.
- **Nemá smysl (dismissed):** rozjednaný obchod, oslovení v posledních 90 dnech, nízké skóre.
- **Review:** neznámá firma, sídlo mimo region (Praha a Středočeský kraj), fyzická osoba (OSVČ),
  hraniční skóre.
- **Lead:** skóre ≥ 70 a firma jednoznačně určená.

## Právní rámec (K OVĚŘENÍ PRÁVNÍKEM)

> Tohle je technické shrnutí pro návrh systému, ne právní stanovisko. Před zapnutím
> `OUTBOUND_AUTOSEND_ENABLED` ho musí potvrdit právník firmy.

1. **Zákon č. 480/2004 Sb., o některých službách informační společnosti, § 7.** Obchodní sdělení
   šířené elektronickou poštou je možné jen uživateli, který k tomu dal **předchozí souhlas**
   (§ 7 odst. 2). ÚOOÚ to vykládá i pro adresy firem a jejich zaměstnanců — **studený e-mail nové
   firmě je proto zakázaný** a agent ho technicky neumí odeslat (CHECK `basis <> 'none' OR channel = 'manual'`
   v 0107 a `decideOutreach`).
2. **Výjimka § 7 odst. 3 — stávající zákazník.** Elektronický kontakt získaný v souvislosti s prodejem
   lze použít pro obchodní sdělení **k vlastním obdobným produktům a službám**, pokud zákazník má
   jasnou možnost odmítnout jednoduše a zdarma při získání kontaktu **i v každé zprávě**.
   Systém: „stávající zákazník" = firma s vyhraným obchodem nebo vyplněným „klient od";
   „obdobná služba" = jen signály z CRM se šablonou pro stávající klienty (catering a akce).
   **K ověření:** zda byl zákazník při prodeji poučen o možnosti odmítnutí (VOP, potvrzení objednávky).
3. **Souhlas** (pro kontakty, které nejsou zákazníky): evidence v `outreach_consent` — přesné znění,
   verze znění, čas, zdroj (web, akce, papír, e-mail) a odvolání. Bez kompletní evidence se e-mail
   nepošle (`consent_incomplete`). Souhlas musí být svobodný, konkrétní, informovaný a prokazatelný
   (čl. 7 GDPR).
4. **Každá zpráva** musí být označená jako obchodní sdělení, nést identifikaci odesílatele
   (§ 7 odst. 4 písm. b) a c)) a platnou adresu pro odmítnutí. Systém přidává patičku
   (`outreach.footer`, **OVĚŘIT: doplnit IČO a sídlo**) a odkaz na odhlášení s podepsaným tokenem
   + hlavičky `List-Unsubscribe` / `List-Unsubscribe-Post` (RFC 8058).
5. **GDPR čl. 6 odst. 1 písm. f) — oprávněný zájem.** Zpracování údajů kontaktních osob firem pro
   B2B oslovení (lead v CRM, osobní oslovení) stojí na oprávněném zájmu. **K ověření:** test
   vyváženosti (LIA), informační povinnost čl. 14 při prvním kontaktu, právo vznést námitku (čl. 21).
   Systém: jen pracovní adresy (freemail → jen ruční návrh), fyzické osoby/OSVČ jen na review,
   z inzerátů se neberou osobní údaje, opt-out přežije výmaz kontaktu (jen otisk adresy).
6. **Opt-out:** odkaz v e-mailu → `/api/web/odhlaseni` → `outbound_unsubscribe`: otisk adresy do
   `outreach_suppression`, kontakty s adresou dostanou „Nesouhlasí s oslovením" (0087), souhlas se
   odvolá, rozpracované koncepty se přeskočí. Odpověď „nepište mi" zapíše CSO tlačítkem
   „Zapsat odhlášení". Odhlášení funguje i při vypnutém agentovi.
7. **Personalizace jen z ověřených faktů.** Šablony schvaluje firma; zástupné symboly se doplní jen
   z faktů signálu/CRM, chybí-li fakt, e-mail nevznikne. Model text nanejvýš stylizuje —
   `checkStylizedText` zahodí stylizaci, která přidá čísla, data, odkazy nebo adresy (napojení modelu
   je zatím vypnuté, viz Co zbývá).

## Odesílání a reputace domény

- Outbound odchází **jen z oddělené schránky** `outreach.senderMailboxEmail` na subdoméně
  (`nabidky@info.mummiesdaddies.com`, **OVĚŘIT a založit** v Google Workspace jako team_member).
  Když schránka v týmu chybí, úloha nic nezařadí (`sender_mailbox_missing`) — nikdy nepadá zpět na
  hlavní schránku. Subdoména potřebuje vlastní SPF, DKIM (selektor google) a DMARC.
- Denní limit 15, okno Út–Čt 9–16 (pražský čas), VIP/citlivé firmy (`vipAccountIds`) vždy přes schválení.

## Cockpit

`/cockpit/signaly` (záložka „Signály" v Obchodech, modul `agent`, jen obchodní role s AAL2):
filtr podle stavu, skóre a důvody, ověřená fakta, odkaz na zdroj, lead s příznakem „Agent".
Akce (RPC `outbound_review`, ověří roli i AAL2 v DB): **Založit lead**, **Odložit**, **Znovu zvážit**,
u oslovení **Schválit k odeslání** (jen e-mail s právním titulem), **Zamítnout**, **Osloveno ručně**,
**Zapsat odhlášení**. Nic z Cockpitu neodesílá přímo — schválený koncept zařadí úloha.

## Data a audit (migrace 0107)

`outbound_signal`, `outbound_outreach`, `outreach_consent`, `outreach_suppression` — RLS: čte obchodní
role s AAL2, z klienta nikdo nezapisuje. Měkký audit nese jen id, stavy, data a počty (nikdy názvy,
texty, IČO, URL ani otisk). Logy a statistiky úlohy obsahují jen počty a kódy.

## Integrace s ostatními balíky

- **P3 (agent_outbox):** kontrakt zná `kind` offer|info_request|follow_up. P7 posílá `kind: 'outreach'`
  a `source_ref: 'outreach:<id>'` a navíc `headers` (List-Unsubscribe). Potřeba v P3:
  `agent_outbox_enqueue` musí přijmout `outreach` (0107 rozšíří CHECK `agent_outbox_kind_check`,
  pokud se tak jmenuje), `OUTBOX_SOURCE_REF_RE` rozšířit o `outreach`, odeslání přenést hlavičky,
  dodržet okno odesílání outbound (P3 cron běží 06:30 UTC — mimo okno Út–Čt 9–16) a po odeslání
  nastavit `outbound_outreach.status = 'sent'` (nebo ho P7 dočte z `agent_outbox` podle `source_ref`).
  Dokud RPC chybí, oslovení zůstává „schváleno" a zkusí se příště.
- **P2/P5:** `deal.source` přidává 0107 jako `ADD COLUMN IF NOT EXISTS` (bez CHECK). Pokud pole
  zavede jiný balík s CHECKem, musí povolit předponu `agent:outbound:`.
- **P6:** odhlášení je route handler `/api/web/odhlaseni` (bez Turnstile — brána je HMAC token);
  test/route-auth-guard ho má jako samostatnou třídu.
- **Retence/GDPR výmaz:** rozšířit sweep na `outbound_signal`/`outbound_outreach` (např. odložené
  signály 12 měsíců); `outreach_suppression` se nemaže (jen otisk, slouží k respektování námitky).

## Zapnutí (provoz)

1. Migrace 0107 (po 0104 P3, aby se rozšířil CHECK fronty).
2. Založit odesílací schránku na subdoméně + DNS (SPF, DKIM, DMARC), přidat ji jako člena týmu.
3. Doplnit `outboundAgent` v `config/mummiesDaddies.ts` (vše `OVĚŘIT`): patička s IČO a sídlem,
   zdroje RSS/iCal a inzerátů, vyloučené firmy, VIP.
4. Env: `OUTBOUND_UNSUBSCRIBE_SECRET` (min. 32 znaků), `OUTBOUND_AGENT_ENABLED=true`, zdroje podle
   potřeby. Pilot nechat **bez** `OUTBOUND_AUTOSEND_ENABLED` (vše přes schválení CSO).
5. Po právním posouzení (oddíl výše) případně `OUTBOUND_AUTOSEND_ENABLED=true`.
