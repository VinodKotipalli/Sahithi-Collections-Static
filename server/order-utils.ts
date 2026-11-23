export type OrderRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type OrderRequestType = 'cancel' | 'return';
export type AuthoritativeOrderStatus =
  | 'pending'
  | 'placed'
  | 'confirmed'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'returned';
export type NormalizedPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed';
export type OrderRefundStatus =
  | 'none'
  | 'not_required'
  | 'pending_refund'
  | 'refund_initiated'
  | 'refunded';
export type OrderCancellationActor = 'customer' | 'owner' | 'system';

export interface NotificationPreferencesData {
  orderUpdates: boolean;
  cancelReturnUpdates: boolean;
  promotions: boolean;
  emailEnabled: boolean;
  smsWhatsappEnabled: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPreferencesData = {
  orderUpdates: true,
  cancelReturnUpdates: true,
  promotions: false,
  emailEnabled: true,
  smsWhatsappEnabled: true,
};

export interface OrderRequestRecordData {
  id: string;
  type: OrderRequestType;
  reason: string;
  status: OrderRequestStatus;
  requestedAt: number;
  updatedAt?: number;
  resolvedAt?: number | null;
  resolutionNote?: string;
}

export interface OrderHistoryEntryData {
  status: string;
  note?: string;
  actor: 'customer' | 'owner' | 'system';
  at: number;
}

export interface CustomerPaymentMethodData {
  id: string;
  methodType: 'card' | 'upi' | 'wallet';
  label: string;
  last4?: string;
  network?: string;
  expiry?: string;
  createdAt?: number;
  updatedAt?: number;
}

export const PRE_SHIPPING_CANCEL_STATES = new Set([
  'pending',
  'placed',
  'confirmed',
  'packed',
]);

export const PRE_CUTOFF_DELIVERY_EDIT_STATES = new Set([
  'pending',
  'placed',
  'confirmed',
]);

export const RETURN_ELIGIBLE_STATES = new Set(['delivered']);

export const VALID_FULFILLMENT_STATES = new Set([
  'pending',
  'placed',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
]);

export const TERMINAL_ORDER_STATES = new Set(['cancelled', 'returned']);

export const ALLOWED_STATUS_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['pending', 'placed', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled']),
  placed: new Set(['placed', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled']),
  confirmed: new Set(['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']),
  packed: new Set(['packed', 'shipped', 'delivered', 'cancelled']),
  shipped: new Set(['shipped', 'delivered', 'returned']),
  delivered: new Set(['delivered', 'returned']),
  cancelled: new Set(['cancelled']),
  returned: new Set(['returned']),
};

export function normalizeRawOrderStatusValue(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!cleaned) return '';
  if (cleaned === 'canceled' || cleaned === 'cancelled_by_customer' || cleaned === 'cancelled_by_admin') {
    return 'cancelled';
  }
  if (cleaned === 'processing') return 'confirmed';
  if (cleaned === 'fulfilled') return 'delivered';
  return cleaned;
}

export function validateOrderStatusTransition(
  currentStatus: string,
  nextStatus: string
): { ok: true } | { ok: false; code: string; error: string } {
  const from = normalizeRawOrderStatusValue(currentStatus);
  const to = normalizeRawOrderStatusValue(nextStatus);
  if (!VALID_FULFILLMENT_STATES.has(to)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `Invalid order status "${nextStatus}".`,
    };
  }
  if (from === 'cancelled' && to !== 'cancelled') {
    return {
      ok: false,
      code: 'INVALID_STATUS_TRANSITION',
      error: 'Cancelled orders cannot be reopened or moved back to an active fulfillment stage.',
    };
  }
  if (from === 'returned' && to !== 'returned') {
    return {
      ok: false,
      code: 'INVALID_STATUS_TRANSITION',
      error: 'Returned orders cannot be moved back to an active fulfillment stage.',
    };
  }
  if ((from === 'shipped' || from === 'delivered') && to === 'cancelled') {
    return {
      ok: false,
      code: 'CANCELLATION_CUTOFF_PASSED',
      error: `Orders already marked as ${from} cannot be cancelled.`,
    };
  }
  const allowed = ALLOWED_STATUS_TRANSITIONS[from];
  if (allowed && !allowed.has(to)) {
    return {
      ok: false,
      code: 'INVALID_STATUS_TRANSITION',
      error: `Order cannot transition from "${from}" to "${to}".`,
    };
  }
  return { ok: true };
}

export function normalizePaymentAndRefundStatus(params: {
  rawPaymentStatus?: unknown;
  rawRefundStatus?: unknown;
  paymentMethod?: unknown;
  orderStatus?: string;
  razorpayPaymentId?: unknown;
}): {
  paymentStatus: NormalizedPaymentStatus;
  refundStatus: OrderRefundStatus;
} {
  const rawPay =
    typeof params.rawPaymentStatus === 'string'
      ? params.rawPaymentStatus.trim().toLowerCase()
      : '';
  const rawRef =
    typeof params.rawRefundStatus === 'string'
      ? params.rawRefundStatus.trim().toLowerCase()
      : '';
  const hasRazorpayPayment =
    typeof params.razorpayPaymentId === 'string' && params.razorpayPaymentId.trim().length > 0;
  const normalizedOrderStatus = normalizeRawOrderStatusValue(params.orderStatus);

  // Separate paymentStatus from refundStatus cleanly (legacy records sometimes put 'refunded' in payment_status)
  let paymentStatus: NormalizedPaymentStatus;
  if (rawPay === 'paid' || rawPay === 'captured') {
    paymentStatus = 'paid';
  } else if (rawPay === 'refunded') {
    paymentStatus = 'paid';
  } else if (rawPay === 'pending' || rawPay === 'authorized' || rawPay === 'created') {
    paymentStatus = 'pending';
  } else if (rawPay === 'failed') {
    paymentStatus = 'failed';
  } else if (rawPay === 'unpaid') {
    paymentStatus = 'unpaid';
  } else {
    paymentStatus = hasRazorpayPayment ? 'paid' : 'unpaid';
  }

  let refundStatus: OrderRefundStatus;
  const isCancelledOrReturned =
    normalizedOrderStatus === 'cancelled' || normalizedOrderStatus === 'returned';

  if (
    rawRef === 'refunded' ||
    rawRef === 'refund_initiated' ||
    rawRef === 'pending_refund'
  ) {
    refundStatus = rawRef;
  } else if (rawRef === 'not_required' && !(isCancelledOrReturned && paymentStatus === 'paid')) {
    refundStatus = 'not_required';
  } else if (rawPay === 'refunded') {
    refundStatus = 'refunded';
  } else if (isCancelledOrReturned) {
    refundStatus = paymentStatus === 'paid' ? 'pending_refund' : 'not_required';
  } else if (rawRef === 'none') {
    refundStatus = 'none';
  } else {
    refundStatus = 'none';
  }

  return { paymentStatus, refundStatus };
}

export function isOrderPendingFulfillment(orderStatus: string): boolean {
  const normalized = normalizeRawOrderStatusValue(orderStatus);
  return (
    normalized === 'pending' ||
    normalized === 'placed' ||
    normalized === 'confirmed' ||
    normalized === 'packed' ||
    normalized === 'shipped'
  );
}

export function isOrderAwaitingDispatch(orderStatus: string): boolean {
  const normalized = normalizeRawOrderStatusValue(orderStatus);
  return (
    normalized === 'pending' ||
    normalized === 'placed' ||
    normalized === 'confirmed' ||
    normalized === 'packed'
  );
}

export function parseNotificationPrefs(raw: unknown): NotificationPreferencesData {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = null;
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }

  if (!obj) return { ...DEFAULT_NOTIFICATION_PREFS };
  return {
    orderUpdates:
      typeof obj.orderUpdates === 'boolean'
        ? obj.orderUpdates
        : DEFAULT_NOTIFICATION_PREFS.orderUpdates,
    cancelReturnUpdates:
      typeof obj.cancelReturnUpdates === 'boolean'
        ? obj.cancelReturnUpdates
        : DEFAULT_NOTIFICATION_PREFS.cancelReturnUpdates,
    promotions:
      typeof obj.promotions === 'boolean'
        ? obj.promotions
        : DEFAULT_NOTIFICATION_PREFS.promotions,
    emailEnabled:
      typeof obj.emailEnabled === 'boolean'
        ? obj.emailEnabled
        : DEFAULT_NOTIFICATION_PREFS.emailEnabled,
    smsWhatsappEnabled:
      typeof obj.smsWhatsappEnabled === 'boolean'
        ? obj.smsWhatsappEnabled
        : DEFAULT_NOTIFICATION_PREFS.smsWhatsappEnabled,
  };
}

export function sanitizeOrderRequestRecord(
  raw: unknown,
  fallbackType?: OrderRequestType
): OrderRequestRecordData | null {
  let parsed: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const obj = JSON.parse(raw) as unknown;
      if (obj && typeof obj === 'object') parsed = obj as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw as Record<string, unknown>;
  }

  if (!parsed || typeof parsed.id !== 'string' || !parsed.id.trim()) {
    return null;
  }

  const rawType = parsed.type === 'cancel' || parsed.type === 'return' ? parsed.type : fallbackType;
  if (!rawType) return null;

  const rawStatus = parsed.status;
  const status: OrderRequestStatus =
    rawStatus === 'approved' ||
    rawStatus === 'rejected' ||
    rawStatus === 'withdrawn' ||
    rawStatus === 'pending'
      ? rawStatus
      : 'pending';

  return {
    id: parsed.id,
    type: rawType,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    status,
    requestedAt: Number(parsed.requestedAt || 0),
    ...(typeof parsed.updatedAt === 'number' ? { updatedAt: Number(parsed.updatedAt) } : {}),
    resolvedAt:
      typeof parsed.resolvedAt === 'number' ? Number(parsed.resolvedAt) : null,
    ...(typeof parsed.resolutionNote === 'string' && parsed.resolutionNote.trim()
      ? { resolutionNote: parsed.resolutionNote.trim() }
      : {}),
  };
}

export function parseOrderHistory(raw: unknown): OrderHistoryEntryData[] {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as OrderHistoryEntryData[];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? (raw as OrderHistoryEntryData[]) : [];
}

/**
 * Recover authoritative fulfillment status from an order record without silently
 * converting cancelled, unknown, or missing statuses into 'pending'.
 */
export function recoverLegacyFulfillmentStatus(params: {
  rawStatus?: string | null;
  rawFulfillmentStatus?: string | null;
  history?: OrderHistoryEntryData[];
  paymentMethod?: string | null;
  hasReturnOnly?: boolean;
  cancelRequest?: OrderRequestRecordData | null;
  cancelledAt?: number | null;
}): { status: string; unknownOrCorrupted: boolean } {
  const safeHistory = Array.isArray(params.history) ? params.history : [];
  const f = normalizeRawOrderStatusValue(params.rawFulfillmentStatus);
  const s = normalizeRawOrderStatusValue(params.rawStatus);

  // Authoritative cancellation takes precedence if either field or verified timestamp/approved cancel says cancelled
  if (
    f === 'cancelled' ||
    s === 'cancelled' ||
    (typeof params.cancelledAt === 'number' && params.cancelledAt > 0) ||
    params.cancelRequest?.status === 'approved'
  ) {
    return { status: 'cancelled', unknownOrCorrupted: false };
  }

  if (f && f !== 'return_requested' && VALID_FULFILLMENT_STATES.has(f)) {
    return { status: f, unknownOrCorrupted: false };
  }
  if (s && s !== 'return_requested' && VALID_FULFILLMENT_STATES.has(s)) {
    return { status: s, unknownOrCorrupted: false };
  }

  // Legacy doc had status/fulfillment_status corrupted to 'return_requested' — recover from history
  if (f === 'return_requested' || s === 'return_requested') {
    for (let i = safeHistory.length - 1; i >= 0; i -= 1) {
      const entryStatus = normalizeRawOrderStatusValue(safeHistory[i]?.status);
      if (VALID_FULFILLMENT_STATES.has(entryStatus)) {
        return { status: entryStatus, unknownOrCorrupted: false };
      }
      if (entryStatus === 'cancel_approved') {
        return { status: 'cancelled', unknownOrCorrupted: false };
      }
    }
    if (params.hasReturnOnly) {
      return { status: 'delivered', unknownOrCorrupted: false };
    }
    return {
      status: params.paymentMethod === 'cod' ? 'placed' : 'confirmed',
      unknownOrCorrupted: false,
    };
  }

  // Check history if raw status was empty or unrecognized
  for (let i = safeHistory.length - 1; i >= 0; i -= 1) {
    const entryStatus = normalizeRawOrderStatusValue(safeHistory[i]?.status);
    if (VALID_FULFILLMENT_STATES.has(entryStatus)) {
      return { status: entryStatus, unknownOrCorrupted: false };
    }
    if (entryStatus === 'cancel_approved') {
      return { status: 'cancelled', unknownOrCorrupted: false };
    }
  }

  // Never silently coerce missing/unknown status to 'pending' — flag as unknown for explicit visibility
  return { status: 'unknown', unknownOrCorrupted: true };
}

export function normalizeOrderRequestsAndStatus(params: {
  rawStatus?: string | null;
  rawFulfillmentStatus?: string | null;
  rawCancelRequest?: unknown;
  rawReturnRequest?: unknown;
  rawPaymentStatus?: unknown;
  rawRefundStatus?: unknown;
  rawCancelledAt?: unknown;
  rawCancelledBy?: unknown;
  rawCancelReason?: unknown;
  razorpayPaymentId?: unknown;
  history?: OrderHistoryEntryData[];
  paymentMethod?: string | null;
}): {
  status: string;
  fulfillmentStatus: string;
  paymentStatus: NormalizedPaymentStatus;
  refundStatus: OrderRefundStatus;
  cancelledAt: number | null;
  cancelledBy: OrderCancellationActor | null;
  cancelReason: string | null;
  cancelRequest: OrderRequestRecordData | null;
  returnRequest: OrderRequestRecordData | null;
  needsAdminReview: boolean;
  legacyCollisionNote: string | null;
} {
  const safeHistory = Array.isArray(params.history) ? params.history : [];
  let cancelRequest = sanitizeOrderRequestRecord(params.rawCancelRequest, 'cancel');
  let returnRequest = sanitizeOrderRequestRecord(params.rawReturnRequest, 'return');

  let hadLegacyMisplacedCancel = false;
  if (!cancelRequest && returnRequest && returnRequest.type === 'cancel') {
    cancelRequest = { ...returnRequest, type: 'cancel' };
    returnRequest = null;
    hadLegacyMisplacedCancel = true;
  }

  const rawF = normalizeRawOrderStatusValue(params.rawFulfillmentStatus);
  const rawS = normalizeRawOrderStatusValue(params.rawStatus);
  const collidedWithReturnRequested =
    rawF === 'return_requested' || rawS === 'return_requested';

  const explicitCancelledAt =
    typeof params.rawCancelledAt === 'number' && Number.isFinite(params.rawCancelledAt) && params.rawCancelledAt > 0
      ? Number(params.rawCancelledAt)
      : null;

  const recovered = recoverLegacyFulfillmentStatus({
    rawStatus: rawS,
    rawFulfillmentStatus: rawF,
    history: safeHistory,
    paymentMethod: params.paymentMethod,
    hasReturnOnly: Boolean(returnRequest && !cancelRequest),
    cancelRequest,
    cancelledAt: explicitCancelledAt,
  });

  const authoritativeStatus = recovered.status;

  // Derive cancellation metadata from explicit columns, history, or approved cancelRequest
  let cancelledAt = explicitCancelledAt;
  let cancelledBy: OrderCancellationActor | null =
    params.rawCancelledBy === 'customer' ||
    params.rawCancelledBy === 'owner' ||
    params.rawCancelledBy === 'system'
      ? params.rawCancelledBy
      : null;
  let cancelReason =
    typeof params.rawCancelReason === 'string' && params.rawCancelReason.trim()
      ? params.rawCancelReason.trim()
      : null;

  if (authoritativeStatus === 'cancelled') {
    const cancelEntry = [...safeHistory]
      .reverse()
      .find((h) => {
        const hs = normalizeRawOrderStatusValue(h?.status);
        return hs === 'cancelled' || hs === 'cancel_approved';
      });
    if (!cancelledAt) {
      cancelledAt = cancelEntry?.at || cancelRequest?.resolvedAt || cancelRequest?.requestedAt || null;
    }
    if (!cancelledBy) {
      cancelledBy = cancelEntry?.actor || (cancelRequest ? 'customer' : 'owner');
    }
    if (!cancelReason) {
      cancelReason = cancelRequest?.reason || cancelEntry?.note || null;
    }
  }

  const { paymentStatus, refundStatus } = normalizePaymentAndRefundStatus({
    rawPaymentStatus: params.rawPaymentStatus,
    rawRefundStatus: params.rawRefundStatus,
    paymentMethod: params.paymentMethod,
    orderStatus: authoritativeStatus,
    razorpayPaymentId: params.razorpayPaymentId,
  });

  const needsAdminReview = Boolean(
    recovered.unknownOrCorrupted ||
      (collidedWithReturnRequested && (hadLegacyMisplacedCancel || cancelRequest))
  );
  const legacyCollisionNote = recovered.unknownOrCorrupted
    ? 'Order status was missing or unrecognized in storage; manual review recommended.'
    : collidedWithReturnRequested && (hadLegacyMisplacedCancel || cancelRequest)
      ? 'Legacy cancellation had return_requested fulfillment status; restored actual fulfillment stage for review.'
      : null;

  return {
    status: authoritativeStatus,
    fulfillmentStatus: authoritativeStatus,
    paymentStatus,
    refundStatus,
    cancelledAt,
    cancelledBy,
    cancelReason,
    cancelRequest,
    returnRequest,
    needsAdminReview,
    legacyCollisionNote,
  };
}

export function validateNonSensitivePaymentMethodInput(input: {
  methodType?: unknown;
  label?: unknown;
  last4?: unknown;
  network?: unknown;
  expiry?: unknown;
}):
  | {
      ok: true;
      methodType: 'card' | 'upi' | 'wallet';
      label: string;
      last4: string | null;
      network: string | null;
      expiry: string | null;
    }
  | { ok: false; error: string } {
  const methodType =
    input.methodType === 'card' || input.methodType === 'upi' || input.methodType === 'wallet'
      ? input.methodType
      : null;
  if (!methodType) {
    return { ok: false, error: 'Payment method type must be card, upi, or wallet.' };
  }

  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label.length < 2 || label.length > 80) {
    return {
      ok: false,
      error: 'Please enter a short label (2 to 80 characters), such as "Personal UPI" or "HDFC Regalia".',
    };
  }

  // Reject any attempt to store full card PANs or CVVs
  const rawLabelDigits = label.replace(/\D/g, '');
  if (rawLabelDigits.length >= 12) {
    return {
      ok: false,
      error: 'For your security, do not enter full card numbers. Only save a nickname and optional last 4 digits.',
    };
  }

  let last4: string | null = null;
  if (typeof input.last4 === 'string' && input.last4.trim()) {
    const cleanLast4 = input.last4.trim();
    if (!/^[0-9]{4}$/.test(cleanLast4)) {
      return { ok: false, error: 'Last 4 digits must be exactly 4 numbers.' };
    }
    last4 = cleanLast4;
  }

  let network: string | null = null;
  if (typeof input.network === 'string' && input.network.trim()) {
    const cleanNet = input.network.trim();
    if (cleanNet.length > 32) {
      return { ok: false, error: 'Card/wallet provider name is too long.' };
    }
    network = cleanNet;
  }

  let expiry: string | null = null;
  if (typeof input.expiry === 'string' && input.expiry.trim()) {
    const cleanExp = input.expiry.trim();
    if (!/^(0[1-9]|1[0-2])\/[0-9]{2,4}$/.test(cleanExp)) {
      return { ok: false, error: 'Expiry must follow MM/YY format.' };
    }
    expiry = cleanExp;
  }

  return { ok: true, methodType, label, last4, network, expiry };
}

export function maskOrderEmailForAudit(email: string): string {
  const clean = email.trim();
  const at = clean.indexOf('@');
  if (at <= 1) return clean;
  return `${clean.slice(0, 2)}***${clean.slice(at)}`;
}
