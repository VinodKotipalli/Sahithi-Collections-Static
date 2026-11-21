import { RefObject } from 'react';
import { ArrowUpDown, Search, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useStorefront } from '../context/StorefrontContext';
import { CollectionCategory, Product } from '../types/boutique';
import { ProductCard } from './ProductCard';
import { RevealSection } from './RevealSection';

export type SortOption = 'newest' | 'price-asc' | 'price-desc' | 'featured';

interface ProductShowcaseProps {
  products: Product[];
  isLoading?: boolean;
  selectedCategory: 'All' | CollectionCategory;
  onSelectCategory: (cat: 'All' | CollectionCategory) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  onClearFilters: () => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  isWishlisted: (id: string) => boolean;
  onToggleWishlist: (id: string) => void;
  onQuickView: (product: Product) => void;
}

export function ProductShowcase({
  products,
  isLoading = false,
  selectedCategory,
  onSelectCategory,
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
  onClearFilters,
  searchInputRef,
  isWishlisted,
  onToggleWishlist,
  onQuickView,
}: ProductShowcaseProps) {
  const { categories, content } = useStorefront();
  const { showcaseHeader } = content;
  const categoryTabs: Array<'All' | CollectionCategory> = [
    'All',
    ...categories.map((c) => c.name),
  ];
  const hasActiveFilters = selectedCategory !== 'All' || searchQuery.trim().length > 0;

  return (
    <section id="new-arrivals" className="py-16 sm:py-24 bg-[#FFF9F5]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <RevealSection>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
                {showcaseHeader.kicker}
              </p>
              <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
                {showcaseHeader.heading}
              </h2>
            </div>
            <p className="max-w-md text-sm text-[#242124]/75">
              {showcaseHeader.subtitle}
            </p>
          </div>
        </RevealSection>

        {/* Filter, Search & Sort Controls */}
        <div className="mt-8 flex flex-col gap-4 border-y border-[#49243E]/10 py-5">
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter by collection">
            {categoryTabs.map((category) => {
              const active = selectedCategory === category;
              return (
                <button
                  key={category}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelectCategory(category)}
                  className={`min-h-[40px] rounded-xl px-4 py-2 text-xs font-medium transition-all duration-200 whitespace-nowrap shrink-0 sm:text-sm ${
                    active
                      ? 'bg-[#49243E] text-[#FFF9F5] shadow-sm'
                      : 'bg-[#F3D5DF]/35 text-[#49243E] hover:bg-[#F3D5DF]/65'
                  }`}
                >
                  {category}
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Search Input */}
            <div className="relative w-full sm:max-w-sm">
              <Search
                className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#49243E]/55"
                aria-hidden="true"
              />
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search dresses, anarkalis, lehengas, kurta sets..."
                aria-label="Search boutique products"
                className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-white pl-10 pr-10 text-sm text-[#242124] placeholder:text-[#242124]/45 focus:border-[#B76E79] focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  aria-label="Clear search query"
                  className="absolute top-1/2 right-2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[#49243E]/70 hover:bg-[#F3D5DF]/40"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>

            {/* Count + Sort */}
            <div className="flex items-center justify-between gap-4 sm:justify-end">
              <span className="text-xs font-medium text-[#242124]/65 tabular-nums whitespace-nowrap">
                {products.length} {products.length === 1 ? 'style' : 'styles'}
              </span>

              <div className="relative flex items-center">
                <ArrowUpDown
                  className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-[#49243E]/70"
                  aria-hidden="true"
                />
                <select
                  value={sortBy}
                  onChange={(e) => onSortChange(e.target.value as SortOption)}
                  aria-label="Sort products"
                  className="h-11 rounded-xl border border-[#49243E]/18 bg-white pl-9 pr-8 text-xs font-medium text-[#49243E] focus:border-[#B76E79] focus:outline-none sm:text-sm"
                >
                  <option value="newest">Sort: Newest</option>
                  <option value="featured">Sort: Featured</option>
                  <option value="price-asc">Price: Low to High</option>
                  <option value="price-desc">Price: High to Low</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Product Grid, Loading Skeletons, or Empty State */}
        {isLoading ? (
          <div className="mt-8 grid grid-cols-1 gap-5 min-[360px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 sm:gap-6">
            {Array.from({ length: 4 }).map((_, idx) => (
              <div
                key={idx}
                className="overflow-hidden rounded-2xl border border-[#49243E]/10 bg-white p-3.5"
              >
                <div className="aspect-[3/4] w-full animate-pulse rounded-xl bg-[#F3D5DF]/35" />
                <div className="mt-4 h-3 w-20 animate-pulse rounded bg-[#49243E]/10" />
                <div className="mt-2 h-5 w-3/4 animate-pulse rounded bg-[#49243E]/12" />
                <div className="mt-4 h-8 w-full animate-pulse rounded-lg bg-[#49243E]/8" />
              </div>
            ))}
          </div>
        ) : products.length > 0 ? (
          <motion.div
            layout
            className="mt-8 grid grid-cols-1 gap-5 min-[360px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 sm:gap-6"
          >
            <AnimatePresence mode="popLayout">
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  isWishlisted={isWishlisted(product.id)}
                  onToggleWishlist={onToggleWishlist}
                  onQuickView={onQuickView}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        ) : (
          <div className="mt-10 flex flex-col items-center justify-center rounded-3xl border border-[#49243E]/12 bg-white px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </div>
            <h3 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
              No matching styles found
            </h3>
            <p className="mt-2 max-w-md text-sm text-[#242124]/70">
              We could not find any pieces matching your current search or category selection. Try clearing your filters to explore the full boutique catalog.
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={onClearFilters}
                className="mt-6 min-h-[44px] rounded-xl bg-[#49243E] px-6 py-2.5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
