/** Spojí třídy, vynechá prázdné hodnoty. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
