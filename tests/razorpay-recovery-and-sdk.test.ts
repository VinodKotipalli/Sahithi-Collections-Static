import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCreateOrderHandler } from '../api/create-order.ts';
import { createOrderStatusHandler } from '../api/order-status.ts';
import razorpayWebhookDefault, {
  config as webhookConfig,
  createRazorpayWebhookHandler,
} from '../api/razorpay-webhook.ts';
import { createVerifyPaymentHandler } from '../api/verify-payment.ts';
import { createAuthApp } from '../server/app.ts';
import {
  clearRazorpayCheckoutCachesForTest,
  type RazorpayClientFactory,
} from '../server/razorpay-checkout.ts';
import { SqliteBoutiqueStore } from '../server/sqlite-store.ts';
import {
  createRazorpayOrder,
  ensureRazorpayCheckoutScript,
  RAZORPAY_CHECKOUT_SCRIPT_SRC,
  resetRazorpayCheckoutLoaderForTest,
} from '../src/services/razorpayCheckout.ts';

function setupMockDomForRazorpayLoader() {
  type Listener = () => void;
  const createdScripts: Array<{
    src: string;
    async: boolean;
    dataset: Record<string, string>;
    parentNode: { removeChild: (el: unknown) => void } | null;
    listeners: Record<string, Listener[]>;
    addEventListener: (ev: string, fn: Listener) => void;
    removeEventListener: (ev: string, fn: Listener) => void;
    trigger: (ev: 'load' | 'error') => void;
  }> = [];

  const body = {
    children: createdScripts as unknown[],
    appendChild(el: (typeof createdScripts)[number]) {
      el.parentNode = body;
      createdScripts.push(el);
    },
    removeChild(el: unknown) {
      const idx = createdScripts.indexOf(el as (typeof createdScripts)[number]);
      if (idx >= 0) {
        createdScripts[idx]!.parentNode = null;
        createdScripts.splice(idx, 1);
      }
    },
  };

  const mockDocument = {
    body,
    head: body,
    querySelector(selector: string) {
      if (selector.includes(RAZORPAY_CHECKOUT_SCRIPT_SRC)) {
        return createdScripts[0] || null;
      }
      return null;
    },
    createElement() {
      const listeners: Record<string, Listener[]> = { load: [], error: [] };
      const el = {
        src: '',
        async: false,
        dataset: {} as Record<string, string>,
        parentNode: null as { removeChild: (node: unknown) => void } | null,
        listeners,
        addEventListener(ev: string, fn: Listener) {
          listeners[ev] = listeners[ev] || [];
          listeners[ev]!.push(fn);
        },
        removeEventListener(ev: string, fn: Listener) {
          listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
        },
        trigger(ev: 'load' | 'error') {
          for (const fn of [...(listeners[ev] || [])]) {
            fn();
          }
        },
      };
      return el;
    },
  };

  const mockWindow: { Razorpay?: unknown } = {};
  (globalThis as unknown as { window?: unknown }).window = mockWindow;
  (globalThis as unknown as { document?: unknown }).document = mockDocument;

  return {
    mockWindow,
    createdScripts,
    cleanup() {
      resetRazorpayCheckoutLoaderForTest();
      delete (globalThis as unknown as { window?: unknown }).window;
      delete (globalThis as unknown as { document?: unknown }).document;
    },
  };
}

test('ensureRazorpayCheckoutScript shares one concurrent load, cleans up errors & timeouts, and recovers on retry', async () => {
  const dom = setupMockDomForRazorpayLoader();
  try {
    resetRazorpayCheckoutLoaderForTest();

    // 1. Concurrent callers share a single <script> element
    const p1 = ensureRazorpayCheckoutScript(2000);
    const p2 = ensureRazorpayCheckoutScript(2000);
    assert.equal(dom.createdScripts.length, 1, 'Concurrent calls must only inject one script tag');

    // Trigger network/script load failure
    dom.createdScripts[0]!.trigger('error');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, false);
    assert.equal(r2, false);
    assert.equal(dom.createdScripts.length, 0, 'Failed script element must be removed on error');

    // 2. Retry after failure injects a fresh script tag; test timeout cleanup
    const pTimeout = ensureRazorpayCheckoutScript(60);
    assert.equal(dom.createdScripts.length, 1, 'Retry after error should inject a fresh script');
    const rTimeout = await pTimeout;
    assert.equal(rTimeout, false);
    assert.equal(dom.createdScripts.length, 0, 'Timed-out script element must be cleaned up');

    // 3. Second retry succeeds cleanly once script loads and initializes window.Razorpay
    const pSuccess = ensureRazorpayCheckoutScript(2000);
    assert.equal(dom.createdScripts.length, 1);
    dom.mockWindow.Razorpay = function MockRazorpay() {};
    dom.createdScripts[0]!.trigger('load');
    assert.equal(await pSuccess, true);

    // 4. Already-loaded SDK resolves immediately without adding more script tags
    assert.equal(await ensureRazorpayCheckoutScript(2000), true);
    assert.equal(dom.createdScripts.length, 1);
  } finally {
    dom.cleanup();
  }
});

test('Express app sets CSP headers allowing Razorpay Checkout SDK & frames and attaches checkout routes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-csp-test-'));
  const { app } = createAuthApp({
    dbPath: path.join(tmpDir, 'boutique.db'),
    disableRateLimit: true,
    seedCatalog: true,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/api/products`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /https:\/\/checkout\.razorpay\.com/);
    assert.match(csp, /https:\/\/api\.razorpay\.com/);
    assert.match(csp, /https:\/\/firestore\.googleapis\.com/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Order creation idempotency, transient verification retry, pending-capture 202, payment.failed webhook & out-of-order protection', async () => {
  assert.equal(webhookConfig.api.bodyParser, false);
  assert.equal(typeof razorpayWebhookDefault, 'function');

  clearRazorpayCheckoutCachesForTest();
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  process.env.RAZORPAY_KEY_ID = 'rzp_test_IdempKey1234';
  process.env.RAZORPAY_KEY_SECRET = 'IdempSecretTest999';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'WebhookSecretIdemp1';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-rzp-rec-'));
  const store = new SqliteBoutiqueStore({
    dbPath: path.join(tmpDir, 'boutique.db'),
    targetEnv: 'development',
    seedCatalog: true,
  });

  let rzpCreateCalls = 0;
  let lastCreatedAmount = 0;
  let paymentFetchAttempt = 0;
  let forcePendingCapture = false;
  let forceTransientFetchErrorCount = 0;

  const factory: RazorpayClientFactory = () => ({
    orders: {
      async create(params) {
        rzpCreateCalls += 1;
        lastCreatedAmount = params.amount;
        return {
          id: `order_rec_${rzpCreateCalls}`,
          amount: params.amount,
          currency: params.currency,
          receipt: params.receipt,
          notes: params.notes,
          status: 'created',
        };
      },
      async fetch(orderId) {
        return {
          id: orderId,
          amount: lastCreatedAmount,
          currency: 'INR',
          status: forcePendingCapture ? 'attempted' : 'paid',
        };
      },
    },
    payments: {
      async fetch(paymentId) {
        paymentFetchAttempt += 1;
        if (forceTransientFetchErrorCount > 0) {
          forceTransientFetchErrorCount -= 1;
          const err = new Error('Gateway timeout while fetching payment') as Error & {
            statusCode?: number;
          };
          err.statusCode = 504;
          throw err;
        }
        return {
          id: paymentId,
          order_id: `order_rec_${rzpCreateCalls}`,
          amount: lastCreatedAmount,
          currency: 'INR',
          status: forcePendingCapture ? 'authorized' : 'captured',
          captured: !forcePendingCapture,
        };
      },
      async capture(paymentId, amount, currency) {
        if (forcePendingCapture) {
          // Simulates gateway keeping payment in authorized/pending capture state
          return {
            id: paymentId,
            order_id: `order_rec_${rzpCreateCalls}`,
            amount,
            currency,
            status: 'authorized',
            captured: false,
          };
        }
        return {
          id: paymentId,
          order_id: `order_rec_${rzpCreateCalls}`,
          amount,
          currency,
          status: 'captured',
          captured: true,
        };
      },
    },
  });

  const verifyIdToken = async (token: string) =>
    token === 'tok_user_1' ? { uid: 'uid_rec_1', email: 'ananya@example.com' } : null;

  const createHandler = createCreateOrderHandler({ razorpayClientFactory: factory, store, verifyIdToken });
  const verifyHandler = createVerifyPaymentHandler({ razorpayClientFactory: factory, store, verifyIdToken });
  const webhookHandler = createRazorpayWebhookHandler({ razorpayClientFactory: factory, store });
  const statusHandler = createOrderStatusHandler({ razorpayClientFactory: factory, store, verifyIdToken });

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/create-order')) return void createHandler(req, res);
    if (req.url?.startsWith('/api/verify-payment')) return void verifyHandler(req, res);
    if (req.url?.startsWith('/api/razorpay-webhook')) return void webhookHandler(req, res);
    if (req.url?.startsWith('/api/order-status')) return void statusHandler(req, res);
    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await store.createPendingEmailUser({
      id: 'uid_rec_1',
      fullName: 'Ananya Reddy',
      email: 'ananya@example.com',
      passwordHash: 'hash',
      now: Date.now(),
    });
    await store.markUserEmailVerified('uid_rec_1', Date.now());

    const productEntry = (await store.listPublicProducts({})).find((p) => p.product.id === 'sc-001')!;
    const variant = productEntry.variants[0]!;
    const initialStock = variant.stock_qty;

    const payload = {
      items: [
        {
          productId: productEntry.product.id,
          variantId: variant.id,
          quantity: 1,
          expectedPricePaise: variant.price_paise,
        },
      ],
      customer: {
        customerName: 'Ananya Reddy',
        customerEmail: 'ananya@example.com',
        customerPhone: '+91 98765 43210',
        shippingAddress: '12 Jubilee Hills, Hyderabad 500033',
      },
      idempotencyKey: 'rzp_attempt_idemp_001',
    };

    // 1. Two identical create-order calls return the exact same Razorpay order & internal_order_ref
    const res1 = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok_user_1',
        'x-request-id': 'req_support_101',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as {
      order_id: string;
      internal_order_ref: string;
      checkout_token: string;
      support_reference: string;
      idempotent_reuse?: boolean;
    };
    assert.equal(body1.order_id, 'order_rec_1');
    assert.equal(body1.internal_order_ref, 'ord_rzp_order_rec_1');
    assert.equal(body1.support_reference, 'req_support_101');

    const res2 = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok_user_1',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as {
      order_id: string;
      internal_order_ref: string;
      idempotent_reuse?: boolean;
    };
    assert.equal(body2.order_id, 'order_rec_1');
    assert.equal(body2.internal_order_ref, 'ord_rzp_order_rec_1');
    assert.equal(body2.idempotent_reuse, true);
    assert.equal(rzpCreateCalls, 1, 'Duplicate create-order retry must not create another Razorpay order');

    // Changing cart quantity with the same idempotencyKey fails loudly with 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_user_1' },
      body: JSON.stringify({
        ...payload,
        items: [{ ...payload.items[0]!, quantity: 2 }],
      }),
    });
    assert.equal(conflictRes.status, 409);
    const conflictBody = (await conflictRes.json()) as { code?: string };
    assert.equal(conflictBody.code, 'IDEMPOTENCY_CONFLICT');

    // 2. Authorized-but-uncaptured payment stays pending (202 PAYMENT_PENDING_CAPTURE) and does NOT deduct stock
    forcePendingCapture = true;
    const pay1 = 'pay_rec_1';
    const sig1 = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(`${body1.order_id}|${pay1}`)
      .digest('hex');

    const pendingCapRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_user_1' },
      body: JSON.stringify({
        razorpay_order_id: body1.order_id,
        razorpay_payment_id: pay1,
        razorpay_signature: sig1,
        checkout_token: body1.checkout_token,
      }),
    });
    assert.equal(pendingCapRes.status, 202);
    const pendingCapBody = (await pendingCapRes.json()) as {
      code?: string;
      paid?: boolean;
      pending_confirmation?: boolean;
    };
    assert.equal(pendingCapBody.code, 'PAYMENT_PENDING_CAPTURE');
    assert.equal(pendingCapBody.paid, false);
    assert.equal(pendingCapBody.pending_confirmation, true);
    const afterPendingProd = await store.getPublicProductByIdOrSlug(productEntry.product.id);
    assert.equal(
      afterPendingProd?.variants[0]?.stock_qty,
      initialStock,
      'Uncaptured payment must never decrement stock'
    );

    // 3. Transient 504 during Razorpay payments.fetch retries safely and confirms order when captured
    forcePendingCapture = false;
    forceTransientFetchErrorCount = 1;
    const beforeFetchAttempts = paymentFetchAttempt;
    const verifyOkRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_user_1' },
      body: JSON.stringify({
        razorpay_order_id: body1.order_id,
        razorpay_payment_id: pay1,
        razorpay_signature: sig1,
        checkout_token: body1.checkout_token,
      }),
    });
    assert.equal(verifyOkRes.status, 200);
    const verifyOkBody = (await verifyOkRes.json()) as {
      success?: boolean;
      internal_order_ref?: string;
      order?: { orderNumber?: string; paymentStatus?: string; status?: string };
    };
    assert.equal(verifyOkBody.success, true);
    assert.equal(verifyOkBody.internal_order_ref, 'ord_rzp_order_rec_1');
    assert.equal(verifyOkBody.order?.paymentStatus, 'paid');
    assert.equal(verifyOkBody.order?.status, 'confirmed');
    assert.ok(paymentFetchAttempt >= beforeFetchAttempts + 2, 'Transient 504 read should have retried');

    // Same idempotencyKey after confirmation rejects duplicate creation
    const postConfirmRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_user_1' },
      body: JSON.stringify(payload),
    });
    assert.equal(postConfirmRes.status, 409);
    assert.equal(((await postConfirmRes.json()) as { code?: string }).code, 'ORDER_ALREADY_CONFIRMED');

    // 4. Out-of-order payment.failed webhook AFTER confirmation MUST NOT downgrade the paid order
    const outOfOrderFailedBody = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: pay1,
            order_id: body1.order_id,
            error_description: 'Delayed failure notification',
          },
        },
      },
    });
    const outOfOrderSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
      .update(outOfOrderFailedBody)
      .digest('hex');
    const outOfOrderRes = await fetch(`${baseUrl}/api/razorpay-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': outOfOrderSig,
        'x-razorpay-event-id': 'evt_out_of_order_1',
      },
      body: outOfOrderFailedBody,
    });
    assert.equal(outOfOrderRes.status, 200);
    const outOfOrderJson = (await outOfOrderRes.json()) as {
      ignored_out_of_order?: boolean;
      already_processed?: boolean;
    };
    assert.equal(outOfOrderJson.ignored_out_of_order, true);
    assert.equal(outOfOrderJson.already_processed, true);
    const storedPaidOrder = await store.getOrderById('ord_rzp_order_rec_1');
    assert.equal(storedPaidOrder?.order.payment_status, 'paid');
    assert.equal(storedPaidOrder?.order.status, 'confirmed');

    // 5. Fresh order that receives payment.failed webhook + duplicate X-Razorpay-Event-Id dedupe
    const resFresh = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_user_1' },
      body: JSON.stringify({ ...payload, idempotencyKey: 'rzp_attempt_fail_002' }),
    });
    assert.equal(resFresh.status, 200);
    const freshOrderBody = (await resFresh.json()) as { order_id: string };
    assert.equal(freshOrderBody.order_id, 'order_rec_2');

    const failWebhookPayload = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_failed_2',
            order_id: freshOrderBody.order_id,
            error_description: 'Bank declined transaction',
          },
        },
      },
    });
    const failSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
      .update(failWebhookPayload)
      .digest('hex');

    const failRes1 = await fetch(`${baseUrl}/api/razorpay-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': failSig,
        'x-razorpay-event-id': 'evt_failed_unique_2',
      },
      body: failWebhookPayload,
    });
    assert.equal(failRes1.status, 200);
    const failJson1 = (await failRes1.json()) as { handled?: boolean; status?: string };
    assert.equal(failJson1.handled, true);
    assert.equal(failJson1.status, 'failed');

    // Replay same X-Razorpay-Event-Id -> deduplicated cleanly
    const failResReplay = await fetch(`${baseUrl}/api/razorpay-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': failSig,
        'x-razorpay-event-id': 'evt_failed_unique_2',
      },
      body: failWebhookPayload,
    });
    assert.equal(failResReplay.status, 200);
    const failJsonReplay = (await failResReplay.json()) as { duplicate_event?: boolean };
    assert.equal(failJsonReplay.duplicate_event, true);

    // /api/order-status reports failed so frontend lets user retry cleanly
    const failedStatusRes = await fetch(`${baseUrl}/api/order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_user_1' },
      body: JSON.stringify({ razorpay_order_id: freshOrderBody.order_id }),
    });
    assert.equal(failedStatusRes.status, 200);
    const failedStatusJson = (await failedStatusRes.json()) as {
      confirmed?: boolean;
      failed?: boolean;
      status?: string;
      failure_reason?: string;
    };
    assert.equal(failedStatusJson.confirmed, false);
    assert.equal(failedStatusJson.failed, true);
    assert.equal(failedStatusJson.status, 'failed');
    assert.equal(failedStatusJson.failure_reason, 'Bank declined transaction');
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    if (prevWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRazorpayCheckoutCachesForTest();
  }
});

test('Client createRazorpayOrder handles non-JSON gateway HTML error responses without crashing', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html', 'x-request-id': 'req_html_502' },
    })) as typeof fetch;

  try {
    const res = await createRazorpayOrder({
      items: [{ productId: 'sc-001', variantId: 'sc-001-var-1', quantity: 1 }],
      idempotencyKey: 'rzp_html_fallback_1',
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.status, 502);
      assert.equal(res.supportReference, 'req_html_502');
      assert.match(res.error, /HTTP 502/);
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
});
