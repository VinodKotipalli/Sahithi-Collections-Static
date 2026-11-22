import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthApp } from '../server/app.ts';
import { bindOwnerAccount } from '../server/db.ts';
import type { EmailMessage } from '../server/providers.ts';
import {
  clearRazorpayCheckoutCachesForTest,
  handleOrderStatusRequest,
  handleRazorpayWebhookRequest,
  handleVerifyPaymentRequest,
} from '../server/razorpay-checkout.ts';
import { runSqliteCancellationRepair } from '../server/repair-cancelled-orders.ts';
import { normalizeOrderRequestsAndStatus } from '../server/order-utils.ts';
import {
  clearClientFirebaseSession,
  handleClientlessApiRequest,
  serializeClientOrderDoc,
} from '../src/services/firebaseClientApi.ts';

class CookieJar {
  private cookies = new Map<string, string>();

  updateFromResponse(res: Response) {
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (!val) this.cookies.delete(name);
      else this.cookies.set(name, val);
    }
  }

  getHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

function extractToken(htmlOrText: string): string {
  const match = htmlOrText.match(/[?&]token=([^"&\s<]+)/);
  assert.ok(match, 'Expected verification token');
  return decodeURIComponent(match[1]);
}

async function jsonReq<T = Record<string, unknown>>(
  baseUrl: string,
  jar: CookieJar,
  method: string,
  reqPath: string,
  body: unknown,
  csrfToken: string
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    'X-CSRF-Token': csrfToken,
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }
  const cookieHeader = jar.getHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;
  const res = await fetch(`${baseUrl}${reqPath}`, {
    method,
    headers,
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  jar.updateFromResponse(res);
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

async function getSession(baseUrl: string, jar: CookieJar) {
  const res = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jar.getHeader() ? { Cookie: jar.getHeader() } : undefined,
  });
  jar.updateFromResponse(res);
  return (await res.json()) as {
    csrfToken: string;
    authenticated: boolean;
    user: { id: string; email: string } | null;
  };
}

async function registerVerifyAndLogin(params: {
  baseUrl: string;
  email: string;
  fullName: string;
  password: string;
  sentEmails: EmailMessage[];
}) {
  const { baseUrl, email, fullName, password, sentEmails } = params;
  const jar = new CookieJar();
  let session = await getSession(baseUrl, jar);

  const reg = await jsonReq(
    baseUrl,
    jar,
    'POST',
    '/api/auth/register',
    { fullName, email, password, confirmPassword: password },
    session.csrfToken
  );
  assert.equal(reg.status, 200);

  const emailMsg = [...sentEmails]
    .reverse()
    .find((m) => m.to.toLowerCase() === email.toLowerCase());
  assert.ok(emailMsg);
  const token = extractToken(emailMsg.html + '\n' + emailMsg.text);

  const ver = await jsonReq(
    baseUrl,
    jar,
    'POST',
    '/api/auth/verify-email',
    { token },
    session.csrfToken
  );
  assert.equal(ver.status, 200);

  session = await getSession(baseUrl, jar);
  if (!session.authenticated) {
    const login = await jsonReq(
      baseUrl,
      jar,
      'POST',
      '/api/auth/login',
      { email, password },
      session.csrfToken
    );
    assert.equal(login.status, 200);
    session = await getSession(baseUrl, jar);
  }
  assert.equal(session.authenticated, true);
  return { jar, csrfToken: session.csrfToken, userId: session.user!.id };
}

test('End-to-end order cancellation synchronization, variant stock restoration, admin filters/counts, concurrency locks, and refund workflow', async () => {
  clearRazorpayCheckoutCachesForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-cancel-sync-'));
  const dbPath = path.join(tmpDir, 'boutique.db');
  const sentEmails: EmailMessage[] = [];

  const appInstance = createAuthApp({
    dbPath,
    emailSender: {
      isConfigured: () => true,
      sendEmail: async (msg) => {
        sentEmails.push(msg);
      },
    },
    disableRateLimit: true,
    appBaseUrl: 'http://127.0.0.1:3000',
    seedCatalog: true,
  });

  const server = http.createServer(appInstance.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Setup owner, customer A, and customer B
    const owner = await registerVerifyAndLogin({
      baseUrl,
      email: 'owner.cancel@sahithidesigns.online',
      fullName: 'Sahithi Owner',
      password: 'OwnerCancel!2026',
      sentEmails,
    });
    bindOwnerAccount(appInstance.db!, {
      email: 'owner.cancel@sahithidesigns.online',
      boundVia: 'cli_setup',
    });
    const ownerLogin = await jsonReq(
      baseUrl,
      owner.jar,
      'POST',
      '/api/admin/login',
      { email: 'owner.cancel@sahithidesigns.online', password: 'OwnerCancel!2026' },
      owner.csrfToken
    );
    assert.equal(ownerLogin.status, 200);
    const ownerCsrf = (await getSession(baseUrl, owner.jar)).csrfToken;

    const custA = await registerVerifyAndLogin({
      baseUrl,
      email: 'divya.cancel@example.com',
      fullName: 'Divya Reddy',
      password: 'CustomerCancel!123',
      sentEmails,
    });

    const custB = await registerVerifyAndLogin({
      baseUrl,
      email: 'sneha.cancel@example.com',
      fullName: 'Sneha Nair',
      password: 'CustomerCancel!456',
      sentEmails,
    });

    // Pick a seeded product with at least 1 variant having >= 4 stock
    const catalogJson = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
      items: Array<{
        id: string;
        variants: Array<{ id: string; stockQty: number; colorName?: string; size?: string }>;
      }>;
    };
    const targetProduct = catalogJson.items.find((p) => (p.variants?.[0]?.stockQty ?? 0) >= 4);
    assert.ok(targetProduct, 'Expected seeded product with >= 4 stock');
    const targetVariant = targetProduct.variants[0];
    const startStock = targetVariant.stockQty;

    // 1. Customer A places COD order (qty 2) -> stock decreases by 2
    const codRes = await jsonReq<{
      order: { id: string; orderNumber: string; status: string; updatedAt: number };
    }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/orders',
      {
        paymentMethod: 'cod',
        idempotencyKey: 'cancel_sync_cod_1',
        customerName: 'Divya Reddy',
        customerEmail: 'divya.cancel@example.com',
        customerPhone: '9876500001',
        shippingAddress: '12 Jubilee Hills, Hyderabad',
        items: [{ productId: targetProduct.id, variantId: targetVariant.id, quantity: 2 }],
      },
      custA.csrfToken
    );
    assert.equal(codRes.status, 201);
    const codOrderId = codRes.data.order.id;
    const codInitialUpdatedAt = codRes.data.order.updatedAt;

    const getVariantStock = async () => {
      const cat = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
        items: Array<{ id: string; variants: Array<{ id: string; stockQty: number }> }>;
      };
      return cat.items
        .find((p) => p.id === targetProduct.id)
        ?.variants.find((v) => v.id === targetVariant.id)?.stockQty;
    };
    assert.equal(await getVariantStock(), startStock - 2);

    // Verify unauthorized cancellation attempts (unauthenticated -> 401, wrong customer -> 403)
    const anonJar = new CookieJar();
    const anonSess = await getSession(baseUrl, anonJar);
    const unauthCancel = await jsonReq(
      baseUrl,
      anonJar,
      'POST',
      `/api/account/orders/${encodeURIComponent(codOrderId)}/cancel`,
      { reason: 'Unauthenticated attempt' },
      anonSess.csrfToken
    );
    assert.equal(unauthCancel.status, 401);

    const wrongCustCancel = await jsonReq(
      baseUrl,
      custB.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(codOrderId)}/cancel`,
      { reason: 'Not my order' },
      custB.csrfToken
    );
    assert.equal(wrongCustCancel.status, 403);

    // 2. Customer A cancels COD order -> persisted cancelled, stock restored once, COD payment stays unpaid & refund not_required
    const cancelCod = await jsonReq<{
      order: {
        id: string;
        status: string;
        fulfillmentStatus: string;
        paymentStatus: string;
        refundStatus: string;
        cancelledAt: number | null;
        cancelledBy: string | null;
        cancelReason: string | null;
        stockRestoredAt: number | null;
        statusHistory: Array<{ status: string; actor: string }>;
      };
    }>(
      baseUrl,
      custA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(codOrderId)}/cancel`,
      { reason: 'Changed my mind', expectedUpdatedAt: codInitialUpdatedAt },
      custA.csrfToken
    );
    assert.equal(cancelCod.status, 200);
    assert.equal(cancelCod.data.order.status, 'cancelled');
    assert.equal(cancelCod.data.order.fulfillmentStatus, 'cancelled');
    assert.equal(cancelCod.data.order.paymentStatus, 'unpaid');
    assert.equal(cancelCod.data.order.refundStatus, 'not_required');
    assert.equal(cancelCod.data.order.cancelledBy, 'customer');
    assert.equal(cancelCod.data.order.cancelReason, 'Changed my mind');
    assert.ok(cancelCod.data.order.cancelledAt && cancelCod.data.order.cancelledAt > 0);
    assert.ok(cancelCod.data.order.stockRestoredAt && cancelCod.data.order.stockRestoredAt > 0);
    assert.equal(await getVariantStock(), startStock);

    // 3. Repeated cancellation is idempotent and does NOT double-restore stock
    const repeatCodCancel = await jsonReq<{
      alreadyCancelled?: boolean;
      order: { status: string; cancelledAt: number | null };
    }>(
      baseUrl,
      custA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(codOrderId)}/cancel`,
      { reason: 'Duplicate click' },
      custA.csrfToken
    );
    assert.equal(repeatCodCancel.status, 200);
    assert.equal(repeatCodCancel.data.alreadyCancelled, true);
    assert.equal(repeatCodCancel.data.order.status, 'cancelled');
    assert.equal(repeatCodCancel.data.order.cancelledAt, cancelCod.data.order.cancelledAt);
    assert.equal(await getVariantStock(), startStock);

    // 4. Stale admin status update using pre-cancel expectedUpdatedAt fails with 409 & cannot overwrite cancellation
    const staleAdminUpdate = await jsonReq<{ code?: string }>(
      baseUrl,
      owner.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(codOrderId)}/status`,
      { status: 'confirmed', expectedUpdatedAt: codInitialUpdatedAt },
      ownerCsrf
    );
    assert.equal(staleAdminUpdate.status, 409);

    // Even with fresh timestamp, admin cannot move a cancelled order back to pending/confirmed
    const reopenCancelled = await jsonReq<{ code?: string }>(
      baseUrl,
      owner.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(codOrderId)}/status`,
      { status: 'pending' },
      ownerCsrf
    );
    assert.equal(reopenCancelled.status, 409);
    assert.equal(reopenCancelled.data.code, 'INVALID_STATUS_TRANSITION');

    // 5. Prepaid paid order cancellation -> refundStatus = 'pending_refund' (NOT 'refunded'), excluded from revenue, stock restored once
    const paidOrderRes = await jsonReq<{
      order: { id: string; totalPaise: number; updatedAt: number };
    }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/orders',
      {
        paymentMethod: 'cod',
        idempotencyKey: 'cancel_sync_prepaid_sim_1',
        customerName: 'Divya Reddy',
        customerEmail: 'divya.cancel@example.com',
        customerPhone: '9876500001',
        shippingAddress: '12 Jubilee Hills, Hyderabad',
        items: [{ productId: targetProduct.id, variantId: targetVariant.id, quantity: 1 }],
      },
      custA.csrfToken
    );
    assert.equal(paidOrderRes.status, 201);
    const paidOrderId = paidOrderRes.data.order.id;
    // Mark as prepaid paid Razorpay order directly in DB (no live Razorpay charge)
    appInstance.db!
      .prepare(
        `UPDATE orders SET payment_method = 'razorpay', payment_status = 'paid', status = 'confirmed', fulfillment_status = 'confirmed', razorpay_order_id = 'order_test_paid_1', razorpay_payment_id = 'pay_test_paid_1' WHERE id = ?`
      )
      .run(paidOrderId);

    const cancelPaid = await jsonReq<{
      order: {
        status: string;
        paymentStatus: string;
        refundStatus: string;
        stockRestoredAt: number | null;
      };
    }>(
      baseUrl,
      custA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(paidOrderId)}/cancel`,
      { reason: 'Ordered wrong color' },
      custA.csrfToken
    );
    assert.equal(cancelPaid.status, 200);
    assert.equal(cancelPaid.data.order.status, 'cancelled');
    assert.equal(cancelPaid.data.order.paymentStatus, 'paid');
    assert.equal(
      cancelPaid.data.order.refundStatus,
      'pending_refund',
      'Prepaid cancelled order must be pending_refund, never auto-marked refunded'
    );
    assert.ok(cancelPaid.data.order.stockRestoredAt);
    assert.equal(await getVariantStock(), startStock);

    // Admin can explicitly confirm refund progression while keeping status === 'cancelled'
    const markRefunded = await jsonReq<{
      order: { status: string; refundStatus: string };
    }>(
      baseUrl,
      owner.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(paidOrderId)}/status`,
      { status: 'cancelled', refundStatus: 'refunded', note: 'Refund settled via Razorpay dashboard' },
      ownerCsrf
    );
    assert.equal(markRefunded.status, 200);
    assert.equal(markRefunded.data.order.status, 'cancelled');
    assert.equal(markRefunded.data.order.refundStatus, 'refunded');

    // 6. Shipped order cannot be cancelled by customer (409 CANCELLATION_CUTOFF_PASSED)
    const shippedOrderRes = await jsonReq<{ order: { id: string } }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/orders',
      {
        paymentMethod: 'cod',
        idempotencyKey: 'cancel_sync_shipped_1',
        customerName: 'Divya Reddy',
        customerEmail: 'divya.cancel@example.com',
        customerPhone: '9876500001',
        shippingAddress: '12 Jubilee Hills, Hyderabad',
        items: [{ productId: targetProduct.id, variantId: targetVariant.id, quantity: 1 }],
      },
      custA.csrfToken
    );
    assert.equal(shippedOrderRes.status, 201);
    const shippedOrderId = shippedOrderRes.data.order.id;

    const shipRes = await jsonReq(
      baseUrl,
      owner.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(shippedOrderId)}/status`,
      { status: 'shipped' },
      ownerCsrf
    );
    assert.equal(shipRes.status, 200);

    const cancelShipped = await jsonReq<{ code?: string }>(
      baseUrl,
      custA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(shippedOrderId)}/cancel`,
      { reason: 'Too late' },
      custA.csrfToken
    );
    assert.equal(cancelShipped.status, 409);
    assert.equal(cancelShipped.data.code, 'CANCELLATION_CUTOFF_PASSED');

    // 7. Admin overview counts, filters, and reload persistence match authoritative DB state
    const overviewRes = await jsonReq<{
      metrics: {
        totalOrders: number;
        pendingOrders: number;
        cancelledOrders: number;
        totalRevenuePaise: number;
      };
    }>(baseUrl, owner.jar, 'GET', '/api/admin/overview', undefined, ownerCsrf);
    assert.equal(overviewRes.status, 200);
    assert.equal(overviewRes.data.metrics.totalOrders, 3);
    assert.equal(overviewRes.data.metrics.pendingOrders, 0);
    assert.equal(overviewRes.data.metrics.cancelledOrders, 2);
    assert.equal(
      overviewRes.data.metrics.totalRevenuePaise,
      0,
      'Cancelled orders must never count toward active revenue'
    );

    const pendingFilter = await jsonReq<{
      items: Array<{ id: string }>;
      statusCounts: Record<string, number>;
    }>(baseUrl, owner.jar, 'GET', '/api/admin/orders?status=pending', undefined, ownerCsrf);
    assert.equal(pendingFilter.status, 200);
    assert.equal(pendingFilter.data.items.length, 0);
    assert.equal(pendingFilter.data.statusCounts.pending, 0);
    assert.equal(pendingFilter.data.statusCounts.cancelled, 2);
    assert.equal(pendingFilter.data.statusCounts.shipped, 1);

    const cancelledFilter = await jsonReq<{
      items: Array<{ id: string; status: string }>;
    }>(baseUrl, owner.jar, 'GET', '/api/admin/orders?status=cancelled', undefined, ownerCsrf);
    assert.equal(cancelledFilter.status, 200);
    assert.equal(cancelledFilter.data.items.length, 2);
    assert.ok(cancelledFilter.data.items.every((o) => o.status === 'cancelled'));

    // Fresh customer order fetch confirms reload persistence
    const custOrdersFresh = await jsonReq<{
      items: Array<{ id: string; status: string; refundStatus: string }>;
    }>(baseUrl, custA.jar, 'GET', '/api/account/orders', undefined, custA.csrfToken);
    assert.equal(custOrdersFresh.status, 200);
    assert.equal(
      custOrdersFresh.data.items.find((o) => o.id === codOrderId)?.status,
      'cancelled'
    );
    assert.equal(
      custOrdersFresh.data.items.find((o) => o.id === paidOrderId)?.refundStatus,
      'refunded'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Delayed Razorpay verify-payment, webhook, and order-status callbacks NEVER reactivate a cancelled order', async () => {
  clearRazorpayCheckoutCachesForTest();
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const originalFetch = globalThis.fetch;

  process.env.RAZORPAY_KEY_ID = 'rzp_test_cancel_guard';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_cancel_guard';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_cancel_guard';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-rzp-delayed-'));
  const dbPath = path.join(tmpDir, 'boutique.db');
  const appInstance = createAuthApp({
    dbPath,
    disableRateLimit: true,
    seedCatalog: true,
  });

  try {
    const store = appInstance.store!;
    const now = Date.now();
    const rzpOrderId = 'order_delayed_cb_1';
    const rzpPaymentId = 'pay_delayed_cb_1';

    // Insert an already-cancelled Razorpay order (e.g., customer cancelled before webhook arrived)
    appInstance.db!.prepare(
      `INSERT INTO orders (
        id, order_number, customer_user_id, customer_name, customer_email, customer_phone,
        shipping_address, subtotal_paise, discount_paise, gift_card_paise, total_paise, currency,
        status, payment_status, fulfillment_status, refund_status, payment_method,
        razorpay_order_id, cancelled_at, cancelled_by, cancel_reason,
        status_history_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'INR', 'cancelled', 'pending', 'cancelled', 'not_required', 'razorpay', ?, ?, 'customer', 'Cancelled prior to payment settlement', ?, ?, ?)`
    ).run(
      'ord_cancelled_rzp_1',
      'SC-RZP-CANC-1',
      'user_rzp_1',
      'Meera',
      'meera@example.com',
      '9876543210',
      'Hyderabad',
      250000,
      250000,
      rzpOrderId,
      now - 5000,
      JSON.stringify([
        { status: 'placed', actor: 'customer', at: now - 10000 },
        { status: 'cancelled', actor: 'customer', note: 'Cancelled prior to payment settlement', at: now - 5000 },
      ]),
      now - 10000,
      now - 5000
    );

    // Mock Razorpay REST API returning a captured payment for that order
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes(`/v1/payments/${rzpPaymentId}`)) {
        return new Response(
          JSON.stringify({
            id: rzpPaymentId,
            order_id: rzpOrderId,
            status: 'captured',
            amount: 250000,
            currency: 'INR',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes(`/v1/orders/${rzpOrderId}/payments`)) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: rzpPaymentId,
                order_id: rzpOrderId,
                status: 'captured',
                amount: 250000,
                currency: 'INR',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: `Unexpected ${url}` }), { status: 404 });
    }) as typeof fetch;

    // 1. Delayed verify-payment callback
    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${rzpOrderId}|${rzpPaymentId}`)
      .digest('hex');

    const verifyRes = await handleVerifyPaymentRequest(
      {
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: sig,
      },
      { store }
    );
    assert.equal(verifyRes.status, 200);
    const verifyOrder = (verifyRes.body as { order?: { status: string; paymentStatus: string; refundStatus: string } }).order;
    assert.equal(verifyOrder?.status, 'cancelled', 'verify-payment must NOT reactivate cancelled order');
    assert.equal(verifyOrder?.paymentStatus, 'paid');
    assert.equal(verifyOrder?.refundStatus, 'pending_refund');

    // 2. Delayed webhook payment.captured callback
    const webhookPayload = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rzpPaymentId,
            order_id: rzpOrderId,
            status: 'captured',
            amount: 250000,
            currency: 'INR',
          },
        },
      },
    });
    const whSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(webhookPayload)
      .digest('hex');

    const whRes = await handleRazorpayWebhookRequest(webhookPayload, whSig, { store });
    assert.equal(whRes.status, 200);

    // 3. Delayed order-status polling check
    const statusRes = await handleOrderStatusRequest(
      { razorpayOrderId: rzpOrderId, paymentId: rzpPaymentId },
      { store }
    );
    assert.equal(statusRes.status, 200);
    const polledOrder = (statusRes.body as { order?: { status: string; paymentStatus: string; refundStatus: string } }).order;
    assert.equal(polledOrder?.status, 'cancelled', 'order-status polling must NOT reactivate cancelled order');
    assert.equal(polledOrder?.paymentStatus, 'paid');
    assert.equal(polledOrder?.refundStatus, 'pending_refund');

    // Confirm database row itself remained cancelled with refund_status === 'pending_refund'
    const dbRow = appInstance.db!
      .prepare(`SELECT status, fulfillment_status, payment_status, refund_status FROM orders WHERE id = ?`)
      .get('ord_cancelled_rzp_1') as {
      status: string;
      fulfillment_status: string;
      payment_status: string;
      refund_status: string;
    };
    assert.equal(dbRow.status, 'cancelled');
    assert.equal(dbRow.fulfillment_status, 'cancelled');
    assert.equal(dbRow.payment_status, 'paid');
    assert.equal(dbRow.refund_status, 'pending_refund');
  } finally {
    globalThis.fetch = originalFetch;
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    if (prevWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Missing/unknown order statuses never silently default to pending, and failed persistence never reports false success', async () => {
  // 1. Corrupted/missing status normalization returns 'unknown' + needsAdminReview: true
  const norm = normalizeOrderRequestsAndStatus({
    rawStatus: '',
    rawFulfillmentStatus: '',
    statusHistory: [],
  });
  assert.equal(norm.fulfillmentStatus, 'unknown');
  assert.equal(norm.needsAdminReview, true);

  const clientSerialized = serializeClientOrderDoc({
    id: 'ord_missing_status',
    order_number: 'SC-UNKNOWN-1',
    customer_name: 'Test Shopper',
    payment_method: 'cod',
    payment_status: 'unpaid',
    total_paise: 150000,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  assert.equal(clientSerialized.status, 'unknown');
  assert.equal(clientSerialized.fulfillmentStatus, 'unknown');
  assert.equal(clientSerialized.needsAdminReview, true);

  // 2. Clientless cancel propagates explicit failure when persistence fails (never fakes success)
  const originalFetch = globalThis.fetch;
  const createMem = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, String(v)),
      removeItem: (k: string) => map.delete(k),
      clear: () => map.clear(),
    };
  };
  (globalThis as Record<string, unknown>).window = {
    location: { hostname: 'sahithidesigns.online', origin: 'https://sahithidesigns.online' },
    sessionStorage: createMem(),
    localStorage: createMem(),
  };
  clearClientFirebaseSession();

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      user_id: 'uid-fail-1',
      email: 'failtest@example.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url');
  const fakeJwt = `${header}.${body}.sig`;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();
    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')) {
      return new Response(
        JSON.stringify({
          idToken: fakeJwt,
          refreshToken: 'ref-fail',
          localId: 'uid-fail-1',
          email: 'failtest@example.com',
          displayName: 'Fail Test',
          expiresIn: '3600',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      return new Response(
        JSON.stringify({
          users: [{ localId: 'uid-fail-1', email: 'failtest@example.com', emailVerified: true }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/api/cancel-order')) {
      return new Response(
        JSON.stringify({ error: 'Database write rejected by server.', code: 'CANCEL_PERSIST_FAILED' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('firestore.googleapis.com') && method === 'GET') {
      return new Response(
        JSON.stringify({
          name: 'projects/p/databases/d/documents/environments/production/orders/ord_fail_1',
          fields: {
            id: { stringValue: 'ord_fail_1' },
            order_number: { stringValue: 'SC-FAIL-1' },
            customer_user_id: { stringValue: 'uid-fail-1' },
            status: { stringValue: 'placed' },
            fulfillment_status: { stringValue: 'placed' },
            payment_method: { stringValue: 'cod' },
            payment_status: { stringValue: 'unpaid' },
            total_paise: { integerValue: '100000' },
          },
          updateTime: '2026-01-01T00:00:01Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('firestore.googleapis.com') && method === 'PATCH') {
      return new Response(
        JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ error: 'Unexpected fetch' }), { status: 500 });
  }) as typeof fetch;

  try {
    const login = await handleClientlessApiRequest('/api/auth/login', 'POST', {
      email: 'failtest@example.com',
      password: 'Password!123',
    });
    assert.equal(login.ok, true);

    const cancelFail = await handleClientlessApiRequest('/api/account/orders/ord_fail_1/cancel', 'POST', {
      reason: 'Testing error handling',
    });
    assert.equal(cancelFail.ok, false, 'Failed persistence must return ok: false');
    if (!cancelFail.ok) {
      assert.ok(cancelFail.error.length > 0);
    }
  } finally {
    clearClientFirebaseSession();
    globalThis.fetch = originalFetch;
  }
});

test('Cancelled order repair script: dry-run vs apply, backup creation, verified evidence only, and idempotency', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-repair-test-'));
  const dbPath = path.join(tmpDir, 'repair.db');
  const backupDir = path.join(tmpDir, 'backups');

  const appInstance = createAuthApp({ dbPath, disableRateLimit: true, seedCatalog: false });
  const db = appInstance.db!;
  const now = Date.now();

  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, order_number, customer_user_id, customer_name, customer_email, customer_phone,
      shipping_address, subtotal_paise, discount_paise, gift_card_paise, total_paise, currency,
      status, payment_status, fulfillment_status, refund_status, payment_method,
      cancelled_at, cancelled_by, cancel_request_json, status_history_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 100000, 0, 0, 100000, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 1. Order with verified cancellation evidence (approved cancel request + history) stuck in 'pending'
  insertOrder.run(
    'ord_repair_1',
    'SC-REP-1',
    'u1',
    'Asha',
    'asha@example.com',
    '9999999991',
    'Hyderabad',
    'pending',
    'paid',
    'pending',
    'none',
    'razorpay',
    null,
    null,
    JSON.stringify({ id: 'req1', type: 'cancel', reason: 'Wrong size', status: 'approved', requestedAt: now - 5000, resolvedAt: now - 2000 }),
    JSON.stringify([
      { status: 'placed', actor: 'customer', at: now - 10000 },
      { status: 'cancelled', actor: 'customer', note: 'Wrong size', at: now - 2000 },
    ]),
    now - 10000,
    now - 2000
  );

  // 2. Order with split status field (status='cancelled', fulfillment_status='placed') and missing refund_status
  insertOrder.run(
    'ord_repair_2',
    'SC-REP-2',
    'u2',
    'Bhanu',
    'bhanu@example.com',
    '9999999992',
    'Hyderabad',
    'cancelled',
    'unpaid',
    'placed',
    'none',
    'cod',
    now - 3000,
    'customer',
    null,
    JSON.stringify([{ status: 'placed', actor: 'customer', at: now - 8000 }]),
    now - 8000,
    now - 3000
  );

  // 3. Genuine pending order -> MUST NOT be touched
  insertOrder.run(
    'ord_genuine_pending',
    'SC-PEND-1',
    'u3',
    'Chitra',
    'chitra@example.com',
    '9999999993',
    'Hyderabad',
    'pending',
    'unpaid',
    'pending',
    'none',
    'cod',
    null,
    null,
    null,
    JSON.stringify([{ status: 'placed', actor: 'customer', at: now - 4000 }]),
    now - 4000,
    now - 4000
  );

  // 4. Failed payment order with NO cancellation evidence -> MUST NOT be touched
  insertOrder.run(
    'ord_failed_pay',
    'SC-FAILPAY-1',
    'u4',
    'Deepa',
    'deepa@example.com',
    '9999999994',
    'Hyderabad',
    'pending',
    'failed',
    'pending',
    'none',
    'razorpay',
    null,
    null,
    null,
    JSON.stringify([{ status: 'placed', actor: 'customer', at: now - 4000 }]),
    now - 4000,
    now - 4000
  );

  // 5. Already consistent cancelled order -> MUST NOT be touched again
  insertOrder.run(
    'ord_already_clean',
    'SC-CLEAN-1',
    'u5',
    'Esha',
    'esha@example.com',
    '9999999995',
    'Hyderabad',
    'cancelled',
    'unpaid',
    'cancelled',
    'not_required',
    'cod',
    now - 6000,
    'customer',
    null,
    JSON.stringify([{ status: 'cancelled', actor: 'customer', at: now - 6000 }]),
    now - 9000,
    now - 6000
  );

  try {
    // Dry-run finds exactly the 2 inconsistent cancelled orders and mutates NOTHING
    const dryRun = runSqliteCancellationRepair({ dbPath, apply: false, backupDir, now });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.scannedCount, 5);
    assert.equal(dryRun.candidateCount, 2);
    assert.equal(dryRun.repairedCount, 0);
    assert.equal(dryRun.backupPath, null);
    assert.deepEqual(
      dryRun.candidates.map((c) => c.id).sort(),
      ['ord_repair_1', 'ord_repair_2']
    );

    const beforeApplyRow = db
      .prepare(`SELECT status FROM orders WHERE id = 'ord_repair_1'`)
      .get() as { status: string };
    assert.equal(beforeApplyRow.status, 'pending', 'Dry-run must not mutate database');

    // Apply writes backup and repairs ONLY the 2 verified orders
    const applied = runSqliteCancellationRepair({ dbPath, apply: true, backupDir, now });
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.candidateCount, 2);
    assert.equal(applied.repairedCount, 2);
    assert.ok(applied.backupPath && fs.existsSync(applied.backupPath), 'Backup JSON must be created before applying');

    const backupJson = JSON.parse(fs.readFileSync(applied.backupPath!, 'utf8')) as {
      affectedOrderCount: number;
      records: Array<{ id: string }>;
    };
    assert.equal(backupJson.affectedOrderCount, 2);

    const rep1 = db
      .prepare(`SELECT status, fulfillment_status, refund_status, cancelled_at, cancelled_by FROM orders WHERE id = 'ord_repair_1'`)
      .get() as { status: string; fulfillment_status: string; refund_status: string; cancelled_at: number; cancelled_by: string };
    assert.equal(rep1.status, 'cancelled');
    assert.equal(rep1.fulfillment_status, 'cancelled');
    assert.equal(rep1.refund_status, 'pending_refund');
    assert.ok(rep1.cancelled_at > 0);
    assert.equal(rep1.cancelled_by, 'customer');

    const rep2 = db
      .prepare(`SELECT status, fulfillment_status, refund_status FROM orders WHERE id = 'ord_repair_2'`)
      .get() as { status: string; fulfillment_status: string; refund_status: string };
    assert.equal(rep2.status, 'cancelled');
    assert.equal(rep2.fulfillment_status, 'cancelled');
    assert.equal(rep2.refund_status, 'not_required');

    // Genuine pending & failed payment orders remained completely untouched
    const genuine = db
      .prepare(`SELECT status, fulfillment_status FROM orders WHERE id = 'ord_genuine_pending'`)
      .get() as { status: string; fulfillment_status: string };
    assert.equal(genuine.status, 'pending');
    assert.equal(genuine.fulfillment_status, 'pending');

    const failedPay = db
      .prepare(`SELECT status, payment_status FROM orders WHERE id = 'ord_failed_pay'`)
      .get() as { status: string; payment_status: string };
    assert.equal(failedPay.status, 'pending');
    assert.equal(failedPay.payment_status, 'failed');

    // Repeat run is idempotent -> 0 candidates
    const secondRun = runSqliteCancellationRepair({ dbPath, apply: true, backupDir, now: now + 1000 });
    assert.equal(secondRun.candidateCount, 0);
    assert.equal(secondRun.repairedCount, 0);
    assert.equal(secondRun.backupPath, null);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
