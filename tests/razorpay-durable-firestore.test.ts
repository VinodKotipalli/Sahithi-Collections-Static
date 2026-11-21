import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createCreateOrderHandler } from '../api/create-order.ts';
import { createOrderStatusHandler } from '../api/order-status.ts';
import { createOrdersHandler } from '../api/orders.ts';
import { createRazorpayWebhookHandler } from '../api/razorpay-webhook.ts';
import { createVerifyPaymentHandler } from '../api/verify-payment.ts';
import {
  clearRazorpayCheckoutCachesForTest,
  type RazorpayClientFactory,
} from '../server/razorpay-checkout.ts';

interface FirebaseConfigFile {
  projectId: string;
  firestoreDatabaseId: string;
}

function readAppletFirebaseConfig(): FirebaseConfigFile {
  const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as FirebaseConfigFile;
}

function generateTestServiceAccount(projectId: string) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'test-key-id-1',
    private_key: privateKey,
    client_email: `firebase-adminsdk-test@${projectId}.iam.gserviceaccount.com`,
    client_id: '100000000000000000001',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

test('Checkout persistence guards: missing/malformed credentials, OAuth failure, 403 IAM denial, durable write, webhook idempotency & post-capture recovery', async () => {
  clearRazorpayCheckoutCachesForTest();
  const cfg = readAppletFirebaseConfig();
  assert.equal(cfg.projectId, 'celtic-pattern-fmln4');
  assert.ok(cfg.firestoreDatabaseId);

  const prevEnv = {
    VERCEL: process.env.VERCEL,
    K_SERVICE: process.env.K_SERVICE,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
    SAHITHI_FIRESTORE_NAMESPACE: process.env.SAHITHI_FIRESTORE_NAMESPACE,
    SAHITHI_TARGET_ENV: process.env.SAHITHI_TARGET_ENV,
  };

  process.env.VERCEL = '1';
  delete process.env.K_SERVICE;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_DurableCheck1';
  process.env.RAZORPAY_KEY_SECRET = 'SecretDurableTest999';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'WebhookSecretDurable1';
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.SAHITHI_FIRESTORE_NAMESPACE;
  delete process.env.SAHITHI_TARGET_ENV;

  let razorpayCreateCount = 0;
  let capturedOrderCount = 0;
  const mockFactory: RazorpayClientFactory = () => ({
    orders: {
      async create(params) {
        razorpayCreateCount += 1;
        const oid = `order_durable_${razorpayCreateCount}`;
        return {
          id: oid,
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
          amount: 169000,
          currency: 'INR',
          status: 'paid',
          notes: { customer_user_id: 'uid_priya_1' },
        };
      },
    },
    payments: {
      async fetch(paymentId) {
        capturedOrderCount += 1;
        return {
          id: paymentId,
          order_id: `order_durable_${razorpayCreateCount}`,
          amount: 169000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        };
      },
      async capture(paymentId, amount, currency) {
        return {
          id: paymentId,
          order_id: `order_durable_${razorpayCreateCount}`,
          amount,
          currency,
          status: 'captured',
          captured: true,
        };
      },
    },
  });

  const firestoreDocs = new Map<string, Record<string, unknown>>();
  const firestoreRequests: Array<{ url: string; method: string; auth: string | null }> = [];
  let oauthShouldFail = false;
  let forcePendingPatch403 = false;
  let forceCommitOrder403 = false;
  let commitWriteCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (urlStr === 'https://oauth2.googleapis.com/token') {
      if (oauthShouldFail) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ access_token: 'mock_srv_oauth_token_123', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.startsWith('https://firestore.googleapis.com/')) {
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization');
      const method = (init?.method || 'GET').toUpperCase();
      firestoreRequests.push({ url: urlStr, method, auth });

      if (urlStr.includes(':runQuery')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (urlStr.includes(':commit')) {
        if (forceCommitOrder403) {
          return new Response(
            JSON.stringify({ error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }
        commitWriteCount += 1;
        const parsedBody = JSON.parse(String(init?.body || '{}')) as {
          writes?: Array<{
            currentDocument?: { exists?: boolean };
            update?: { name: string; fields?: Record<string, unknown> };
          }>;
        };
        for (const w of parsedBody.writes || []) {
          const docName = w.update?.name || '';
          if (w.currentDocument?.exists === false && firestoreDocs.has(docName)) {
            return new Response(
              JSON.stringify({ error: { code: 409, status: 'ALREADY_EXISTS' } }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (docName && w.update?.fields) {
            firestoreDocs.set(docName, { name: docName, fields: w.update.fields });
          }
        }
        return new Response(JSON.stringify({ writeResults: [{ updateTime: new Date().toISOString() }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const cleanDocUrl = urlStr.split('?')[0]!;
      const docName = cleanDocUrl.replace('https://firestore.googleapis.com/v1/', '');

      if (method === 'PATCH') {
        if (forcePendingPatch403 && docName.includes('/pending_checkouts/')) {
          return new Response(
            JSON.stringify({ error: { code: 403, message: 'PERMISSION_DENIED: Caller does not have permission on secret-project', status: 'PERMISSION_DENIED' } }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const parsed = JSON.parse(String(init?.body || '{}')) as { fields?: Record<string, unknown> };
        firestoreDocs.set(docName, { name: docName, fields: parsed.fields || {} });
        return new Response(JSON.stringify({ name: docName, fields: parsed.fields || {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'POST') {
        const parsedUrl = new URL(urlStr);
        const docId = parsedUrl.searchParams.get('documentId') || '';
        const fullDocName = `${docName}/${docId}`;
        if (firestoreDocs.has(fullDocName)) {
          return new Response(
            JSON.stringify({ error: { code: 409, status: 'ALREADY_EXISTS' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const parsed = JSON.parse(String(init?.body || '{}')) as { fields?: Record<string, unknown> };
        firestoreDocs.set(fullDocName, { name: fullDocName, fields: parsed.fields || {} });
        return new Response(JSON.stringify({ name: fullDocName, fields: parsed.fields || {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'GET') {
        if (docName.endsWith('/site_documents/settings')) {
          return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
        }
        const existing = firestoreDocs.get(docName);
        if (!existing) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), { status: 404 });
        }
        return new Response(JSON.stringify(existing), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return originalFetch(input, init);
  }) as typeof fetch;

  const verifyIdToken = async (token: string) =>
    token === 'customer-id-token-priya' ? { uid: 'uid_priya_1', email: 'priya@example.com' } : null;

  const createHandler = createCreateOrderHandler({
    razorpayClientFactory: mockFactory,
    verifyIdToken,
    requireDurablePersistence: true,
  });
  const verifyHandler = createVerifyPaymentHandler({
    razorpayClientFactory: mockFactory,
    verifyIdToken,
    strictPersistence: true,
  });
  const webhookHandler = createRazorpayWebhookHandler({
    razorpayClientFactory: mockFactory,
  });
  const statusHandler = createOrderStatusHandler({
    razorpayClientFactory: mockFactory,
    verifyIdToken,
  });
  const ordersHandler = createOrdersHandler({
    verifyIdToken,
    requireDurablePersistence: true,
  });

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/create-order')) return void createHandler(req, res);
    if (req.url?.startsWith('/api/verify-payment')) return void verifyHandler(req, res);
    if (req.url?.startsWith('/api/razorpay-webhook')) return void webhookHandler(req, res);
    if (req.url?.startsWith('/api/order-status')) return void statusHandler(req, res);
    if (req.url?.startsWith('/api/orders')) return void ordersHandler(req, res);
    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  const loggedErrors: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((a) => String(a)).join(' '));
  };

  try {
    const samplePayload = {
      items: [{ productId: 'sc-101', variantId: 'sc-101-var-1', quantity: 1 }],
      customer: {
        customerName: 'Priya Menon',
        customerEmail: 'priya@example.com',
        customerPhone: '+91 98765 00001',
        shippingAddress: '42 Lavelle Road, Bengaluru 560001',
      },
    };

    // 1. Missing FIREBASE_SERVICE_ACCOUNT_JSON on Vercel (signed-in customer & guest):
    //    Must fail with 503 CHECKOUT_PERSISTENCE_FAILED BEFORE razorpay.orders.create, and NEVER send customer token to Firestore
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const missingSignedIn = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
        'x-vercel-id': 'req_missing_sa_1',
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(missingSignedIn.status, 503);
    const missingSignedInBody = (await missingSignedIn.json()) as Record<string, unknown>;
    assert.equal(missingSignedInBody.code, 'CHECKOUT_PERSISTENCE_FAILED');
    assert.equal(missingSignedInBody.order_id, undefined);
    assert.equal(missingSignedInBody.checkout_token, undefined);
    assert.equal(razorpayCreateCount, 0, 'Razorpay order must NOT be created without valid server DB creds');
    assert.equal(
      firestoreRequests.some((r) => r.url.includes('/pending_checkouts/')),
      false,
      'Must NOT write pending_checkouts with customer token'
    );

    const missingGuest = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(missingGuest.status, 503);
    assert.equal(razorpayCreateCount, 0);

    // 2. Malformed service account & project mismatch fail BEFORE razorpay.orders.create
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{not-valid-json';
    const malformedRes = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(malformedRes.status, 503);
    assert.equal(razorpayCreateCount, 0);

    const wrongProjectCreds = generateTestServiceAccount('wrong-firebase-project');
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(wrongProjectCreds);
    const mismatchRes = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(mismatchRes.status, 503);
    assert.equal(razorpayCreateCount, 0);

    // 3. Valid Base64 credentials + Google OAuth exchange failure -> fails BEFORE razorpay.orders.create
    const validCreds = generateTestServiceAccount(cfg.projectId);
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = Buffer.from(JSON.stringify(validCreds), 'utf8').toString('base64');
    oauthShouldFail = true;
    const oauthFailRes = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(oauthFailRes.status, 503);
    assert.equal(razorpayCreateCount, 0);
    oauthShouldFail = false;

    // 4. Firestore IAM 403 PERMISSION_DENIED on pending_checkouts PATCH:
    //    Logs structured metadata with project/db/env/path/req, returns 503 without raw Google JSON or customer PII
    clearRazorpayCheckoutCachesForTest();
    forcePendingPatch403 = true;
    loggedErrors.length = 0;
    const iam403Res = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
        'x-vercel-id': 'req_iam_403_test',
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(iam403Res.status, 503);
    const iam403Body = (await iam403Res.json()) as { code?: string; error?: string; order_id?: string; checkout_token?: string };
    assert.equal(iam403Body.code, 'CHECKOUT_PERSISTENCE_FAILED');
    assert.equal(iam403Body.order_id, undefined);
    assert.equal(iam403Body.checkout_token, undefined);
    assert.equal((iam403Body.error || '').includes('PERMISSION_DENIED'), false);
    assert.equal((iam403Body.error || '').includes('secret-project'), false);
    assert.equal((iam403Body.error || '').includes('Priya'), false);
    assert.ok(
      loggedErrors.some(
        (line) =>
          line.includes('op=save_pending_checkout') &&
          line.includes('status=403') &&
          line.includes(`project=${cfg.projectId}`) &&
          line.includes(`db=${cfg.firestoreDatabaseId}`) &&
          line.includes('env=production') &&
          line.includes('req=req_iam_403_test')
      ),
      `Expected structured persistence error log, got: ${loggedErrors.join(' | ')}`
    );
    forcePendingPatch403 = false;

    // 5. Full Razorpay create-order -> post-capture 403 returning 202 ORDER_CONFIRMATION_PENDING -> order-status recovery -> webhook idempotency
    clearRazorpayCheckoutCachesForTest();
    firestoreRequests.length = 0;
    const createOkRes = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(createOkRes.status, 200);
    const createOkBody = (await createOkRes.json()) as {
      order_id: string;
      checkout_token: string;
      amount: number;
      key_id: string;
    };
    assert.ok(createOkBody.order_id);
    assert.ok(createOkBody.checkout_token);

    const expectedPendingPath = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/environments/production/pending_checkouts/${createOkBody.order_id}`;
    assert.ok(firestoreDocs.has(expectedPendingPath), 'pending_checkouts doc must be written under environments/production');
    const pendingWriteReq = firestoreRequests.find(
      (r) => r.method === 'PATCH' && r.url.includes(`/pending_checkouts/${createOkBody.order_id}`)
    );
    assert.ok(pendingWriteReq);
    assert.equal(pendingWriteReq.auth, 'Bearer mock_srv_oauth_token_123');
    assert.equal(pendingWriteReq.url.includes('?key='), false, 'OAuth writes must not pass browser API key');

    // Simulate captured payment hitting transient Firestore 403 on :commit -> returns 202 ORDER_CONFIRMATION_PENDING
    const payId = 'pay_durable_1';
    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${createOkBody.order_id}|${payId}`)
      .digest('hex');

    forceCommitOrder403 = true;
    const verify202Res = await originalFetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify({
        razorpay_order_id: createOkBody.order_id,
        razorpay_payment_id: payId,
        razorpay_signature: sig,
        checkout_token: createOkBody.checkout_token,
      }),
    });
    assert.equal(verify202Res.status, 202);
    const verify202Body = (await verify202Res.json()) as {
      pending_confirmation?: boolean;
      code?: string;
      error?: string;
    };
    assert.equal(verify202Body.pending_confirmation, true);
    assert.equal(verify202Body.code, 'ORDER_CONFIRMATION_PENDING');
    assert.equal((verify202Body.error || '').includes('PERMISSION_DENIED'), false);
    assert.equal(commitWriteCount, 0);

    // Recover via /api/order-status once Firestore permissions succeed (even across fresh memory cache)
    forceCommitOrder403 = false;
    clearRazorpayCheckoutCachesForTest();
    const recoverRes = await originalFetch(`${baseUrl}/api/order-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify({ razorpay_order_id: createOkBody.order_id, razorpay_payment_id: payId }),
    });
    assert.equal(recoverRes.status, 200);
    const recoverBody = (await recoverRes.json()) as {
      confirmed?: boolean;
      order?: { id?: string; orderNumber?: string; customerUserId?: string };
    };
    assert.equal(recoverBody.confirmed, true);
    assert.equal(recoverBody.order?.customerUserId, 'uid_priya_1');
    assert.equal(commitWriteCount, 1);

    const expectedOrderPath = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/environments/production/orders/${recoverBody.order?.id}`;
    assert.ok(firestoreDocs.has(expectedOrderPath));

    // Replay Razorpay webhook on cold cache -> returns existing order idempotently without duplicate write
    clearRazorpayCheckoutCachesForTest();
    const webhookBodyStr = JSON.stringify({
      event: 'order.paid',
      payload: {
        payment: { entity: { id: payId, order_id: createOkBody.order_id } },
        order: { entity: { id: createOkBody.order_id } },
      },
    });
    const webhookSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(webhookBodyStr)
      .digest('hex');

    const webhookRes = await originalFetch(`${baseUrl}/api/razorpay-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': webhookSig,
      },
      body: webhookBodyStr,
    });
    assert.equal(webhookRes.status, 200);
    const webhookJson = (await webhookRes.json()) as { already_processed?: boolean; order?: { id?: string } };
    assert.equal(webhookJson.already_processed, true);
    assert.equal(webhookJson.order?.id, recoverBody.order?.id);
    assert.equal(commitWriteCount, 1, 'Webhook replay must not re-commit stock/order writes');
    assert.ok(capturedOrderCount >= 1);

    // 6. COD POST /api/orders uses the same service-account credential and production namespace
    const codRes = await originalFetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify({
        ...samplePayload,
        paymentMethod: 'cod',
        idempotencyKey: 'cod_durable_prod_1',
      }),
    });
    assert.equal(codRes.status, 201);
    const codBody = (await codRes.json()) as {
      order?: { id?: string; paymentMethod?: string; customerUserId?: string };
    };
    assert.equal(codBody.order?.paymentMethod, 'cod');
    assert.equal(codBody.order?.customerUserId, 'uid_priya_1');
    assert.equal(commitWriteCount, 2);
    const codOrderPath = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/environments/production/orders/${codBody.order?.id}`;
    assert.ok(firestoreDocs.has(codOrderPath));
  } finally {
    console.error = origConsoleError;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearRazorpayCheckoutCachesForTest();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Vercel Starter-Tier mode (default): checkout, verify-payment, order-status & COD succeed automatically without service-account IAM', async () => {
  clearRazorpayCheckoutCachesForTest();
  const cfg = readAppletFirebaseConfig();

  const prevEnv = {
    VERCEL: process.env.VERCEL,
    K_SERVICE: process.env.K_SERVICE,
    FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    SAHITHI_FIRESTORE_NAMESPACE: process.env.SAHITHI_FIRESTORE_NAMESPACE,
    SAHITHI_TARGET_ENV: process.env.SAHITHI_TARGET_ENV,
  };

  process.env.VERCEL = '1';
  delete process.env.K_SERVICE;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.SAHITHI_FIRESTORE_NAMESPACE;
  delete process.env.SAHITHI_TARGET_ENV;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_StarterTier1';
  process.env.RAZORPAY_KEY_SECRET = 'SecretStarterTier999';

  let rzpSeq = 0;
  const mockFactory: RazorpayClientFactory = () => ({
    orders: {
      async create(params) {
        rzpSeq += 1;
        return {
          id: `order_starter_${rzpSeq}`,
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
          amount: 169000,
          currency: 'INR',
          status: 'paid',
          notes: { customer_user_id: 'uid_priya_1' },
        };
      },
    },
    payments: {
      async fetch(paymentId) {
        return {
          id: paymentId,
          order_id: `order_starter_${rzpSeq}`,
          amount: 169000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        };
      },
      async capture(paymentId, amount, currency) {
        return {
          id: paymentId,
          order_id: `order_starter_${rzpSeq}`,
          amount,
          currency,
          status: 'captured',
          captured: true,
        };
      },
    },
  });

  const firestoreDocs = new Map<string, { name: string; fields: Record<string, unknown> }>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith('https://firestore.googleapis.com/')) {
      const method = (init?.method || 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization');
      if (urlStr.includes(':runQuery')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes(':commit')) {
        return new Response(
          JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const cleanDocUrl = urlStr.split('?')[0]!;
      const docName = cleanDocUrl.replace('https://firestore.googleapis.com/v1/', '');
      if (method === 'POST') {
        const parsedUrl = new URL(urlStr);
        const docId = parsedUrl.searchParams.get('documentId') || '';
        const fullDocName = `${docName}/${docId}`;
        if (firestoreDocs.has(fullDocName)) {
          return new Response(
            JSON.stringify({ error: { code: 409, status: 'ALREADY_EXISTS' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const parsed = JSON.parse(String(init?.body || '{}')) as { fields?: Record<string, unknown> };
        const fields = parsed.fields || {};
        // Assert strict compliance with firestore.rules isValidPublicOrder for orders collection creates
        if (docName.endsWith('/orders')) {
          assert.ok(fields.status && typeof fields.status === 'object');
          const statusVal = (fields.status as { stringValue?: string }).stringValue;
          assert.ok(statusVal === 'placed' || statusVal === 'pending');
          const payStatusVal = (fields.payment_status as { stringValue?: string } | undefined)?.stringValue;
          assert.ok(payStatusVal === 'unpaid' || payStatusVal === 'pending');
          const uidField = fields.customer_user_id as { stringValue?: string; nullValue?: null };
          if (uidField?.stringValue) {
            assert.equal(auth, 'Bearer customer-id-token-priya');
          }
        }
        firestoreDocs.set(fullDocName, { name: fullDocName, fields });
        return new Response(JSON.stringify({ name: fullDocName, fields }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'GET') {
        if (docName.endsWith('/site_documents/settings')) {
          return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
        }
        const existing = firestoreDocs.get(docName);
        if (!existing) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), { status: 404 });
        }
        return new Response(JSON.stringify(existing), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const verifyIdToken = async (token: string) =>
    token === 'customer-id-token-priya' ? { uid: 'uid_priya_1', email: 'priya@example.com' } : null;

  const createHandler = createCreateOrderHandler({ razorpayClientFactory: mockFactory, verifyIdToken });
  const verifyHandler = createVerifyPaymentHandler({ razorpayClientFactory: mockFactory, verifyIdToken });
  const statusHandler = createOrderStatusHandler({ razorpayClientFactory: mockFactory, verifyIdToken });
  const ordersHandler = createOrdersHandler({ verifyIdToken });

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/create-order')) return void createHandler(req, res);
    if (req.url?.startsWith('/api/verify-payment')) return void verifyHandler(req, res);
    if (req.url?.startsWith('/api/order-status')) return void statusHandler(req, res);
    if (req.url?.startsWith('/api/orders')) return void ordersHandler(req, res);
    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const samplePayload = {
      items: [{ productId: 'sc-101', variantId: 'sc-101-var-1', quantity: 1 }],
      customer: {
        customerName: 'Priya Menon',
        customerEmail: 'priya@example.com',
        customerPhone: '+91 98765 00001',
        shippingAddress: '42 Lavelle Road, Bengaluru 560001',
      },
    };

    // 1. Create Razorpay order with ZERO service-account config on Vercel -> 200 OK token_backed
    const createRes = await originalFetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify(samplePayload),
    });
    assert.equal(createRes.status, 200);
    const createBody = (await createRes.json()) as {
      order_id: string;
      checkout_token: string;
      persistence_mode: string;
      key_id: string;
    };
    assert.equal(createBody.persistence_mode, 'token_backed');
    assert.ok(createBody.order_id);
    assert.ok(createBody.checkout_token);

    // 2. Simulate cold lambda + verify payment -> persists via isValidPublicOrder rule (200 OK)
    clearRazorpayCheckoutCachesForTest();
    const payId = 'pay_starter_1';
    const sig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${createBody.order_id}|${payId}`)
      .digest('hex');

    const verifyRes = await originalFetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify({
        razorpay_order_id: createBody.order_id,
        razorpay_payment_id: payId,
        razorpay_signature: sig,
        checkout_token: createBody.checkout_token,
        orderData: { ...samplePayload.customer, items: samplePayload.items },
      }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = (await verifyRes.json()) as {
      success?: boolean;
      persistence_mode?: string;
      order?: { id?: string; orderNumber?: string; paymentStatus?: string; status?: string };
    };
    assert.equal(verifyBody.success, true);
    assert.equal(verifyBody.persistence_mode, 'public_order_rule');
    assert.equal(verifyBody.order?.paymentStatus, 'paid');
    assert.equal(verifyBody.order?.status, 'confirmed');
    assert.ok(verifyBody.order?.orderNumber);

    const expectedOrderDoc = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/environments/production/orders/${verifyBody.order?.id}`;
    assert.ok(firestoreDocs.has(expectedOrderDoc));

    // 3. /api/order-status on cold cache checks live Razorpay API for the public-rule doc & returns confirmed paid order
    clearRazorpayCheckoutCachesForTest();
    const statusRes = await originalFetch(`${baseUrl}/api/order-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify({ razorpay_order_id: createBody.order_id }),
    });
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as {
      confirmed?: boolean;
      order?: { paymentStatus?: string; status?: string };
    };
    assert.equal(statusBody.confirmed, true);
    assert.equal(statusBody.order?.paymentStatus, 'paid');
    assert.equal(statusBody.order?.status, 'confirmed');

    // 4. COD /api/orders with ZERO service-account config on Vercel -> 201 Created + idempotent 200 retry
    const codRes1 = await originalFetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify({
        ...samplePayload,
        paymentMethod: 'cod',
        idempotencyKey: 'cod_starter_tier_1',
      }),
    });
    assert.equal(codRes1.status, 201);
    const codBody1 = (await codRes1.json()) as { order?: { id?: string; orderNumber?: string }; duplicate?: boolean };
    assert.equal(codBody1.duplicate, false);
    assert.ok(codBody1.order?.orderNumber);
    const expectedCodDoc = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/environments/production/orders/${codBody1.order?.id}`;
    assert.ok(firestoreDocs.has(expectedCodDoc));

    const codRes2 = await originalFetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer customer-id-token-priya',
      },
      body: JSON.stringify({
        ...samplePayload,
        paymentMethod: 'cod',
        idempotencyKey: 'cod_starter_tier_1',
      }),
    });
    assert.equal(codRes2.status, 200);
    const codBody2 = (await codRes2.json()) as { duplicate?: boolean; order?: { id?: string } };
    assert.equal(codBody2.duplicate, true);
    assert.equal(codBody2.order?.id, codBody1.order?.id);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearRazorpayCheckoutCachesForTest();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

