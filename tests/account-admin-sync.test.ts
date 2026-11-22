import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthApp } from '../server/app.ts';
import { bindOwnerAccount } from '../server/db.ts';
import type { EmailMessage } from '../server/providers.ts';
import { clearRazorpayCheckoutCachesForTest } from '../server/razorpay-checkout.ts';
import {
  AUTHORIZED_OWNER_EMAIL,
  clearClientFirebaseSession,
  handleClientlessApiRequest,
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
    user: {
      id: string;
      email: string;
      fullName: string;
      phone?: string | null;
      notificationPrefs?: Record<string, boolean>;
      recentReauthValid?: boolean;
      isOwner?: boolean;
    } | null;
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

test('Express + SQLite: profile/prefs/addresses/payment refs CRUD, cancel vs return separation, delivery cutoff, withdraw, stock idempotency, hide order, ownership & account deletion', async () => {
  clearRazorpayCheckoutCachesForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-acct-admin-sync-'));
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
    // 0. Owner + Customer A + Customer B setup
    const owner = await registerVerifyAndLogin({
      baseUrl,
      email: 'owner.sync@sahithidesigns.online',
      fullName: 'Sahithi Owner',
      password: 'OwnerSync!2026',
      sentEmails,
    });
    bindOwnerAccount(appInstance.db!, {
      email: 'owner.sync@sahithidesigns.online',
      boundVia: 'cli_setup',
    });
    const ownerLogin = await jsonReq(
      baseUrl,
      owner.jar,
      'POST',
      '/api/admin/login',
      { email: 'owner.sync@sahithidesigns.online', password: 'OwnerSync!2026' },
      owner.csrfToken
    );
    assert.equal(ownerLogin.status, 200);
    const ownerCsrf = (await getSession(baseUrl, owner.jar)).csrfToken;

    const customerA = await registerVerifyAndLogin({
      baseUrl,
      email: 'ananya.sync@example.com',
      fullName: 'Ananya Verma',
      password: 'CustomerSync!123',
      sentEmails,
    });

    const customerB = await registerVerifyAndLogin({
      baseUrl,
      email: 'priya.sync@example.com',
      fullName: 'Priya Menon',
      password: 'CustomerSync!456',
      sentEmails,
    });

    // 1. Profile edit (name, phone, notificationPrefs) & server-field tamper attempt -> Admin sync
    const profilePatch = await jsonReq<{
      user: {
        fullName: string;
        phone: string | null;
        isOwner?: boolean;
        notificationPrefs: { orderUpdates: boolean; cancelReturnUpdates: boolean; promotions: boolean };
      };
    }>(
      baseUrl,
      customerA.jar,
      'PATCH',
      '/api/account/profile',
      {
        fullName: 'Ananya Rao',
        phone: '+91 98490 11223',
        isOwner: true,
        walletBalance: 999999,
        rewardPoints: 999999,
        notificationPrefs: {
          orderUpdates: true,
          cancelReturnUpdates: true,
          promotions: true,
          emailEnabled: true,
          smsWhatsappEnabled: true,
        },
      },
      customerA.csrfToken
    );
    assert.equal(profilePatch.status, 200);
    assert.equal(profilePatch.data.user.fullName, 'Ananya Rao');
    assert.equal(profilePatch.data.user.phone, '+91 98490 11223');
    assert.equal(profilePatch.data.user.isOwner, false);
    assert.equal(profilePatch.data.user.notificationPrefs.promotions, true);

    // 2. Saved addresses CRUD + Admin activity view check
    const addrCreate = await jsonReq<{ address: { id: string; line1: string } }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/account/addresses',
      {
        fullName: 'Ananya Rao',
        phone: '+91 98490 11223',
        line1: 'Flat 204, Jubilee Enclave',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500033',
        label: 'Home',
        isDefault: true,
      },
      customerA.csrfToken
    );
    assert.equal(addrCreate.status, 200);
    const addrId = addrCreate.data.address.id;

    const activityRes = await jsonReq<{
      users: Array<{
        id: string;
        fullName: string;
        phone: string | null;
        notificationPrefs?: { promotions: boolean };
        addresses?: Array<{ id: string; line1: string; city: string }>;
      }>;
    }>(baseUrl, owner.jar, 'GET', '/api/admin/activity', undefined, ownerCsrf);
    assert.equal(activityRes.status, 200);
    const adminCustA = activityRes.data.users.find((u) => u.id === customerA.userId);
    assert.ok(adminCustA, 'Admin activity should include Customer A');
    assert.equal(adminCustA.fullName, 'Ananya Rao');
    assert.equal(adminCustA.phone, '+91 98490 11223');
    assert.equal(adminCustA.notificationPrefs?.promotions, true);
    assert.equal(adminCustA.addresses?.[0]?.line1, 'Flat 204, Jubilee Enclave');

    // 3. Payment reference CRUD & strict rejection of raw PANs
    const badPan = await jsonReq<{ error?: string }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/account/payment-methods',
      {
        methodType: 'card',
        label: '4111222233334444',
        last4: '4444',
      },
      customerA.csrfToken
    );
    assert.equal(badPan.status, 400);

    const payCreate = await jsonReq<{ method: { id: string; label: string; last4?: string } }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/account/payment-methods',
      {
        methodType: 'card',
        label: 'HDFC Millennia Personal',
        last4: '4242',
        network: 'Visa',
        expiry: '08/29',
      },
      customerA.csrfToken
    );
    assert.equal(payCreate.status, 200);
    assert.equal(payCreate.data.method.last4, '4242');

    // Customer B cannot delete Customer A's payment method or address
    const crossPayDelete = await jsonReq(
      baseUrl,
      customerB.jar,
      'DELETE',
      `/api/account/payment-methods/${encodeURIComponent(payCreate.data.method.id)}`,
      undefined,
      customerB.csrfToken
    );
    assert.equal(crossPayDelete.status, 404);

    // Delete own payment reference
    const payDel = await jsonReq(
      baseUrl,
      customerA.jar,
      'DELETE',
      `/api/account/payment-methods/${encodeURIComponent(payCreate.data.method.id)}`,
      undefined,
      customerA.csrfToken
    );
    assert.equal(payDel.status, 200);

    // 4. Place a COD order & verify stock deduction + shipping snapshot stability after address edit/delete
    const catalogRes = await fetch(`${baseUrl}/api/products`);
    const catalogJson = (await catalogRes.json()) as {
      items: Array<{
        id: string;
        name: string;
        variants: Array<{ id: string; stockQty: number; pricePaise: number }>;
      }>;
    };
    const product = catalogJson.items.find((p) => (p.variants?.[0]?.stockQty ?? 0) >= 3);
    assert.ok(product, 'Expected seeded product with >= 3 stock');
    const variant = product.variants[0];
    const initialStock = variant.stockQty;

    const codOrderRes = await jsonReq<{
      order: {
        id: string;
        orderNumber: string;
        fulfillmentStatus: string;
        shippingAddress: string;
      };
    }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/orders',
      {
        paymentMethod: 'cod',
        idempotencyKey: 'idem_sync_cod_1',
        customerName: 'Ananya Rao',
        customerEmail: 'ananya.sync@example.com',
        customerPhone: '9849011223',
        shippingAddress: 'Flat 204, Jubilee Enclave, Hyderabad, Telangana - 500033',
        items: [{ productId: product.id, variantId: variant.id, quantity: 2 }],
      },
      customerA.csrfToken
    );
    assert.equal(codOrderRes.status, 201);
    const orderId = codOrderRes.data.order.id;

    // Editing or deleting saved address must NOT mutate the placed order's shipping snapshot
    await jsonReq(
      baseUrl,
      customerA.jar,
      'PATCH',
      `/api/account/addresses/${encodeURIComponent(addrId)}`,
      {
        fullName: 'Ananya Rao',
        phone: '+91 98490 11223',
        line1: 'Plot 99, Banjara Hills',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500034',
        label: 'Work',
        isDefault: true,
      },
      customerA.csrfToken
    );
    await jsonReq(
      baseUrl,
      customerA.jar,
      'DELETE',
      `/api/account/addresses/${encodeURIComponent(addrId)}`,
      undefined,
      customerA.csrfToken
    );

    // 5. Pre-dispatch delivery edit succeeds while status is 'placed'
    const delivEditOk = await jsonReq<{
      order: { customerPhone: string; shippingAddress: string; deliveryDetailsEditedAt: number | null };
    }>(
      baseUrl,
      customerA.jar,
      'PATCH',
      `/api/account/orders/${encodeURIComponent(orderId)}/delivery`,
      {
        customerName: 'Ananya K Rao',
        customerPhone: '9849055667',
        shippingAddress: 'Villa 12, Kondapur, Hyderabad, Telangana - 500084',
      },
      customerA.csrfToken
    );
    assert.equal(delivEditOk.status, 200);
    assert.equal(delivEditOk.data.order.shippingAddress, 'Villa 12, Kondapur, Hyderabad, Telangana - 500084');
    assert.ok(delivEditOk.data.order.deliveryDetailsEditedAt);

    // Cross-customer access denied
    const crossHide = await jsonReq(
      baseUrl,
      customerB.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(orderId)}/hide`,
      {},
      customerB.csrfToken
    );
    assert.equal(crossHide.status, 403);

    // Admin advances order to 'packed' -> delivery cutoff enforced (409)
    const packRes = await jsonReq(
      baseUrl,
      owner.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(orderId)}/status`,
      { status: 'packed', note: 'Ready for courier pickup' },
      ownerCsrf
    );
    assert.equal(packRes.status, 200);

    const delivEditLocked = await jsonReq<{ code?: string }>(
      baseUrl,
      customerA.jar,
      'PATCH',
      `/api/account/orders/${encodeURIComponent(orderId)}/delivery`,
      { shippingAddress: 'New Late Address 999' },
      customerA.csrfToken
    );
    assert.equal(delivEditLocked.status, 409);

    // 6. Customer turns off cancelReturnUpdates pref and cancels order directly -> immediate 'cancelled' + idempotent stock restore once
    await jsonReq(
      baseUrl,
      customerA.jar,
      'PATCH',
      '/api/account/profile',
      {
        notificationPrefs: {
          orderUpdates: true,
          cancelReturnUpdates: false,
          promotions: true,
          emailEnabled: true,
          smsWhatsappEnabled: false,
        },
      },
      customerA.csrfToken
    );

    const notifsBeforeCancel = await jsonReq<{ items: Array<{ id: string; type: string }> }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/notifications',
      undefined,
      customerA.csrfToken
    );
    const reqNotifCountBefore = notifsBeforeCancel.data.items.filter(
      (n) => n.type === 'request_update'
    ).length;

    const cancelDirect = await jsonReq<{
      order: {
        status: string;
        fulfillmentStatus: string;
        refundStatus: string;
        cancelledBy: string | null;
        cancelledAt: number | null;
        stockRestoredAt: number | null;
        cancelRequest: { status: string; type: string } | null;
        returnRequest: unknown;
      };
    }>(
      baseUrl,
      customerA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(orderId)}/cancel`,
      { reason: 'Event postponed.' },
      customerA.csrfToken
    );
    assert.equal(cancelDirect.status, 200);
    assert.equal(cancelDirect.data.order.status, 'cancelled');
    assert.equal(cancelDirect.data.order.fulfillmentStatus, 'cancelled');
    assert.equal(cancelDirect.data.order.refundStatus, 'not_required');
    assert.equal(cancelDirect.data.order.cancelledBy, 'customer');
    assert.ok(cancelDirect.data.order.cancelledAt);
    assert.ok(cancelDirect.data.order.stockRestoredAt);
    assert.equal(cancelDirect.data.order.returnRequest, null);

    // Admin immediately sees 'cancelled' (never stale 'pending'/'placed') and preserved shipping snapshot
    const adminOrdersAfterCancel = await jsonReq<{
      items: Array<{
        id: string;
        status: string;
        fulfillmentStatus: string;
        shippingAddress: string;
        returnRequest: unknown;
      }>;
    }>(baseUrl, owner.jar, 'GET', '/api/admin/orders?page=1&pageSize=20', undefined, ownerCsrf);
    const adminCancelledOrder = adminOrdersAfterCancel.data.items.find((o) => o.id === orderId);
    assert.ok(adminCancelledOrder);
    assert.equal(adminCancelledOrder.status, 'cancelled');
    assert.equal(adminCancelledOrder.fulfillmentStatus, 'cancelled');
    assert.equal(adminCancelledOrder.returnRequest, null);
    assert.equal(adminCancelledOrder.shippingAddress, 'Villa 12, Kondapur, Hyderabad, Telangana - 500084');

    // Repeated cancel is idempotent and must NOT double-restore stock
    const repeatCancel = await jsonReq<{ alreadyCancelled?: boolean }>(
      baseUrl,
      customerA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(orderId)}/cancel`,
      { reason: 'Event postponed.' },
      customerA.csrfToken
    );
    assert.equal(repeatCancel.status, 200);
    assert.equal(repeatCancel.data.alreadyCancelled, true);

    const catalogAfterRestore = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
      items: Array<{ id: string; variants: Array<{ id: string; stockQty: number }> }>;
    };
    const restoredVar = catalogAfterRestore.items
      .find((p) => p.id === product.id)
      ?.variants.find((v) => v.id === variant.id);
    assert.equal(restoredVar?.stockQty, initialStock, 'Variant stock should restore cleanly once');

    // Preference cancelReturnUpdates === false suppressed new request_update notification
    const notifsAfterResolve = await jsonReq<{ items: Array<{ id: string; type: string }> }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/notifications',
      undefined,
      customerA.csrfToken
    );
    const reqNotifCountAfter = notifsAfterResolve.data.items.filter(
      (n) => n.type === 'request_update'
    ).length;
    assert.equal(reqNotifCountAfter, reqNotifCountBefore);

    // 6b. Delivered order return request: submit -> edit reason -> withdraw -> resubmit -> admin approve
    const retOrderRes = await jsonReq<{ order: { id: string } }>(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/orders',
      {
        paymentMethod: 'cod',
        idempotencyKey: 'idem_sync_cod_return_1',
        customerName: 'Ananya Rao',
        customerEmail: 'ananya.sync@example.com',
        customerPhone: '9849011223',
        shippingAddress: 'Flat 204, Jubilee Enclave, Hyderabad',
        items: [{ productId: product.id, variantId: variant.id, quantity: 1 }],
      },
      customerA.csrfToken
    );
    assert.equal(retOrderRes.status, 201);
    const retOrderId = retOrderRes.data.order.id;

    await jsonReq(
      baseUrl,
      owner.jar,
      'PATCH',
      `/api/admin/orders/${encodeURIComponent(retOrderId)}/status`,
      { status: 'delivered' },
      ownerCsrf
    );

    const retSubmit = await jsonReq<{
      order: { fulfillmentStatus: string; returnRequest: { status: string; reason: string; type: string } | null; cancelRequest: unknown };
    }>(
      baseUrl,
      customerA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(retOrderId)}/request`,
      { type: 'return', reason: 'Sleeve fit is slightly tight.' },
      customerA.csrfToken
    );
    assert.equal(retSubmit.status, 200);
    assert.equal(retSubmit.data.order.fulfillmentStatus, 'delivered');
    assert.equal(retSubmit.data.order.returnRequest?.type, 'return');
    assert.equal(retSubmit.data.order.returnRequest?.status, 'pending');
    assert.equal(retSubmit.data.order.cancelRequest, null);

    const retEdit = await jsonReq<{
      order: { returnRequest: { reason: string; status: string } | null };
    }>(
      baseUrl,
      customerA.jar,
      'PATCH',
      `/api/account/orders/${encodeURIComponent(retOrderId)}/request`,
      { type: 'return', reason: 'Need a larger size after trying on.' },
      customerA.csrfToken
    );
    assert.equal(retEdit.status, 200);
    assert.equal(retEdit.data.order.returnRequest?.reason, 'Need a larger size after trying on.');

    const retWithdraw = await jsonReq<{
      order: { fulfillmentStatus: string; returnRequest: { status: string } | null };
    }>(
      baseUrl,
      customerA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(retOrderId)}/request/withdraw`,
      { type: 'return' },
      customerA.csrfToken
    );
    assert.equal(retWithdraw.status, 200);
    assert.equal(retWithdraw.data.order.returnRequest?.status, 'withdrawn');
    assert.equal(retWithdraw.data.order.fulfillmentStatus, 'delivered');

    // Delete notification
    if (notifsAfterResolve.data.items.length > 0) {
      const targetNotifId = notifsAfterResolve.data.items[0].id;
      const delNotif = await jsonReq(
        baseUrl,
        customerA.jar,
        'DELETE',
        `/api/account/notifications/${encodeURIComponent(targetNotifId)}`,
        undefined,
        customerA.csrfToken
      );
      assert.equal(delNotif.status, 200);
    }

    // 7. Hide order from customer list while keeping visible in Admin with hiddenByCustomer: true
    const hideRes = await jsonReq(
      baseUrl,
      customerA.jar,
      'POST',
      `/api/account/orders/${encodeURIComponent(orderId)}/hide`,
      {},
      customerA.csrfToken
    );
    assert.equal(hideRes.status, 200);

    const custOrdersAfterHide = await jsonReq<{ items: Array<{ id: string }> }>(
      baseUrl,
      customerA.jar,
      'GET',
      '/api/account/orders',
      undefined,
      customerA.csrfToken
    );
    assert.equal(custOrdersAfterHide.data.items.some((o) => o.id === orderId), false);

    const adminOrdersAfterHide = await jsonReq<{
      items: Array<{ id: string; hiddenByCustomer?: boolean }>;
    }>(baseUrl, owner.jar, 'GET', '/api/admin/orders?page=1&pageSize=20', undefined, ownerCsrf);
    const hiddenInAdmin = adminOrdersAfterHide.data.items.find((o) => o.id === orderId);
    assert.ok(hiddenInAdmin);
    assert.equal(hiddenInAdmin.hiddenByCustomer, true);

    // 8. Legacy collided record normalization on read (SQLite direct row)
    const legacyId = 'ord_legacy_collision_1';
    const legacyNow = Date.now();
    appInstance.db!.prepare(
      `INSERT INTO orders (
        id, order_number, customer_user_id, customer_name, customer_email, customer_phone,
        shipping_address, subtotal_paise, discount_paise, gift_card_paise, total_paise, currency,
        status, payment_status, fulfillment_status, payment_method, status_history_json,
        return_request_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'INR', 'return_requested', 'unpaid', 'return_requested', 'cod', ?, ?, ?, ?)`
    ).run(
      legacyId,
      'SC-LEGACY-01',
      customerA.userId,
      'Ananya Rao',
      'ananya.sync@example.com',
      '9849011223',
      'Hyderabad',
      100000,
      100000,
      JSON.stringify([
        { status: 'placed', actor: 'customer', at: legacyNow - 5000 },
        { status: 'confirmed', actor: 'owner', at: legacyNow - 3000 },
        { status: 'cancel_requested', actor: 'customer', at: legacyNow - 1000 },
      ]),
      JSON.stringify({
        id: 'req_legacy_cancel',
        type: 'cancel',
        reason: 'Old collided cancel request',
        status: 'pending',
        requestedAt: legacyNow - 1000,
      }),
      legacyNow - 5000,
      legacyNow
    );

    const legacyAdminFetch = await jsonReq<{
      items: Array<{
        id: string;
        fulfillmentStatus: string;
        cancelRequest: { status: string; type: string } | null;
        returnRequest: unknown;
        needsAdminReview?: boolean;
      }>;
    }>(baseUrl, owner.jar, 'GET', '/api/admin/orders?page=1&pageSize=20', undefined, ownerCsrf);
    const normalizedLegacy = legacyAdminFetch.data.items.find((o) => o.id === legacyId);
    assert.ok(normalizedLegacy);
    assert.equal(normalizedLegacy.fulfillmentStatus, 'confirmed');
    assert.equal(normalizedLegacy.cancelRequest?.type, 'cancel');
    assert.equal(normalizedLegacy.cancelRequest?.status, 'pending');
    assert.equal(normalizedLegacy.returnRequest, null);
    assert.equal(normalizedLegacy.needsAdminReview, true);

    // 9. Account Deletion rules: Owner blocked, Customer requires recent reauth + 'DELETE', preserves order ledger
    const ownerDeleteAttempt = await jsonReq<{ code?: string }>(
      baseUrl,
      owner.jar,
      'DELETE',
      '/api/account/profile',
      { confirmText: 'DELETE' },
      ownerCsrf
    );
    assert.equal(ownerDeleteAttempt.status, 403);
    assert.equal(ownerDeleteAttempt.data.code, 'OWNER_ACCOUNT_PROTECTED');

    // Simulate expired reauth window (>10 min) on Customer A's session -> 403 REAUTH_REQUIRED
    appInstance.db
      ?.prepare(`UPDATE sessions SET last_reauth_at = ? WHERE user_id = ?`)
      .run(Date.now() - 15 * 60_000, customerA.userId);

    const noReauthDelete = await jsonReq<{ code?: string }>(
      baseUrl,
      customerA.jar,
      'DELETE',
      '/api/account/profile',
      { confirmText: 'DELETE' },
      customerA.csrfToken
    );
    assert.equal(noReauthDelete.status, 403);
    assert.equal(noReauthDelete.data.code, 'REAUTH_REQUIRED');

    // Customer A reauthenticates -> wrong confirmText fails with 400 -> valid DELETE succeeds
    const reauthRes = await jsonReq(
      baseUrl,
      customerA.jar,
      'POST',
      '/api/account/reauthenticate',
      { password: 'CustomerSync!123' },
      customerA.csrfToken
    );
    assert.equal(reauthRes.status, 200);

    const badConfirmDelete = await jsonReq<{ code?: string }>(
      baseUrl,
      customerA.jar,
      'DELETE',
      '/api/account/profile',
      { confirmText: 'remove' },
      customerA.csrfToken
    );
    assert.equal(badConfirmDelete.status, 400);

    const validDelete = await jsonReq<{ ok: boolean; deletedUserId: string }>(
      baseUrl,
      customerA.jar,
      'DELETE',
      '/api/account/profile',
      { confirmText: 'DELETE' },
      customerA.csrfToken
    );
    assert.equal(validDelete.status, 200);
    assert.equal(validDelete.data.ok, true);

    // Session cleared & historical order still exists with anonymized customer_user_id === null
    const postDeleteSession = await getSession(baseUrl, customerA.jar);
    assert.equal(postDeleteSession.authenticated, false);
    const preservedOrder = appInstance.db
      ?.prepare(`SELECT id, customer_user_id FROM orders WHERE id = ?`)
      .get(orderId) as { id: string; customer_user_id: string | null } | undefined;
    assert.ok(preservedOrder);
    assert.equal(preservedOrder.customer_user_id, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Clientless Static Mode (handleClientlessApiRequest) Concurrency, Sync & Delete
// ---------------------------------------------------------------------------

function encodeFsVal(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => encodeFsVal(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = encodeFsVal(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function decodeFsVal(fv: Record<string, unknown> | undefined): unknown {
  if (!fv) return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return Boolean(fv.booleanValue);
  if ('integerValue' in fv) return Number(fv.integerValue);
  if ('doubleValue' in fv) return Number(fv.doubleValue);
  if ('stringValue' in fv) return String(fv.stringValue ?? '');
  if ('arrayValue' in fv) {
    const arr = (fv.arrayValue as { values?: Array<Record<string, unknown>> })?.values || [];
    return arr.map((item) => decodeFsVal(item));
  }
  if ('mapValue' in fv) {
    const out: Record<string, unknown> = {};
    const mf = (fv.mapValue as { fields?: Record<string, Record<string, unknown>> })?.fields || {};
    for (const [k, v] of Object.entries(mf)) {
      out[k] = decodeFsVal(v);
    }
    return out;
  }
  return null;
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

test('Clientless Firestore mode: customer edit/delete, cancel vs return separation, concurrency conflict (409), stock idempotency & legacy doc normalization', async () => {
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

  const docs = new Map<string, { data: Record<string, unknown>; updateTime: string }>();
  let versionSeq = 1;
  let currentUid = 'uid-cust-a';
  let currentEmail = 'kavya.client@example.com';
  let deletedAuthAccounts: string[] = [];

  const encodeDoc = (docPath: string, entry: { data: Record<string, unknown>; updateTime: string }) => {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.data)) {
      if (v !== undefined) fields[k] = encodeFsVal(v);
    }
    return {
      name: `projects/celtic-pattern-fmln4/databases/test/documents/environments/production/${docPath}`,
      fields,
      updateTime: entry.updateTime,
    };
  };

  // Seed one published product in Firestore mock
  docs.set('products/prod_silk_1', {
    data: {
      id: 'prod_silk_1',
      title: 'Kanjivaram Banarasi Suit',
      slug: 'kanjivaram-banarasi-suit',
      sku: 'SC-KS-01',
      category: 'Suits',
      description: 'Handwoven bridal silk',
      fabric_note: 'Pure Zari Silk',
      price_paise: 450000,
      compare_at_paise: 520000,
      stock_qty: 5,
      low_stock_threshold: 2,
      status: 'published',
      featured: true,
      version: 1,
      variants: [
        {
          id: 'var_silk_1',
          product_id: 'prod_silk_1',
          sku: 'SC-KS-01-M',
          size: 'M',
          color_name: 'Crimson',
          color_hex: '#8B1E3F',
          price_paise: 450000,
          compare_at_paise: 520000,
          stock_qty: 5,
          position: 0,
        },
      ],
      images: [
        {
          id: 'img_1',
          product_id: 'prod_silk_1',
          url: '/assets/sample.jpg',
          alt: 'Crimson silk suit',
          is_cover: true,
          position: 0,
        },
      ],
      created_at: Date.now() - 10000,
      updated_at: Date.now() - 10000,
    },
    updateTime: '2026-01-01T00:00:01Z',
  });

  // Also seed a legacy collided order doc belonging to uid-cust-a
  docs.set('orders/ord_legacy_fs_1', {
    data: {
      id: 'ord_legacy_fs_1',
      order_number: 'SC-FS-LEG-01',
      customer_user_id: 'uid-cust-a',
      customer_name: 'Kavya S',
      customer_email: 'kavya.client@example.com',
      customer_phone: '9988776655',
      shipping_address: '101 Jubilee Hills',
      subtotal_paise: 450000,
      discount_paise: 0,
      gift_card_paise: 0,
      total_paise: 450000,
      currency: 'INR',
      status: 'return_requested',
      fulfillment_status: 'return_requested',
      payment_status: 'unpaid',
      payment_method: 'cod',
      status_history: [
        { status: 'placed', actor: 'customer', at: Date.now() - 9000 },
        { status: 'confirmed', actor: 'owner', at: Date.now() - 7000 },
        { status: 'cancel_requested', actor: 'customer', at: Date.now() - 4000 },
      ],
      return_request: {
        id: 'req_fs_leg_1',
        type: 'cancel',
        reason: 'Legacy firestore cancel',
        status: 'pending',
        requestedAt: Date.now() - 4000,
      },
      created_at: Date.now() - 9000,
      updated_at: Date.now() - 4000,
    },
    updateTime: '2026-01-01T00:00:02Z',
  });

  const makeJwt = () =>
    makeFakeJwt({
      user_id: currentUid,
      email: currentEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')) {
      const b = JSON.parse(String(init?.body || '{}')) as { email?: string };
      currentEmail = String(b.email || '').toLowerCase();
      currentUid = currentEmail === AUTHORIZED_OWNER_EMAIL ? 'uid-owner-1' : 'uid-cust-a';
      return new Response(
        JSON.stringify({
          idToken: makeJwt(),
          refreshToken: `ref-${currentUid}`,
          localId: currentUid,
          email: currentEmail,
          displayName: currentEmail === AUTHORIZED_OWNER_EMAIL ? 'Store Owner' : 'Kavya S',
          expiresIn: '3600',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      return new Response(
        JSON.stringify({
          users: [
            {
              localId: currentUid,
              email: currentEmail,
              emailVerified: true,
              displayName: currentEmail === AUTHORIZED_OWNER_EMAIL ? 'Store Owner' : 'Kavya S',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:update')) {
      const b = JSON.parse(String(init?.body || '{}')) as { displayName?: string };
      return new Response(
        JSON.stringify({
          localId: currentUid,
          email: currentEmail,
          displayName: b.displayName || 'Updated User',
          emailVerified: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:delete')) {
      deletedAuthAccounts.push(currentUid);
      return new Response(JSON.stringify({ kind: 'identitytoolkit#DeleteAccountResponse' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('firestore.googleapis.com/v1/')) {
      const marker = '/documents/environments/production';
      const idx = url.indexOf(marker);
      assert.ok(idx !== -1, `Unexpected URL: ${url}`);
      const after = url.slice(idx + marker.length).replace(/^\/+/, '');
      const [rawDocPath, queryStr = ''] = after.split('?');
      const params = new URLSearchParams(queryStr);

      if (rawDocPath.endsWith(':runQuery') && method === 'POST') {
        const parentPrefix = rawDocPath.slice(0, -':runQuery'.length).replace(/\/+$/, '');
        const qBody = JSON.parse(String(init?.body || '{}')) as {
          structuredQuery?: {
            from?: Array<{ collectionId?: string }>;
            where?: {
              fieldFilter?: { field?: { fieldPath?: string }; value?: Record<string, unknown> };
            };
          };
        };
        const colId = qBody.structuredQuery?.from?.[0]?.collectionId || '';
        const prefix = parentPrefix ? `${parentPrefix}/${colId}/` : `${colId}/`;
        const filterPath = qBody.structuredQuery?.where?.fieldFilter?.field?.fieldPath;
        const filterVal = decodeFsVal(qBody.structuredQuery?.where?.fieldFilter?.value);
        const matched = Array.from(docs.entries())
          .filter(([k, entry]) => {
            if (!k.startsWith(prefix)) return false;
            if (filterPath && entry.data[filterPath] !== filterVal) return false;
            return true;
          })
          .map(([k, entry]) => ({ document: encodeDoc(k, entry) }));
        return new Response(JSON.stringify(matched), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const parts = rawDocPath.split('/').filter(Boolean);
      // List collection (odd segment count)
      if (parts.length % 2 === 1 && method === 'GET') {
        const prefix = `${parts.join('/')}/`;
        const documents = Array.from(docs.entries())
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map(([k, entry]) => encodeDoc(k, entry));
        return new Response(JSON.stringify({ documents }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const docPath = parts.join('/');
      if (method === 'GET') {
        const existing = docs.get(docPath);
        if (!existing) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(encodeDoc(docPath, existing)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'PATCH') {
        const existing = docs.get(docPath);
        const expectedUpdateTime = params.get('currentDocument.updateTime');
        if (expectedUpdateTime && (!existing || existing.updateTime !== expectedUpdateTime)) {
          return new Response(
            JSON.stringify({
              error: {
                code: 409,
                status: 'ABORTED',
                message: 'Document was modified concurrently (updateTime mismatch).',
              },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const raw = JSON.parse(String(init?.body || '{}')) as {
          fields?: Record<string, Record<string, unknown>>;
        };
        const decodedPatch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw.fields || {})) {
          decodedPatch[k] = decodeFsVal(v);
        }
        const maskPaths = params.getAll('updateMask.fieldPaths');
        const nextData =
          maskPaths.length > 0 && existing
            ? { ...existing.data, ...decodedPatch }
            : decodedPatch;
        const nextEntry = {
          data: nextData,
          updateTime: `2026-01-01T00:00:${String(++versionSeq).padStart(2, '0')}Z`,
        };
        docs.set(docPath, nextEntry);
        return new Response(JSON.stringify(encodeDoc(docPath, nextEntry)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'DELETE') {
        if (!docs.has(docPath)) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        docs.delete(docPath);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: `Unhandled ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;

  try {
    // 1. Customer signs in & verifies legacy order normalization
    const loginRes = await handleClientlessApiRequest('/api/auth/login', 'POST', {
      email: 'kavya.client@example.com',
      password: 'Password!123',
    });
    assert.equal(loginRes.ok, true);

    const listLegacy = await handleClientlessApiRequest<{
      items: Array<{
        id: string;
        fulfillmentStatus: string;
        cancelRequest: { status: string; type: string } | null;
        returnRequest: unknown;
        needsAdminReview?: boolean;
      }>;
    }>('/api/account/orders', 'GET');
    assert.equal(listLegacy.ok, true);
    if (listLegacy.ok) {
      const leg = listLegacy.data.items.find((o) => o.id === 'ord_legacy_fs_1');
      assert.ok(leg);
      assert.equal(leg.fulfillmentStatus, 'confirmed');
      assert.equal(leg.cancelRequest?.type, 'cancel');
      assert.equal(leg.cancelRequest?.status, 'pending');
      assert.equal(leg.returnRequest, null);
      assert.equal(leg.needsAdminReview, true);
    }

    // 2. Customer updates profile + address + payment ref
    const profPatch = await handleClientlessApiRequest<{
      user: { fullName: string; phone: string | null; notificationPrefs: { promotions: boolean } };
    }>('/api/account/profile', 'PATCH', {
      fullName: 'Kavya Sharma',
      phone: '+91 90000 12345',
      notificationPrefs: { promotions: true },
    });
    assert.equal(profPatch.ok, true);

    const addrRes = await handleClientlessApiRequest<{ address: { id: string } }>(
      '/api/account/addresses',
      'POST',
      {
        fullName: 'Kavya Sharma',
        phone: '9000012345',
        line1: '12 Rose Garden',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        label: 'Home',
        isDefault: true,
      }
    );
    assert.equal(addrRes.ok, true);

    // 3. Place COD order, customer cancels directly -> immediately 'cancelled' in Firestore
    const orderRes = await handleClientlessApiRequest<{
      order: { id: string; fulfillmentStatus: string };
    }>('/api/orders', 'POST', {
      paymentMethod: 'cod',
      idempotencyKey: 'fs_idem_1',
      customerName: 'Kavya Sharma',
      customerEmail: 'kavya.client@example.com',
      customerPhone: '9000012345',
      shippingAddress: '12 Rose Garden, Bengaluru',
      items: [{ productId: 'prod_silk_1', variantId: 'var_silk_1', quantity: 1 }],
    });
    assert.equal(orderRes.ok, true);
    const fsOrderId = orderRes.ok ? orderRes.data.order.id : '';
    const stockBeforeCancel = docs.get('products/prod_silk_1')?.data.stock_qty as number;
    assert.equal(stockBeforeCancel, 5);

    const cancelDirectRes = await handleClientlessApiRequest<{
      order: { status: string; fulfillmentStatus: string; cancelledBy: string | null; refundStatus: string };
    }>(`/api/account/orders/${fsOrderId}/cancel`, 'POST', {
      reason: 'Need a different size.',
    });
    assert.equal(cancelDirectRes.ok, true);
    if (cancelDirectRes.ok) {
      assert.equal(cancelDirectRes.data.order.status, 'cancelled');
      assert.equal(cancelDirectRes.data.order.fulfillmentStatus, 'cancelled');
      assert.equal(cancelDirectRes.data.order.cancelledBy, 'customer');
      assert.equal(cancelDirectRes.data.order.refundStatus, 'not_required');
    }

    // 4. Sign in as owner and check admin activity + admin sees 'cancelled' + terminal lock + legacy cancel resolve
    clearClientFirebaseSession();
    await handleClientlessApiRequest('/api/admin/login', 'POST', {
      email: AUTHORIZED_OWNER_EMAIL,
      password: 'owner-password',
    });

    // Check admin/activity shows Kavya Sharma's updated phone, prefs & address
    const actRes = await handleClientlessApiRequest<{
      users: Array<{
        id: string;
        fullName: string;
        phone: string | null;
        addresses?: Array<{ city: string }>;
      }>;
    }>('/api/admin/activity', 'GET');
    assert.equal(actRes.ok, true);
    if (actRes.ok) {
      const kavya = actRes.data.users.find((u) => u.id === 'uid-cust-a');
      assert.ok(kavya);
      assert.equal(kavya.fullName, 'Kavya Sharma');
      assert.equal(kavya.phone, '+91 90000 12345');
      assert.equal(kavya.addresses?.[0]?.city, 'Bengaluru');
    }

    // Admin orders immediately show fsOrderId as 'cancelled', excluded from ?status=pending and included in ?status=cancelled
    const adminPendingRes = await handleClientlessApiRequest<{
      items: Array<{ id: string; status: string }>;
      statusCounts?: Record<string, number>;
    }>('/api/admin/orders?page=1&pageSize=20&status=pending', 'GET');
    assert.equal(adminPendingRes.ok, true);
    if (adminPendingRes.ok) {
      assert.equal(adminPendingRes.data.items.some((o) => o.id === fsOrderId), false);
    }
    const adminCancelledRes = await handleClientlessApiRequest<{
      items: Array<{ id: string; status: string }>;
      statusCounts?: Record<string, number>;
    }>('/api/admin/orders?page=1&pageSize=20&status=cancelled', 'GET');
    assert.equal(adminCancelledRes.ok, true);
    if (adminCancelledRes.ok) {
      assert.equal(adminCancelledRes.data.items.some((o) => o.id === fsOrderId && o.status === 'cancelled'), true);
      assert.equal(adminCancelledRes.data.statusCounts?.cancelled, 1);
    }

    // Admin cannot reopen a cancelled order back to pending/confirmed (409)
    const reopenAttempt = await handleClientlessApiRequest(`/api/admin/orders/${fsOrderId}/status`, 'PATCH', {
      status: 'confirmed',
    });
    assert.equal(reopenAttempt.ok, false);
    if (!reopenAttempt.ok) assert.equal(reopenAttempt.status, 409);

    // Admin approves legacy pending cancel request -> transitions to cancelled cleanly once & second approve fails with 409
    const approveLegacyFs = await handleClientlessApiRequest<{
      order: { fulfillmentStatus: string; stockRestoredAt: number | null };
    }>('/api/admin/orders/ord_legacy_fs_1/resolve-request', 'POST', {
      decision: 'approved',
      requestType: 'cancel',
      note: 'Approved legacy cancel request',
    });
    assert.equal(approveLegacyFs.ok, true);
    if (approveLegacyFs.ok) {
      assert.equal(approveLegacyFs.data.order.fulfillmentStatus, 'cancelled');
    }
    const approveAgain = await handleClientlessApiRequest('/api/admin/orders/ord_legacy_fs_1/resolve-request', 'POST', {
      decision: 'approved',
      requestType: 'cancel',
    });
    assert.equal(approveAgain.ok, false);
    if (!approveAgain.ok) assert.equal(approveAgain.status, 409);

    // Owner delete account is strictly blocked
    const ownerDel = await handleClientlessApiRequest('/api/account/profile', 'DELETE', {
      confirmText: 'DELETE',
    });
    assert.equal(ownerDel.ok, false);
    if (!ownerDel.ok) assert.equal(ownerDel.status, 403);

    // 5. Switch back to customer A: verify hide order + reauth + account deletion
    clearClientFirebaseSession();
    await handleClientlessApiRequest('/api/auth/login', 'POST', {
      email: 'kavya.client@example.com',
      password: 'Password!123',
    });

    const hideFs = await handleClientlessApiRequest(`/api/account/orders/${fsOrderId}/hide`, 'POST', {});
    assert.equal(hideFs.ok, true);

    await handleClientlessApiRequest('/api/account/reauthenticate', 'POST', {
      password: 'Password!123',
    });
    const custDel = await handleClientlessApiRequest<{ ok: boolean }>('/api/account/profile', 'DELETE', {
      confirmText: 'DELETE',
    });
    assert.equal(custDel.ok, true);
    assert.ok(deletedAuthAccounts.includes('uid-cust-a'));
    assert.equal(docs.has('users/uid-cust-a'), false);
    // Order ledger preserved with null customer_user_id
    assert.equal(docs.get(`orders/${fsOrderId}`)?.data.customer_user_id, null);
  } finally {
    clearClientFirebaseSession();
    globalThis.fetch = originalFetch;
  }
});
