// Katalog proměnných prostředí — JEDINÝ zdroj pravdy pro scripts/setup-check.mjs,
// .env.example a tabulku v docs/NASAZENI.md (test/env-catalog.test.ts hlídá,
// že všechny tři sedí a že kód nečte proměnnou, která tu chybí).
//
// required:
//   'always'  — bez ní aplikace v produkci nefunguje (setup-check = chyba),
//   'if:X'    — povinná, když je zapnutý přepínač X (X === 'true'),
//   'no'      — volitelná.
// secret: true = hodnotu nikdy nevypisovat (setup-check ukáže jen „nastaveno“).
// owner: kdo proměnnou zavádí. 'základ' = už v kódu; 'P8' = tento balík;
//   'návrh P2/P3' = jméno navržené tímto balíkem pro práci paralelních
//   balíků (Gmail, agent, geokódování) — pokud ji balík pojmenuje jinak,
//   upraví se jen tady a v docs/NASAZENI.md.
// where: odkud hodnotu vzít (pro klienta, česky).

/** @typedef {{ name: string, group: string, required: string, secret: boolean, def: string, purpose: string, where: string, owner: string }} EnvVar */

/** @type {EnvVar[]} */
export const ENV_CATALOG = [
  // --- Supabase ---
  { name: 'SUPABASE_URL', group: 'Supabase', required: 'always', secret: false, def: '', owner: 'základ',
    purpose: 'Adresa projektu Supabase (https://<ref>.supabase.co)', where: 'Supabase → Project Settings → API → Project URL' },
  { name: 'SUPABASE_PUBLISHABLE_KEY', group: 'Supabase', required: 'always', secret: false, def: '', owner: 'základ',
    purpose: 'Veřejný klíč (sb_publishable_…) pro přihlášení a dotazy s RLS', where: 'Supabase → Project Settings → API Keys → Publishable key' },
  { name: 'SUPABASE_SECRET_KEY', group: 'Supabase', required: 'always', secret: true, def: '', owner: 'základ',
    purpose: 'Servisní klíč (sb_secret_…), obchází RLS — jen server, crony, RPC webu', where: 'Supabase → Project Settings → API Keys → Secret key' },
  { name: 'NEXT_PUBLIC_SUPABASE_URL', group: 'Supabase', required: 'no', secret: false, def: '', owner: 'základ',
    purpose: 'Starší název SUPABASE_URL (záložní čtení) — nenastavovat', where: '—' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', group: 'Supabase', required: 'no', secret: false, def: '', owner: 'základ',
    purpose: 'Starší název publishable klíče (záložní čtení) — nenastavovat', where: '—' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', group: 'Supabase', required: 'no', secret: true, def: '', owner: 'základ',
    purpose: 'Starší název servisního klíče (záložní čtení) — nenastavovat', where: '—' },

  // --- Migrace (jen GitHub Actions / lokálně, NE ve Vercelu) ---
  { name: 'SUPABASE_DB_URL', group: 'Migrace (GitHub)', required: 'no', secret: true, def: '', owner: 'základ',
    purpose: 'Připojovací řetězec produkční DB pro scripts/migrate.mjs (Session pooler)', where: 'Supabase → Connect → Session pooler; GitHub secret prostředí production' },
  { name: 'STAGING_DB_URL', group: 'Migrace (GitHub)', required: 'no', secret: true, def: '', owner: 'základ',
    purpose: 'Připojovací řetězec stagingu', where: 'Staging projekt Supabase → Connect → Session pooler; GitHub secret' },
  { name: 'PRODUCTION_PROJECT_REFS', group: 'Migrace (GitHub)', required: 'no', secret: false, def: '', owner: 'základ',
    purpose: 'Ref(y) produkčního projektu, na které staging nesmí ukazovat', where: 'Supabase → Project Settings → General → Reference ID' },
  { name: 'MIGRATE_DB_TLS_INSECURE', group: 'Migrace (GitHub)', required: 'no', secret: false, def: '', owner: 'základ',
    purpose: 'Jen lokální zkouška proti jinému Postgresu (=1 neověřuje TLS). Nikdy proti Supabase', where: '—' },

  // --- Aplikace ---
  { name: 'APP_URL', group: 'Aplikace', required: 'always', secret: false, def: '', owner: 'základ',
    purpose: 'Veřejná adresa (https://www.mummiesdaddies.com) — odkazy v e-mailech, OAuth', where: 'Doména projektu ve Vercelu' },
  { name: 'CRON_SECRET', group: 'Aplikace', required: 'always', secret: true, def: '', owner: 'základ',
    purpose: 'Bearer tajemství, kterým Vercel Cron volá /api/cron/*', where: 'Vygenerovat: openssl rand -hex 32 (Vercel ho posílá sám)' },
  { name: 'MFA_ENFORCED', group: 'Aplikace', required: 'no', secret: false, def: 'zapnuto', owner: 'základ',
    purpose: 'false vypne povinné dvoufázové přihlášení — v produkci NIKDY', where: '—' },
  { name: 'OAUTH_REDIRECT_HOSTS', group: 'Aplikace', required: 'no', secret: false, def: '', owner: 'základ',
    purpose: 'Další povolené hosty pro OAuth klienty MCP (čárkou)', where: 'Jen při napojení dalšího AI klienta' },
  { name: 'TURNSTILE_SECRET_KEY', group: 'Aplikace', required: 'always', secret: true, def: '', owner: 'základ',
    purpose: 'Ověření Cloudflare Turnstile (přihlášení, formuláře webu /api/web/*)', where: 'Cloudflare → Turnstile → Add widget (doména mummiesdaddies.com) → Secret key' },
  { name: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', group: 'Aplikace', required: 'always', secret: false, def: '', owner: 'základ',
    purpose: 'Veřejný klíč widgetu Turnstile v prohlížeči', where: 'Cloudflare → Turnstile → Site key' },

  // --- Provoz a alarm (P8) ---
  { name: 'OPS_ALARM_ENABLED', group: 'Provoz a alarm', required: 'no', secret: false, def: 'vypnuto', owner: 'P8',
    purpose: 'true zapne cron /api/cron/ops-alarm (alarm do 15 minut)', where: 'Zapnout po nastavení ALERT_WEBHOOK_URL' },
  { name: 'ALERT_WEBHOOK_URL', group: 'Provoz a alarm', required: 'if:OPS_ALARM_ENABLED', secret: true, def: '', owner: 'P8',
    purpose: 'HTTPS webhook, který alarm přepošle e-mailem / SMS správci', where: 'Make/Zapier scénář „Webhook → e-mail + SMS“, Slack/Teams incoming webhook' },
  { name: 'OPS_ALARM_REPEAT_MINUTES', group: 'Provoz a alarm', required: 'no', secret: false, def: '180', owner: 'P8',
    purpose: 'Za jak dlouho připomenout trvající problém (15–1440)', where: '—' },
  { name: 'OPS_EXPECTED_JOBS', group: 'Provoz a alarm', required: 'no', secret: false, def: 'inquiry-agent:20,agent-outbox:20', owner: 'P8',
    purpose: 'Úlohy hlídané na „přestala běžet“ (název:minuty)', where: '—' },
  { name: 'HEALTH_TOKEN', group: 'Provoz a alarm', required: 'no', secret: true, def: '', owner: 'P8',
    purpose: 'Bearer pro detail /api/health (bez něj jen ok/degraded/down)', where: 'Vygenerovat: openssl rand -hex 24; vložit do uptime monitoru' },

  // --- Gmail (Google Workspace klienta) — P2 čtení, P3 odesílání, společný connectors/gmail ---
  { name: 'GMAIL_OAUTH_CLIENT_ID', group: 'Gmail', required: 'if:INQUIRY_AGENT_ENABLED', secret: false, def: '', owner: 'P2/P3',
    purpose: 'OAuth klient interní aplikace v Google Cloud projektu klienta (čtení i odesílání)', where: 'Google Cloud → APIs & Services → Credentials → OAuth client ID (Web)' },
  { name: 'GMAIL_OAUTH_CLIENT_SECRET', group: 'Gmail', required: 'if:INQUIRY_AGENT_ENABLED', secret: true, def: '', owner: 'P2/P3',
    purpose: 'Tajemství OAuth klienta', where: 'Tamtéž (Client secret)' },
  { name: 'GMAIL_REFRESH_TOKENS', group: 'Gmail', required: 'if:INQUIRY_AGENT_ENABLED', secret: true, def: '', owner: 'P2/P3',
    purpose: 'Refresh tokeny schránek jako JSON {"adresa schránky": "refresh token"} (rozsahy gmail.readonly + gmail.send)', where: 'Jednorázová autorizace každé schránky (docs/NASAZENI.md, Gmail); vložit do Vercelu' },
  { name: 'GMAIL_CHECK_REFRESH_TOKEN', group: 'Gmail', required: 'no', secret: true, def: 'první z GMAIL_REFRESH_TOKENS', owner: 'P8',
    purpose: 'Jen pro setup-check: refresh token jedné schránky k ověření (do Vercelu nedávat)', where: 'Jednorázově z autorizace schránky; po kontrole smazat z .env.local' },

  // --- Agent poptávek, odchozí fronta, model ---
  { name: 'INQUIRY_AGENT_ENABLED', group: 'Agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P2',
    purpose: 'true zapne cron /api/cron/inquiry-agent (čtení pošty a rozhodnutí)', where: 'Zapnout až po pilotu se schválením' },
  { name: 'INQUIRY_AGENT_MAILBOXES', group: 'Agent', required: 'if:INQUIRY_AGENT_ENABLED', secret: false, def: '', owner: 'P2',
    purpose: 'Čtené schránky (adresy čárkou); každá musí mít token v GMAIL_REFRESH_TOKENS', where: 'Schránky vedení / obchodu / poptavky@ v Google Workspace' },
  { name: 'AGENT_OUTBOX_ENABLED', group: 'Agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P3',
    purpose: 'true zapne cron /api/cron/agent-outbox (odesílání přes Gmail; jen schválené zprávy)', where: 'Zapnout až po pilotu' },
  { name: 'AGENT_AUTOSEND_ENABLED', group: 'Agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P3',
    purpose: 'true dovolí odeslání bez člověka (navíc L4 v Cockpitu a schválená mapa)', where: 'Až po dohodě s vedením (pravomoc L4)' },
  { name: 'ANTHROPIC_API_KEY', group: 'Agent', required: 'if:INQUIRY_AGENT_ENABLED', secret: true, def: '', owner: 'základ',
    purpose: 'Klíč Anthropic API (čtení poptávek, PDF nabídek)', where: 'console.anthropic.com → organizace klienta → API Keys (s limitem útraty)' },
  { name: 'AI_PDF_DAILY_LIMIT', group: 'Agent', required: 'no', secret: false, def: '40', owner: 'základ',
    purpose: 'Denní strop čtení PDF modelem (import nabídek)', where: '—' },
  { name: 'GEO_ENABLED', group: 'Agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P2',
    purpose: 'true zapne geokódování místa akce (vzdálenost pro dopravu, Mapy.com)', where: '—' },
  { name: 'MAPY_API_KEY', group: 'Agent', required: 'if:GEO_ENABLED', secret: true, def: '', owner: 'P2',
    purpose: 'Klíč Mapy.com API (geokódování adresy akce)', where: 'developer.mapy.com → účet klienta → projekt → API klíč' },
  { name: 'FOLLOWUP_CADENCE_ENABLED', group: 'Agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P4',
    purpose: 'true zapne připomínky neodpovězených nabídek přes odchozí frontu (cron /api/cron/follow-ups)', where: 'Zapnout s FOLLOWUP_WATCH_ENABLED' },

  // --- Outbound agent (P7, docs/OUTBOUND.md) ---
  { name: 'OUTBOUND_AGENT_ENABLED', group: 'Outbound agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P7',
    purpose: 'true zapne cron /api/cron/outbound-agent (signály, leady, oslovení)', where: 'Až po odsouhlasení ICP a šablon s CSO' },
  { name: 'OUTBOUND_AUTOSEND_ENABLED', group: 'Outbound agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P7',
    purpose: 'true dovolí oslovení bez člověka (jen stávající zákazníci a doložený souhlas)', where: '—' },
  { name: 'OUTBOUND_UNSUBSCRIBE_SECRET', group: 'Outbound agent', required: 'if:OUTBOUND_AGENT_ENABLED', secret: true, def: '', owner: 'P7',
    purpose: 'Podpis odkazu na odhlášení (min. 32 znaků); bez něj žádné oslovení neodejde', where: 'Vygenerovat: openssl rand -hex 32' },
  { name: 'OUTBOUND_ARES_ENABLED', group: 'Outbound agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P7', purpose: 'Zdroj signálů ARES (nové firmy)', where: '—' },
  { name: 'OUTBOUND_FEEDS_ENABLED', group: 'Outbound agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P7', purpose: 'Zdroj signálů z RSS/iCal kalendářů akcí', where: '—' },
  { name: 'OUTBOUND_JOBS_ENABLED', group: 'Outbound agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P7', purpose: 'Zdroj signálů z inzerátů práce', where: '—' },
  { name: 'VVZ_ENABLED', group: 'Outbound agent', required: 'no', secret: false, def: 'vypnuto', owner: 'P7', purpose: 'Zdroj signálů z veřejných zakázek (ISVZ)', where: '—' },
  { name: 'VVZ_OPEN_DATA_URL', group: 'Outbound agent', required: 'if:VVZ_ENABLED', secret: false, def: '', owner: 'P7',
    purpose: 'Adresa JSON exportu otevřených dat veřejných zakázek', where: 'Portál ISVZ → otevřená data (OVĚŘIT)' },

  // --- Veřejný web (P6) ---
  { name: 'WEB_INTAKE_ENABLED', group: 'Veřejný web', required: 'no', secret: false, def: 'vypnuto', owner: 'P6',
    purpose: 'true zapne příjem poptávek a objednávek z webu (/api/web/*); bez něj 503', where: 'Až po smlouvě o zpracování a zveřejnění informací' },
  { name: 'WEB_RETENTION_ENABLED', group: 'Veřejný web', required: 'no', secret: false, def: 'vypnuto', owner: 'P6',
    purpose: 'true zapne denní retenci údajů z webu (/api/cron/web-retention)', where: '—' },
  { name: 'NEXT_PUBLIC_WEB_INSTANT_OFFER_CLAIM', group: 'Veřejný web', required: 'no', secret: false, def: 'vypnuto', owner: 'P6',
    purpose: 'true = web slibuje nabídku do pár minut (jen když agent opravdu odesílá sám)', where: '—' },

  // --- Původní integrace (pro tuto firmu vypnuté) ---
  { name: 'MS_GRAPH_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'P2',
    purpose: 'true zpřístupní trasy /api/ms/* (Outlook); klient má Google Workspace', where: '—' },
  { name: 'OUTLOOK_MAIL_SYNC_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ',
    purpose: 'Sync pošty přes Microsoft Graph — klient má Google Workspace, nechat vypnuté', where: '—' },
  { name: 'OUTLOOK_MAIL_SYNC_MEMBER_ID', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Člen týmu pro Graph sync', where: '—' },
  { name: 'OUTLOOK_MAIL_WEBHOOK_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Webhook Graph', where: '—' },
  { name: 'MS_CLIENT_ID', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Registrace aplikace Entra ID', where: '—' },
  { name: 'MS_CLIENT_SECRET', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: true, def: '', owner: 'základ', purpose: 'Tajemství Entra ID', where: '—' },
  { name: 'MS_TENANT_ID', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'common', owner: 'základ', purpose: 'Tenant Entra ID', where: '—' },
  { name: 'MS_REDIRECT_URI', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Callback Graph OAuth', where: '—' },
  { name: 'MS_APP_CLIENT_ID', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Aplikační registrace pro přehled e-mailem (režim app)', where: '—' },
  { name: 'MS_APP_CLIENT_SECRET', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: true, def: '', owner: 'základ', purpose: 'Tajemství aplikační registrace', where: '—' },
  { name: 'MS_APP_TENANT_ID', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Tenant aplikační registrace', where: '—' },
  { name: 'GRAPH_FILES_SCOPE_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Rozsah Files.Read.All', where: '—' },
  { name: 'SHAREPOINT_DOC_SYNC_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Kontrola dokumentů v SharePointu', where: '—' },
  { name: 'SHAREPOINT_DOC_SYNC_MEMBER_ID', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Člen pro SharePoint', where: '—' },
  { name: 'CALENDAR_SYNC_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'zapnuto s follow-upy', owner: 'základ', purpose: 'Kontrola schůzek v Outlooku (false = vypnout)', where: '—' },
  { name: 'DIGEST_SEND_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Přehled e-mailem přes Graph', where: '—' },
  { name: 'DIGEST_SEND_MODE', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'delegated', owner: 'základ', purpose: 'Režim odeslání přehledu', where: '—' },
  { name: 'DIGEST_RECIPIENTS', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Příjemci přehledu (jen firemní adresy)', where: '—' },
  { name: 'DIGEST_SENDER', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Odesílatel přehledu (režim app)', where: '—' },
  { name: 'DIGEST_SENDER_MEMBER_ID', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Člen, jehož tokenem se přehled posílá', where: '—' },
  { name: 'MAIL_CONTENT_INTAKE_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Čtení obsahu pošty ze složky Outlooku', where: '—' },
  { name: 'MAIL_CONTENT_AI_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Model nad obsahem pošty', where: '—' },
  { name: 'MAIL_CONTENT_FOLDER', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Název složky Outlooku', where: '—' },
  { name: 'MAIL_CONTENT_FOLDER_CREATE', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Založit složku automaticky', where: '—' },
  { name: 'MAIL_OFFER_ATTACHMENT_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Čtení PDF nabídek z odeslané pošty', where: '—' },
  { name: 'MAIL_OFFER_ATTACHMENT_KEYWORDS', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '', owner: 'základ', purpose: 'Klíčová slova příloh nabídek', where: '—' },
  { name: 'MAIL_SYNC_INITIAL_DAYS', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: '120', owner: 'základ', purpose: 'Okno prvního načtení pošty', where: '—' },
  { name: 'CAPABILITY_AUTO_INTAKE_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Automatický příjem z pošty (Graph)', where: '—' },
  { name: 'AUTO_INTAKE_DAILY_LIMIT', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'z konfigurace', owner: 'základ', purpose: 'Denní limit automatického příjmu', where: '—' },
  { name: 'CAPABILITY_MAIL_TO_CASE_ENABLED', group: 'Původní (Microsoft 365) — nepoužívat', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Případ z pošty', where: '—' },
  { name: 'FOLLOWUP_WATCH_ENABLED', group: 'Ostatní úlohy', required: 'no', secret: false, def: 'vypnuto', owner: 'základ',
    purpose: 'true zapne denní cron /api/cron/follow-ups (hlídač follow-upů, vypršení schválení)', where: 'Zapnout po prvním uživateli' },
  { name: 'ARES_ENRICH_ENABLED', group: 'Ostatní úlohy', required: 'no', secret: false, def: 'vypnuto', owner: 'základ',
    purpose: 'true zapne denní doplňování IČO z ARES (veřejný registr, bez klíče)', where: '—' },
  { name: 'IDOKLAD_SYNC_ENABLED', group: 'Ostatní úlohy', required: 'no', secret: false, def: 'vypnuto', owner: 'základ', purpose: 'Sync iDokladu (modul finance je vypnutý)', where: '—' },
  { name: 'IDOKLAD_CLIENT_ID', group: 'Ostatní úlohy', required: 'if:IDOKLAD_SYNC_ENABLED', secret: false, def: '', owner: 'základ', purpose: 'iDoklad API klient', where: 'iDoklad → Nastavení → API' },
  { name: 'IDOKLAD_CLIENT_SECRET', group: 'Ostatní úlohy', required: 'if:IDOKLAD_SYNC_ENABLED', secret: true, def: '', owner: 'základ', purpose: 'iDoklad API tajemství', where: 'iDoklad → Nastavení → API' },
  { name: 'PREVIEW_BASIC_AUTH', group: 'Ostatní úlohy', required: 'no', secret: true, def: '', owner: 'náhled',
    purpose: 'Jen uzavřený náhled: heslo prohlížeče na celou aplikaci ve tvaru uživatel:heslo; v ostrém provozu nenastavovat', where: 'Vygenerovat a předat jen lidem s přístupem k náhledu' },
  { name: 'TURBOPACK_ROOT', group: 'Ostatní úlohy', required: 'no', secret: false, def: '', owner: 'P6',
    purpose: 'Jen vývoj: kořen Turbopacku při běhu z git worktree', where: '—' },
  { name: 'IDOKLAD_SYNC_DAYS', group: 'Ostatní úlohy', required: 'no', secret: false, def: '90', owner: 'základ', purpose: 'Kolik dní zpět číst faktury', where: '—' },
]

// Proměnné, které kód čte, ale nastavuje je platforma — do katalogu nepatří.
export const PLATFORM_VARS = new Set(['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'])

export function isRequired(v, env) {
  if (v.required === 'always') return true
  if (v.required.startsWith('if:')) return env[v.required.slice(3)] === 'true'
  return false
}

/** Obsah .env.example z katalogu (bez hodnot tajemství). */
export function renderEnvExample() {
  const lines = [
    '# Proměnné prostředí — vzor. Generuje se ze scripts/env-catalog.mjs',
    '# (node scripts/setup-check.mjs --write-env-example); ručně needitovat.',
    '# Postup a tabulka: docs/NASAZENI.md. Lokálně zkopírovat do .env.local.',
    '# Všechny přepínače *_ENABLED jsou ve výchozím stavu vypnuté.',
  ]
  let group = ''
  for (const v of ENV_CATALOG) {
    if (v.group !== group) {
      group = v.group
      lines.push('', `# --- ${group} ---`)
    }
    const req = v.required === 'always' ? 'povinná' : v.required.startsWith('if:') ? `povinná při ${v.required.slice(3)}=true` : 'volitelná'
    lines.push(`# ${v.purpose} (${req}${v.def ? `; výchozí: ${v.def}` : ''})`)
    lines.push(`${v.required === 'always' ? '' : '# '}${v.name}=`)
  }
  lines.push('', '# --- Nastavuje platforma (Vercel, Node, GitHub Actions) — nevyplňovat ---', `# ${[...PLATFORM_VARS].join(', ')}`)
  return lines.join('\n') + '\n'
}
