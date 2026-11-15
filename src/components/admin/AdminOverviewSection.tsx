import { normalizeAdminOverview } from '../../services/adminOverview';
import {
  AlertTriangle,
  ArrowUpRight,
  FolderKanban,
  IndianRupee,
  Mail,
  Package,
  Plus,
  ShoppingBag,
} from 'lucide-react';
import type { AdminOverviewResponse, AdminProduct } from '../../types/boutique';
import { formatPaiseINR, formatTimestamp } from '../../utils/format';

export type OverviewTargetTab =
  | 'overview'
  | 'catalog'
  | 'categories'
  | 'orders'
  | 'content'
  | 'messages'
  | 'settings'
  | 'account';

interface AdminOverviewSectionProps {
  overview: AdminOverviewResponse | null;
  loading: boolean;
  onNavigateTab: (tab: OverviewTargetTab) => void;
  onQuickFilterCatalog: (filter: {
    status?: 'all' | 'published' | 'draft' | 'archived';
    stock?: 'all' | 'low' | 'out';
  }) => void;
  onCreateProduct: () => void;
  onEditProduct: (product: AdminProduct) => void;
}

export function AdminOverviewSection({
  overview,
  loading,
  onNavigateTab,
  onQuickFilterCatalog,
  onCreateProduct,
  onEditProduct,
}: AdminOverviewSectionProps) {
  if (loading || !overview) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
              <div className="h-3 w-24 animate-pulse rounded bg-[#49243E]/10" />
              <div className="mt-4 h-8 w-20 animate-pulse rounded bg-[#49243E]/15" />
              <div className="mt-3 h-3 w-36 animate-pulse rounded bg-[#49243E]/8" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="h-64 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
          <div className="h-64 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
        </div>
      </div>
    );
  }

  const { metrics, lowStockItems, recentOrders, recentMessages, recentAuditLogs } = normalizeAdminOverview(overview);

  const cards = [
    {
      label: 'Total Products',
      value: String(metrics.totalProducts),
      detail: `${metrics.publishedProducts} published · ${metrics.draftProducts} draft`,
      icon: Package,
      onClick: () => {
        onQuickFilterCatalog({ status: 'all', stock: 'all' });
        onNavigateTab('catalog');
      },
    },
    {
      label: 'Collections',
      value: String(metrics.totalCategories),
      detail: 'Active storefront categories',
      icon: FolderKanban,
      onClick: () => onNavigateTab('categories'),
    },
    {
      label: 'Total Orders',
      value: String(metrics.totalOrders),
      detail: `${metrics.pendingOrders} awaiting fulfillment`,
      icon: ShoppingBag,
      onClick: () => onNavigateTab('orders'),
    },
    {
      label: 'Total Revenue',
      value: formatPaiseINR(metrics.totalRevenuePaise),
      detail: 'Non-cancelled storefront orders',
      icon: IndianRupee,
      onClick: () => onNavigateTab('orders'),
    },
    {
      label: 'Customer Messages',
      value: String(metrics.totalMessages),
      detail:
        metrics.unreadMessages > 0
          ? `${metrics.unreadMessages} unread enquiries`
          : 'All enquiries reviewed',
      icon: Mail,
      onClick: () => onNavigateTab('messages'),
    },
    {
      label: 'Low Stock Watch',
      value: String(metrics.lowStockProducts),
      detail:
        metrics.outOfStockProducts > 0
          ? `${metrics.outOfStockProducts} out of stock`
          : 'Healthy variant stock',
      icon: AlertTriangle,
      onClick: () => {
        onQuickFilterCatalog({ status: 'all', stock: 'low' });
        onNavigateTab('catalog');
      },
    },
  ];

  return (
    <div className="space-y-6">
      {/* KPI Grid */}
      <section aria-label="Store metrics overview" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              type="button"
              onClick={card.onClick}
              className="group flex flex-col justify-between rounded-2xl border border-[#49243E]/12 bg-white p-5 text-left transition-colors hover:border-[#B76E79]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]/30"
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
            </button>
          );
        })}
      </section>

      {/* Quick Actions Bar */}
      <section
        aria-label="Quick boutique actions"
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#49243E]/12 bg-white px-5 py-4"
      >
        <div>
          <h2 className="font-serif text-lg font-semibold text-[#49243E]">Quick Actions</h2>
          <p className="text-xs text-[#242124]/65">
            Jump straight into catalog curation, homepage copy, or customer care.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onCreateProduct}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Add Product</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab('content')}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5] px-4 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
          >
            <span>Edit Storefront Content</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab('settings')}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5] px-4 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
          >
            <span>Brand &amp; Contact Settings</span>
          </button>
        </div>
      </section>

      {/* Activity Columns */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recent Orders */}
        <section aria-label="Recent orders" className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between border-b border-[#49243E]/10 pb-3.5">
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">Recent Orders</h2>
            <button
              type="button"
              onClick={() => onNavigateTab('orders')}
              className="inline-flex min-h-[36px] items-center gap-1 text-xs font-medium text-[#B76E79] hover:text-[#49243E]"
            >
              <span>View all</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {recentOrders.length === 0 ? (
            <p className="py-10 text-center text-sm text-[#242124]/65">
              No storefront orders placed yet.
            </p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {recentOrders.map((order) => (
                <li key={order.id} className="flex items-center justify-between gap-3 py-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[#49243E]">
                      {order.customerName}{' '}
                      <span className="font-mono font-normal text-[#B76E79]">
                        · {order.orderNumber}
                      </span>
                    </p>
                    <p className="mt-0.5 truncate text-[#242124]/60 capitalize tabular-nums">
                      {order.status} · {formatTimestamp(order.createdAt)}
                    </p>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums text-[#49243E]">
                    {formatPaiseINR(order.totalPaise)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent Customer Messages */}
        <section aria-label="Recent messages" className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between border-b border-[#49243E]/10 pb-3.5">
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">Customer Enquiries</h2>
            <button
              type="button"
              onClick={() => onNavigateTab('messages')}
              className="inline-flex min-h-[36px] items-center gap-1 text-xs font-medium text-[#B76E79] hover:text-[#49243E]"
            >
              <span>Open inbox</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {recentMessages.length === 0 ? (
            <p className="py-10 text-center text-sm text-[#242124]/65">
              No customer messages received yet.
            </p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {recentMessages.map((msg) => (
                <li key={msg.id} className="flex items-center justify-between gap-3 py-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[#49243E]">
                      {msg.senderName}{' '}
                      <span className="font-normal text-[#242124]/65">· {msg.subject}</span>
                    </p>
                    <p className="mt-0.5 truncate text-[#242124]/60">
                      {msg.status === 'unread' ? 'Unread · ' : `${msg.status} · `}
                      {formatTimestamp(msg.createdAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onNavigateTab('messages')}
                    className="shrink-0 rounded-lg border border-[#49243E]/15 px-2.5 py-1.5 text-[11px] font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                  >
                    Review
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Low Stock Items */}
        <section aria-label="Low stock products" className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between border-b border-[#49243E]/10 pb-3.5">
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">Low Stock Alerts</h2>
            <button
              type="button"
              onClick={() => {
                onQuickFilterCatalog({ status: 'all', stock: 'low' });
                onNavigateTab('catalog');
              }}
              className="inline-flex min-h-[36px] items-center gap-1 text-xs font-medium text-[#B76E79] hover:text-[#49243E]"
            >
              <span>Filter catalog</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {lowStockItems.length === 0 ? (
            <p className="py-10 text-center text-sm text-[#242124]/65">
              All active designs are above their low-stock thresholds.
            </p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {lowStockItems.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 py-3 text-xs">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onEditProduct(item)}
                      className="truncate text-left font-semibold text-[#49243E] hover:text-[#B76E79]"
                    >
                      {item.name}
                    </button>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-[#242124]/60">
                      {item.sku} · {item.category}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 font-semibold tabular-nums ${
                      (item.stockQty ?? 0) === 0 ? 'text-[#B91C1C]' : 'text-[#92400E]'
                    }`}
                  >
                    {item.stockQty ?? 0} left
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent Catalog Activity */}
        <section aria-label="Recent catalog activity" className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between border-b border-[#49243E]/10 pb-3.5">
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">Recent Activity</h2>
            <button
              type="button"
              onClick={() => onNavigateTab('account')}
              className="inline-flex min-h-[36px] items-center gap-1 text-xs font-medium text-[#B76E79] hover:text-[#49243E]"
            >
              <span>Audit trail</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {recentAuditLogs.length === 0 ? (
            <p className="py-10 text-center text-sm text-[#242124]/65">
              No recent catalog activity recorded.
            </p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {recentAuditLogs.map((entry) => (
                <li key={entry.id} className="py-3 text-xs">
                  <p className="font-semibold text-[#49243E]">
                    <span className="uppercase tracking-wider text-[#B76E79]">{entry.action}</span>
                    {' · '}
                    <span>{entry.productTitle}</span>
                  </p>
                  <p className="mt-0.5 text-[#242124]/70">{entry.summary}</p>
                  <p className="mt-0.5 text-[11px] text-[#242124]/50 tabular-nums">
                    {formatTimestamp(entry.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
