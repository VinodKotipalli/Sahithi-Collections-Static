import {
  Archive,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  Globe,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AdminProduct,
  CollectionCategory,
  StorefrontCategory,
} from '../../types/boutique';
import { formatPaiseINR, formatTimestamp } from '../../utils/format';
import { BoutiqueImage } from '../BoutiqueImage';

interface AdminProductTableProps {
  products: AdminProduct[];
  categories: StorefrontCategory[];
  loading: boolean;
  total: number;
  page: number;
  totalPages: number;
  searchQuery: string;
  statusFilter: 'all' | 'published' | 'draft' | 'archived';
  categoryFilter: 'All' | CollectionCategory;
  stockFilter: 'all' | 'low' | 'out';
  sortBy: 'updated' | 'newest' | 'price_asc' | 'price_desc' | 'stock_asc';
  busyProductId: string | null;
  onSearchChange: (q: string) => void;
  onStatusChange: (s: 'all' | 'published' | 'draft' | 'archived') => void;
  onCategoryChange: (c: 'All' | CollectionCategory) => void;
  onStockChange: (s: 'all' | 'low' | 'out') => void;
  onSortChange: (sort: 'updated' | 'newest' | 'price_asc' | 'price_desc' | 'stock_asc') => void;
  onPageChange: (page: number) => void;
  onCreateNew: () => void;
  onEdit: (product: AdminProduct) => void;
  onDuplicate: (product: AdminProduct) => void;
  onTogglePublish: (product: AdminProduct) => void;
  onArchiveToggle: (product: AdminProduct) => void;
  onRequestDelete: (product: AdminProduct) => void;
}

export function AdminProductTable({
  products,
  categories,
  loading,
  total,
  page,
  totalPages,
  searchQuery,
  statusFilter,
  categoryFilter,
  stockFilter,
  sortBy,
  busyProductId,
  onSearchChange,
  onStatusChange,
  onCategoryChange,
  onStockChange,
  onSortChange,
  onPageChange,
  onCreateNew,
  onEdit,
  onDuplicate,
  onTogglePublish,
  onArchiveToggle,
  onRequestDelete,
}: AdminProductTableProps) {
  const statusOptions: Array<{ value: 'all' | 'published' | 'draft' | 'archived'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'published', label: 'Published' },
    { value: 'draft', label: 'Drafts' },
    { value: 'archived', label: 'Archived' },
  ];

  return (
    <section
      aria-label="Product catalog management"
      className="rounded-3xl border border-[#49243E]/12 bg-white p-4 sm:p-6"
    >
      {/* Toolbar */}
      <div className="flex flex-col gap-4 border-b border-[#49243E]/10 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Filter products by publication status"
            className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-[#49243E]/10 bg-[#FFF9F5] p-1"
          >
            {statusOptions.map((opt) => {
              const active = statusFilter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onStatusChange(opt.value)}
                  className={`min-h-[38px] rounded-lg px-3.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-[#49243E] text-[#FFF9F5]'
                      : 'text-[#49243E]/80 hover:bg-[#F3D5DF]/40'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <p className="text-xs font-medium text-[#242124]/65 tabular-nums">
            Showing {products.length} of{' '}
            {typeof total === 'number' && !Number.isNaN(total) ? total : products.length} product
            {(typeof total === 'number' && !Number.isNaN(total) ? total : products.length) === 1
              ? ''
              : 's'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="relative md:col-span-5">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#49243E]/55"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search title, SKU, or collection..."
              aria-label="Search admin products"
              className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 pl-10 pr-10 text-sm text-[#242124] placeholder:text-[#242124]/45 focus:border-[#49243E] focus:bg-white focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                aria-label="Clear product search"
                className="absolute top-1/2 right-2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[#49243E]/70 hover:bg-[#F3D5DF]/40"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="md:col-span-3">
            <select
              value={categoryFilter}
              onChange={(e) => onCategoryChange(e.target.value as 'All' | CollectionCategory)}
              aria-label="Filter by collection category"
              className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm text-[#49243E] focus:border-[#49243E] focus:bg-white focus:outline-none"
            >
              <option value="All">All Collections</option>
              {Array.from(
                new Set([
                  ...categories.map((cat) => cat.name),
                  ...(categoryFilter !== 'All' ? [categoryFilter] : []),
                ])
              ).map((catName) => (
                <option key={catName} value={catName}>
                  {catName}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <select
              value={stockFilter}
              onChange={(e) => onStockChange(e.target.value as 'all' | 'low' | 'out')}
              aria-label="Filter by stock status"
              className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm text-[#49243E] focus:border-[#49243E] focus:bg-white focus:outline-none"
            >
              <option value="all">All Stock</option>
              <option value="low">Low Stock</option>
              <option value="out">Out of Stock</option>
            </select>
          </div>

          <div className="relative md:col-span-2">
            <ArrowUpDown
              className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#49243E]/65"
              aria-hidden="true"
            />
            <select
              value={sortBy}
              onChange={(e) =>
                onSortChange(
                  e.target.value as 'updated' | 'newest' | 'price_asc' | 'price_desc' | 'stock_asc'
                )
              }
              aria-label="Sort admin products"
              className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 pl-8 pr-3 text-sm text-[#49243E] focus:border-[#49243E] focus:bg-white focus:outline-none"
            >
              <option value="updated">Updated</option>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: Low</option>
              <option value="price_desc">Price: High</option>
              <option value="stock_asc">Stock: Low</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading Skeleton */}
      {loading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 5 }).map((_, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between gap-4 rounded-2xl border border-[#49243E]/8 p-3"
            >
              <div className="flex items-center gap-3">
                <div className="h-14 w-12 animate-pulse rounded-xl bg-[#F3D5DF]/40" />
                <div className="space-y-2">
                  <div className="h-4 w-48 animate-pulse rounded bg-[#49243E]/12" />
                  <div className="h-3 w-32 animate-pulse rounded bg-[#49243E]/8" />
                </div>
              </div>
              <div className="h-8 w-28 animate-pulse rounded-lg bg-[#49243E]/10" />
            </div>
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </div>
          <h3 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
            No matching products
          </h3>
          <p className="mt-1.5 max-w-md text-sm text-[#242124]/70">
            Adjust your filters or add a new design to begin curating your storefront catalog.
          </p>
          <button
            type="button"
            onClick={onCreateNew}
            className="mt-5 min-h-[44px] rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
          >
            Add First Product
          </button>
        </div>
      ) : (
        <>
          {/* Desktop Data Table */}
          <div className="mt-4 hidden overflow-x-auto lg:block">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[#49243E]/12 text-[11px] font-semibold tracking-wider uppercase text-[#49243E]/65">
                  <th className="py-3 pr-4">Product</th>
                  <th className="py-3 px-3">SKU</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-3 text-right">Selling Price</th>
                  <th className="py-3 px-3 text-right">Stock</th>
                  <th className="py-3 px-3">Updated</th>
                  <th className="py-3 pl-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#49243E]/8">
                {products.map((product) => {
                  const isBusy = busyProductId === product.id;
                  const lowStock =
                    product.status !== 'archived' &&
                    (product.stockQty ?? 0) <= (product.lowStockThreshold ?? 5);
                  const statusLabel =
                    product.status === 'published'
                      ? 'Published'
                      : product.status === 'archived'
                        ? 'Archived'
                        : 'Draft';

                  return (
                    <tr
                      key={product.id}
                      className="transition-colors hover:bg-[#FFF9F5]/85"
                    >
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-3">
                          <div className="h-14 w-11 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/10 bg-[#F8F1ED]">
                            <BoutiqueImage
                              src={product.images[0]?.src || ''}
                              alt={product.images[0]?.alt || product.name}
                              loading="lazy"
                              fallbackTitle={product.name}
                              className="h-full w-full object-cover object-top"
                            />
                          </div>
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={() => onEdit(product)}
                              className="line-clamp-1 text-left font-serif text-base font-semibold text-[#49243E] hover:text-[#B76E79]"
                            >
                              {product.name}
                            </button>
                            <p className="mt-0.5 text-xs text-[#242124]/60">
                              {product.category}
                              {' · '}
                              <span className="tabular-nums">
                                {product.variants?.length || 0} variant{(product.variants?.length || 0) === 1 ? '' : 's'}
                              </span>
                              {product.featured && ' · Featured'}
                            </p>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3 font-mono text-xs text-[#242124]/75">
                        {product.sku}
                      </td>

                      <td className="py-3 px-3 text-xs font-medium">
                        <span
                          className={
                            product.status === 'published'
                              ? 'text-[#166534]'
                              : product.status === 'archived'
                                ? 'text-[#242124]/55'
                                : 'text-[#92400E]'
                          }
                        >
                          {statusLabel}
                        </span>
                      </td>

                      <td className="py-3 px-3 text-right tabular-nums">
                        <span className="font-semibold text-[#242124]">
                          {formatPaiseINR(product.pricePaise ?? Math.round(product.price * 100))}
                        </span>
                        {product.compareAtPaise && (
                          <div className="text-[11px] line-through text-[#242124]/45">
                            {formatPaiseINR(product.compareAtPaise)}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-3 text-right tabular-nums">
                        <span
                          className={`font-semibold ${
                            (product.stockQty ?? 0) === 0
                              ? 'text-[#B91C1C]'
                              : lowStock
                                ? 'text-[#B45309]'
                                : 'text-[#242124]'
                          }`}
                        >
                          {product.stockQty ?? 0}
                        </span>
                      </td>

                      <td className="py-3 px-3 text-xs text-[#242124]/65 whitespace-nowrap">
                        {formatTimestamp(product.updatedAt)}
                      </td>

                      <td className="py-3 pl-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onEdit(product)}
                            aria-label={`Edit ${product.name}`}
                            title="Edit product"
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#49243E]/12 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 disabled:opacity-50"
                          >
                            <Edit3 className="h-4 w-4" aria-hidden="true" />
                          </button>

                          {product.status !== 'archived' && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => onTogglePublish(product)}
                              aria-label={
                                product.status === 'published'
                                  ? `Unpublish ${product.name}`
                                  : `Publish ${product.name}`
                              }
                              title={product.status === 'published' ? 'Unpublish to Draft' : 'Publish to Storefront'}
                              className="flex h-9 items-center gap-1 rounded-lg border border-[#49243E]/12 px-2.5 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#49243E] hover:text-[#FFF9F5] disabled:opacity-50"
                            >
                              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>{product.status === 'published' ? 'Unpublish' : 'Publish'}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onDuplicate(product)}
                            aria-label={`Duplicate ${product.name}`}
                            title="Duplicate as draft"
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#49243E]/12 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 disabled:opacity-50"
                          >
                            <Copy className="h-4 w-4" aria-hidden="true" />
                          </button>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onArchiveToggle(product)}
                            aria-label={
                              product.status === 'archived'
                                ? `Restore ${product.name}`
                                : `Archive ${product.name}`
                            }
                            title={product.status === 'archived' ? 'Restore to draft' : 'Archive product'}
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#49243E]/12 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 disabled:opacity-50"
                          >
                            {product.status === 'archived' ? (
                              <RotateCcw className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Archive className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onRequestDelete(product)}
                            aria-label={`Delete ${product.name}`}
                            title="Delete product"
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#B76E79]/25 text-[#B76E79] transition-colors hover:bg-[#F3D5DF]/45 hover:text-[#49243E] disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card Layout */}
          <ul className="mt-4 space-y-3 lg:hidden">
            {products.map((product) => {
              const isBusy = busyProductId === product.id;
              return (
                <li
                  key={product.id}
                  className="rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5]/55 p-3.5"
                >
                  <div className="flex gap-3">
                    <div className="h-20 w-16 shrink-0 overflow-hidden rounded-xl border border-[#49243E]/10 bg-[#F8F1ED]">
                      <BoutiqueImage
                        src={product.images[0]?.src || ''}
                        alt={product.images[0]?.alt || product.name}
                        loading="lazy"
                        fallbackTitle={product.name}
                        className="h-full w-full object-cover object-top"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-[#B76E79]">
                        {product.category} · {product.status}
                      </p>
                      <h3 className="mt-0.5 line-clamp-1 font-serif text-lg font-semibold text-[#49243E]">
                        {product.name}
                      </h3>
                      <p className="mt-1 text-xs text-[#242124]/70 tabular-nums">
                        {formatPaiseINR(product.pricePaise ?? Math.round(product.price * 100))}
                        {' · '}
                        Stock: {product.stockQty ?? 0}
                        {' · '}
                        <span className="font-mono">{product.sku}</span>
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onEdit(product)}
                      className="min-h-[42px] flex-1 rounded-xl bg-[#49243E] px-3 text-xs font-medium text-[#FFF9F5]"
                    >
                      Edit
                    </button>
                    {product.status !== 'archived' && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => onTogglePublish(product)}
                        className="min-h-[42px] rounded-xl border border-[#49243E]/20 bg-white px-3 text-xs font-medium text-[#49243E]"
                      >
                        {product.status === 'published' ? 'Unpublish' : 'Publish'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onArchiveToggle(product)}
                      className="min-h-[42px] rounded-xl border border-[#49243E]/20 bg-white px-3 text-xs font-medium text-[#49243E]"
                    >
                      {product.status === 'archived' ? 'Restore' : 'Archive'}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onDuplicate(product)}
                      aria-label={`Duplicate ${product.name}`}
                      className="flex min-h-[42px] min-w-[42px] items-center justify-center rounded-xl border border-[#49243E]/20 bg-white text-[#49243E]"
                    >
                      <Copy className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onRequestDelete(product)}
                      aria-label={`Delete ${product.name}`}
                      className="flex min-h-[42px] min-w-[42px] items-center justify-center rounded-xl border border-[#B76E79]/30 bg-white text-[#9B2C3E]"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Pagination */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#49243E]/10 pt-4">
            <span className="text-xs text-[#242124]/65 tabular-nums">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => onPageChange(page - 1)}
                className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 disabled:opacity-45"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                <span>Previous</span>
              </button>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => onPageChange(page + 1)}
                className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 disabled:opacity-45"
              >
                <span>Next</span>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
