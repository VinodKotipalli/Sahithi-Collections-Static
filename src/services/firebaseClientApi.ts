import firebaseAppletConfig from '../../firebase-applet-config.json';
import {
  DEFAULT_SITE_SETTINGS,
  DEFAULT_STOREFRONT_CONTENT,
  INITIAL_SEED_CATEGORIES,
  mergeSiteSettings,
  mergeStorefrontContent,
} from '../../server/storefront-defaults.ts';
import type { AuthCapabilities, AuthUser, ApiResult } from '../context/AuthContext';

export const AUTHORIZED_OWNER_EMAIL = 'saivinodkotipalli2003@gmail.com';
const PASSWORD_MIN_LENGTH = 8;
const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CLIENT_SESSION_STORAGE_KEY = 'sahithi_fb_client_session_v1';
const CLIENT_PENDING_VERIFY_KEY = 'sahithi_fb_pending_verify_v1';

interface ClientFirebaseSession {
  idToken: string;
  refreshToken: string;
  uid: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
  lastReauthAt: number;
  issuedAt: number;
  expiresAtMs: number;
  csrfToken: string;
}

interface PendingVerifyRecord {
  idToken: string;
  lastSentAt: number;
  expiresAt: number;
}

interface FirestoreFieldValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  stringValue?: string;
  arrayValue?: { values?: FirestoreFieldValue[] };
  mapValue?: { fields?: Record<string, FirestoreFieldValue> };
}

interface FirestoreDocResponse {
  name?: string;
  fields?: Record<string, FirestoreFieldValue>;
}

const FIREBASE_CONFIG = {
  apiKey: firebaseAppletConfig.apiKey,
  projectId: firebaseAppletConfig.projectId,
  firestoreDatabaseId:
    firebaseAppletConfig.firestoreDatabaseId || '(default)',
};

function resolveClientTargetEnv(): 'development' | 'production' {
  if (typeof window === 'undefined') return 'development';
  const host = window.location.hostname.toLowerCase();
  if (host.startsWith('ais-pre-')) return 'production';
  if (
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    !host.startsWith('ais-dev-')
  ) {
    return 'production';
  }
  return 'development';
}

function resolveClientOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'https://ais-pre-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app';
}

function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i += 1) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

let memorySession: ClientFirebaseSession | null = null;
const memoryPendingVerify = new Map<string, PendingVerifyRecord>();

function loadStoredSession(): ClientFirebaseSession | null {
  if (memorySession) return memorySession;
  if (typeof window === 'undefined') return null;
  try {
    const raw =
      window.sessionStorage.getItem(CLIENT_SESSION_STORAGE_KEY) ||
      window.localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClientFirebaseSession>;
    if (
      parsed &&
      typeof parsed.idToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.uid === 'string' &&
      typeof parsed.email === 'string'
    ) {
      memorySession = {
        idToken: parsed.idToken,
        refreshToken: parsed.refreshToken,
        uid: parsed.uid,
        email: parsed.email.toLowerCase(),
        fullName: parsed.fullName || 'Member',
        emailVerified: Boolean(parsed.emailVerified),
        lastReauthAt: Number(parsed.lastReauthAt || Date.now()),
        issuedAt: Number(parsed.issuedAt || Date.now()),
        expiresAtMs: Number(parsed.expiresAtMs || Date.now() + 3600_000),
        csrfToken: parsed.csrfToken || randomHex(16),
      };
      return memorySession;
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function saveStoredSession(session: ClientFirebaseSession | null): void {
  memorySession = session;
  if (typeof window === 'undefined') return;
  try {
    if (!session) {
      window.sessionStorage.removeItem(CLIENT_SESSION_STORAGE_KEY);
      window.localStorage.removeItem(CLIENT_SESSION_STORAGE_KEY);
    } else {
      const serialized = JSON.stringify(session);
      window.sessionStorage.setItem(CLIENT_SESSION_STORAGE_KEY, serialized);
      window.localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, serialized);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function clearClientFirebaseSession(): void {
  saveStoredSession(null);
}

function getPendingVerify(email: string): PendingVerifyRecord | null {
  const clean = email.trim().toLowerCase();
  const mem = memoryPendingVerify.get(clean);
  if (mem) return mem;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${CLIENT_PENDING_VERIFY_KEY}:${clean}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingVerifyRecord;
    if (parsed && typeof parsed.idToken === 'string') {
      memoryPendingVerify.set(clean, parsed);
      return parsed;
    }
  } catch {
    // Ignore
  }
  return null;
}

function setPendingVerify(email: string, record: PendingVerifyRecord): void {
  const clean = email.trim().toLowerCase();
  memoryPendingVerify.set(clean, record);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      `${CLIENT_PENDING_VERIFY_KEY}:${clean}`,
      JSON.stringify(record)
    );
  } catch {
    // Ignore
  }
}

function toFirestoreValue(val: unknown): FirestoreFieldValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFirestoreValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreFieldValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(field: FirestoreFieldValue | undefined): unknown {
  if (!field) return null;
  if ('nullValue' in field) return null;
  if ('booleanValue' in field) return Boolean(field.booleanValue);
  if ('integerValue' in field) return Number(field.integerValue);
  if ('doubleValue' in field) return Number(field.doubleValue);
  if ('stringValue' in field) return String(field.stringValue ?? '');
  if ('arrayValue' in field) {
    return (field.arrayValue?.values ?? []).map((v) => fromFirestoreValue(v));
  }
  if ('mapValue' in field) {
    const out: Record<string, unknown> = {};
    const fields = field.mapValue?.fields ?? {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function docToRecord<T>(doc: FirestoreDocResponse | null): T | null {
  if (!doc || !doc.fields) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    out[k] = fromFirestoreValue(v);
  }
  return out as T;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(
            Array.from(atob(padded))
              .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
              .join('')
          )
        : Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractOobCodeClient(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const code = parsed.searchParams.get('oobCode') || parsed.searchParams.get('token');
      if (code) return code.trim();
    } catch {
      // Fall through
    }
  }
  return trimmed;
}

class ClientFirebaseError extends Error {
  readonly httpStatus: number;
  readonly code: string;

  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function mapFirebaseAuthError(rawMessage: string): ClientFirebaseError {
  const code = (rawMessage || 'UNKNOWN').split(' : ')[0].trim();
  switch (code) {
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS':
      return new ClientFirebaseError(
        401,
        'INVALID_CREDENTIALS',
        'Invalid email or password.'
      );
    case 'USER_DISABLED':
      return new ClientFirebaseError(
        403,
        'ACCOUNT_DISABLED',
        'This account has been disabled.'
      );
    case 'EMAIL_EXISTS':
      return new ClientFirebaseError(
        409,
        'EMAIL_EXISTS',
        'An account with this email address already exists.'
      );
    case 'OPERATION_NOT_ALLOWED':
    case 'ADMIN_ONLY_OPERATION':
      return new ClientFirebaseError(
        503,
        'AUTH_PROVIDER_DISABLED',
        'Email/Password sign-in is currently disabled in Firebase Console for this project. Enable Authentication → Sign-in method → Email/Password in Firebase Console.'
      );
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
    case 'RESET_PASSWORD_EXCEED_LIMIT':
      return new ClientFirebaseError(
        429,
        'RATE_LIMITED',
        'Too many authentication attempts. Please wait a few minutes before trying again.'
      );
    case 'EXPIRED_OOB_CODE':
      return new ClientFirebaseError(
        400,
        'TOKEN_EXPIRED',
        'This verification or password reset link has expired. Please request a new link.'
      );
    case 'INVALID_OOB_CODE':
      return new ClientFirebaseError(
        400,
        'TOKEN_INVALID',
        'This verification or password reset link is invalid or has already been used.'
      );
    case 'WEAK_PASSWORD':
      return new ClientFirebaseError(
        400,
        'VALIDATION_ERROR',
        'Password must be at least 8 characters long.'
      );
    case 'UNAUTHORIZED_DOMAIN':
    case 'INVALID_CONTINUE_URI':
    case 'MISSING_CONTINUE_URI':
      return new ClientFirebaseError(
        503,
        'CONTINUE_URI_REJECTED',
        `Firebase Authentication rejected the callback URL (${ code }).`
      );
    default:
      return new ClientFirebaseError(
        400,
        code || 'AUTH_ERROR',
        'Unable to complete authentication request. Please check your details and try again.'
      );
  }
}

async function callIdentityToolkit<T>(
  endpoint: string,
  payload: Record<string, unknown>
): Promise<T> {
  const url = `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(
    FIREBASE_CONFIG.apiKey
  )}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  } & T;
  if (!res.ok || data.error) {
    throw mapFirebaseAuthError(data.error?.message || `HTTP_${res.status}`);
  }
  return data;
}

async function sendOobEmailWithFallback(params: {
  requestType: 'VERIFY_EMAIL' | 'PASSWORD_RESET';
  idToken?: string;
  email?: string;
  continueUrl?: string;
}): Promise<void> {
  const basePayload: Record<string, unknown> = {
    requestType: params.requestType,
    ...(params.idToken ? { idToken: params.idToken } : {}),
    ...(params.email ? { email: params.email } : {}),
  };

  if (params.continueUrl) {
    try {
      await callIdentityToolkit('accounts:sendOobCode', {
        ...basePayload,
        continueUrl: params.continueUrl,
      });
      return;
    } catch (err) {
      if (
        !(err instanceof ClientFirebaseError) ||
        err.code !== 'CONTINUE_URI_REJECTED'
      ) {
        throw err;
      }
    }
  }
  await callIdentityToolkit('accounts:sendOobCode', basePayload);
}

async function lookupFirebaseAccount(idToken: string): Promise<{
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  expiresAtMs: number;
} | null> {
  try {
    const data = await callIdentityToolkit<{
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        displayName?: string;
      }>;
    }>('accounts:lookup', { idToken });
    const account = data.users?.[0];
    if (!account || !account.localId) return null;
    const jwt = decodeJwtPayload(idToken);
    const expSec = Number(jwt?.exp || 0);
    return {
      uid: account.localId,
      email: (account.email || '').toLowerCase(),
      emailVerified: Boolean(account.emailVerified),
      displayName: account.displayName || '',
      expiresAtMs: expSec > 0 ? expSec * 1000 : Date.now() + 3600_000,
    };
  } catch {
    return null;
  }
}

async function refreshClientIdToken(refreshToken: string): Promise<{
  idToken: string;
  refreshToken: string;
  expiresAtMs: number;
} | null> {
  try {
    const url = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(
      FIREBASE_CONFIG.apiKey
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id_token?: string;
      refresh_token?: string;
      expires_in?: string;
    };
    if (!data.id_token) return null;
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAtMs: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
  } catch {
    return null;
  }
}

async function getValidClientSession(): Promise<ClientFirebaseSession | null> {
  const session = loadStoredSession();
  if (!session) return null;

  let active = session;
  if (Date.now() > active.expiresAtMs - 60_000) {
    const refreshed = await refreshClientIdToken(active.refreshToken);
    if (!refreshed) {
      clearClientFirebaseSession();
      return null;
    }
    active = {
      ...active,
      idToken: refreshed.idToken,
      refreshToken: refreshed.refreshToken,
      expiresAtMs: refreshed.expiresAtMs,
    };
    saveStoredSession(active);
  }

  const verified = await lookupFirebaseAccount(active.idToken);
  if (!verified || !verified.emailVerified) {
    clearClientFirebaseSession();
    return null;
  }

  active = {
    ...active,
    email: verified.email,
    emailVerified: verified.emailVerified,
    fullName: verified.displayName || active.fullName,
    expiresAtMs: verified.expiresAtMs,
  };
  saveStoredSession(active);
  return active;
}

function buildPublicAuthUser(session: ClientFirebaseSession): AuthUser {
  const reauthExpiresAt = session.lastReauthAt + REAUTH_WINDOW_MS;
  const isOwner =
    session.emailVerified &&
    session.email.toLowerCase() === AUTHORIZED_OWNER_EMAIL;
  return {
    id: session.uid,
    fullName: session.fullName || (isOwner ? 'Store Owner' : 'Member'),
    email: session.email,
    emailVerified: session.emailVerified,
    hasPassword: true,
    isOwner,
    recentReauthValid: Date.now() < reauthExpiresAt,
    recentReauthExpiresAt: reauthExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Direct Firestore REST Helpers
// ---------------------------------------------------------------------------

function firestoreBaseUrl(): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    FIREBASE_CONFIG.projectId
  )}/databases/${encodeURIComponent(
    FIREBASE_CONFIG.firestoreDatabaseId
  )}/documents/environments/${encodeURIComponent(resolveClientTargetEnv())}`;
}

async function firestoreGetDoc<T>(
  collectionName: string,
  docId: string,
  idToken?: string
): Promise<T | null> {
  const url = `${firestoreBaseUrl()}/${collectionName}/${encodeURIComponent(docId)}`;
  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const doc = (await res.json()) as FirestoreDocResponse;
  return docToRecord<T>(doc);
}

async function firestoreSetDoc(
  collectionName: string,
  docId: string,
  data: Record<string, unknown>,
  idToken?: string
): Promise<boolean> {
  const url = `${firestoreBaseUrl()}/${collectionName}/${encodeURIComponent(docId)}`;
  const fields: Record<string, FirestoreFieldValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields }),
  });
  return res.ok;
}

async function firestoreDeleteDoc(
  collectionName: string,
  docId: string,
  idToken?: string
): Promise<boolean> {
  const url = `${firestoreBaseUrl()}/${collectionName}/${encodeURIComponent(docId)}`;
  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { method: 'DELETE', headers });
  return res.ok || res.status === 404;
}

async function firestoreListDocs<T>(
  collectionName: string,
  idToken?: string
): Promise<T[]> {
  const url = `${firestoreBaseUrl()}/${collectionName}?pageSize=300`;
  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (!res.ok) return [];
  const data = (await res.json()) as { documents?: FirestoreDocResponse[] };
  return (data.documents ?? [])
    .map((d) => docToRecord<T>(d))
    .filter((item): item is T => item !== null);
}

interface StoredProductDoc {
  id: string;
  sku: string;
  slug: string;
  title: string;
  description: string;
  fabric_note: string;
  category: string;
  status: 'draft' | 'active' | 'archived';
  featured: number;
  price_paise: number;
  compare_at_paise: number | null;
  stock_qty: number;
  low_stock_threshold: number;
  colors_json: string;
  sizes_json: string;
  version: number;
  published_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  variants?: Array<{
    id: string;
    product_id: string;
    sku: string;
    size: string;
    color_name: string;
    color_hex: string;
    price_paise: number;
    compare_at_paise: number | null;
    stock_qty: number;
    position: number;
    created_at: number;
    updated_at: number;
  }>;
  images?: Array<{
    id: string;
    product_id: string;
    url: string;
    alt_text: string;
    is_cover: number;
    position: number;
    created_at: number;
  }>;
}

function buildSeedProductsDocs(): StoredProductDoc[] {
  return [];
}

function formatProductDto(doc: StoredProductDoc, includeAdmin = false) {
  const variants = Array.isArray(doc.variants) ? doc.variants : [];
  const images = Array.isArray(doc.images) ? doc.images : [];
  const totalStock =
    variants.length > 0
      ? variants.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0)
      : Number(doc.stock_qty || 0);
  const effectivePricePaise =
    variants.length > 0
      ? Math.min(...variants.map((v) => Number(v.price_paise || doc.price_paise)))
      : Number(doc.price_paise || 0);
  const minVariant =
    variants.find((v) => Number(v.price_paise) === effectivePricePaise) ||
    variants[0] ||
    null;
  const effectiveComparePaise = minVariant
    ? minVariant.compare_at_paise
    : doc.compare_at_paise;

  let colors: Array<{ name: string; hex: string }> = [];
  let sizes: string[] = [];
  try {
    colors = JSON.parse(doc.colors_json || '[]') as Array<{ name: string; hex: string }>;
  } catch {
    colors = [];
  }
  try {
    sizes = JSON.parse(doc.sizes_json || '[]') as string[];
  } catch {
    sizes = [];
  }

  const dateSource = doc.published_at || doc.created_at || Date.now();
  const dateAdded = new Date(dateSource).toISOString().slice(0, 10);

  const pub = {
    id: doc.id,
    slug: doc.slug,
    name: doc.title,
    category: doc.category || 'Dresses',
    pricePaise: effectivePricePaise,
    compareAtPaise: effectiveComparePaise,
    price: Number((effectivePricePaise / 100).toFixed(2)),
    compareAtPrice:
      effectiveComparePaise !== null && effectiveComparePaise !== undefined
        ? Number((Number(effectiveComparePaise) / 100).toFixed(2))
        : null,
    description: doc.description || '',
    fabricNote: doc.fabric_note || '',
    stockQty: totalStock,
    lowStockThreshold: Number(doc.low_stock_threshold ?? 2),
    inStock: totalStock > 0,
    images: images.map((img) => ({
      src: img.url,
      alt: img.alt_text || doc.title,
      isCover: Boolean(img.is_cover),
    })),
    colors,
    sizes,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      size: v.size,
      colorName: v.color_name,
      colorHex: v.color_hex,
      pricePaise: Number(v.price_paise),
      compareAtPaise: v.compare_at_paise,
      stockQty: Number(v.stock_qty),
      position: Number(v.position),
    })),
    featured: Boolean(doc.featured),
    dateAdded,
    updatedAt: Number(doc.updated_at || Date.now()),
  };

  if (!includeAdmin) return pub;
  return {
    ...pub,
    sku: doc.sku,
    status: doc.status || 'active',
    version: Number(doc.version || 1),
    publishedAt: doc.published_at,
    archivedAt: doc.archived_at,
    createdAt: Number(doc.created_at || Date.now()),
    orderCount: 0,
    rawImages: images.map((img) => ({
      id: img.id,
      url: img.url,
      alt: img.alt_text || doc.title,
      isCover: Boolean(img.is_cover),
      position: Number(img.position || 0),
    })),
  };
}

async function ensureCompletedClientSignIn(params: {
  email: string;
  password: string;
  requireOwner: boolean;
}): Promise<ApiResult<{
  csrfToken: string;
  user: AuthUser;
  ownerBinding?: { boundAt: number; boundVia: string };
}>> {
  const email = params.email.trim().toLowerCase();
  const password = params.password;

  if (!EMAIL_REGEX.test(email) || !password) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: params.requireOwner
        ? 'Please enter your owner email and password.'
        : 'Please enter a valid email address and password.',
    };
  }

  if (params.requireOwner && email !== AUTHORIZED_OWNER_EMAIL) {
    return {
      ok: false,
      status: 403,
      code: 'OWNER_FORBIDDEN',
      error: 'This account does not have store owner permissions.',
    };
  }

  let signIn: {
    idToken: string;
    refreshToken: string;
    localId: string;
    email: string;
    displayName?: string;
    expiresIn?: string;
  };
  try {
    signIn = await callIdentityToolkit('accounts:signInWithPassword', {
      email,
      password,
      returnSecureToken: true,
    });
  } catch (err) {
    if (err instanceof ClientFirebaseError) {
      return { ok: false, status: err.httpStatus, code: err.code, error: err.message };
    }
    return {
      ok: false,
      status: 500,
      code: 'AUTH_ERROR',
      error: 'Unable to complete sign-in right now. Please try again.',
    };
  }

  const account = await lookupFirebaseAccount(signIn.idToken);
  if (!account) {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_CREDENTIALS',
      error: 'Unable to verify your login token. Please try again.',
    };
  }

  if (!account.emailVerified) {
    const existing = getPendingVerify(email);
    setPendingVerify(email, {
      idToken: signIn.idToken,
      lastSentAt: existing?.lastSentAt ?? 0,
      expiresAt: Date.now() + 30 * 60_000,
    });
    return {
      ok: false,
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
      error: params.requireOwner
        ? 'Your owner email is not yet verified. Open the verification link sent to your inbox or click Resend verification email below.'
        : 'Your email address is not yet verified. Open the verification link in your inbox or resend a fresh link.',
    };
  }

  const now = Date.now();
  const isOwner = account.email === AUTHORIZED_OWNER_EMAIL && account.emailVerified;
  const fullName =
    account.displayName ||
    signIn.displayName ||
    (isOwner ? 'Store Owner' : 'Member');

  // Sync user profile and owner binding in Firestore using the user's verified Firebase idToken
  await firestoreSetDoc(
    'users',
    account.uid,
    {
      id: account.uid,
      full_name: fullName,
      email: account.email,
      email_verified: 1,
      password_hash: 'firebase-managed',
      phone_e164: null,
      phone_verified: 0,
      created_at: now,
      updated_at: now,
    },
    signIn.idToken
  ).catch(() => false);

  let boundAt = now;
  const boundVia = 'firebase_verified_owner';
  if (isOwner) {
    const existingBinding = await firestoreGetDoc<{
      owner_user_id?: string;
      bound_at?: number;
    }>('settings', 'admin_binding', signIn.idToken);
    if (existingBinding?.bound_at) {
      boundAt = Number(existingBinding.bound_at);
    } else {
      await firestoreSetDoc(
        'settings',
        'admin_binding',
        {
          singleton: 1,
          owner_email: account.email,
          owner_user_id: account.uid,
          bound_at: now,
          bound_via: boundVia,
          updated_at: now,
        },
        signIn.idToken
      ).catch(() => false);
    }
  }

  const session: ClientFirebaseSession = {
    idToken: signIn.idToken,
    refreshToken: signIn.refreshToken,
    uid: account.uid,
    email: account.email,
    fullName,
    emailVerified: true,
    lastReauthAt: now,
    issuedAt: now,
    expiresAtMs: account.expiresAtMs,
    csrfToken: randomHex(16),
  };
  saveStoredSession(session);

  return {
    ok: true,
    data: {
      csrfToken: session.csrfToken,
      user: buildPublicAuthUser(session),
      ...(isOwner ? { ownerBinding: { boundAt, boundVia } } : {}),
    },
  };
}

export async function handleClientlessApiRequest<T>(
  rawPath: string,
  method: string,
  rawBody?: unknown
): Promise<ApiResult<T>> {
  const upperMethod = (method || 'GET').toUpperCase();
  const [pathname] = rawPath.split('?');
  const cleanPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  let body: Record<string, unknown> = {};
  if (typeof rawBody === 'string' && rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      body = {};
    }
  } else if (rawBody && typeof rawBody === 'object' && !(rawBody instanceof FormData)) {
    body = rawBody as Record<string, unknown>;
  }

  try {
    // 1. Capabilities
    if (cleanPath === '/api/auth/capabilities' && upperMethod === 'GET') {
      const capabilities: AuthCapabilities = {
        authMode: 'firebase_managed',
        firebaseProjectId: FIREBASE_CONFIG.projectId,
        emailPasswordEnabled: true,
        providerStatusReason: null,
        emailDeliveryConfigured: true,
        passwordMinLength: PASSWORD_MIN_LENGTH,
        environmentTarget: resolveClientTargetEnv(),
        databaseBackend: 'firestore',
      };
      return { ok: true, data: capabilities as unknown as T };
    }

    // 2. Public Auth Session
    if (cleanPath === '/api/auth/session' && upperMethod === 'GET') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: true,
          data: {
            authenticated: false,
            csrfToken: randomHex(16),
            user: null,
          } as unknown as T,
        };
      }
      return {
        ok: true,
        data: {
          authenticated: true,
          csrfToken: session.csrfToken,
          user: buildPublicAuthUser(session),
        } as unknown as T,
      };
    }

    // 3. Customer Login & Owner Login
    if (cleanPath === '/api/auth/login' && upperMethod === 'POST') {
      const res = await ensureCompletedClientSignIn({
        email: typeof body.email === 'string' ? body.email : '',
        password: typeof body.password === 'string' ? body.password : '',
        requireOwner: false,
      });
      return res as unknown as ApiResult<T>;
    }

    if (cleanPath === '/api/admin/login' && upperMethod === 'POST') {
      const res = await ensureCompletedClientSignIn({
        email: typeof body.email === 'string' ? body.email : '',
        password: typeof body.password === 'string' ? body.password : '',
        requireOwner: true,
      });
      return res as unknown as ApiResult<T>;
    }

    // 4. Logout
    if (cleanPath === '/api/auth/logout' && upperMethod === 'POST') {
      clearClientFirebaseSession();
      return {
        ok: true,
        data: {
          csrfToken: randomHex(16),
          message: 'Signed out successfully.',
        } as unknown as T,
      };
    }

    // 5. Customer Registration
    if (cleanPath === '/api/auth/register' && upperMethod === 'POST') {
      const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const confirmPassword =
        typeof body.confirmPassword === 'string' ? body.confirmPassword : password;

      if (fullName.length < 2 || fullName.length > 100) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please enter your full name (2–100 characters).',
        };
      }
      if (!EMAIL_REGEX.test(email)) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please enter a valid email address.',
        };
      }
      if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`,
        };
      }
      if (confirmPassword !== password) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Password and confirmation password do not match.',
        };
      }

      try {
        const created = await callIdentityToolkit<{
          idToken: string;
          refreshToken: string;
          localId: string;
          email: string;
        }>('accounts:signUp', {
          email,
          password,
          displayName: fullName,
          returnSecureToken: true,
        });

        const now = Date.now();
        await sendOobEmailWithFallback({
          requestType: 'VERIFY_EMAIL',
          idToken: created.idToken,
          continueUrl: `${resolveClientOrigin()}/login`,
        });

        setPendingVerify(email, {
          idToken: created.idToken,
          lastSentAt: now,
          expiresAt: now + 30 * 60_000,
        });

        return {
          ok: true,
          data: {
            acceptedByProvider: true,
            cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
            message:
              'Account created and Firebase Authentication accepted the verification email request. Check your inbox and spam folder to confirm your email address (provider acceptance does not prove inbox delivery).',
          } as unknown as T,
        };
      } catch (err) {
        if (err instanceof ClientFirebaseError && err.code === 'EMAIL_EXISTS') {
          return {
            ok: true,
            data: {
              message:
                'If this email is eligible for registration, a verification link has been requested. If you already created an account earlier, sign in or use Forgot Password instead.',
            } as unknown as T,
          };
        }
        if (err instanceof ClientFirebaseError) {
          return { ok: false, status: err.httpStatus, code: err.code, error: err.message };
        }
        throw err;
      }
    }

    // 6. Owner Activation
    if (cleanPath === '/api/admin/activate' && upperMethod === 'POST') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const confirmPassword =
        typeof body.confirmPassword === 'string' ? body.confirmPassword : password;

      if (!EMAIL_REGEX.test(email)) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please enter a valid owner email address.',
        };
      }
      if (email !== AUTHORIZED_OWNER_EMAIL) {
        return {
          ok: false,
          status: 403,
          code: 'OWNER_FORBIDDEN',
          error: 'Only the authorized boutique owner email can activate studio access.',
        };
      }
      if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: `Owner password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`,
        };
      }
      if (password !== confirmPassword) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Password and confirmation password do not match.',
        };
      }

      try {
        const created = await callIdentityToolkit<{
          idToken: string;
          refreshToken: string;
          localId: string;
          email: string;
        }>('accounts:signUp', {
          email,
          password,
          displayName: 'Store Owner',
          returnSecureToken: true,
        });
        const now = Date.now();
        await sendOobEmailWithFallback({
          requestType: 'VERIFY_EMAIL',
          idToken: created.idToken,
          continueUrl: `${resolveClientOrigin()}/admin/login`,
        });
        setPendingVerify(email, {
          idToken: created.idToken,
          lastSentAt: now,
          expiresAt: now + 30 * 60_000,
        });
        return {
          ok: true,
          data: {
            requiresVerification: true,
            acceptedByProvider: true,
            cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
            email,
            message:
              'Owner account created and Firebase Authentication accepted the verification email request. Check your inbox and spam folder, click the link to verify, then sign in here (provider acceptance does not prove inbox delivery).',
          } as unknown as T,
        };
      } catch (err) {
        if (err instanceof ClientFirebaseError && err.code === 'EMAIL_EXISTS') {
          return {
            ok: false,
            status: 409,
            code: 'ACCOUNT_EXISTS',
            error:
              'An owner account already exists for this email address. Switch to Sign In or use Forgot Password to reset your password.',
          };
        }
        if (err instanceof ClientFirebaseError) {
          return { ok: false, status: err.httpStatus, code: err.code, error: err.message };
        }
        throw err;
      }
    }

    // 7. Resend Verification (Customer & Owner)
    if (
      (cleanPath === '/api/auth/resend-verification' ||
        cleanPath === '/api/admin/resend-verification') &&
      upperMethod === 'POST'
    ) {
      const isAdminRoute = cleanPath === '/api/admin/resend-verification';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!EMAIL_REGEX.test(email)) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please enter a valid email address.',
        };
      }
      if (isAdminRoute && email !== AUTHORIZED_OWNER_EMAIL) {
        return {
          ok: false,
          status: 403,
          code: 'OWNER_FORBIDDEN',
          error: 'Verification resend on this endpoint is restricted to the authorized owner email.',
        };
      }

      const now = Date.now();
      const pending = getPendingVerify(email);
      if (
        pending &&
        pending.lastSentAt > 0 &&
        now - pending.lastSentAt < VERIFY_RESEND_COOLDOWN_MS
      ) {
        const waitSec = Math.ceil(
          (VERIFY_RESEND_COOLDOWN_MS - (now - pending.lastSentAt)) / 1000
        );
        return {
          ok: false,
          status: 429,
          code: 'RESEND_COOLDOWN',
          retryAfterSeconds: waitSec,
          error: `Please wait ${waitSec} seconds before requesting another verification email.`,
        };
      }

      let idTokenToUse = pending && now < pending.expiresAt ? pending.idToken : '';
      if (!idTokenToUse && password) {
        const signIn = await callIdentityToolkit<{ idToken: string }>(
          'accounts:signInWithPassword',
          {
            email,
            password,
            returnSecureToken: true,
          }
        );
        const lookedUp = await lookupFirebaseAccount(signIn.idToken);
        if (lookedUp?.emailVerified) {
          return {
            ok: true,
            data: {
              alreadyVerified: true,
              message:
                'Your email address is already verified. You can sign in with your password now.',
            } as unknown as T,
          };
        }
        idTokenToUse = signIn.idToken;
      }

      if (!idTokenToUse) {
        return {
          ok: false,
          status: 400,
          code: 'PASSWORD_REQUIRED_FOR_RESEND',
          error:
            'Enter your password and click Resend verification email so we can verify your account and issue a fresh verification link.',
        };
      }

      await sendOobEmailWithFallback({
        requestType: 'VERIFY_EMAIL',
        idToken: idTokenToUse,
        continueUrl: `${resolveClientOrigin()}${isAdminRoute ? '/admin/login' : '/login'}`,
      });
      setPendingVerify(email, {
        idToken: idTokenToUse,
        lastSentAt: now,
        expiresAt: now + 30 * 60_000,
      });

      return {
        ok: true,
        data: {
          acceptedByProvider: true,
          cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
          message:
            'Verification email request accepted by Firebase Authentication. Please check your inbox and spam folder (note: provider acceptance does not prove inbox delivery).',
        } as unknown as T,
      };
    }

    // 8. Confirm Email Verification (Customer & Owner)
    if (
      (cleanPath === '/api/auth/verify-email' ||
        cleanPath === '/api/admin/activate/confirm') &&
      upperMethod === 'POST'
    ) {
      const rawCode =
        typeof body.token === 'string'
          ? body.token
          : typeof body.oobCode === 'string'
            ? body.oobCode
            : '';
      const oobCode = extractOobCodeClient(rawCode);
      if (!oobCode) {
        return {
          ok: false,
          status: 400,
          code: 'TOKEN_MISSING',
          error: 'Verification code is missing.',
        };
      }

      const confirmed = await callIdentityToolkit<{ email?: string }>('accounts:update', {
        oobCode,
      });
      const verifiedEmail = (confirmed.email || '').toLowerCase();
      if (
        cleanPath === '/api/admin/activate/confirm' &&
        verifiedEmail !== AUTHORIZED_OWNER_EMAIL
      ) {
        return {
          ok: false,
          status: 403,
          code: 'OWNER_FORBIDDEN',
          error: 'Verification code does not match the authorized owner email.',
        };
      }

      return {
        ok: true,
        data: {
          verified: true,
          email: verifiedEmail,
          verifiedEmail,
          purpose: 'verify_email',
          message: `Email address (${verifiedEmail}) verified. You can now sign in with your password.`,
        } as unknown as T,
      };
    }

    // 9. Forgot Password (Customer & Owner)
    if (
      (cleanPath === '/api/auth/forgot-password' ||
        cleanPath === '/api/admin/forgot-password') &&
      upperMethod === 'POST'
    ) {
      const isAdminRoute = cleanPath === '/api/admin/forgot-password';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!EMAIL_REGEX.test(email)) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please enter a valid email address.',
        };
      }

      if (!isAdminRoute || email === AUTHORIZED_OWNER_EMAIL) {
        await sendOobEmailWithFallback({
          requestType: 'PASSWORD_RESET',
          email,
          continueUrl: `${resolveClientOrigin()}${isAdminRoute ? '/admin/login' : '/login'}`,
        });
      }

      return {
        ok: true,
        data: {
          acceptedByProvider: !isAdminRoute || email === AUTHORIZED_OWNER_EMAIL,
          message:
            'If a registered email/password account exists for that address, Firebase Authentication accepted the password reset request. Please check your inbox and spam folder (note: provider acceptance alone does not guarantee inbox delivery).',
        } as unknown as T,
      };
    }

    // 10. Reset Password Confirmation (Customer & Owner)
    if (
      (cleanPath === '/api/auth/reset-password' ||
        cleanPath === '/api/admin/password-reset/confirm') &&
      upperMethod === 'POST'
    ) {
      const rawCode =
        typeof body.token === 'string'
          ? body.token
          : typeof body.oobCode === 'string'
            ? body.oobCode
            : '';
      const newPassword = typeof body.password === 'string' ? body.password : '';
      const oobCode = extractOobCodeClient(rawCode);
      if (!oobCode) {
        return {
          ok: false,
          status: 400,
          code: 'TOKEN_MISSING',
          error: 'Password reset code is missing.',
        };
      }
      if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 128) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: `New password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`,
        };
      }

      await callIdentityToolkit('accounts:resetPassword', {
        oobCode,
        newPassword,
      });
      clearClientFirebaseSession();
      return {
        ok: true,
        data: {
          csrfToken: randomHex(16),
          message: 'Your password has been updated. Please sign in with your new password.',
        } as unknown as T,
      };
    }

    // 11. Admin Session Check
    if (cleanPath === '/api/admin/session' && upperMethod === 'GET') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'ADMIN_AUTH_REQUIRED',
          error: 'Owner authentication is required to access the studio portal.',
        };
      }
      if (!session.emailVerified || session.email !== AUTHORIZED_OWNER_EMAIL) {
        return {
          ok: false,
          status: 403,
          code: 'OWNER_FORBIDDEN',
          error: 'Access denied. Only the verified store owner account may access this portal.',
        };
      }
      return {
        ok: true,
        data: {
          authenticated: true,
          isOwner: true,
          user: buildPublicAuthUser(session),
          ownerBinding: {
            boundAt: session.issuedAt,
            boundVia: 'firebase_verified_owner',
          },
        } as unknown as T,
      };
    }

    // 12. Customer Account Profile & Security
    if (cleanPath === '/api/account/profile') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      if (upperMethod === 'GET') {
        return {
          ok: true,
          data: { user: buildPublicAuthUser(session) } as unknown as T,
        };
      }
      if (upperMethod === 'PATCH') {
        const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
        if (fullName.length < 2 || fullName.length > 100) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: 'Please enter a valid full name (2–100 characters).',
          };
        }
        await callIdentityToolkit('accounts:update', {
          idToken: session.idToken,
          displayName: fullName,
          returnSecureToken: false,
        }).catch(() => undefined);
        const updatedSession: ClientFirebaseSession = {
          ...session,
          fullName,
        };
        saveStoredSession(updatedSession);
        await firestoreSetDoc(
          'users',
          session.uid,
          {
            id: session.uid,
            full_name: fullName,
            email: session.email,
            email_verified: 1,
            password_hash: 'firebase-managed',
            updated_at: Date.now(),
          },
          session.idToken
        ).catch(() => false);
        return {
          ok: true,
          data: { user: buildPublicAuthUser(updatedSession) } as unknown as T,
        };
      }
    }

    if (cleanPath === '/api/account/reauthenticate' && upperMethod === 'POST') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Current password is required.',
        };
      }
      const signIn = await callIdentityToolkit<{
        idToken: string;
        refreshToken: string;
      }>('accounts:signInWithPassword', {
        email: session.email,
        password,
        returnSecureToken: true,
      });
      const updated: ClientFirebaseSession = {
        ...session,
        idToken: signIn.idToken,
        refreshToken: signIn.refreshToken,
        lastReauthAt: Date.now(),
      };
      saveStoredSession(updated);
      return {
        ok: true,
        data: {
          message: 'Identity reauthenticated.',
          user: buildPublicAuthUser(updated),
        } as unknown as T,
      };
    }

    if (cleanPath === '/api/account/change-password' && upperMethod === 'POST') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      if (Date.now() - session.lastReauthAt > REAUTH_WINDOW_MS) {
        return {
          ok: false,
          status: 403,
          code: 'REAUTH_REQUIRED',
          error: 'Please verify your current password before updating login details.',
        };
      }
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 128) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`,
        };
      }
      const resTokens = await callIdentityToolkit<{
        idToken: string;
        refreshToken: string;
      }>('accounts:update', {
        idToken: session.idToken,
        password: newPassword,
        returnSecureToken: true,
      });
      const updated: ClientFirebaseSession = {
        ...session,
        idToken: resTokens.idToken,
        refreshToken: resTokens.refreshToken,
        lastReauthAt: Date.now(),
      };
      saveStoredSession(updated);
      return {
        ok: true,
        data: {
          message: 'Password updated successfully.',
          user: buildPublicAuthUser(updated),
        } as unknown as T,
      };
    }

    // 13. Public Storefront & Catalog Endpoints
    if (cleanPath === '/api/storefront' && upperMethod === 'GET') {
      const [settingsDoc, contentDoc, categoriesDocs] = await Promise.all([
        firestoreGetDoc<{ data?: unknown }>('settings', 'site_settings'),
        firestoreGetDoc<{ data?: unknown }>('settings', 'storefront_content'),
        firestoreListDocs<{
          id: string;
          name: string;
          slug: string;
          subtitle: string;
          image_url: string;
          alt_text: string;
          position: number;
        }>('categories'),
      ]);

      const settings = mergeSiteSettings(settingsDoc?.data ?? DEFAULT_SITE_SETTINGS);
      const content = mergeStorefrontContent(
        contentDoc?.data ?? DEFAULT_STOREFRONT_CONTENT
      );
      const categories =
        categoriesDocs.length > 0
          ? [...categoriesDocs]
              .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
              .map((c) => ({
                id: c.id,
                name: c.name,
                slug: c.slug,
                subtitle: c.subtitle || '',
                imageUrl: c.image_url || '',
                altText: c.alt_text || c.name,
                position: Number(c.position || 0),
              }))
          : INITIAL_SEED_CATEGORIES.map((c) => ({
              id: c.id,
              name: c.name,
              slug: c.slug,
              subtitle: c.subtitle,
              imageUrl: c.imageUrl,
              altText: c.altText,
              position: c.position,
            }));

      return {
        ok: true,
        data: { settings, content, categories } as unknown as T,
      };
    }

    if (cleanPath === '/api/products' && upperMethod === 'GET') {
      let docs = await firestoreListDocs<StoredProductDoc>('products');
      if (docs.length === 0) {
        docs = buildSeedProductsDocs();
      }
      const activeItems = docs
        .filter((d) => d.status === 'active')
        .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
        .map((d) => formatProductDto(d, false));
      return {
        ok: true,
        data: { items: activeItems } as unknown as T,
      };
    }

    // 14. Public Contact Enquiry
    if (cleanPath === '/api/contact' && upperMethod === 'POST') {
      const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const productInterest =
        typeof body.productInterest === 'string' ? body.productInterest.trim() : null;

      if (fullName.length < 2 || message.length < 5) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please enter your name and message.',
        };
      }
      const id = `msg_${Date.now().toString(36)}_${randomHex(4)}`;
      const now = Date.now();
      await firestoreSetDoc('contact_messages', id, {
        id,
        full_name: fullName,
        phone,
        email,
        product_interest: productInterest,
        message,
        status: 'new',
        admin_notes: '',
        created_at: now,
        updated_at: now,
      });
      return {
        ok: true,
        data: {
          id,
          message:
            'Thank you for reaching out to Sahithi Collections. Our boutique team has received your enquiry.',
        } as unknown as T,
      };
    }

    // 15. Protected Admin Dashboard Operations (Overview, Products, Categories, Content, Settings, Messages, Orders, Audit)
    if (cleanPath.startsWith('/api/admin/')) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'ADMIN_AUTH_REQUIRED',
          error: 'Owner authentication is required to access the studio portal.',
        };
      }
      if (!session.emailVerified || session.email !== AUTHORIZED_OWNER_EMAIL) {
        return {
          ok: false,
          status: 403,
          code: 'OWNER_FORBIDDEN',
          error: 'Access denied. Only the verified store owner account may access this portal.',
        };
      }

      const idToken = session.idToken;

      if (cleanPath === '/api/admin/overview' && upperMethod === 'GET') {
        let products = await firestoreListDocs<StoredProductDoc>('products', idToken);
        if (products.length === 0) {
          products = buildSeedProductsDocs();
          await Promise.all(
            products.map((p) =>
              firestoreSetDoc(
                'products',
                p.id,
                p as unknown as Record<string, unknown>,
                idToken
              )
            )
          );
        }
        const categories = await firestoreListDocs<{ id: string }>('categories', idToken);
        const messages = await firestoreListDocs<{ status?: string }>(
          'contact_messages',
          idToken
        );
        const orders = await firestoreListDocs<{
          status?: string;
          total_paise?: number;
        }>('orders', idToken);
        const auditLogs = await firestoreListDocs<{
          id: string;
          actor_email: string;
          action: string;
          entity_type: string;
          entity_id: string | null;
          summary: string;
          created_at: number;
        }>('admin_audit_log', idToken);

        const activeCount = products.filter((p) => p.status === 'active').length;
        const draftCount = products.filter((p) => p.status === 'draft').length;
        const archivedCount = products.filter((p) => p.status === 'archived').length;
        const lowStockCount = products.filter(
          (p) => p.status === 'active' && Number(p.stock_qty) <= Number(p.low_stock_threshold ?? 2)
        ).length;
        const outOfStockCount = products.filter(
          (p) => p.status === 'active' && Number(p.stock_qty) <= 0
        ).length;

        const paidOrders = orders.filter(
          (o) => o.status === 'paid' || o.status === 'fulfilled'
        );
        const totalRevenuePaise = paidOrders.reduce(
          (sum, o) => sum + Number(o.total_paise || 0),
          0
        );

        return {
          ok: true,
          data: {
            metrics: {
              totalProducts: products.length,
              activeProducts: activeCount,
              draftProducts: draftCount,
              archivedProducts: archivedCount,
              lowStockProducts: lowStockCount,
              outOfStockProducts: outOfStockCount,
              totalCategories: categories.length || INITIAL_SEED_CATEGORIES.length,
              totalOrders: orders.length,
              pendingOrders: orders.filter((o) => o.status === 'pending').length,
              totalRevenuePaise,
              totalRevenue: Number((totalRevenuePaise / 100).toFixed(2)),
              unreadMessages: messages.filter((m) => m.status === 'new').length,
              totalMessages: messages.length,
            },
            recentAudit: [...auditLogs]
              .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
              .slice(0, 12)
              .map((log) => ({
                id: log.id,
                actorEmail: log.actor_email,
                action: log.action,
                entityType: log.entity_type,
                entityId: log.entity_id,
                summary: log.summary,
                createdAt: Number(log.created_at || Date.now()),
              })),
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/products' && upperMethod === 'GET') {
        let docs = await firestoreListDocs<StoredProductDoc>('products', idToken);
        if (docs.length === 0) {
          docs = buildSeedProductsDocs();
        }
        return {
          ok: true,
          data: {
            items: docs
              .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
              .map((d) => formatProductDto(d, true)),
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/content') {
        if (upperMethod === 'GET') {
          const doc = await firestoreGetDoc<{ data?: unknown; updated_at?: number }>(
            'settings',
            'storefront_content',
            idToken
          );
          return {
            ok: true,
            data: {
              content: mergeStorefrontContent(doc?.data ?? DEFAULT_STOREFRONT_CONTENT),
              updatedAt: Number(doc?.updated_at || Date.now()),
            } as unknown as T,
          };
        }
        if (upperMethod === 'PUT') {
          const merged = mergeStorefrontContent(body.content ?? body);
          const now = Date.now();
          const saved = await firestoreSetDoc(
            'settings',
            'storefront_content',
            {
              singleton: 1,
              data: merged,
              updated_at: now,
              updated_by: session.uid,
            },
            idToken
          );
          if (!saved) {
            return {
              ok: false,
              status: 500,
              code: 'WRITE_FAILED',
              error: 'Failed to persist storefront content to Firestore.',
            };
          }
          return {
            ok: true,
            data: {
              content: merged,
              updatedAt: now,
              message: 'Storefront content saved.',
            } as unknown as T,
          };
        }
      }

      if (cleanPath === '/api/admin/settings') {
        if (upperMethod === 'GET') {
          const doc = await firestoreGetDoc<{ data?: unknown; updated_at?: number }>(
            'settings',
            'site_settings',
            idToken
          );
          return {
            ok: true,
            data: {
              settings: mergeSiteSettings(doc?.data ?? DEFAULT_SITE_SETTINGS),
              updatedAt: Number(doc?.updated_at || Date.now()),
            } as unknown as T,
          };
        }
        if (upperMethod === 'PUT') {
          const merged = mergeSiteSettings(body.settings ?? body);
          const now = Date.now();
          const saved = await firestoreSetDoc(
            'settings',
            'site_settings',
            {
              singleton: 1,
              data: merged,
              updated_at: now,
              updated_by: session.uid,
            },
            idToken
          );
          if (!saved) {
            return {
              ok: false,
              status: 500,
              code: 'WRITE_FAILED',
              error: 'Failed to persist site settings to Firestore.',
            };
          }
          return {
            ok: true,
            data: {
              settings: merged,
              updatedAt: now,
              message: 'Boutique settings saved.',
            } as unknown as T,
          };
        }
      }

      if (cleanPath === '/api/admin/categories' && upperMethod === 'GET') {
        const docs = await firestoreListDocs<{
          id: string;
          name: string;
          slug: string;
          subtitle: string;
          image_url: string;
          alt_text: string;
          position: number;
          created_at?: number;
          updated_at?: number;
        }>('categories', idToken);
        const list =
          docs.length > 0
            ? [...docs]
                .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
                .map((c) => ({
                  id: c.id,
                  name: c.name,
                  slug: c.slug,
                  subtitle: c.subtitle || '',
                  imageUrl: c.image_url || '',
                  altText: c.alt_text || c.name,
                  position: Number(c.position || 0),
                  createdAt: Number(c.created_at || Date.now()),
                  updatedAt: Number(c.updated_at || Date.now()),
                }))
            : INITIAL_SEED_CATEGORIES.map((c) => ({
                ...c,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              }));
        return { ok: true, data: { items: list } as unknown as T };
      }

      if (cleanPath === '/api/admin/messages' && upperMethod === 'GET') {
        const docs = await firestoreListDocs<{
          id: string;
          full_name: string;
          phone: string;
          email: string | null;
          product_interest: string | null;
          message: string;
          status: string;
          admin_notes: string;
          created_at: number;
          updated_at: number;
        }>('contact_messages', idToken);
        return {
          ok: true,
          data: {
            items: docs
              .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
              .map((m) => ({
                id: m.id,
                fullName: m.full_name,
                phone: m.phone,
                email: m.email,
                productInterest: m.product_interest,
                message: m.message,
                status: m.status || 'new',
                adminNotes: m.admin_notes || '',
                createdAt: Number(m.created_at || Date.now()),
                updatedAt: Number(m.updated_at || Date.now()),
              })),
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/orders' && upperMethod === 'GET') {
        const docs = await firestoreListDocs<{
          id: string;
          order_number: string;
          customer_name: string;
          customer_phone: string;
          customer_email: string | null;
          status: string;
          subtotal_paise: number;
          total_paise: number;
          notes: string | null;
          created_at: number;
          updated_at: number;
          items?: Array<{
            id: string;
            product_id: string;
            variant_id: string | null;
            title_snapshot: string;
            sku_snapshot: string;
            size_snapshot: string;
            color_snapshot: string;
            unit_price_paise: number;
            qty: number;
          }>;
        }>('orders', idToken);
        return {
          ok: true,
          data: {
            items: docs
              .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
              .map((o) => ({
                id: o.id,
                orderNumber: o.order_number,
                customerName: o.customer_name,
                customerPhone: o.customer_phone,
                customerEmail: o.customer_email,
                status: o.status,
                subtotalPaise: Number(o.subtotal_paise || 0),
                totalPaise: Number(o.total_paise || 0),
                subtotal: Number((Number(o.subtotal_paise || 0) / 100).toFixed(2)),
                total: Number((Number(o.total_paise || 0) / 100).toFixed(2)),
                notes: o.notes || '',
                createdAt: Number(o.created_at || Date.now()),
                updatedAt: Number(o.updated_at || Date.now()),
                items: (o.items ?? []).map((it) => ({
                  id: it.id,
                  productId: it.product_id,
                  variantId: it.variant_id,
                  titleSnapshot: it.title_snapshot,
                  skuSnapshot: it.sku_snapshot,
                  sizeSnapshot: it.size_snapshot,
                  colorSnapshot: it.color_snapshot,
                  unitPricePaise: Number(it.unit_price_paise || 0),
                  unitPrice: Number((Number(it.unit_price_paise || 0) / 100).toFixed(2)),
                  qty: Number(it.qty || 1),
                })),
              })),
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/audit' && upperMethod === 'GET') {
        const docs = await firestoreListDocs<{
          id: string;
          actor_email: string;
          action: string;
          entity_type: string;
          entity_id: string | null;
          summary: string;
          created_at: number;
        }>('admin_audit_log', idToken);
        return {
          ok: true,
          data: {
            items: docs
              .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
              .slice(0, 100)
              .map((log) => ({
                id: log.id,
                actorEmail: log.actor_email,
                action: log.action,
                entityType: log.entity_type,
                entityId: log.entity_id,
                summary: log.summary,
                createdAt: Number(log.created_at || Date.now()),
              })),
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/products' && upperMethod === 'POST') {
        const now = Date.now();
        const title = typeof body.title === 'string' ? body.title.trim() : 'New Piece';
        const id = `prod_${now.toString(36)}_${randomHex(3)}`;
        const slug =
          (typeof body.slug === 'string' && body.slug.trim()) ||
          title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
          id;
        const sku =
          (typeof body.sku === 'string' && body.sku.trim().toUpperCase()) ||
          `SC-${now.toString(36).toUpperCase()}`;
        const pricePaise = Math.max(100, Math.round(Number(body.pricePaise || 100000)));
        const compareAtPaise =
          body.compareAtPaise !== null && body.compareAtPaise !== undefined
            ? Math.round(Number(body.compareAtPaise))
            : null;
        const stockQty = Math.max(0, Math.round(Number(body.stockQty ?? 1)));
        const status =
          body.status === 'draft' || body.status === 'archived' ? body.status : 'active';
        const rawImages = Array.isArray(body.images) ? body.images : [];
        const rawVariants = Array.isArray(body.variants) ? body.variants : [];
        const doc: StoredProductDoc = {
          id,
          sku,
          slug,
          title,
          description: typeof body.description === 'string' ? body.description.trim() : '',
          fabric_note: typeof body.fabricNote === 'string' ? body.fabricNote.trim() : '',
          category: typeof body.category === 'string' ? body.category : 'Dresses',
          status,
          featured: body.featured ? 1 : 0,
          price_paise: pricePaise,
          compare_at_paise: compareAtPaise,
          stock_qty: stockQty,
          low_stock_threshold: Math.max(0, Number(body.lowStockThreshold ?? 2)),
          colors_json: JSON.stringify(Array.isArray(body.colors) ? body.colors : []),
          sizes_json: JSON.stringify(Array.isArray(body.sizes) ? body.sizes : []),
          version: 1,
          published_at: status === 'active' ? now : null,
          archived_at: status === 'archived' ? now : null,
          created_at: now,
          updated_at: now,
          images: rawImages.map((img: Record<string, unknown>, idx: number) => ({
            id: `img_${id}_${idx + 1}`,
            product_id: id,
            url: String(img.url || ''),
            alt_text: String(img.alt || title),
            is_cover: img.isCover || idx === 0 ? 1 : 0,
            position: idx,
            created_at: now,
          })),
          variants: rawVariants.map((v: Record<string, unknown>, idx: number) => ({
            id: `var_${id}_${idx + 1}`,
            product_id: id,
            sku: String(v.sku || `${sku}-${idx + 1}`),
            size: String(v.size || 'Free Size'),
            color_name: String(v.colorName || 'Signature'),
            color_hex: String(v.colorHex || '#49243E'),
            price_paise: Math.max(100, Math.round(Number(v.pricePaise || pricePaise))),
            compare_at_paise:
              v.compareAtPaise !== null && v.compareAtPaise !== undefined
                ? Math.round(Number(v.compareAtPaise))
                : compareAtPaise,
            stock_qty: Math.max(0, Math.round(Number(v.stockQty ?? stockQty))),
            position: idx,
            created_at: now,
            updated_at: now,
          })),
        };
        const saved = await firestoreSetDoc(
          'products',
          id,
          doc as unknown as Record<string, unknown>,
          idToken
        );
        if (!saved) {
          return {
            ok: false,
            status: 500,
            code: 'WRITE_FAILED',
            error: 'Failed to save product to Firestore.',
          };
        }
        return {
          ok: true,
          data: { item: formatProductDto(doc, true) } as unknown as T,
        };
      }

      if (cleanPath.startsWith('/api/admin/products/') && upperMethod === 'PATCH') {
        const sub = cleanPath.slice('/api/admin/products/'.length);
        const isStatusPatch = sub.endsWith('/status');
        const productId = decodeURIComponent(
          isStatusPatch ? sub.slice(0, -'/status'.length) : sub
        );
        const existing = await firestoreGetDoc<StoredProductDoc>(
          'products',
          productId,
          idToken
        );
        if (!existing) {
          return {
            ok: false,
            status: 404,
            code: 'PRODUCT_NOT_FOUND',
            error: 'Product not found.',
          };
        }
        const now = Date.now();
        const nextStatus =
          body.status === 'draft' || body.status === 'archived' || body.status === 'active'
            ? body.status
            : existing.status;
        const updated: StoredProductDoc = isStatusPatch
          ? {
              ...existing,
              status: nextStatus,
              version: Number(existing.version || 1) + 1,
              updated_at: now,
            }
          : {
              ...existing,
              title:
                typeof body.title === 'string' ? body.title.trim() : existing.title,
              sku:
                typeof body.sku === 'string'
                  ? body.sku.trim().toUpperCase()
                  : existing.sku,
              slug:
                typeof body.slug === 'string' ? body.slug.trim() : existing.slug,
              description:
                typeof body.description === 'string'
                  ? body.description.trim()
                  : existing.description,
              fabric_note:
                typeof body.fabricNote === 'string'
                  ? body.fabricNote.trim()
                  : existing.fabric_note,
              category:
                typeof body.category === 'string' ? body.category : existing.category,
              status: nextStatus,
              featured:
                body.featured !== undefined ? (body.featured ? 1 : 0) : existing.featured,
              price_paise:
                body.pricePaise !== undefined
                  ? Math.max(100, Math.round(Number(body.pricePaise)))
                  : existing.price_paise,
              compare_at_paise:
                body.compareAtPaise !== undefined
                  ? body.compareAtPaise !== null
                    ? Math.round(Number(body.compareAtPaise))
                    : null
                  : existing.compare_at_paise,
              stock_qty:
                body.stockQty !== undefined
                  ? Math.max(0, Math.round(Number(body.stockQty)))
                  : existing.stock_qty,
              low_stock_threshold:
                body.lowStockThreshold !== undefined
                  ? Math.max(0, Math.round(Number(body.lowStockThreshold)))
                  : existing.low_stock_threshold,
              colors_json: Array.isArray(body.colors)
                ? JSON.stringify(body.colors)
                : existing.colors_json,
              sizes_json: Array.isArray(body.sizes)
                ? JSON.stringify(body.sizes)
                : existing.sizes_json,
              version: Number(existing.version || 1) + 1,
              updated_at: now,
            };
        const saved = await firestoreSetDoc(
          'products',
          productId,
          updated as unknown as Record<string, unknown>,
          idToken
        );
        if (!saved) {
          return {
            ok: false,
            status: 500,
            code: 'WRITE_FAILED',
            error: 'Failed to update product in Firestore.',
          };
        }
        return {
          ok: true,
          data: { item: formatProductDto(updated, true) } as unknown as T,
        };
      }

      if (cleanPath.startsWith('/api/admin/products/') && upperMethod === 'DELETE') {
        const productId = decodeURIComponent(cleanPath.slice('/api/admin/products/'.length));
        await firestoreDeleteDoc('products', productId, idToken);
        return {
          ok: true,
          data: { deleted: true, id: productId } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/categories' && upperMethod === 'POST') {
        const now = Date.now();
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name.length < 2) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: 'Category name is required.',
          };
        }
        const id =
          (typeof body.slug === 'string' && body.slug.trim()) ||
          name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
          `cat_${now.toString(36)}`;
        const record = {
          id,
          name,
          slug: id,
          subtitle: typeof body.subtitle === 'string' ? body.subtitle.trim() : '',
          image_url: typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '',
          alt_text: typeof body.altText === 'string' ? body.altText.trim() : name,
          position: Number(body.position ?? 0),
          created_at: now,
          updated_at: now,
        };
        const saved = await firestoreSetDoc('categories', id, record, idToken);
        if (!saved) {
          return {
            ok: false,
            status: 500,
            code: 'WRITE_FAILED',
            error: 'Failed to save category to Firestore.',
          };
        }
        return {
          ok: true,
          data: {
            item: {
              id: record.id,
              name: record.name,
              slug: record.slug,
              subtitle: record.subtitle,
              imageUrl: record.image_url,
              altText: record.alt_text,
              position: record.position,
              createdAt: now,
              updatedAt: now,
            },
          } as unknown as T,
        };
      }

      if (cleanPath.startsWith('/api/admin/categories/')) {
        const catId = decodeURIComponent(cleanPath.slice('/api/admin/categories/'.length));
        if (upperMethod === 'DELETE') {
          await firestoreDeleteDoc('categories', catId, idToken);
          return { ok: true, data: { deleted: true, id: catId } as unknown as T };
        }
        if (upperMethod === 'PATCH') {
          const existing = await firestoreGetDoc<Record<string, unknown>>(
            'categories',
            catId,
            idToken
          );
          const now = Date.now();
          const updated: Record<string, unknown> = {
            ...(existing || { id: catId, slug: catId, created_at: now }),
            ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
            ...(typeof body.subtitle === 'string' ? { subtitle: body.subtitle.trim() } : {}),
            ...(typeof body.imageUrl === 'string' ? { image_url: body.imageUrl.trim() } : {}),
            ...(typeof body.altText === 'string' ? { alt_text: body.altText.trim() } : {}),
            ...(body.position !== undefined ? { position: Number(body.position) } : {}),
            updated_at: now,
          };
          await firestoreSetDoc('categories', catId, updated, idToken);
          return {
            ok: true,
            data: {
              item: {
                id: String(updated.id || catId),
                name: String(updated.name || ''),
                slug: String(updated.slug || catId),
                subtitle: String(updated.subtitle || ''),
                imageUrl: String(updated.image_url || ''),
                altText: String(updated.alt_text || ''),
                position: Number(updated.position || 0),
                createdAt: Number(updated.created_at || now),
                updatedAt: now,
              },
            } as unknown as T,
          };
        }
      }

      if (cleanPath.startsWith('/api/admin/messages/')) {
        const msgId = decodeURIComponent(cleanPath.slice('/api/admin/messages/'.length));
        if (upperMethod === 'DELETE') {
          await firestoreDeleteDoc('contact_messages', msgId, idToken);
          return { ok: true, data: { deleted: true, id: msgId } as unknown as T };
        }
        if (upperMethod === 'PATCH') {
          const existing = await firestoreGetDoc<Record<string, unknown>>(
            'contact_messages',
            msgId,
            idToken
          );
          if (!existing) {
            return {
              ok: false,
              status: 404,
              code: 'MESSAGE_NOT_FOUND',
              error: 'Message not found.',
            };
          }
          const now = Date.now();
          const updated: Record<string, unknown> = {
            ...existing,
            ...(typeof body.status === 'string' ? { status: body.status } : {}),
            ...(typeof body.adminNotes === 'string'
              ? { admin_notes: body.adminNotes }
              : {}),
            updated_at: now,
          };
          await firestoreSetDoc('contact_messages', msgId, updated, idToken);
          return {
            ok: true,
            data: {
              item: {
                id: msgId,
                fullName: String(updated.full_name || ''),
                phone: String(updated.phone || ''),
                email: (updated.email as string | null) ?? null,
                productInterest: (updated.product_interest as string | null) ?? null,
                message: String(updated.message || ''),
                status: String(updated.status || 'new'),
                adminNotes: String(updated.admin_notes || ''),
                createdAt: Number(updated.created_at || now),
                updatedAt: now,
              },
            } as unknown as T,
          };
        }
      }

      if (cleanPath.startsWith('/api/admin/orders/') && upperMethod === 'PATCH') {
        const orderId = decodeURIComponent(cleanPath.slice('/api/admin/orders/'.length));
        const existing = await firestoreGetDoc<Record<string, unknown>>(
          'orders',
          orderId,
          idToken
        );
        if (!existing) {
          return {
            ok: false,
            status: 404,
            code: 'ORDER_NOT_FOUND',
            error: 'Order not found.',
          };
        }
        const now = Date.now();
        const updated = {
          ...existing,
          ...(typeof body.status === 'string' ? { status: body.status } : {}),
          ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
          updated_at: now,
        };
        await firestoreSetDoc('orders', orderId, updated, idToken);
        return {
          ok: true,
          data: { item: updated } as unknown as T,
        };
      }
    }

    return {
      ok: false,
      status: 404,
      code: 'API_ROUTE_NOT_FOUND',
      error: `API endpoint not found (${upperMethod} ${cleanPath}).`,
    };
  } catch (err) {
    if (err instanceof ClientFirebaseError) {
      return {
        ok: false,
        status: err.httpStatus,
        code: err.code,
        error: err.message,
      };
    }
    return {
      ok: false,
      status: 500,
      code: 'CLIENT_FIREBASE_ERROR',
      error:
        err instanceof Error
          ? err.message
          : 'Unable to complete the request right now. Please try again.',
    };
  }
}
