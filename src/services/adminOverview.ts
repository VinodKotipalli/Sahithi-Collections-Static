import type { AdminOverviewResponse } from '../types/boutique';

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const rows = (value: unknown): Record<string, any>[] =>
  Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : [];
const number = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Normalize current and legacy Firebase overview payloads at the UI boundary. */
export function normalizeAdminOverview(value: unknown): AdminOverviewResponse {
  const data = record(value);
  const metrics = record(data.metrics);
  const keys = ['totalProducts', 'publishedProducts', 'draftProducts', 'archivedProducts',
    'lowStockProducts', 'outOfStockProducts', 'totalCategories', 'totalOrders',
    'pendingOrders', 'totalRevenuePaise', 'unreadMessages', 'totalMessages', 'totalAuditEvents'] as const;
  const normalizedMetrics = Object.fromEntries(keys.map(key => [key, number(
    key === 'publishedProducts' ? metrics.publishedProducts ?? metrics.activeProducts : metrics[key]
  )])) as unknown as AdminOverviewResponse['metrics'];
  return {
    metrics: normalizedMetrics,
    lowStockItems: rows(data.lowStockItems) as AdminOverviewResponse['lowStockItems'],
    recentOrders: rows(data.recentOrders).map(o => ({
      id: text(o.id), orderNumber: text(o.orderNumber ?? o.order_number),
      customerName: text(o.customerName ?? o.customer_name),
      customerEmail: text(o.customerEmail ?? o.customer_email),
      customerPhone: text(o.customerPhone ?? o.customer_phone),
      shippingAddress: text(o.shippingAddress ?? o.shipping_address),
      status: text(o.status), subtotalPaise: number(o.subtotalPaise ?? o.subtotal_paise),
      totalPaise: number(o.totalPaise ?? o.total_paise), currency: text(o.currency) || 'INR',
      createdAt: number(o.createdAt ?? o.created_at), items: rows(o.items) as any,
    })),
    recentMessages: rows(data.recentMessages).map(m => ({
      id: text(m.id), senderName: text(m.senderName ?? m.sender_name ?? m.full_name),
      senderEmail: text(m.senderEmail ?? m.sender_email ?? m.email),
      senderPhone: text(m.senderPhone ?? m.sender_phone ?? m.phone),
      subject: text(m.subject ?? m.product_interest), message: text(m.message),
      status: ['read', 'replied', 'archived'].includes(m.status) ? m.status : 'unread',
      adminNote: text(m.adminNote ?? m.admin_note ?? m.admin_notes),
      createdAt: number(m.createdAt ?? m.created_at), updatedAt: number(m.updatedAt ?? m.updated_at),
    })),
    recentAuditLogs: rows(data.recentAuditLogs ?? data.recentAudit).map(a => ({
      id: text(a.id), productId: text(a.productId ?? a.product_id ?? a.entity_id),
      productTitle: text(a.productTitle ?? a.product_title) || 'Catalog update',
      action: text(a.action), summary: text(a.summary),
      createdAt: number(a.createdAt ?? a.created_at),
    })),
  };
}
