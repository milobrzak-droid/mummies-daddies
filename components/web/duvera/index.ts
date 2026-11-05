// Stránky důvěry: reference, prostory, o nás, blog, Vánoce (serverové komponenty;
// FilterGrid je 'use client'). Stránky volají content.ts a photos.ts → jen server.
export { AboutPage, teamMembers } from './AboutPage'
export { ArticleBody } from './ArticleBody'
export { BlogArticlePage, BlogListPage, blogArticleMetadata, blogListItems, blogStaticParams, relatedService } from './BlogPages'
export { ChristmasPage } from './ChristmasPage'
export { FactList, type Fact } from './FactList'
export { FilterGrid, type FilterItem, type FilterOption } from './FilterGrid'
export { Gallery } from './Gallery'
export { PlaceholderPanel } from './PlaceholderPanel'
export { PriceText, splitPrices } from './PriceText'
export { QuoteCard } from './QuoteCard'
export {
  ReferenceCasePage,
  ReferenceListPage,
  referenceAwaitsConsent,
  referenceCards,
  referenceCasePaths,
  referenceFilter,
  referenceStaticParams,
} from './ReferencePages'
export { SplitHero } from './SplitHero'
export { VenuesPage, venueCards } from './VenuesPage'
