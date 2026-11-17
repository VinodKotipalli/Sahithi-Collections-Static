import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createOrdersHandler } from '../api/orders.ts';
import { createAuthApp } from '../server/app.ts';
import { bindOwnerAccount, initAuthDatabase } from '../server/db.ts';
import type { EmailMessage } from '../server/providers.ts';
import { clearRazorpayCheckoutCachesForTest } from '../server/razorpay-checkout.ts';
import { SqliteBoutiqueStore } from '../server/sqlite-store.ts';

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
  assert.ok(match, 'Expected token query param in verification email');
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
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
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
    user: { id: string; email: string; isOwner?: boolean } | null;
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

  const verificationEmail = [...sentEmails]
    .reverse()
    .find((m) => m.to.toLowerCase() === email.toLowerCase());
  assert.ok(verificationEmail);
  const token = extractToken(verificationEmail.html + '\n' + verificationEmail.text);

  const verifyRes = await jsonReq<{ csrfToken?: string }>(
    baseUrl,
    jar,
    'POST',
    '/api/auth/verify-email',
    { token },
    session.csrfToken
  );
  assert.equal(verifyRes.status, 200);

  session = await getSession(baseUrl, jar);
  if (!session.authenticated) {
    const loginRes = await jsonReq<{ csrfToken?: string }>(
      baseUrl,
      jar,
      'POST',
      '/api/auth/login',
      { email, password },
      session.csrfToken
    );
    assert.equal(loginRes.status, 200);
    session = await getSession(baseUrl, jar);
  }
  assert.equal(session.authenticated, true);
  return { jar, csrfToken: session.csrfToken, userId: session.user!.id };
}

test('Cash on Delivery checkout: validation, idempotency, inventory deduction, admin collection & revenue separation', async () => {
  clearRazorpayCheckoutCachesForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-cod-e2e-'));
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
    // Prepare Owner session (separate browser/CookieJar) and Customer session
    const ownerCreds = await registerVerifyAndLogin({
      baseUrl,
      email: 'owner.studio@sahithidesigns.online',
      fullName: 'Sahithi Owner',
      password: 'OwnerPass!2026',
      sentEmails,
    });
    bindOwnerAccount(appInstance.db!, {
      email: 'owner.studio@sahithidesigns.online',
      boundVia: 'cli_setup',
    });
    const ownerLogin = await jsonReq<{ user: { isOwner?: boolean } }>(
      baseUrl,
      ownerCreds.jar,
      'POST',
      '/api/admin/login',
      { email: 'owner.studio@sahithidesigns.online', password: 'OwnerPass!2026' },
      ownerCreds.csrfToken
    );
    assert.equal(ownerLogin.status, 200);
    assert.equal(ownerLogin.data.user.isOwner, true);
    const ownerSession = await getSession(baseUrl, ownerCreds.jar);
    const ownerCsrf = ownerSession.csrfToken;

    const customer = await registerVerifyAndLogin({
      baseUrl,
      email: 'priya.cod@example.com',
      fullName: 'Priya Sharma',
      password: 'CustomerPass!123',
      sentEmails,
    });

    // Pick a published product variant from catalog
    const product = await appInstance.store.getPublicProductByIdOrSlug('sc-103');
    assert.ok(product, 'Expected seeded sc-103 product');
    const targetVariant = product.variants[0];
    assert.ok(targetVariant);
    const initialStock = targetVariant.stock_qty;
    assert.ok(initialStock >= 3, 'Expected at least 3 stock units on seeded variant');

    // Create an active ₹100 off coupon so server promo calculation is exercised
    const createCouponRes = await jsonReq(
      baseUrl,
      ownerCreds.jar,
      'POST',
      '/api/admin/coupons',
      {
        code: 'COD100',
        title: 'Boutique ₹100 Off',
        discountType: 'flat_paise',
        discountValue: 10000,
        minSpendPaise: 50000,
        active: true,
      },
      ownerCsrf
    );
    assert.equal(createCouponRes.status, 200);

    // 1. Validation check: missing delivery address rejected (400)
    const badAddrRes = await jsonReq<{ code?: string }>(
      baseUrl,
      customer.jar,
      'POST',
      '/api/orders',
      {
        customerName: 'Priya Sharma',
        customerEmail: 'priya.cod@example.com',
        customerPhone: '+91 98765 43210',
        shippingAddress: '123',
        paymentMethod: 'cod',
        idempotencyKey: 'cod_bad_addr_1',
        items: [{ productId: product.product.id, variantId: targetVariant.id, quantity: 1 }],
      },
      customer.csrfToken
    );
    assert.equal(badAddrRes.status, 400);
    assert.equal(badAddrRes.data.code, 'VALIDATION_ERROR');

    // 2. Out-of-stock / excessive quantity rejected (409 INSUFFICIENT_STOCK)
    const tooMuchRes = await jsonReq<{ code?: string }>(
      baseUrl,
      customer.jar,
      'POST',
      '/api/orders',
      {
        customerName: 'Priya Sharma',
        customerEmail: 'priya.cod@example.com',
        customerPhone: '+91 98765 43210',
        shippingAddress: '14 Banjara Hills, Road No 3, Hyderabad 500034',
        paymentMethod: 'cod',
        idempotencyKey: 'cod_oos_1',
        items: [{ productId: product.product.id, variantId: targetVariant.id, quantity: 20 }],
      },
      customer.csrfToken
    );
    assert.equal(tooMuchRes.status, 409);
    assert.equal(tooMuchRes.data.code, 'INSUFFICIENT_STOCK');

    // 3. Place valid COD order (quantity 2, ignores tampered client totalPaise if sent, applies server coupon COD100)
    const expectedSubtotal = targetVariant.price_paise * 2;
    const expectedTotal = expectedSubtotal - 10000;
    const codKey = 'cod_test_attempt_0001';

    const placeRes = await jsonReq<{
      order: {
        id: string;
        orderNumber: string;
        status: string;
        paymentMethod: string;
        paymentStatus: string;
        fulfillmentStatus: string;
        subtotalPaise: number;
        discountPaise: number;
        totalPaise: number;
        razorpayOrderId: string | null;
        razorpayPaymentId: string | null;
        idempotencyKey: string | null;
      };
      duplicate?: boolean;
    }>(
      baseUrl,
      customer.jar,
      'POST',
      '/api/orders',
      {
        customerName: 'Priya Sharma',
        customerEmail: 'priya.cod@example.com',
        customerPhone: '+91 98765 43210',
        shippingAddress: '14 Banjara Hills, Road No 3, Hyderabad 500034',
        paymentMethod: 'cod',
        couponCode: 'COD100',
        totalPaise: 100, // tampered client field must be ignored
        idempotencyKey: codKey,
        items: [
          {
            productId: product.product.id,
            variantId: targetVariant.id,
            quantity: 2,
            expectedPricePaise: targetVariant.price_paise,
          },
        ],
      },
      customer.csrfToken
    );
    assert.equal(placeRes.status, 201);
    assert.equal(placeRes.data.duplicate, false);
    const createdOrder = placeRes.data.order;
    assert.ok(createdOrder.orderNumber.startsWith('SC-'));
    assert.equal(createdOrder.paymentMethod, 'cod');
    assert.equal(createdOrder.paymentStatus, 'unpaid');
    assert.equal(createdOrder.status, 'placed');
    assert.equal(createdOrder.fulfillmentStatus, 'placed');
    assert.equal(createdOrder.razorpayOrderId, null);
    assert.equal(createdOrder.razorpayPaymentId, null);
    assert.equal(createdOrder.subtotalPaise, expectedSubtotal);
    assert.equal(createdOrder.discountPaise, 10000);
    assert.equal(createdOrder.totalPaise, expectedTotal);

    const afterFirstStock = (
      await appInstance.store.getPublicProductByIdOrSlug(product.product.id)
    )!.variants.find((v) => v.id === targetVariant.id)!.stock_qty;
    assert.equal(afterFirstStock, initialStock - 2);

    // 4. Duplicate submission / timeout retry with exact same idempotencyKey returns SAME order & does NOT deduct stock again
    const dupRes = await jsonReq<{
      order: { id: string; orderNumber: string };
      duplicate?: boolean;
    }>(
      baseUrl,
      customer.jar,
      'POST',
      '/api/orders',
      {
        customerName: 'Priya Sharma',
        customerEmail: 'priya.cod@example.com',
        customerPhone: '+91 98765 43210',
        shippingAddress: '14 Banjara Hills, Road No 3, Hyderabad 500034',
        paymentMethod: 'cod',
        couponCode: 'COD100',
        idempotencyKey: codKey,
        items: [
          {
            productId: product.product.id,
            variantId: targetVariant.id,
            quantity: 2,
            expectedPricePaise: targetVariant.price_paise,
          },
        ],
      },
      customer.csrfToken
    );
    assert.equal(dupRes.status, 200);
    assert.equal(dupRes.data.duplicate, true);
    assert.equal(dupRes.data.order.id, createdOrder.id);
    assert.equal(dupRes.data.order.orderNumber, createdOrder.orderNumber);

    const afterDupStock = (
      await appInstance.store.getPublicProductByIdOrSlug(product.product.id)
    )!.variants.find((v) => v.id === targetVariant.id)!.stock_qty;
    assert.equal(afterDupStock, initialStock - 2, 'Stock must not be deducted twice on duplicate retry');

    // 5. Customer Account visibility
    const custOrdersRes = await jsonReq<{
      items: Array<{ id: string; orderNumber: string; paymentMethod: string; paymentStatus: string }>;
    }>(baseUrl, customer.jar, 'GET', '/api/account/orders', undefined, customer.csrfToken);
    assert.equal(custOrdersRes.status, 200);
    const custOrder = custOrdersRes.data.items.find((o) => o.id === createdOrder.id);
    assert.ok(custOrder);
    assert.equal(custOrder.orderNumber, createdOrder.orderNumber);
    assert.equal(custOrder.paymentMethod, 'cod');
    assert.equal(custOrder.paymentStatus, 'unpaid');

    // 6. Customer cannot call owner-only collect-payment endpoint
    const custCollectForbidden = await jsonReq(
      baseUrl,
      customer.jar,
      'POST',
      `/api/admin/orders/${createdOrder.id}/collect-payment`,
      {},
      customer.csrfToken
    );
    assert.equal(custCollectForbidden.status, 403);

    // 7. Separate signed-in Admin session sees COD order & unpaid revenue exclusion
    const adminOrdersRes = await jsonReq<{
      items: Array<{
        id: string;
        orderNumber: string;
        paymentMethod: string;
        paymentStatus: string;
        fulfillmentStatus: string;
        totalPaise: number;
      }>;
    }>(baseUrl, ownerCreds.jar, 'GET', '/api/admin/orders', undefined, ownerCsrf);
    assert.equal(adminOrdersRes.status, 200);
    assert.equal(adminOrdersRes.data.items.length, 1);
    assert.equal(adminOrdersRes.data.items[0].orderNumber, createdOrder.orderNumber);
    assert.equal(adminOrdersRes.data.items[0].paymentMethod, 'cod');
    assert.equal(adminOrdersRes.data.items[0].paymentStatus, 'unpaid');
    assert.equal(adminOrdersRes.data.items[0].fulfillmentStatus, 'placed');

    const overviewBefore = await jsonReq<{
      metrics: { totalOrders: number; pendingOrders: number; totalRevenuePaise: number };
    }>(baseUrl, ownerCreds.jar, 'GET', '/api/admin/overview', undefined, ownerCsrf);
    assert.equal(overviewBefore.status, 200);
    assert.equal(overviewBefore.data.metrics.totalOrders, 1);
    assert.equal(overviewBefore.data.metrics.pendingOrders, 1);
    assert.equal(
      overviewBefore.data.metrics.totalRevenuePaise,
      0,
      'Unpaid COD order must NOT be included in collected revenue before payment collection'
    );

    // 8. Admin updates fulfillment to "delivered": must NOT mark payment as collected
    const deliverRes = await jsonReq<{
      order: { fulfillmentStatus: string; paymentStatus: string; paymentCollectedAt: number | null };
    }>(
      baseUrl,
      ownerCreds.jar,
      'PATCH',
      `/api/admin/orders/${createdOrder.id}/status`,
      { status: 'delivered', note: 'Handed over to recipient' },
      ownerCsrf
    );
    assert.equal(deliverRes.status, 200);
    assert.equal(deliverRes.data.order.fulfillmentStatus, 'delivered');
    assert.equal(deliverRes.data.order.paymentStatus, 'unpaid');
    assert.equal(deliverRes.data.order.paymentCollectedAt, null);

    const overviewDeliveredUnpaid = await jsonReq<{
      metrics: { totalOrders: number; pendingOrders: number; totalRevenuePaise: number };
    }>(baseUrl, ownerCreds.jar, 'GET', '/api/admin/overview', undefined, ownerCsrf);
    assert.equal(overviewDeliveredUnpaid.data.metrics.totalOrders, 1);
    assert.equal(overviewDeliveredUnpaid.data.metrics.pendingOrders, 0);
    assert.equal(overviewDeliveredUnpaid.data.metrics.totalRevenuePaise, 0);

    // 9. Admin marks payment collected: marks paid, records timestamp, preserves fulfillment 'delivered', updates revenue
    const collectRes = await jsonReq<{
      paymentStatus: string;
      order: {
        paymentStatus: string;
        fulfillmentStatus: string;
        paymentCollectedAt: number | null;
      };
    }>(
      baseUrl,
      ownerCreds.jar,
      'POST',
      `/api/admin/orders/${createdOrder.id}/collect-payment`,
      { note: 'Collected ₹ cash by courier' },
      ownerCsrf
    );
    assert.equal(collectRes.status, 200);
    assert.equal(collectRes.data.paymentStatus, 'paid');
    assert.equal(collectRes.data.order.paymentStatus, 'paid');
    assert.equal(collectRes.data.order.fulfillmentStatus, 'delivered');
    assert.ok(typeof collectRes.data.order.paymentCollectedAt === 'number');

    const overviewAfterCollect = await jsonReq<{
      metrics: { totalOrders: number; pendingOrders: number; totalRevenuePaise: number };
    }>(baseUrl, ownerCreds.jar, 'GET', '/api/admin/overview', undefined, ownerCsrf);
    assert.equal(overviewAfterCollect.data.metrics.totalOrders, 1);
    assert.equal(overviewAfterCollect.data.metrics.pendingOrders, 0);
    assert.equal(overviewAfterCollect.data.metrics.totalRevenuePaise, expectedTotal);

    // 10. Guest COD checkout also succeeds and is visible to admin while isolated from signed-in customer account
    const guestJar = new CookieJar();
    const guestSession = await getSession(baseUrl, guestJar);
    const guestOrderRes = await jsonReq<{
      order: { id: string; orderNumber: string; customerUserId: string | null; paymentMethod: string };
    }>(
      baseUrl,
      guestJar,
      'POST',
      '/api/orders',
      {
        customerName: 'Guest Shopper',
        customerEmail: 'guest@example.com',
        customerPhone: '+91 90000 11111',
        shippingAddress: '45 Indiranagar, Bengaluru 560038',
        paymentMethod: 'cod',
        idempotencyKey: 'cod_guest_attempt_1',
        items: [{ productId: product.product.id, variantId: targetVariant.id, quantity: 1 }],
      },
      guestSession.csrfToken
    );
    assert.equal(guestOrderRes.status, 201);
    assert.equal(guestOrderRes.data.order.customerUserId, null);
    assert.equal(guestOrderRes.data.order.paymentMethod, 'cod');

    const custOrdersAfterGuest = await jsonReq<{ items: Array<{ id: string }> }>(
      baseUrl,
      customer.jar,
      'GET',
      '/api/account/orders',
      undefined,
      customer.csrfToken
    );
    assert.equal(
      custOrdersAfterGuest.data.items.some((o) => o.id === guestOrderRes.data.order.id),
      false,
      'Guest COD order must not leak into customer account history'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    appInstance.db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Vercel /api/orders handler enforces verified auth, persists COD via store, and fails explicitly on storage unavailability', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-vercel-orders-'));
  const dbPath = path.join(tmpDir, 'vercel-orders.db');
  const store = new SqliteBoutiqueStore({ dbPath, targetEnv: 'development', seedCatalog: true });

  const prevFbProject = process.env.FIREBASE_PROJECT_ID;
  const prevGoogleProj = process.env.GOOGLE_CLOUD_PROJECT;
  const prevFbConfig = process.env.FIREBASE_CONFIG;
  const prevSvcAcct = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const prevViteFbProj = process.env.VITE_FIREBASE_PROJECT_ID;

  try {
    const product = await store.getPublicProductByIdOrSlug('sc-103');
    assert.ok(product);
    const variant = product.variants[0];

    const nowTs = Date.now();
    store.db
      .prepare(
        `INSERT INTO users (id, full_name, email, email_verified, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?, ?)`
      )
      .run('uid_firebase_123', 'Kavya Nair', 'fb@example.com', nowTs, nowTs);

    // Mock HTTP request/response helper for Vercel Node handler
    const invokeHandler = async (
      handler: ReturnType<typeof createOrdersHandler>,
      req: { method: string; headers?: Record<string, string>; body?: unknown }
    ) => {
      let statusCode = 200;
      let jsonPayload: Record<string, unknown> = {};
      const resHeaders: Record<string, string> = {};
      const mockReq = {
        method: req.method,
        headers: req.headers || {},
        body: req.body,
      } as unknown as Parameters<typeof handler>[0];
      const mockRes = {
        setHeader(k: string, v: string) {
          resHeaders[k.toLowerCase()] = v;
        },
        status(code: number) {
          statusCode = code;
          return mockRes;
        },
        json(payload: unknown) {
          jsonPayload = payload as Record<string, unknown>;
        },
        end(raw?: string) {
          if (raw) jsonPayload = JSON.parse(raw);
        },
      } as unknown as Parameters<typeof handler>[1];
      await handler(mockReq, mockRes);
      return { statusCode, body: jsonPayload, headers: resHeaders };
    };

    const handlerWithStore = createOrdersHandler({
      store,
      verifyIdToken: async (token) =>
        token === 'valid-firebase-jwt' ? { uid: 'uid_firebase_123', email: 'fb@example.com' } : null,
    });

    // Rejects tampered invalid bearer token
    const badTokenRes = await invokeHandler(handlerWithStore, {
      method: 'POST',
      headers: { authorization: 'Bearer invalid-token' },
      body: { paymentMethod: 'cod' },
    });
    assert.equal(badTokenRes.statusCode, 401);

    // Succeeds with verified Firebase UID and saves COD order + deducts stock once
    const okRes = await invokeHandler(handlerWithStore, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-firebase-jwt' },
      body: {
        customerName: 'Kavya Nair',
        customerEmail: 'fb@example.com',
        customerPhone: '+91 98450 12345',
        shippingAddress: '88 MG Road, Kochi 682016',
        paymentMethod: 'cod',
        idempotencyKey: 'vercel_cod_key_1',
        items: [{ productId: product.product.id, variantId: variant.id, quantity: 1 }],
      },
    });
    assert.equal(okRes.statusCode, 201);
    const created = okRes.body.order as {
      orderNumber: string;
      customerUserId: string;
      paymentMethod: string;
      paymentStatus: string;
      status: string;
    };
    assert.equal(created.customerUserId, 'uid_firebase_123');
    assert.equal(created.paymentMethod, 'cod');
    assert.equal(created.paymentStatus, 'unpaid');
    assert.equal(created.status, 'placed');

    // Rejects GET and fails strictly when persistence throws
    const wrongMethodRes = await invokeHandler(handlerWithStore, { method: 'GET' });
    assert.equal(wrongMethodRes.statusCode, 405);

    const failingStore = {
      ...store,
      getOrderById: async () => null,
      getProductsForCartValidation: store.getProductsForCartValidation.bind(store),
      getPublicProductByIdOrSlug: store.getPublicProductByIdOrSlug.bind(store),
      getCouponByCode: store.getCouponByCode.bind(store),
      getGiftCardByCode: store.getGiftCardByCode.bind(store),
      placeOrder: async () => {
        throw new Error('Simulated database write failure');
      },
    } as unknown as NonNullable<Parameters<typeof createOrdersHandler>[0]>['store'];
    const failingHandler = createOrdersHandler({
      store: failingStore,
      verifyIdToken: async () => ({ uid: 'uid_firebase_123', email: 'fb@example.com' }),
    });
    const failedSaveRes = await invokeHandler(failingHandler, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-firebase-jwt' },
      body: {
        customerName: 'Kavya Nair',
        customerEmail: 'fb@example.com',
        customerPhone: '+91 98450 12345',
        shippingAddress: '88 MG Road, Kochi 682016',
        paymentMethod: 'cod',
        idempotencyKey: 'vercel_cod_fail_1',
        items: [{ productId: product.product.id, variantId: variant.id, quantity: 1 }],
      },
    });
    assert.equal(failedSaveRes.statusCode, 500);
    assert.equal(failedSaveRes.body.code, 'COD_ORDER_FAILED');
  } finally {
    if (prevFbProject !== undefined) process.env.FIREBASE_PROJECT_ID = prevFbProject;
    if (prevGoogleProj !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prevGoogleProj;
    if (prevFbConfig !== undefined) process.env.FIREBASE_CONFIG = prevFbConfig;
    if (prevSvcAcct !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = prevSvcAcct;
    if (prevViteFbProj !== undefined) process.env.VITE_FIREBASE_PROJECT_ID = prevViteFbProj;
    await store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SQLite schema migration upgrades legacy orders table with idempotency & payment collection columns safely', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-cod-migration-'));
  const dbPath = path.join(tmpDir, 'legacy.db');

  // Create minimal legacy orders table WITHOUT idempotency_key, payment_collected_at, payment_collected_by
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      shipping_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      subtotal_paise INTEGER NOT NULL,
      total_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO orders (
      id, order_number, customer_name, customer_email, customer_phone,
      shipping_address, status, subtotal_paise, total_paise, currency, created_at
    ) VALUES (
      'legacy_ord_1', 'SC-LEG-001', 'Legacy Customer', 'leg@example.com', '9999999999',
      '1 Heritage Lane, Jaipur 302001', 'delivered', 149900, 149900, 'INR', 1700000000000
    );
  `);
  legacyDb.close();

  const upgradedDb = initAuthDatabase(dbPath);
  try {
    const columns = upgradedDb.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    assert.equal(names.has('idempotency_key'), true);
    assert.equal(names.has('payment_collected_at'), true);
    assert.equal(names.has('payment_collected_by'), true);
    assert.equal(names.has('payment_method'), true);
    assert.equal(names.has('payment_status'), true);
    assert.equal(names.has('fulfillment_status'), true);

    const legacyRow = upgradedDb
      .prepare('SELECT id, order_number, status FROM orders WHERE id = ?')
      .get('legacy_ord_1') as { id: string; order_number: string; status: string } | undefined;
    assert.ok(legacyRow);
    assert.equal(legacyRow.order_number, 'SC-LEG-001');
  } finally {
    upgradedDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
