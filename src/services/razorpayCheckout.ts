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

export function ensureRazorpayCheckoutScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (typeof window.Razorpay === 'function') return Promise.resolve(true);

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_CHECKOUT_SCRIPT_SRC}"]`
    );
    if (existing) {
      if (typeof window.Razorpay === 'function') {
        resolve(true);
        return;
      }
      existing.addEventListener('load', () => resolve(typeof window.Razorpay === 'function'), {
        once: true,
      });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = RAZORPAY_CHECKOUT_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(typeof window.Razorpay === 'function');
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export interface CreateRazorpayOrderInput {
  amount: number;
  currency?: string;
  receipt?: string;
}

export interface CreateRazorpayOrderResponse {
  order_id: string;
  amount: number;
  currency: string;
  receipt?: string;
}

export async function createRazorpayOrder(
  input: CreateRazorpayOrderInput
): Promise<
  | { ok: true; data: CreateRazorpayOrderResponse }
  | { ok: false; status: number; error: string }
> {
  if (!Number.isInteger(input.amount) || input.amount < 100) {
    return {
      ok: false,
      status: 400,
      error: 'Order amount must be at least ₹1.00 (100 paise).',
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
        amount: input.amount,
        currency: input.currency || 'INR',
        receipt: input.receipt || `rcpt_${Date.now()}`,
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
    if (!orderId) {
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
        amount: typeof body.amount === 'number' ? body.amount : input.amount,
        currency: typeof body.currency === 'string' ? body.currency : input.currency || 'INR',
        receipt: typeof body.receipt === 'string' ? body.receipt : input.receipt,
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
