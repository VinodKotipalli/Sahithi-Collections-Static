import type { PlacedOrderReceipt } from '../types/boutique';
import { getValidClientIdToken } from './firebaseClientApi';

export interface RazorpaySuccessPayload {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export interface RazorpayFailurePayload {
  error?: {
    code?: string;
    description?: string;
    source?: string;
    step?: string;
    reason?: string;
    metadata?: {
      order_id?: string;
      payment_id?: string;
    };
  };
}

export interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  theme?: {
    color?: string;
  };
  modal?: {
    ondismiss?: () => void;
  };
  handler: (response: RazorpaySuccessPayload) => void | Promise<void>;
}

export interface RazorpayInstance {
  open: () => void;
  on: (event: 'payment.failed', callback: (response: RazorpayFailurePayload) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayInstance;
  }
}

export const RAZORPAY_CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;
const DEFAULT_API_TIMEOUT_MS = 20_000;

let inFlightScriptLoadPromise: Promise<boolean> | null = null;

export function resetRazorpayCheckoutLoaderForTest(): void {
  inFlightScriptLoadPromise = null;
}

async function buildCheckoutHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const idToken = await getValidClientIdToken().catch(() => null);
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }
  return headers;
}

function getSafeSupportReference(
  body: Record<string, unknown>,
  res: Response
): string | undefined {
  if (typeof body.support_reference === 'string' && body.support_reference.trim()) {
    return body.support_reference.trim();
  }
  if (typeof body.requestId === 'string' && body.requestId.trim()) {
    return body.requestId.trim();
  }
  const headerId = res.headers.get('x-request-id') || res.headers.get('x-vercel-id');
  return headerId && headerId.trim() ? headerId.trim() : undefined;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_API_TIMEOUT_MS
): Promise<{ res: Response; timedOut: false } | { timedOut: true } | { networkError: string; timedOut: false }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, Math.max(2000, timeoutMs));

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return { res, timedOut: false };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { timedOut: true };
    }
    return {
      networkError:
        err instanceof Error
          ? err.message
          : 'Unable to reach the payment server. Please check your connection.',
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function ensureRazorpayCheckoutScript(
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false);
  }
  if (typeof window.Razorpay === 'function') {
    return Promise.resolve(true);
  }
  if (inFlightScriptLoadPromise) {
    return inFlightScriptLoadPromise;
  }

  const effectiveTimeoutMs = Math.max(50, timeoutMs);

  const loadPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_CHECKOUT_SCRIPT_SRC}"]`
    );

    if (
      existing &&
      existing.dataset?.razorpayStatus !== 'loading' &&
      existing.parentNode
    ) {
      // Remove stale/failed <script> elements from prior attempts so a fresh load occurs.
      existing.parentNode.removeChild(existing);
    }

    const activeExisting = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_CHECKOUT_SCRIPT_SRC}"]`
    );
    const isFreshScript = !activeExisting;
    const targetScript = activeExisting || document.createElement('script');

    const cleanupListeners = () => {
      targetScript.removeEventListener('load', onLoad);
      targetScript.removeEventListener('error', onError);
    };

    const finish = (ok: boolean, removeOnFail = false) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cleanupListeners();
      if (!ok) {
        if (targetScript.dataset) {
          targetScript.dataset.razorpayStatus = 'error';
        }
        if (removeOnFail && targetScript.parentNode) {
          targetScript.parentNode.removeChild(targetScript);
        }
      } else if (targetScript.dataset) {
        targetScript.dataset.razorpayStatus = 'ready';
      }
      resolve(ok);
    };

    const onLoad = () => {
      const available = typeof window.Razorpay === 'function';
      finish(available, !available);
    };

    const onError = () => {
      finish(false, true);
    };

    targetScript.addEventListener('load', onLoad, { once: true });
    targetScript.addEventListener('error', onError, { once: true });

    timer = setTimeout(() => {
      const available = typeof window.Razorpay === 'function';
      finish(available, !available);
    }, effectiveTimeoutMs);

    if (typeof window.Razorpay === 'function') {
      finish(true, false);
      return;
    }

    if (isFreshScript) {
      if (targetScript.dataset) {
        targetScript.dataset.razorpayStatus = 'loading';
      }
      targetScript.src = RAZORPAY_CHECKOUT_SCRIPT_SRC;
      targetScript.async = true;
      (document.body || document.head).appendChild(targetScript);
    }
  }).finally(() => {
    if (inFlightScriptLoadPromise === loadPromise) {
      inFlightScriptLoadPromise = null;
    }
  });

  inFlightScriptLoadPromise = loadPromise;
  return loadPromise;
}

export interface CreateRazorpayOrderItem {
  productId: string;
  variantId: string;
  quantity: number;
  expectedPricePaise?: number | null;
}

export interface CreateRazorpayOrderInput {
  items: CreateRazorpayOrderItem[];
  customer?: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    shippingAddress: string;
  };
  couponCode?: string | null;
  giftCardCode?: string | null;
  currency?: string;
  receipt?: string;
  idempotencyKey?: string;
}

export interface CreateRazorpayOrderResponse {
  order_id: string;
  internal_order_ref?: string;
  amount: number;
  subtotal_paise?: number;
  discount_paise?: number;
  gift_card_paise?: number;
  coupon_code?: string | null;
  gift_card_code?: string | null;
  currency: string;
  key_id: string;
  receipt?: string;
  checkout_token?: string;
  customer_user_id?: string | null;
  idempotent_reuse?: boolean;
  support_reference?: string;
}

export async function createRazorpayOrder(
  input: CreateRazorpayOrderInput
): Promise<
  | { ok: true; data: CreateRazorpayOrderResponse }
  | {
      ok: false;
      status: number;
      code?: string;
      error: string;
      timedOut?: boolean;
      supportReference?: string;
      existingOrder?: PlacedOrderReceipt;
    }
> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'EMPTY_CART',
      error: 'Your shopping bag is empty.',
    };
  }

  const headers = await buildCheckoutHeaders();
  const outcome = await fetchWithTimeout('/api/create-order', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      items: input.items,
      customer: input.customer,
      couponCode: input.couponCode || undefined,
      giftCardCode: input.giftCardCode || undefined,
      currency: input.currency || 'INR',
      receipt: input.receipt || `sc_rcpt_${Date.now()}`,
      idempotencyKey: input.idempotencyKey || undefined,
    }),
  });

  if (outcome.timedOut) {
    return {
      ok: false,
      status: 504,
      code: 'REQUEST_TIMEOUT',
      timedOut: true,
      error: 'The payment server took too long to respond. Please try again in a moment.',
    };
  }

  if ('networkError' in outcome) {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      error: outcome.networkError,
    };
  }

  const { res } = outcome;
  const body = await parseJsonSafe(res);
  const supportReference = getSafeSupportReference(body, res);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: typeof body.code === 'string' ? body.code : undefined,
      error:
        typeof body.error === 'string' && body.error
          ? body.error
          : `Failed to create payment order (HTTP ${res.status}).`,
      supportReference,
      existingOrder: body.order ? (body.order as PlacedOrderReceipt) : undefined,
    };
  }

  const orderId =
    typeof body.order_id === 'string'
      ? body.order_id
      : typeof body.id === 'string'
        ? body.id
        : '';
  const keyId = typeof body.key_id === 'string' ? body.key_id.trim() : '';
  const amount = typeof body.amount === 'number' ? Math.round(body.amount) : NaN;
  const currency = typeof body.currency === 'string' ? body.currency.trim() : '';

  if (!orderId || !keyId || !Number.isInteger(amount) || amount < 100 || !currency) {
    return {
      ok: false,
      status: 500,
      code: 'INVALID_ORDER_RESPONSE',
      error: 'Invalid order response received from payment server.',
      supportReference,
    };
  }

  return {
    ok: true,
    data: {
      order_id: orderId,
      internal_order_ref:
        typeof body.internal_order_ref === 'string' ? body.internal_order_ref : undefined,
      amount,
      subtotal_paise:
        typeof body.subtotal_paise === 'number' ? Math.round(body.subtotal_paise) : undefined,
      discount_paise:
        typeof body.discount_paise === 'number' ? Math.round(body.discount_paise) : undefined,
      gift_card_paise:
        typeof body.gift_card_paise === 'number' ? Math.round(body.gift_card_paise) : undefined,
      coupon_code: typeof body.coupon_code === 'string' ? body.coupon_code : null,
      gift_card_code: typeof body.gift_card_code === 'string' ? body.gift_card_code : null,
      currency,
      key_id: keyId,
      receipt: typeof body.receipt === 'string' ? body.receipt : input.receipt,
      checkout_token:
        typeof body.checkout_token === 'string' ? body.checkout_token : undefined,
      customer_user_id:
        typeof body.customer_user_id === 'string' ? body.customer_user_id : null,
      idempotent_reuse: Boolean(body.idempotent_reuse),
      support_reference: supportReference,
    },
  };
}

export interface VerifyRazorpayPaymentInput {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  checkout_token?: string;
  couponCode?: string | null;
  giftCardCode?: string | null;
  orderData?: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    shippingAddress: string;
    couponCode?: string | null;
    giftCardCode?: string | null;
    items: Array<{
      productId: string;
      variantId: string;
      quantity: number;
      expectedPricePaise: number;
    }>;
  };
}

export interface VerifyRazorpayPaymentResponse {
  success: boolean;
  verified: boolean;
  pending_confirmation?: boolean;
  order_id: string;
  internal_order_ref?: string;
  payment_id: string;
  message?: string;
  order?: PlacedOrderReceipt;
  support_reference?: string;
}

export async function verifyRazorpayPayment(
  input: VerifyRazorpayPaymentInput
): Promise<
  | { ok: true; data: VerifyRazorpayPaymentResponse }
  | {
      ok: false;
      status: number;
      code?: string;
      error: string;
      timedOut?: boolean;
      supportReference?: string;
    }
> {
  const headers = await buildCheckoutHeaders();
  const outcome = await fetchWithTimeout('/api/verify-payment', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(input),
  });

  if (outcome.timedOut) {
    return {
      ok: false,
      status: 504,
      code: 'VERIFY_TIMEOUT',
      timedOut: true,
      error: 'Verification timed out while contacting the server. Checking payment status…',
    };
  }

  if ('networkError' in outcome) {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      error: outcome.networkError,
    };
  }

  const { res } = outcome;
  const body = await parseJsonSafe(res);
  const supportReference = getSafeSupportReference(body, res);
  const isPendingConfirmation =
    res.status === 202 || body.pending_confirmation === true;

  if (isPendingConfirmation) {
    return {
      ok: true,
      data: {
        success: Boolean(body.success ?? true),
        verified: Boolean(body.verified ?? true),
        pending_confirmation: true,
        order_id: String(body.order_id || input.razorpay_order_id),
        internal_order_ref:
          typeof body.internal_order_ref === 'string' ? body.internal_order_ref : undefined,
        payment_id: String(body.payment_id || input.razorpay_payment_id),
        message:
          typeof body.message === 'string' && body.message
            ? body.message
            : 'Payment received. We are confirming your order.',
        support_reference: supportReference,
      },
    };
  }

  if (!res.ok || body.success !== true) {
    return {
      ok: false,
      status: res.status || 400,
      code: typeof body.code === 'string' ? body.code : undefined,
      error:
        typeof body.error === 'string' && body.error
          ? body.error
          : 'Payment signature verification failed.',
      supportReference,
    };
  }

  return {
    ok: true,
    data: {
      success: true,
      verified: true,
      pending_confirmation: false,
      order_id: String(body.order_id || input.razorpay_order_id),
      internal_order_ref:
        typeof body.internal_order_ref === 'string' ? body.internal_order_ref : undefined,
      payment_id: String(body.payment_id || input.razorpay_payment_id),
      message: typeof body.message === 'string' ? body.message : undefined,
      order: body.order ? (body.order as PlacedOrderReceipt) : undefined,
      support_reference: supportReference,
    },
  };
}

export async function checkRazorpayOrderStatus(params: {
  razorpayOrderId: string;
  razorpayPaymentId?: string;
}): Promise<
  | {
      ok: true;
      confirmed: boolean;
      pendingConfirmation: boolean;
      failed: boolean;
      status: string;
      message?: string;
      order?: PlacedOrderReceipt;
      razorpayOrderId: string;
      razorpayPaymentId?: string;
      supportReference?: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      timedOut?: boolean;
      supportReference?: string;
    }
> {
  const headers = await buildCheckoutHeaders();
  const outcome = await fetchWithTimeout('/api/order-status', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      razorpay_order_id: params.razorpayOrderId,
      razorpay_payment_id: params.razorpayPaymentId || undefined,
    }),
  });

  if (outcome.timedOut) {
    return {
      ok: false,
      status: 504,
      timedOut: true,
      error: 'Status check timed out. Please try again in a moment.',
    };
  }

  if ('networkError' in outcome) {
    return {
      ok: false,
      status: 0,
      error: outcome.networkError,
    };
  }

  const { res } = outcome;
  const body = await parseJsonSafe(res);
  const supportReference = getSafeSupportReference(body, res);

  if (!res.ok && res.status !== 202) {
    return {
      ok: false,
      status: res.status,
      error:
        typeof body.error === 'string' && body.error
          ? body.error
          : `Unable to check payment status (HTTP ${res.status}).`,
      supportReference,
    };
  }

  const normalizedStatus = String(
    body.status || (body.confirmed || body.order ? 'confirmed' : 'pending')
  );
  const failed = Boolean(body.failed || normalizedStatus === 'failed');

  return {
    ok: true,
    confirmed: Boolean((body.confirmed || body.verified || body.success) && body.order),
    pendingConfirmation: Boolean(body.pending_confirmation || res.status === 202),
    failed,
    status: normalizedStatus,
    message: typeof body.message === 'string' ? body.message : undefined,
    order: body.order ? (body.order as PlacedOrderReceipt) : undefined,
    razorpayOrderId: String(body.order_id || params.razorpayOrderId),
    razorpayPaymentId:
      typeof body.payment_id === 'string' ? body.payment_id : params.razorpayPaymentId,
    supportReference,
  };
}
