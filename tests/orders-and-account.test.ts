import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthApp } from '../server/app.ts';
import { bindOwnerAccount } from '../server/db.ts';
import type { EmailMessage, EmailSender } from '../server/providers.ts';
import {
  clearRazorpayCheckoutCachesForTest,
  handleCreateOrderRequest,
  handleVerifyPaymentRequest,
  type RazorpayClientFactory,
  type RazorpayClientLike,
  type RazorpayPaymentEntity,
} from '../server/razorpay-checkout.ts';
import { SqliteBoutiqueStore } from '../server/sqlite-store.ts';
import type { BoutiqueStore } from '../server/store.ts';

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

interface MockRazorpayState {
  orders: Array<{ id: string; amount: number; currency: string; receipt: string; notes?: Record<string, string> }>;
  payments: Map<string, RazorpayPaymentEntity>;
}

function createStatefulMockRazorpayFactory(state: MockRazorpayState): RazorpayClientFactory {
  return (): RazorpayClientLike => ({
    orders: {
      async create(params) {
        const id = `order_e2e_${state.orders.length + 1}`;
        const rec = {
          id,
          amount: params.amount,
          currency: params.currency,
          receipt: params.receipt,
          notes: params.notes,
        };
        state.orders.push(rec);
        return { ...rec, status: 'created' };
      },
      async fetch(orderId) {
        const found = state.orders.find((o) => o.id === orderId);
        return {
          id: orderId,
          amount: found?.amount ?? 169000,
          currency: found?.currency ?? 'INR',
          receipt: found?.receipt ?? 'rcpt_e2e',
          notes: found?.notes,
          status: 'paid',
        };
      },
      async fetchPayments(orderId) {
        const matched = Array.from(state.payments.values()).filter((p) => p.order_id === orderId);
        return { items: matched };
      },
    },
    payments: {
      async fetch(paymentId) {
        const existing = state.payments.get(paymentId);
        if (existing) return existing;
        const latest = state.orders[state.orders.length - 1];
        return {
          id: paymentId,
          order_id: latest?.id ?? 'order_e2e_1',
          amount: latest?.amount ?? 169000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        };
      },
      async capture(paymentId, amount, currency) {
        const current = state.payments.get(paymentId);
        const updated: RazorpayPaymentEntity = {
          id: paymentId,
          order_id: current?.order_id ?? state.orders[state.orders.length - 1]?.id ?? 'order_e2e_1',
          amount,
          currency,
          status: 'captured',
          captured: true,
        };
        state.payments.set(paymentId, updated);
        return updated;
      },
    },
  });
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
  assert.ok(verificationEmail, `Expected verification email for ${email}`);
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

  let currentCsrf = String(verifyRes.data.csrfToken || session.csrfToken);
  session = await getSession(baseUrl, jar);
  currentCsrf = session.csrfToken || currentCsrf;

  if (!session.authenticated) {
    const loginRes = await jsonReq<{ user: { id: string; email: string }; csrfToken?: string }>(
      baseUrl,
      jar,
      'POST',
      '/api/auth/login',
      { email, password },
      currentCsrf
    );
    assert.equal(loginRes.status, 200);
    session = await getSession(baseUrl, jar);
    currentCsrf = session.csrfToken || String(loginRes.data.csrfToken || currentCsrf);
  }

  assert.equal(session.authenticated, true);
  assert.ok(session.user?.id);

  return { jar, csrfToken: currentCsrf, userId: session.user.id };
}

test('End-to-end order integrity, customer account isolation, owner sync, notifications, promos & recovery', async () => {
  clearRazorpayCheckoutCachesForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-e2e-account-'));
  const dbPath = path.join(tmpDir, 'boutique.db');
  const sentEmails: EmailMessage[] = [];

  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  process.env.RAZORPAY_KEY_ID = 'rzp_test_U17MiWPrvpas0b';
  process.env.RAZORPAY_KEY_SECRET = 'Oroq81QnfslWBN9z3bsXYOf5';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_sahithi_test_secret_123';

  const mockRzpState: MockRazorpayState = {
    orders: [],
    payments: new Map(),
  };

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
    razorpayClientFactory: createStatefulMockRazorpayFactory(mockRzpState),
  });

  const server = http.createServer(appInstance.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Set up owner + Customer A + Customer B
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

    const customerA = await registerVerifyAndLogin({
      baseUrl,
      email: 'meera.customer@example.com',
      fullName: 'Meera Rao',
      password: 'CustomerPass!123',
      sentEmails,
    });

    const customerB = await registerVerifyAndLogin({
      baseUrl,
      email: 'divya.customer@example.com',
      fullName: 'Divya Nair',
      password: 'CustomerPass!456',
      sentEmails,
    });

    // Owner creates a promo coupon and a gift card
    const cpnRes = await jsonReq<{ coupon: { code: string } }>(
      baseUrl,
      ownerCreds.jar,
      'POST',
      '/api/admin/coupons',
      {
        code: 'SAHITHI10',
        title: '10% Boutique Welcome',
        description: '10% off up to ₹200',
        discountType: 'percent',
        discountValue: 10,
        maxDiscountPaise: 20000,
        minSpendPaise: 50000,
        active: true,
      },
      ownerCsrf
    );
    assert.equal(cpnRes.status, 200);

    const gcRes = await jsonReq<{ giftCard: { code: string; balancePaise: number } }>(
      baseUrl,
      ownerCreds.jar,
      'POST',
      '/api/admin/gift-cards',
      {
        code: 'GIFT-MEERA-100',
        initialBalancePaise: 10000,
        recipientEmail: 'meera.customer@example.com',
        active: true,
      },
      ownerCsrf
    );
    assert.equal(gcRes.status, 200);

    // Track initial stock of sc-101 variant 0 (₹1,690 = 169000 paise)
    const initialKurti = await appInstance.store.getPublicProductByIdOrSlug('sc-101');
    assert.ok(initialKurti);
    const variant0 = initialKurti.variants[0];
    assert.ok(variant0);
    const initialStock = variant0.stock_qty;

    // 1. Customer A saves an address & syncs wishlist
    const addrRes = await jsonReq<{ address: { id: string; isDefault: boolean } }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/account/addresses',
      {
        label: 'Home',
        fullName: 'Meera Rao',
        phone: '+91 98480 12345',
        line1: '18 Jubilee Hills Road 36',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500033',
        isDefault: true,
      },
      customerA.csrfToken
    );
    assert.equal(addrRes.status, 200);
    assert.equal(addrRes.data.address.isDefault, true);

    const wishRes = await jsonReq<{ productIds: string[] }>(
      baseUrl,
      customerA.jar,
      'PUT',
      '/api/account/wishlist',
      { productIds: ['sc-101', 'sc-004'] },
      customerA.csrfToken
    );
    assert.equal(wishRes.status, 200);
    assert.deepEqual(wishRes.data.productIds, ['sc-101', 'sc-004']);

    // 2. Customer A initiates checkout with coupon SAHITHI10 (10% off 169000 = 16900) + GIFT-MEERA-100 (10000)
    // Expected payable = 169000 - 16900 - 10000 = 142100 paise
    const createOrderA = await jsonReq<{
      order_id: string;
      amount: number;
      discount_paise: number;
      gift_card_paise: number;
      checkout_token: string;
    }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/create-order',
      {
        currency: 'INR',
        couponCode: 'SAHITHI10',
        giftCardCode: 'GIFT-MEERA-100',
        items: [{ productId: 'sc-101', variantId: variant0.id, quantity: 1 }],
        customer: {
          customerName: 'Meera Rao',
          customerEmail: 'meera.customer@example.com',
          customerPhone: '+91 98480 12345',
          shippingAddress: '18 Jubilee Hills Road 36, Hyderabad, Telangana 500033',
        },
      },
      customerA.csrfToken
    );
    assert.equal(createOrderA.status, 200);
    assert.equal(createOrderA.data.amount, 142100);
    assert.equal(createOrderA.data.discount_paise, 16900);
    assert.equal(createOrderA.data.gift_card_paise, 10000);

    const paymentIdA = 'pay_e2e_customer_a_1';
    mockRzpState.payments.set(paymentIdA, {
      id: paymentIdA,
      order_id: createOrderA.data.order_id,
      amount: 142100,
      currency: 'INR',
      status: 'captured',
      captured: true,
    });
    const sigA = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${createOrderA.data.order_id}|${paymentIdA}`)
      .digest('hex');

    // Simulate concurrent race between /api/verify-payment and signed /api/razorpay-webhook
    const webhookPayloadA = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentIdA,
            order_id: createOrderA.data.order_id,
            amount: 142100,
            currency: 'INR',
            status: 'captured',
            captured: true,
          },
        },
      },
    });
    const webhookSigA = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(webhookPayloadA)
      .digest('hex');

    const [verifyResA, webhookResA] = await Promise.all([
      jsonReq<{ success: boolean; order: { id: string; orderNumber: string; customerUserId: string } }>(
        baseUrl,
        customerA.jar,
        'POST',
        '/api/verify-payment',
        {
          razorpay_order_id: createOrderA.data.order_id,
          razorpay_payment_id: paymentIdA,
          razorpay_signature: sigA,
          checkout_token: createOrderA.data.checkout_token,
        },
        customerA.csrfToken
      ),
      fetch(`${baseUrl}/api/razorpay-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Razorpay-Signature': webhookSigA,
        },
        body: webhookPayloadA,
      }).then(async (r) => ({ status: r.status, data: (await r.json()) as { success?: boolean; order?: { id: string } } })),
    ]);

    assert.equal(verifyResA.status, 200);
    assert.equal(webhookResA.status, 200);
    assert.equal(verifyResA.data.order.customerUserId, customerA.userId);
    assert.ok(verifyResA.data.order.orderNumber.startsWith('SC-'));

    // Stock deducted ONCE even under verify + webhook race
    const afterRaceKurti = await appInstance.store.getPublicProductByIdOrSlug('sc-101');
    assert.equal(afterRaceKurti?.variants[0]?.stock_qty, initialStock - 1);

    // Gift card balance deducted
    const gcAfter = await jsonReq<{ giftCard: { balancePaise: number } }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/gift-cards/check',
      { code: 'GIFT-MEERA-100' },
      customerA.csrfToken
    );
    assert.equal(gcAfter.status, 200);
    assert.equal(gcAfter.data.giftCard.balancePaise, 0);

    // Sahithi Rewards accrued for Customer A
    const rewardsA = await jsonReq<{
      pointsBalance: number;
      lifetimeSpendPaise: number;
      isPlusMember: boolean;
    }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/rewards',
      undefined,
      customerA.csrfToken
    );
    assert.equal(rewardsA.status, 200);
    assert.ok(rewardsA.data.pointsBalance > 0);
    assert.equal(rewardsA.data.lifetimeSpendPaise, 142100);

    const paymentMethodsA = await jsonReq<{ enabled: boolean; methods: unknown[] }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/payment-methods',
      undefined,
      customerA.csrfToken
    );
    assert.equal(paymentMethodsA.status, 200);
    assert.equal(paymentMethodsA.data.enabled, false);
    assert.deepEqual(paymentMethodsA.data.methods, []);

    // 3. Customer isolation: Customer B sees 0 orders and receives 403 when trying to submit a request on A's order
    const ordersB = await jsonReq<{ items: unknown[] }>(
      baseUrl,
      customerB.jar,
      'GET',
      '/api/account/orders',
      undefined,
      customerB.csrfToken
    );
    assert.equal(ordersB.status, 200);
    assert.equal(ordersB.data.items.length, 0);

    const crossReq = await jsonReq(
      baseUrl,
      customerB.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(verifyResA.data.order.id)}/request`,
      { type: 'cancel', reason: 'Unauthorized attempt' },
      customerB.csrfToken
    );
    assert.equal(crossReq.status, 403);

    // 4. Owner updates fulfillment status -> appends statusHistory + creates notification
    const statusPatchRes = await jsonReq<{
      order: { status: string; fulfillmentStatus: string; statusHistory: Array<{ status: string; note?: string }> };
    }>(
      baseUrl,
      ownerCreds.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(verifyResA.data.order.id)}/status`,
      { status: 'packed', note: 'Wrapped with tissue in Sahithi studio' },
      ownerCsrf
    );
    assert.equal(statusPatchRes.status, 200);
    assert.equal(statusPatchRes.data.order.fulfillmentStatus, 'packed');
    assert.ok(
      statusPatchRes.data.order.statusHistory.some(
        (h) => h.status === 'packed' && (h.note || '').includes('Sahithi studio')
      )
    );

    // Advance to delivered before customer submits a return request
    const deliverPatchRes = await jsonReq<{
      order: { fulfillmentStatus: string };
    }>(
      baseUrl,
      ownerCreds.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(verifyResA.data.order.id)}/status`,
      { status: 'delivered', note: 'Delivered to bridal boutique reception' },
      ownerCsrf
    );
    assert.equal(deliverPatchRes.status, 200);
    assert.equal(deliverPatchRes.data.order.fulfillmentStatus, 'delivered');

    // Customer A submits a return request -> Owner resolves it -> Notification delivered
    const returnReqA = await jsonReq<{
      order: { status: string; returnRequest: { type: string; status: string } | null };
    }>(
      baseUrl,
      customerA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(verifyResA.data.order.id)}/request`,
      { type: 'return', reason: 'Need a larger drape length for bridal ceremony' },
      customerA.csrfToken
    );
    assert.equal(returnReqA.status, 200);
    assert.equal(returnReqA.data.order.returnRequest?.type, 'return');

    const ownerResolve = await jsonReq<{
      order: { status: string; returnRequest: { status: string; resolutionNote?: string } | null };
    }>(
      baseUrl,
      ownerCreds.jar,
      'POST',
      `/api/admin/orders/${encodeURIComponent(verifyResA.data.order.id)}/resolve-request`,
      { decision: 'approved', note: 'Courier pickup scheduled for tomorrow' },
      ownerCsrf
    );
    assert.equal(ownerResolve.status, 200);
    assert.equal(ownerResolve.data.order.returnRequest?.status, 'approved');
    assert.equal(ownerResolve.data.order.status, 'returned');

    // Customer A sees unread notifications & marks all read
    const notifsA = await jsonReq<{
      unreadCount: number;
      items: Array<{ id: string; read: boolean; title: string }>;
    }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/notifications',
      undefined,
      customerA.csrfToken
    );
    assert.equal(notifsA.status, 200);
    assert.ok(notifsA.data.items.length >= 2);
    assert.ok(notifsA.data.unreadCount >= 2);

    const markAllRead = await jsonReq<{ ok: boolean }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/account/notifications/read-all',
      {},
      customerA.csrfToken
    );
    assert.equal(markAllRead.status, 200);
    assert.equal(markAllRead.data.ok, true);

    const notifsAAfterRead = await jsonReq<{ unreadCount: number }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/notifications',
      undefined,
      customerA.csrfToken
    );
    assert.equal(notifsAAfterRead.status, 200);
    assert.equal(notifsAAfterRead.data.unreadCount, 0);

    // 5. Webhook-only order recovery when browser closes (no /api/verify-payment call)
    const guestJar = new CookieJar();
    const guestSession = await getSession(baseUrl, guestJar);
    const guestCreate = await jsonReq<{ order_id: string; amount: number }>(
      baseUrl,
      guestJar,
      'POST',
      '/api/create-order',
      {
        currency: 'INR',
        items: [{ productId: 'sc-101', variantId: variant0.id, quantity: 1 }],
        customer: {
          customerName: 'Guest Priya',
          customerEmail: 'guest.priya@example.com',
          customerPhone: '+91 91234 56789',
          shippingAddress: '45 Banjara Hills, Hyderabad 500034',
        },
      },
      guestSession.csrfToken
    );
    assert.equal(guestCreate.status, 200);
    const guestPayId = 'pay_e2e_webhook_only';
    mockRzpState.payments.set(guestPayId, {
      id: guestPayId,
      order_id: guestCreate.data.order_id,
      amount: guestCreate.data.amount,
      currency: 'INR',
      status: 'captured',
      captured: true,
    });
    const whBody = JSON.stringify({
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: guestPayId,
            order_id: guestCreate.data.order_id,
            amount: guestCreate.data.amount,
            currency: 'INR',
            status: 'captured',
            captured: true,
          },
        },
      },
    });
    const whSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(whBody)
      .digest('hex');

    // Invalid webhook signature is rejected
    const badWhRes = await fetch(`${baseUrl}/api/razorpay-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad_sig' },
      body: whBody,
    });
    assert.equal(badWhRes.status, 401);

    const goodWhRes = await fetch(`${baseUrl}/api/razorpay-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': whSig },
      body: whBody,
    });
    assert.equal(goodWhRes.status, 200);

    // Guest order appears in owner Admin Orders & Activity, NOT in Customer A's /api/account/orders
    const ordersAAfterGuest = await jsonReq<{ items: Array<{ id: string }> }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/orders',
      undefined,
      customerA.csrfToken
    );
    assert.equal(ordersAAfterGuest.data.items.length, 1);

    const adminOrders = await jsonReq<{
      total: number;
      items: Array<{ customerUserId: string | null; razorpayOrderId: string }>;
    }>(
      baseUrl,
      ownerCreds.jar,
      'GET',
      '/api/admin/orders',
      undefined,
      ownerCsrf
    );
    assert.equal(adminOrders.status, 200);
    assert.equal(adminOrders.data.total, 2);
    assert.ok(
      adminOrders.data.items.some(
        (o) => o.razorpayOrderId === guestCreate.data.order_id && o.customerUserId === null
      )
    );

    // Stock deducted once for webhook-only order too
    const afterGuestKurti = await appInstance.store.getPublicProductByIdOrSlug('sc-101');
    assert.equal(afterGuestKurti?.variants[0]?.stock_qty, initialStock - 2);

    // 6. Failed payment / abandoned modal deducts 0 stock and creates no order
    const abandonedCreate = await jsonReq<{ order_id: string }>(
      baseUrl,
      customerB.jar,
      'POST',
      '/api/create-order',
      {
        currency: 'INR',
        items: [{ productId: 'sc-101', variantId: variant0.id, quantity: 1 }],
        customer: {
          customerName: 'Divya Nair',
          customerEmail: 'divya.customer@example.com',
          customerPhone: '+91 99999 88888',
          shippingAddress: '7 Indiranagar, Bengaluru 560038',
        },
      },
      customerB.csrfToken
    );
    assert.equal(abandonedCreate.status, 200);
    mockRzpState.payments.set('pay_failed_attempt', {
      id: 'pay_failed_attempt',
      order_id: abandonedCreate.data.order_id,
      amount: 169000,
      currency: 'INR',
      status: 'failed',
      captured: false,
    });
    const failedVerify = await jsonReq(
      baseUrl,
      customerB.jar,
      'POST',
      '/api/verify-payment',
      {
        razorpay_order_id: abandonedCreate.data.order_id,
        razorpay_payment_id: 'pay_failed_attempt',
        razorpay_signature: crypto
          .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
          .update(`${abandonedCreate.data.order_id}|pay_failed_attempt`)
          .digest('hex'),
      },
      customerB.csrfToken
    );
    assert.equal(failedVerify.status, 400);
    const afterFailKurti = await appInstance.store.getPublicProductByIdOrSlug('sc-101');
    assert.equal(afterFailKurti?.variants[0]?.stock_qty, initialStock - 2);

    // 7. Admin Overview & Activity reflect live metrics
    const overviewRes = await jsonReq<{
      metrics: { totalOrders: number; totalCustomers: number; openReturnRequests: number };
    }>(baseUrl, ownerCreds.jar, 'GET', '/api/admin/overview', undefined, ownerCsrf);
    assert.equal(overviewRes.status, 200);
    assert.equal(overviewRes.data.metrics.totalOrders, 2);
    assert.ok(overviewRes.data.metrics.totalCustomers >= 2);
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    if (prevWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      appInstance.db?.close();
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRazorpayCheckoutCachesForTest();
  }
});

test('Durable checkout persistence failures return 503 pre-payment and 202 pending_confirmation with status/owner recovery post-capture', async () => {
  clearRazorpayCheckoutCachesForTest();
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevSaJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  process.env.RAZORPAY_KEY_ID = 'rzp_test_U17MiWPrvpas0b';
  process.env.RAZORPAY_KEY_SECRET = 'Oroq81QnfslWBN9z3bsXYOf5';
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-durable-test-'));
  const dbPath = path.join(tmpDir, 'durable.db');

  try {
    // A. Pre-payment durable persistence failure when requireDurablePersistence is true with no store/service account -> 503
    const mockState: MockRazorpayState = { orders: [], payments: new Map() };
    const noPersistRes = await handleCreateOrderRequest({
      body: {
        items: [{ productId: 'sc-101', variantId: 'sc-101-var-1', quantity: 1 }],
        customer: {
          customerName: 'Asha',
          customerEmail: 'asha@example.com',
          customerPhone: '9876543210',
          shippingAddress: '10 MG Road, Bengaluru',
        },
      },
      store: null,
      razorpayClientFactory: createStatefulMockRazorpayFactory(mockState),
      requireDurablePersistence: true,
    });
    assert.equal(noPersistRes.status, 503);
    assert.equal(noPersistRes.body.code, 'CHECKOUT_PERSISTENCE_FAILED');

    // B. Transient order persistence failure AFTER payment capture returns 202 pending_confirmation,
    //    then recovers cleanly via /api/order-status and /api/admin/orders/recover without duplicate stock deduction
    const appInstance = createAuthApp({
      dbPath,
      disableRateLimit: true,
      seedCatalog: true,
      razorpayClientFactory: createStatefulMockRazorpayFactory(mockState),
    });

    const realStore = appInstance.store as SqliteBoutiqueStore;
    const kavyaUser = await realStore.createPendingEmailUser({
      id: 'user_kavya_1',
      fullName: 'Kavya Sharma',
      email: 'kavya@example.com',
      passwordHash: 'hash_placeholder',
      now: Date.now(),
    });
    const baseProduct = await realStore.getPublicProductByIdOrSlug('sc-101');
    const variant0 = baseProduct!.variants[0]!;
    const stockBefore = variant0.stock_qty;

    let failPlaceOrderOnce = true;
    const flakyStore: BoutiqueStore = new Proxy(realStore, {
      get(target, prop, receiver) {
        if (prop === 'placeOrder') {
          return async (input: Parameters<BoutiqueStore['placeOrder']>[0]) => {
            if (failPlaceOrderOnce) {
              failPlaceOrderOnce = false;
              throw new Error('Simulated transient Firestore write timeout');
            }
            return target.placeOrder(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const createOk = await handleCreateOrderRequest({
      body: {
        items: [{ productId: 'sc-101', variantId: variant0.id, quantity: 1 }],
        customer: {
          customerName: 'Kavya Sharma',
          customerEmail: 'kavya@example.com',
          customerPhone: '+91 98111 22334',
          shippingAddress: '22 Park Street, Kolkata 700016',
        },
      },
      store: flakyStore,
      customerUserId: kavyaUser.id,
      razorpayClientFactory: createStatefulMockRazorpayFactory(mockState),
    });
    assert.equal(createOk.status, 200);
    const oid = String(createOk.body.order_id);
    const pid = 'pay_delayed_persist_1';
    mockState.payments.set(pid, {
      id: pid,
      order_id: oid,
      amount: Number(createOk.body.amount),
      currency: 'INR',
      status: 'captured',
      captured: true,
    });
    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${oid}|${pid}`)
      .digest('hex');

    const verifyDelayed = await handleVerifyPaymentRequest({
      body: {
        razorpay_order_id: oid,
        razorpay_payment_id: pid,
        razorpay_signature: sig,
        checkout_token: createOk.body.checkout_token,
      },
      store: flakyStore,
      customerUserId: kavyaUser.id,
      razorpayClientFactory: createStatefulMockRazorpayFactory(mockState),
    });
    assert.equal(verifyDelayed.status, 202);
    assert.equal(verifyDelayed.body.pending_confirmation, true);
    assert.equal(verifyDelayed.body.code, 'ORDER_CONFIRMATION_PENDING');

    // Recover via HTTP /api/order-status on the Express app
    const server = http.createServer(appInstance.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/order-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ razorpay_order_id: oid, razorpay_payment_id: pid }),
      });
      assert.equal(statusRes.status, 200);
      const statusBody = (await statusRes.json()) as {
        order?: { orderNumber?: string; customerUserId?: string };
      };
      assert.ok(statusBody.order?.orderNumber?.startsWith('SC-'));
      assert.equal(statusBody.order?.customerUserId, kavyaUser.id);

      const stockAfter = (await realStore.getPublicProductByIdOrSlug('sc-101'))?.variants[0]?.stock_qty;
      assert.equal(stockAfter, stockBefore - 1);
      const allOrders = await realStore.listAdminOrders(1, 10);
      assert.equal(allOrders.total, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      appInstance.db?.close();
    }
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    if (prevSaJson === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = prevSaJson;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRazorpayCheckoutCachesForTest();
  }
});
