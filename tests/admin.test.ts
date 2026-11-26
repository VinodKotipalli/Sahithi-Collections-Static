import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createAuthApp } from '../server/app.ts';
import { bindOwnerAccount } from '../server/db.ts';
import { FirestoreRestStore } from '../server/firebase-rest.ts';
import type { EmailMessage, EmailSender } from '../server/providers.ts';
import { StoreHttpError } from '../server/store.ts';

class CookieJar {
  private store = new Map<string, string>();

  updateFromResponse(res: Response) {
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [];
    for (const cookieStr of setCookies) {
      const [pair] = cookieStr.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (!val) {
        this.store.delete(name);
      } else {
        this.store.set(name, val);
      }
    }
  }

  getHeader(): string {
    return Array.from(this.store.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

function extractToken(htmlOrText: string): string {
  const match = htmlOrText.match(/[?&]token=([^"&\s<]+)/);
  assert.ok(match, 'Expected token query param in email payload');
  return decodeURIComponent(match[1]);
}

// Valid minimal 1x1 PNG binary
const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

let tmpDir = '';
let dbPath = '';
let server: http.Server;
let baseUrl = '';
let sentEmails: EmailMessage[] = [];
let appInstance: ReturnType<typeof createAuthApp>;
const testEmailSender: EmailSender = {
  isConfigured: () => true,
  sendEmail: async (msg) => {
    sentEmails.push(msg);
  },
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-admin-test-'));
  dbPath = path.join(tmpDir, 'boutique.db');

  appInstance = createAuthApp({
    dbPath,
    emailSender: testEmailSender,
    disableRateLimit: true,
    appBaseUrl: 'http://127.0.0.1:3000',
    seedCatalog: true,
  });

  server = http.createServer(appInstance.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  try {
    appInstance.db?.close();
  } catch {
    // Already closed in persistence test
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getSession(jar: CookieJar) {
  const res = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jar.getHeader() ? { Cookie: jar.getHeader() } : undefined,
  });
  jar.updateFromResponse(res);
  return (await res.json()) as { csrfToken: string; authenticated: boolean; user: Record<string, unknown> | null };
}

async function jsonReq(
  jar: CookieJar,
  method: string,
  reqPath: string,
  body: unknown,
  csrfToken: string
) {
  const headers: Record<string, string> = {
    'X-CSRF-Token': csrfToken,
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }
  if (jar.getHeader()) {
    headers.Cookie = jar.getHeader();
  }
  const res = await fetch(`${baseUrl}${reqPath}`, {
    method,
    headers,
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  jar.updateFromResponse(res);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, json };
}

async function registerAndVerifyCustomer(
  jar: CookieJar,
  fullName: string,
  email: string,
  password: string,
  extraFields: Record<string, unknown> = {}
) {
  const { csrfToken } = await getSession(jar);
  const startLen = sentEmails.length;
  const reg = await jsonReq(
    jar,
    'POST',
    '/api/auth/register',
    { fullName, email, password, confirmPassword: password, ...extraFields },
    csrfToken
  );
  assert.equal(reg.res.status, 200);
  const msg = sentEmails.slice(startLen).find((m) => m.to.toLowerCase() === email.toLowerCase());
  assert.ok(msg, `Verification email should be sent to ${email}`);
  const token = extractToken(msg.text || msg.html);

  const verify = await jsonReq(jar, 'POST', '/api/auth/verify-email', { token }, csrfToken);
  assert.equal(verify.res.status, 200);
  return { csrfToken: String(verify.json.csrfToken || csrfToken), user: verify.json.user as { id: string; email: string } };
}

test('SEO protections: /robots.txt & /sitemap.xml exclude /admin, and /admin carries X-Robots-Tag noindex', async () => {
  const robotsRes = await fetch(`${baseUrl}/robots.txt`);
  assert.equal(robotsRes.status, 200);
  const robotsText = await robotsRes.text();
  assert.match(robotsText, /Disallow:\s*\/admin/);
  assert.match(robotsText, /Disallow:\s*\/api\/admin/);

  const sitemapRes = await fetch(`${baseUrl}/sitemap.xml`);
  assert.equal(sitemapRes.status, 200);
  const sitemapXml = await sitemapRes.text();
  assert.ok(!sitemapXml.includes('/admin'), 'sitemap.xml must never list /admin');

  const adminPageRes = await fetch(`${baseUrl}/admin`);
  assert.match(adminPageRes.headers.get('x-robots-tag') || '', /noindex/i);
  assert.match(adminPageRes.headers.get('cache-control') || '', /no-store/i);
  assert.equal(adminPageRes.headers.get('x-frame-options'), null);

  const adminLoginPageRes = await fetch(`${baseUrl}/admin/login`);
  assert.match(adminLoginPageRes.headers.get('x-robots-tag') || '', /noindex/i);
  assert.match(adminLoginPageRes.headers.get('cache-control') || '', /no-store/i);
});

test('All /api/admin endpoints enforce 401 when logged out and 403 for non-owner accounts', async () => {
  const guestJar = new CookieJar();
  const { csrfToken: guestCsrf } = await getSession(guestJar);

  // Unauthenticated checks -> 401
  for (const endpoint of [
    '/api/admin/session',
    '/api/admin/overview',
    '/api/admin/products',
    '/api/admin/categories',
    '/api/admin/orders',
    '/api/admin/content',
    '/api/admin/settings',
    '/api/admin/messages',
    '/api/admin/audit',
  ]) {
    const res = await fetch(`${baseUrl}${endpoint}`);
    assert.equal(res.status, 401, `${endpoint} should return 401 when unauthenticated`);
  }

  const unauthCreate = await jsonReq(guestJar, 'POST', '/api/admin/products', { title: 'Test' }, guestCsrf);
  assert.equal(unauthCreate.res.status, 401);

  const unauthUpload = await fetch(`${baseUrl}/api/admin/uploads`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': guestCsrf, Cookie: guestJar.getHeader() },
  });
  assert.equal(unauthUpload.status, 401);

  // Register a regular customer attempting client-side role injection (isAdmin: true, role: 'admin')
  const shopperJar = new CookieJar();
  const shopper = await registerAndVerifyCustomer(
    shopperJar,
    'Shopper User',
    'shopper@example.com',
    'ShopperPass123!',
    { isAdmin: true, role: 'admin' }
  );

  // Regular authenticated customer gets user.isOwner=false on session & login, and 403 on all admin routes
  const shopperSession = await getSession(shopperJar);
  assert.equal(shopperSession.authenticated, true);
  assert.equal(shopperSession.user?.isOwner, false);

  const shopperRegularLogin = await jsonReq(
    shopperJar,
    'POST',
    '/api/auth/login',
    { email: 'shopper@example.com', password: 'ShopperPass123!' },
    shopper.csrfToken
  );
  assert.equal(shopperRegularLogin.res.status, 200);
  assert.equal((shopperRegularLogin.json.user as { isOwner?: boolean })?.isOwner, false);

  for (const endpoint of [
    '/api/admin/session',
    '/api/admin/overview',
    '/api/admin/products',
    '/api/admin/categories',
    '/api/admin/orders',
    '/api/admin/content',
    '/api/admin/settings',
    '/api/admin/messages',
    '/api/admin/audit',
  ]) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      headers: { Cookie: shopperJar.getHeader() },
    });
    assert.equal(res.status, 403, `${endpoint} must reject regular user with 403`);
  }

  const shopperLoginAdmin = await jsonReq(
    shopperJar,
    'POST',
    '/api/admin/login',
    { email: 'shopper@example.com', password: 'ShopperPass123!' },
    shopper.csrfToken
  );
  assert.equal(shopperLoginAdmin.res.status, 403);
});

test('Owner email requires verification & trusted server-side binding before granting /admin access', async () => {
  const ownerEmail = 'saivinodkotipalli2003@gmail.com';
  const ownerPass = 'BoutiqueOwner#2026!';
  const ownerJar = new CookieJar();
  const { csrfToken: preCsrf } = await getSession(ownerJar);

  // 1. Register saivinodkotipalli2003@gmail.com (unverified yet)
  const startLen = sentEmails.length;
  const reg = await jsonReq(
    ownerJar,
    'POST',
    '/api/auth/register',
    { fullName: 'Saivinod Kotipalli', email: ownerEmail, password: ownerPass, confirmPassword: ownerPass },
    preCsrf
  );
  assert.equal(reg.res.status, 200);

  // Unverified owner with right password receives EMAIL_NOT_VERIFIED; wrong password receives INVALID_CREDENTIALS
  const wrongPassAttempt = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: 'WrongPassword123' },
    preCsrf
  );
  assert.equal(wrongPassAttempt.res.status, 401);
  assert.equal(wrongPassAttempt.json.code, 'INVALID_CREDENTIALS');

  const unverifiedAttempt = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: ownerPass },
    preCsrf
  );
  assert.equal(unverifiedAttempt.res.status, 403);
  assert.equal(unverifiedAttempt.json.code, 'EMAIL_NOT_VERIFIED');

  assert.ok(appInstance.db);
  // Server binding must refuse an unverified account!
  assert.throws(
    () => bindOwnerAccount(appInstance.db!, { email: ownerEmail, boundVia: 'cli_setup' }),
    /not verified/i
  );

  // Complete real email verification
  const msg = sentEmails.slice(startLen).find((m) => m.to.toLowerCase() === ownerEmail);
  assert.ok(msg);
  const token = extractToken(msg.text || msg.html);
  const verify = await jsonReq(ownerJar, 'POST', '/api/auth/verify-email', { token }, preCsrf);
  assert.equal(verify.res.status, 200);
  assert.equal((verify.json.user as { isOwner?: boolean })?.isOwner, false);
  const ownerCsrf = String(verify.json.csrfToken || preCsrf);

  // Even AFTER verifying saivinodkotipalli2003@gmail.com email, admin access is STILL denied (403) until trusted binding!
  const beforeBindCheck = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(beforeBindCheck.status, 403);

  const preBindLogin = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: ownerPass },
    ownerCsrf
  );
  assert.equal(preBindLogin.res.status, 403);
  assert.equal(preBindLogin.json.code, 'OWNER_NOT_BOUND');

  // Complete trusted server-side owner binding using verified immutable user.id
  const bound = bindOwnerAccount(appInstance.db!, { email: ownerEmail, boundVia: 'cli_setup' });
  assert.equal(bound.bound_via, 'cli_setup');

  // Storefront /api/auth/login returns user.isOwner=true and grants /api/admin/* access cleanly
  const storefrontOwnerLogin = await jsonReq(
    ownerJar,
    'POST',
    '/api/auth/login',
    { email: ownerEmail, password: ownerPass },
    ownerCsrf
  );
  assert.equal(storefrontOwnerLogin.res.status, 200);
  assert.equal((storefrontOwnerLogin.json.user as { isOwner?: boolean })?.isOwner, true);
  let boundCsrf = String(storefrontOwnerLogin.json.csrfToken || ownerCsrf);

  const currentUserAfterLogin = await getSession(ownerJar);
  assert.equal(currentUserAfterLogin.authenticated, true);
  assert.equal(currentUserAfterLogin.user?.isOwner, true);

  const postLoginAdminOverview = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(postLoginAdminOverview.status, 200);

  // Admin sign-in endpoint also authorizes properly
  const adminLogin = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: ownerPass },
    boundCsrf
  );
  assert.equal(adminLogin.res.status, 200);
  assert.equal((adminLogin.json.user as { isOwner?: boolean })?.isOwner, true);
  boundCsrf = String(adminLogin.json.csrfToken);

  // Verify logout immediately revokes access, and logging back in restores it
  const logoutRes = await jsonReq(ownerJar, 'POST', '/api/auth/logout', {}, boundCsrf);
  assert.equal(logoutRes.res.status, 200);
  const afterLogoutSession = await getSession(ownerJar);
  assert.equal(afterLogoutSession.authenticated, false);
  assert.equal(afterLogoutSession.user, null);
  const afterLogoutRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: ownerJar.getHeader() ? { Cookie: ownerJar.getHeader() } : undefined,
  });
  assert.equal(afterLogoutRes.status, 401);

  const reLoginCsrf = String(afterLogoutSession.csrfToken || logoutRes.json.csrfToken);
  const reLogin = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: ownerPass },
    reLoginCsrf
  );
  assert.equal(reLogin.res.status, 200);
  boundCsrf = String(reLogin.json.csrfToken);

  const sessionCheck = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(sessionCheck.status, 200);
  const sessionData = (await sessionCheck.json()) as { isOwner: boolean; user: { id: string; isOwner: boolean } };
  assert.equal(sessionData.isOwner, true);
  assert.equal(sessionData.user.isOwner, true);
  assert.equal(sessionData.user.id, bound.owner_user_id);

  // Upload validation: reject fake image content & accept genuine PNG magic bytes
  const badForm = new FormData();
  badForm.append('files', new Blob(['<svg onload=alert(1)>'], { type: 'image/png' }), 'evil.png');
  const badUploadRes = await fetch(`${baseUrl}/api/admin/uploads`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': boundCsrf, Cookie: ownerJar.getHeader() },
    body: badForm,
  });
  assert.equal(badUploadRes.status, 400);

  const goodForm = new FormData();
  goodForm.append('files', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), 'gown.png');
  const goodUploadRes = await fetch(`${baseUrl}/api/admin/uploads`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': boundCsrf, Cookie: ownerJar.getHeader() },
    body: goodForm,
  });
  assert.equal(goodUploadRes.status, 201);
  const uploadedData = (await goodUploadRes.json()) as {
    files: Array<{ url: string; mimeType: string }>;
  };
  const uploadedUrl = uploadedData.files[0].url;
  assert.match(uploadedUrl, /^\/api\/media\/sc-/);

  // Draft/unlinked upload is readable by owner, hidden (404) from public
  const ownerMediaRead = await fetch(`${baseUrl}${uploadedUrl}`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(ownerMediaRead.status, 200);

  const publicMediaBeforePublish = await fetch(`${baseUrl}${uploadedUrl}`);
  assert.equal(publicMediaBeforePublish.status, 404);

  // Create DRAFT product with size/color variants
  const createDraft = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/products',
    {
      title: 'Kanchipuram Rose Zari Skirt Set',
      category: 'Festive Collection',
      sku: 'SC-TEST-100',
      description: 'Handwoven rosewood zari festive skirt set tailored with silk lining.',
      fabricNote: 'Pure silk zari weave',
      pricePaise: 549900, // ₹5,499
      compareAtPaise: 629900,
      lowStockThreshold: 3,
      featured: true,
      status: 'draft',
      variants: [
        {
          sku: 'SC-TEST-100-S',
          size: 'S',
          colorName: 'Rosewood',
          colorHex: '#B76E79',
          pricePaise: 549900,
          compareAtPaise: 629900,
          stockQty: 4,
        },
        {
          sku: 'SC-TEST-100-M',
          size: 'M',
          colorName: 'Rosewood',
          colorHex: '#B76E79',
          pricePaise: 569900,
          compareAtPaise: 649900,
          stockQty: 2,
        },
      ],
      images: [{ url: uploadedUrl, alt: 'Kanchipuram Rose Set front view', isCover: true }],
    },
    boundCsrf
  );
  assert.equal(createDraft.res.status, 201);
  const draftProd = createDraft.json.product as {
    id: string;
    version: number;
    status: string;
    variants: Array<{ id: string; pricePaise: number; stockQty: number }>;
  };
  assert.equal(draftProd.status, 'draft');
  assert.equal(draftProd.variants.length, 2);

  // Draft MUST NOT appear on public /api/products or /api/products/:id
  const publicCatalogWhileDraft = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{ id: string }>;
  };
  assert.ok(!publicCatalogWhileDraft.items.some((p) => p.id === draftProd.id));
  assert.equal((await fetch(`${baseUrl}/api/products/${draftProd.id}`)).status, 404);

  // Publish the product -> now visible in storefront & uploaded media becomes publicly readable
  const publishRes = await jsonReq(
    ownerJar,
    'POST',
    `/api/admin/products/${draftProd.id}/publish`,
    { expectedVersion: draftProd.version },
    boundCsrf
  );
  assert.equal(publishRes.res.status, 200);
  const publishedProd = publishRes.json.product as {
    id: string;
    version: number;
    status: string;
    variants: Array<{ id: string; pricePaise: number; stockQty: number }>;
  };
  assert.equal(publishedProd.status, 'published');
  assert.equal((await fetch(`${baseUrl}${uploadedUrl}`)).status, 200);

  const publicCatalogLive = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{ id: string; pricePaise: number }>;
  };
  const liveMatch = publicCatalogLive.items.find((p) => p.id === draftProd.id);
  assert.ok(liveMatch);
  assert.equal(liveMatch.pricePaise, 549900);

  // Optimistic locking conflict check: stale expectedVersion -> 409 VERSION_CONFLICT
  const stalePatch = await jsonReq(
    ownerJar,
    'PATCH',
    `/api/admin/products/${draftProd.id}`,
    {
      expectedVersion: draftProd.version, // stale v1 instead of v2
      title: 'Kanchipuram Rose Zari Skirt Set',
      category: 'Festive Collection',
      sku: 'SC-TEST-100',
      description: 'Updated description text for concurrency test.',
      fabricNote: 'Pure silk zari weave',
      pricePaise: 499900,
      status: 'published',
      variants: [
        {
          id: publishedProd.variants[0].id,
          sku: 'SC-TEST-100-S',
          size: 'S',
          colorName: 'Rosewood',
          colorHex: '#B76E79',
          pricePaise: 499900,
          stockQty: 4,
        },
      ],
      images: [{ url: uploadedUrl, alt: 'Front view', isCover: true }],
    },
    boundCsrf
  );
  assert.equal(stalePatch.res.status, 409);
  assert.equal(stalePatch.json.code, 'VERSION_CONFLICT');

  // Shopper adds size S variant (₹5,499) to bag; owner raises price to ₹5,999 -> cart revalidation flags PRICE_CHANGED
  const variantS = publishedProd.variants[0];
  const priceRaisePatch = await jsonReq(
    ownerJar,
    'PATCH',
    `/api/admin/products/${draftProd.id}`,
    {
      expectedVersion: publishedProd.version,
      title: 'Kanchipuram Rose Zari Skirt Set',
      category: 'Festive Collection',
      sku: 'SC-TEST-100',
      description: 'Handwoven rosewood zari festive skirt set tailored with silk lining.',
      fabricNote: 'Pure silk zari weave',
      pricePaise: 599900,
      status: 'published',
      variants: publishedProd.variants.map((v, idx) => ({
        id: v.id,
        sku: idx === 0 ? 'SC-TEST-100-S' : 'SC-TEST-100-M',
        size: idx === 0 ? 'S' : 'M',
        colorName: 'Rosewood',
        colorHex: '#B76E79',
        pricePaise: idx === 0 ? 599900 : 619900,
        stockQty: v.stockQty,
      })),
      images: [{ url: uploadedUrl, alt: 'Front view', isCover: true }],
    },
    boundCsrf
  );
  assert.equal(priceRaisePatch.res.status, 200);

  // Guest validates cart with old price 549900 -> detects priceChanged
  const cartJar = new CookieJar();
  const { csrfToken: cartCsrf } = await getSession(cartJar);
  const validateRes = await jsonReq(
    cartJar,
    'POST',
    '/api/cart/validate',
    {
      items: [
        {
          productId: draftProd.id,
          variantId: variantS.id,
          quantity: 2,
          seenPricePaise: 549900,
        },
      ],
    },
    cartCsrf
  );
  assert.equal(validateRes.res.status, 200);
  assert.equal(validateRes.json.hasPriceChanges, true);
  assert.equal(validateRes.json.subtotalPaise, 599900 * 2);

  // Tampered order attempt with old expectedPricePaise fails with 409 PRICE_CHANGED
  const staleOrderRes = await jsonReq(
    cartJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Ananya Rao',
      customerEmail: 'ananya@example.com',
      customerPhone: '+91 9876543210',
      shippingAddress: '12 Jubilee Hills, Hyderabad 500033',
      items: [
        {
          productId: draftProd.id,
          variantId: variantS.id,
          quantity: 2,
          expectedPricePaise: 549900,
        },
      ],
    },
    cartCsrf
  );
  assert.equal(staleOrderRes.res.status, 409);
  assert.equal(staleOrderRes.json.code, 'PRICE_CHANGED');

  // Exceeding variant S stock (5 > 4) fails with 409 INSUFFICIENT_STOCK
  const overStockRes = await jsonReq(
    cartJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Ananya Rao',
      customerEmail: 'ananya@example.com',
      customerPhone: '+91 9876543210',
      shippingAddress: '12 Jubilee Hills, Hyderabad 500033',
      items: [
        {
          productId: draftProd.id,
          variantId: variantS.id,
          quantity: 5,
          expectedPricePaise: 599900,
        },
      ],
    },
    cartCsrf
  );
  assert.equal(overStockRes.res.status, 409);
  assert.equal(overStockRes.json.code, 'INSUFFICIENT_STOCK');

  // Valid order (qty 2) succeeds at authoritative server price 599900 paise and decrements variant S stock 4 -> 2
  const validOrderRes = await jsonReq(
    cartJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Ananya Rao',
      customerEmail: 'ananya@example.com',
      customerPhone: '+91 9876543210',
      shippingAddress: '12 Jubilee Hills, Hyderabad 500033',
      items: [
        {
          productId: draftProd.id,
          variantId: variantS.id,
          quantity: 2,
          expectedPricePaise: 599900,
        },
      ],
    },
    cartCsrf
  );
  assert.equal(validOrderRes.res.status, 201);
  const placedOrder = validOrderRes.json.order as { id: string; totalPaise: number };
  assert.equal(placedOrder.totalPaise, 599900 * 2);

  // Verify stock decremented cleanly
  const afterOrderProdRes = await fetch(`${baseUrl}/api/products/${draftProd.id}`);
  const afterOrderProd = (await afterOrderProdRes.json()) as {
    product: { stockQty: number; variants: Array<{ id: string; stockQty: number }> };
  };
  const updatedVarS = afterOrderProd.product.variants.find((v) => v.id === variantS.id);
  assert.equal(updatedVarS?.stockQty, 2);

  // Deleting a product referenced by an order MUST archive it instead of hard deleting, preserving historical order line price!
  const deleteReferencedRes = await jsonReq(
    ownerJar,
    'DELETE',
    `/api/admin/products/${draftProd.id}`,
    undefined,
    boundCsrf
  );
  assert.equal(deleteReferencedRes.res.status, 200);
  assert.equal(deleteReferencedRes.json.archivedInsteadOfDeleted, true);

  // Audit log recorded lifecycle actions
  const auditRes = await fetch(`${baseUrl}/api/admin/audit?productId=${draftProd.id}`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(auditRes.status, 200);
  const auditData = (await auditRes.json()) as { items: Array<{ action: string }> };
  const actions = auditData.items.map((a) => a.action);
  assert.ok(actions.includes('create'));
  assert.ok(actions.includes('publish'));
  assert.ok(actions.includes('price_change'));
  assert.ok(actions.includes('archive'));

  // Persistence check: close DB & server, re-open a fresh app against the same SQLite path
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  appInstance.db?.close();

  appInstance = createAuthApp({
    dbPath,
    emailSender: testEmailSender,
    disableRateLimit: true,
    appBaseUrl: 'http://127.0.0.1:3000',
    seedCatalog: true,
  });
  server = http.createServer(appInstance.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const nextAddr = server.address();
  assert.ok(nextAddr && typeof nextAddr === 'object');
  baseUrl = `http://127.0.0.1:${nextAddr.port}`;

  // Previous owner session cookie still works and previous orders + archived product + audit logs persisted!
  const persistedOverviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(persistedOverviewRes.status, 200);
  const persistedOverview = (await persistedOverviewRes.json()) as {
    metrics: { totalOrders: number; archivedProducts: number };
  };
  assert.equal(persistedOverview.metrics.totalOrders, 1);
  assert.ok(persistedOverview.metrics.archivedProducts >= 1);

  const persistedOrdersRes = await fetch(`${baseUrl}/api/admin/orders`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  const persistedOrders = (await persistedOrdersRes.json()) as {
    items: Array<{ id: string; totalPaise: number; items: Array<{ unitPricePaise: number }> }>;
  };
  assert.equal(persistedOrders.items.length, 1);
  assert.equal(persistedOrders.items[0].totalPaise, 599900 * 2);
  assert.equal(persistedOrders.items[0].items[0].unitPricePaise, 599900);

  // Verify ADMIN_OWNER_EMAIL mismatch enforcement directly against persistent DB binding (no ADMIN_OWNER_USER_ID needed)
  const prevEnvEmail = process.env.ADMIN_OWNER_EMAIL;
  try {
    process.env.ADMIN_OWNER_EMAIL = 'other-email@example.com';
    const mismatchRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: ownerJar.getHeader() },
    });
    assert.equal(mismatchRes.status, 403);

    process.env.ADMIN_OWNER_EMAIL = ownerEmail;
    const matchedRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: ownerJar.getHeader() },
    });
    assert.equal(matchedRes.status, 200);
  } finally {
    if (prevEnvEmail === undefined) delete process.env.ADMIN_OWNER_EMAIL;
    else process.env.ADMIN_OWNER_EMAIL = prevEnvEmail;
  }

  // Owner password recovery flow: forgot-password -> reset-password -> sign in at /api/admin/login -> /api/admin/session
  const recoveryJar = new CookieJar();
  const { csrfToken: recCsrf } = await getSession(recoveryJar);
  const emailStart = sentEmails.length;
  const forgotRes = await jsonReq(
    recoveryJar,
    'POST',
    '/api/auth/forgot-password',
    { email: ownerEmail },
    recCsrf
  );
  assert.equal(forgotRes.res.status, 200);
  const resetEmailMsg = sentEmails.slice(emailStart).find((m) => m.to.toLowerCase() === ownerEmail);
  assert.ok(resetEmailMsg, 'Expected password reset email for owner');
  const resetToken = extractToken(resetEmailMsg.text || resetEmailMsg.html);

  const nextOwnerPass = 'RecoveredBoutique#2026!';
  const resetRes = await jsonReq(
    recoveryJar,
    'POST',
    '/api/auth/reset-password',
    { token: resetToken, password: nextOwnerPass },
    recCsrf
  );
  assert.equal(resetRes.res.status, 200);

  // Previous owner session was revoked on password reset
  const revokedSessionRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(revokedSessionRes.status, 401);

  const postResetSession = await getSession(recoveryJar);
  const recoveredLogin = await jsonReq(
    recoveryJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: nextOwnerPass },
    postResetSession.csrfToken
  );
  assert.equal(recoveredLogin.res.status, 200);
  assert.equal((recoveredLogin.json.user as { isOwner?: boolean })?.isOwner, true);
});

test('Server-side /admin redirect guard, session expiry, generic invalid login, and rate limiting work end-to-end', async () => {
  // 1. Unauthenticated GET /admin returns 302 redirect to /admin/login
  const unauthPageRes = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(unauthPageRes.status, 302);
  assert.equal(unauthPageRes.headers.get('location'), '/admin/login');
  assert.match(unauthPageRes.headers.get('x-robots-tag') || '', /noindex/i);
  assert.match(unauthPageRes.headers.get('cache-control') || '', /no-store/i);

  // 2. Unauthenticated GET /admin/login returns non-redirect response
  const loginPageRes = await fetch(`${baseUrl}/admin/login`, { redirect: 'manual' });
  assert.notEqual(loginPageRes.status, 302);

  // 3. Log in as the bound owner
  const jar = new CookieJar();
  const { csrfToken } = await getSession(jar);

  // Unknown email and wrong password both return generic "Invalid email or password."
  const unknownAttempt = await jsonReq(
    jar,
    'POST',
    '/api/admin/login',
    { email: 'unknown@example.com', password: 'SomePassword123!' },
    csrfToken
  );
  const wrongPassAttempt = await jsonReq(
    jar,
    'POST',
    '/api/admin/login',
    { email: 'saivinodkotipalli2003@gmail.com', password: 'WrongPassword123!' },
    csrfToken
  );
  assert.equal(unknownAttempt.res.status, 401);
  assert.equal(wrongPassAttempt.res.status, 401);
  assert.equal(unknownAttempt.json.error, 'Invalid email or password.');
  assert.equal(wrongPassAttempt.json.error, 'Invalid email or password.');

  // Valid login succeeds
  const validLogin = await jsonReq(
    jar,
    'POST',
    '/api/admin/login',
    { email: 'saivinodkotipalli2003@gmail.com', password: 'RecoveredBoutique#2026!' },
    csrfToken
  );
  assert.equal(validLogin.res.status, 200);
  assert.equal((validLogin.json.user as { isOwner?: boolean })?.isOwner, true);

  // Authenticated owner visiting /admin/login or /admin is redirected server-side to /admin/dashboard
  const alreadyAuthedLoginPage = await fetch(`${baseUrl}/admin/login`, {
    headers: { Cookie: jar.getHeader() },
    redirect: 'manual',
  });
  assert.equal(alreadyAuthedLoginPage.status, 302);
  assert.equal(alreadyAuthedLoginPage.headers.get('location'), '/admin/dashboard');

  const rootAdminRedirect = await fetch(`${baseUrl}/admin`, {
    headers: { Cookie: jar.getHeader() },
    redirect: 'manual',
  });
  assert.equal(rootAdminRedirect.status, 302);
  assert.equal(rootAdminRedirect.headers.get('location'), '/admin/dashboard');

  // Authenticated owner visiting /admin/dashboard passes the server guard (not redirected)
  const authedDashboardPage = await fetch(`${baseUrl}/admin/dashboard`, {
    headers: { Cookie: jar.getHeader() },
    redirect: 'manual',
  });
  assert.notEqual(authedDashboardPage.status, 302);

  // 4. Session expiry: expire all sessions in DB -> /api/admin/* returns 401 and GET /admin/dashboard redirects to /admin/login
  assert.ok(appInstance.db);
  appInstance.db.prepare(`UPDATE sessions SET expires_at = ?`).run(Date.now() - 1000);

  const expiredApi = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { Cookie: jar.getHeader() },
  });
  assert.equal(expiredApi.status, 401);

  const expiredPage = await fetch(`${baseUrl}/admin/dashboard`, {
    headers: { Cookie: jar.getHeader() },
    redirect: 'manual',
  });
  assert.equal(expiredPage.status, 302);
  assert.equal(expiredPage.headers.get('location'), '/admin/login');
});

test('POST /api/admin/login enforces rate limiting when rate limiter is active', async () => {
  const limitedApp = createAuthApp({
    dbPath: ':memory:',
    disableRateLimit: false,
    appBaseUrl: 'http://127.0.0.1:3000',
    seedCatalog: false,
  });
  const limitedServer = http.createServer(limitedApp.app);
  await new Promise<void>((resolve) => limitedServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = limitedServer.address();
  assert.ok(addr && typeof addr === 'object');
  const limitedUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const jar = new CookieJar();
    const bootRes = await fetch(`${limitedUrl}/api/auth/session`);
    jar.updateFromResponse(bootRes);
    const { csrfToken } = (await bootRes.json()) as { csrfToken: string };

    let lastStatus = 0;
    let lastCode: unknown = null;
    for (let i = 0; i < 12; i += 1) {
      const attempt = await fetch(`${limitedUrl}/api/admin/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          Cookie: jar.getHeader(),
        },
        body: JSON.stringify({
          email: 'saivinodkotipalli2003@gmail.com',
          password: 'WrongPassword123!',
        }),
      });
      lastStatus = attempt.status;
      const body = (await attempt.json().catch(() => ({}))) as { code?: string };
      lastCode = body.code;
      if (lastStatus === 429) break;
    }

    assert.equal(lastStatus, 429);
    assert.equal(lastCode, 'RATE_LIMITED');
  } finally {
    await new Promise<void>((resolve, reject) =>
      limitedServer.close((e) => (e ? reject(e) : resolve()))
    );
    limitedApp.db?.close();
  }
});

test('Categories CRUD, Storefront CMS Content & Settings updates, and Contact Messages inbox work end-to-end', async () => {
  const jar = new CookieJar();
  const { csrfToken } = await getSession(jar);

  const loginRes = await jsonReq(
    jar,
    'POST',
    '/api/admin/login',
    { email: 'saivinodkotipalli2003@gmail.com', password: 'RecoveredBoutique#2026!' },
    csrfToken
  );
  assert.equal(loginRes.res.status, 200);
  const ownerCsrf = String(loginRes.json.csrfToken || csrfToken);

  // 1. Categories CRUD: create a custom category, create a product in it, verify delete blocks with 409, rename propagates, then clean up
  const createCatRes = await jsonReq(
    jar,
    'POST',
    '/api/admin/categories',
    {
      name: 'Bridal Couture',
      subtitle: 'Heirloom lehengas & hand-embroidered trousseaus',
      imageUrl: '/boutique-media/col_festive_1794557704352.jpg',
      altText: 'Bridal Couture collection look',
      position: 5,
    },
    ownerCsrf
  );
  assert.equal(createCatRes.res.status, 201);
  const createdCategory = createCatRes.json.category as { id: string; name: string };
  assert.equal(createdCategory.name, 'Bridal Couture');

  const createCatProduct = await jsonReq(
    jar,
    'POST',
    '/api/admin/products',
    {
      title: 'Crimson Bridal Zardozi Lehenga',
      category: 'Bridal Couture',
      sku: 'SC-BRIDAL-01',
      description: 'Hand-embroidered bridal lehenga.',
      fabricNote: 'Pure silk velvet with zardozi',
      pricePaise: 1450000,
      lowStockThreshold: 2,
      featured: false,
      status: 'draft',
      variants: [
        {
          sku: 'SC-BRIDAL-01-S',
          size: 'S',
          colorName: 'Crimson',
          colorHex: '#991B1B',
          pricePaise: 1450000,
          stockQty: 3,
        },
      ],
      images: [{ url: '/boutique-media/col_festive_1794557704352.jpg', alt: 'Lehenga', isCover: true }],
    },
    ownerCsrf
  );
  assert.equal(createCatProduct.res.status, 201);
  const bridalProduct = createCatProduct.json.product as { id: string };

  // Deleting category while product references it -> 409 CATEGORY_IN_USE
  const deleteInUseRes = await jsonReq(
    jar,
    'DELETE',
    `/api/admin/categories/${createdCategory.id}`,
    undefined,
    ownerCsrf
  );
  assert.equal(deleteInUseRes.res.status, 409);
  assert.equal(deleteInUseRes.json.code, 'CATEGORY_IN_USE');

  // Renaming category propagates to assigned product
  const renameCatRes = await jsonReq(
    jar,
    'PATCH',
    `/api/admin/categories/${createdCategory.id}`,
    {
      name: 'Heirloom Bridal',
      subtitle: 'Handcrafted wedding trousseaus',
    },
    ownerCsrf
  );
  assert.equal(renameCatRes.res.status, 200);
  const fetchedProdAfterRename = await fetch(`${baseUrl}/api/admin/products/${bridalProduct.id}`, {
    headers: { Cookie: jar.getHeader() },
  });
  assert.equal(fetchedProdAfterRename.status, 200);
  const renamedProdJson = (await fetchedProdAfterRename.json()) as { product: { category: string } };
  assert.equal(renamedProdJson.product.category, 'Heirloom Bridal');

  // Remove the draft product, then delete the unused category
  const delProdRes = await jsonReq(
    jar,
    'DELETE',
    `/api/admin/products/${bridalProduct.id}`,
    undefined,
    ownerCsrf
  );
  assert.equal(delProdRes.res.status, 200);

  const deleteUnusedCatRes = await jsonReq(
    jar,
    'DELETE',
    `/api/admin/categories/${createdCategory.id}`,
    undefined,
    ownerCsrf
  );
  assert.equal(deleteUnusedCatRes.res.status, 200);

  // 2. Upload image for CMS logo & verify public media access once referenced in Settings & Content
  const uploadForm = new FormData();
  uploadForm.append('files', new Blob([VALID_PNG_BYTES], { type: 'image/png' }), 'brand-logo.png');
  const uploadRes = await fetch(`${baseUrl}/api/admin/uploads`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': ownerCsrf, Cookie: jar.getHeader() },
    body: uploadForm,
  });
  assert.equal(uploadRes.status, 201);
  const uploadedLogoUrl = ((await uploadRes.json()) as { files: Array<{ url: string }> }).files[0].url;

  const settingsGetRes = await fetch(`${baseUrl}/api/admin/settings`, {
    headers: { Cookie: jar.getHeader() },
  });
  assert.equal(settingsGetRes.status, 200);
  const currentSettings = ((await settingsGetRes.json()) as { settings: Record<string, unknown> }).settings;

  const updateSettingsRes = await jsonReq(
    jar,
    'PUT',
    '/api/admin/settings',
    {
      ...currentSettings,
      brandName: 'Sahithi Atelier Hyderabad',
      tagline: 'Curated Festive & Handloom Luxury',
      logoUrl: uploadedLogoUrl,
    },
    ownerCsrf
  );
  assert.equal(updateSettingsRes.res.status, 200);

  const contentGetRes = await fetch(`${baseUrl}/api/admin/content`, {
    headers: { Cookie: jar.getHeader() },
  });
  assert.equal(contentGetRes.status, 200);
  const currentContent = ((await contentGetRes.json()) as { content: { hero: Record<string, unknown> } }).content;

  const updateContentRes = await jsonReq(
    jar,
    'PUT',
    '/api/admin/content',
    {
      ...currentContent,
      hero: {
        ...currentContent.hero,
        eyebrow: 'AUTUMN / FESTIVE 2026',
        headline: 'Crafted Silhouettes for Modern Celebrations.',
      },
    },
    ownerCsrf
  );
  assert.equal(updateContentRes.res.status, 200);

  // Public /api/storefront reflects updates and uploaded logo media URL is publicly accessible
  const publicStorefrontRes = await fetch(`${baseUrl}/api/storefront`);
  assert.equal(publicStorefrontRes.status, 200);
  const storefrontData = (await publicStorefrontRes.json()) as {
    settings: { brandName: string; logoUrl: string };
    content: { hero: { eyebrow: string; headline: string } };
  };
  assert.equal(storefrontData.settings.brandName, 'Sahithi Atelier Hyderabad');
  assert.equal(storefrontData.settings.logoUrl, uploadedLogoUrl);
  assert.equal(storefrontData.content.hero.eyebrow, 'AUTUMN / FESTIVE 2026');
  assert.equal((await fetch(`${baseUrl}${uploadedLogoUrl}`)).status, 200);

  // 3. Public boutique enquiry -> admin overview unread count -> admin messages status/note -> delete
  const visitorJar = new CookieJar();
  const { csrfToken: visitorCsrf } = await getSession(visitorJar);
  const contactRes = await jsonReq(
    visitorJar,
    'POST',
    '/api/contact',
    {
      senderName: 'Meera Krishnan',
      senderEmail: 'meera@example.com',
      senderPhone: '+91 98480 12345',
      subject: 'Custom Anarkali Fitting',
      message: 'Would love to book a private bridal styling appointment next Friday.',
    },
    visitorCsrf
  );
  assert.equal(contactRes.res.status, 201);

  const overviewAfterMsgRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: jar.getHeader() },
  });
  assert.equal(overviewAfterMsgRes.status, 200);
  const overviewAfterMsg = (await overviewAfterMsgRes.json()) as {
    metrics: { unreadMessages: number; totalMessages: number };
    recentMessages: Array<{ id: string; senderName: string; status: string }>;
  };
  assert.ok(overviewAfterMsg.metrics.unreadMessages >= 1);
  const createdMsg = overviewAfterMsg.recentMessages.find((m) => m.senderName === 'Meera Krishnan');
  assert.ok(createdMsg);
  assert.equal(createdMsg.status, 'unread');

  const patchMsgRes = await jsonReq(
    jar,
    'PATCH',
    `/api/admin/messages/${createdMsg.id}`,
    {
      status: 'replied',
      adminNote: 'Confirmed appointment for Friday 4 PM.',
    },
    ownerCsrf
  );
  assert.equal(patchMsgRes.res.status, 200);
  assert.equal((patchMsgRes.json.message as { status: string }).status, 'replied');
  assert.equal(
    (patchMsgRes.json.message as { adminNote: string }).adminNote,
    'Confirmed appointment for Friday 4 PM.'
  );

  const listRepliedRes = await fetch(`${baseUrl}/api/admin/messages?status=replied&q=Meera`, {
    headers: { Cookie: jar.getHeader() },
  });
  assert.equal(listRepliedRes.status, 200);
  const listReplied = (await listRepliedRes.json()) as {
    items: Array<{ id: string }>;
    unreadCount: number;
  };
  assert.equal(listReplied.items.length, 1);
  assert.equal(listReplied.unreadCount, 0);

  const delMsgRes = await jsonReq(
    jar,
    'DELETE',
    `/api/admin/messages/${createdMsg.id}`,
    undefined,
    ownerCsrf
  );
  assert.equal(delMsgRes.res.status, 200);
});

test('CMS optional empty fields persist without default reversion, validation returns fieldErrors, re-publishing clears archivedAt, and RBAC blocks customers', async () => {
  const ownerJar = new CookieJar();
  const { csrfToken } = await getSession(ownerJar);
  const loginRes = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: 'saivinodkotipalli2003@gmail.com', password: 'RecoveredBoutique#2026!' },
    csrfToken
  );
  assert.equal(loginRes.res.status, 200);
  const ownerCsrf = String(loginRes.json.csrfToken || csrfToken);

  // 1. Cleared optional fields in Content & Settings must persist as empty strings instead of silently reverting
  const currentSettingsRes = await fetch(`${baseUrl}/api/admin/settings`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  const currentSettings = (
    (await currentSettingsRes.json()) as {
      settings: {
        brandName: string;
        tagline: string;
        logoUrl: string;
        contact: Record<string, string>;
        socialLinks: Record<string, string>;
      };
    }
  ).settings;

  const clearedSettingsRes = await jsonReq(
    ownerJar,
    'PUT',
    '/api/admin/settings',
    {
      ...currentSettings,
      tagline: '',
      logoUrl: '',
      contact: {
        ...currentSettings.contact,
        storeAddress: '',
      },
    },
    ownerCsrf
  );
  assert.equal(clearedSettingsRes.res.status, 200);
  const savedSettings = clearedSettingsRes.json.settings as {
    tagline: string;
    logoUrl: string;
    contact: { storeAddress: string };
  };
  assert.equal(savedSettings.tagline, '');
  assert.equal(savedSettings.logoUrl, '');
  assert.equal(savedSettings.contact.storeAddress, '');

  const currentContentRes = await fetch(`${baseUrl}/api/admin/content`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  const currentContent = (
    (await currentContentRes.json()) as {
      content: {
        hero: Record<string, unknown>;
        collectionsHeader: Record<string, unknown>;
        lookbookEntries: Array<Record<string, unknown>>;
        [k: string]: unknown;
      };
    }
  ).content;

  const clearedContentRes = await jsonReq(
    ownerJar,
    'PUT',
    '/api/admin/content',
    {
      ...currentContent,
      hero: {
        ...currentContent.hero,
        eyebrow: '',
      },
      collectionsHeader: {
        ...currentContent.collectionsHeader,
        kicker: '',
      },
      lookbookEntries: currentContent.lookbookEntries.map((entry, idx) =>
        idx === 0 ? { ...entry, caption: '' } : entry
      ),
    },
    ownerCsrf
  );
  assert.equal(clearedContentRes.res.status, 200);
  const savedContent = clearedContentRes.json.content as {
    hero: { eyebrow: string };
    collectionsHeader: { kicker: string };
    lookbookEntries: Array<{ caption: string }>;
  };
  assert.equal(savedContent.hero.eyebrow, '');
  assert.equal(savedContent.collectionsHeader.kicker, '');
  assert.equal(savedContent.lookbookEntries[0].caption, '');

  // Verify public /api/storefront reflects empty optional strings rather than defaults
  const sfAfterClear = (await (await fetch(`${baseUrl}/api/storefront`)).json()) as {
    settings: { tagline: string };
    content: { hero: { eyebrow: string }; collectionsHeader: { kicker: string } };
  };
  assert.equal(sfAfterClear.settings.tagline, '');
  assert.equal(sfAfterClear.content.hero.eyebrow, '');
  assert.equal(sfAfterClear.content.collectionsHeader.kicker, '');

  // 2. Structured fieldErrors validation checks across endpoints
  const badCategory = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/categories',
    { name: 'Test Cat', position: 1001 },
    ownerCsrf
  );
  assert.equal(badCategory.res.status, 400);
  assert.equal(badCategory.json.code, 'VALIDATION_ERROR');
  assert.ok((badCategory.json.fieldErrors as Record<string, string>)?.position);

  const badContent = await jsonReq(
    ownerJar,
    'PUT',
    '/api/admin/content',
    {
      ...currentContent,
      hero: { ...currentContent.hero, headline: '   ' },
    },
    ownerCsrf
  );
  assert.equal(badContent.res.status, 400);
  assert.ok((badContent.json.fieldErrors as Record<string, string>)?.['hero.headline']);

  const badSettings = await jsonReq(
    ownerJar,
    'PUT',
    '/api/admin/settings',
    {
      ...currentSettings,
      contact: { ...currentSettings.contact, email: 'not-an-email' },
      socialLinks: { ...currentSettings.socialLinks, instagramUrl: 'not-a-url' },
    },
    ownerCsrf
  );
  assert.equal(badSettings.res.status, 400);
  assert.ok((badSettings.json.fieldErrors as Record<string, string>)?.['contact.email']);

  const badProduct = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/products',
    { title: 'A' },
    ownerCsrf
  );
  assert.equal(badProduct.res.status, 400);
  assert.ok((badProduct.json.fieldErrors as Record<string, string>)?.title);

  // Oversized adminNote (>1000 chars) returns 400 VALIDATION_ERROR + fieldErrors.adminNote
  const visitorJar = new CookieJar();
  const { csrfToken: visitorCsrf } = await getSession(visitorJar);
  const msgCreate = await jsonReq(
    visitorJar,
    'POST',
    '/api/contact',
    {
      senderName: 'Validation Probe',
      senderEmail: 'probe@example.com',
      subject: 'Note Limit Check',
      message: 'Testing message adminNote length enforcement.',
    },
    visitorCsrf
  );
  assert.equal(msgCreate.res.status, 201);
  const createdMsgId = String(msgCreate.json.id);

  const longNoteRes = await jsonReq(
    ownerJar,
    'PATCH',
    `/api/admin/messages/${createdMsgId}`,
    { adminNote: 'x'.repeat(1005) },
    ownerCsrf
  );
  assert.equal(longNoteRes.res.status, 400);
  assert.equal(longNoteRes.json.code, 'VALIDATION_ERROR');
  assert.ok((longNoteRes.json.fieldErrors as Record<string, string>)?.adminNote);

  await jsonReq(ownerJar, 'DELETE', `/api/admin/messages/${createdMsgId}`, undefined, ownerCsrf);

  // 3. Re-publishing an archived product clears archivedAt and restores live visibility
  const archCreate = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/products',
    {
      title: 'Archive Restore Test Kurta',
      category: 'Ethnic Wear',
      sku: 'SC-ARCH-01',
      description: 'Handspun cotton silk festive kurta for archive-republish verification.',
      pricePaise: 329900,
      status: 'published',
      variants: [
        {
          sku: 'SC-ARCH-01-M',
          size: 'M',
          colorName: 'Ivory',
          colorHex: '#FAF7F2',
          pricePaise: 329900,
          stockQty: 5,
        },
      ],
      images: [{ url: '/boutique-media/col_ethnic_1794557704352.jpg', alt: 'Kurta', isCover: true }],
    },
    ownerCsrf
  );
  assert.equal(archCreate.res.status, 201);
  const archProd = archCreate.json.product as { id: string; version: number };

  const archivedRes = await jsonReq(
    ownerJar,
    'POST',
    `/api/admin/products/${archProd.id}/archive`,
    { expectedVersion: archProd.version },
    ownerCsrf
  );
  assert.equal(archivedRes.res.status, 200);
  const archivedDto = archivedRes.json.product as { version: number; archivedAt: number | null; status: string };
  assert.equal(archivedDto.status, 'archived');
  assert.ok(archivedDto.archivedAt !== null);

  const republishedRes = await jsonReq(
    ownerJar,
    'PATCH',
    `/api/admin/products/${archProd.id}`,
    {
      expectedVersion: archivedDto.version,
      title: 'Archive Restore Test Kurta',
      category: 'Ethnic Wear',
      sku: 'SC-ARCH-01',
      description: 'Handspun cotton silk festive kurta for archive-republish verification.',
      pricePaise: 329900,
      status: 'published',
      variants: [
        {
          sku: 'SC-ARCH-01-M',
          size: 'M',
          colorName: 'Ivory',
          colorHex: '#FAF7F2',
          pricePaise: 329900,
          stockQty: 5,
        },
      ],
      images: [{ url: '/boutique-media/col_ethnic_1794557704352.jpg', alt: 'Kurta', isCover: true }],
    },
    ownerCsrf
  );
  assert.equal(republishedRes.res.status, 200);
  const republishedDto = republishedRes.json.product as { status: string; archivedAt: number | null };
  assert.equal(republishedDto.status, 'published');
  assert.equal(republishedDto.archivedAt, null);
  assert.equal((await fetch(`${baseUrl}/api/products/${archProd.id}`)).status, 200);

  await jsonReq(ownerJar, 'DELETE', `/api/admin/products/${archProd.id}`, undefined, ownerCsrf);

  // 4. Customer RBAC checks on all write admin routes -> 403
  const custJar = new CookieJar();
  const cust = await registerAndVerifyCustomer(
    custJar,
    'Customer Check',
    'cust-rbac@example.com',
    'CustomerPass#2026!'
  );
  const writeChecks: Array<[string, string, unknown]> = [
    ['PUT', '/api/admin/content', currentContent],
    ['PUT', '/api/admin/settings', currentSettings],
    ['POST', '/api/admin/categories', { name: 'Forbidden Cat', position: 1 }],
    ['PATCH', '/api/admin/messages/nonexistent', { status: 'read' }],
    ['PATCH', '/api/admin/orders/nonexistent/status', { status: 'confirmed' }],
  ];
  for (const [method, pathUrl, payload] of writeChecks) {
    const r = await jsonReq(custJar, method, pathUrl, payload, cust.csrfToken);
    assert.equal(r.res.status, 403, `${method} ${pathUrl} must return 403 for customers`);
  }
});

test('FirestoreRestStore surfaces StoreHttpError (403/500) instead of masking Firestore errors as null', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Missing or insufficient permissions.' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const fsStore = new FirestoreRestStore({
      config: {
        projectId: 'mock-project',
        apiKey: 'mock-key',
        authDomain: 'mock.firebaseapp.com',
        firestoreDatabaseId: '(default)',
      },
      namespace: 'shared-preview',
      targetEnv: 'shared-preview',
      ownerEmail: 'saivinodkotipalli2003@gmail.com',
    });

    await assert.rejects(
      () => fsStore.resolveBoundOwner(),
      (err: unknown) => err instanceof StoreHttpError && err.httpStatus === 403
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Sign out clears partitioned and unpartitioned cookies, enforces no-store caching, protects /account, and rejects replayed session cookies', async () => {
  const jar = new CookieJar();
  const { csrfToken: initCsrf } = await getSession(jar);

  const cust = await registerAndVerifyCustomer(
    jar,
    'Logout Verification Shopper',
    'logout-verify@example.com',
    'BoutiquePass#2026!'
  );
  assert.ok(jar.getHeader().includes('sc_session='));

  const staleSessionHeader = jar.getHeader();

  // Authenticated /account does not redirect and returns no-store headers
  const acctBefore = await fetch(`${baseUrl}/account`, {
    headers: { Cookie: staleSessionHeader },
    redirect: 'manual',
  });
  assert.ok(acctBefore.status !== 302);
  assert.match(acctBefore.headers.get('cache-control') || '', /no-store/i);

  // Logout over HTTPS proxy headers clears partitioned, unpartitioned, and lax cookie jars
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      'X-CSRF-Token': cust.csrfToken || initCsrf,
      Cookie: jar.getHeader(),
    },
    body: JSON.stringify({}),
  });
  assert.equal(logoutRes.status, 200);
  assert.match(logoutRes.headers.get('cache-control') || '', /no-store/i);
  const setCookies = logoutRes.headers.getSetCookie();
  assert.ok(
    setCookies.some((c) => c.startsWith('sc_session=;') && c.includes('Partitioned') && c.includes('SameSite=None')),
    'Should emit Partitioned clear header for sc_session'
  );
  assert.ok(
    setCookies.some((c) => c.startsWith('sc_fb_session=;') && c.includes('Partitioned') && c.includes('SameSite=None')),
    'Should emit Partitioned clear header for sc_fb_session'
  );
  assert.ok(
    setCookies.some((c) => c.startsWith('sc_session=;') && c.includes('SameSite=Lax')),
    'Should emit SameSite=Lax clear header for sc_session'
  );
  jar.updateFromResponse(logoutRes);
  assert.ok(!jar.getHeader().includes('sc_session='));

  // Replaying the pre-logout session cookie must be rejected
  const replayProfile = await fetch(`${baseUrl}/api/account/profile`, {
    headers: { Cookie: staleSessionHeader },
  });
  assert.equal(replayProfile.status, 401);

  const replaySession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: staleSessionHeader },
  });
  assert.equal(replaySession.status, 200);
  assert.match(replaySession.headers.get('cache-control') || '', /no-store/i);
  const replaySessionJson = (await replaySession.json()) as { authenticated: boolean; user: unknown };
  assert.equal(replaySessionJson.authenticated, false);
  assert.equal(replaySessionJson.user, null);

  // Visiting /account or /admin after logout redirects to login pages
  const acctAfter = await fetch(`${baseUrl}/account`, {
    headers: { Cookie: jar.getHeader() },
    redirect: 'manual',
  });
  assert.equal(acctAfter.status, 302);
  assert.equal(acctAfter.headers.get('location'), '/login?next=%2Faccount');

  const adminAfter = await fetch(`${baseUrl}/admin/dashboard`, {
    headers: { Cookie: jar.getHeader() },
    redirect: 'manual',
  });
  assert.equal(adminAfter.status, 302);
  assert.equal(adminAfter.headers.get('location'), '/admin/login');
});

test('Edit Product and Delete Product: preserves existing URL on title edit, syncs storefront, removes deleted items from active list and cart, and enforces 401/403 RBAC', async () => {
  const ownerEmail = 'saivinodkotipalli2003@gmail.com';
  const ownerPass = 'RecoveredBoutique#2026!';
  const ownerJar = new CookieJar();
  const { csrfToken: initCsrf } = await getSession(ownerJar);

  const loginRes = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: ownerPass },
    initCsrf
  );
  assert.equal(loginRes.res.status, 200);
  const ownerCsrf = String(loginRes.json.csrfToken);

  // Create a published test product
  const createRes = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/products',
    {
      title: 'Test Boutique Kurti',
      category: 'Kurtis',
      sku: 'SC-TEST-EDIT-DEL',
      description: 'Handcrafted test kurti for verifying edit and delete workflows.',
      fabricNote: 'Pure Cotton',
      pricePaise: 79900,
      status: 'published',
      images: [{ url: '/boutique-media/prod_hand_embroidered_kurti_1794557658962.jpg', alt: 'Test Boutique Kurti', isCover: true }],
      variants: [
        {
          sku: 'SC-TEST-EDIT-DEL-S',
          size: 'S',
          colorName: 'Rose',
          colorHex: '#E8B8C8',
          pricePaise: 79900,
          compareAtPaise: null,
          stockQty: 10,
        },
      ],
    },
    ownerCsrf
  );
  assert.equal(createRes.res.status, 201);
  const created = createRes.json.product as {
    id: string;
    slug: string;
    name: string;
    pricePaise: number;
    stockQty: number;
    version: number;
    variants: Array<{ id: string; sku: string }>;
  };
  const originalSlug = created.slug;
  assert.equal(originalSlug, 'test-boutique-kurti');

  // Verify non-admins receive 401 (signed out) and 403 (customer) on direct edit and delete requests
  const anonJar = new CookieJar();
  const { csrfToken: anonCsrf } = await getSession(anonJar);
  const anonEdit = await jsonReq(
    anonJar,
    'PATCH',
    `/api/admin/products/${created.id}`,
    { title: 'Hacked Title' },
    anonCsrf
  );
  assert.equal(anonEdit.res.status, 401);
  const anonDel = await jsonReq(
    anonJar,
    'DELETE',
    `/api/admin/products/${created.id}`,
    undefined,
    anonCsrf
  );
  assert.equal(anonDel.res.status, 401);

  const custJar = new CookieJar();
  const cust = await registerAndVerifyCustomer(
    custJar,
    'Non Admin Shopper',
    'non-admin-rbac@example.com',
    'ShopperPass#2026!'
  );
  const custEdit = await jsonReq(
    custJar,
    'PATCH',
    `/api/admin/products/${created.id}`,
    { title: 'Hacked Title' },
    cust.csrfToken
  );
  assert.equal(custEdit.res.status, 403);
  const custDel = await jsonReq(
    custJar,
    'DELETE',
    `/api/admin/products/${created.id}`,
    undefined,
    cust.csrfToken
  );
  assert.equal(custDel.res.status, 403);

  // Edit product's name, price, and stock as admin
  const patchRes = await jsonReq(
    ownerJar,
    'PATCH',
    `/api/admin/products/${created.id}`,
    {
      expectedVersion: created.version,
      title: 'Test Boutique Kurti Edited Edition',
      category: 'Kurtis',
      sku: 'SC-TEST-EDIT-DEL',
      description: 'Updated description for the edited test kurti.',
      fabricNote: 'Pure Mulmul Cotton',
      pricePaise: 94900,
      status: 'published',
      images: [{ url: '/boutique-media/prod_hand_embroidered_kurti_1794557658962.jpg', alt: 'Test Boutique Kurti Edited Edition', isCover: true }],
      variants: [
        {
          id: created.variants[0].id,
          sku: 'SC-TEST-EDIT-DEL-S',
          size: 'S',
          colorName: 'Rose',
          colorHex: '#E8B8C8',
          pricePaise: 94900,
          compareAtPaise: null,
          stockQty: 18,
        },
      ],
    },
    ownerCsrf
  );
  assert.equal(patchRes.res.status, 200);
  const updated = patchRes.json.product as {
    id: string;
    slug: string;
    name: string;
    pricePaise: number;
    stockQty: number;
  };
  assert.equal(updated.name, 'Test Boutique Kurti Edited Edition');
  assert.equal(updated.pricePaise, 94900);
  assert.equal(updated.stockQty, 18);
  // Existing URL slug MUST be preserved after title edit!
  assert.equal(updated.slug, originalSlug);

  // Verify at existing product URL (/api/products/<originalSlug>) and signed-out storefront list
  const bySlugRes = await fetch(`${baseUrl}/api/products/${originalSlug}`);
  assert.equal(bySlugRes.status, 200);
  const bySlugData = (await bySlugRes.json()) as {
    product: { id: string; name: string; pricePaise: number; stockQty: number };
  };
  assert.equal(bySlugData.product.name, 'Test Boutique Kurti Edited Edition');
  assert.equal(bySlugData.product.pricePaise, 94900);
  assert.equal(bySlugData.product.stockQty, 18);

  // Now delete the test product as admin
  const delRes = await jsonReq(
    ownerJar,
    'DELETE',
    `/api/admin/products/${created.id}`,
    undefined,
    ownerCsrf
  );
  assert.equal(delRes.res.status, 200);
  assert.equal(delRes.json.archivedInsteadOfDeleted, false);

  // Verify removed from active admin list
  const adminListRes = await fetch(`${baseUrl}/api/admin/products?pageSize=100`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  const adminListData = (await adminListRes.json()) as { items: Array<{ id: string }> };
  assert.ok(!adminListData.items.some((p) => p.id === created.id));

  // Verify removed from public storefront & category filter & old product URL returns 404
  const pubListRes = await fetch(`${baseUrl}/api/products?category=Kurtis`);
  const pubListData = (await pubListRes.json()) as { items: Array<{ id: string }> };
  assert.ok(!pubListData.items.some((p) => p.id === created.id));

  const oldUrlRes = await fetch(`${baseUrl}/api/products/${originalSlug}`);
  assert.equal(oldUrlRes.status, 404);

  // Verify customer with the deleted product in their cart cannot order it
  const cartCheckRes = await jsonReq(
    anonJar,
    'POST',
    '/api/cart/validate',
    {
      items: [
        {
          productId: created.id,
          variantId: created.variants[0].id,
          quantity: 1,
          seenPricePaise: 94900,
        },
      ],
    },
    anonCsrf
  );
  assert.equal(cartCheckRes.res.status, 200);
  assert.equal(cartCheckRes.json.hasUnavailable, true);

  const orderDeletedRes = await jsonReq(
    anonJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Test Shopper',
      customerEmail: 'shopper@example.com',
      customerPhone: '+91 9876543210',
      shippingAddress: '12 Jubilee Hills, Hyderabad 500033',
      items: [
        {
          productId: created.id,
          variantId: created.variants[0].id,
          quantity: 1,
          expectedPricePaise: 94900,
        },
      ],
    },
    anonCsrf
  );
  assert.equal(orderDeletedRes.res.status, 409);
  assert.equal(orderDeletedRes.json.code, 'PRODUCT_UNAVAILABLE');

  // Verify unpublishing and re-publishing starter product sc-101 (Floral Cotton Kurti)
  const unpubSc101 = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/products/sc-101/unpublish',
    { expectedVersion: 999 }, // Even with stale expectedVersion, single-click transition succeeds
    ownerCsrf
  );
  assert.equal(unpubSc101.res.status, 200);
  const unpubProd = unpubSc101.json.product as { id: string; status: string; sku: string };
  assert.equal(unpubProd.id, 'sc-101');
  assert.equal(unpubProd.status, 'draft');

  // Verify sc-101 is hidden from public storefront while unpublished
  const pubAfterUnpub = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{ id: string }>;
  };
  assert.ok(!pubAfterUnpub.items.some((p) => p.id === 'sc-101'));

  // Re-publish sc-101
  const repubSc101 = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/products/sc-101/publish',
    {},
    ownerCsrf
  );
  assert.equal(repubSc101.res.status, 200);
  const repubProd = repubSc101.json.product as { id: string; status: string };
  assert.equal(repubProd.id, 'sc-101');
  assert.equal(repubProd.status, 'published');

  // Verify sc-101 is visible again on public storefront
  const pubAfterRepub = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{ id: string }>;
  };
  assert.ok(pubAfterRepub.items.some((p) => p.id === 'sc-101'));
});
