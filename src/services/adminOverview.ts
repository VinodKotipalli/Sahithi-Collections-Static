import {
  normalizeOrderRequestsAndStatus,
  parseOrderHistory,
} from '../../server/order-utils.ts';
import type {
  AdminOverviewResponse,
  OrderFulfillmentStatus,
  OrderPaymentStatus,
} from '../types/boutique';

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const rows = (value: unknown): Record<string, any>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, any> => Boolean(v && typeof v === 'object')) : [];
const number = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value && typeof value === 'object' ? (value as T) : fallback;
}

/** Normalize current and legacy Firebase overview payloads at the UI boundary. */
export function normalizeAdminOverview(value: unknown): AdminOverviewResponse {
  const data = record(value);
  const metrics = record(data.metrics);
  const keys = [
    'totalProducts',
    'publishedProducts',
    'draftProducts',
    'archivedProducts',
    'lowStockProducts',
    'outOfStockProducts',
    'totalCategories',
    'totalOrders',
    'pendingOrders',
    'cancelledOrders',
    'totalRevenuePaise',
    'unreadMessages',
    'totalMessages',
    'totalAuditEvents',
    'totalCustomers',
    'openReturnRequests',
  ] as const;
  const normalizedMetrics = Object.fromEntries(
    keys.map((key) => [
      key,
      number(
        key === 'publishedProducts'
          ? metrics.publishedProducts ?? metrics.activeProducts
          : metrics[key]
      ),
    ])
  ) as unknown as AdminOverviewResponse['metrics'];
  return {
    metrics: normalizedMetrics,
    lowStockItems: rows(data.lowStockItems) as AdminOverviewResponse['lowStockItems'],
    recentOrders: rows(data.recentOrders).map((o) => {
      const history = parseOrderHistory(o.statusHistory ?? o.status_history ?? o.status_history_json);
      const rawPaymentMethod = text(o.paymentMethod ?? o.payment_method);
      const rzPaymentId = o.razorpayPaymentId ?? o.razorpay_payment_id ?? null;
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: text(o.status) || undefined,
        rawFulfillmentStatus: text(o.fulfillmentStatus ?? o.fulfillment_status) || undefined,
        rawCancelRequest: o.cancelRequest ?? o.cancel_request ?? o.cancel_request_json,
        rawReturnRequest: o.returnRequest ?? o.return_request ?? o.return_request_json,
        rawPaymentStatus: o.paymentStatus ?? o.payment_status,
        rawRefundStatus: o.refundStatus ?? o.refund_status,
        rawCancelledAt: o.cancelledAt ?? o.cancelled_at,
        rawCancelledBy: o.cancelledBy ?? o.cancelled_by,
        rawCancelReason: o.cancelReason ?? o.cancel_reason,
        razorpayPaymentId: rzPaymentId,
        history,
        paymentMethod: rawPaymentMethod || undefined,
      });
      const fulfillmentStatus: OrderFulfillmentStatus =
        norm.fulfillmentStatus === 'pending' ||
        norm.fulfillmentStatus === 'placed' ||
        norm.fulfillmentStatus === 'confirmed' ||
        norm.fulfillmentStatus === 'packed' ||
        norm.fulfillmentStatus === 'shipped' ||
        norm.fulfillmentStatus === 'delivered' ||
        norm.fulfillmentStatus === 'cancelled' ||
        norm.fulfillmentStatus === 'returned'
          ? (norm.fulfillmentStatus as OrderFulfillmentStatus)
          : 'unknown';
      const status = fulfillmentStatus;
      const paymentStatus: OrderPaymentStatus = norm.paymentStatus;
      const paymentMethod: 'cod' | 'razorpay' | undefined =
        rawPaymentMethod === 'razorpay' || rawPaymentMethod === 'cod'
          ? rawPaymentMethod
          : rzPaymentId
            ? 'razorpay'
            : undefined;
      return {
        id: text(o.id),
        orderNumber: text(o.orderNumber ?? o.order_number),
        customerUserId:
          typeof (o.customerUserId ?? o.customer_user_id) === 'string'
            ? String(o.customerUserId ?? o.customer_user_id)
            : null,
        customerName: text(o.customerName ?? o.customer_name),
        customerEmail: text(o.customerEmail ?? o.customer_email),
        customerPhone: text(o.customerPhone ?? o.customer_phone),
        shippingAddress: text(o.shippingAddress ?? o.shipping_address),
        status,
        paymentStatus,
        refundStatus: norm.refundStatus,
        fulfillmentStatus,
        paymentMethod,
        paymentCollectedAt:
          typeof (o.paymentCollectedAt ?? o.payment_collected_at) === 'number'
            ? Number(o.paymentCollectedAt ?? o.payment_collected_at)
            : null,
        idempotencyKey:
          typeof (o.idempotencyKey ?? o.idempotency_key) === 'string'
            ? String(o.idempotencyKey ?? o.idempotency_key)
            : null,
        razorpayOrderId:
          typeof (o.razorpayOrderId ?? o.razorpay_order_id) === 'string'
            ? String(o.razorpayOrderId ?? o.razorpay_order_id)
            : null,
        razorpayPaymentId: typeof rzPaymentId === 'string' ? rzPaymentId : null,
        couponCode:
          typeof (o.couponCode ?? o.coupon_code) === 'string'
            ? String(o.couponCode ?? o.coupon_code)
            : null,
        giftCardCode:
          typeof (o.giftCardCode ?? o.gift_card_code) === 'string'
            ? String(o.giftCardCode ?? o.gift_card_code)
            : null,
        subtotalPaise: number(o.subtotalPaise ?? o.subtotal_paise),
        discountPaise: number(o.discountPaise ?? o.discount_paise),
        giftCardPaise: number(o.giftCardPaise ?? o.gift_card_paise),
        totalPaise: number(o.totalPaise ?? o.total_paise),
        currency: text(o.currency) || 'INR',
        statusHistory: parseJsonField(o.statusHistory ?? o.status_history ?? o.status_history_json, []),
        cancelledAt: norm.cancelledAt,
        cancelledBy: norm.cancelledBy,
        cancelReason: norm.cancelReason,
        cancelRequest: norm.cancelRequest,
        returnRequest: norm.returnRequest,
        hiddenByCustomer: Boolean(o.hiddenByCustomer ?? o.hidden_by_customer),
        needsAdminReview: norm.needsAdminReview,
        legacyCollisionNote: norm.legacyCollisionNote,
        createdAt: number(o.createdAt ?? o.created_at),
        updatedAt: number(o.updatedAt ?? o.updated_at ?? o.createdAt ?? o.created_at),
        items: rows(o.items) as any,
      };
    }),
    recentMessages: rows(data.recentMessages).map((m) => ({
      id: text(m.id),
      senderName: text(m.senderName ?? m.sender_name ?? m.full_name),
      senderEmail: text(m.senderEmail ?? m.sender_email ?? m.email),
      senderPhone: text(m.senderPhone ?? m.sender_phone ?? m.phone),
      subject: text(m.subject ?? m.product_interest),
      message: text(m.message),
      status: ['read', 'replied', 'archived'].includes(m.status) ? m.status : 'unread',
      adminNote: text(m.adminNote ?? m.admin_note ?? m.admin_notes),
      createdAt: number(m.createdAt ?? m.created_at),
      updatedAt: number(m.updatedAt ?? m.updated_at),
    })),
    recentAuditLogs: rows(data.recentAuditLogs ?? data.recentAudit).map((a) => ({
      id: text(a.id),
      productId: text(a.productId ?? a.product_id ?? a.entity_id),
      productTitle: text(a.productTitle ?? a.product_title) || 'Catalog update',
      action: text(a.action),
      summary: text(a.summary),
      createdAt: number(a.createdAt ?? a.created_at),
    })),
  };
}
