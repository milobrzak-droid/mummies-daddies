// GDPR „právo na výmaz" — čisté funkce pro redakci osobních údajů (e-mail,
// jméno) z volného textu. Beze všeho I/O, ať jdou snadno a rychle testovat;
// volání do DB dělá domain/crm/gdprSweep.ts, který tyhle funkce jen používá.
//
// Kontext: bezpečnostní audit v této session zjistil, že smazání kontaktu
// (domain/crm/actions/contacts.ts → deleteContact) smaže řádek `contact`, ale
// jméno a e-mail dané osoby může dál viset ve volném textu
// `sales_activity.body` (poznámky z hovorů, shrnutí e-mailů apod.) — a
// ověřovací dotaz nad daty potvrdil, že v ten den existujících 55 řádcích
// `sales_activity` se e-mailová adresa vyskytuje v každém jednom. Bez
// redakce téhle volné textu nejde právo na výmaz poctivě tvrdit jako splněné.

/** Jednotný placeholder — použitý všude, aby šlo redigovaný text poznat na první pohled. */
export const REDACTION_PLACEHOLDER = '[odstraněno]'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rozdělí jméno na tokeny a vrátí je, jen pokud je jméno dost specifické na
 * redakci podle jména: alespoň dva tokeny oddělené bílým znakem a každý
 * dlouhý aspoň 2 znaky. Jinak `null` = podle jména se neredaguje (e-mail
 * tím dotčen není).
 *
 * Proč: jednoslovné či velmi krátké jméno („Jan", „a") je běžné slovo. Jeho
 * redakce by zaslepila každý samostatný výskyt v cizích poznámkách. Důsledek
 * pro volající: kontakt se jménem jen jedno slovo se v textu podle jména
 * nemaže, pokud je třeba, zbývá redakce podle e-mailu.
 */
export function nameTokensOf(name: string | null | undefined): string[] | null {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null
  if (tokens.some((t) => [...t].length < 2)) return null
  return tokens
}

export type PersonalIdentifiers = {
  email?: string | null
  name?: string | null
}

/**
 * Nahradí v `text` výskyty e-mailu a/nebo jména z `identifiers` placeholderem
 * `REDACTION_PLACEHOLDER`. Čistá funkce — žádné I/O, žádné vedlejší efekty.
 *
 * E-mail:
 * - porovnává se case-insensitive (adresy se v textu objevují v libovolném
 *   velikosti písmen),
 * - hledá se jako celý token, ne jako fuzzy podřetězec — hranice tokenu jsou
 *   znaky, které se v e-mailových adresách běžně vyskytují (písmena, číslice,
 *   tečka, podtržítko, %, +, -). Díky tomu se "jan.novak@firma.cz" nenajde
 *   jako podřetězec uvnitř "xjan.novak@firma.cz" ani "jan.novak@firma.czech",
 *   a naopak se najde i uprostřed věty typu "(jan.novak@firma.cz)".
 * - našich vzorů může být v textu víc (global flag) — každý výskyt se nahradí.
 *
 * Jméno:
 * - redaguje se jen jméno o aspoň dvou tokenech s délkou >= 2 (viz
 *   `nameTokensOf`); jednoslovné/krátké jméno se podle jména neredaguje.
 * - shoda toleruje opakované bílé znaky mezi tokeny a rozdíly velikosti
 *   písmen, ale NE diakritiku (žádné fuzzy párování).
 * - redaguje se POUZE jako celá fráze (ne jednotlivá slova zvlášť). Důvod: české jméno typu
 *   "Jan Novák" má obě části běžná, samostatně se vyskytující slova/příjmení
 *   — "Jan" je jedno z nejčastějších křestních jmen a mohl by se objevit
 *   v poznámce o úplně jiném člověku (jiný Jan, jiný Novák). Kdybychom
 *   redigovali "Jan" a "Novák" zvlášť, mohli bychom omylem smazat zmínku
 *   o někom jiném — to je vlastní typ chyby (falešná pozitiva), kterému
 *   se chceme vyhnout stejně jako nedostatečné redakci. Redakce celé fráze
 *   "Jan Novák" jako jednoho bloku je konzervativnější: nezasáhne text,
 *   který zmiňuje jen jednu z těch dvou částí zvlášť, i za cenu, že
 *   nezachytí volnější formulace (např. "Novák, Jan" nebo jen příjmení).
 *   To je vědomý kompromis ve prospěch nižšího rizika kolaterální redakce.
 * - hranice fráze se hlídají stejně jako u e-mailu (přes Unicode "písmeno
 *   nebo číslice"), aby "Jan Novák" nezasáhlo třeba "Jan Nováková".
 */
export function redactPersonalData(text: string, identifiers: PersonalIdentifiers): string {
  if (!text) return text
  let result = text

  const email = identifiers.email?.trim()
  if (email) {
    const escaped = escapeRegExp(email)
    // Hranice před shodou je záměrně přísnější než za ní. Vlevo hlídáme
    // i "." "_" "%" "+" "-", protože ty se v místní části e-mailu běžně
    // vyskytují — bez toho by "novak@firma.cz" omylem "ukouslo" kus delší
    // adresy "jan.novak@firma.cz". Vpravo hlídáme jen písmena/číslice: za
    // doménou/TLD stojí v prostém textu skoro vždy interpunkce (tečka konce
    // věty, čárka, závorka) a ta redakci nemá bránit — jinak by se
    // "jan.novak@firma.cz." na konci věty vůbec neredigovalo.
    const emailRe = new RegExp(`(?<![\\p{L}\\p{N}._%+-])${escaped}(?![\\p{L}\\p{N}])`, 'giu')
    result = result.replace(emailRe, REDACTION_PLACEHOLDER)
  }

  const nameTokens = nameTokensOf(identifiers.name)
  if (nameTokens) {
    // Tokeny se spojují přes \s+, takže opakované mezery, tabulátor či zalomení
    // řádku uvnitř jména shodu nerozbijí. Case-insensitive díky flagu `i`.
    const pattern = nameTokens.map(escapeRegExp).join('\\s+')
    const nameRe = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu')
    result = result.replace(nameRe, REDACTION_PLACEHOLDER)
  }

  return result
}

/**
 * Shrnutí toho, co redakce udělala — pro rozhodnutí, jestli je vůbec potřeba
 * řádek zapsat/auditovat (beze změny nemá smysl volat UPDATE ani recordAudit),
 * a pro případné logování počtu zásahů. Čistá funkce, žádné I/O.
 */
export function redactionSummary(
  original: string,
  redacted: string,
): { changed: boolean; placeholderCount: number } {
  if (original === redacted) return { changed: false, placeholderCount: 0 }
  const placeholderRe = new RegExp(escapeRegExp(REDACTION_PLACEHOLDER), 'g')
  const placeholderCount = redacted.match(placeholderRe)?.length ?? 0
  return { changed: true, placeholderCount }
}
