import type { Metadata } from 'next'
import { COMPANY, getPage, getSection, getSectionParsed, parseItem, splitDots } from '@/lib/web/content'
import {
  BLOG_ARTICLES,
  CLIENT_ARTICLE_PLACEHOLDER,
  PLANNED_ARTICLE_TAGS,
  blogArticle,
  blogSlugFromHref,
  relatedArticles,
  type BlogArticle,
} from '@/lib/web/duvera/blog'
import { contextInquiryHref, slugify } from '@/lib/web/duvera/links'
import { duveraMetadata } from '@/lib/web/duvera/metadata'
import { formatDate } from '@/lib/web/format'
import { CATERING_MENU, FOOTER_COLUMNS } from '@/lib/web/navigation'
import { getPhoto } from '@/lib/web/photos'
import { toneAt } from '@/lib/web/tokens'
import { Badge } from '../Badge'
import { Breadcrumbs } from '../Breadcrumbs'
import { Button } from '../Button'
import { Container } from '../Container'
import { Cta } from '../Cta'
import { PastelCard } from '../PastelCard'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'
import { ArticleBody } from './ArticleBody'
import { FilterGrid, type FilterItem } from './FilterGrid'

const LIST_PATH = '/blog'
const ARTICLE_TEMPLATE = '/blog/[slug]'

/** Popisek blogu v drobečkové navigaci (stejný jako v patičce). */
function blogLabel(): string {
  for (const col of FOOTER_COLUMNS) for (const l of col.links) if (l.href === LIST_PATH) return l.label
  return getSection(LIST_PATH, 'uvod').heading
}

/** „Vše“ pro filtr = první položka filtru z copy /reference („Filtr: Vše · …“). */
function allLabel(): string {
  return splitDots(parseItem(getSection('/reference', 'pripadovky').body).text)[0]
}

function ArticleMeta({ article }: { article: BlogArticle }) {
  return (
    <time dateTime={article.published} className="text-small text-cocoa-soft">
      {formatDate(article.published)}
    </time>
  )
}

/** Karty výpisu: doporučené články z copy; bez textu = karta se zástupcem bez odkazu. */
export function blogListItems() {
  return getSectionParsed(LIST_PATH, 'doporucene').parsedItems.map((it) => {
    const slug = blogSlugFromHref(it.href) ?? slugify(it.text)
    const article = blogArticle(slug)
    return { slug, title: it.text, article, tag: article?.tag ?? PLANNED_ARTICLE_TAGS[slug] ?? null }
  })
}

export function BlogListPage() {
  const uvod = getSection(LIST_PATH, 'uvod')
  const stitky = getSectionParsed(LIST_PATH, 'stitky')
  const doporucene = getSection(LIST_PATH, 'doporucene')
  const cta = getSectionParsed(LIST_PATH, 'cta')
  const options = stitky.parsedItems.map((t) => ({ value: slugify(t.text), label: t.text }))
  let photoIndex = 0
  const items: FilterItem[] = blogListItems().map((b, i) => {
    const a = b.article
    return {
      key: b.slug,
      tags: b.tag ? [slugify(b.tag)] : [],
      node: a ? (
        <PastelCard
          title={b.title}
          description={a.excerpt}
          href={`${LIST_PATH}/${a.slug}`}
          photo={getPhoto(a.photoSlot)}
          aspect="landscape"
          tone={toneAt(photoIndex++)}
          eyebrow={a.tag}
          meta={<ArticleMeta article={a} />}
          sizes="(min-width: 1280px) 400px, (min-width: 1024px) 31vw, (min-width: 640px) 48vw, 100vw"
        />
      ) : (
        <PastelCard title={b.title} description={CLIENT_ARTICLE_PLACEHOLDER} tone={toneAt(i, ['vanilla', 'pistachio', 'sage'])} eyebrow={b.tag} />
      ),
    }
  })
  // Hotové články napřed.
  items.sort((x, y) => Number(!blogArticle(x.key)) - Number(!blogArticle(y.key)))

  return (
    <>
      <Section tone="blush" soft labelledBy="blog-title" className="pb-section-sm pt-10 sm:pt-14">
        <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: blogLabel() }]} className="mb-8" />
        <div className="max-w-3xl motion-safe:animate-lift">
          <h1 id="blog-title" className="md-caps text-h1 text-cocoa">
            {uvod.heading}
          </h1>
          <p className="md-pretty mt-5 text-lead text-cocoa">
            <PlaceholderText text={uvod.body} />
          </p>
        </div>
      </Section>

      <Section id="clanky" labelledBy="doporucene-title">
        <SectionHeading id="doporucene-title" title={doporucene.heading} />
        <FilterGrid
          legend={stitky.heading}
          allLabel={allLabel()}
          options={options}
          items={items}
          gridClassName="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 lg:gap-8"
        />
      </Section>

      {cta.parsedCta ? (
        <Cta title={cta.heading} body={cta.body || null} primary={{ label: cta.parsedCta.label, href: contextInquiryHref(cta.parsedCta.href, { zdroj: LIST_PATH }) }} showPhone />
      ) : null}
    </>
  )
}

// ── článek ──────────────────────────────────────────────────────────────────

export function blogStaticParams() {
  return BLOG_ARTICLES.map((a) => ({ slug: a.slug }))
}

/** Metadata článku podle šablony copy (/blog/[slug]: „[Název článku] | Blog Mummies & Daddies“). */
export function blogArticleMetadata(slug: string): Metadata {
  const a = blogArticle(slug)
  if (!a) return {}
  const template = getPage(ARTICLE_TEMPLATE)
  const path = `${LIST_PATH}/${a.slug}`
  const title = template.metaTitle.replace('[Název článku]', a.title)
  return duveraMetadata(ARTICLE_TEMPLATE, {
    ogSlot: a.photoSlot,
    override: {
      title: { absolute: title },
      description: a.excerpt,
      alternates: { canonical: path },
      openGraph: { title, description: a.excerpt, url: path, type: 'article', publishedTime: a.published, ...(a.modified ? { modifiedTime: a.modified } : {}) },
    },
  })
}

/** Box „Hodí se k tomu“: svatby mají příklad přímo v copy, ostatní služby popis z menu Catering. */
export function relatedService(a: BlogArticle): { title: string; text: string; href: string } {
  const box = getSection(ARTICLE_TEMPLATE, 'sluzba')
  const example = parseItem(box.body.replace(/^.*?např\.:\s*/, ''))
  if (a.service.href === '/catering/svatby' && example.title) return { title: example.title, text: example.text, href: a.service.href }
  const m = CATERING_MENU.find((c) => c.href === a.service.href)
  return { title: m?.label ?? '', text: m?.description ?? '', href: a.service.href }
}

export function BlogArticlePage({ slug }: { slug: string }) {
  const a = blogArticle(slug)
  if (!a) throw new Error(`blog: neznámý článek ${slug}`)
  const path = `${LIST_PATH}/${a.slug}`
  const sluzba = getSectionParsed(ARTICLE_TEMPLATE, 'sluzba')
  const autor = getSection(ARTICLE_TEMPLATE, 'autor')
  const cta = getSectionParsed(ARTICLE_TEMPLATE, 'cta')
  const souvisejici = getSection(ARTICLE_TEMPLATE, 'souvisejici')
  const service = relatedService(a)
  const related = relatedArticles(a.slug)
  const photo = getPhoto(a.photoSlot)
  const ctaHref = contextInquiryHref(cta.parsedCta?.href, { typ: a.service.eventType, zdroj: path })

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: a.title,
    description: a.excerpt,
    datePublished: a.published,
    ...(a.modified ? { dateModified: a.modified } : {}),
    inLanguage: 'cs-CZ',
    mainEntityOfPage: `${COMPANY.siteUrl}${path}`,
    ...(photo.src ? { image: `${COMPANY.siteUrl}${photo.src}` } : {}),
    author: { '@type': a.author.name === COMPANY.brand ? 'Organization' : 'Person', name: a.author.name },
    publisher: { '@id': `${COMPANY.siteUrl}/#firma` },
  }

  return (
    <>
      <article aria-labelledby="clanek-title">
        <header className="bg-blush-soft pb-20 pt-10 sm:pt-14">
          <Container width="prose">
            <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: blogLabel(), href: LIST_PATH }, { label: a.title }]} className="mb-8" />
            <div className="motion-safe:animate-lift">
              <p className="mb-5 flex flex-wrap items-center gap-3">
                <Badge tone="paper">{a.tag}</Badge>
                <ArticleMeta article={a} />
              </p>
              <h1 id="clanek-title" className="md-caps text-h1 text-cocoa">
                {a.title}
              </h1>
              <p className="md-pretty mt-5 text-lead text-cocoa-soft">{a.excerpt}</p>
            </div>
          </Container>
        </header>
        <Container width="default" className="relative -mt-12">
          <PhotoFrame photo={photo} aspect="wide" preload quality={85} tone="blush" sizes="(min-width: 1280px) 1200px, 100vw" />
        </Container>
        <Container width="prose" className="py-section-sm">
          <ArticleBody blocks={a.blocks} />

          <aside aria-labelledby="autor-title" className="mt-12 flex items-center gap-4 border-t border-hairline pt-8">
            <span aria-hidden="true" className="grid h-14 w-14 shrink-0 place-items-center rounded-pill bg-sage font-display text-[1.5rem] font-semibold text-cocoa">
              {a.author.name.replace(/^Bc\.\s*/, '').charAt(0)}
            </span>
            <div>
              <h2 id="autor-title" className="font-copy text-eyebrow uppercase text-cocoa-soft">
                {autor.heading}
              </h2>
              <p className="mt-1 text-copy text-cocoa">
                <span className="font-semibold">{a.author.name}</span>, <PlaceholderText text={a.author.role} />
              </p>
            </div>
          </aside>
        </Container>
      </article>

      <Section tone="vanilla" soft spacing="sm" width="prose" labelledBy="sluzba-title">
        <div className="rounded-frame bg-paper p-6 ring-1 ring-hairline sm:p-8">
          <h2 id="sluzba-title" className="font-copy text-eyebrow uppercase text-cocoa-soft">
            {sluzba.heading}
          </h2>
          <p className="md-caps mt-3 text-h3 text-cocoa">{service.title}</p>
          <p className="md-pretty mt-2 text-copy text-cocoa-soft">{service.text}</p>
          {sluzba.parsedCta ? (
            <div className="mt-6">
              <Button href={service.href} variant="outline" arrow>
                {sluzba.parsedCta.label}
              </Button>
            </div>
          ) : null}
        </div>
      </Section>

      {cta.parsedCta ? <Cta title={cta.heading} body={cta.body} primary={{ label: cta.parsedCta.label, href: ctaHref }} showPhone /> : null}

      {related.length ? (
        <Section labelledBy="souvisejici-title">
          <SectionHeading id="souvisejici-title" title={souvisejici.heading} />
          <ul role="list" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 lg:gap-8">
            {related.map((r, i) => (
              <li key={r.slug}>
                <PastelCard
                  title={r.title}
                  description={r.excerpt}
                  href={`${LIST_PATH}/${r.slug}`}
                  photo={getPhoto(r.photoSlot)}
                  aspect="landscape"
                  tone={toneAt(i)}
                  eyebrow={r.tag}
                  meta={<ArticleMeta article={r} />}
                  sizes="(min-width: 1280px) 400px, (min-width: 1024px) 31vw, (min-width: 640px) 48vw, 100vw"
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
    </>
  )
}
