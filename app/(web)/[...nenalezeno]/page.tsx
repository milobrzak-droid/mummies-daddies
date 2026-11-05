import { notFound } from 'next/navigation'

/**
 * Neznámé adresy → 404 webu (app/(web)/not-found.tsx) i s hlavičkou a patičkou.
 * Bez tohoto catch-all by Next použil kořenovou 404 mimo layout webu.
 * Konkrétní stránky (i v hlavním systému) mají přednost, tahle cesta je poslední.
 * Pozn.: Next 16 při notFound() použije metadata layoutu (titulek úvodu) a sám
 * přidá <meta name="robots" content="noindex">.
 */
export default function UnknownPage(): never {
  notFound()
}
