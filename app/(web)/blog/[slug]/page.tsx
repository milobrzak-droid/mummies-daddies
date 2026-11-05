import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { BlogArticlePage, blogArticleMetadata, blogStaticParams } from '@/components/web/duvera'
import { blogArticle } from '@/lib/web/duvera/blog'

/** /blog/<slug>: článek podle šablony copy (/blog/[slug]). Neznámý slug → 404. */
export const dynamicParams = false

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
