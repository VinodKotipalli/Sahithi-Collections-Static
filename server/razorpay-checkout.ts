import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Razorpay from 'razorpay';
import { PRODUCTS } from '../src/config/products.ts';
import { StoreHttpError, type BoutiqueStore, type PlaceOrderInput } from './store.ts';

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
}

export interface RazorpayPaymentEntity {
  id: string;
  order_id?: string | null;
  amount: number | string;
  currency?: string;
  status?: string;
  captured?: boolean;
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
  status: string;
  subtotalPaise: number;
  totalPaise: number;
  currency: string;
  createdAt: number;
  paymentMethod: 'razorpay';
  razorpayOrderId: string;
  razorpayPaymentId: string;
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
  currency: string;
  receipt: string;
  items: ValidatedOrderLine[];
  customer: OrderCustomerDetails | null;
  customerUserId: string | null;
  status: 'pending' | 'confirmed';
  createdAt: number;
  expiresAt: number;
  confirmedOrder?: SerializedOrderReceipt;
  razorpayPaymentId?: string;
}

interface SignedCheckoutTokenPayload {
  v: 1;
  oid: string;
  amt: number;
  cur: string;
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

let cachedGoogleAccessToken: { token: string; expiresAtMs: number } | null = null;

function defaultRazorpayFactory(keyId: string, keySecret: string): RazorpayClientLike {
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  }) as unknown as RazorpayClientLike;
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

  const kService = (process.env.K_SERVICE || '').trim().toLowerCase();
  if (kService.startsWith('ais-pre-')) return 'shared-preview';
  if (kService.startsWith('ais-dev-')) return 'development';

  // On Vercel deployments (both Preview *.vercel.app and Production custom domain),
  // the client SPA reads environments/production (firebaseClientApi.ts).
  if (
    process.env.VERCEL === '1' ||
    (process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
  ) {
    return 'production';
  }

  return 'development';
}

interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function parseServiceAccountCredentials(): ServiceAccountCreds | null {
  const rawEnv = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  let jsonText = rawEnv;

  if (!jsonText) {
    const gacPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    if (gacPath && fs.existsSync(gacPath)) {
      try {
        jsonText = fs.readFileSync(gacPath, 'utf8').trim();
      } catch {
        return null;
      }
    }
  }

  if (!jsonText) return null;

  if (!jsonText.startsWith('{')) {
    try {
      const decoded = Buffer.from(jsonText, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) jsonText = decoded;
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<ServiceAccountCreds>;
    if (
      typeof parsed.client_email === 'string' &&
      parsed.client_email &&
      typeof parsed.private_key === 'string' &&
      parsed.private_key
    ) {
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key.replace(/\\n/g, '\n'),
        token_uri:
          typeof parsed.token_uri === 'string' && parsed.token_uri
            ? parsed.token_uri
            : 'https://oauth2.googleapis.com/token',
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function getFirestoreAdminBearerToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedGoogleAccessToken && now < cachedGoogleAccessToken.expiresAtMs - 60_000) {
    return cachedGoogleAccessToken.token;
  }

  const creds = parseServiceAccountCredentials();
  if (!creds) return null;

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
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch(creds.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) return null;
    const tokenPayload = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof tokenPayload.access_token === 'string' && tokenPayload.access_token) {
      const expiresInMs = Number(tokenPayload.expires_in || 3600) * 1000;
      cachedGoogleAccessToken = {
        token: tokenPayload.access_token,
        expiresAtMs: now + expiresInMs,
      };
      return tokenPayload.access_token;
    }
  } catch {
    return null;
  }
  return null;
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

interface CatalogVariantInfo {
  id: string;
  sku: string;
  size: string;
  color_name: string;
  price_paise: number;
  stock_qty: number;
}

interface CatalogProductInfo {
  id: string;
  slug: string;
  title: string;
  sku: string;
  status: string;
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

async function fetchPublishedCatalogFromFirestore(): Promise<Map<string, CatalogProductInfo>> {
  const ctx = getFirestoreContext();
  const byId = new Map<string, CatalogProductInfo>();

  // Seed catalog fallback (matches src/services/firebaseClientApi.ts)
  const seeds = buildSeedCatalogProducts();
  for (const seed of seeds) {
    byId.set(seed.id, seed);
  }

  if (!ctx) return byId;

  const bearerToken = await getFirestoreAdminBearerToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const keyParam = ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';

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

async function savePendingCheckoutToFirestore(record: PendingCheckoutRecord): Promise<void> {
  const ctx = getFirestoreContext();
  if (!ctx) return;
  const bearerToken = await getFirestoreAdminBearerToken();
  if (!bearerToken) return;

  const keyParam = ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/pending_checkouts/${encodeURIComponent(record.razorpayOrderId)}${keyParam}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      fields: toFsFields({
        id: record.razorpayOrderId,
        razorpay_order_id: record.razorpayOrderId,
        amount_paise: record.amountPaise,
        currency: record.currency,
        receipt: record.receipt,
        items: record.items,
        customer: record.customer,
        customer_user_id: record.customerUserId,
        status: record.status,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
        ...(record.razorpayPaymentId ? { razorpay_payment_id: record.razorpayPaymentId } : {}),
        ...(record.confirmedOrder ? { confirmed_order: record.confirmedOrder } : {}),
      }),
    }),
  }).catch(() => undefined);
}

async function loadPendingCheckoutFromFirestore(
  razorpayOrderId: string
): Promise<PendingCheckoutRecord | null> {
  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const bearerToken = await getFirestoreAdminBearerToken();
  if (!bearerToken) return null;

  const keyParam = ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/pending_checkouts/${encodeURIComponent(razorpayOrderId)}${keyParam}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { fields?: Record<string, FsFieldValue> };
    const data = fromFsFields(json.fields);
    if (typeof data.razorpay_order_id !== 'string') return null;
    return {
      razorpayOrderId: data.razorpay_order_id,
      amountPaise: Math.round(Number(data.amount_paise || 0)),
      currency: String(data.currency || 'INR'),
      receipt: String(data.receipt || ''),
      items: Array.isArray(data.items) ? (data.items as ValidatedOrderLine[]) : [],
      customer:
        data.customer && typeof data.customer === 'object'
          ? (data.customer as OrderCustomerDetails)
          : null,
      customerUserId:
        typeof data.customer_user_id === 'string' ? data.customer_user_id : null,
      status: data.status === 'confirmed' ? 'confirmed' : 'pending',
      createdAt: Number(data.created_at || Date.now()),
      expiresAt: Number(data.expires_at || Date.now() + CHECKOUT_TOKEN_TTL_MS),
      razorpayPaymentId:
        typeof data.razorpay_payment_id === 'string' ? data.razorpay_payment_id : undefined,
      confirmedOrder:
        data.confirmed_order && typeof data.confirmed_order === 'object'
          ? (data.confirmed_order as SerializedOrderReceipt)
          : undefined,
    };
  } catch {
    return null;
  }
}

function buildDeterministicOrderId(razorpayOrderId: string): string {
  const sanitized = razorpayOrderId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const candidate = `ord_rzp_${sanitized}`;
  return candidate.slice(0, 120);
}

async function fetchExistingFirestoreOrder(
  orderDocId: string,
  razorpayOrderId: string,
  razorpayPaymentId: string
): Promise<SerializedOrderReceipt | null> {
  const ctx = getFirestoreContext();
  if (!ctx) return null;
  const bearerToken = await getFirestoreAdminBearerToken();
  if (!bearerToken) return null;

  const keyParam = ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';
  const url = `${ctx.docBaseUrl}/environments/${ctx.namespace}/orders/${encodeURIComponent(orderDocId)}${keyParam}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as { fields?: Record<string, FsFieldValue> };
    const data = fromFsFields(doc.fields);
    if (typeof data.id !== 'string') return null;
    const rawItems = Array.isArray(data.items) ? data.items : [];
    return {
      id: data.id,
      orderNumber: String(data.order_number || orderDocId),
      status: 'confirmed',
      subtotalPaise: Number(data.subtotal_paise || 0),
      totalPaise: Number(data.total_paise || 0),
      currency: String(data.currency || 'INR'),
      createdAt: Number(data.created_at || Date.now()),
      paymentMethod: 'razorpay',
      razorpayOrderId: String(data.razorpay_order_id || razorpayOrderId),
      razorpayPaymentId: String(data.razorpay_payment_id || razorpayPaymentId),
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
  totalPaise: number;
}): Promise<SerializedOrderReceipt> {
  const { razorpayOrderId, razorpayPaymentId, customerUserId, customer, lines, totalPaise } = params;
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
    status: 'confirmed',
    subtotalPaise: totalPaise,
    totalPaise,
    currency: 'INR',
    createdAt: now,
    paymentMethod: 'razorpay',
    razorpayOrderId,
    razorpayPaymentId,
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

  if (!ctx) return receipt;

  const bearerToken = await getFirestoreAdminBearerToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const keyParam = ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : '';

  const productIds = Array.from(new Set(lines.map((l) => l.productId)));

  // With Firebase service-account admin credentials, we can write confirmed status and Razorpay metadata.
  // Without admin credentials, firestore.rules (`isValidPublicOrder`) allows unauthenticated `create`
  // with exact 14 fields and `status: 'pending'` — so use `currentDocument: { exists: false }` commit
  // to enforce exactly-once creation in Firestore cleanly.
  const docFields = bearerToken
    ? {
        id: orderDocId,
        order_number: orderNumber,
        customer_user_id: customerUserId,
        customer_name: customer.customerName,
        customer_email: customer.customerEmail,
        customer_phone: customer.customerPhone,
        shipping_address: customer.shippingAddress,
        status: 'confirmed',
        subtotal_paise: totalPaise,
        total_paise: totalPaise,
        currency: 'INR',
        created_at: now,
        product_ids: productIds,
        items: firestoreItems,
        payment_method: 'razorpay',
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
      }
    : {
        id: orderDocId,
        order_number: orderNumber,
        customer_user_id: null,
        customer_name: customer.customerName,
        customer_email: customer.customerEmail,
        customer_phone: customer.customerPhone,
        shipping_address: customer.shippingAddress,
        status: 'pending',
        subtotal_paise: totalPaise,
        total_paise: totalPaise,
        currency: 'INR',
        created_at: now,
        product_ids: productIds,
        items: firestoreItems,
      };

  const docName = `${ctx.dbRootResource}/environments/${ctx.namespace}/orders/${orderDocId}`;
  const commitRes = await fetch(`${ctx.docBaseUrl}:commit${keyParam}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      writes: [
        {
          currentDocument: { exists: false },
          update: {
            name: docName,
            fields: toFsFields(docFields),
          },
        },
      ],
    }),
  });

  if (commitRes.ok) {
    return receipt;
  }

  // If the order document already exists (duplicate verify call or concurrent race), return idempotently
  if (commitRes.status === 409 || commitRes.status === 412 || commitRes.status === 400) {
    const errText = await commitRes.text().catch(() => '');
    if (
      errText.includes('ALREADY_EXISTS') ||
      errText.includes('FAILED_PRECONDITION') ||
      commitRes.status === 409 ||
      commitRes.status === 412
    ) {
      const existing = await fetchExistingFirestoreOrder(
        orderDocId,
        razorpayOrderId,
        razorpayPaymentId
      );
      if (existing) return existing;
      return receipt;
    }
    throw new StoreHttpError(
      502,
      'ORDER_RECORD_FAILED',
      `Failed to save confirmed order to Firestore: ${errText.slice(0, 180)}`
    );
  }

  const errText = await commitRes.text().catch(() => '');
  throw new StoreHttpError(
    commitRes.status >= 400 ? commitRes.status : 500,
    'ORDER_RECORD_FAILED',
    `Failed to persist order record (${commitRes.status}): ${errText.slice(0, 180)}`
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

function sanitizeEnvCredential(raw: string | undefined): string {
  if (!raw) return '';
  let val = raw.trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1).trim();
  }
  return val.replace(/[\r\n]+/g, '').trim();
}

function maskRazorpayKeyId(keyId: string): string {
  if (keyId.length <= 12) return keyId;
  return `${keyId.slice(0, 12)}…${keyId.slice(-4)}`;
}

export function resolveRazorpayCredentials():
  | { ok: true; keyId: string; keySecret: string; mode: 'test' | 'live' }
  | { ok: false; code: string; error: string } {
  const keyId = sanitizeEnvCredential(process.env.RAZORPAY_KEY_ID);
  const keySecret = sanitizeEnvCredential(
    process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET
  );

  if (!keyId || !keySecret) {
    return {
      ok: false,
      code: 'RAZORPAY_AUTH_FAILED',
      error:
        'Razorpay API credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured on the server.',
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

export async function handleCreateOrderRequest(params: {
  body: Record<string, unknown>;
  store?: BoutiqueStore | null;
  customerUserId?: string | null;
  razorpayClientFactory?: RazorpayClientFactory;
}): Promise<CheckoutHandlerResponse> {
  const { body, store = null, customerUserId = null, razorpayClientFactory } = params;

  const creds = resolveRazorpayCredentials();
  if (!creds.ok) {
    return {
      status: 401,
      body: {
        status: 401,
        code: creds.code,
        error: creds.error,
      },
    };
  }
  const { keyId, keySecret, mode: keyMode } = creds;

  const currency =
    typeof body.currency === 'string' && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : 'INR';

  if (currency !== 'INR') {
    return {
      status: 400,
      body: {
        status: 400,
        code: 'INVALID_CURRENCY',
        error: 'Only INR currency is supported for checkout.',
      },
    };
  }

  let validatedLines: ValidatedOrderLine[] = [];
  let amountPaise = NaN;

  const hasItemsField = Array.isArray(body.items);
  if (hasItemsField) {
    const parsedLines = parseCartLines(body.items);
    try {
      const checked = await validateCartAgainstCatalog({ items: parsedLines, store });
      validatedLines = checked.lines;
      amountPaise = checked.totalPaise;
    } catch (err) {
      if (err instanceof StoreHttpError) {
        return {
          status: err.httpStatus,
          body: {
            status: err.httpStatus,
            code: err.code,
            error: err.message,
          },
        };
      }
      throw err;
    }
  } else {
    const rawAmount = body.amount;
    amountPaise =
      typeof rawAmount === 'number' && Number.isFinite(rawAmount)
        ? Math.round(rawAmount)
        : typeof rawAmount === 'string' && rawAmount.trim() !== ''
          ? Math.round(Number(rawAmount))
          : NaN;
  }

  if (!Number.isInteger(amountPaise) || amountPaise < MIN_PRICE_PAISE) {
    return {
      status: 400,
      body: {
        status: 400,
        code: 'INVALID_AMOUNT',
        error: 'Amount must be at least 100 paise (₹1.00).',
      },
    };
  }

  const receipt =
    typeof body.receipt === 'string' && body.receipt.trim()
      ? body.receipt.trim().slice(0, 40)
      : `sc_rcpt_${Date.now()}`;

  const customer = parseCustomerDetails(body.customer || body.orderData);

  try {
    const razorpay = (razorpayClientFactory || defaultRazorpayFactory)(keyId, keySecret);
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      ...(validatedLines.length > 0
        ? {
            notes: {
              items_count: String(validatedLines.length),
              product_ids: validatedLines
                .map((l) => l.productId)
                .join(',')
                .slice(0, 200),
            },
          }
        : {}),
    });

    const now = Date.now();
    const pendingRecord: PendingCheckoutRecord = {
      razorpayOrderId: order.id,
      amountPaise: Number(order.amount || amountPaise),
      currency: String(order.currency || 'INR').toUpperCase(),
      receipt: String(order.receipt || receipt),
      items: validatedLines,
      customer,
      customerUserId,
      status: 'pending',
      createdAt: now,
      expiresAt: now + CHECKOUT_TOKEN_TTL_MS,
    };

    pruneMemoryCaches(now);
    pendingCheckoutsMemory.set(order.id, pendingRecord);
    await savePendingCheckoutToFirestore(pendingRecord);

    const checkoutToken = createSignedCheckoutToken(
      {
        v: 1,
        oid: order.id,
        amt: pendingRecord.amountPaise,
        cur: pendingRecord.currency,
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

    return {
      status: 200,
      body: {
        order_id: order.id,
        id: order.id,
        amount: pendingRecord.amountPaise,
        currency: pendingRecord.currency,
        receipt: pendingRecord.receipt,
        key_id: keyId,
        checkout_token: checkoutToken,
      },
    };
  } catch (err: unknown) {
    const { description, isAuthFailure } = extractRazorpayApiError(
      err,
      'Failed to create Razorpay order.'
    );

    if (isAuthFailure) {
      const masked = maskRazorpayKeyId(keyId);
      return {
        status: 401,
        body: {
          status: 401,
          code: 'RAZORPAY_AUTH_FAILED',
          keyMode,
          keyPrefix: masked,
          error: `Razorpay API authentication failed for ${keyMode} key "${masked}". Update RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your server / Vercel environment variables with an active matching key pair from Razorpay Dashboard → Account & Settings → API Keys.`,
        },
      };
    }

    return {
      status: 500,
      body: {
        status: 500,
        code: 'RAZORPAY_ORDER_FAILED',
        error: description,
      },
    };
  }
}

export async function handleVerifyPaymentRequest(params: {
  body: Record<string, unknown>;
  store?: BoutiqueStore | null;
  customerUserId?: string | null;
  razorpayClientFactory?: RazorpayClientFactory;
}): Promise<CheckoutHandlerResponse> {
  const { body, store = null, customerUserId = null, razorpayClientFactory } = params;

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
  const { keyId, keySecret } = creds;

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

  // Verify HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
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

  // Deduplicate concurrent verify requests for the same order
  const existingInFlight = inFlightVerifications.get(razorpayOrderId);
  if (existingInFlight) {
    return existingInFlight;
  }

  const runVerification = async (): Promise<CheckoutHandlerResponse> => {
    // Check in-memory and Firestore idempotency state first
    const memCompleted = completedCheckoutsMemory.get(razorpayOrderId);
    if (memCompleted) {
      return {
        status: 200,
        body: {
          ...memCompleted.responseBody,
          already_processed: true,
        },
      };
    }

    let pendingRecord =
      pendingCheckoutsMemory.get(razorpayOrderId) ||
      (await loadPendingCheckoutFromFirestore(razorpayOrderId));

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

    // Parse & validate orderData against server catalog if provided
    const rawOrderData =
      body.orderData && typeof body.orderData === 'object'
        ? (body.orderData as Record<string, unknown>)
        : null;
    const customerFromOrderData = parseCustomerDetails(rawOrderData) || pendingRecord?.customer || null;
    const parsedOrderItems = rawOrderData && Array.isArray(rawOrderData.items)
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

    const expectedAmountPaise =
      pendingRecord?.amountPaise ??
      verifiedToken?.amt ??
      catalogValidatedForOrder?.totalPaise ??
      null;

    // If both pending/token amount and orderData catalog total exist, verify they match
    if (
      pendingRecord &&
      catalogValidatedForOrder &&
      pendingRecord.amountPaise !== catalogValidatedForOrder.totalPaise
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

    // Verify payment & order status server-side against Razorpay API
    let fetchedPayment: RazorpayPaymentEntity;
    let fetchedOrder: RazorpayOrderEntity | null = null;
    try {
      const razorpay = (razorpayClientFactory || defaultRazorpayFactory)(keyId, keySecret);
      fetchedPayment = await razorpay.payments.fetch(razorpayPaymentId);
      if (fetchedPayment.order_id && fetchedPayment.order_id !== razorpayOrderId) {
        return {
          status: 400,
          body: {
            status: 400,
            success: false,
            verified: false,
            code: 'PAYMENT_ORDER_MISMATCH',
            error: 'Razorpay payment does not belong to this order.',
          },
        };
      }

      if (
        expectedAmountPaise !== null &&
        Math.round(Number(fetchedPayment.amount)) !== expectedAmountPaise
      ) {
        return {
          status: 400,
          body: {
            status: 400,
            success: false,
            verified: false,
            code: 'AMOUNT_MISMATCH',
            error: 'Paid amount does not match the expected order amount.',
          },
        };
      }

      const paidCurrency = String(fetchedPayment.currency || '').toUpperCase();
      if (paidCurrency !== 'INR') {
        return {
          status: 400,
          body: {
            status: 400,
            success: false,
            verified: false,
            code: 'CURRENCY_MISMATCH',
            error: `Unexpected payment currency (${paidCurrency || 'unknown'}). Expected INR.`,
          },
        };
      }

      const verifyAmountForCapture =
        expectedAmountPaise ?? Math.round(Number(fetchedPayment.amount));

      fetchedOrder = await razorpay.orders.fetch(razorpayOrderId).catch(() => null);
      if (
        fetchedOrder &&
        expectedAmountPaise !== null &&
        Math.round(Number(fetchedOrder.amount)) !== expectedAmountPaise
      ) {
        return {
          status: 400,
          body: {
            status: 400,
            success: false,
            verified: false,
            code: 'AMOUNT_MISMATCH',
            error: 'Razorpay order amount does not match the checkout total.',
          },
        };
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
        return {
          status: 400,
          body: {
            status: 400,
            success: false,
            verified: false,
            code: 'PAYMENT_NOT_CAPTURED',
            error: `Payment is not captured (status: ${fetchedPayment.status || 'unknown'}).`,
          },
        };
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
            keyMode: creds.mode,
            keyPrefix: masked,
            error: `Razorpay API authentication failed for ${creds.mode} key "${masked}" while verifying payment. Ensure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET match your active Razorpay key pair.`,
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

    const finalLines =
      catalogValidatedForOrder?.lines || pendingRecord?.items || [];
    const finalTotalPaise =
      expectedAmountPaise ?? Math.round(Number(fetchedPayment.amount));

    if (customerFromOrderData && finalLines.length > 0) {
      let confirmedReceipt: SerializedOrderReceipt;

      if (store) {
        const placeInput: PlaceOrderInput = {
          customerUserId,
          customerName: customerFromOrderData.customerName,
          customerEmail: customerFromOrderData.customerEmail,
          customerPhone: customerFromOrderData.customerPhone,
          shippingAddress: customerFromOrderData.shippingAddress,
          items: finalLines.map((l) => ({
            productId: l.productId,
            variantId: l.variantId,
            quantity: l.quantity,
            expectedPricePaise: l.unitPricePaise,
          })),
        };
        const { order, items } = await store.placeOrder(placeInput);
        await store.updateOrderStatus(order.id, 'confirmed').catch(() => false);
        confirmedReceipt = {
          id: order.id,
          orderNumber: order.order_number,
          status: 'confirmed',
          subtotalPaise: order.subtotal_paise,
          totalPaise: order.total_paise,
          currency: order.currency,
          createdAt: order.created_at,
          paymentMethod: 'razorpay',
          razorpayOrderId,
          razorpayPaymentId,
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
          customerUserId,
          customer: customerFromOrderData,
          lines: finalLines,
          totalPaise: finalTotalPaise,
        });
      }

      if (pendingRecord) {
        pendingRecord = {
          ...pendingRecord,
          status: 'confirmed',
          razorpayPaymentId,
          confirmedOrder: confirmedReceipt,
        };
        pendingCheckoutsMemory.set(razorpayOrderId, pendingRecord);
        await savePendingCheckoutToFirestore(pendingRecord);
      }

      const responseBody: Record<string, unknown> = {
        success: true,
        verified: true,
        order_id: razorpayOrderId,
        payment_id: razorpayPaymentId,
        message: 'Payment verified and order confirmed.',
        order: confirmedReceipt,
      };
      completedCheckoutsMemory.set(razorpayOrderId, {
        paymentId: razorpayPaymentId,
        order: confirmedReceipt,
        responseBody,
      });

      return { status: 200, body: responseBody };
    }

    const responseBody: Record<string, unknown> = {
      success: true,
      verified: true,
      order_id: razorpayOrderId,
      payment_id: razorpayPaymentId,
      message: 'Payment verified successfully.',
    };
    completedCheckoutsMemory.set(razorpayOrderId, {
      paymentId: razorpayPaymentId,
      responseBody,
    });
    return { status: 200, body: responseBody };
  };

  const promise = runVerification().finally(() => {
    inFlightVerifications.delete(razorpayOrderId);
  });
  inFlightVerifications.set(razorpayOrderId, promise);

  try {
    return await promise;
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
    return {
      status: 500,
      body: {
        status: 500,
        success: false,
        verified: true,
        code: 'ORDER_RECORD_FAILED',
        error:
          err instanceof Error
            ? err.message
            : 'Payment verified, but order recording failed.',
      },
    };
  }
}

export function clearRazorpayCheckoutCachesForTest() {
  pendingCheckoutsMemory.clear();
  completedCheckoutsMemory.clear();
  inFlightVerifications.clear();
}
