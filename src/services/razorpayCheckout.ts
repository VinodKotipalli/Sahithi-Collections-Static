import type { PlacedOrderReceipt } from '../types/boutique';

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
  currency?: string;
  receipt?: string;
}

export interface CreateRazorpayOrderResponse {
  order_id: string;
  amount: number;
  currency: string;
  key_id: string;
  receipt?: string;
  checkout_token?: string;
}

export async function createRazorpayOrder(
  input: CreateRazorpayOrderInput
): Promise<
  | { ok: true; data: CreateRazorpayOrderResponse }
  | { ok: false; status: number; error: string }
> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'Your shopping bag is empty.',
    };
  }

  try {
    const res = await fetch('/api/create-order', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        items: input.items,
        customer: input.customer,
        currency: input.currency || 'INR',
        receipt: input.receipt || `sc_rcpt_${Date.now()}`,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
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
        currency,
        key_id: keyId,
        receipt: typeof body.receipt === 'string' ? body.receipt : input.receipt,
        checkout_token:
          typeof body.checkout_token === 'string' ? body.checkout_token : undefined,
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
  orderData?: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    shippingAddress: string;
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
  order_id: string;
  payment_id: string;
  message?: string;
  order?: PlacedOrderReceipt;
}

export async function verifyRazorpayPayment(
  input: VerifyRazorpayPaymentInput
): Promise<
  | { ok: true; data: VerifyRazorpayPaymentResponse }
  | { ok: false; status: number; error: string }
> {
  try {
    const res = await fetch('/api/verify-payment', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(input),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.success !== true) {
      return {
        ok: false,
        status: res.status || 400,
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
