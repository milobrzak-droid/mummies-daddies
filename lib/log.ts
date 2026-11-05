// Záznam chyby. Zní to jako maličkost, ale audit ukázal, že v aplikaci
// bylo přes 40 míst, která chybu zachytila a beze stopy zahodila — takže
// když integrace selhala, nezůstalo po ní vůbec nic a jediný způsob, jak
// se to dozvědět, bylo všimnout si po týdnech chybějících dat.
//
// Na Vercelu končí console.error v runtime logu, který jde prohledávat
// i posílat dál. Až přibude Sentry, mění se jen tělo téhle funkce.

type Context = Record<string, unknown>

// `details` a `hint` z chyb PostgREST/Postgres se NIKDY nelogují. U porušení
// CHECK / NOT NULL / UNIQUE je v `details` celý řádek dat ("Failing row
// contains (...)", "Key (email)=(...) already exists"), tedy texty zápisů,
// e-maily a telefony, které by skončily v runtime logu (retence, přístup,
// log drain). Z chyby zůstává kód, zpráva a kontext volajícího.
const NEVER_LOGGED_KEYS = new Set(['details', 'hint'])

function stripSensitive(_key: string, value: unknown): unknown {
  return NEVER_LOGGED_KEYS.has(_key) ? undefined : value
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value, stripSensitive) } catch { return String(value) }
}

// Postgres do hlášky „invalid input syntax for type uuid: "hodnota"" a „invalid
// input value for enum x: "hodnota"" opíše celý vstup, tedy třeba text z formuláře
// nebo e-mail. Ze zprávy se ta hodnota vypustí, zbytek (typ, sloupec) zůstává.
export function redactPgLiteral(message: string): string {
  return message.replace(/^(invalid input [^:\n]*): "[\s\S]*"$/i, '$1: "…"')
}

function describe(err: unknown): string {
  // PostgrestError z supabase-js je Error s vlastnostmi code/details/hint;
  // do logu jde jen jméno a zpráva (details/hint se sem nedostanou).
  if (err instanceof Error) return `${err.name}: ${redactPgLiteral(err.message)}`
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown }
    if (typeof code === 'string' || typeof message === 'string') {
      const parts: string[] = []
      if (typeof code === 'string') parts.push(`code=${JSON.stringify(code)}`)
      if (typeof message === 'string') parts.push(`message=${JSON.stringify(redactPgLiteral(message))}`)
      return parts.join(' ')
    }
  }
  return stringify(err)
}

// Context hodnoty vždy projdou JSON.stringify — i řetězce. Dřív se řetězec
// vkládal do logového řádku syrový (`k=${v}`), takže hodnota s \r/\n uvnitř
// (např. z CSP reportu nebo jiného externího vstupu) mohla rozseknout jeden
// log řádek na víc řádků a předstírat vlastní `[scope] ...` záznam (log
// injection). JSON.stringify escapuje \n/\r na \\n/\\r a řádek zůstane jeden.
function formatContext(context: Context): string {
  const parts = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${stringify(v)}`)
  return parts.length ? ` · ${parts.join(' ')}` : ''
}

/**
 * `scope` je název integrace nebo operace, ne soubor — v logu chceme vidět
 * „graph.fetch selhalo", ne cestu, která se při přesunu souboru rozejde.
 */
export function logError(scope: string, err: unknown, context: Context = {}): void {
  console.error(`[${scope}] ${describe(err)}${formatContext(context)}`)
}

/** Varování bez výjimky — něco proběhlo, ale ne tak, jak mělo. */
export function logWarn(scope: string, message: string, context: Context = {}): void {
  console.warn(`[${scope}] ${message}${formatContext(context)}`)
}
