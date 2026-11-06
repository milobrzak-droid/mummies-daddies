import { Fragment } from 'react'
import { czechNbsp } from '@/lib/web/placeholders'
import { PlaceholderText } from './PlaceholderText'

/**
 * Titulek s JEDNÍM akcentovým slovem (docs/web-v2-design.md §1.2): „KAŽDÁ AKCE SI ZASLOUŽÍ
 * <malina>POŘÁDNÝ</malina> CATERING“. Text v DOM zůstává beze změny (čtečky, SEO, testy),
 * jen se jedno slovo obalí <span class="md-accent">.
 *
 * accent:
 *   - řetězec = přesný podřetězec titulku (první výskyt, bez ohledu na velikost písmen),
 *   - undefined = automaticky poslední plnovýznamové slovo (≥ 3 písmena),
 *   - false = bez akcentu.
 * tone: raspberry (Mummy, výchozí) / blue (Daddy).
 */
export type AccentTone = 'raspberry' | 'blue'

const WORD = /[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]/gu

export function autoAccent(title: string): string | null {
  if (/\[DOPLNÍ/.test(title)) return null
  const words = [...title.matchAll(WORD)].map((m) => m[0]).filter((w) => w.length >= 3 && !/^\d+$/.test(w))
  return words.at(-1) ?? null
}

export function AccentTitle({ title, accent, tone = 'raspberry' }: { title: string; accent?: string | false | null; tone?: AccentTone }) {
  const word = accent === false || accent === null ? null : accent ?? autoAccent(title)
  const at = word ? title.toLocaleLowerCase('cs').lastIndexOf(word.toLocaleLowerCase('cs')) : -1
  if (!word || at < 0) return <PlaceholderText text={title} />
  // Pro explicitní akcent bereme první výskyt, pro automatický poslední.
  const i = accent ? title.toLocaleLowerCase('cs').indexOf(word.toLocaleLowerCase('cs')) : at
  return (
    <Fragment>
      {czechNbsp(title.slice(0, i))}
      <span className={tone === 'blue' ? 'md-accent-blue' : 'md-accent'}>{title.slice(i, i + word.length)}</span>
      {czechNbsp(title.slice(i + word.length))}
    </Fragment>
  )
}
