import { Archive, FileEdit, Globe, Package, AlertTriangle } from 'lucide-react';
import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import type { AdminOverviewMetrics } from '../../types/boutique';

interface AdminOverviewCardsProps {
  metrics: AdminOverviewMetrics | null;
  loading: boolean;
  onQuickFilter: (filter: { status?: 'all' | 'published' | 'draft' | 'archived'; stock?: 'all' | 'low' | 'out' }) => void;
}

export function AdminOverviewCards({
  metrics,
  loading,
  onQuickFilter,
}: AdminOverviewCardsProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  if (loading || !metrics) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div
            key={idx}
            className="rounded-2xl border border-[#49243E]/12 bg-white p-5"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-[#49243E]/10" />
            <div className="mt-4 h-8 w-16 animate-pulse rounded bg-[#49243E]/15" />
            <div className="mt-3 h-3 w-32 animate-pulse rounded bg-[#49243E]/8" />
          </div>
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: 'Total Products',
      value: metrics.totalProducts,
      detail: `${metrics.archivedProducts} archived`,
      icon: Package,
      onClick: () => onQuickFilter({ status: 'all', stock: 'all' }),
    },
    {
      label: 'Published Live',
      value: metrics.publishedProducts,
      detail: 'Visible on storefront',
      icon: Globe,
      onClick: () => onQuickFilter({ status: 'published', stock: 'all' }),
    },
    {
      label: 'Drafts',
      value: metrics.draftProducts,
      detail: 'Private until published',
      icon: FileEdit,
      onClick: () => onQuickFilter({ status: 'draft', stock: 'all' }),
    },
    {
      label: 'Low Stock',
      value: metrics.lowStockProducts,
      detail:
        metrics.outOfStockProducts > 0
          ? `${metrics.outOfStockProducts} out of stock`
          : 'At or below threshold',
      icon: metrics.lowStockProducts > 0 ? AlertTriangle : Archive,
      onClick: () => onQuickFilter({ status: 'all', stock: 'low' }),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card, idx) => {
        const Icon = card.icon;
        return (
          <motion.button
            key={card.label}
            type="button"
            onClick={card.onClick}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: prefersReducedMotion ? 0.01 : 0.24,
              delay: prefersReducedMotion ? 0 : idx * 0.04,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="group flex flex-col justify-between rounded-2xl border border-[#49243E]/12 bg-white p-5 text-left transition-colors hover:border-[#B76E79]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]/30"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium tracking-[0.12em] uppercase text-[#49243E]/70">
                {card.label}
              </span>
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#F3D5DF]/40 text-[#49243E] transition-colors group-hover:bg-[#49243E] group-hover:text-[#FFF9F5]">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <p className="mt-3 font-serif text-3xl font-semibold tabular-nums text-[#49243E]">
              {card.value}
            </p>
            <p className="mt-1.5 text-xs text-[#242124]/65 tabular-nums">{card.detail}</p>
          </motion.button>
        );
      })}
    </div>
  );
}
