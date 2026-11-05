import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { BlogArticlePage, blogArticleMetadata, blogStaticParams } from '@/components/web/duvera'
import { blogArticle } from '@/lib/web/duvera/blog'

/** /blog/<slug>: článek podle šablony copy (/blog/[slug]). Neznámý slug → 404. */
// Bez `dynamicParams = false`: v Next 16 se s ním předgenerované stránky
// vyrenderovaly přes sourozenecký catch-all app/(web)/[...nenalezeno] a všechny
// odpovídaly 404 (odkazy z úvodu a /catering/svatby vedly do prázdna, prefetch
// RSC se točil v přesměrování). Neznámý slug dál končí notFound() níže.

export function generateStaticParams() {
  return blogStaticParams()
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  return blogArticleMetadata(slug)
}

export default async function BlogArticleRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!blogArticle(slug)) notFound()
  return <BlogArticlePage slug={slug} />
}
