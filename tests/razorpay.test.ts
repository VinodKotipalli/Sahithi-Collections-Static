import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCreateOrderHandler } from '../api/create-order.ts';
import { createVerifyPaymentHandler } from '../api/verify-payment.ts';
import { createAuthApp } from '../server/app.ts';
import {
  clearRazorpayCheckoutCachesForTest,
  type RazorpayClientFactory,
  type RazorpayClientLike,
  type RazorpayPaymentEntity,
} from '../server/razorpay-checkout.ts';

interface MockRazorpayState {
  createdOrders: Array<{ amount: number; currency: string; receipt: string }>;
  capturedPayments: Array<{ paymentId: string; amount: number; currency: string }>;
  nextPaymentOverrides: Partial<RazorpayPaymentEntity>;
}

function createMockRazorpayFactory(state: MockRazorpayState): RazorpayClientFactory {
  return (): RazorpayClientLike => ({
    orders: {
      async create(params) {
        state.createdOrders.push({
          amount: params.amount,
          currency: params.currency,
          receipt: params.receipt,
        });
        const id = `order_mock_${state.createdOrders.length}`;
        return {
          id,
          amount: params.amount,
          currency: params.currency,
          receipt: params.receipt,
          status: 'created',
        };
      },
      async fetch(orderId) {
        const idxMatch = /^order_mock_(\d+)$/.exec(orderId);
        const created = idxMatch
          ? state.createdOrders[Number(idxMatch[1]) - 1]
          : state.createdOrders[state.createdOrders.length - 1];
        return {
          id: orderId,
          amount: created?.amount ?? 74900,
          currency: created?.currency ?? 'INR',
          receipt: created?.receipt ?? 'rcpt_mock',
          status: 'paid',
        };
      },
    },
    payments: {
      async fetch(paymentId) {
        const latestOrder = state.createdOrders[state.createdOrders.length - 1];
        return {
          id: paymentId,
          order_id:
            state.nextPaymentOverrides.order_id !== undefined
              ? state.nextPaymentOverrides.order_id
              : `order_mock_${Math.max(1, state.createdOrders.length)}`,
          amount:
            state.nextPaymentOverrides.amount !== undefined
              ? state.nextPaymentOverrides.amount
              : (latestOrder?.amount ?? 74900),
          currency:
            state.nextPaymentOverrides.currency !== undefined
              ? state.nextPaymentOverrides.currency
              : 'INR',
          status:
            state.nextPaymentOverrides.status !== undefined
              ? state.nextPaymentOverrides.status
              : 'captured',
          captured:
            state.nextPaymentOverrides.captured !== undefined
              ? state.nextPaymentOverrides.captured
              : true,
        };
      },
      async capture(paymentId, amount, currency) {
        state.capturedPayments.push({ paymentId, amount, currency });
        return {
          id: paymentId,
          order_id: `order_mock_${Math.max(1, state.createdOrders.length)}`,
          amount,
          currency,
          status: 'captured',
          captured: true,
        };
      },
    },
  });
}

test('Razorpay Standard Checkout endpoints: server cart calculation, key_id return, HMAC + API verification, and idempotent order creation', async () => {
  clearRazorpayCheckoutCachesForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-razorpay-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;

  const mockState: MockRazorpayState = {
    createdOrders: [],
    capturedPayments: [],
    nextPaymentOverrides: {},
  };

  const { app, store } = createAuthApp({
    dbPath,
    disableRateLimit: true,
    seedCatalog: true,
    razorpayClientFactory: createMockRazorpayFactory(mockState),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Missing credentials -> 401
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const noAuthRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 69900, currency: 'INR', receipt: 'rcpt_1' }),
    });
    assert.equal(noAuthRes.status, 401);

    // 2. Configure test credentials and validate low amount -> 400
    process.env.RAZORPAY_KEY_ID = 'rzp_test_U17MiWPrvpas0b';
    process.env.RAZORPAY_KEY_SECRET = 'Oroq81QnfslWBN9z3bsXYOf5';

    const lowAmountRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 50, currency: 'INR', receipt: 'rcpt_low' }),
    });
    assert.equal(lowAmountRes.status, 400);
    const lowAmountBody = (await lowAmountRes.json()) as { code?: string };
    assert.equal(lowAmountBody.code, 'INVALID_AMOUNT');

    // 3. Create order with cart item sc-103 (₹749 = 74900 paise) — ignores tampered client amount
    const kurti = await store.getPublicProductByIdOrSlug('sc-103');
    assert.ok(kurti, 'Expected seeded sc-103 product');
    const firstVariantId = kurti.variants[0]?.id || 'sc-103';

    const createRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 100, // tampered client amount must be ignored when items are provided
        currency: 'INR',
        receipt: 'sc_rcpt_test_1',
        items: [{ productId: 'sc-103', variantId: firstVariantId, quantity: 1 }],
        customer: {
          customerName: 'Ananya Reddy',
          customerEmail: 'ananya@example.com',
          customerPhone: '+91 98765 43210',
          shippingAddress: '12 Jubilee Hills, Hyderabad 500033',
        },
      }),
    });
    assert.equal(createRes.status, 200);
    const createBody = (await createRes.json()) as {
      order_id?: string;
      amount?: number;
      currency?: string;
      key_id?: string;
      checkout_token?: string;
      key_secret?: string;
    };
    assert.equal(createBody.order_id, 'order_mock_1');
    assert.equal(createBody.amount, 74900);
    assert.equal(createBody.currency, 'INR');
    assert.equal(createBody.key_id, 'rzp_test_U17MiWPrvpas0b');
    assert.equal(createBody.key_secret, undefined);
    assert.ok(createBody.checkout_token);

    // 4. Verify payment: missing fields -> 400
    const missingFieldsRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ razorpay_order_id: 'order_mock_1' }),
    });
    assert.equal(missingFieldsRes.status, 400);
    const missingFieldsBody = (await missingFieldsRes.json()) as {
      success?: boolean;
      code?: string;
    };
    assert.equal(missingFieldsBody.success, false);
    assert.equal(missingFieldsBody.code, 'MISSING_FIELDS');

    // 5. Order ID mismatch against checkout_token -> 400 ORDER_MISMATCH
    const mismatchSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update('order_wrong_999|pay_test_1')
      .digest('hex');
    const mismatchRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_wrong_999',
        razorpay_payment_id: 'pay_test_1',
        razorpay_signature: mismatchSig,
        checkout_token: createBody.checkout_token,
      }),
    });
    assert.equal(mismatchRes.status, 400);
    const mismatchBody = (await mismatchRes.json()) as { code?: string };
    assert.equal(mismatchBody.code, 'ORDER_MISMATCH');

    // 6. Invalid HMAC signature -> 400 INVALID_SIGNATURE
    const invalidSigRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_mock_1',
        razorpay_payment_id: 'pay_test456',
        razorpay_signature: '0000000000000000000000000000000000000000000000000000000000000000',
        checkout_token: createBody.checkout_token,
      }),
    });
    assert.equal(invalidSigRes.status, 400);
    const invalidSigBody = (await invalidSigRes.json()) as {
      success?: boolean;
      verified?: boolean;
      code?: string;
    };
    assert.equal(invalidSigBody.success, false);
    assert.equal(invalidSigBody.verified, false);
    assert.equal(invalidSigBody.code, 'INVALID_SIGNATURE');

    // 7. Payment amount mismatch on Razorpay server -> 400 AMOUNT_MISMATCH
    const paymentId1 = 'pay_mock_valid_1';
    const validSignature1 = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`order_mock_1|${paymentId1}`)
      .digest('hex');

    mockState.nextPaymentOverrides = { order_id: 'order_mock_1', amount: 100 };
    const wrongAmtRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_mock_1',
        razorpay_payment_id: paymentId1,
        razorpay_signature: validSignature1,
        checkout_token: createBody.checkout_token,
      }),
    });
    assert.equal(wrongAmtRes.status, 400);
    const wrongAmtBody = (await wrongAmtRes.json()) as { code?: string };
    assert.equal(wrongAmtBody.code, 'AMOUNT_MISMATCH');

    // 8. Uncaptured / failed payment on Razorpay server -> 400 PAYMENT_NOT_CAPTURED
    mockState.nextPaymentOverrides = {
      order_id: 'order_mock_1',
      amount: 74900,
      status: 'failed',
      captured: false,
    };
    const failedPayRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_mock_1',
        razorpay_payment_id: paymentId1,
        razorpay_signature: validSignature1,
        checkout_token: createBody.checkout_token,
      }),
    });
    assert.equal(failedPayRes.status, 400);
    const failedPayBody = (await failedPayRes.json()) as { code?: string };
    assert.equal(failedPayBody.code, 'PAYMENT_NOT_CAPTURED');

    // 9. Valid signature + captured payment -> 200 and records order ONCE
    mockState.nextPaymentOverrides = {
      order_id: 'order_mock_1',
      amount: 74900,
      currency: 'INR',
      status: 'captured',
      captured: true,
    };

    const verifyPayload = {
      razorpay_order_id: 'order_mock_1',
      razorpay_payment_id: paymentId1,
      razorpay_signature: validSignature1,
      checkout_token: createBody.checkout_token,
      orderData: {
        customerName: 'Ananya Reddy',
        customerEmail: 'ananya@example.com',
        customerPhone: '+91 98765 43210',
        shippingAddress: '12 Jubilee Hills, Hyderabad 500033',
        items: [
          {
            productId: 'sc-103',
            variantId: firstVariantId,
            quantity: 1,
            expectedPricePaise: 74900,
          },
        ],
      },
    };

    const validSigRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyPayload),
    });
    assert.equal(validSigRes.status, 200);
    const validSigBody = (await validSigRes.json()) as {
      success?: boolean;
      verified?: boolean;
      order_id?: string;
      payment_id?: string;
      order?: { id?: string; status?: string; totalPaise?: number };
    };
    assert.equal(validSigBody.success, true);
    assert.equal(validSigBody.verified, true);
    assert.equal(validSigBody.order_id, 'order_mock_1');
    assert.equal(validSigBody.payment_id, paymentId1);
    assert.equal(validSigBody.order?.status, 'confirmed');
    assert.equal(validSigBody.order?.totalPaise, 74900);

    // Duplicate verify call -> returns same order idempotently without creating a second order
    const duplicateRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyPayload),
    });
    assert.equal(duplicateRes.status, 200);
    const duplicateBody = (await duplicateRes.json()) as {
      already_processed?: boolean;
      order?: { id?: string };
    };
    assert.equal(duplicateBody.already_processed, true);
    assert.equal(duplicateBody.order?.id, validSigBody.order?.id);

    const allOrders = await store.listAdminOrders(1, 20);
    assert.equal(allOrders.total, 1, 'Order must be persisted exactly once');
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRazorpayCheckoutCachesForTest();
  }
});

test('Vercel Node.js Serverless Functions (/api/create-order.ts & /api/verify-payment.ts) handle cart pricing & authorized capture', async () => {
  clearRazorpayCheckoutCachesForTest();
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;

  process.env.RAZORPAY_KEY_ID = 'rzp_test_U17MiWPrvpas0b';
  process.env.RAZORPAY_KEY_SECRET = 'Oroq81QnfslWBN9z3bsXYOf5';

  const mockState: MockRazorpayState = {
    createdOrders: [],
    capturedPayments: [],
    nextPaymentOverrides: {
      status: 'authorized',
      captured: false,
    },
  };

  const factory = createMockRazorpayFactory(mockState);
  const createHandler = createCreateOrderHandler({ razorpayClientFactory: factory });
  const verifyHandler = createVerifyPaymentHandler({ razorpayClientFactory: factory });

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/create-order')) {
      void createHandler(req, res);
      return;
    }
    if (req.url?.startsWith('/api/verify-payment')) {
      void verifyHandler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Method guard
    const getRes = await fetch(`${baseUrl}/api/create-order`);
    assert.equal(getRes.status, 405);

    // Server-side catalog calculation for Straight-Cut Printed Kurti (sc-103: ₹749 * 2 = 149800 paise)
    const createRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ productId: 'sc-103', variantId: 'sc-103-var-1', quantity: 2 }],
        currency: 'INR',
      }),
    });
    assert.equal(createRes.status, 200);
    const createBody = (await createRes.json()) as {
      order_id: string;
      amount: number;
      currency: string;
      key_id: string;
      checkout_token: string;
    };
    assert.equal(createBody.order_id, 'order_mock_1');
    assert.equal(createBody.amount, 149800);
    assert.equal(createBody.currency, 'INR');
    assert.equal(createBody.key_id, 'rzp_test_U17MiWPrvpas0b');

    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${createBody.order_id}|pay_auth_123`)
      .digest('hex');

    const verifyRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: createBody.order_id,
        razorpay_payment_id: 'pay_auth_123',
        razorpay_signature: sig,
        checkout_token: createBody.checkout_token,
      }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = (await verifyRes.json()) as { success?: boolean; verified?: boolean };
    assert.equal(verifyBody.success, true);
    assert.equal(verifyBody.verified, true);
    assert.equal(mockState.capturedPayments.length, 1);
    assert.equal(mockState.capturedPayments[0]?.amount, 149800);
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearRazorpayCheckoutCachesForTest();
  }
});

test('Razorpay credential sanitization strips quotes/newlines, rejects malformed keys, and reports actionable masked 401 errors', async () => {
  clearRazorpayCheckoutCachesForTest();
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;

  try {
    // 1. Quoted & newline-padded credentials are sanitized cleanly before SDK usage
    let capturedKeyId = '';
    let capturedKeySecret = '';
    const captureHandler = createCreateOrderHandler({
      razorpayClientFactory: (keyId, keySecret) => {
        capturedKeyId = keyId;
        capturedKeySecret = keySecret;
        return {
          orders: {
            async create(params) {
              return { id: 'order_clean_1', amount: params.amount, currency: params.currency };
            },
            async fetch() {
              return { id: 'order_clean_1', amount: 74900, currency: 'INR' };
            },
          },
          payments: {
            async fetch() {
              return { id: 'pay_1', amount: 74900, currency: 'INR', status: 'captured', captured: true };
            },
            async capture() {
              return { id: 'pay_1', amount: 74900, currency: 'INR', status: 'captured', captured: true };
            },
          },
        };
      },
    });

    const srv = http.createServer((req, res) => {
      void captureHandler(req, res);
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const { port } = srv.address() as { port: number };
    const url = `http://127.0.0.1:${port}/api/create-order`;

    try {
      process.env.RAZORPAY_KEY_ID = '  "rzp_test_CleanKey1234" \n';
      process.env.RAZORPAY_KEY_SECRET = " 'SecretClean999'\r\n";

      const cleanRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: 'sc-103', variantId: 'sc-103-var-1', quantity: 1 }] }),
      });
      assert.equal(cleanRes.status, 200);
      assert.equal(capturedKeyId, 'rzp_test_CleanKey1234');
      assert.equal(capturedKeySecret, 'SecretClean999');

      // 1b. Literal backslash-newline, zero-width space, and accidental KEY= prefix are stripped cleanly
      process.env.RAZORPAY_KEY_ID = 'RAZORPAY_KEY_ID=rzp_live_PrefixedKey88\\n';
      process.env.RAZORPAY_KEY_SECRET = '\u200BRAZORPAY_KEY_SECRET="PrefixedSecret77"\\r\\n';
      const prefixedRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: 'sc-103', variantId: 'sc-103-var-1', quantity: 1 }] }),
      });
      assert.equal(prefixedRes.status, 200);
      assert.equal(capturedKeyId, 'rzp_live_PrefixedKey88');
      assert.equal(capturedKeySecret, 'PrefixedSecret77');

      // 2. Malformed key ID returns 401 RAZORPAY_AUTH_FAILED
      process.env.RAZORPAY_KEY_ID = 'invalid_key_prefix';
      process.env.RAZORPAY_KEY_SECRET = 'SecretClean999';
      const badFormatRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: 'sc-103', variantId: 'sc-103-var-1', quantity: 1 }] }),
      });
      assert.equal(badFormatRes.status, 401);
      const badFormatBody = (await badFormatRes.json()) as { code?: string; error?: string };
      assert.equal(badFormatBody.code, 'RAZORPAY_AUTH_FAILED');
      assert.match(badFormatBody.error || '', /RAZORPAY_KEY_ID/);

      // 2b. Key ID accidentally pasted into RAZORPAY_KEY_SECRET returns clear 401 guidance
      process.env.RAZORPAY_KEY_ID = 'rzp_live_SampleLiveKey1';
      process.env.RAZORPAY_KEY_SECRET = 'rzp_live_SampleLiveKey1';
      const swappedRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: 'sc-103', variantId: 'sc-103-var-1', quantity: 1 }] }),
      });
      assert.equal(swappedRes.status, 401);
      const swappedBody = (await swappedRes.json()) as { code?: string; error?: string };
      assert.equal(swappedBody.code, 'RAZORPAY_AUTH_FAILED');
      assert.match(swappedBody.error || '', /RAZORPAY_KEY_SECRET/);

      // 2c. Masked asterisks copied from Razorpay Dashboard return actionable 401 guidance
      process.env.RAZORPAY_KEY_ID = 'rzp_live_SampleLiveKey1';
      process.env.RAZORPAY_KEY_SECRET = '*************************';
      const maskedRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: 'sc-103', variantId: 'sc-103-var-1', quantity: 1 }] }),
      });
      assert.equal(maskedRes.status, 401);
      const maskedBody = (await maskedRes.json()) as { code?: string; error?: string };
      assert.equal(maskedBody.code, 'RAZORPAY_AUTH_FAILED');
      assert.match(maskedBody.error || '', /Regenerate Key/i);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    // 3. Upstream 401 returns masked keyPrefix diagnostic and never leaks secret
    const authFailHandler = createCreateOrderHandler({
      razorpayClientFactory: () => ({
        orders: {
          async create() {
            throw { statusCode: 401, error: { description: 'Authentication failed' } };
          },
          async fetch() {
            return { id: 'o', amount: 100 };
          },
        },
        payments: {
          async fetch() {
            return { id: 'p', amount: 100 };
          },
          async capture() {
            return { id: 'p', amount: 100 };
          },
        },
      }),
    });
    const srv2 = http.createServer((req, res) => {
      void authFailHandler(req, res);
    });
    await new Promise<void>((resolve) => srv2.listen(0, '127.0.0.1', () => resolve()));
    const { port: port2 } = srv2.address() as { port: number };
    try {
      process.env.RAZORPAY_KEY_ID = 'rzp_test_SampleKey9876';
      process.env.RAZORPAY_KEY_SECRET = 'SuperSecretNeverExpose';
      const failRes = await fetch(`http://127.0.0.1:${port2}/api/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: 'sc-103', variantId: 'sc-103-var-1', quantity: 1 }] }),
      });
      assert.equal(failRes.status, 401);
      const failBody = (await failRes.json()) as {
        code?: string;
        keyMode?: string;
        keyPrefix?: string;
        error?: string;
      };
      assert.equal(failBody.code, 'RAZORPAY_AUTH_FAILED');
      assert.equal(failBody.keyMode, 'test');
      assert.equal(failBody.keyPrefix, 'rzp_test_Sam…9876');
      assert.equal((failBody.error || '').includes('SuperSecretNeverExpose'), false);
    } finally {
      await new Promise<void>((resolve) => srv2.close(() => resolve()));
    }
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    clearRazorpayCheckoutCachesForTest();
  }
});

