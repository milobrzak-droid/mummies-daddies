// Nouzový vypínač vynucení MFA. Výchozí stav = vynuceno. Hodnota
// MFA_ENFORCED=false vypne AAL2 bránu v proxy i v requireUser(); každé takové
// rozhodnutí se loguje jako varování, ať vypnutí nezůstane bez povšimnutí.
// Bez importů z next/headers, aby šel modul použít i v proxy.
export function mfaEnforced(): boolean {
  if (process.env.MFA_ENFORCED === 'false') {
    console.warn('[auth] MFA_ENFORCED=false — vynucení dvoufázového přihlášení je VYPNUTÉ.')
    return false
  }
  return true
}
