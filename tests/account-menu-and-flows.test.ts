import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ACCOUNT_LOGOUT_ITEM,
  ACCOUNT_MENU_ITEMS,
  buildAccountSectionPath,
  isValidAccountSection,
  parseAccountSection,
} from '../src/config/accountMenu.ts';
import { sanitizeNextPath } from '../src/hooks/useBoutiqueRouter.ts';
import { createAuthApp } from '../server/app.ts';
import { bindOwnerAccount } from '../server/db.ts';
import type { EmailMessage } from '../server/providers.ts';
import {
  clearRazorpayCheckoutCachesForTest,
  type RazorpayClientFactory,
  type RazorpayClientLike,
  type RazorpayPaymentEntity,
} from '../server/razorpay-checkout.ts';

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
    user: { id: string; email: string; fullName: string; isOwner?: boolean } | null;
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

  session = await getSession(baseUrl, jar);
  let currentCsrf = session.csrfToken;
  if (!session.authenticated) {
    const loginRes = await jsonReq<{ csrfToken?: string }>(
      baseUrl,
      jar,
      'POST',
      '/api/auth/login',
      { email, password },
      currentCsrf
    );
    assert.equal(loginRes.status, 200);
    session = await getSession(baseUrl, jar);
    currentCsrf = session.csrfToken;
  }

  assert.equal(session.authenticated, true);
  assert.ok(session.user?.id);
  return { jar, csrfToken: currentCsrf, userId: session.user.id };
}

test('Shared account menu config matches required order, icons, routes, and safe next redirects', () => {
  assert.deepEqual(
    ACCOUNT_MENU_ITEMS.map((item) => item.label),
    [
      'My Profile',
      'Orders',
      'Coupons',
      'Sahithi Rewards',
      'Sahithi Plus',
      'Saved Cards & Wallet',
      'Saved Addresses',
      'Wishlist',
      'Gift Cards',
      'Notifications',
    ]
  );
  assert.equal(ACCOUNT_LOGOUT_ITEM.label, 'Logout');
  assert.ok(ACCOUNT_LOGOUT_ITEM.icon);

  for (const item of ACCOUNT_MENU_ITEMS) {
    assert.ok(item.icon, `Expected icon on ${item.label}`);
    assert.equal(item.href, buildAccountSectionPath(item.id));
    assert.equal(isValidAccountSection(item.id), true);
    assert.equal(parseAccountSection(item.id), item.id);
  }

  assert.equal(parseAccountSection('unknown-section'), 'profile');
  assert.equal(parseAccountSection(null), 'profile');
  assert.equal(buildAccountSectionPath('orders'), '/account?section=orders');

  assert.equal(sanitizeNextPath('/account?section=orders', '/account'), '/account?section=orders');
  assert.equal(sanitizeNextPath('https://evil.example/phish', '/account'), '/account');
  assert.equal(sanitizeNextPath('//evil.example/phish', '/account'), '/account');
});

test('Customer account sections integrate profile, COD & Razorpay orders, coupon usage limits, gift cards, rewards, addresses, wishlist isolation & notifications', async () => {
  clearRazorpayCheckoutCachesForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-account-menu-flows-'));
  const dbPath = path.join(tmpDir, 'boutique.db');
  const sentEmails: EmailMessage[] = [];

  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevTok = process.env.RAZORPAY_TOKENIZATION_ENABLED;

  process.env.RAZORPAY_KEY_ID = 'rzp_test_U17MiWPrvpas0b';
  process.env.RAZORPAY_KEY_SECRET = 'Oroq81QnfslWBN9z3bsXYOf5';
  delete process.env.RAZORPAY_TOKENIZATION_ENABLED;

  const rzpOrders: Array<{ id: string; amount: number; currency: string; receipt: string }> = [];
  const rzpPayments = new Map<string, RazorpayPaymentEntity>();
  const mockFactory: RazorpayClientFactory = (): RazorpayClientLike => ({
    orders: {
      async create(params) {
        const rec = {
          id: `order_menu_${rzpOrders.length + 1}`,
          amount: params.amount,
          currency: params.currency,
          receipt: params.receipt,
        };
        rzpOrders.push(rec);
        return { ...rec, status: 'created' };
      },
      async fetch(orderId) {
        const found = rzpOrders.find((o) => o.id === orderId);
        return {
          id: orderId,
          amount: found?.amount ?? 169000,
          currency: found?.currency ?? 'INR',
          receipt: found?.receipt ?? 'rcpt_menu',
          status: 'paid',
        };
      },
      async fetchPayments(orderId) {
        return {
          items: Array.from(rzpPayments.values()).filter((p) => p.order_id === orderId),
        };
      },
    },
    payments: {
      async fetch(paymentId) {
        const existing = rzpPayments.get(paymentId);
        if (existing) return existing;
        const latest = rzpOrders[rzpOrders.length - 1];
        return {
          id: paymentId,
          order_id: latest?.id ?? 'order_menu_1',
          amount: latest?.amount ?? 169000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        };
      },
      async capture(paymentId, amount, currency) {
        const updated: RazorpayPaymentEntity = {
          id: paymentId,
          order_id: rzpOrders[rzpOrders.length - 1]?.id ?? 'order_menu_1',
          amount,
          currency,
          status: 'captured',
          captured: true,
        };
        rzpPayments.set(paymentId, updated);
        return updated;
      },
    },
  });

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
    razorpayClientFactory: mockFactory,
  });

  const server = http.createServer(appInstance.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const owner = await registerVerifyAndLogin({
      baseUrl,
      email: 'owner.menu@sahithidesigns.online',
      fullName: 'Sahithi Owner',
      password: 'OwnerPass!2026',
      sentEmails,
    });
    bindOwnerAccount(appInstance.db!, {
      email: 'owner.menu@sahithidesigns.online',
      boundVia: 'cli_setup',
    });
    const ownerLogin = await jsonReq(
      baseUrl,
      owner.jar,
      'POST',
      '/api/admin/login',
      { email: 'owner.menu@sahithidesigns.online', password: 'OwnerPass!2026' },
      owner.csrfToken
    );
    assert.equal(ownerLogin.status, 200);
    const ownerCsrf = (await getSession(baseUrl, owner.jar)).csrfToken;

    const custA = await registerVerifyAndLogin({
      baseUrl,
      email: 'ananya.menu@example.com',
      fullName: 'Ananya Verma',
      password: 'AnanyaPass!2026',
      sentEmails,
    });
    const custB = await registerVerifyAndLogin({
      baseUrl,
      email: 'rohini.menu@example.com',
      fullName: 'Rohini Desai',
      password: 'RohiniPass!2026',
      sentEmails,
    });

    // 1. My Profile persistence
    const patchProfile = await jsonReq<{ user: { fullName: string } }>(
      baseUrl,
      custA.jar,
      'PATCH',
      '/api/account/profile',
      { fullName: 'Ananya Verma-Reddy' },
      custA.csrfToken
    );
    assert.equal(patchProfile.status, 200);
    assert.equal(patchProfile.data.user.fullName, 'Ananya Verma-Reddy');
    const reloadedSession = await getSession(baseUrl, custA.jar);
    assert.equal(reloadedSession.user?.fullName, 'Ananya Verma-Reddy');

    // 2. Coupons: create active single-use coupon + expired coupon + high-min-spend coupon
    const onceCpn = await jsonReq(
      baseUrl,
      owner.jar,
      'POST',
      '/api/admin/coupons',
      {
        code: 'ONCE50',
        title: 'Flat ₹50 Once',
        description: 'Valid once per customer on ₹500+',
        discountType: 'flat_paise',
        discountValue: 5000,
        minSpendPaise: 50000,
        usageLimit: 1,
        active: true,
      },
      ownerCsrf
    );
    assert.equal(onceCpn.status, 200);

    const expCpn = await jsonReq(
      baseUrl,
      owner.jar,
      'POST',
      '/api/admin/coupons',
      {
        code: 'EXPIRED20',
        title: 'Expired Offer',
        description: 'Past end date',
        discountType: 'flat_paise',
        discountValue: 2000,
        minSpendPaise: 10000,
        expiresAt: Date.now() - 86_400_000,
        active: true,
      },
      ownerCsrf
    );
    assert.equal(expCpn.status, 200);

    const highCpn = await jsonReq(
      baseUrl,
      owner.jar,
      'POST',
      '/api/admin/coupons',
      {
        code: 'HIGHSPEND',
        title: 'High Spend',
        description: 'Requires ₹9000+',
        discountType: 'flat_paise',
        discountValue: 50000,
        minSpendPaise: 900000,
        active: true,
      },
      ownerCsrf
    );
    assert.equal(highCpn.status, 200);

    const activeCoupons = await jsonReq<{ items: Array<{ code: string }> }>(
      baseUrl,
      custA.jar,
      'GET',
      '/api/account/coupons',
      undefined,
      custA.csrfToken
    );
    assert.equal(activeCoupons.status, 200);
    assert.ok(activeCoupons.data.items.some((c) => c.code === 'ONCE50'));
    assert.equal(
      activeCoupons.data.items.some((c) => c.code === 'EXPIRED20'),
      false,
      'Expired coupon should not appear in customer coupons list'
    );

    // Gift card for Ananya
    const gcCreate = await jsonReq(
      baseUrl,
      owner.jar,
      'POST',
      '/api/admin/gift-cards',
      {
        code: 'GC-ANANYA-200',
        initialBalancePaise: 20000,
        recipientEmail: 'ananya.menu@example.com',
        active: true,
      },
      ownerCsrf
    );
    assert.equal(gcCreate.status, 200);

    const product = await appInstance.store.getPublicProductByIdOrSlug('sc-101');
    assert.ok(product && product.variants[0]);
    const variant0 = product.variants[0];
    const startStock = variant0.stock_qty;

    // 3. COD checkout with ONCE50 + GC-ANANYA-200 and idempotency retry protection
    const codKey = 'cod-retry-key-ananya-1';
    const codPayload = {
      items: [{ productId: 'sc-101', variantId: variant0.id, quantity: 1 }],
      couponCode: 'ONCE50',
      giftCardCode: 'GC-ANANYA-200',
      idempotencyKey: codKey,
      customer: {
        customerName: 'Ananya Verma-Reddy',
        customerEmail: 'ananya.menu@example.com',
        customerPhone: '+91 98480 99887',
        shippingAddress: '12 Film Nagar, Hyderabad, Telangana 500096',
      },
    };
    const cod1 = await jsonReq<{
      order: {
        id: string;
        orderNumber: string;
        paymentMethod: string;
        paymentStatus: string;
        fulfillmentStatus: string;
        totalPaise: number;
      };
    }>(baseUrl, custA.jar, 'POST', '/api/orders', codPayload, custA.csrfToken);
    assert.equal(cod1.status, 201);
    assert.equal(cod1.data.order.paymentMethod, 'cod');
    assert.equal(cod1.data.order.paymentStatus, 'unpaid');
    assert.equal(cod1.data.order.fulfillmentStatus, 'placed');

    // Retry with same idempotencyKey must NOT create a second order or fail ONCE50 usage limit
    const codRetry = await jsonReq<{
      duplicate?: boolean;
      order: { id: string; orderNumber: string };
    }>(baseUrl, custA.jar, 'POST', '/api/orders', codPayload, custA.csrfToken);
    assert.equal(codRetry.status, 200);
    assert.equal(codRetry.data.duplicate, true);
    assert.equal(codRetry.data.order.id, cod1.data.order.id);

    // Stock only deducted once
    const stockAfterCod = (await appInstance.store.getPublicProductByIdOrSlug('sc-101'))?.variants[0]?.stock_qty;
    assert.equal(stockAfterCod, startStock - 1);

    // Second separate order reusing ONCE50 must fail eligibility (limit reached); expired & high-spend fail too
    const reuseOnce50 = await jsonReq<{ error: string }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/orders',
      {
        ...codPayload,
        giftCardCode: undefined,
        idempotencyKey: 'cod-second-attempt-ananya',
      },
      custA.csrfToken
    );
    assert.equal(reuseOnce50.status, 400);

    const expiredCod = await jsonReq(
      baseUrl,
      custA.jar,
      'POST',
      '/api/orders',
      {
        ...codPayload,
        couponCode: 'EXPIRED20',
        giftCardCode: undefined,
        idempotencyKey: 'cod-expired-attempt',
      },
      custA.csrfToken
    );
    assert.equal(expiredCod.status, 400);

    const highSpendCod = await jsonReq(
      baseUrl,
      custA.jar,
      'POST',
      '/api/orders',
      {
        ...codPayload,
        couponCode: 'HIGHSPEND',
        giftCardCode: undefined,
        idempotencyKey: 'cod-highspend-attempt',
      },
      custA.csrfToken
    );
    assert.equal(highSpendCod.status, 400);

    // 4. Online Razorpay order for Ananya alongside COD order
    const rzpCreate = await jsonReq<{
      order_id: string;
      amount: number;
      checkout_token: string;
    }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/create-order',
      {
        currency: 'INR',
        items: [{ productId: 'sc-101', variantId: variant0.id, quantity: 1 }],
        customer: codPayload.customer,
      },
      custA.csrfToken
    );
    assert.equal(rzpCreate.status, 200);
    const rzpPayId = 'pay_ananya_menu_1';
    rzpPayments.set(rzpPayId, {
      id: rzpPayId,
      order_id: rzpCreate.data.order_id,
      amount: rzpCreate.data.amount,
      currency: 'INR',
      status: 'captured',
      captured: true,
    });
    const rzpSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${rzpCreate.data.order_id}|${rzpPayId}`)
      .digest('hex');
    const rzpVerify = await jsonReq<{
      order: { id: string; paymentMethod: string; paymentStatus: string };
    }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/verify-payment',
      {
        razorpay_order_id: rzpCreate.data.order_id,
        razorpay_payment_id: rzpPayId,
        razorpay_signature: rzpSig,
        checkout_token: rzpCreate.data.checkout_token,
      },
      custA.csrfToken
    );
    assert.equal(rzpVerify.status, 200);
    assert.equal(rzpVerify.data.order.paymentMethod, 'razorpay');
    assert.equal(rzpVerify.data.order.paymentStatus, 'paid');

    // Customer Orders and Admin Orders match in fields and records
    const custOrders = await jsonReq<{
      items: Array<{ id: string; orderNumber: string; paymentMethod: string; paymentStatus: string }>;
    }>(baseUrl, custA.jar, 'GET', '/api/account/orders', undefined, custA.csrfToken);
    const adminOrders = await jsonReq<{
      items: Array<{ id: string; orderNumber: string; paymentMethod: string; paymentStatus: string }>;
    }>(baseUrl, owner.jar, 'GET', '/api/admin/orders', undefined, ownerCsrf);
    assert.equal(custOrders.data.items.length, 2);
    assert.equal(adminOrders.data.items.length, 2);
    assert.deepEqual(
      custOrders.data.items.map((o) => o.orderNumber).sort(),
      adminOrders.data.items.map((o) => o.orderNumber).sort()
    );

    // Owner updates COD fulfillment to delivered (does NOT auto-mark payment collected)
    const deliverCod = await jsonReq<{
      order: { paymentStatus: string; fulfillmentStatus: string };
    }>(
      baseUrl,
      owner.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(cod1.data.order.id)}/status`,
      { status: 'delivered', note: 'Delivered to security desk' },
      ownerCsrf
    );
    assert.equal(deliverCod.status, 200);
    assert.equal(deliverCod.data.order.fulfillmentStatus, 'delivered');
    assert.equal(deliverCod.data.order.paymentStatus, 'unpaid');

    // Owner marks COD payment collected -> points/rewards now include COD + Razorpay spend
    const collectCod = await jsonReq<{
      order: { paymentStatus: string; fulfillmentStatus: string };
    }>(
      baseUrl,
      owner.jar,
      'POST',
      `/api/admin/orders/${encodeURIComponent(cod1.data.order.id)}/collect-payment`,
      { note: 'Cash verified' },
      ownerCsrf
    );
    assert.equal(collectCod.status, 200);
    assert.equal(collectCod.data.order.paymentStatus, 'paid');

    const rewardsA = await jsonReq<{
      pointsBalance: number;
      lifetimeSpendPaise: number;
    }>(baseUrl, custA.jar, 'GET', '/api/account/rewards', undefined, custA.csrfToken);
    assert.equal(rewardsA.status, 200);
    assert.equal(
      rewardsA.data.lifetimeSpendPaise,
      cod1.data.order.totalPaise + rzpCreate.data.amount
    );

    // 5. Saved Cards & Wallet availability flag
    const payMethodsDefault = await jsonReq<{ enabled: boolean }>(
      baseUrl,
      custA.jar,
      'GET',
      '/api/account/payment-methods',
      undefined,
      custA.csrfToken
    );
    assert.equal(payMethodsDefault.data.enabled, false);
    process.env.RAZORPAY_TOKENIZATION_ENABLED = 'true';
    const payMethodsEnabled = await jsonReq<{ enabled: boolean }>(
      baseUrl,
      custA.jar,
      'GET',
      '/api/account/payment-methods',
      undefined,
      custA.csrfToken
    );
    assert.equal(payMethodsEnabled.data.enabled, true);

    // 6. Saved Addresses default promotion on delete
    const addr1 = await jsonReq<{ address: { id: string; isDefault: boolean } }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/account/addresses',
      {
        label: 'Home',
        fullName: 'Ananya',
        phone: '9848099887',
        line1: '12 Film Nagar',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500096',
        isDefault: true,
      },
      custA.csrfToken
    );
    const addr2 = await jsonReq<{ address: { id: string; isDefault: boolean } }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/account/addresses',
      {
        label: 'Studio',
        fullName: 'Ananya',
        phone: '9848099887',
        line1: '45 Jubilee Hills',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500033',
        isDefault: false,
      },
      custA.csrfToken
    );
    assert.equal(addr1.data.address.isDefault, true);
    assert.equal(addr2.data.address.isDefault, false);

    const delAddr1 = await jsonReq(
      baseUrl,
      custA.jar,
      'DELETE',
      `/api/account/addresses/${encodeURIComponent(addr1.data.address.id)}`,
      undefined,
      custA.csrfToken
    );
    assert.equal(delAddr1.status, 200);
    const remainingAddrs = await jsonReq<{ items: Array<{ id: string; isDefault: boolean }> }>(
      baseUrl,
      custA.jar,
      'GET',
      '/api/account/addresses',
      undefined,
      custA.csrfToken
    );
    assert.equal(remainingAddrs.data.items.length, 1);
    assert.equal(remainingAddrs.data.items[0]?.id, addr2.data.address.id);
    assert.equal(remainingAddrs.data.items[0]?.isDefault, true);

    // 7. Wishlist deletion sync & user isolation
    await jsonReq(
      baseUrl,
      custA.jar,
      'PUT',
      '/api/account/wishlist',
      { productIds: ['sc-101', 'sc-004'] },
      custA.csrfToken
    );
    await jsonReq(
      baseUrl,
      custA.jar,
      'PUT',
      '/api/account/wishlist',
      { productIds: ['sc-101'] },
      custA.csrfToken
    );
    const wishA = await jsonReq<{ productIds: string[] }>(
      baseUrl,
      custA.jar,
      'GET',
      '/api/account/wishlist',
      undefined,
      custA.csrfToken
    );
    assert.deepEqual(wishA.data.productIds, ['sc-101']);
    const wishB = await jsonReq<{ productIds: string[] }>(
      baseUrl,
      custB.jar,
      'GET',
      '/api/account/wishlist',
      undefined,
      custB.csrfToken
    );
    assert.deepEqual(wishB.data.productIds, []);

    // 8. Gift card balance check after COD deduction (20000 - remaining -> 0)
    const gcCheck = await jsonReq<{ giftCard: { balancePaise: number } }>(
      baseUrl,
      custA.jar,
      'POST',
      '/api/gift-cards/check',
      { code: 'GC-ANANYA-200' },
      custA.csrfToken
    );
    assert.equal(gcCheck.status, 200);
    assert.equal(gcCheck.data.giftCard.balancePaise, 0);

    // 9. Notifications mark single read + mark all read
    const notifsBefore = await jsonReq<{
      unreadCount: number;
      items: Array<{ id: string; read: boolean }>;
    }>(baseUrl, custA.jar, 'GET', '/api/account/notifications', undefined, custA.csrfToken);
    assert.equal(notifsBefore.status, 200);
    assert.ok(notifsBefore.data.items.length >= 2);
    const firstId = notifsBefore.data.items[0]!.id;
    const markOne = await jsonReq<{ ok: boolean }>(
      baseUrl,
      custA.jar,
      'PATCH',
      `/api/account/notifications/${encodeURIComponent(firstId)}/read`,
      {},
      custA.csrfToken
    );
    assert.equal(markOne.status, 200);
    const notifsMid = await jsonReq<{ unreadCount: number }>(
      baseUrl,
      custA.jar,
      'GET',
      '/api/account/notifications',
      undefined,
      custA.csrfToken
    );
    assert.equal(notifsMid.data.unreadCount, notifsBefore.data.unreadCount - 1);

    await jsonReq(
      baseUrl,
      custA.jar,
      'POST',
      '/api/account/notifications/read-all',
      {},
      custA.csrfToken
    );
    const notifsEnd = await jsonReq<{ unreadCount: number }>(
      baseUrl,
      custA.jar,
      'GET',
      '/api/account/notifications',
      undefined,
      custA.csrfToken
    );
    assert.equal(notifsEnd.data.unreadCount, 0);
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    if (prevTok === undefined) delete process.env.RAZORPAY_TOKENIZATION_ENABLED;
    else process.env.RAZORPAY_TOKENIZATION_ENABLED = prevTok;

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
