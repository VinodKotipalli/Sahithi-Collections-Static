import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Razorpay from 'razorpay';
import { PRODUCTS } from '../src/config/products.ts';
import { verifyFirebaseIdToken } from './firebase-rest.ts';
import {
  StoreHttpError,
  type BoutiqueStore,
  type CouponRow,
  type GiftCardRow,
  type OrderStatusHistoryEntry,
  type PendingCheckoutRow,
  type PlaceOrderInput,
} from './store.ts';

const MIN_PRICE_PAISE = 100;
const CHECKOUT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_CACHE_MAX = 1000;
const COMPLETED_CACHE_MAX = 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SEED_SKU_BY_ID: Record<string, string> = {
  'sc-001': 'SC-DRS-001',
  'sc-002': 'SC-ETH-002',
  'sc-003': 'SC-WST-003',
  'sc-004': 'SC-DRS-004',
  'sc-005': 'SC-FST-005',
  'sc-006': 'SC-FST-006',
  'sc-007': 'SC-ETH-007',
  'sc-008': 'SC-DRS-008',
  'sc-009': 'SC-WST-009',
  'sc-010': 'SC-FST-010',
  'sc-011': 'SC-ACC-011',
  'sc-012': 'SC-ACC-012',
  'sc-101': 'SC-KRT-101',
  'sc-102': 'SC-KRT-102',
  'sc-103': 'SC-KRT-103',
  'sc-104': 'SC-KRT-104',
  'sc-105': 'SC-KST-105',
  'sc-106': 'SC-KST-106',
  'sc-107': 'SC-KST-107',
  'sc-108': 'SC-SAR-108',
  'sc-109': 'SC-SAR-109',
  'sc-110': 'SC-SAR-110',
  'sc-111': 'SC-SAR-111',
  'sc-112': 'SC-CRD-112',
  'sc-113': 'SC-CRD-113',
  'sc-114': 'SC-DUP-114',
  'sc-115': 'SC-DUP-115',
};

export interface RazorpayOrderEntity {
  id: string;
  amount: number | string;
  currency?: string;
  receipt?: string;
  status?: string;
  notes?: Record<string, string>;
}

export interface RazorpayPaymentEntity {
  id: string;
  order_id?: string | null;
  amount: number | string;
  currency?: string;
  status?: string;
  captured?: boolean;
  email?: string;
  contact?: string;
  error_code?: string;
  error_description?: string;
  error_reason?: string;
  notes?: Record<string, string>;
}

export interface RazorpayClientLike {
  orders: {
    create: (params: {
      amount: number;
      currency: string;
      receipt: string;
      notes?: Record<string, string>;
    }) => Promise<RazorpayOrderEntity>;
    fetch: (orderId: string) => Promise<RazorpayOrderEntity>;
    fetchPayments?: (orderId: string) => Promise<{ items?: RazorpayPaymentEntity[] }>;
  };
  payments: {
    fetch: (paymentId: string) => Promise<RazorpayPaymentEntity>;
    capture: (
      paymentId: string,
      amount: number,
      currency: string
    ) => Promise<RazorpayPaymentEntity>;
  };
}

export type RazorpayClientFactory = (
  keyId: string,
  keySecret: string
) => RazorpayClientLike;

export type IdTokenVerifierFn = (
  token: string
) => Promise<{ uid: string; email?: string } | null>;

export interface CartLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  expectedPricePaise?: number | null;
}

export interface ValidatedOrderLine {
  productId: string;
  variantId: string;
  productTitle: string;
  variantLabel: string;
  sku: string;
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
}

export interface OrderCustomerDetails {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
}

export interface SerializedOrderReceipt {
  id: string;
  orderNumber: string;
  customerUserId?: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  subtotalPaise: number;
  discountPaise: number;
  giftCardPaise: number;
  couponCode: string | null;
  giftCardCode: string | null;
  totalPaise: number;
  currency: string;
  createdAt: number;
  updatedAt?: number;
  paymentCollectedAt?: number | null;
  idempotencyKey?: string | null;
  paymentMethod: 'razorpay' | 'cod';
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  statusHistory: OrderStatusHistoryEntry[];
  items: Array<{
    productId: string;
    variantId: string | null;
    productTitle: string;
    variantLabel: string;
    sku: string;
    unitPricePaise: number;
    quantity: number;
    lineTotalPaise: number;
  }>;
}

interface PendingCheckoutRecord {
  razorpayOrderId: string;
  amountPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  giftCardPaise: number;
  couponCode: string | null;
  giftCardCode: string | null;
  currency: string;
  receipt: string;
  items: ValidatedOrderLine[];
  customer: OrderCustomerDetails | null;
  customerUserId: string | null;
  status: 'pending' | 'confirmed' | 'payment_received_pending_confirm' | 'failed';
  createdAt: number;
  expiresAt: number;
  confirmedOrder?: SerializedOrderReceipt;
  razorpayPaymentId?: string;
  idempotencyKey?: string | null;
  payloadHash?: string;
  failureReason?: string;
}

interface SignedCheckoutTokenPayload {
  v: 1;
  oid: string;
  amt: number;
  sub?: number;
  disc?: number;
  gc?: number;
  cpn?: string | null;
  gcc?: string | null;
  cur: string;
  uid?: string | null;
  items: Array<{
    productId: string;
    variantId: string;
    quantity: number;
    unitPricePaise: number;
  }>;
  iat: number;
  exp: number;
}

export interface CheckoutHandlerResponse {
  status: number;
  body: Record<string, unknown>;
}

const pendingCheckoutsMemory = new Map<string, PendingCheckoutRecord>();
const completedCheckoutsMemory = new Map<
  string,
  { paymentId: string; order?: SerializedOrderReceipt; responseBody: Record<string, unknown> }
>();
const inFlightVerifications = new Map<string, Promise<CheckoutHandlerResponse>>();
const idempotentOrderAttemptsMemory = new Map<
  string,
  { payloadHash: string; razorpayOrderId: string; keyId: string; expiresAt: number }
>();
const processedWebhookEventsMemory = new Map<
  string,
  { eventType: string; processedAt: number; orderId?: string; order?: SerializedOrderReceipt }
>();

let cachedGoogleAccessToken: {
  token: string;
  expiresAtMs: number;
  clientEmail: string;
} | null = null;

function defaultRazorpayFactory(keyId: string, keySecret: string): RazorpayClientLike {
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  }) as unknown as RazorpayClientLike;
}

function isTransientNetworkOrServerError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  const statusCode =
    typeof obj.statusCode === 'number'
      ? obj.statusCode
      : typeof (obj.response as Record<string, unknown> | undefined)?.status === 'number'
        ? ((obj.response as Record<string, unknown>).status as number)
        : null;
  if (statusCode !== null) {
    return statusCode >= 500 || statusCode === 429;
  }
  const code = typeof obj.code === 'string' ? obj.code.toUpperCase() : '';
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }
  const msg = obj instanceof Error ? obj.message.toLowerCase() : String(obj.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('network') || msg.includes('econnreset');
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(3, options?.maxAttempts ?? 3));
  const baseDelayMs = Math.max(10, options?.baseDelayMs ?? 60);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isTransientNetworkOrServerError(err)) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 25);
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt + jitter));
    }
  }
  throw lastErr;
}

function withSupportRef(
  status: number,
  body: Record<string, unknown>,
  requestId?: string
): CheckoutHandlerResponse {
  if (!requestId || body.support_reference) {
    return { status, body };
  }
  return {
    status,
    body: {
      ...body,
      support_reference: requestId,
    },
  };
}

function pruneMemoryCaches(now = Date.now()) {
  if (pendingCheckoutsMemory.size > PENDING_CACHE_MAX) {
    for (const [key, rec] of pendingCheckoutsMemory.entries()) {
      if (rec.expiresAt <= now) pendingCheckoutsMemory.delete(key);
    }
    while (pendingCheckoutsMemory.size > PENDING_CACHE_MAX) {
      const oldest = pendingCheckoutsMemory.keys().next().value;
      if (!oldest) break;
      pendingCheckoutsMemory.delete(oldest);
    }
  }
  if (completedCheckoutsMemory.size > COMPLETED_CACHE_MAX) {
    while (completedCheckoutsMemory.size > COMPLETED_CACHE_MAX) {
      const oldest = completedCheckoutsMemory.keys().next().value;
      if (!oldest) break;
      completedCheckoutsMemory.delete(oldest);
    }
  }
  if (idempotentOrderAttemptsMemory.size > PENDING_CACHE_MAX) {
    for (const [key, rec] of idempotentOrderAttemptsMemory.entries()) {
      if (rec.expiresAt <= now) idempotentOrderAttemptsMemory.delete(key);
    }
    while (idempotentOrderAttemptsMemory.size > PENDING_CACHE_MAX) {
      const oldest = idempotentOrderAttemptsMemory.keys().next().value;
      if (!oldest) break;
      idempotentOrderAttemptsMemory.delete(oldest);
    }
  }
  if (processedWebhookEventsMemory.size > COMPLETED_CACHE_MAX) {
    while (processedWebhookEventsMemory.size > COMPLETED_CACHE_MAX) {
      const oldest = processedWebhookEventsMemory.keys().next().value;
      if (!oldest) break;
      processedWebhookEventsMemory.delete(oldest);
    }
  }
}

function sanitizeNamespace(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'development';
}

interface FirebaseAppletConfigFile {
  projectId: string;
  apiKey?: string;
  firestoreDatabaseId: string;
}

function loadFirebaseConfig(): FirebaseAppletConfigFile | null {
  const candidate = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(candidate)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Partial<FirebaseAppletConfigFile>;
    if (parsed.projectId && parsed.firestoreDatabaseId) {
      return {
        projectId: String(parsed.projectId).trim(),
        apiKey: parsed.apiKey ? String(parsed.apiKey).trim() : undefined,
        firestoreDatabaseId: String(parsed.firestoreDatabaseId).trim(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function resolveServerFirestoreNamespace(): string {
  const explicitNs = (process.env.SAHITHI_FIRESTORE_NAMESPACE || '').trim();
  if (explicitNs) return sanitizeNamespace(explicitNs);

  const explicitTarget = (process.env.SAHITHI_TARGET_ENV || '').trim().toLowerCase();
  if (
    explicitTarget === 'development' ||
    explicitTarget === 'shared-preview' ||
    explicitTarget === 'production'
  ) {
    return explicitTarget;
  }

  // On Vercel deployments (both Preview *.vercel.app and Production custom domain),
  // the client SPA reads environments/production (firebaseClientApi.ts).
  if (process.env.VERCEL === '1') {
    return 'production';
  }

  const kService = (process.env.K_SERVICE || '').trim().toLowerCase();
  if (kService.startsWith('ais-pre-')) return 'shared-preview';
  if (kService.startsWith('ais-dev-')) return 'development';

  if ((process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    return 'production';
  }

  return 'development';
}

interface ServiceAccountCreds {
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type ServiceAccountParseResult =
  | { ok: true; creds: ServiceAccountCreds }
  | {
      ok: false;
      reasonCode: 'MISSING' | 'MALFORMED' | 'PROJECT_MISMATCH';
      detail: string;
    };

type ServerBearerResult =
  | { ok: true; token: string }
  | {
      ok: false;
      status: number;
      reasonCode: string;
      detail: string;
    };

function logCheckoutPersistenceFailure(params: {
  operation: string;
  projectId: string;
  databaseId: string;
  namespace: string;
  path?: string;
  status: number | string;
  code: string;
  requestId?: string;
  reason: string;
}) {
  const safeReason = params.reason.replace(/\s+/g, ' ').slice(0, 220);
  console.error(
    `[checkout-persistence] op=${params.operation} status=${params.status} code=${params.code} project=${params.projectId} db=${params.databaseId} env=${params.namespace} path=${params.path || '-'} req=${params.requestId || '-'} reason=${safeReason}`
  );
}

function unwrapJsonStringCandidate(raw: string): string {
  let val = raw.replace(/^\uFEFF/, '').trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1).trim();
  }
  return val;
}

function parseServiceAccountCredentialsDetailed(expectedProjectId?: string): ServiceAccountParseResult {
  let rawText = unwrapJsonStringCandidate(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '');

  if (!rawText) {
    const gacPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    if (gacPath && fs.existsSync(gacPath)) {
      try {
        rawText = unwrapJsonStringCandidate(fs.readFileSync(gacPath, 'utf8'));
      } catch {
        return {
          ok: false,
          reasonCode: 'MALFORMED',
          detail: 'Unable to read GOOGLE_APPLICATION_CREDENTIALS file.',
        };
      }
    }
  }

  if (!rawText) {
    return {
      ok: false,
      reasonCode: 'MISSING',
      detail: 'FIREBASE_SERVICE_ACCOUNT_JSON is not set on the server.',
    };
  }

  let jsonText = rawText;
  if (!jsonText.startsWith('{')) {
    try {
      const decoded = unwrapJsonStringCandidate(
        Buffer.from(jsonText.replace(/\s+/g, ''), 'base64').toString('utf8')
      );
      if (decoded.startsWith('{')) jsonText = decoded;
    } catch {
      return {
        ok: false,
        reasonCode: 'MALFORMED',
        detail: 'FIREBASE_SERVICE_ACCOUNT_JSON is neither valid JSON nor valid base64 JSON.',
      };
    }
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(jsonText);
    if (typeof parsedUnknown === 'string') {
      parsedUnknown = JSON.parse(parsedUnknown);
    }
  } catch {
    return {
      ok: false,
      reasonCode: 'MALFORMED',
      detail: 'FIREBASE_SERVICE_ACCOUNT_JSON could not be parsed as JSON.',
    };
  }

  if (!parsedUnknown || typeof parsedUnknown !== 'object') {
    return {
      ok: false,
      reasonCode: 'MALFORMED',
      detail: 'FIREBASE_SERVICE_ACCOUNT_JSON parsed value is not an object.',
    };
  }

  const parsed = parsedUnknown as Partial<ServiceAccountCreds>;
  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKey =
    typeof parsed.private_key === 'string'
      ? parsed.private_key.replace(/\\n/g, '\n').trim()
      : '';

  if (!clientEmail || !clientEmail.includes('@') || !privateKey || !privateKey.includes('PRIVATE KEY')) {
    return {
      ok: false,
      reasonCode: 'MALFORMED',
      detail: 'Service-account JSON is missing required client_email or private_key fields.',
    };
  }

  if (expectedProjectId && projectId && projectId !== expectedProjectId) {
    return {
      ok: false,
      reasonCode: 'PROJECT_MISMATCH',
      detail: `Service-account project_id (${projectId}) does not match configured Firebase project (${expectedProjectId}).`,
    };
  }

  return {
    ok: true,
    creds: {
      project_id: projectId || undefined,
      client_email: clientEmail,
      private_key: privateKey,
      token_uri:
        typeof parsed.token_uri === 'string' && parsed.token_uri.trim()
          ? parsed.token_uri.trim()
          : 'https://oauth2.googleapis.com/token',
    },
  };
}

function parseServiceAccountCredentials(): ServiceAccountCreds | null {
  const cfg = loadFirebaseConfig();
  const parsed = parseServiceAccountCredentialsDetailed(cfg?.projectId);
  return parsed.ok ? parsed.creds : null;
}

async function resolveFirestoreServerBearerToken(options?: {
  operation?: string;
  requestId?: string;
  ctx?: {
    projectId: string;
    databaseId: string;
    namespace: string;
  } | null;
}): Promise<ServerBearerResult> {
  const now = Date.now();
  const cfg = loadFirebaseConfig();
  const expectedProjectId = options?.ctx?.projectId || cfg?.projectId;
  const parsed = parseServiceAccountCredentialsDetailed(expectedProjectId);

  if (!parsed.ok) {
    // Allow Cloud Run / GCE ADC metadata token only when not on Vercel and service-account env is absent
    const isCloudRunOrGce =
      process.env.VERCEL !== '1' &&
      Boolean((process.env.K_SERVICE || process.env.GOOGLE_RUNTIME || '').trim());
    if (parsed.reasonCode === 'MISSING' && isCloudRunOrGce) {
      if (
        cachedGoogleAccessToken &&
        cachedGoogleAccessToken.clientEmail === '__metadata__' &&
        now < cachedGoogleAccessToken.expiresAtMs - 60_000
      ) {
        return { ok: true, token: cachedGoogleAccessToken.token };
      }
      try {
        const metaRes = await fetch(
          'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
          { headers: { 'Metadata-Flavor': 'Google' } }
        );
        if (metaRes.ok) {
          const metaJson = (await metaRes.json()) as {
            access_token?: string;
            expires_in?: number;
          };
          if (typeof metaJson.access_token === 'string' && metaJson.access_token) {
            cachedGoogleAccessToken = {
              token: metaJson.access_token,
              expiresAtMs: now + Number(metaJson.expires_in || 3600) * 1000,
              clientEmail: '__metadata__',
            };
            return { ok: true, token: metaJson.access_token };
          }
        }
      } catch {
        // Fall through to structured error
      }
    }
    return {
      ok: false,
      status: 503,
      reasonCode: `CREDENTIAL_${parsed.reasonCode}`,
      detail: parsed.detail,
    };
  }

  const creds = parsed.creds;
  if (
    cachedGoogleAccessToken &&
    cachedGoogleAccessToken.clientEmail === creds.client_email &&
    now < cachedGoogleAccessToken.expiresAtMs - 60_000
  ) {
    return { ok: true, token: cachedGoogleAccessToken.token };
  }

  let assertion: string;
  try {
    const iatSec = Math.floor(now / 1000);
    const expSec = iatSec + 3600;
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claimSet = Buffer.from(
      JSON.stringify({
        iss: creds.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: creds.token_uri || 'https://oauth2.googleapis.com/token',
        iat: iatSec,
        exp: expSec,
      })
    ).toString('base64url');

    const signingInput = `${header}.${claimSet}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(creds.private_key).toString('base64url');
    assertion = `${signingInput}.${signature}`;
  } catch (err) {
    return {
      ok: false,
      status: 503,
      reasonCode: 'PRIVATE_KEY_INVALID',
      detail:
        err instanceof Error
          ? `Failed to sign Google OAuth assertion: ${err.message}`
          : 'Failed to sign Google OAuth assertion.',
    };
  }

  try {
    const res = await fetch(creds.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      };
      return {
        ok: false,
        status: res.status || 401,
        reasonCode: 'OAUTH_EXCHANGE_FAILED',
        detail: `Google OAuth token exchange returned HTTP ${res.status} (${errBody.error || 'unknown_error'})`,
      };
    }
    const tokenPayload = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof tokenPayload.access_token === 'string' && tokenPayload.access_token) {
      const expiresInMs = Number(tokenPayload.expires_in || 3600) * 1000;
      cachedGoogleAccessToken = {
        token: tokenPayload.access_token,
        expiresAtMs: now + expiresInMs,
        clientEmail: creds.client_email,
      };
      return { ok: true, token: tokenPayload.access_token };
    }
    return {
      ok: false,
      status: 502,
      reasonCode: 'OAUTH_EMPTY_TOKEN',
      detail: 'Google OAuth response did not contain an access_token.',
    };
  } catch (err) {
    return {
      ok: false,
      status: 503,
      reasonCode: 'OAUTH_NETWORK_ERROR',
      detail:
        err instanceof Error
          ? `Google OAuth exchange network failure: ${err.message}`
          : 'Google OAuth exchange network failure.',
    };
  }
}

async function getFirestoreAdminBearerToken(options?: {
  operation?: string;
  requestId?: string;
}): Promise<string | null> {
  const res = await resolveFirestoreServerBearerToken(options);
  return res.ok ? res.token : null;
}

export async function verifyBearerFirebaseTokenFromHeader(
  authHeader: string | string[] | undefined,
  verifierOverride?: IdTokenVerifierFn
): Promise<
  | { ok: true; uid: string | null; rawToken: string | null; email?: string | null }
  | { ok: false; status: 401; code: string; error: string }
> {
  const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!headerStr || !headerStr.trim()) {
    return { ok: true, uid: null, rawToken: null };
  }

  const trimmed = headerStr.trim();
  if (!/^Bearer\s+/i.test(trimmed)) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_INVALID',
      error: 'Invalid Authorization header format.',
    };
  }
  const token = trimmed.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_INVALID',
      error: 'Missing Bearer token.',
    };
  }

  if (verifierOverride) {
    const verified = await verifierOverride(token).catch(() => null);
    if (!verified || !verified.uid) {
      return {
        ok: false,
        status: 401,
        code: 'AUTH_INVALID',
        error: 'Your session token has expired or is invalid. Please sign in again.',
      };
    }
    return { ok: true, uid: verified.uid, rawToken: token, email: verified.email || null };
  }

  const cfg = loadFirebaseConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_INVALID',
      error: 'Firebase configuration is unavailable to verify your sign-in token.',
    };
  }

  const claims = await verifyFirebaseIdToken(token, cfg.projectId).catch(() => null);
  if (!claims || !claims.uid) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_INVALID',
      error: 'Your sign-in session has expired or is invalid. Please sign in again.',
    };
  }

  return { ok: true, uid: claims.uid, rawToken: token, email: claims.email || null };
}

type FsFieldValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { arrayValue: { values?: FsFieldValue[] } }
  | { mapValue: { fields?: Record<string, FsFieldValue> } };

function toFsValue(val: unknown): FsFieldValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { nullValue: null };
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFsValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FsFieldValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function toFsFields(obj: Record<string, unknown>): Record<string, FsFieldValue> {
  const fields: Record<string, FsFieldValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFsValue(v);
  }
  return fields;
}

function fromFsValue(val?: FsFieldValue): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map((item) => fromFsValue(item));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      out[k] = fromFsValue(v);
    }
    return out;
  }
  return null;
}

function fromFsFields(fields?: Record<string, FsFieldValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fromFsValue(v);
  }
  return out;
}

export interface CatalogVariantInfo {
  id: string;
  sku: string;
  size: string;
  color_name: string;
  price_paise: number;
  stock_qty: number;
}

export interface CatalogProductInfo {
  id: string;
  slug: string;
  title: string;
  sku: string;
  status: string;
  category?: string;
  description?: string;
  fabric_note?: string;
  price_paise: number;
  stock_qty: number;
  variants: CatalogVariantInfo[];
}

function buildSeedCatalogProducts(): CatalogProductInfo[] {
  return PRODUCTS.map((item) => {
    const slug =
      item.slug ||
      item.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const sku =
      SEED_SKU_BY_ID[item.id] ||
      (item.id.toLowerCase().startsWith('sc-')
        ? `SC-${item.id.slice(3).toUpperCase()}`
        : `SC-${item.id.toUpperCase()}`);
    const pricePaise = item.pricePaise ?? Math.round(item.price * 100);

    let pos = 0;
    const variants: CatalogVariantInfo[] = [];
    for (const size of item.sizes) {
      for (const color of item.colors) {
        const colorCode = color.name
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 3)
          .toUpperCase();
        const sizeCode = size.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        variants.push({
          id: `${item.id}-var-${pos + 1}`,
          sku: `${sku}-${sizeCode}-${colorCode}-${pos + 1}`,
          size,
          color_name: color.name,
          price_paise: pricePaise,
          stock_qty: 6,
        });
        pos += 1;
      }
    }

    const totalStock = variants.reduce((s, v) => s + v.stock_qty, 0);
    return {
      id: item.id,
      slug,
      title: item.name,
      sku,
      status: 'published',
      category: item.category,
      description: item.description,
      fabric_note: item.fabricNote,
      price_paise: pricePaise,
      stock_qty: totalStock,
      variants,
    };
  });
}

function getFirestoreContext(): {
  projectId: string;
  databaseId: string;
  apiKey?: string;
  namespace: string;
  dbRootResource: string;
  docBaseUrl: string;
} | null {
  const cfg = loadFirebaseConfig();
  if (!cfg) return null;
  const namespace = resolveServerFirestoreNamespace();
  const dbRootResource = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents`;
  return {
    projectId: cfg.projectId,
    databaseId: cfg.firestoreDatabaseId,
    apiKey: cfg.apiKey,
    namespace,
    dbRootResource,
    docBaseUrl: `https://firestore.googleapis.com/v1/${dbRootResource}`,
  };
}

function shouldRequireDurablePersistence(params: {
  store?: BoutiqueStore | null;
  requireDurablePersistence?: boolean;
}): boolean {
  if (params.requireDurablePersistence !== undefined) {
    return params.requireDurablePersistence;
  }
  if (params.store) return true;
  if (process.env.VERCEL === '1') return true;
  if (Boolean((process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim())) return true;
  if (Boolean((process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim())) return true;
  return false;
}

export async function fetchPublishedCatalogFromFirestore(): Promise<Map<string, CatalogProductInfo>> {
  const ctx = getFirestoreContext();
  const byId = new Map<string, CatalogProductInfo>();

  const seeds = buildSeedCatalogProducts();
  for (const seed of seeds) {
    byId.set(seed.id, seed);
  }

  if (!ctx) return byId;

  const bearerToken = await getFirestoreAdminBearerToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const keyParam = !bearerToken && ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';

  const hiddenIds = new Set<string>();
  const hiddenSlugs = new Set<string>();
  const deletedIds = new Set<string>();

  try {
    const settingsRes = await fetch(
      `${ctx.docBaseUrl}/environments/${ctx.namespace}/site_documents/settings${keyParam}`,
      { headers }
    );
    if (settingsRes.ok) {
      const settingsJson = (await settingsRes.json()) as {
        fields?: Record<string, FsFieldValue>;
      };
      const settingsData = fromFsFields(settingsJson.fields);
      const hIds = Array.isArray(settingsData.hidden_product_ids)
        ? settingsData.hidden_product_ids
        : [];
      const hSlugs = Array.isArray(settingsData.hidden_product_slugs)
        ? settingsData.hidden_product_slugs
        : [];
      const dIds = Array.isArray(settingsData.deleted_product_ids)
        ? settingsData.deleted_product_ids
        : [];
      for (const id of hIds) if (typeof id === 'string') hiddenIds.add(id);
      for (const slug of hSlugs) if (typeof slug === 'string') hiddenSlugs.add(slug);
      for (const id of dIds) {
        if (typeof id === 'string') {
          deletedIds.add(id);
          hiddenIds.add(id);
        }
      }
    }
  } catch {
    // Non-fatal: continue with seed + runQuery
  }

  try {
    const queryUrl = `${ctx.docBaseUrl}/environments/${ctx.namespace}:runQuery${keyParam}`;
    const res = await fetch(queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'products' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'status' },
              op: 'EQUAL',
              value: { stringValue: 'published' },
            },
          },
        },
      }),
    });

    if (res.ok) {
      const rows = (await res.json()) as Array<{
        document?: { name?: string; fields?: Record<string, FsFieldValue> };
      }>;
      for (const row of rows) {
        if (!row.document?.fields) continue;
        const raw = fromFsFields(row.document.fields);
        const docId =
          typeof raw.id === 'string' && raw.id
            ? raw.id
            : row.document.name?.split('/').pop() || '';
        if (!docId) continue;

        const rawVariants = Array.isArray(raw.variants) ? raw.variants : [];
        const variants: CatalogVariantInfo[] = rawVariants
          .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === 'object'))
          .map((v, idx) => ({
            id: typeof v.id === 'string' && v.id ? v.id : `${docId}-var-${idx + 1}`,
            sku:
              typeof v.sku === 'string' && v.sku
                ? v.sku
                : `${String(raw.sku || docId)}-V${idx + 1}`,
            size: typeof v.size === 'string' && v.size ? v.size : 'Free Size',
            color_name:
              typeof v.color_name === 'string' && v.color_name ? v.color_name : 'Signature',
            price_paise: Math.round(Number(v.price_paise ?? raw.price_paise ?? 0)),
            stock_qty: Math.round(Number(v.stock_qty ?? 0)),
          }));

        byId.set(docId, {
          id: docId,
          slug: typeof raw.slug === 'string' ? raw.slug : docId,
          title: typeof raw.title === 'string' ? raw.title : 'Sahithi Piece',
          sku: typeof raw.sku === 'string' ? raw.sku : docId,
          status: typeof raw.status === 'string' ? raw.status : 'published',
          category: typeof raw.category === 'string' ? raw.category : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          fabric_note: typeof raw.fabric_note === 'string' ? raw.fabric_note : undefined,
          price_paise: Math.round(Number(raw.price_paise ?? 0)),
          stock_qty: Math.round(Number(raw.stock_qty ?? 0)),
          variants,
        });
      }
    }
  } catch {
    // Fallback to seed catalog when Firestore is unreachable
  }

  for (const [id, prod] of Array.from(byId.entries())) {
    if (
      deletedIds.has(id) ||
      hiddenIds.has(id) ||
      hiddenSlugs.has(prod.slug) ||
      (prod.status !== 'published' && prod.status !== 'active')
    ) {
      byId.delete(id);
    }
  }

  return byId;
}

async function fetchCouponFromFirestoreByCode(
  code: string,
  options?: { bearerToken?: string | null; requestId?: string }
): Promise<CouponRow | null> {
  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const bearerToken =
    options?.bearerToken !== undefined
      ? options.bearerToken
      : await getFirestoreAdminBearerToken({
          operation: 'fetch_coupon',
          requestId: options?.requestId,
        });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const keyParam = !bearerToken && ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';
  const queryUrl = `${ctx.docBaseUrl}/environments/${ctx.namespace}:runQuery${keyParam}`;
  try {
    const res = await fetch(queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'coupons' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'code' },
              op: 'EQUAL',
              value: { stringValue: code.trim().toUpperCase() },
            },
          },
          limit: 1,
        },
      }),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      document?: { name?: string; fields?: Record<string, FsFieldValue> };
    }>;
    if (!rows[0]?.document?.fields) return null;
    const d = fromFsFields(rows[0].document.fields);
    return {
      id: String(d.id || rows[0].document.name?.split('/').pop() || ''),
      code: String(d.code || code).toUpperCase(),
      title: String(d.title || ''),
      description: String(d.description || ''),
      discount_type: d.discount_type === 'flat_paise' ? 'flat_paise' : 'percent',
      discount_value: Number(d.discount_value || 0),
      max_discount_paise:
        typeof d.max_discount_paise === 'number' ? d.max_discount_paise : null,
      min_spend_paise: Number(d.min_spend_paise || 0),
      usage_limit: typeof d.usage_limit === 'number' ? d.usage_limit : null,
      used_count: Number(d.used_count || 0),
      active: d.active ? 1 : 0,
      starts_at: typeof d.starts_at === 'number' ? d.starts_at : null,
      expires_at: typeof d.expires_at === 'number' ? d.expires_at : null,
      created_at: Number(d.created_at || 0),
      updated_at: Number(d.updated_at || 0),
    };
  } catch {
    return null;
  }
}

async function fetchGiftCardFromFirestoreByCode(
  code: string,
  options?: { bearerToken?: string | null; requestId?: string }
): Promise<GiftCardRow | null> {
  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const bearerToken =
    options?.bearerToken !== undefined
      ? options.bearerToken
      : await getFirestoreAdminBearerToken({
          operation: 'fetch_gift_card',
          requestId: options?.requestId,
        });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const keyParam = !bearerToken && ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';
  const queryUrl = `${ctx.docBaseUrl}/environments/${ctx.namespace}:runQuery${keyParam}`;
  try {
    const res = await fetch(queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'gift_cards' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'code' },
              op: 'EQUAL',
              value: { stringValue: code.trim().toUpperCase() },
            },
          },
          limit: 1,
        },
      }),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      document?: { name?: string; fields?: Record<string, FsFieldValue> };
    }>;
    if (!rows[0]?.document?.fields) return null;
    const d = fromFsFields(rows[0].document.fields);
    return {
      id: String(d.id || rows[0].document.name?.split('/').pop() || ''),
      code: String(d.code || code).toUpperCase(),
      recipient_email: String(d.recipient_email || ''),
      note: String(d.note || ''),
      initial_balance_paise: Number(d.initial_balance_paise || 0),
      balance_paise: Number(d.balance_paise || 0),
      active: d.active ? 1 : 0,
      expires_at: typeof d.expires_at === 'number' ? d.expires_at : null,
      last_used_at: typeof d.last_used_at === 'number' ? d.last_used_at : null,
      created_at: Number(d.created_at || 0),
      updated_at: Number(d.updated_at || 0),
    };
  } catch {
    return null;
  }
}

export async function validatePromoAndGiftCardForBag(params: {
  subtotalPaise: number;
  couponCode?: string | null;
  giftCardCode?: string | null;
  store?: BoutiqueStore | null;
  ensurePayableMinimum?: boolean;
}): Promise<{
  couponCode: string | null;
  discountPaise: number;
  giftCardCode: string | null;
  giftCardPaise: number;
  finalAmountPaise: number;
}> {
  const { subtotalPaise, store } = params;
  const now = Date.now();
  let couponCode: string | null = null;
  let discountPaise = 0;

  if (params.couponCode && params.couponCode.trim()) {
    const cleanCode = params.couponCode.trim().toUpperCase();
    const coupon = store
      ? await store.getCouponByCode(cleanCode)
      : await fetchCouponFromFirestoreByCode(cleanCode);
    if (!coupon || !coupon.active) {
      throw new StoreHttpError(400, 'INVALID_COUPON', `Coupon "${cleanCode}" is invalid or inactive.`);
    }
    if (coupon.starts_at && now < coupon.starts_at) {
      throw new StoreHttpError(400, 'INVALID_COUPON', `Coupon "${cleanCode}" is not active yet.`);
    }
    if (coupon.expires_at && now > coupon.expires_at) {
      throw new StoreHttpError(400, 'COUPON_EXPIRED', `Coupon "${cleanCode}" has expired.`);
    }
    if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit) {
      throw new StoreHttpError(400, 'COUPON_EXHAUSTED', `Coupon "${cleanCode}" has reached its redemption limit.`);
    }
    if (subtotalPaise < coupon.min_spend_paise) {
      throw new StoreHttpError(
        400,
        'COUPON_MIN_SPEND',
        `Coupon "${cleanCode}" requires a minimum bag value of ₹${(coupon.min_spend_paise / 100).toLocaleString('en-IN')}.`
      );
    }

    if (coupon.discount_type === 'percent') {
      discountPaise = Math.round((subtotalPaise * coupon.discount_value) / 100);
      if (coupon.max_discount_paise && coupon.max_discount_paise > 0) {
        discountPaise = Math.min(discountPaise, coupon.max_discount_paise);
      }
    } else {
      discountPaise = coupon.discount_value;
    }
    const maxAllowedDiscount = params.ensurePayableMinimum
      ? Math.max(0, subtotalPaise - MIN_PRICE_PAISE)
      : subtotalPaise;
    discountPaise = Math.max(0, Math.min(maxAllowedDiscount, Math.round(discountPaise)));
    couponCode = coupon.code;
  }

  let giftCardCode: string | null = null;
  let giftCardPaise = 0;
  if (params.giftCardCode && params.giftCardCode.trim()) {
    const cleanGc = params.giftCardCode.trim().toUpperCase();
    const gc = store
      ? await store.getGiftCardByCode(cleanGc)
      : await fetchGiftCardFromFirestoreByCode(cleanGc);
    if (!gc || !gc.active) {
      throw new StoreHttpError(400, 'INVALID_GIFT_CARD', `Gift card "${cleanGc}" was not found or is inactive.`);
    }
    if (gc.expires_at && now > gc.expires_at) {
      throw new StoreHttpError(400, 'GIFT_CARD_EXPIRED', `Gift card "${cleanGc}" has expired.`);
    }
    if (gc.balance_paise <= 0) {
      throw new StoreHttpError(400, 'GIFT_CARD_EMPTY', `Gift card "${cleanGc}" has zero remaining balance.`);
    }
    const afterCoupon = Math.max(0, subtotalPaise - discountPaise);
    const maxRedeemable = params.ensurePayableMinimum
      ? Math.max(0, afterCoupon - MIN_PRICE_PAISE)
      : afterCoupon;
    giftCardPaise = Math.min(gc.balance_paise, maxRedeemable);
    giftCardCode = gc.code;
  }

  const finalAmountPaise = Math.max(0, subtotalPaise - discountPaise - giftCardPaise);
  return {
    couponCode,
    discountPaise,
    giftCardCode,
    giftCardPaise,
    finalAmountPaise,
  };
}

async function validateCartAgainstCatalog(params: {
  items: CartLineInput[];
  store?: BoutiqueStore | null;
}): Promise<{ lines: ValidatedOrderLine[]; totalPaise: number }> {
  const { items, store } = params;
  if (!Array.isArray(items) || items.length === 0) {
    throw new StoreHttpError(400, 'EMPTY_CART', 'At least one item is required for checkout.');
  }
  if (items.length > 50) {
    throw new StoreHttpError(400, 'VALIDATION_ERROR', 'Cart cannot contain more than 50 lines.');
  }

  const requestedIds = Array.from(
    new Set(items.map((it) => String(it.productId || '').trim()).filter(Boolean))
  );
  let storeMap: Map<string, Awaited<ReturnType<BoutiqueStore['getPublicProductByIdOrSlug']>>> | null = null;
  let catalogMap: Map<string, CatalogProductInfo> | null = null;
  if (store) {
    const rawMap = await store.getProductsForCartValidation(requestedIds);
    storeMap = rawMap;
  } else {
    catalogMap = await fetchPublishedCatalogFromFirestore();
  }

  const lines: ValidatedOrderLine[] = [];
  let totalPaise = 0;

  for (const rawLine of items) {
    const productId = String(rawLine.productId || '').trim();
    const variantId = rawLine.variantId ? String(rawLine.variantId).trim() : '';
    const quantity = Math.round(Number(rawLine.quantity || 0));
    const expectedPricePaise =
      rawLine.expectedPricePaise !== undefined && rawLine.expectedPricePaise !== null
        ? Math.round(Number(rawLine.expectedPricePaise))
        : null;

    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new StoreHttpError(
        400,
        'VALIDATION_ERROR',
        'Each bag item must have a valid product and quantity between 1 and 20.'
      );
    }

    let prod: CatalogProductInfo | undefined;
    if (store) {
      const found = storeMap?.get(productId) || (await store.getPublicProductByIdOrSlug(productId));
      if (
        found &&
        (found.product.status === 'published' ||
          (found.product.status as string) === 'active')
      ) {
        prod = {
          id: found.product.id,
          slug: found.product.slug,
          title: found.product.title,
          sku: found.product.sku,
          status: found.product.status,
          price_paise: found.product.price_paise,
          stock_qty: found.product.stock_qty,
          variants: found.variants.map((v) => ({
            id: v.id,
            sku: v.sku,
            size: v.size,
            color_name: v.color_name,
            price_paise: v.price_paise,
            stock_qty: v.stock_qty,
          })),
        };
      }
    } else {
      prod = catalogMap?.get(productId);
    }

    if (!prod) {
      throw new StoreHttpError(
        409,
        'PRODUCT_UNAVAILABLE',
        'One or more items in your bag are no longer available.'
      );
    }

    const variant =
      (variantId ? prod.variants.find((v) => v.id === variantId) : prod.variants[0]) ||
      prod.variants[0] ||
      null;

    if (variantId && prod.variants.length > 0 && !prod.variants.some((v) => v.id === variantId)) {
      throw new StoreHttpError(
        409,
        'VARIANT_UNAVAILABLE',
        `Selected option for "${prod.title}" is no longer available.`
      );
    }

    const unitPricePaise = variant ? variant.price_paise : prod.price_paise;
    const availableStock = variant ? variant.stock_qty : prod.stock_qty;

    if (!Number.isInteger(unitPricePaise) || unitPricePaise < MIN_PRICE_PAISE) {
      throw new StoreHttpError(
        400,
        'INVALID_AMOUNT',
        `Invalid server price configured for "${prod.title}".`
      );
    }

    if (expectedPricePaise !== null && expectedPricePaise !== unitPricePaise) {
      throw new StoreHttpError(
        409,
        'PRICE_CHANGED',
        `The price for "${prod.title}" has been updated. Please refresh your bag.`
      );
    }

    if (availableStock < quantity || availableStock <= 0) {
      throw new StoreHttpError(
        409,
        'INSUFFICIENT_STOCK',
        availableStock <= 0
          ? `"${prod.title}" is currently out of stock.`
          : `Only ${availableStock} piece(s) left for "${prod.title}".`
      );
    }

    const lineTotalPaise = unitPricePaise * quantity;
    totalPaise += lineTotalPaise;
    lines.push({
      productId: prod.id,
      variantId: variant?.id || prod.id,
      productTitle: prod.title,
      variantLabel: variant ? `${variant.size} / ${variant.color_name}` : 'Standard',
      sku: variant?.sku || prod.sku,
      unitPricePaise,
      quantity,
      lineTotalPaise,
    });
  }

  return { lines, totalPaise };
}

function createSignedCheckoutToken(
  payload: SignedCheckoutTokenPayload,
  keySecret: string
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', keySecret)
    .update(`rzp_chk_v1.${encoded}`)
    .digest('base64url');
  return `v1.${encoded}.${sig}`;
}

function verifySignedCheckoutToken(
  token: string,
  keySecret: string
): SignedCheckoutTokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', keySecret)
    .update(`rzp_chk_v1.${encoded}`)
    .digest('base64url');

  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf = Buffer.from(providedSig, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as SignedCheckoutTokenPayload;
    if (
      parsed.v !== 1 ||
      typeof parsed.oid !== 'string' ||
      !parsed.oid ||
      typeof parsed.amt !== 'number' ||
      !Number.isInteger(parsed.amt) ||
      typeof parsed.cur !== 'string' ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toPendingCheckoutRow(record: PendingCheckoutRecord): PendingCheckoutRow {
  return {
    id: record.razorpayOrderId,
    customer_user_id: record.customerUserId,
    amount_paise: record.amountPaise,
    subtotal_paise: record.subtotalPaise,
    discount_paise: record.discountPaise,
    gift_card_paise: record.giftCardPaise,
    coupon_code: record.couponCode,
    gift_card_code: record.giftCardCode,
    currency: record.currency,
    receipt: record.receipt,
    items_json: JSON.stringify(record.items),
    customer_json: record.customer ? JSON.stringify(record.customer) : null,
    status: record.status,
    razorpay_payment_id: record.razorpayPaymentId || null,
    confirmed_order_id: record.confirmedOrder?.id || null,
    confirmed_order_json: record.confirmedOrder ? JSON.stringify(record.confirmedOrder) : null,
    created_at: record.createdAt,
    updated_at: Date.now(),
    expires_at: record.expiresAt,
  };
}

function fromPendingCheckoutRow(row: PendingCheckoutRow): PendingCheckoutRecord {
  let items: ValidatedOrderLine[] = [];
  let customer: OrderCustomerDetails | null = null;
  let confirmedOrder: SerializedOrderReceipt | undefined;
  try {
    const parsed = JSON.parse(row.items_json || '[]') as unknown;
    if (Array.isArray(parsed)) items = parsed as ValidatedOrderLine[];
  } catch {
    items = [];
  }
  if (row.customer_json) {
    try {
      customer = JSON.parse(row.customer_json) as OrderCustomerDetails;
    } catch {
      customer = null;
    }
  }
  if (row.confirmed_order_json) {
    try {
      confirmedOrder = JSON.parse(row.confirmed_order_json) as SerializedOrderReceipt;
    } catch {
      confirmedOrder = undefined;
    }
  }
  return {
    razorpayOrderId: row.id,
    amountPaise: row.amount_paise,
    subtotalPaise: row.subtotal_paise,
    discountPaise: row.discount_paise,
    giftCardPaise: row.gift_card_paise,
    couponCode: row.coupon_code,
    giftCardCode: row.gift_card_code,
    currency: row.currency,
    receipt: row.receipt,
    items,
    customer,
    customerUserId: row.customer_user_id,
    status:
      row.status === 'confirmed' ||
      row.status === 'payment_received_pending_confirm' ||
      row.status === 'failed'
        ? row.status
        : 'pending',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    razorpayPaymentId: row.razorpay_payment_id || undefined,
    confirmedOrder,
  };
}

async function savePendingCheckoutToFirestore(
  record: PendingCheckoutRecord,
  options?: { strict?: boolean; requestId?: string; bearerToken?: string | null }
): Promise<boolean> {
  const ctx = getFirestoreContext();
  if (!ctx) {
    if (options?.strict) {
      logCheckoutPersistenceFailure({
        operation: 'save_pending_checkout',
        projectId: 'unknown',
        databaseId: 'unknown',
        namespace: resolveServerFirestoreNamespace(),
        path: `pending_checkouts/${record.razorpayOrderId}`,
        status: 503,
        code: 'FIREBASE_CONFIG_MISSING',
        requestId: options.requestId,
        reason: 'firebase-applet-config.json is missing or invalid.',
      });
      throw new StoreHttpError(
        503,
        'CHECKOUT_PERSISTENCE_FAILED',
        'Unable to initialize payment checkout right now. Please try again in a moment.'
      );
    }
    return false;
  }

  const docPath = `environments/${ctx.namespace}/pending_checkouts/${record.razorpayOrderId}`;
  const tokenRes: ServerBearerResult = options?.bearerToken
    ? { ok: true, token: options.bearerToken }
    : await resolveFirestoreServerBearerToken({
        operation: 'save_pending_checkout',
        requestId: options?.requestId,
        ctx,
      });

  if (!tokenRes.ok) {
    if (!options?.strict) {
      return false;
    }
    logCheckoutPersistenceFailure({
      operation: 'save_pending_checkout',
      projectId: ctx.projectId,
      databaseId: ctx.databaseId,
      namespace: ctx.namespace,
      path: docPath,
      status: tokenRes.status,
      code: tokenRes.reasonCode,
      requestId: options?.requestId,
      reason: tokenRes.detail,
    });
    throw new StoreHttpError(
      503,
      'CHECKOUT_PERSISTENCE_FAILED',
      'Unable to initialize payment checkout right now. Please try again in a moment.'
    );
  }

  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/pending_checkouts/${encodeURIComponent(record.razorpayOrderId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenRes.token}`,
      },
      body: JSON.stringify({
        fields: toFsFields({
          id: record.razorpayOrderId,
          razorpay_order_id: record.razorpayOrderId,
          amount_paise: record.amountPaise,
          subtotal_paise: record.subtotalPaise,
          discount_paise: record.discountPaise,
          gift_card_paise: record.giftCardPaise,
          coupon_code: record.couponCode,
          gift_card_code: record.giftCardCode,
          currency: record.currency,
          receipt: record.receipt,
          items: record.items,
          customer: record.customer,
          customer_user_id: record.customerUserId,
          status: record.status,
          created_at: record.createdAt,
          updated_at: Date.now(),
          expires_at: record.expiresAt,
          ...(record.razorpayPaymentId ? { razorpay_payment_id: record.razorpayPaymentId } : {}),
          ...(record.idempotencyKey ? { idempotency_key: record.idempotencyKey } : {}),
          ...(record.payloadHash ? { payload_hash: record.payloadHash } : {}),
          ...(record.failureReason ? { failure_reason: record.failureReason } : {}),
          ...(record.confirmedOrder ? { confirmed_order: record.confirmedOrder } : {}),
        }),
      }),
    });
  } catch (err) {
    if (!options?.strict) return false;
    logCheckoutPersistenceFailure({
      operation: 'save_pending_checkout',
      projectId: ctx.projectId,
      databaseId: ctx.databaseId,
      namespace: ctx.namespace,
      path: docPath,
      status: 503,
      code: 'FIRESTORE_NETWORK_ERROR',
      requestId: options?.requestId,
      reason: err instanceof Error ? err.message : 'Network error calling Firestore REST API.',
    });
    throw new StoreHttpError(
      503,
      'CHECKOUT_PERSISTENCE_FAILED',
      'Unable to initialize payment checkout right now. Please try again in a moment.'
    );
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logCheckoutPersistenceFailure({
      operation: 'save_pending_checkout',
      projectId: ctx.projectId,
      databaseId: ctx.databaseId,
      namespace: ctx.namespace,
      path: docPath,
      status: res.status,
      code: res.status === 403 ? 'FIRESTORE_PERMISSION_DENIED' : 'FIRESTORE_WRITE_FAILED',
      requestId: options?.requestId,
      reason: errText || res.statusText || `HTTP ${res.status}`,
    });
    if (options?.strict) {
      throw new StoreHttpError(
        503,
        'CHECKOUT_PERSISTENCE_FAILED',
        'Unable to initialize payment checkout right now. Please try again in a moment.'
      );
    }
    return false;
  }
  return true;
}

async function loadPendingCheckoutFromFirestore(
  razorpayOrderId: string,
  options?: { requestId?: string }
): Promise<PendingCheckoutRecord | null> {
  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const tokenRes = await resolveFirestoreServerBearerToken({
    operation: 'load_pending_checkout',
    requestId: options?.requestId,
    ctx,
  });
  if (!tokenRes.ok) return null;

  const docPath = `environments/${ctx.namespace}/pending_checkouts/${razorpayOrderId}`;
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/pending_checkouts/${encodeURIComponent(razorpayOrderId)}`;
  try {
    const res = await withTransientRetry(() =>
      fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      })
    );
    if (!res.ok) {
      if (res.status !== 404) {
        const errText = await res.text().catch(() => '');
        logCheckoutPersistenceFailure({
          operation: 'load_pending_checkout',
          projectId: ctx.projectId,
          databaseId: ctx.databaseId,
          namespace: ctx.namespace,
          path: docPath,
          status: res.status,
          code: 'FIRESTORE_READ_FAILED',
          requestId: options?.requestId,
          reason: errText || res.statusText || `HTTP ${res.status}`,
        });
      }
      return null;
    }
    const json = (await res.json()) as { fields?: Record<string, FsFieldValue> };
    const data = fromFsFields(json.fields);
    if (typeof data.razorpay_order_id !== 'string') return null;
    return {
      razorpayOrderId: data.razorpay_order_id,
      amountPaise: Math.round(Number(data.amount_paise || 0)),
      subtotalPaise: Math.round(Number(data.subtotal_paise || data.amount_paise || 0)),
      discountPaise: Math.round(Number(data.discount_paise || 0)),
      giftCardPaise: Math.round(Number(data.gift_card_paise || 0)),
      couponCode: typeof data.coupon_code === 'string' ? data.coupon_code : null,
      giftCardCode: typeof data.gift_card_code === 'string' ? data.gift_card_code : null,
      currency: String(data.currency || 'INR'),
      receipt: String(data.receipt || ''),
      items: Array.isArray(data.items) ? (data.items as ValidatedOrderLine[]) : [],
      customer:
        data.customer && typeof data.customer === 'object'
          ? (data.customer as OrderCustomerDetails)
          : null,
      customerUserId:
        typeof data.customer_user_id === 'string' ? data.customer_user_id : null,
      status:
        data.status === 'confirmed'
          ? 'confirmed'
          : data.status === 'payment_received_pending_confirm'
            ? 'payment_received_pending_confirm'
            : data.status === 'failed'
              ? 'failed'
              : 'pending',
      createdAt: Number(data.created_at || Date.now()),
      expiresAt: Number(data.expires_at || Date.now() + CHECKOUT_TOKEN_TTL_MS),
      razorpayPaymentId:
        typeof data.razorpay_payment_id === 'string' ? data.razorpay_payment_id : undefined,
      idempotencyKey:
        typeof data.idempotency_key === 'string' ? data.idempotency_key : null,
      payloadHash:
        typeof data.payload_hash === 'string' ? data.payload_hash : undefined,
      failureReason:
        typeof data.failure_reason === 'string' ? data.failure_reason : undefined,
      confirmedOrder:
        data.confirmed_order && typeof data.confirmed_order === 'object'
          ? (data.confirmed_order as SerializedOrderReceipt)
          : undefined,
    };
  } catch {
    return null;
  }
}

function buildAttemptDocId(idempotencyKey: string): string {
  return crypto.createHash('sha256').update(`rzp_attempt:${idempotencyKey}`).digest('hex').slice(0, 32);
}

async function loadCreateOrderAttempt(
  idempotencyKey: string,
  options?: { store?: BoutiqueStore | null; requestId?: string }
): Promise<{ payloadHash: string; razorpayOrderId: string; keyId: string; expiresAt: number } | null> {
  const now = Date.now();
  const mem = idempotentOrderAttemptsMemory.get(idempotencyKey);
  if (mem && mem.expiresAt > now) {
    return mem;
  }
  if (options?.store) return null;

  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const tokenRes = await resolveFirestoreServerBearerToken({
    operation: 'load_create_order_attempt',
    requestId: options?.requestId,
    ctx,
  });
  if (!tokenRes.ok) return null;

  const attemptDocId = buildAttemptDocId(idempotencyKey);
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/pending_checkout_attempts/${encodeURIComponent(attemptDocId)}`;
  try {
    const res = await withTransientRetry(() =>
      fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      })
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { fields?: Record<string, FsFieldValue> };
    const data = fromFsFields(json.fields);
    if (
      typeof data.razorpay_order_id !== 'string' ||
      typeof data.payload_hash !== 'string' ||
      Number(data.expires_at || 0) <= now
    ) {
      return null;
    }
    const found = {
      payloadHash: data.payload_hash,
      razorpayOrderId: data.razorpay_order_id,
      keyId: typeof data.key_id === 'string' ? data.key_id : '',
      expiresAt: Number(data.expires_at),
    };
    idempotentOrderAttemptsMemory.set(idempotencyKey, found);
    return found;
  } catch {
    return null;
  }
}

async function saveCreateOrderAttempt(params: {
  idempotencyKey: string;
  payloadHash: string;
  razorpayOrderId: string;
  keyId: string;
  expiresAt: number;
  store?: BoutiqueStore | null;
  requestId?: string;
  bearerToken?: string | null;
}): Promise<void> {
  idempotentOrderAttemptsMemory.set(params.idempotencyKey, {
    payloadHash: params.payloadHash,
    razorpayOrderId: params.razorpayOrderId,
    keyId: params.keyId,
    expiresAt: params.expiresAt,
  });

  if (params.store) return;
  const ctx = getFirestoreContext();
  if (!ctx) return;

  let token = params.bearerToken || null;
  if (!token) {
    const tokenRes = await resolveFirestoreServerBearerToken({
      operation: 'save_create_order_attempt',
      requestId: params.requestId,
      ctx,
    }).catch(() => null);
    if (tokenRes && tokenRes.ok) {
      token = tokenRes.token;
    }
  }

  if (!token) return;
  const attemptDocId = buildAttemptDocId(params.idempotencyKey);
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/pending_checkout_attempts/${encodeURIComponent(attemptDocId)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      fields: toFsFields({
        id: attemptDocId,
        idempotency_key: params.idempotencyKey,
        payload_hash: params.payloadHash,
        razorpay_order_id: params.razorpayOrderId,
        key_id: params.keyId,
        expires_at: params.expiresAt,
        updated_at: Date.now(),
      }),
    }),
  }).catch(() => {});
}

function buildWebhookEventDocId(eventId: string): string {
  return crypto.createHash('sha256').update(`webhook:${eventId}`).digest('hex').slice(0, 32);
}

async function loadWebhookEventProcessed(
  eventId: string,
  options?: { store?: BoutiqueStore | null; requestId?: string }
): Promise<{ eventType: string; processedAt: number; orderId?: string; order?: SerializedOrderReceipt } | null> {
  const mem = processedWebhookEventsMemory.get(eventId);
  if (mem) return mem;
  if (options?.store) return null;

  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const tokenRes = await resolveFirestoreServerBearerToken({
    operation: 'load_webhook_event',
    requestId: options?.requestId,
    ctx,
  });
  if (!tokenRes.ok) return null;

  const docId = buildWebhookEventDocId(eventId);
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/webhook_events/${encodeURIComponent(docId)}`;
  try {
    const res = await withTransientRetry(() =>
      fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      })
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { fields?: Record<string, FsFieldValue> };
    const data = fromFsFields(json.fields);
    if (typeof data.event_type !== 'string') return null;
    const found = {
      eventType: data.event_type,
      processedAt: Number(data.processed_at || Date.now()),
      orderId: typeof data.order_id === 'string' ? data.order_id : undefined,
      order:
        data.order && typeof data.order === 'object'
          ? (data.order as SerializedOrderReceipt)
          : undefined,
    };
    processedWebhookEventsMemory.set(eventId, found);
    return found;
  } catch {
    return null;
  }
}

async function saveWebhookEventProcessed(params: {
  eventId: string;
  eventType: string;
  orderId?: string;
  order?: SerializedOrderReceipt;
  store?: BoutiqueStore | null;
  requestId?: string;
}): Promise<void> {
  const record = {
    eventType: params.eventType,
    processedAt: Date.now(),
    orderId: params.orderId,
    order: params.order,
  };
  processedWebhookEventsMemory.set(params.eventId, record);

  if (params.store) return;
  const ctx = getFirestoreContext();
  if (!ctx) return;
  const tokenRes = await resolveFirestoreServerBearerToken({
    operation: 'save_webhook_event',
    requestId: params.requestId,
    ctx,
  });
  if (!tokenRes.ok) return;

  const docId = buildWebhookEventDocId(params.eventId);
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/webhook_events/${encodeURIComponent(docId)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenRes.token}`,
    },
    body: JSON.stringify({
      fields: toFsFields({
        id: docId,
        event_id: params.eventId,
        event_type: params.eventType,
        order_id: params.orderId || null,
        processed_at: record.processedAt,
        ...(params.order ? { order: params.order } : {}),
      }),
    }),
  }).catch(() => {});
}

function buildDeterministicOrderId(razorpayOrderId: string): string {
  const sanitized = razorpayOrderId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const candidate = `ord_rzp_${sanitized}`;
  return candidate.slice(0, 120);
}

function parseStatusHistorySafe(raw: unknown): OrderStatusHistoryEntry[] {
  if (Array.isArray(raw)) return raw as OrderStatusHistoryEntry[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as OrderStatusHistoryEntry[];
    } catch {
      return [];
    }
  }
  return [];
}

async function fetchExistingFirestoreOrder(
  orderDocId: string,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  options?: { requestId?: string; bearerToken?: string | null }
): Promise<SerializedOrderReceipt | null> {
  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const tokenRes: ServerBearerResult = options?.bearerToken
    ? { ok: true, token: options.bearerToken }
    : await resolveFirestoreServerBearerToken({
        operation: 'fetch_existing_order',
        requestId: options?.requestId,
        ctx,
      });
  if (!tokenRes.ok) return null;

  const docPath = `environments/${ctx.namespace}/orders/${orderDocId}`;
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/orders/${encodeURIComponent(orderDocId)}`;
  try {
    const res = await withTransientRetry(() =>
      fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      })
    );
    if (!res.ok) {
      if (res.status !== 404) {
        const errText = await res.text().catch(() => '');
        logCheckoutPersistenceFailure({
          operation: 'fetch_existing_order',
          projectId: ctx.projectId,
          databaseId: ctx.databaseId,
          namespace: ctx.namespace,
          path: docPath,
          status: res.status,
          code: 'FIRESTORE_READ_FAILED',
          requestId: options?.requestId,
          reason: errText || res.statusText || `HTTP ${res.status}`,
        });
      }
      return null;
    }
    const doc = (await res.json()) as { fields?: Record<string, FsFieldValue> };
    const data = fromFsFields(doc.fields);
    if (typeof data.id !== 'string') return null;
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const createdAt = Number(data.created_at || Date.now());
    const paymentMethodRaw = typeof data.payment_method === 'string' ? data.payment_method : '';
    const rzpOid = typeof data.razorpay_order_id === 'string' && data.razorpay_order_id ? data.razorpay_order_id : null;
    const rzpPid = typeof data.razorpay_payment_id === 'string' && data.razorpay_payment_id ? data.razorpay_payment_id : null;
    const paymentMethod: 'razorpay' | 'cod' =
      paymentMethodRaw === 'cod' || (!rzpOid && !rzpPid && paymentMethodRaw !== 'razorpay')
        ? 'cod'
        : 'razorpay';
    return {
      id: data.id,
      orderNumber: String(data.order_number || orderDocId),
      customerUserId:
        typeof data.customer_user_id === 'string' ? data.customer_user_id : null,
      status: String(data.status || (paymentMethod === 'cod' ? 'placed' : 'confirmed')),
      paymentStatus: String(
        data.payment_status || (paymentMethod === 'razorpay' ? 'paid' : 'unpaid')
      ),
      fulfillmentStatus: String(
        data.fulfillment_status || data.status || (paymentMethod === 'cod' ? 'placed' : 'confirmed')
      ),
      subtotalPaise: Number(data.subtotal_paise || 0),
      discountPaise: Number(data.discount_paise || 0),
      giftCardPaise: Number(data.gift_card_paise || 0),
      couponCode: typeof data.coupon_code === 'string' ? data.coupon_code : null,
      giftCardCode: typeof data.gift_card_code === 'string' ? data.gift_card_code : null,
      totalPaise: Number(data.total_paise || 0),
      currency: String(data.currency || 'INR'),
      createdAt,
      updatedAt: Number(data.updated_at || createdAt),
      paymentCollectedAt:
        typeof data.payment_collected_at === 'number' ? data.payment_collected_at : null,
      idempotencyKey:
        typeof data.idempotency_key === 'string' ? data.idempotency_key : null,
      paymentMethod,
      razorpayOrderId: rzpOid || (razorpayOrderId || null),
      razorpayPaymentId: rzpPid || (razorpayPaymentId || null),
      statusHistory: parseStatusHistorySafe(data.status_history_json),
      items: rawItems
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((it) => ({
          productId: String(it.product_id || ''),
          variantId: typeof it.variant_id === 'string' ? it.variant_id : null,
          productTitle: String(it.product_title || ''),
          variantLabel: String(it.variant_label || ''),
          sku: String(it.sku || ''),
          unitPricePaise: Number(it.unit_price_paise || 0),
          quantity: Number(it.quantity || 1),
          lineTotalPaise: Number(it.line_total_paise || 0),
        })),
    };
  } catch {
    return null;
  }
}

async function persistConfirmedOrderToFirestoreOnce(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  customerUserId: string | null;
  customer: OrderCustomerDetails;
  lines: ValidatedOrderLine[];
  subtotalPaise: number;
  discountPaise: number;
  giftCardPaise: number;
  couponCode: string | null;
  giftCardCode: string | null;
  totalPaise: number;
  strictPersistence?: boolean;
  requestId?: string;
}): Promise<SerializedOrderReceipt> {
  const {
    razorpayOrderId,
    razorpayPaymentId,
    customerUserId,
    customer,
    lines,
    subtotalPaise,
    discountPaise,
    giftCardPaise,
    couponCode,
    giftCardCode,
    totalPaise,
    strictPersistence = false,
    requestId,
  } = params;
  const ctx = getFirestoreContext();
  const orderDocId = buildDeterministicOrderId(razorpayOrderId);
  const now = Date.now();
  const suffix = crypto
    .createHash('sha256')
    .update(razorpayOrderId)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  const orderNumber = `SC-${suffix}`;
  const statusHistory: OrderStatusHistoryEntry[] = [
    {
      status: 'confirmed',
      note: 'Payment verified via Razorpay',
      actor: 'system',
      at: now,
    },
  ];
  const statusHistoryJson = JSON.stringify(statusHistory);

  const firestoreItems = lines.map((l, idx) => ({
    id: `item_${orderDocId}_${idx + 1}`,
    order_id: orderDocId,
    product_id: l.productId,
    variant_id: l.variantId,
    product_title: l.productTitle,
    variant_label: l.variantLabel,
    sku: l.sku,
    unit_price_paise: l.unitPricePaise,
    quantity: l.quantity,
    line_total_paise: l.lineTotalPaise,
  }));

  const receipt: SerializedOrderReceipt = {
    id: orderDocId,
    orderNumber,
    customerUserId,
    status: 'confirmed',
    paymentStatus: 'paid',
    fulfillmentStatus: 'confirmed',
    subtotalPaise,
    discountPaise,
    giftCardPaise,
    couponCode,
    giftCardCode,
    totalPaise,
    currency: 'INR',
    createdAt: now,
    paymentMethod: 'razorpay',
    razorpayOrderId,
    razorpayPaymentId,
    statusHistory,
    items: lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      productTitle: l.productTitle,
      variantLabel: l.variantLabel,
      sku: l.sku,
      unitPricePaise: l.unitPricePaise,
      quantity: l.quantity,
      lineTotalPaise: l.lineTotalPaise,
    })),
  };

  if (!ctx) {
    if (strictPersistence) {
      logCheckoutPersistenceFailure({
        operation: 'commit_confirmed_order',
        projectId: 'unknown',
        databaseId: 'unknown',
        namespace: resolveServerFirestoreNamespace(),
        path: `orders/${orderDocId}`,
        status: 503,
        code: 'FIREBASE_CONFIG_MISSING',
        requestId,
        reason: 'firebase-applet-config.json is missing or invalid.',
      });
      throw new StoreHttpError(
        503,
        'ORDER_CONFIRMATION_PENDING',
        'Payment received. Order confirmation is delayed and will complete shortly.'
      );
    }
    return receipt;
  }

  const orderPath = `environments/${ctx.namespace}/orders/${orderDocId}`;
  const tokenRes = await resolveFirestoreServerBearerToken({
    operation: 'commit_confirmed_order',
    requestId,
    ctx,
  });
  if (!tokenRes.ok) {
    if (!strictPersistence) {
      return receipt;
    }
    logCheckoutPersistenceFailure({
      operation: 'commit_confirmed_order',
      projectId: ctx.projectId,
      databaseId: ctx.databaseId,
      namespace: ctx.namespace,
      path: orderPath,
      status: tokenRes.status,
      code: tokenRes.reasonCode,
      requestId,
      reason: tokenRes.detail,
    });
    throw new StoreHttpError(
      503,
      'ORDER_CONFIRMATION_PENDING',
      'Payment received. Order confirmation is delayed and will complete shortly.'
    );
  }

  const adminBearer = tokenRes.token;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminBearer}`,
  };
  const productIds = Array.from(new Set(lines.map((l) => l.productId)));

  const docFields = {
    id: orderDocId,
    order_number: orderNumber,
    customer_user_id: customerUserId,
    customer_name: customer.customerName,
    customer_email: customer.customerEmail,
    customer_phone: customer.customerPhone,
    shipping_address: customer.shippingAddress,
    status: 'confirmed',
    payment_status: 'paid',
    fulfillment_status: 'confirmed',
    payment_method: 'razorpay',
    razorpay_order_id: razorpayOrderId,
    razorpay_payment_id: razorpayPaymentId,
    coupon_code: couponCode,
    gift_card_code: giftCardCode,
    discount_paise: discountPaise,
    gift_card_paise: giftCardPaise,
    status_history_json: statusHistoryJson,
    return_request_json: null,
    subtotal_paise: subtotalPaise,
    total_paise: totalPaise,
    currency: 'INR',
    created_at: now,
    updated_at: now,
    product_ids: productIds,
    items: firestoreItems,
  };

  const docName = `${ctx.dbRootResource}/environments/${ctx.namespace}/orders/${orderDocId}`;
  const writes: Array<Record<string, unknown>> = [
    {
      currentDocument: { exists: false },
      update: {
        name: docName,
        fields: toFsFields(docFields),
      },
    },
  ];

  if (customerUserId) {
    const notifId = `notif_placed_${orderDocId}`;
    writes.push({
      currentDocument: { exists: false },
      update: {
        name: `${ctx.dbRootResource}/environments/${ctx.namespace}/users/${encodeURIComponent(customerUserId)}/notifications/${notifId}`,
        fields: toFsFields({
          id: notifId,
          user_id: customerUserId,
          type: 'order_placed',
          title: `Order ${orderNumber} placed`,
          message: `Payment verified for order ${orderNumber} (₹${(totalPaise / 100).toLocaleString('en-IN')}).`,
          order_id: orderDocId,
          order_number: orderNumber,
          is_read: 0,
          read: false,
          read_at: null,
          created_at: now,
        }),
      },
    });
  }

  for (const pid of productIds) {
    try {
      const prodRes = await fetch(
        `${ctx.docBaseUrl}/environments/${ctx.namespace}/products/${encodeURIComponent(pid)}`,
        { headers }
      );
      if (prodRes.ok) {
        const prodDoc = (await prodRes.json()) as {
          updateTime?: string;
          fields?: Record<string, FsFieldValue>;
        };
        const prodData = fromFsFields(prodDoc.fields);
        const rawVariants = Array.isArray(prodData.variants) ? prodData.variants : [];
        const nextVariants = rawVariants.map((v) => {
          if (!v || typeof v !== 'object') return v;
          const rec = { ...(v as Record<string, unknown>) };
          const qtyOrdered = lines
            .filter((l) => l.productId === pid && l.variantId === String(rec.id || ''))
            .reduce((s, l) => s + l.quantity, 0);
          if (qtyOrdered > 0) {
            rec.stock_qty = Math.max(0, Number(rec.stock_qty || 0) - qtyOrdered);
          }
          return rec;
        });
        const nextTotalStock = nextVariants.reduce(
          (sum, v) =>
            sum + (v && typeof v === 'object' ? Number((v as Record<string, unknown>).stock_qty || 0) : 0),
          0
        );
        writes.push({
          ...(prodDoc.updateTime ? { currentDocument: { updateTime: prodDoc.updateTime } } : {}),
          update: {
            name: `${ctx.dbRootResource}/environments/${ctx.namespace}/products/${encodeURIComponent(pid)}`,
            fields: toFsFields({
              ...prodData,
              variants: nextVariants,
              stock_qty: nextTotalStock,
              updated_at: now,
            }),
          },
        });
      }
    } catch {
      // Skip best-effort stock read failure if product is seed-only
    }
  }

  if (couponCode) {
    const cpn = await fetchCouponFromFirestoreByCode(couponCode, {
      bearerToken: adminBearer,
      requestId,
    });
    if (cpn) {
      writes.push({
        update: {
          name: `${ctx.dbRootResource}/environments/${ctx.namespace}/coupons/${encodeURIComponent(cpn.id)}`,
          fields: toFsFields({
            ...cpn,
            used_count: Number(cpn.used_count || 0) + 1,
            updated_at: now,
          }),
        },
      });
    }
  }

  if (giftCardCode && giftCardPaise > 0) {
    const gc = await fetchGiftCardFromFirestoreByCode(giftCardCode, {
      bearerToken: adminBearer,
      requestId,
    });
    if (gc) {
      writes.push({
        update: {
          name: `${ctx.dbRootResource}/environments/${ctx.namespace}/gift_cards/${encodeURIComponent(gc.id)}`,
          fields: toFsFields({
            ...gc,
            balance_paise: Math.max(0, Number(gc.balance_paise || 0) - giftCardPaise),
            last_used_at: now,
            updated_at: now,
          }),
        },
      });
    }
  }

  let commitRes: Response;
  try {
    commitRes = await fetch(`${ctx.docBaseUrl}:commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ writes }),
    });
  } catch (err) {
    logCheckoutPersistenceFailure({
      operation: 'commit_confirmed_order',
      projectId: ctx.projectId,
      databaseId: ctx.databaseId,
      namespace: ctx.namespace,
      path: orderPath,
      status: 503,
      code: 'FIRESTORE_NETWORK_ERROR',
      requestId,
      reason: err instanceof Error ? err.message : 'Network error during Firestore commit.',
    });
    throw new StoreHttpError(
      503,
      'ORDER_CONFIRMATION_PENDING',
      'Payment received. Order confirmation is delayed and will complete shortly.'
    );
  }

  if (commitRes.ok) {
    return receipt;
  }

  const errText = await commitRes.text().catch(() => '');
  if (
    commitRes.status === 409 ||
    commitRes.status === 412 ||
    errText.includes('ALREADY_EXISTS') ||
    errText.includes('FAILED_PRECONDITION')
  ) {
    const existing = await fetchExistingFirestoreOrder(
      orderDocId,
      razorpayOrderId,
      razorpayPaymentId,
      { requestId, bearerToken: adminBearer }
    );
    if (existing) return existing;
  }

  logCheckoutPersistenceFailure({
    operation: 'commit_confirmed_order',
    projectId: ctx.projectId,
    databaseId: ctx.databaseId,
    namespace: ctx.namespace,
    path: orderPath,
    status: commitRes.status,
    code: commitRes.status === 403 ? 'FIRESTORE_PERMISSION_DENIED' : 'FIRESTORE_COMMIT_FAILED',
    requestId,
    reason: errText || commitRes.statusText || `HTTP ${commitRes.status}`,
  });

  throw new StoreHttpError(
    503,
    'ORDER_CONFIRMATION_PENDING',
    'Payment received. Order confirmation is delayed and will complete shortly.'
  );
}

function parseCartLines(rawItems: unknown): CartLineInput[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((obj) => ({
      productId: typeof obj.productId === 'string' ? obj.productId.trim() : '',
      variantId: typeof obj.variantId === 'string' ? obj.variantId.trim() : null,
      quantity:
        typeof obj.quantity === 'number' && Number.isFinite(obj.quantity)
          ? Math.round(obj.quantity)
          : Math.round(Number(obj.quantity || 0)),
      expectedPricePaise:
        typeof obj.expectedPricePaise === 'number' && Number.isFinite(obj.expectedPricePaise)
          ? Math.round(obj.expectedPricePaise)
          : typeof obj.seenPricePaise === 'number' && Number.isFinite(obj.seenPricePaise)
            ? Math.round(obj.seenPricePaise)
            : null,
    }))
    .filter((line) => line.productId.length > 0);
}

function parseCustomerDetails(raw: unknown): OrderCustomerDetails | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const customerName = typeof obj.customerName === 'string' ? obj.customerName.trim() : '';
  const customerEmail =
    typeof obj.customerEmail === 'string' ? obj.customerEmail.trim().toLowerCase() : '';
  const customerPhone = typeof obj.customerPhone === 'string' ? obj.customerPhone.trim() : '';
  const shippingAddress =
    typeof obj.shippingAddress === 'string' ? obj.shippingAddress.trim() : '';

  if (
    customerName.length >= 2 &&
    EMAIL_REGEX.test(customerEmail) &&
    customerPhone.length >= 7 &&
    shippingAddress.length >= 8
  ) {
    return { customerName, customerEmail, customerPhone, shippingAddress };
  }
  return null;
}

function sanitizeEnvCredential(raw: string | undefined, knownPrefixes: string[] = []): string {
  if (!raw) return '';
  let val = raw
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/\\r|\\n/gi, '')
    .replace(/[\r\n]+/g, '')
    .trim();

  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1).trim();
  }

  for (const prefix of knownPrefixes) {
    const eqPrefix = `${prefix}=`;
    if (val.toLowerCase().startsWith(eqPrefix.toLowerCase())) {
      val = val.slice(eqPrefix.length).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1).trim();
      }
      break;
    }
  }

  return val.replace(/\s+/g, '');
}

function maskRazorpayKeyId(keyId: string): string {
  if (keyId.length <= 12) return keyId;
  return `${keyId.slice(0, 12)}…${keyId.slice(-4)}`;
}

export function resolveRazorpayCredentials():
  | { ok: true; keyId: string; keySecret: string; mode: 'test' | 'live' }
  | { ok: false; code: string; error: string } {
  const keyId = sanitizeEnvCredential(process.env.RAZORPAY_KEY_ID, [
    'RAZORPAY_KEY_ID',
    'VITE_RAZORPAY_KEY_ID',
    'NEXT_PUBLIC_RAZORPAY_KEY_ID',
    'key_id',
  ]);
  const keySecret = sanitizeEnvCredential(
    process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET,
    ['RAZORPAY_KEY_SECRET', 'RAZORPAY_SECRET', 'key_secret']
  );

  if (!keyId || !keySecret) {
    return {
      ok: false,
      code: 'RAZORPAY_AUTH_FAILED',
      error:
        'Razorpay API credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured on the server.',
    };
  }

  if (/\*{3,}|•{3,}/.test(keySecret)) {
    return {
      ok: false,
      code: 'RAZORPAY_AUTH_FAILED',
      error:
        'RAZORPAY_KEY_SECRET contains masked asterisks (***) instead of the actual secret. Razorpay only reveals the Key Secret once at creation — click Regenerate Key in Razorpay Dashboard → Account & Settings → API Keys, save both the new Key ID and Secret in Vercel Environment Variables, and redeploy.',
    };
  }

  const keyMatch = /^rzp_(test|live)_[A-Za-z0-9_-]+$/.exec(keyId);
  if (!keyMatch) {
    return {
      ok: false,
      code: 'RAZORPAY_AUTH_FAILED',
      error:
        'Invalid RAZORPAY_KEY_ID format on server. Expected a valid Razorpay key starting with rzp_test_ or rzp_live_.',
    };
  }

  if (keySecret === keyId || /^rzp_(test|live)_/i.test(keySecret)) {
    return {
      ok: false,
      code: 'RAZORPAY_AUTH_FAILED',
      error:
        'RAZORPAY_KEY_SECRET appears to contain a Razorpay Key ID instead of the Key Secret. Set RAZORPAY_KEY_SECRET to the matching secret generated alongside RAZORPAY_KEY_ID.',
    };
  }

  return {
    ok: true,
    keyId,
    keySecret,
    mode: keyMatch[1] === 'live' ? 'live' : 'test',
  };
}

function extractRazorpayApiError(
  err: unknown,
  fallbackMessage: string
): { statusCode: number; description: string; isAuthFailure: boolean } {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const axiosResponse =
    errObj.response && typeof errObj.response === 'object'
      ? (errObj.response as Record<string, unknown>)
      : {};
  const statusCode =
    typeof errObj.statusCode === 'number'
      ? errObj.statusCode
      : typeof axiosResponse.status === 'number'
        ? axiosResponse.status
        : 500;
  const innerErr =
    errObj.error && typeof errObj.error === 'object'
      ? (errObj.error as Record<string, unknown>)
      : axiosResponse.data &&
          typeof axiosResponse.data === 'object' &&
          (axiosResponse.data as Record<string, unknown>).error &&
          typeof (axiosResponse.data as Record<string, unknown>).error === 'object'
        ? ((axiosResponse.data as Record<string, unknown>).error as Record<string, unknown>)
        : {};
  const description =
    typeof innerErr.description === 'string' && innerErr.description
      ? innerErr.description
      : err instanceof Error
        ? err.message
        : fallbackMessage;
  const isAuthFailure =
    statusCode === 401 || description.toLowerCase().includes('authentication failed');
  return { statusCode, description, isAuthFailure };
}

async function persistPendingCheckoutRecord(params: {
  record: PendingCheckoutRecord;
  store?: BoutiqueStore | null;
  strictPersistence: boolean;
  requestId?: string;
  bearerToken?: string | null;
}): Promise<void> {
  const { record, store, strictPersistence, requestId, bearerToken } = params;
  pendingCheckoutsMemory.set(record.razorpayOrderId, record);

  if (store) {
    try {
      await store.savePendingCheckout(toPendingCheckoutRow(record));
    } catch (err) {
      throw new StoreHttpError(
        503,
        'CHECKOUT_PERSISTENCE_FAILED',
        err instanceof Error
          ? err.message
          : 'Unable to save checkout state before opening payment.'
      );
    }
    return;
  }

  await savePendingCheckoutToFirestore(record, {
    strict: strictPersistence,
    requestId,
    bearerToken,
  });
}

async function loadPendingCheckoutRecord(
  razorpayOrderId: string,
  store?: BoutiqueStore | null,
  requestId?: string
): Promise<PendingCheckoutRecord | null> {
  const mem = pendingCheckoutsMemory.get(razorpayOrderId);
  if (mem) return mem;

  if (store) {
    const row = await store.getPendingCheckout(razorpayOrderId).catch(() => null);
    if (row) return fromPendingCheckoutRow(row);
  }

  return loadPendingCheckoutFromFirestore(razorpayOrderId, { requestId });
}

function computeCreateOrderPayloadHash(params: {
  currency: string;
  subtotalPaise: number;
  amountPaise: number;
  discountPaise: number;
  giftCardPaise: number;
  couponCode: string | null;
  giftCardCode: string | null;
  customerUserId: string | null;
  items: ValidatedOrderLine[];
}): string {
  const normalizedItems = [...params.items]
    .map((l) => `${l.productId}:${l.variantId}:${l.quantity}:${l.unitPricePaise}`)
    .sort();
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        currency: params.currency,
        subtotalPaise: params.subtotalPaise,
        amountPaise: params.amountPaise,
        discountPaise: params.discountPaise,
        giftCardPaise: params.giftCardPaise,
        couponCode: params.couponCode,
        giftCardCode: params.giftCardCode,
        customerUserId: params.customerUserId,
        items: normalizedItems,
      })
    )
    .digest('hex');
}

export async function handleCreateOrderRequest(params: {
  body: Record<string, unknown>;
  store?: BoutiqueStore | null;
  customerUserId?: string | null;
  customerIdToken?: string | null;
  razorpayClientFactory?: RazorpayClientFactory;
  requireDurablePersistence?: boolean;
  requestId?: string;
}): Promise<CheckoutHandlerResponse> {
  const {
    body,
    store = null,
    customerUserId = null,
    razorpayClientFactory,
    requireDurablePersistence,
    requestId,
  } = params;

  const creds = resolveRazorpayCredentials();
  if (!creds.ok) {
    return withSupportRef(
      401,
      {
        status: 401,
        code: creds.code,
        error: creds.error,
      },
      requestId
    );
  }
  const { keyId, keySecret, mode: keyMode } = creds;

  const currency =
    typeof body.currency === 'string' && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : 'INR';

  if (currency !== 'INR') {
    return withSupportRef(
      400,
      {
        status: 400,
        code: 'INVALID_CURRENCY',
        error: 'Only INR currency is supported for checkout.',
      },
      requestId
    );
  }

  let validatedLines: ValidatedOrderLine[] = [];
  let subtotalPaise = NaN;

  const hasItemsField = Array.isArray(body.items);
  if (hasItemsField) {
    const parsedLines = parseCartLines(body.items);
    try {
      const checked = await validateCartAgainstCatalog({ items: parsedLines, store });
      validatedLines = checked.lines;
      subtotalPaise = checked.totalPaise;
    } catch (err) {
      if (err instanceof StoreHttpError) {
        return withSupportRef(
          err.httpStatus,
          {
            status: err.httpStatus,
            code: err.code,
            error: err.message,
          },
          requestId
        );
      }
      throw err;
    }
  } else {
    const rawAmount = body.amount;
    subtotalPaise =
      typeof rawAmount === 'number' && Number.isFinite(rawAmount)
        ? Math.round(rawAmount)
        : typeof rawAmount === 'string' && rawAmount.trim() !== ''
          ? Math.round(Number(rawAmount))
          : NaN;
  }

  if (!Number.isInteger(subtotalPaise) || subtotalPaise < MIN_PRICE_PAISE) {
    return withSupportRef(
      400,
      {
        status: 400,
        code: 'INVALID_AMOUNT',
        error: 'Amount must be at least 100 paise (₹1.00).',
      },
      requestId
    );
  }

  const requestedCouponCode =
    typeof body.couponCode === 'string'
      ? body.couponCode
      : typeof body.coupon_code === 'string'
        ? body.coupon_code
        : null;
  const requestedGiftCardCode =
    typeof body.giftCardCode === 'string'
      ? body.giftCardCode
      : typeof body.gift_card_code === 'string'
        ? body.gift_card_code
        : null;

  let discountPaise = 0;
  let giftCardPaise = 0;
  let couponCode: string | null = null;
  let giftCardCode: string | null = null;
  let amountPaise = subtotalPaise;

  if (requestedCouponCode || requestedGiftCardCode) {
    try {
      const promoResult = await validatePromoAndGiftCardForBag({
        subtotalPaise,
        couponCode: requestedCouponCode,
        giftCardCode: requestedGiftCardCode,
        store,
        ensurePayableMinimum: true,
      });
      couponCode = promoResult.couponCode;
      discountPaise = promoResult.discountPaise;
      giftCardCode = promoResult.giftCardCode;
      giftCardPaise = promoResult.giftCardPaise;
      amountPaise = promoResult.finalAmountPaise;
    } catch (err) {
      if (err instanceof StoreHttpError) {
        return withSupportRef(
          err.httpStatus,
          {
            status: err.httpStatus,
            code: err.code,
            error: err.message,
          },
          requestId
        );
      }
      throw err;
    }
  }

  const rawIdempotencyKey =
    typeof body.idempotencyKey === 'string'
      ? body.idempotencyKey.trim()
      : typeof body.idempotency_key === 'string'
        ? body.idempotency_key.trim()
        : typeof body.checkoutAttemptId === 'string'
          ? body.checkoutAttemptId.trim()
          : '';
  if (rawIdempotencyKey && !/^[A-Za-z0-9_.:-]{6,120}$/.test(rawIdempotencyKey)) {
    return withSupportRef(
      400,
      {
        status: 400,
        code: 'INVALID_IDEMPOTENCY_KEY',
        error: 'Invalid checkout attempt reference.',
      },
      requestId
    );
  }
  const cleanIdempotencyKey = rawIdempotencyKey || null;
  const payloadHash = computeCreateOrderPayloadHash({
    currency,
    subtotalPaise,
    amountPaise,
    discountPaise,
    giftCardPaise,
    couponCode,
    giftCardCode,
    customerUserId,
    items: validatedLines,
  });

  const receipt =
    typeof body.receipt === 'string' && body.receipt.trim()
      ? body.receipt.trim().slice(0, 40)
      : `sc_rcpt_${Date.now()}`;

  const customer = parseCustomerDetails(body.customer || body.orderData);
  const strictPersistence = shouldRequireDurablePersistence({
    store,
    requireDurablePersistence,
  });

  // Resolve and validate server Firestore credential BEFORE creating a Razorpay order
  let precheckedServerBearer: string | null = null;
  if (!store && strictPersistence) {
    const ctx = getFirestoreContext();
    if (!ctx) {
      logCheckoutPersistenceFailure({
        operation: 'precheck_checkout_persistence',
        projectId: 'unknown',
        databaseId: 'unknown',
        namespace: resolveServerFirestoreNamespace(),
        path: 'pending_checkouts',
        status: 503,
        code: 'FIREBASE_CONFIG_MISSING',
        requestId,
        reason: 'firebase-applet-config.json is missing or invalid.',
      });
      return withSupportRef(
        503,
        {
          status: 503,
          code: 'CHECKOUT_PERSISTENCE_FAILED',
          error: 'Unable to initialize payment checkout right now. Please try again in a moment.',
        },
        requestId
      );
    }

    const tokenRes = await resolveFirestoreServerBearerToken({
      operation: 'precheck_checkout_persistence',
      requestId,
      ctx,
    });
    if (!tokenRes.ok) {
      logCheckoutPersistenceFailure({
        operation: 'precheck_checkout_persistence',
        projectId: ctx.projectId,
        databaseId: ctx.databaseId,
        namespace: ctx.namespace,
        path: `environments/${ctx.namespace}/pending_checkouts`,
        status: tokenRes.status,
        code: tokenRes.reasonCode,
        requestId,
        reason: tokenRes.detail,
      });
      return withSupportRef(
        503,
        {
          status: 503,
          code: 'CHECKOUT_PERSISTENCE_FAILED',
          error: 'Unable to initialize payment checkout right now. Please try again in a moment.',
        },
        requestId
      );
    }
    precheckedServerBearer = tokenRes.token;
  }

  // Deduplicate repeated create-order clicks/retries using idempotencyKey
  if (cleanIdempotencyKey) {
    const existingAttempt = await loadCreateOrderAttempt(cleanIdempotencyKey, {
      store,
      requestId,
    });
    if (existingAttempt) {
      if (existingAttempt.payloadHash !== payloadHash) {
        return withSupportRef(
          409,
          {
            status: 409,
            code: 'IDEMPOTENCY_CONFLICT',
            error: 'Your bag or promo selection changed. Please retry payment from the updated total.',
          },
          requestId
        );
      }

      const existingPending = await loadPendingCheckoutRecord(
        existingAttempt.razorpayOrderId,
        store,
        requestId
      );
      if (existingPending?.status === 'confirmed' && existingPending.confirmedOrder) {
        return withSupportRef(
          409,
          {
            status: 409,
            code: 'ORDER_ALREADY_CONFIRMED',
            error: 'Payment for this checkout attempt was already confirmed.',
            order: existingPending.confirmedOrder,
          },
          requestId
        );
      }
      if (
        existingPending &&
        existingPending.status === 'pending' &&
        existingPending.expiresAt > Date.now()
      ) {
        const nowReuse = Date.now();
        const reusedToken = createSignedCheckoutToken(
          {
            v: 1,
            oid: existingPending.razorpayOrderId,
            amt: existingPending.amountPaise,
            sub: existingPending.subtotalPaise,
            disc: existingPending.discountPaise,
            gc: existingPending.giftCardPaise,
            cpn: existingPending.couponCode,
            gcc: existingPending.giftCardCode,
            cur: existingPending.currency,
            uid: customerUserId,
            items: existingPending.items.map((l) => ({
              productId: l.productId,
              variantId: l.variantId,
              quantity: l.quantity,
              unitPricePaise: l.unitPricePaise,
            })),
            iat: nowReuse,
            exp: existingPending.expiresAt,
          },
          keySecret
        );
        return withSupportRef(
          200,
          {
            order_id: existingPending.razorpayOrderId,
            id: existingPending.razorpayOrderId,
            internal_order_ref: buildDeterministicOrderId(existingPending.razorpayOrderId),
            amount: existingPending.amountPaise,
            subtotal_paise: existingPending.subtotalPaise,
            discount_paise: existingPending.discountPaise,
            gift_card_paise: existingPending.giftCardPaise,
            coupon_code: existingPending.couponCode,
            gift_card_code: existingPending.giftCardCode,
            currency: existingPending.currency,
            receipt: existingPending.receipt,
            key_id: keyId,
            checkout_token: reusedToken,
            idempotent_reuse: true,
          },
          requestId
        );
      }
    }
  }

  try {
    const razorpay = (razorpayClientFactory || defaultRazorpayFactory)(keyId, keySecret);
    const notes: Record<string, string> = {};
    if (validatedLines.length > 0) {
      notes.items_count = String(validatedLines.length);
      notes.product_ids = validatedLines
        .map((l) => l.productId)
        .join(',')
        .slice(0, 200);
    }
    if (customerUserId) {
      notes.customer_user_id = customerUserId.slice(0, 120);
    }
    if (couponCode) notes.coupon_code = couponCode.slice(0, 40);
    if (giftCardCode) notes.gift_card_code = giftCardCode.slice(0, 40);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      ...(Object.keys(notes).length > 0 ? { notes } : {}),
    });

    const now = Date.now();
    const internalOrderRef = buildDeterministicOrderId(order.id);
    const pendingRecord: PendingCheckoutRecord = {
      razorpayOrderId: order.id,
      amountPaise: Number(order.amount || amountPaise),
      subtotalPaise,
      discountPaise,
      giftCardPaise,
      couponCode,
      giftCardCode,
      currency: String(order.currency || 'INR').toUpperCase(),
      receipt: String(order.receipt || receipt),
      items: validatedLines,
      customer,
      customerUserId,
      idempotencyKey: cleanIdempotencyKey,
      payloadHash,
      status: 'pending',
      createdAt: now,
      expiresAt: now + CHECKOUT_TOKEN_TTL_MS,
    };

    pruneMemoryCaches(now);
    try {
      await persistPendingCheckoutRecord({
        record: pendingRecord,
        store,
        strictPersistence,
        requestId,
        bearerToken: precheckedServerBearer,
      });
    } catch (persistErr) {
      pendingCheckoutsMemory.delete(order.id);
      if (persistErr instanceof StoreHttpError) {
        return withSupportRef(
          persistErr.httpStatus,
          {
            status: persistErr.httpStatus,
            code: persistErr.code,
            error: persistErr.message,
          },
          requestId
        );
      }
      return withSupportRef(
        503,
        {
          status: 503,
          code: 'CHECKOUT_PERSISTENCE_FAILED',
          error: 'Unable to initialize payment checkout right now. Please try again in a moment.',
        },
        requestId
      );
    }

    if (cleanIdempotencyKey) {
      await saveCreateOrderAttempt({
        idempotencyKey: cleanIdempotencyKey,
        payloadHash,
        razorpayOrderId: order.id,
        keyId,
        expiresAt: pendingRecord.expiresAt,
        store,
        requestId,
        bearerToken: precheckedServerBearer,
      });
    }

    const checkoutToken = createSignedCheckoutToken(
      {
        v: 1,
        oid: order.id,
        amt: pendingRecord.amountPaise,
        sub: subtotalPaise,
        disc: discountPaise,
        gc: giftCardPaise,
        cpn: couponCode,
        gcc: giftCardCode,
        cur: pendingRecord.currency,
        uid: customerUserId,
        items: validatedLines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          unitPricePaise: l.unitPricePaise,
        })),
        iat: now,
        exp: now + CHECKOUT_TOKEN_TTL_MS,
      },
      keySecret
    );

    return withSupportRef(
      200,
      {
        order_id: order.id,
        id: order.id,
        internal_order_ref: internalOrderRef,
        amount: pendingRecord.amountPaise,
        subtotal_paise: subtotalPaise,
        discount_paise: discountPaise,
        gift_card_paise: giftCardPaise,
        coupon_code: couponCode,
        gift_card_code: giftCardCode,
        currency: pendingRecord.currency,
        receipt: pendingRecord.receipt,
        key_id: keyId,
        checkout_token: checkoutToken,
      },
      requestId
    );
  } catch (err: unknown) {
    if (err instanceof StoreHttpError) {
      return withSupportRef(
        err.httpStatus,
        {
          status: err.httpStatus,
          code: err.code,
          error: err.message,
        },
        requestId
      );
    }

    const { description, isAuthFailure } = extractRazorpayApiError(
      err,
      'Failed to create Razorpay order.'
    );

    if (isAuthFailure) {
      const masked = maskRazorpayKeyId(keyId);
      return withSupportRef(
        401,
        {
          status: 401,
          code: 'RAZORPAY_AUTH_FAILED',
          keyMode,
          keyPrefix: masked,
          error: `Razorpay API authentication failed for ${keyMode} key "${masked}". Update RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your server / Vercel environment variables with an active matching key pair from Razorpay Dashboard → Account & Settings → API Keys.`,
        },
        requestId
      );
    }

    return withSupportRef(
      500,
      {
        status: 500,
        code: 'RAZORPAY_ORDER_FAILED',
        error: description,
      },
      requestId
    );
  }
}

async function finalizePaidRazorpayOrder(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  keyId: string;
  keySecret: string;
  keyMode: 'test' | 'live';
  store: BoutiqueStore | null;
  customerUserId: string | null;
  customerIdToken?: string | null;
  customerOverride?: OrderCustomerDetails | null;
  itemsOverride?: ValidatedOrderLine[] | null;
  expectedAmountOverride?: number | null;
  verifiedToken?: SignedCheckoutTokenPayload | null;
  razorpayClientFactory?: RazorpayClientFactory;
  fetchedPaymentPreloaded?: RazorpayPaymentEntity | null;
  source: 'verify' | 'webhook' | 'status' | 'recover';
  strictPersistence?: boolean;
  requestId?: string;
}): Promise<CheckoutHandlerResponse> {
  const {
    razorpayOrderId,
    razorpayPaymentId,
    keyId,
    keySecret,
    keyMode,
    store,
    verifiedToken = null,
    razorpayClientFactory,
    source,
    strictPersistence = false,
    requestId,
  } = params;

  const existingInFlight = inFlightVerifications.get(razorpayOrderId);
  if (existingInFlight) {
    return existingInFlight;
  }

  const runFinalization = async (): Promise<CheckoutHandlerResponse> => {
    const orderDocId = buildDeterministicOrderId(razorpayOrderId);

    // 1. Check in-memory / store / Firestore idempotency state first
    const memCompleted = completedCheckoutsMemory.get(razorpayOrderId);
    if (memCompleted?.order) {
      return {
        status: 200,
        body: {
          ...memCompleted.responseBody,
          already_processed: true,
        },
      };
    }

    if (store) {
      const existingOrder = await store.getOrderById(orderDocId).catch(() => null);
      if (existingOrder) {
        const serialized: SerializedOrderReceipt = {
          id: existingOrder.order.id,
          orderNumber: existingOrder.order.order_number,
          customerUserId: existingOrder.order.customer_user_id,
          status: existingOrder.order.status,
          paymentStatus: existingOrder.order.payment_status || 'paid',
          fulfillmentStatus:
            existingOrder.order.fulfillment_status || existingOrder.order.status,
          subtotalPaise: existingOrder.order.subtotal_paise,
          discountPaise: existingOrder.order.discount_paise || 0,
          giftCardPaise: existingOrder.order.gift_card_paise || 0,
          couponCode: existingOrder.order.coupon_code || null,
          giftCardCode: existingOrder.order.gift_card_code || null,
          totalPaise: existingOrder.order.total_paise,
          currency: existingOrder.order.currency,
          createdAt: existingOrder.order.created_at,
          paymentMethod: 'razorpay',
          razorpayOrderId:
            existingOrder.order.razorpay_order_id || razorpayOrderId,
          razorpayPaymentId:
            existingOrder.order.razorpay_payment_id || razorpayPaymentId,
          statusHistory: parseStatusHistorySafe(existingOrder.order.status_history_json),
          items: existingOrder.items.map((l) => ({
            productId: l.product_id,
            variantId: l.variant_id,
            productTitle: l.product_title,
            variantLabel: l.variant_label,
            sku: l.sku,
            unitPricePaise: l.unit_price_paise,
            quantity: l.quantity,
            lineTotalPaise: l.line_total_paise,
          })),
        };
        const responseBody: Record<string, unknown> = {
          success: true,
          verified: true,
          already_processed: true,
          order_id: razorpayOrderId,
          payment_id: serialized.razorpayPaymentId || razorpayPaymentId,
          message: 'Payment already verified and order confirmed.',
          order: serialized,
        };
        completedCheckoutsMemory.set(razorpayOrderId, {
          paymentId: serialized.razorpayPaymentId || razorpayPaymentId,
          order: serialized,
          responseBody,
        });
        return { status: 200, body: responseBody };
      }
    }

    let pendingRecord = await loadPendingCheckoutRecord(razorpayOrderId, store, requestId);

    if (pendingRecord?.status === 'confirmed' && pendingRecord.confirmedOrder) {
      const responseBody: Record<string, unknown> = {
        success: true,
        verified: true,
        already_processed: true,
        order_id: razorpayOrderId,
        payment_id: pendingRecord.razorpayPaymentId || razorpayPaymentId,
        message: 'Payment already verified and order confirmed.',
        order: pendingRecord.confirmedOrder,
      };
      completedCheckoutsMemory.set(razorpayOrderId, {
        paymentId: pendingRecord.razorpayPaymentId || razorpayPaymentId,
        order: pendingRecord.confirmedOrder,
        responseBody,
      });
      return { status: 200, body: responseBody };
    }

    if (!store) {
      const existingFsOrder = await fetchExistingFirestoreOrder(
        orderDocId,
        razorpayOrderId,
        razorpayPaymentId,
        { requestId }
      );
      if (existingFsOrder) {
        const responseBody: Record<string, unknown> = {
          success: true,
          verified: true,
          already_processed: true,
          order_id: razorpayOrderId,
          payment_id: existingFsOrder.razorpayPaymentId || razorpayPaymentId,
          message: 'Payment already verified and order confirmed.',
          order: existingFsOrder,
        };
        completedCheckoutsMemory.set(razorpayOrderId, {
          paymentId: existingFsOrder.razorpayPaymentId || razorpayPaymentId,
          order: existingFsOrder,
          responseBody,
        });
        return { status: 200, body: responseBody };
      }
    }

    const expectedAmountPaise =
      pendingRecord?.amountPaise ??
      verifiedToken?.amt ??
      params.expectedAmountOverride ??
      null;

    // 2. Verify payment & order status server-side against Razorpay API
    let fetchedPayment: RazorpayPaymentEntity;
    let fetchedOrder: RazorpayOrderEntity | null = null;
    try {
      const razorpay = (razorpayClientFactory || defaultRazorpayFactory)(keyId, keySecret);
      fetchedPayment =
        params.fetchedPaymentPreloaded ||
        (await withTransientRetry(() => razorpay.payments.fetch(razorpayPaymentId)));

      if (fetchedPayment.order_id && fetchedPayment.order_id !== razorpayOrderId) {
        return withSupportRef(
          400,
          {
            status: 400,
            success: false,
            verified: false,
            code: 'PAYMENT_ORDER_MISMATCH',
            error: 'Razorpay payment does not belong to this order.',
          },
          requestId
        );
      }

      if (
        expectedAmountPaise !== null &&
        Math.round(Number(fetchedPayment.amount)) !== expectedAmountPaise
      ) {
        return withSupportRef(
          400,
          {
            status: 400,
            success: false,
            verified: false,
            code: 'AMOUNT_MISMATCH',
            error: 'Paid amount does not match the expected order amount.',
          },
          requestId
        );
      }

      const paidCurrency = String(fetchedPayment.currency || '').toUpperCase();
      if (paidCurrency !== 'INR') {
        return withSupportRef(
          400,
          {
            status: 400,
            success: false,
            verified: false,
            code: 'CURRENCY_MISMATCH',
            error: `Unexpected payment currency (${paidCurrency || 'unknown'}). Expected INR.`,
          },
          requestId
        );
      }

      const verifyAmountForCapture =
        expectedAmountPaise ?? Math.round(Number(fetchedPayment.amount));

      fetchedOrder = await withTransientRetry(() => razorpay.orders.fetch(razorpayOrderId)).catch(
        () => null
      );
      if (
        fetchedOrder &&
        expectedAmountPaise !== null &&
        Math.round(Number(fetchedOrder.amount)) !== expectedAmountPaise
      ) {
        return withSupportRef(
          400,
          {
            status: 400,
            success: false,
            verified: false,
            code: 'AMOUNT_MISMATCH',
            error: 'Razorpay order amount does not match the checkout total.',
          },
          requestId
        );
      }

      if (fetchedPayment.status === 'authorized' && !fetchedPayment.captured) {
        fetchedPayment = await razorpay.payments.capture(
          razorpayPaymentId,
          verifyAmountForCapture,
          'INR'
        );
      }

      const isCaptured =
        fetchedPayment.status === 'captured' || fetchedPayment.captured === true;
      if (!isCaptured) {
        const payStatus = String(fetchedPayment.status || 'unknown').toLowerCase();
        if (payStatus === 'authorized' || payStatus === 'created' || payStatus === 'pending') {
          if (pendingRecord) {
            pendingRecord = {
              ...pendingRecord,
              status: 'payment_received_pending_confirm',
              razorpayPaymentId,
            };
            pendingCheckoutsMemory.set(razorpayOrderId, pendingRecord);
            await persistPendingCheckoutRecord({
              record: pendingRecord,
              store,
              strictPersistence: false,
              requestId,
            }).catch(() => {});
          }
          return withSupportRef(
            202,
            {
              status: 202,
              success: true,
              verified: true,
              paid: false,
              pending_confirmation: true,
              payment_status: payStatus,
              code: 'PAYMENT_PENDING_CAPTURE',
              order_id: razorpayOrderId,
              internal_order_ref: orderDocId,
              payment_id: razorpayPaymentId,
              message:
                'Your payment is authorized and awaiting capture confirmation. Check status before retrying payment.',
            },
            requestId
          );
        }

        return withSupportRef(
          400,
          {
            status: 400,
            success: false,
            verified: false,
            code: 'PAYMENT_NOT_CAPTURED',
            error: `Payment is not captured (status: ${fetchedPayment.status || 'unknown'}).`,
          },
          requestId
        );
      }
    } catch (rzpErr: unknown) {
      const { description, isAuthFailure } = extractRazorpayApiError(
        rzpErr,
        'Unable to verify payment status with Razorpay.'
      );
      if (isAuthFailure) {
        const masked = maskRazorpayKeyId(keyId);
        return {
          status: 401,
          body: {
            status: 401,
            success: false,
            verified: false,
            code: 'RAZORPAY_AUTH_FAILED',
            keyMode,
            keyPrefix: masked,
            error: `Razorpay API authentication failed for ${keyMode} key "${masked}" while verifying payment. Ensure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET match your active Razorpay key pair.`,
          },
        };
      }
      return {
        status: 400,
        body: {
          status: 400,
          success: false,
          verified: false,
          code: 'RAZORPAY_PAYMENT_VERIFY_FAILED',
          error: description,
        },
      };
    }

    const finalLines = params.itemsOverride || pendingRecord?.items || [];
    const effectiveCustomer = params.customerOverride || pendingRecord?.customer || null;
    const effectiveUid =
      params.customerUserId ||
      pendingRecord?.customerUserId ||
      verifiedToken?.uid ||
      (typeof fetchedOrder?.notes?.customer_user_id === 'string' && fetchedOrder.notes.customer_user_id
        ? fetchedOrder.notes.customer_user_id
        : null) ||
      null;

    const finalTotalPaise =
      expectedAmountPaise ?? Math.round(Number(fetchedPayment.amount));
    const finalSubtotalPaise =
      pendingRecord?.subtotalPaise ??
      verifiedToken?.sub ??
      (finalLines.length > 0
        ? finalLines.reduce((sum, l) => sum + l.lineTotalPaise, 0)
        : finalTotalPaise);
    const finalDiscountPaise =
      pendingRecord?.discountPaise ?? verifiedToken?.disc ?? 0;
    const finalGiftCardPaise =
      pendingRecord?.giftCardPaise ?? verifiedToken?.gc ?? 0;
    const finalCouponCode =
      pendingRecord?.couponCode ?? verifiedToken?.cpn ?? null;
    const finalGiftCardCode =
      pendingRecord?.giftCardCode ?? verifiedToken?.gcc ?? null;

    if (effectiveCustomer && finalLines.length > 0) {
      try {
        let confirmedReceipt: SerializedOrderReceipt;

        if (store) {
          const suffix = crypto
            .createHash('sha256')
            .update(razorpayOrderId)
            .digest('hex')
            .slice(0, 6)
            .toUpperCase();
          const placeInput: PlaceOrderInput = {
            id: orderDocId,
            orderNumber: `SC-${suffix}`,
            customerUserId: effectiveUid,
            customerName: effectiveCustomer.customerName,
            customerEmail: effectiveCustomer.customerEmail,
            customerPhone: effectiveCustomer.customerPhone,
            shippingAddress: effectiveCustomer.shippingAddress,
            status: 'confirmed',
            paymentStatus: 'paid',
            fulfillmentStatus: 'confirmed',
            paymentMethod: 'razorpay',
            razorpayOrderId,
            razorpayPaymentId,
            couponCode: finalCouponCode,
            giftCardCode: finalGiftCardCode,
            discountPaise: finalDiscountPaise,
            giftCardPaise: finalGiftCardPaise,
            statusHistory: [
              {
                status: 'confirmed',
                note:
                  source === 'webhook'
                    ? 'Confirmed automatically via Razorpay webhook'
                    : source === 'recover'
                      ? 'Recovered from captured Razorpay payment'
                      : 'Payment verified via Razorpay',
                actor: 'system',
                at: Date.now(),
              },
            ],
            items: finalLines.map((l) => ({
              productId: l.productId,
              variantId: l.variantId,
              quantity: l.quantity,
              expectedPricePaise: l.unitPricePaise,
            })),
          };
          const { order, items } = await store.placeOrder(placeInput);
          confirmedReceipt = {
            id: order.id,
            orderNumber: order.order_number,
            customerUserId: order.customer_user_id,
            status: order.status,
            paymentStatus: order.payment_status || 'paid',
            fulfillmentStatus: order.fulfillment_status || 'confirmed',
            subtotalPaise: order.subtotal_paise,
            discountPaise: order.discount_paise || 0,
            giftCardPaise: order.gift_card_paise || 0,
            couponCode: order.coupon_code || null,
            giftCardCode: order.gift_card_code || null,
            totalPaise: order.total_paise,
            currency: order.currency,
            createdAt: order.created_at,
            paymentMethod: 'razorpay',
            razorpayOrderId: order.razorpay_order_id || razorpayOrderId,
            razorpayPaymentId: order.razorpay_payment_id || razorpayPaymentId,
            statusHistory: parseStatusHistorySafe(order.status_history_json),
            items: items.map((l) => ({
              productId: l.product_id,
              variantId: l.variant_id,
              productTitle: l.product_title,
              variantLabel: l.variant_label,
              sku: l.sku,
              unitPricePaise: l.unit_price_paise,
              quantity: l.quantity,
              lineTotalPaise: l.line_total_paise,
            })),
          };
        } else {
          confirmedReceipt = await persistConfirmedOrderToFirestoreOnce({
            razorpayOrderId,
            razorpayPaymentId,
            customerUserId: effectiveUid,
            customer: effectiveCustomer,
            lines: finalLines,
            subtotalPaise: finalSubtotalPaise,
            discountPaise: finalDiscountPaise,
            giftCardPaise: finalGiftCardPaise,
            couponCode: finalCouponCode,
            giftCardCode: finalGiftCardCode,
            totalPaise: finalTotalPaise,
            strictPersistence,
            requestId,
          });
        }

        if (pendingRecord) {
          pendingRecord = {
            ...pendingRecord,
            customerUserId: effectiveUid,
            status: 'confirmed',
            razorpayPaymentId,
            confirmedOrder: confirmedReceipt,
          };
          pendingCheckoutsMemory.set(razorpayOrderId, pendingRecord);
          await persistPendingCheckoutRecord({
            record: pendingRecord,
            store,
            strictPersistence: false,
            requestId,
          }).catch(() => {});
        }

        const responseBody: Record<string, unknown> = {
          success: true,
          verified: true,
          order_id: razorpayOrderId,
          internal_order_ref: orderDocId,
          payment_id: razorpayPaymentId,
          message: 'Payment verified and order confirmed.',
          order: confirmedReceipt,
          ...(requestId ? { support_reference: requestId } : {}),
        };
        completedCheckoutsMemory.set(razorpayOrderId, {
          paymentId: razorpayPaymentId,
          order: confirmedReceipt,
          responseBody,
        });

        return { status: 200, body: responseBody };
      } catch (persistErr) {
        const ctx = getFirestoreContext();
        logCheckoutPersistenceFailure({
          operation: 'finalize_paid_order',
          projectId: ctx?.projectId || 'unknown',
          databaseId: ctx?.databaseId || 'unknown',
          namespace: ctx?.namespace || resolveServerFirestoreNamespace(),
          path: `orders/${orderDocId}`,
          status: 202,
          code: 'ORDER_CONFIRMATION_PENDING',
          requestId,
          reason:
            persistErr instanceof Error
              ? persistErr.message
              : 'Deferred order confirmation after payment capture.',
        });

        // Payment WAS verified and captured, but saving the order to the DB failed/delayed.
        // Return 202 pending confirmation so client does NOT charge again or lose reference.
        if (pendingRecord) {
          pendingRecord = {
            ...pendingRecord,
            customerUserId: effectiveUid,
            status: 'payment_received_pending_confirm',
            razorpayPaymentId,
          };
          pendingCheckoutsMemory.set(razorpayOrderId, pendingRecord);
          await persistPendingCheckoutRecord({
            record: pendingRecord,
            store,
            strictPersistence: false,
            requestId,
          }).catch(() => {});
        }

        return withSupportRef(
          202,
          {
            status: 202,
            success: true,
            verified: true,
            pending_confirmation: true,
            code: 'ORDER_CONFIRMATION_PENDING',
            order_id: razorpayOrderId,
            internal_order_ref: orderDocId,
            payment_id: razorpayPaymentId,
            message: 'Payment received. We’re confirming your order',
            error:
              persistErr instanceof StoreHttpError
                ? persistErr.message
                : 'Order confirmation is delayed and will complete shortly.',
          },
          requestId
        );
      }
    }

    // Payment captured/verified without order item lines (legacy standalone payment check)
    const responseBody: Record<string, unknown> = {
      success: true,
      verified: true,
      order_id: razorpayOrderId,
      internal_order_ref: orderDocId,
      payment_id: razorpayPaymentId,
      message: 'Payment verified successfully.',
      ...(requestId ? { support_reference: requestId } : {}),
    };
    completedCheckoutsMemory.set(razorpayOrderId, {
      paymentId: razorpayPaymentId,
      responseBody,
    });
    return { status: 200, body: responseBody };
  };

  const promise = runFinalization().finally(() => {
    inFlightVerifications.delete(razorpayOrderId);
  });
  inFlightVerifications.set(razorpayOrderId, promise);
  return promise;
}

export async function handleVerifyPaymentRequest(params: {
  body: Record<string, unknown>;
  store?: BoutiqueStore | null;
  customerUserId?: string | null;
  customerIdToken?: string | null;
  razorpayClientFactory?: RazorpayClientFactory;
  strictPersistence?: boolean;
  requestId?: string;
}): Promise<CheckoutHandlerResponse> {
  const {
    body,
    store = null,
    customerUserId = null,
    customerIdToken = null,
    razorpayClientFactory,
    requestId,
  } = params;
  const strictPersistence = shouldRequireDurablePersistence({
    store,
    requireDurablePersistence: params.strictPersistence,
  });

  const razorpayOrderId =
    typeof body.razorpay_order_id === 'string'
      ? body.razorpay_order_id.trim()
      : typeof body.order_id === 'string'
        ? body.order_id.trim()
        : '';
  const razorpayPaymentId =
    typeof body.razorpay_payment_id === 'string'
      ? body.razorpay_payment_id.trim()
      : typeof body.payment_id === 'string'
        ? body.payment_id.trim()
        : '';
  const razorpaySignature =
    typeof body.razorpay_signature === 'string'
      ? body.razorpay_signature.trim()
      : typeof body.signature === 'string'
        ? body.signature.trim()
        : '';
  const checkoutToken =
    typeof body.checkout_token === 'string' ? body.checkout_token.trim() : '';
  const expectedOrderIdParam =
    typeof body.expected_order_id === 'string' ? body.expected_order_id.trim() : '';

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return {
      status: 400,
      body: {
        status: 400,
        success: false,
        verified: false,
        code: 'MISSING_FIELDS',
        error:
          'Missing required payment verification fields (razorpay_order_id, razorpay_payment_id, razorpay_signature).',
      },
    };
  }

  const creds = resolveRazorpayCredentials();
  if (!creds.ok) {
    return {
      status: 401,
      body: {
        status: 401,
        success: false,
        verified: false,
        code: creds.code,
        error: creds.error,
      },
    };
  }
  const { keyId, keySecret, mode: keyMode } = creds;

  if (expectedOrderIdParam && expectedOrderIdParam !== razorpayOrderId) {
    return {
      status: 400,
      body: {
        status: 400,
        success: false,
        verified: false,
        code: 'ORDER_MISMATCH',
        error: 'Payment order ID does not match the stored checkout order.',
      },
    };
  }

  let verifiedToken: SignedCheckoutTokenPayload | null = null;
  if (checkoutToken) {
    verifiedToken = verifySignedCheckoutToken(checkoutToken, keySecret);
    if (!verifiedToken || verifiedToken.oid !== razorpayOrderId) {
      return {
        status: 400,
        body: {
          status: 400,
          success: false,
          verified: false,
          code: 'ORDER_MISMATCH',
          error: 'Checkout session does not match the Razorpay order ID.',
        },
      };
    }
  }

  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const actualBuf = Buffer.from(razorpaySignature, 'utf8');
  const isValidSignature =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

  if (!isValidSignature) {
    return {
      status: 400,
      body: {
        status: 400,
        success: false,
        verified: false,
        code: 'INVALID_SIGNATURE',
        error: 'Invalid payment signature. Payment could not be verified.',
      },
    };
  }

  const rawOrderData =
    body.orderData && typeof body.orderData === 'object'
      ? (body.orderData as Record<string, unknown>)
      : null;
  const customerFromOrderData = parseCustomerDetails(rawOrderData);
  const parsedOrderItems =
    rawOrderData && Array.isArray(rawOrderData.items)
      ? parseCartLines(rawOrderData.items)
      : [];

  let catalogValidatedForOrder: { lines: ValidatedOrderLine[]; totalPaise: number } | null = null;
  if (parsedOrderItems.length > 0) {
    try {
      catalogValidatedForOrder = await validateCartAgainstCatalog({
        items: parsedOrderItems,
        store,
      });
    } catch (err) {
      if (err instanceof StoreHttpError) {
        return {
          status: err.httpStatus,
          body: {
            status: err.httpStatus,
            success: false,
            verified: false,
            code: err.code,
            error: err.message,
          },
        };
      }
      throw err;
    }
  }

  const pendingRecord = await loadPendingCheckoutRecord(razorpayOrderId, store, requestId);
  const expectedAmount =
    pendingRecord?.amountPaise ?? verifiedToken?.amt ?? null;
  const effectiveSubtotal = catalogValidatedForOrder?.totalPaise ?? null;
  if (
    pendingRecord &&
    effectiveSubtotal !== null &&
    pendingRecord.subtotalPaise !== effectiveSubtotal
  ) {
    return {
      status: 400,
      body: {
        status: 400,
        success: false,
        verified: false,
        code: 'AMOUNT_MISMATCH',
        error: 'Order items total does not match the authorized Razorpay order amount.',
      },
    };
  }

  return finalizePaidRazorpayOrder({
    razorpayOrderId,
    razorpayPaymentId,
    keyId,
    keySecret,
    keyMode,
    store,
    customerUserId,
    customerIdToken,
    customerOverride: customerFromOrderData,
    itemsOverride: catalogValidatedForOrder?.lines || null,
    expectedAmountOverride: expectedAmount ?? effectiveSubtotal,
    verifiedToken,
    razorpayClientFactory,
    source: 'verify',
    strictPersistence,
    requestId,
  });
}

export async function handleRazorpayWebhookRequest(params: {
  rawBody: string;
  signatureHeader: string | string[] | undefined;
  eventIdHeader?: string | string[] | undefined;
  store?: BoutiqueStore | null;
  razorpayClientFactory?: RazorpayClientFactory;
  requestId?: string;
}): Promise<CheckoutHandlerResponse> {
  const {
    rawBody,
    signatureHeader,
    eventIdHeader,
    store = null,
    razorpayClientFactory,
    requestId,
  } = params;
  const sig = (Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader || '').trim();
  const explicitEventId = (
    Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader || ''
  ).trim();
  const webhookSecret = sanitizeEnvCredential(process.env.RAZORPAY_WEBHOOK_SECRET);

  if (!webhookSecret) {
    return withSupportRef(
      503,
      {
        status: 503,
        code: 'WEBHOOK_NOT_CONFIGURED',
        error: 'RAZORPAY_WEBHOOK_SECRET is not configured on the server.',
      },
      requestId
    );
  }

  if (!sig) {
    return withSupportRef(
      401,
      {
        status: 401,
        code: 'MISSING_WEBHOOK_SIGNATURE',
        error: 'Missing X-Razorpay-Signature header.',
      },
      requestId
    );
  }

  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf = Buffer.from(sig, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return withSupportRef(
      401,
      {
        status: 401,
        code: 'INVALID_WEBHOOK_SIGNATURE',
        error: 'Webhook signature verification failed.',
      },
      requestId
    );
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return withSupportRef(
      400,
      { status: 400, code: 'INVALID_JSON', error: 'Invalid webhook payload.' },
      requestId
    );
  }

  const eventType = typeof event.event === 'string' ? event.event : '';
  if (
    eventType !== 'payment.captured' &&
    eventType !== 'order.paid' &&
    eventType !== 'payment.failed'
  ) {
    return withSupportRef(
      200,
      { received: true, ignored: true, event: eventType },
      requestId
    );
  }

  if (explicitEventId) {
    const seen = await loadWebhookEventProcessed(explicitEventId, { store, requestId });
    if (seen) {
      return withSupportRef(
        200,
        {
          received: true,
          duplicate_event: true,
          already_processed: true,
          event: seen.eventType,
          event_id: explicitEventId,
          ...(seen.orderId ? { order_id: seen.orderId } : {}),
          ...(seen.order ? { order: seen.order } : {}),
        },
        requestId
      );
    }
  }

  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  const paymentWrapper =
    payload.payment && typeof payload.payment === 'object'
      ? (payload.payment as Record<string, unknown>)
      : {};
  const paymentEntity =
    paymentWrapper.entity && typeof paymentWrapper.entity === 'object'
      ? (paymentWrapper.entity as RazorpayPaymentEntity)
      : null;
  const orderWrapper =
    payload.order && typeof payload.order === 'object'
      ? (payload.order as Record<string, unknown>)
      : {};
  const orderEntity =
    orderWrapper.entity && typeof orderWrapper.entity === 'object'
      ? (orderWrapper.entity as RazorpayOrderEntity)
      : null;

  const razorpayOrderId =
    (typeof paymentEntity?.order_id === 'string' && paymentEntity.order_id.trim()) ||
    (typeof orderEntity?.id === 'string' && orderEntity.id.trim()) ||
    '';
  const razorpayPaymentId =
    typeof paymentEntity?.id === 'string' ? paymentEntity.id.trim() : '';

  if (eventType === 'payment.failed') {
    if (!razorpayOrderId) {
      return withSupportRef(
        400,
        {
          status: 400,
          code: 'MISSING_FIELDS',
          error: 'Webhook payment.failed payload missing order_id.',
        },
        requestId
      );
    }

    const orderDocId = buildDeterministicOrderId(razorpayOrderId);
    const memDone = completedCheckoutsMemory.get(razorpayOrderId)?.order;
    const storeDone = store
      ? await store
          .getOrderById(orderDocId)
          .then((res) => (res ? res.order : null))
          .catch(() => null)
      : null;
    const pending = await loadPendingCheckoutRecord(razorpayOrderId, store, requestId);
    const fsDone =
      !store && !memDone && pending?.status !== 'confirmed'
        ? await fetchExistingFirestoreOrder(orderDocId, razorpayOrderId, razorpayPaymentId, {
            requestId,
          })
        : null;

    if (memDone || storeDone || pending?.status === 'confirmed' || fsDone) {
      // Out-of-order guard: NEVER let payment.failed overwrite an already-paid/confirmed order.
      if (explicitEventId) {
        await saveWebhookEventProcessed({
          eventId: explicitEventId,
          eventType,
          orderId: razorpayOrderId,
          order: memDone || pending?.confirmedOrder || fsDone || undefined,
          store,
          requestId,
        });
      }
      return withSupportRef(
        200,
        {
          received: true,
          ignored_out_of_order: true,
          already_processed: true,
          event: eventType,
          order_id: razorpayOrderId,
          internal_order_ref: orderDocId,
          ...(memDone || pending?.confirmedOrder || fsDone
            ? { order: memDone || pending?.confirmedOrder || fsDone }
            : {}),
        },
        requestId
      );
    }

    const failureReason =
      (typeof paymentEntity?.error_description === 'string' &&
        paymentEntity.error_description.trim()) ||
      (typeof paymentEntity?.error_reason === 'string' && paymentEntity.error_reason.trim()) ||
      'Payment failed at the payment gateway.';

    if (pending) {
      const updatedPending: PendingCheckoutRecord = {
        ...pending,
        status: 'failed',
        razorpayPaymentId: razorpayPaymentId || pending.razorpayPaymentId,
        failureReason,
      };
      pendingCheckoutsMemory.set(razorpayOrderId, updatedPending);
      await persistPendingCheckoutRecord({
        record: updatedPending,
        store,
        strictPersistence: false,
        requestId,
      }).catch(() => {});
    }

    if (explicitEventId) {
      await saveWebhookEventProcessed({
        eventId: explicitEventId,
        eventType,
        orderId: razorpayOrderId,
        store,
        requestId,
      });
    }

    return withSupportRef(
      200,
      {
        received: true,
        handled: true,
        event: eventType,
        status: 'failed',
        order_id: razorpayOrderId,
        internal_order_ref: orderDocId,
        payment_id: razorpayPaymentId || null,
        failure_reason: failureReason,
      },
      requestId
    );
  }

  if (!razorpayOrderId || !razorpayPaymentId) {
    return withSupportRef(
      400,
      {
        status: 400,
        code: 'MISSING_FIELDS',
        error: 'Webhook payload missing payment.entity.id or order_id.',
      },
      requestId
    );
  }

  const creds = resolveRazorpayCredentials();
  if (!creds.ok) {
    return withSupportRef(
      401,
      { status: 401, code: creds.code, error: creds.error },
      requestId
    );
  }

  const finalResult = await finalizePaidRazorpayOrder({
    razorpayOrderId,
    razorpayPaymentId,
    keyId: creds.keyId,
    keySecret: creds.keySecret,
    keyMode: creds.mode,
    store,
    customerUserId: null,
    razorpayClientFactory,
    source: 'webhook',
    strictPersistence: shouldRequireDurablePersistence({ store }),
    requestId,
  });

  if (explicitEventId && finalResult.status === 200) {
    await saveWebhookEventProcessed({
      eventId: explicitEventId,
      eventType,
      orderId: razorpayOrderId,
      order: finalResult.body.order as SerializedOrderReceipt | undefined,
      store,
      requestId,
    });
  }

  return finalResult;
}

export async function handleOrderStatusRequest(params: {
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  store?: BoutiqueStore | null;
  customerUserId?: string | null;
  customerIdToken?: string | null;
  razorpayClientFactory?: RazorpayClientFactory;
  requestId?: string;
}): Promise<CheckoutHandlerResponse> {
  const {
    razorpayOrderId,
    razorpayPaymentId,
    store = null,
    customerUserId = null,
    customerIdToken = null,
    razorpayClientFactory,
    requestId,
  } = params;

  const cleanOid = razorpayOrderId.trim();
  if (!cleanOid) {
    return withSupportRef(
      400,
      { status: 400, code: 'MISSING_ORDER_ID', error: 'razorpay_order_id is required.' },
      requestId
    );
  }

  const orderDocId = buildDeterministicOrderId(cleanOid);
  if (store) {
    const existing = await store.getOrderById(orderDocId).catch(() => null);
    if (existing) {
      if (
        existing.order.customer_user_id &&
        customerUserId &&
        existing.order.customer_user_id !== customerUserId
      ) {
        return withSupportRef(
          403,
          { status: 403, code: 'FORBIDDEN', error: 'Access denied for this order.' },
          requestId
        );
      }
      return withSupportRef(
        200,
        {
          confirmed: true,
          pending_confirmation: false,
          failed: false,
          status: 'confirmed',
          order_id: cleanOid,
          internal_order_ref: orderDocId,
          payment_id: existing.order.razorpay_payment_id || razorpayPaymentId || null,
          order: {
            id: existing.order.id,
            orderNumber: existing.order.order_number,
            customerUserId: existing.order.customer_user_id,
            status: existing.order.status,
            paymentStatus: existing.order.payment_status || 'paid',
            fulfillmentStatus: existing.order.fulfillment_status || existing.order.status,
            subtotalPaise: existing.order.subtotal_paise,
            discountPaise: existing.order.discount_paise || 0,
            giftCardPaise: existing.order.gift_card_paise || 0,
            couponCode: existing.order.coupon_code || null,
            giftCardCode: existing.order.gift_card_code || null,
            totalPaise: existing.order.total_paise,
            currency: existing.order.currency,
            createdAt: existing.order.created_at,
            paymentMethod: 'razorpay',
            razorpayOrderId: cleanOid,
            razorpayPaymentId: existing.order.razorpay_payment_id || razorpayPaymentId || '',
            statusHistory: parseStatusHistorySafe(existing.order.status_history_json),
            items: existing.items.map((l) => ({
              productId: l.product_id,
              variantId: l.variant_id,
              productTitle: l.product_title,
              variantLabel: l.variant_label,
              sku: l.sku,
              unitPricePaise: l.unit_price_paise,
              quantity: l.quantity,
              lineTotalPaise: l.line_total_paise,
            })),
          },
        },
        requestId
      );
    }
  } else {
    const existingFs = await fetchExistingFirestoreOrder(
      orderDocId,
      cleanOid,
      razorpayPaymentId || '',
      { requestId }
    );
    if (existingFs) {
      return withSupportRef(
        200,
        {
          confirmed: true,
          pending_confirmation: false,
          failed: false,
          status: 'confirmed',
          order_id: cleanOid,
          internal_order_ref: orderDocId,
          payment_id: existingFs.razorpayPaymentId || razorpayPaymentId || null,
          order: existingFs,
        },
        requestId
      );
    }
  }

  const pendingRecord = await loadPendingCheckoutRecord(cleanOid, store, requestId);
  if (pendingRecord?.status === 'failed') {
    return withSupportRef(
      200,
      {
        confirmed: false,
        pending_confirmation: false,
        failed: true,
        status: 'failed',
        order_id: cleanOid,
        internal_order_ref: orderDocId,
        payment_id: razorpayPaymentId?.trim() || pendingRecord.razorpayPaymentId || null,
        failure_reason: pendingRecord.failureReason || 'Payment failed.',
        message:
          pendingRecord.failureReason ||
          'Your previous payment attempt failed. You can retry checkout safely.',
      },
      requestId
    );
  }

  const pid = razorpayPaymentId?.trim() || pendingRecord?.razorpayPaymentId || '';
  if (!pid) {
    return withSupportRef(
      200,
      {
        confirmed: false,
        pending_confirmation: pendingRecord?.status === 'payment_received_pending_confirm',
        failed: false,
        order_id: cleanOid,
        internal_order_ref: orderDocId,
        status: pendingRecord?.status || 'pending',
      },
      requestId
    );
  }

  const creds = resolveRazorpayCredentials();
  if (!creds.ok) {
    return withSupportRef(
      202,
      {
        confirmed: false,
        pending_confirmation: true,
        failed: false,
        order_id: cleanOid,
        internal_order_ref: orderDocId,
        payment_id: pid,
        message: 'Payment received. We’re confirming your order',
      },
      requestId
    );
  }

  const finalRes = await finalizePaidRazorpayOrder({
    razorpayOrderId: cleanOid,
    razorpayPaymentId: pid,
    keyId: creds.keyId,
    keySecret: creds.keySecret,
    keyMode: creds.mode,
    store,
    customerUserId,
    customerIdToken,
    razorpayClientFactory,
    source: 'status',
    strictPersistence: shouldRequireDurablePersistence({ store }),
    requestId,
  });

  if (finalRes.status === 200 && finalRes.body.order) {
    return withSupportRef(
      200,
      {
        confirmed: true,
        pending_confirmation: false,
        failed: false,
        ...finalRes.body,
      },
      requestId
    );
  }
  return withSupportRef(finalRes.status, finalRes.body, requestId);
}

export async function handleRecoverRazorpayOrder(params: {
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  customerFallback?: OrderCustomerDetails | null;
  store?: BoutiqueStore | null;
  razorpayClientFactory?: RazorpayClientFactory;
  requestId?: string;
}): Promise<CheckoutHandlerResponse> {
  const {
    razorpayOrderId,
    razorpayPaymentId,
    customerFallback = null,
    store = null,
    razorpayClientFactory,
    requestId,
  } = params;

  const cleanOid = razorpayOrderId.trim();
  if (!cleanOid) {
    return {
      status: 400,
      body: { status: 400, code: 'MISSING_ORDER_ID', error: 'razorpayOrderId is required.' },
    };
  }

  const creds = resolveRazorpayCredentials();
  if (!creds.ok) {
    return {
      status: 401,
      body: { status: 401, code: creds.code, error: creds.error },
    };
  }

  let pid = (razorpayPaymentId || '').trim();
  if (!pid) {
    const pending = await loadPendingCheckoutRecord(cleanOid, store, requestId);
    pid = pending?.razorpayPaymentId || '';
  }

  const razorpay = (razorpayClientFactory || defaultRazorpayFactory)(creds.keyId, creds.keySecret);
  if (!pid && typeof razorpay.orders.fetchPayments === 'function') {
    try {
      const paymentsList = await razorpay.orders.fetchPayments(cleanOid);
      const captured = (paymentsList.items || []).find(
        (p) => p.status === 'captured' || p.captured === true || p.status === 'authorized'
      );
      if (captured?.id) pid = captured.id;
    } catch {
      // fall through
    }
  }

  if (!pid) {
    return {
      status: 404,
      body: {
        status: 404,
        code: 'NO_CAPTURED_PAYMENT',
        error: `No captured or authorized Razorpay payment found for order ${cleanOid}. Provide the Razorpay Payment ID (pay_...) to recover.`,
      },
    };
  }

  return finalizePaidRazorpayOrder({
    razorpayOrderId: cleanOid,
    razorpayPaymentId: pid,
    keyId: creds.keyId,
    keySecret: creds.keySecret,
    keyMode: creds.mode,
    store,
    customerUserId: null,
    customerOverride: customerFallback,
    razorpayClientFactory,
    source: 'recover',
    strictPersistence: shouldRequireDurablePersistence({ store }),
    requestId,
  });
}

function buildDeterministicCodOrderId(idempotencyKey: string): string {
  const hash = crypto.createHash('sha256').update(`cod:${idempotencyKey}`).digest('hex').slice(0, 24);
  return `ord_cod_${hash}`;
}

async function persistCodOrderToFirestoreOnce(params: {
  orderDocId: string;
  orderNumber: string;
  idempotencyKey: string | null;
  customerUserId: string | null;
  customer: OrderCustomerDetails;
  lines: ValidatedOrderLine[];
  subtotalPaise: number;
  discountPaise: number;
  giftCardPaise: number;
  couponCode: string | null;
  giftCardCode: string | null;
  totalPaise: number;
  strictPersistence?: boolean;
  requestId?: string;
}): Promise<{ receipt: SerializedOrderReceipt; duplicate: boolean }> {
  const {
    orderDocId,
    orderNumber,
    idempotencyKey,
    customerUserId,
    customer,
    lines,
    subtotalPaise,
    discountPaise,
    giftCardPaise,
    couponCode,
    giftCardCode,
    totalPaise,
    strictPersistence = false,
    requestId,
  } = params;

  const ctx = getFirestoreContext();
  if (!ctx) {
    if (strictPersistence) {
      logCheckoutPersistenceFailure({
        operation: 'place_cod_order',
        projectId: 'unknown',
        databaseId: 'unknown',
        namespace: resolveServerFirestoreNamespace(),
        path: `orders/${orderDocId}`,
        status: 503,
        code: 'FIREBASE_CONFIG_MISSING',
        requestId,
        reason: 'firebase-applet-config.json is missing or invalid.',
      });
      throw new StoreHttpError(
        503,
        'ORDER_PERSISTENCE_UNAVAILABLE',
        'Order storage is unavailable right now. Please try again in a moment.'
      );
    }
    const now = Date.now();
    const statusHistory: OrderStatusHistoryEntry[] = [
      {
        status: 'placed',
        note: 'Cash on Delivery order placed · Payment due on delivery',
        actor: customerUserId ? 'customer' : 'system',
        at: now,
      },
    ];
    return {
      duplicate: false,
      receipt: {
        id: orderDocId,
        orderNumber,
        customerUserId,
        status: 'placed',
        paymentStatus: 'unpaid',
        fulfillmentStatus: 'placed',
        subtotalPaise,
        discountPaise,
        giftCardPaise,
        couponCode,
        giftCardCode,
        totalPaise,
        currency: 'INR',
        createdAt: now,
        updatedAt: now,
        paymentCollectedAt: null,
        idempotencyKey,
        paymentMethod: 'cod',
        razorpayOrderId: null,
        razorpayPaymentId: null,
        statusHistory,
        items: lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          productTitle: l.productTitle,
          variantLabel: l.variantLabel,
          sku: l.sku,
          unitPricePaise: l.unitPricePaise,
          quantity: l.quantity,
          lineTotalPaise: l.lineTotalPaise,
        })),
      },
    };
  }

  const orderPath = `environments/${ctx.namespace}/orders/${orderDocId}`;
  const tokenRes = await resolveFirestoreServerBearerToken({
    operation: 'place_cod_order',
    requestId,
    ctx,
  });

  if (!tokenRes.ok) {
    if (strictPersistence) {
      logCheckoutPersistenceFailure({
        operation: 'place_cod_order',
        projectId: ctx.projectId,
        databaseId: ctx.databaseId,
        namespace: ctx.namespace,
        path: orderPath,
        status: tokenRes.status,
        code: tokenRes.reasonCode,
        requestId,
        reason: tokenRes.detail,
      });
      throw new StoreHttpError(
        503,
        'ORDER_PERSISTENCE_UNAVAILABLE',
        'Unable to save your order right now. Please try again in a moment.'
      );
    }
    const now = Date.now();
    const statusHistory: OrderStatusHistoryEntry[] = [
      {
        status: 'placed',
        note: 'Cash on Delivery order placed · Payment due on delivery',
        actor: customerUserId ? 'customer' : 'system',
        at: now,
      },
    ];
    return {
      duplicate: false,
      receipt: {
        id: orderDocId,
        orderNumber,
        customerUserId,
        status: 'placed',
        paymentStatus: 'unpaid',
        fulfillmentStatus: 'placed',
        subtotalPaise,
        discountPaise,
        giftCardPaise,
        couponCode,
        giftCardCode,
        totalPaise,
        currency: 'INR',
        createdAt: now,
        updatedAt: now,
        paymentCollectedAt: null,
        idempotencyKey,
        paymentMethod: 'cod',
        razorpayOrderId: null,
        razorpayPaymentId: null,
        statusHistory,
        items: lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          productTitle: l.productTitle,
          variantLabel: l.variantLabel,
          sku: l.sku,
          unitPricePaise: l.unitPricePaise,
          quantity: l.quantity,
          lineTotalPaise: l.lineTotalPaise,
        })),
      },
    };
  }

  const adminBearer = tokenRes.token;

  // Fast idempotency lookup before mutating inventory
  if (idempotencyKey) {
    const existing = await fetchExistingFirestoreOrder(orderDocId, '', '', {
      requestId,
      bearerToken: adminBearer,
    });
    if (existing) {
      return { receipt: existing, duplicate: true };
    }
  }

  const now = Date.now();
  const statusHistory: OrderStatusHistoryEntry[] = [
    {
      status: 'placed',
      note: 'Cash on Delivery order placed · Payment due on delivery',
      actor: customerUserId ? 'customer' : 'system',
      at: now,
    },
  ];
  const statusHistoryJson = JSON.stringify(statusHistory);
  const firestoreItems = lines.map((l, idx) => ({
    id: `item_${orderDocId}_${idx + 1}`,
    order_id: orderDocId,
    product_id: l.productId,
    variant_id: l.variantId,
    product_title: l.productTitle,
    variant_label: l.variantLabel,
    sku: l.sku,
    unit_price_paise: l.unitPricePaise,
    quantity: l.quantity,
    line_total_paise: l.lineTotalPaise,
  }));

  const receipt: SerializedOrderReceipt = {
    id: orderDocId,
    orderNumber,
    customerUserId,
    status: 'placed',
    paymentStatus: 'unpaid',
    fulfillmentStatus: 'placed',
    subtotalPaise,
    discountPaise,
    giftCardPaise,
    couponCode,
    giftCardCode,
    totalPaise,
    currency: 'INR',
    createdAt: now,
    updatedAt: now,
    paymentCollectedAt: null,
    idempotencyKey,
    paymentMethod: 'cod',
    razorpayOrderId: null,
    razorpayPaymentId: null,
    statusHistory,
    items: lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      productTitle: l.productTitle,
      variantLabel: l.variantLabel,
      sku: l.sku,
      unitPricePaise: l.unitPricePaise,
      quantity: l.quantity,
      lineTotalPaise: l.lineTotalPaise,
    })),
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminBearer}`,
  };
  const productIds = Array.from(new Set(lines.map((l) => l.productId)));

  const docFields = {
    id: orderDocId,
    order_number: orderNumber,
    customer_user_id: customerUserId,
    customer_name: customer.customerName,
    customer_email: customer.customerEmail,
    customer_phone: customer.customerPhone,
    shipping_address: customer.shippingAddress,
    status: 'placed',
    payment_status: 'unpaid',
    fulfillment_status: 'placed',
    payment_method: 'cod',
    razorpay_order_id: null,
    razorpay_payment_id: null,
    coupon_code: couponCode,
    gift_card_code: giftCardCode,
    discount_paise: discountPaise,
    gift_card_paise: giftCardPaise,
    status_history_json: statusHistoryJson,
    return_request_json: null,
    idempotency_key: idempotencyKey,
    payment_collected_at: null,
    payment_collected_by: null,
    subtotal_paise: subtotalPaise,
    total_paise: totalPaise,
    currency: 'INR',
    created_at: now,
    updated_at: now,
    product_ids: productIds,
    items: firestoreItems,
  };

  const docName = `${ctx.dbRootResource}/environments/${ctx.namespace}/orders/${orderDocId}`;
  const writes: Array<Record<string, unknown>> = [
    {
      currentDocument: { exists: false },
      update: {
        name: docName,
        fields: toFsFields(docFields),
      },
    },
  ];

  if (customerUserId) {
    const notifId = `notif_placed_${orderDocId}`;
    writes.push({
      currentDocument: { exists: false },
      update: {
        name: `${ctx.dbRootResource}/environments/${ctx.namespace}/users/${encodeURIComponent(customerUserId)}/notifications/${notifId}`,
        fields: toFsFields({
          id: notifId,
          user_id: customerUserId,
          type: 'order_placed',
          title: `Order ${orderNumber} placed`,
          message: `Your Cash on Delivery order ${orderNumber} is placed. ₹${(totalPaise / 100).toLocaleString('en-IN')} is due on delivery.`,
          order_id: orderDocId,
          order_number: orderNumber,
          is_read: 0,
          read: false,
          read_at: null,
          created_at: now,
        }),
      },
    });
  }

  for (const pid of productIds) {
    const prodRes = await fetch(
      `${ctx.docBaseUrl}/environments/${ctx.namespace}/products/${encodeURIComponent(pid)}`,
      { headers }
    );
    if (prodRes.ok) {
      const prodDoc = (await prodRes.json()) as {
        updateTime?: string;
        fields?: Record<string, FsFieldValue>;
      };
      const prodData = fromFsFields(prodDoc.fields);
      const rawVariants = Array.isArray(prodData.variants) ? prodData.variants : [];
      const nextVariants = rawVariants.map((v) => {
        if (!v || typeof v !== 'object') return v;
        const rec = { ...(v as Record<string, unknown>) };
        const qtyOrdered = lines
          .filter((l) => l.productId === pid && l.variantId === String(rec.id || ''))
          .reduce((s, l) => s + l.quantity, 0);
        if (qtyOrdered > 0) {
          const currentQty = Number(rec.stock_qty || 0);
          if (currentQty < qtyOrdered) {
            throw new StoreHttpError(
              409,
              'INSUFFICIENT_STOCK',
              currentQty <= 0
                ? `"${String(prodData.title || 'This piece')}" is currently out of stock.`
                : `Only ${currentQty} piece(s) left for "${String(prodData.title || 'this piece')}".`
            );
          }
          rec.stock_qty = currentQty - qtyOrdered;
        }
        return rec;
      });
      const nextTotalStock = nextVariants.reduce(
        (sum, v) =>
          sum + (v && typeof v === 'object' ? Number((v as Record<string, unknown>).stock_qty || 0) : 0),
        0
      );
      writes.push({
        ...(prodDoc.updateTime ? { currentDocument: { updateTime: prodDoc.updateTime } } : {}),
        update: {
          name: `${ctx.dbRootResource}/environments/${ctx.namespace}/products/${encodeURIComponent(pid)}`,
          fields: toFsFields({
            ...prodData,
            variants: nextVariants,
            stock_qty: nextTotalStock,
            updated_at: now,
          }),
        },
      });
    }
  }

  if (couponCode) {
    const cpn = await fetchCouponFromFirestoreByCode(couponCode, {
      bearerToken: adminBearer,
      requestId,
    });
    if (cpn) {
      writes.push({
        update: {
          name: `${ctx.dbRootResource}/environments/${ctx.namespace}/coupons/${encodeURIComponent(cpn.id)}`,
          fields: toFsFields({
            ...cpn,
            used_count: Number(cpn.used_count || 0) + 1,
            updated_at: now,
          }),
        },
      });
    }
  }

  if (giftCardCode && giftCardPaise > 0) {
    const gc = await fetchGiftCardFromFirestoreByCode(giftCardCode, {
      bearerToken: adminBearer,
      requestId,
    });
    if (gc) {
      writes.push({
        update: {
          name: `${ctx.dbRootResource}/environments/${ctx.namespace}/gift_cards/${encodeURIComponent(gc.id)}`,
          fields: toFsFields({
            ...gc,
            balance_paise: Math.max(0, Number(gc.balance_paise || 0) - giftCardPaise),
            last_used_at: now,
            updated_at: now,
          }),
        },
      });
    }
  }

  let commitRes: Response;
  try {
    commitRes = await fetch(`${ctx.docBaseUrl}:commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ writes }),
    });
  } catch (err) {
    logCheckoutPersistenceFailure({
      operation: 'place_cod_order',
      projectId: ctx.projectId,
      databaseId: ctx.databaseId,
      namespace: ctx.namespace,
      path: orderPath,
      status: 503,
      code: 'FIRESTORE_NETWORK_ERROR',
      requestId,
      reason: err instanceof Error ? err.message : 'Network error during COD Firestore commit.',
    });
    throw new StoreHttpError(
      503,
      'ORDER_RECORD_FAILED',
      'Unable to save your order right now. Please try again in a moment.'
    );
  }

  if (commitRes.ok) {
    return { receipt, duplicate: false };
  }

  const errText = await commitRes.text().catch(() => '');
  if (
    commitRes.status === 409 ||
    commitRes.status === 412 ||
    errText.includes('ALREADY_EXISTS') ||
    errText.includes('FAILED_PRECONDITION')
  ) {
    if (idempotencyKey) {
      const existing = await fetchExistingFirestoreOrder(orderDocId, '', '', {
        requestId,
        bearerToken: adminBearer,
      });
      if (existing) {
        return { receipt: existing, duplicate: true };
      }
    }
    throw new StoreHttpError(
      409,
      'ORDER_CONFLICT',
      'Inventory or order state changed while placing your order. Please review your bag and retry.'
    );
  }

  logCheckoutPersistenceFailure({
    operation: 'place_cod_order',
    projectId: ctx.projectId,
    databaseId: ctx.databaseId,
    namespace: ctx.namespace,
    path: orderPath,
    status: commitRes.status,
    code: commitRes.status === 403 ? 'FIRESTORE_PERMISSION_DENIED' : 'FIRESTORE_COMMIT_FAILED',
    requestId,
    reason: errText || commitRes.statusText || `HTTP ${commitRes.status}`,
  });

  throw new StoreHttpError(
    503,
    'ORDER_RECORD_FAILED',
    'Unable to save your order right now. Please try again in a moment.'
  );
}

export async function handlePlaceCodOrderRequest(params: {
  body: Record<string, unknown>;
  store?: BoutiqueStore | null;
  customerUserId?: string | null;
  customerIdToken?: string | null;
  requireDurablePersistence?: boolean;
  requestId?: string;
}): Promise<CheckoutHandlerResponse> {
  const {
    body,
    store = null,
    customerUserId = null,
    requireDurablePersistence = true,
    requestId,
  } = params;

  const rawMethod =
    typeof body.paymentMethod === 'string' ? body.paymentMethod.trim().toLowerCase() : 'cod';
  if (rawMethod !== 'cod') {
    return {
      status: 400,
      body: {
        status: 400,
        code: 'INVALID_PAYMENT_METHOD',
        error: 'POST /api/orders supports Cash on Delivery ("cod"). Use /api/create-order for Razorpay payments.',
      },
    };
  }

  const rawCustomer =
    body.customer && typeof body.customer === 'object'
      ? (body.customer as Record<string, unknown>)
      : body;
  const customerName =
    typeof rawCustomer.customerName === 'string' ? rawCustomer.customerName.trim() : '';
  const customerEmail =
    typeof rawCustomer.customerEmail === 'string' ? rawCustomer.customerEmail.trim().toLowerCase() : '';
  const customerPhone =
    typeof rawCustomer.customerPhone === 'string' ? rawCustomer.customerPhone.trim() : '';
  const shippingAddress =
    typeof rawCustomer.shippingAddress === 'string' ? rawCustomer.shippingAddress.trim() : '';

  if (customerName.length < 2 || customerName.length > 100) {
    return {
      status: 400,
      body: { status: 400, code: 'VALIDATION_ERROR', error: 'Please enter your full name.' },
    };
  }
  if (!EMAIL_REGEX.test(customerEmail)) {
    return {
      status: 400,
      body: { status: 400, code: 'VALIDATION_ERROR', error: 'Please enter a valid email address.' },
    };
  }
  if (customerPhone.length < 7 || customerPhone.length > 24) {
    return {
      status: 400,
      body: {
        status: 400,
        code: 'VALIDATION_ERROR',
        error: 'Please enter a valid contact phone number.',
      },
    };
  }
  if (shippingAddress.length < 8 || shippingAddress.length > 400) {
    return {
      status: 400,
      body: {
        status: 400,
        code: 'VALIDATION_ERROR',
        error: 'Please enter a complete delivery address.',
      },
    };
  }

  const cartLines = parseCartLines(body.items);
  if (cartLines.length === 0) {
    return {
      status: 400,
      body: { status: 400, code: 'EMPTY_CART', error: 'Your shopping bag is empty.' },
    };
  }

  const rawIdempotency =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim().slice(0, 128) : '';
  const cleanIdempotencyKey =
    rawIdempotency && /^[a-zA-Z0-9_.:-]{6,128}$/.test(rawIdempotency)
      ? rawIdempotency
      : null;

  const deterministicOrderId = cleanIdempotencyKey
    ? buildDeterministicCodOrderId(cleanIdempotencyKey)
    : `ord_cod_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

  // Fast idempotency check BEFORE catalog/stock validation so retries succeed cleanly even after stock decremented on first attempt
  if (cleanIdempotencyKey) {
    if (store) {
      const existingStoreOrder = await store.getOrderById(deterministicOrderId).catch(() => null);
      if (existingStoreOrder) {
        const { order: o, items } = existingStoreOrder;
        const receipt: SerializedOrderReceipt = {
          id: o.id,
          orderNumber: o.order_number,
          customerUserId: o.customer_user_id,
          status: o.status,
          paymentStatus: o.payment_status || 'unpaid',
          fulfillmentStatus: o.fulfillment_status || o.status || 'placed',
          subtotalPaise: o.subtotal_paise,
          discountPaise: o.discount_paise || 0,
          giftCardPaise: o.gift_card_paise || 0,
          couponCode: o.coupon_code || null,
          giftCardCode: o.gift_card_code || null,
          totalPaise: o.total_paise,
          currency: o.currency,
          createdAt: o.created_at,
          updatedAt: o.updated_at ?? o.created_at,
          paymentCollectedAt: o.payment_collected_at ?? null,
          idempotencyKey: o.idempotency_key ?? cleanIdempotencyKey,
          paymentMethod: (o.payment_method as 'cod' | 'razorpay') || 'cod',
          razorpayOrderId: o.razorpay_order_id ?? null,
          razorpayPaymentId: o.razorpay_payment_id ?? null,
          statusHistory: parseStatusHistorySafe(o.status_history_json),
          items: items.map((l) => ({
            productId: l.product_id,
            variantId: l.variant_id,
            productTitle: l.product_title,
            variantLabel: l.variant_label,
            sku: l.sku,
            unitPricePaise: l.unit_price_paise,
            quantity: l.quantity,
            lineTotalPaise: l.line_total_paise,
          })),
        };
        return { status: 200, body: { order: receipt, duplicate: true } };
      }
    } else {
      const existingFsOrder = await fetchExistingFirestoreOrder(deterministicOrderId, '', '', {
        requestId,
      });
      if (existingFsOrder) {
        return { status: 200, body: { order: existingFsOrder, duplicate: true } };
      }
    }
  }

  try {
    const validated = await validateCartAgainstCatalog({ items: cartLines, store });
    const rawCoupon = typeof body.couponCode === 'string' ? body.couponCode.trim() : null;
    const rawGiftCard = typeof body.giftCardCode === 'string' ? body.giftCardCode.trim() : null;

    const promo = await validatePromoAndGiftCardForBag({
      subtotalPaise: validated.totalPaise,
      couponCode: rawCoupon,
      giftCardCode: rawGiftCard,
      store,
      ensurePayableMinimum: false,
    });

    const customer: OrderCustomerDetails = {
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
    };

    const orderNumber = `SC-${new Date().getUTCFullYear()}-${crypto
      .createHash('sha256')
      .update(deterministicOrderId)
      .digest('hex')
      .slice(0, 6)
      .toUpperCase()}`;

    if (store) {
      const { order, items } = await store.placeOrder({
        id: deterministicOrderId,
        orderNumber,
        idempotencyKey: cleanIdempotencyKey,
        customerUserId,
        customerName: customer.customerName,
        customerEmail: customer.customerEmail,
        customerPhone: customer.customerPhone,
        shippingAddress: customer.shippingAddress,
        status: 'placed',
        paymentStatus: 'unpaid',
        fulfillmentStatus: 'placed',
        paymentMethod: 'cod',
        razorpayOrderId: null,
        razorpayPaymentId: null,
        couponCode: promo.couponCode,
        giftCardCode: promo.giftCardCode,
        discountPaise: promo.discountPaise,
        giftCardPaise: promo.giftCardPaise,
        items: validated.lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          expectedPricePaise: l.unitPricePaise,
        })),
      });

      const receipt: SerializedOrderReceipt = {
        id: order.id,
        orderNumber: order.order_number,
        customerUserId: order.customer_user_id,
        status: order.status,
        paymentStatus: order.payment_status || 'unpaid',
        fulfillmentStatus: order.fulfillment_status || order.status || 'placed',
        subtotalPaise: order.subtotal_paise,
        discountPaise: order.discount_paise || 0,
        giftCardPaise: order.gift_card_paise || 0,
        couponCode: order.coupon_code || null,
        giftCardCode: order.gift_card_code || null,
        totalPaise: order.total_paise,
        currency: order.currency,
        createdAt: order.created_at,
        updatedAt: order.updated_at ?? order.created_at,
        paymentCollectedAt: order.payment_collected_at ?? null,
        idempotencyKey: order.idempotency_key ?? cleanIdempotencyKey,
        paymentMethod: 'cod',
        razorpayOrderId: null,
        razorpayPaymentId: null,
        statusHistory: parseStatusHistorySafe(order.status_history_json),
        items: items.map((l) => ({
          productId: l.product_id,
          variantId: l.variant_id,
          productTitle: l.product_title,
          variantLabel: l.variant_label,
          sku: l.sku,
          unitPricePaise: l.unit_price_paise,
          quantity: l.quantity,
          lineTotalPaise: l.line_total_paise,
        })),
      };

      return { status: 201, body: { order: receipt, duplicate: false } };
    }

    const persisted = await persistCodOrderToFirestoreOnce({
      orderDocId: deterministicOrderId,
      orderNumber,
      idempotencyKey: cleanIdempotencyKey,
      customerUserId,
      customer,
      lines: validated.lines,
      subtotalPaise: validated.totalPaise,
      discountPaise: promo.discountPaise,
      giftCardPaise: promo.giftCardPaise,
      couponCode: promo.couponCode,
      giftCardCode: promo.giftCardCode,
      totalPaise: promo.finalAmountPaise,
      strictPersistence: requireDurablePersistence,
      requestId,
    });

    return {
      status: persisted.duplicate ? 200 : 201,
      body: { order: persisted.receipt, duplicate: persisted.duplicate },
    };
  } catch (err) {
    if (err instanceof StoreHttpError) {
      return {
        status: err.httpStatus,
        body: { status: err.httpStatus, code: err.code, error: err.message },
      };
    }
    return {
      status: 500,
      body: {
        status: 500,
        code: 'COD_ORDER_FAILED',
        error:
          err instanceof Error && err.message
            ? err.message
            : 'Unable to place Cash on Delivery order right now.',
      },
    };
  }
}

export function clearRazorpayCheckoutCachesForTest() {
  pendingCheckoutsMemory.clear();
  completedCheckoutsMemory.clear();
  inFlightVerifications.clear();
  idempotentOrderAttemptsMemory.clear();
  processedWebhookEventsMemory.clear();
  cachedGoogleAccessToken = null;
}
