export type OrderRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type OrderRequestType = 'cancel' | 'return';

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
 * Recover true underlying fulfillment status from order history if a legacy bug
 * overwrote `status` / `fulfillment_status` to `return_requested`.
 */
export function recoverLegacyFulfillmentStatus(params: {
  rawStatus?: string | null;
  rawFulfillmentStatus?: string | null;
  history: OrderHistoryEntryData[];
  paymentMethod?: string | null;
  hasReturnOnly?: boolean;
}): string {
  const f = (params.rawFulfillmentStatus || '').trim();
  const s = (params.rawStatus || '').trim();

  if (f && f !== 'return_requested' && VALID_FULFILLMENT_STATES.has(f)) {
    return f;
  }
  if (s && s !== 'return_requested' && VALID_FULFILLMENT_STATES.has(s)) {
    return s;
  }

  // Legacy doc had status/fulfillment_status corrupted to 'return_requested'
  for (let i = params.history.length - 1; i >= 0; i -= 1) {
    const entryStatus = String(params.history[i]?.status || '').trim();
    if (VALID_FULFILLMENT_STATES.has(entryStatus)) {
      return entryStatus;
    }
  }

  if (params.hasReturnOnly) {
    return 'delivered';
  }
  return params.paymentMethod === 'cod' ? 'placed' : 'confirmed';
}

export function normalizeOrderRequestsAndStatus(params: {
  rawStatus?: string | null;
  rawFulfillmentStatus?: string | null;
  rawCancelRequest?: unknown;
  rawReturnRequest?: unknown;
  history: OrderHistoryEntryData[];
  paymentMethod?: string | null;
}): {
  status: string;
  fulfillmentStatus: string;
  cancelRequest: OrderRequestRecordData | null;
  returnRequest: OrderRequestRecordData | null;
  needsAdminReview: boolean;
  legacyCollisionNote: string | null;
} {
  let cancelRequest = sanitizeOrderRequestRecord(params.rawCancelRequest, 'cancel');
  let returnRequest = sanitizeOrderRequestRecord(params.rawReturnRequest, 'return');

  let hadLegacyMisplacedCancel = false;
  if (!cancelRequest && returnRequest && returnRequest.type === 'cancel') {
    cancelRequest = { ...returnRequest, type: 'cancel' };
    returnRequest = null;
    hadLegacyMisplacedCancel = true;
  }

  const rawF = String(params.rawFulfillmentStatus || '').trim();
  const rawS = String(params.rawStatus || '').trim();
  const collidedWithReturnRequested =
    rawF === 'return_requested' || rawS === 'return_requested';

  const recoveredFulfillment = recoverLegacyFulfillmentStatus({
    rawStatus: rawS,
    rawFulfillmentStatus: rawF,
    history: params.history,
    paymentMethod: params.paymentMethod,
    hasReturnOnly: Boolean(returnRequest && !cancelRequest),
  });

  const needsAdminReview = Boolean(
    collidedWithReturnRequested && (hadLegacyMisplacedCancel || cancelRequest)
  );
  const legacyCollisionNote = needsAdminReview
    ? 'Legacy cancellation had return_requested fulfillment status; restored actual fulfillment stage for review.'
    : null;

  return {
    status:
      rawS === 'return_requested'
        ? recoveredFulfillment
        : rawS || recoveredFulfillment,
    fulfillmentStatus: recoveredFulfillment,
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
