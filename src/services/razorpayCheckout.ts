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

const RAZORPAY_CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;

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

export function ensureRazorpayCheckoutScript(
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS
): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (typeof window.Razorpay === 'function') return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(ok);
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_CHECKOUT_SCRIPT_SRC}"]`
    );

    const targetScript = existing || document.createElement('script');
    const onLoad = () => finish(typeof window.Razorpay === 'function');
    const onError = () => {
      if (!existing && targetScript.parentNode) {
        targetScript.parentNode.removeChild(targetScript);
      }
      finish(false);
    };

    targetScript.addEventListener('load', onLoad, { once: true });
    targetScript.addEventListener('error', onError, { once: true });

    timer = setTimeout(() => {
      targetScript.removeEventListener('load', onLoad);
      targetScript.removeEventListener('error', onError);
      finish(typeof window.Razorpay === 'function');
    }, Math.max(1000, timeoutMs));

    if (!existing) {
      targetScript.src = RAZORPAY_CHECKOUT_SCRIPT_SRC;
      targetScript.async = true;
      document.body.appendChild(targetScript);
    } else if (typeof window.Razorpay === 'function') {
      targetScript.removeEventListener('load', onLoad);
      targetScript.removeEventListener('error', onError);
      finish(true);
    }
  });
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
}

export interface CreateRazorpayOrderResponse {
  order_id: string;
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
}

export async function createRazorpayOrder(
  input: CreateRazorpayOrderInput
): Promise<
  | { ok: true; data: CreateRazorpayOrderResponse }
  | { ok: false; status: number; code?: string; error: string }
> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'Your shopping bag is empty.',
    };
  }

  try {
    const headers = await buildCheckoutHeaders();
    const res = await fetch('/api/create-order', {
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
      }),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: typeof body.code === 'string' ? body.code : undefined,
        error:
          typeof body.error === 'string' && body.error
            ? body.error
            : `Failed to create payment order (HTTP ${res.status}).`,
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
        error: 'Invalid order response received from payment server.',
      };
    }

    return {
      ok: true,
      data: {
        order_id: orderId,
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
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error:
        err instanceof Error
          ? err.message
          : 'Unable to reach the payment server. Please check your connection.',
    };
  }
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
  payment_id: string;
  message?: string;
  order?: PlacedOrderReceipt;
}

export async function verifyRazorpayPayment(
  input: VerifyRazorpayPaymentInput
): Promise<
  | { ok: true; data: VerifyRazorpayPaymentResponse }
  | { ok: false; status: number; code?: string; error: string }
> {
  try {
    const headers = await buildCheckoutHeaders();
    const res = await fetch('/api/verify-payment', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(input),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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
          payment_id: String(body.payment_id || input.razorpay_payment_id),
          message:
            typeof body.message === 'string' && body.message
              ? body.message
              : 'Payment received. We are confirming your order.',
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
      };
    }

    return {
      ok: true,
      data: {
        success: true,
        verified: true,
        pending_confirmation: false,
        order_id: String(body.order_id || input.razorpay_order_id),
        payment_id: String(body.payment_id || input.razorpay_payment_id),
        message: typeof body.message === 'string' ? body.message : undefined,
        order: body.order ? (body.order as PlacedOrderReceipt) : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error:
        err instanceof Error
          ? err.message
          : 'Network error while verifying payment signature.',
    };
  }
}

export async function checkRazorpayOrderStatus(params: {
  razorpayOrderId: string;
  razorpayPaymentId?: string;
}): Promise<
  | {
      ok: true;
      confirmed: boolean;
      pendingConfirmation: boolean;
      status: string;
      message?: string;
      order?: PlacedOrderReceipt;
      razorpayOrderId: string;
      razorpayPaymentId?: string;
    }
  | { ok: false; status: number; error: string }
> {
  try {
    const headers = await buildCheckoutHeaders();
    const res = await fetch('/api/order-status', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        razorpay_order_id: params.razorpayOrderId,
        razorpay_payment_id: params.razorpayPaymentId || undefined,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && res.status !== 202) {
      return {
        ok: false,
        status: res.status,
        error:
          typeof body.error === 'string' && body.error
            ? body.error
            : `Unable to check payment status (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      confirmed: Boolean(body.confirmed && body.order),
      pendingConfirmation: Boolean(body.pending_confirmation || res.status === 202),
      status: String(body.status || (body.confirmed ? 'confirmed' : 'pending')),
      message: typeof body.message === 'string' ? body.message : undefined,
      order: body.order ? (body.order as PlacedOrderReceipt) : undefined,
      razorpayOrderId: String(body.order_id || params.razorpayOrderId),
      razorpayPaymentId:
        typeof body.payment_id === 'string' ? body.payment_id : params.razorpayPaymentId,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error:
        err instanceof Error
          ? err.message
          : 'Unable to check order status right now.',
    };
  }
}
