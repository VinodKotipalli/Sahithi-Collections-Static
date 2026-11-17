import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTHORIZED_OWNER_EMAIL,
  clearClientFirebaseSession,
  handleClientlessApiRequest,
  invalidateClientSessionVerificationCache,
} from '../src/services/firebaseClientApi.ts';

function encodeFirestoreValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => encodeFirestoreValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = encodeFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function encodeFirestoreDoc(name: string, data: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) fields[k] = encodeFirestoreValue(v);
  }
  return { name, fields };
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function installMemoryWebStorage() {
  const createStore = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
    };
  };
  const sessionStorage = createStore();
  const localStorage = createStore();
  (globalThis as Record<string, unknown>).window = {
    location: {
      hostname: 'sahithidesigns.online',
      origin: 'https://sahithidesigns.online',
    },
    sessionStorage,
    localStorage,
  };
  return { sessionStorage, localStorage };
}

interface MockFirestoreHarness {
  docs: Map<string, Record<string, unknown>>;
  writeCalls: Array<{ collection: string; docId: string; data: Record<string, unknown> }>;
  deleteCalls: Array<{ collection: string; docId: string }>;
  failNextLookupTransient: boolean;
  failFirestoreWriteWith403: boolean;
  failFirestoreDeleteWith403: boolean;
  currentEmail: string;
  currentUid: string;
  currentVerified: boolean;
}

function setupMockFirebaseFetch() {
  const originalFetch = globalThis.fetch;
  installMemoryWebStorage();
  clearClientFirebaseSession();

  const harness: MockFirestoreHarness = {
    docs: new Map(),
    writeCalls: [],
    deleteCalls: [],
    failNextLookupTransient: false,
    failFirestoreWriteWith403: false,
    failFirestoreDeleteWith403: false,
    currentEmail: AUTHORIZED_OWNER_EMAIL,
    currentUid: 'uid-owner-1',
    currentVerified: true,
  };

  const makeToken = () =>
    makeFakeJwt({
      user_id: harness.currentUid,
      email: harness.currentEmail,
      email_verified: harness.currentVerified,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')) {
      const body = JSON.parse(String(init?.body || '{}')) as { email?: string };
      const email = String(body.email || '').toLowerCase();
      harness.currentEmail = email;
      harness.currentUid = email === AUTHORIZED_OWNER_EMAIL ? 'uid-owner-1' : 'uid-customer-1';
      return new Response(
        JSON.stringify({
          idToken: makeToken(),
          refreshToken: `refresh-${harness.currentUid}`,
          localId: harness.currentUid,
          email: harness.currentEmail,
          displayName: email === AUTHORIZED_OWNER_EMAIL ? 'Store Owner' : 'Customer Member',
          expiresIn: '3600',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      if (harness.failNextLookupTransient) {
        harness.failNextLookupTransient = false;
        return new Response(
          JSON.stringify({ error: { code: 503, message: 'SERVICE_UNAVAILABLE' } }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          users: [
            {
              localId: harness.currentUid,
              email: harness.currentEmail,
              emailVerified: harness.currentVerified,
              displayName:
                harness.currentEmail === AUTHORIZED_OWNER_EMAIL ? 'Store Owner' : 'Customer Member',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('firestore.googleapis.com/v1/')) {
      const envMarker = '/documents/environments/';
      const idx = url.indexOf(envMarker);
      assert.ok(idx !== -1, `Unexpected Firestore URL: ${url}`);
      const afterEnv = url.slice(idx + envMarker.length);
      const slashIdx = afterEnv.indexOf('/');
      const restPath = afterEnv.slice(slashIdx + 1).split('?')[0];

      if (restPath === ':runQuery' && method === 'POST') {
        const prefix = 'products/';
        const matched = Array.from(harness.docs.entries())
          .filter(([key, val]) => key.startsWith(prefix) && val.status === 'published')
          .map(([key, val]) => ({
            document: encodeFirestoreDoc(key, val),
          }));
        return new Response(JSON.stringify(matched), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const segments = restPath.split('/');
      if (segments.length === 1 && method === 'GET') {
        const col = segments[0];
        const prefix = `${col}/`;
        const documents = Array.from(harness.docs.entries())
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, val]) => encodeFirestoreDoc(key, val));
        return new Response(JSON.stringify({ documents }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (segments.length === 2) {
        const col = segments[0];
        const docId = decodeURIComponent(segments[1]);
        const key = `${col}/${docId}`;

        if (method === 'GET') {
          const existing = harness.docs.get(key);
          if (!existing) {
            return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify(encodeFirestoreDoc(key, existing)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (method === 'PATCH') {
          if (harness.failFirestoreWriteWith403) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 403,
                  status: 'PERMISSION_DENIED',
                  message: 'Missing or insufficient permissions.',
                },
              }),
              { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
          }
          const raw = JSON.parse(String(init?.body || '{}')) as {
            fields?: Record<string, unknown>;
          };
          const decodeVal = (fv: Record<string, unknown>): unknown => {
            if (!fv) return null;
            if ('nullValue' in fv) return null;
            if ('booleanValue' in fv) return Boolean(fv.booleanValue);
            if ('integerValue' in fv) return Number(fv.integerValue);
            if ('doubleValue' in fv) return Number(fv.doubleValue);
            if ('stringValue' in fv) return String(fv.stringValue ?? '');
            if ('arrayValue' in fv) {
              const arr = (fv.arrayValue as { values?: Array<Record<string, unknown>> })?.values || [];
              return arr.map((item) => decodeVal(item));
            }
            if ('mapValue' in fv) {
              const out: Record<string, unknown> = {};
              const mf = (fv.mapValue as { fields?: Record<string, Record<string, unknown>> })?.fields || {};
              for (const [k, v] of Object.entries(mf)) {
                out[k] = decodeVal(v);
              }
              return out;
            }
            return null;
          };
          const decoded: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(raw.fields || {})) {
            decoded[k] = decodeVal(v as Record<string, unknown>);
          }
          harness.docs.set(key, decoded);
          harness.writeCalls.push({ collection: col, docId, data: decoded });
          return new Response(JSON.stringify(encodeFirestoreDoc(key, decoded)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (method === 'DELETE') {
          if (harness.failFirestoreDeleteWith403) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 403,
                  status: 'PERMISSION_DENIED',
                  message: 'Missing or insufficient permissions.',
                },
              }),
              { status: 403, headers: { 'Content-Type': 'application/json' } }
            );
          }
          harness.deleteCalls.push({ collection: col, docId });
          if (!harness.docs.has(key)) {
            return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          harness.docs.delete(key);
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    return new Response(JSON.stringify({ error: `Unhandled mock URL ${method} ${url}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    harness,
    restore: () => {
      clearClientFirebaseSession();
      globalThis.fetch = originalFetch;
    },
  };
}

test('clientless owner login writes rules-compliant users & admin_bindings/primary, survives transient lookup errors, and enforces customer RBAC', async () => {
  const { harness, restore } = setupMockFirebaseFetch();
  try {
    // 1. Signed-out visitor receives 401
    const unauth = await handleClientlessApiRequest('/api/admin/session', 'GET');
    assert.equal(unauth.ok, false);
    if (!unauth.ok) assert.equal(unauth.status, 401);

    // 2. Owner signs in
    const login = await handleClientlessApiRequest<{
      user: { email: string; isOwner: boolean };
      ownerBinding: { boundAt: number; boundVia: string };
    }>('/api/admin/login', 'POST', {
      email: AUTHORIZED_OWNER_EMAIL,
      password: 'owner-test-password',
    });
    assert.equal(login.ok, true);
    if (login.ok) {
      assert.equal(login.data.user.isOwner, true);
      assert.equal(login.data.user.email, AUTHORIZED_OWNER_EMAIL);
    }

    // Verify rules-compliant Firestore writes
    const userDoc = harness.docs.get('users/uid-owner-1');
    assert.ok(userDoc, 'Expected users/{uid} document to be written');
    assert.equal(typeof userDoc.email_verified, 'boolean');
    assert.equal(userDoc.email_verified, true);
    assert.equal('password_hash' in userDoc, false);

    const bindingDoc = harness.docs.get('admin_bindings/primary');
    assert.ok(bindingDoc, 'Expected admin_bindings/primary document to be written');
    assert.equal(bindingDoc.owner_user_id, 'uid-owner-1');
    assert.equal(bindingDoc.bound_email, AUTHORIZED_OWNER_EMAIL);
    assert.equal(harness.docs.has('settings/admin_binding'), false);

    // 3. Transient 503 on accounts:lookup must NOT wipe active owner session
    invalidateClientSessionVerificationCache();
    harness.failNextLookupTransient = true;
    const adminCheck = await handleClientlessApiRequest<{ authenticated: boolean; isOwner: boolean }>(
      '/api/admin/session',
      'GET'
    );
    assert.equal(adminCheck.ok, true);
    if (adminCheck.ok) {
      assert.equal(adminCheck.data.authenticated, true);
      assert.equal(adminCheck.data.isOwner, true);
    }

    // 4. Logout clears session
    const logoutRes = await handleClientlessApiRequest('/api/auth/logout', 'POST', {});
    assert.equal(logoutRes.ok, true);

    // 5. Regular customer login is denied access to admin dashboard & mutations (403)
    const custLogin = await handleClientlessApiRequest('/api/auth/login', 'POST', {
      email: 'customer@example.com',
      password: 'customer-password',
    });
    assert.equal(custLogin.ok, true);

    const custAdminSession = await handleClientlessApiRequest('/api/admin/session', 'GET');
    assert.equal(custAdminSession.ok, false);
    if (!custAdminSession.ok) assert.equal(custAdminSession.status, 403);

    const custEdit = await handleClientlessApiRequest('/api/admin/products/sc-101', 'PATCH', {
      title: 'Hijacked',
    });
    assert.equal(custEdit.ok, false);
    if (!custEdit.ok) assert.equal(custEdit.status, 403);

    const custDelete = await handleClientlessApiRequest('/api/admin/products/sc-101', 'DELETE');
    assert.equal(custDelete.ok, false);
    if (!custDelete.ok) assert.equal(custDelete.status, 403);
  } finally {
    restore();
  }
});

test('clientless product create, edit (validation, optimistic lock, slug preservation), Firestore error propagation, delete, and order-archive protection', async () => {
  const { harness, restore } = setupMockFirebaseFetch();
  try {
    const login = await handleClientlessApiRequest('/api/admin/login', 'POST', {
      email: AUTHORIZED_OWNER_EMAIL,
      password: 'owner-test-password',
    });
    assert.equal(login.ok, true);

    // 1. Create a disposable test product
    const createRes = await handleClientlessApiRequest<{
      product: {
        id: string;
        slug: string;
        name: string;
        pricePaise: number;
        version: number;
      };
    }>('/api/admin/products', 'POST', {
      title: 'Disposable Atelier Kurti',
      category: 'Kurtis',
      sku: 'SC-TEST-DISP-1',
      description: 'Disposable test cotton kurti for edit and delete verification.',
      fabricNote: 'Pure breathable cotton',
      pricePaise: 99900,
      compareAtPaise: 129900,
      lowStockThreshold: 3,
      featured: false,
      status: 'published',
      variants: [
        {
          sku: 'SC-TEST-DISP-1-M',
          size: 'M',
          colorName: 'Rose',
          colorHex: '#B76E79',
          pricePaise: 99900,
          compareAtPaise: 129900,
          stockQty: 5,
        },
      ],
      images: [
        {
          url: '/assets/products/test-kurti.jpg',
          alt: 'Disposable Atelier Kurti',
          isCover: true,
        },
      ],
    });
    assert.equal(createRes.ok, true);
    assert.ok(createRes.ok);
    const created = createRes.data.product;
    assert.equal(created.slug, 'disposable-atelier-kurti');
    assert.equal(created.pricePaise, 99900);
    assert.equal(created.version, 1);

    // 2. Validation error returns fieldErrors and does not mutate Firestore
    const invalidEdit = await handleClientlessApiRequest(
      `/api/admin/products/${encodeURIComponent(created.id)}`,
      'PATCH',
      {
        expectedVersion: created.version,
        title: 'X',
        category: 'Kurtis',
        sku: 'SC-TEST-DISP-1',
        description: 'Valid description for testing validation error response.',
        pricePaise: 119900,
        variants: [
          {
            sku: 'SC-TEST-DISP-1-M',
            size: 'M',
            colorName: 'Rose',
            colorHex: '#B76E79',
            pricePaise: 119900,
            stockQty: 4,
          },
        ],
        images: [{ url: '/assets/products/test-kurti.jpg', alt: 'Test', isCover: true }],
      }
    );
    assert.equal(invalidEdit.ok, false);
    if (!invalidEdit.ok) {
      assert.equal(invalidEdit.status, 400);
      assert.ok(invalidEdit.fieldErrors?.title);
    }

    // 3. Stale expectedVersion triggers 409 VERSION_CONFLICT
    const conflictEdit = await handleClientlessApiRequest(
      `/api/admin/products/${encodeURIComponent(created.id)}`,
      'PATCH',
      {
        expectedVersion: 99,
        title: 'Conflict Check',
        category: 'Kurtis',
        sku: 'SC-TEST-DISP-1',
        description: 'Description long enough for validation check.',
        pricePaise: 119900,
        variants: [
          {
            sku: 'SC-TEST-DISP-1-M',
            size: 'M',
            colorName: 'Rose',
            colorHex: '#B76E79',
            pricePaise: 119900,
            stockQty: 4,
          },
        ],
        images: [{ url: '/assets/products/test-kurti.jpg', alt: 'Test', isCover: true }],
      }
    );
    assert.equal(conflictEdit.ok, false);
    if (!conflictEdit.ok) {
      assert.equal(conflictEdit.status, 409);
      assert.equal(conflictEdit.code, 'VERSION_CONFLICT');
    }

    // 4. Firestore write failure must propagate real error & NOT fake local save
    harness.failFirestoreWriteWith403 = true;
    const failedWriteEdit = await handleClientlessApiRequest(
      `/api/admin/products/${encodeURIComponent(created.id)}`,
      'PATCH',
      {
        expectedVersion: created.version,
        title: 'Should Fail On 403',
        category: 'Kurtis',
        sku: 'SC-TEST-DISP-1',
        description: 'Testing that Firestore write errors are never masked.',
        pricePaise: 129900,
        variants: [
          {
            sku: 'SC-TEST-DISP-1-M',
            size: 'M',
            colorName: 'Rose',
            colorHex: '#B76E79',
            pricePaise: 129900,
            stockQty: 4,
          },
        ],
        images: [{ url: '/assets/products/test-kurti.jpg', alt: 'Test', isCover: true }],
      }
    );
    assert.equal(failedWriteEdit.ok, false);
    if (!failedWriteEdit.ok) assert.equal(failedWriteEdit.status, 403);
    harness.failFirestoreWriteWith403 = false;

    // 5. Valid Edit succeeds, preserves slug, bumps version, and reflects in public storefront
    const editRes = await handleClientlessApiRequest<{
      product: {
        id: string;
        slug: string;
        name: string;
        pricePaise: number;
        stockQty: number;
        version: number;
      };
    }>(`/api/admin/products/${encodeURIComponent(created.id)}`, 'PATCH', {
      expectedVersion: created.version,
      title: 'Updated Atelier Kurti',
      category: 'Kurtis',
      sku: 'SC-TEST-DISP-1',
      description: 'Updated description for our handcrafted cotton atelier kurti.',
      fabricNote: 'Soft woven cotton',
      pricePaise: 114900,
      compareAtPaise: 149900,
      lowStockThreshold: 2,
      featured: true,
      status: 'published',
      variants: [
        {
          sku: 'SC-TEST-DISP-1-M',
          size: 'M',
          colorName: 'Rose',
          colorHex: '#B76E79',
          pricePaise: 114900,
          compareAtPaise: 149900,
          stockQty: 9,
        },
      ],
      images: [{ url: '/assets/products/test-kurti.jpg', alt: 'Updated Kurti', isCover: true }],
    });
    assert.equal(editRes.ok, true);
    assert.ok(editRes.ok);
    assert.equal(editRes.data.product.name, 'Updated Atelier Kurti');
    assert.equal(editRes.data.product.slug, 'disposable-atelier-kurti');
    assert.equal(editRes.data.product.pricePaise, 114900);
    assert.equal(editRes.data.product.stockQty, 9);
    assert.equal(editRes.data.product.version, 2);

    // Public storefront lookup by original slug reflects update
    clearClientFirebaseSession();
    const publicBySlug = await handleClientlessApiRequest<{
      product: { id: string; name: string; pricePaise: number };
    }>('/api/products/disposable-atelier-kurti', 'GET');
    assert.equal(publicBySlug.ok, true);
    if (publicBySlug.ok) {
      assert.equal(publicBySlug.data.product.id, created.id);
      assert.equal(publicBySlug.data.product.name, 'Updated Atelier Kurti');
      assert.equal(publicBySlug.data.product.pricePaise, 114900);
    }

    // Re-authenticate owner for delete tests
    await handleClientlessApiRequest('/api/admin/login', 'POST', {
      email: AUTHORIZED_OWNER_EMAIL,
      password: 'owner-test-password',
    });

    // 6. Firestore delete failure must propagate real error & NOT hide product locally
    harness.failFirestoreDeleteWith403 = true;
    const failedDelete = await handleClientlessApiRequest(
      `/api/admin/products/${encodeURIComponent(created.id)}`,
      'DELETE'
    );
    assert.equal(failedDelete.ok, false);
    if (!failedDelete.ok) assert.equal(failedDelete.status, 403);
    assert.ok(harness.docs.has(`products/${created.id}`), 'Product must remain after failed delete');
    harness.failFirestoreDeleteWith403 = false;

    // 7. Hard delete unreferenced product removes from Firestore, admin list, public storefront, and cart validation
    const delRes = await handleClientlessApiRequest<{
      deleted: boolean;
      deletedId: string;
      archivedInsteadOfDeleted: boolean;
    }>(`/api/admin/products/${encodeURIComponent(created.id)}`, 'DELETE');
    assert.equal(delRes.ok, true);
    if (delRes.ok) {
      assert.equal(delRes.data.deleted, true);
      assert.equal(delRes.data.deletedId, created.id);
      assert.equal(delRes.data.archivedInsteadOfDeleted, false);
    }
    assert.equal(harness.docs.has(`products/${created.id}`), false);

    clearClientFirebaseSession();
    const publicAfterDel = await handleClientlessApiRequest(
      '/api/products/disposable-atelier-kurti',
      'GET'
    );
    assert.equal(publicAfterDel.ok, false);
    if (!publicAfterDel.ok) assert.equal(publicAfterDel.status, 404);

    const cartVal = await handleClientlessApiRequest<{ hasUnavailable: boolean }>(
      '/api/cart/validate',
      'POST',
      { items: [{ productId: created.id, quantity: 1 }] }
    );
    assert.equal(cartVal.ok, true);
    if (cartVal.ok) assert.equal(cartVal.data.hasUnavailable, true);

    // 8. Deleting a product referenced by an existing order archives instead of hard deleting
    await handleClientlessApiRequest('/api/admin/login', 'POST', {
      email: AUTHORIZED_OWNER_EMAIL,
      password: 'owner-test-password',
    });
    const orderProductRes = await handleClientlessApiRequest<{ product: { id: string; slug: string } }>(
      '/api/admin/products',
      'POST',
      {
        title: 'Ordered Heritage Saree',
        category: 'Sarees',
        sku: 'SC-TEST-ORD-1',
        description: 'Heritage saree referenced by a historical customer order.',
        pricePaise: 179900,
        variants: [
          {
            sku: 'SC-TEST-ORD-1-FS',
            size: 'Free Size',
            colorName: 'Crimson',
            colorHex: '#8A2B3B',
            pricePaise: 179900,
            stockQty: 3,
          },
        ],
        images: [{ url: '/assets/products/test-saree.jpg', alt: 'Saree', isCover: true }],
      }
    );
    assert.equal(orderProductRes.ok, true);
    assert.ok(orderProductRes.ok);
    const orderedProd = orderProductRes.data.product;
    harness.docs.set('orders/ord_hist_1', {
      id: 'ord_hist_1',
      order_number: 'SC-HIST-1',
      status: 'delivered',
      subtotal_paise: 179900,
      total_paise: 179900,
      product_ids: [orderedProd.id],
      items: [{ id: 'item_1', product_id: orderedProd.id, quantity: 1 }],
    });

    const archiveOnDel = await handleClientlessApiRequest<{
      archivedInsteadOfDeleted: boolean;
      product: { status: string; orderCount: number };
    }>(`/api/admin/products/${encodeURIComponent(orderedProd.id)}`, 'DELETE');
    assert.equal(archiveOnDel.ok, true);
    if (archiveOnDel.ok) {
      assert.equal(archiveOnDel.data.archivedInsteadOfDeleted, true);
      assert.equal(archiveOnDel.data.product.status, 'archived');
      assert.equal(archiveOnDel.data.product.orderCount, 1);
    }

    clearClientFirebaseSession();
    const publicOrderedAfterArchive = await handleClientlessApiRequest(
      `/api/products/${encodeURIComponent(orderedProd.slug)}`,
      'GET'
    );
    assert.equal(publicOrderedAfterArchive.ok, false);
    if (!publicOrderedAfterArchive.ok) assert.equal(publicOrderedAfterArchive.status, 404);
  } finally {
    restore();
  }
});
