import { normalizeAdminOverview } from './adminOverview';
import firebaseAppletConfig from '../../firebase-applet-config.json';
import {
  DEFAULT_LOYALTY_CONFIG,
  DEFAULT_SITE_SETTINGS,
  DEFAULT_STOREFRONT_CONTENT,
  INITIAL_SEED_CATEGORIES,
  mergeLoyaltyConfig,
  mergeSiteSettings,
  mergeStorefrontContent,
} from '../../server/storefront-defaults.ts';
import {
  isOrderAwaitingDispatch,
  normalizeOrderRequestsAndStatus,
  normalizePaymentAndRefundStatus,
  normalizeRawOrderStatusValue,
  parseNotificationPrefs,
  parseOrderHistory,
  PRE_CUTOFF_DELIVERY_EDIT_STATES,
  PRE_SHIPPING_CANCEL_STATES,
  RETURN_ELIGIBLE_STATES,
  VALID_FULFILLMENT_STATES,
  validateNonSensitivePaymentMethodInput,
  validateOrderStatusTransition,
  type NotificationPreferencesData,
} from '../../server/order-utils.ts';
import { PRODUCTS, SEED_SKU_BY_ID } from '../config/products';
import {
  compressUploadDataUrl,
  DocumentTooLargeError,
  fitInlineImagesToBudget,
} from '../utils/imageCompression';
import type { AuthCapabilities, AuthUser, ApiResult } from '../context/AuthContext';
import type {
  LoyaltyConfig,
  OrderReturnRequest,
  OrderStatusHistoryEntry,
  ProductColor,
} from '../types/boutique';
import {
  formatVariantDisplayLabel,
  isVariantColorActiveInMetadata,
  makeStableColorId,
  resolveVariantSnapshotImageUrl,
  validateColorVariantMatrix,
} from '../utils/colorVariants';

export const AUTHORIZED_OWNER_EMAIL = 'saivinodkotipalli2003@gmail.com';
const PASSWORD_MIN_LENGTH = 8;
const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CLIENT_SESSION_STORAGE_KEY = 'sahithi_fb_client_session_v1';
const CLIENT_PENDING_VERIFY_KEY = 'sahithi_fb_pending_verify_v1';

const SESSION_LOOKUP_TTL_MS = 15 * 1000;

interface ClientFirebaseSession {
  idToken: string;
  refreshToken: string;
  uid: string;
  email: string | null;
  fullName: string;
  phone?: string | null;
  verifiedPhone?: string | null;
  notificationPrefs?: NotificationPreferencesData;
  emailVerified: boolean;
  phoneVerified?: boolean;
  hasPassword?: boolean;
  signInProviders?: string[];
  lastReauthAt: number;
  issuedAt: number;
  expiresAtMs: number;
  lastVerifiedAt?: number;
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
  updateTime?: string;
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
let inFlightSessionPromise: Promise<ClientFirebaseSession | null> | null = null;
const memoryPendingVerify = new Map<string, PendingVerifyRecord>();

function emitBoutiqueSyncEvent(topic: 'orders' | 'account' | 'catalog'): void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('sahithi-boutique-sync');
      channel.postMessage({ topic, at: Date.now() });
      channel.close();
    }
  } catch {
    // Ignore BroadcastChannel unavailability in tests/non-browser runtimes
  }
}

function sessionHasVerifiedIdentity(session: {
  email?: string | null;
  emailVerified?: boolean;
  phone?: string | null;
  verifiedPhone?: string | null;
  phoneVerified?: boolean;
}): boolean {
  return Boolean(
    (session.emailVerified && session.email) ||
      (session.phoneVerified && (session.verifiedPhone || session.phone))
  );
}

function loadStoredSession(): ClientFirebaseSession | null {
  if (memorySession) return memorySession;
  if (typeof window === 'undefined') return null;
  try {
    const raw =
      window.sessionStorage.getItem(CLIENT_SESSION_STORAGE_KEY) ||
      window.localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClientFirebaseSession>;
    const normalizedEmail =
      typeof parsed.email === 'string' && parsed.email.trim()
        ? parsed.email.trim().toLowerCase()
        : null;
    const hasEmailOrPhoneIdentity =
      Boolean(normalizedEmail) ||
      Boolean(parsed.phoneVerified) ||
      typeof parsed.verifiedPhone === 'string' ||
      typeof parsed.phone === 'string';
    if (
      parsed &&
      typeof parsed.idToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.uid === 'string' &&
      hasEmailOrPhoneIdentity
    ) {
      memorySession = {
        idToken: parsed.idToken,
        refreshToken: parsed.refreshToken,
        uid: parsed.uid,
        email: normalizedEmail,
        fullName: parsed.fullName || 'Member',
        phone: typeof parsed.phone === 'string' ? parsed.phone : null,
        verifiedPhone:
          typeof parsed.verifiedPhone === 'string'
            ? parsed.verifiedPhone
            : parsed.phoneVerified && typeof parsed.phone === 'string'
              ? parsed.phone
              : null,
        notificationPrefs: parsed.notificationPrefs
          ? parseNotificationPrefs(parsed.notificationPrefs)
          : undefined,
        emailVerified: Boolean(normalizedEmail && parsed.emailVerified),
        phoneVerified: Boolean(parsed.phoneVerified),
        hasPassword: parsed.hasPassword !== false,
        signInProviders: Array.isArray(parsed.signInProviders)
          ? parsed.signInProviders.filter((p): p is string => typeof p === 'string')
          : undefined,
        lastReauthAt: Number(parsed.lastReauthAt || Date.now()),
        issuedAt: Number(parsed.issuedAt || Date.now()),
        expiresAtMs: Number(parsed.expiresAtMs || Date.now() + 3600_000),
        lastVerifiedAt: Number(parsed.lastVerifiedAt || 0) || undefined,
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
  inFlightSessionPromise = null;
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

export function invalidateClientSessionVerificationCache(): void {
  if (memorySession) {
    memorySession = { ...memorySession, lastVerifiedAt: 0 };
  }
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
  readonly fieldErrors?: Record<string, string>;

  constructor(
    httpStatus: number,
    code: string,
    message: string,
    fieldErrors?: Record<string, string>
  ) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
    this.fieldErrors = fieldErrors;
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

function getIdentityToolkitBaseUrl(): string {
  const emulatorHost =
    (typeof process !== 'undefined' &&
      process.env &&
      (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST)) ||
    '';
  if (emulatorHost.trim()) {
    const clean = emulatorHost.trim().replace(/^https?:\/\//, '');
    return `http://${clean}/identitytoolkit.googleapis.com/v1`;
  }
  return 'https://identitytoolkit.googleapis.com/v1';
}

function getSecureTokenBaseUrl(): string {
  const emulatorHost =
    (typeof process !== 'undefined' &&
      process.env &&
      (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST)) ||
    '';
  if (emulatorHost.trim()) {
    const clean = emulatorHost.trim().replace(/^https?:\/\//, '');
    return `http://${clean}/securetoken.googleapis.com/v1`;
  }
  return 'https://securetoken.googleapis.com/v1';
}

async function callIdentityToolkit<T>(
  endpoint: string,
  payload: Record<string, unknown>
): Promise<T> {
  const url = `${getIdentityToolkitBaseUrl()}/${endpoint}?key=${encodeURIComponent(
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

type AccountLookupResult =
  | {
      status: 'ok';
      account: {
        uid: string;
        email: string | null;
        emailVerified: boolean;
        phoneNumber: string | null;
        phoneVerified: boolean;
        providerIds: string[];
        hasPassword: boolean;
        displayName: string;
        authTimeMs: number;
        expiresAtMs: number;
      };
    }
  | { status: 'invalid' }
  | { status: 'transient_error' };

type TokenRefreshResult =
  | {
      status: 'ok';
      tokens: {
        idToken: string;
        refreshToken: string;
        expiresAtMs: number;
      };
    }
  | { status: 'invalid' }
  | { status: 'transient_error' };

async function lookupFirebaseAccountDetailed(idToken: string): Promise<AccountLookupResult> {
  try {
    const url = `${getIdentityToolkitBaseUrl()}/accounts:lookup?key=${encodeURIComponent(
      FIREBASE_CONFIG.apiKey
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        phoneNumber?: string;
        displayName?: string;
        providerUserInfo?: Array<{ providerId?: string }>;
      }>;
    };

    if (!res.ok || data.error) {
      const errCode = (data.error?.message || '').split(' : ')[0].trim();
      if (
        errCode === 'INVALID_ID_TOKEN' ||
        errCode === 'TOKEN_EXPIRED' ||
        errCode === 'USER_NOT_FOUND' ||
        errCode === 'USER_DISABLED'
      ) {
        return { status: 'invalid' };
      }
      if (res.status === 429 || res.status >= 500) {
        return { status: 'transient_error' };
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return { status: 'invalid' };
      }
      return { status: 'transient_error' };
    }

    const account = data.users?.[0];
    if (!account || !account.localId) return { status: 'invalid' };
    const jwt = decodeJwtPayload(idToken);
    const expSec = Number(jwt?.exp || 0);
    const authTimeSec = Number(jwt?.auth_time || 0);
    const cleanEmail =
      typeof account.email === 'string' && account.email.trim()
        ? account.email.trim().toLowerCase()
        : null;
    const cleanPhone =
      typeof account.phoneNumber === 'string' && account.phoneNumber.trim()
        ? account.phoneNumber.trim()
        : null;
    const providerIds = Array.isArray(account.providerUserInfo)
      ? account.providerUserInfo
          .map((p) => (typeof p?.providerId === 'string' ? p.providerId : ''))
          .filter(Boolean)
      : [];
    return {
      status: 'ok',
      account: {
        uid: account.localId,
        email: cleanEmail,
        emailVerified: Boolean(cleanEmail && account.emailVerified),
        phoneNumber: cleanPhone,
        phoneVerified: Boolean(cleanPhone),
        providerIds,
        hasPassword: providerIds.includes('password'),
        displayName: account.displayName || '',
        authTimeMs: authTimeSec > 0 ? authTimeSec * 1000 : Date.now(),
        expiresAtMs: expSec > 0 ? expSec * 1000 : Date.now() + 3600_000,
      },
    };
  } catch {
    return { status: 'transient_error' };
  }
}

async function lookupFirebaseAccount(idToken: string): Promise<{
  uid: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneVerified: boolean;
  providerIds: string[];
  hasPassword: boolean;
  displayName: string;
  authTimeMs: number;
  expiresAtMs: number;
} | null> {
  const result = await lookupFirebaseAccountDetailed(idToken);
  return result.status === 'ok' ? result.account : null;
}

async function refreshClientIdTokenDetailed(refreshToken: string): Promise<TokenRefreshResult> {
  try {
    const url = `${getSecureTokenBaseUrl()}/token?key=${encodeURIComponent(
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
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      id_token?: string;
      refresh_token?: string;
      expires_in?: string;
    };
    if (!res.ok) {
      const errMsg = String(data.error?.message || '').toUpperCase();
      if (
        errMsg.includes('INVALID_REFRESH_TOKEN') ||
        errMsg.includes('TOKEN_EXPIRED') ||
        errMsg.includes('USER_DISABLED') ||
        errMsg.includes('USER_NOT_FOUND') ||
        res.status === 400 ||
        res.status === 401 ||
        res.status === 403
      ) {
        return { status: 'invalid' };
      }
      return { status: 'transient_error' };
    }
    if (!data.id_token) return { status: 'invalid' };
    const jwt = decodeJwtPayload(data.id_token);
    const expSec = Number(jwt?.exp || 0);
    return {
      status: 'ok',
      tokens: {
        idToken: data.id_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAtMs:
          expSec > 0 ? expSec * 1000 : Date.now() + Number(data.expires_in || 3600) * 1000,
      },
    };
  } catch {
    return { status: 'transient_error' };
  }
}

async function resolveValidClientSession(): Promise<ClientFirebaseSession | null> {
  const session = loadStoredSession();
  if (!session) return null;

  let active = session;
  const now = Date.now();
  let forceLookup = false;

  if (now > active.expiresAtMs - 60_000) {
    const refreshed = await refreshClientIdTokenDetailed(active.refreshToken);
    if (refreshed.status === 'invalid') {
      clearClientFirebaseSession();
      return null;
    }
    if (refreshed.status === 'transient_error') {
      return sessionHasVerifiedIdentity(active) && now < active.expiresAtMs - 5_000
        ? active
        : null;
    }
    active = {
      ...active,
      idToken: refreshed.tokens.idToken,
      refreshToken: refreshed.tokens.refreshToken,
      expiresAtMs: refreshed.tokens.expiresAtMs,
      lastVerifiedAt: undefined,
    };
    saveStoredSession(active);
    forceLookup = true;
  }

  if (
    !forceLookup &&
    sessionHasVerifiedIdentity(active) &&
    active.lastVerifiedAt &&
    now - active.lastVerifiedAt < SESSION_LOOKUP_TTL_MS &&
    now < active.expiresAtMs - 60_000
  ) {
    return active;
  }

  const lookup = await lookupFirebaseAccountDetailed(active.idToken);
  if (lookup.status === 'invalid') {
    clearClientFirebaseSession();
    return null;
  }
  if (lookup.status === 'transient_error') {
    return sessionHasVerifiedIdentity(active) && now < active.expiresAtMs - 5_000
      ? active
      : null;
  }
  if (!lookup.account.emailVerified && !lookup.account.phoneVerified) {
    clearClientFirebaseSession();
    return null;
  }

  active = {
    ...active,
    email: lookup.account.email,
    emailVerified: lookup.account.emailVerified,
    verifiedPhone: lookup.account.phoneNumber,
    phoneVerified: lookup.account.phoneVerified,
    phone: active.phone || lookup.account.phoneNumber || null,
    hasPassword: lookup.account.hasPassword,
    signInProviders: lookup.account.providerIds,
    fullName: lookup.account.displayName || active.fullName,
    expiresAtMs: lookup.account.expiresAtMs,
    lastVerifiedAt: Date.now(),
  };
  saveStoredSession(active);
  return active;
}

async function getValidClientSession(): Promise<ClientFirebaseSession | null> {
  if (inFlightSessionPromise) {
    return inFlightSessionPromise;
  }
  const promise = resolveValidClientSession().finally(() => {
    if (inFlightSessionPromise === promise) {
      inFlightSessionPromise = null;
    }
  });
  inFlightSessionPromise = promise;
  return promise;
}

export async function getValidClientIdToken(): Promise<string | null> {
  const session = await getValidClientSession().catch(() => null);
  return session?.idToken ?? null;
}

function buildPublicAuthUser(session: ClientFirebaseSession): AuthUser {
  const reauthExpiresAt = session.lastReauthAt + REAUTH_WINDOW_MS;
  const cleanEmail = session.email ? session.email.toLowerCase() : null;
  const isOwner = Boolean(
    session.emailVerified &&
      cleanEmail &&
      cleanEmail === AUTHORIZED_OWNER_EMAIL
  );
  const verifiedPhone =
    session.phoneVerified && (session.verifiedPhone || session.phone)
      ? session.verifiedPhone || session.phone || null
      : null;
  return {
    id: session.uid,
    fullName: session.fullName || (isOwner ? 'Store Owner' : 'Member'),
    email: cleanEmail,
    phone: session.phone ?? verifiedPhone ?? null,
    verifiedPhone,
    notificationPrefs: parseNotificationPrefs(session.notificationPrefs),
    emailVerified: Boolean(cleanEmail && session.emailVerified),
    phoneVerified: Boolean(verifiedPhone),
    hasPassword: session.hasPassword !== false,
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

async function firestoreGetDocWithMeta<T>(
  collectionName: string,
  docId: string,
  idToken?: string
): Promise<{ data: T; updateTime?: string } | null> {
  const url = `${firestoreBaseUrl()}/${collectionName}/${encodeURIComponent(docId)}`;
  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (res.status === 404 || !res.ok) return null;
  const doc = (await res.json()) as FirestoreDocResponse;
  const data = docToRecord<T>(doc);
  if (!data) return null;
  return { data, updateTime: doc.updateTime };
}

async function firestoreGetDoc<T>(
  collectionName: string,
  docId: string,
  idToken?: string
): Promise<T | null> {
  const meta = await firestoreGetDocWithMeta<T>(collectionName, docId, idToken);
  return meta ? meta.data : null;
}

async function parseFirestoreHttpError(
  res: Response,
  fallbackMessage: string
): Promise<ClientFirebaseError> {
  const payload = (await res.json().catch(() => ({}))) as {
    error?: { code?: number; message?: string; status?: string };
  };
  const fsStatus = String(payload.error?.status || '').toUpperCase();
  const fsMessage = payload.error?.message || fallbackMessage;
  if (res.status === 401 || fsStatus === 'UNAUTHENTICATED') {
    return new ClientFirebaseError(
      401,
      'ADMIN_AUTH_REQUIRED',
      'Your authentication session expired. Please sign in again.'
    );
  }
  if (res.status === 403 || fsStatus === 'PERMISSION_DENIED') {
    return new ClientFirebaseError(
      403,
      'FIRESTORE_PERMISSION_DENIED',
      `Permission denied while writing to Firestore: ${fsMessage}`
    );
  }
  if (res.status === 400 || fsStatus === 'INVALID_ARGUMENT') {
    return new ClientFirebaseError(
      400,
      'VALIDATION_ERROR',
      `Invalid Firestore payload: ${fsMessage}`
    );
  }
  if (
    res.status === 409 ||
    res.status === 412 ||
    fsStatus === 'ABORTED' ||
    fsStatus === 'FAILED_PRECONDITION'
  ) {
    return new ClientFirebaseError(
      409,
      'CONCURRENCY_CONFLICT',
      'This record was updated elsewhere. Please refresh and try again.'
    );
  }
  return new ClientFirebaseError(res.status || 502, fsStatus || 'FIRESTORE_ERROR', fsMessage);
}

async function firestoreSetDoc(
  collectionName: string,
  docId: string,
  data: Record<string, unknown>,
  idToken?: string,
  updateMaskFields?: string[],
  options?: { updateTime?: string }
): Promise<void> {
  const params = new URLSearchParams();
  if (Array.isArray(updateMaskFields) && updateMaskFields.length > 0) {
    for (const f of updateMaskFields) {
      params.append('updateMask.fieldPaths', f);
    }
  }
  if (options?.updateTime) {
    params.set('currentDocument.updateTime', options.updateTime);
  }
  const qs = params.toString();
  const url = `${firestoreBaseUrl()}/${collectionName}/${encodeURIComponent(docId)}${qs ? `?${qs}` : ''}`;
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
  if (!res.ok) {
    throw await parseFirestoreHttpError(
      res,
      `Failed to save ${collectionName}/${docId} (HTTP ${res.status}).`
    );
  }
}

async function firestoreDeleteDoc(
  collectionName: string,
  docId: string,
  idToken?: string
): Promise<void> {
  const url = `${firestoreBaseUrl()}/${collectionName}/${encodeURIComponent(docId)}`;
  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, { method: 'DELETE', headers });
  if (!res.ok && res.status !== 404) {
    throw await parseFirestoreHttpError(
      res,
      `Failed to delete ${collectionName}/${docId} (HTTP ${res.status}).`
    );
  }
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

async function firestoreRunQuery<T>(
  collectionId: string,
  filters: Array<{ field: string; value: string | boolean | number }>,
  idToken?: string
): Promise<T[]> {
  const parentUrl = firestoreBaseUrl();
  const runUrl = `${parentUrl}:runQuery`;
  const fieldFilters = filters.map((f) => ({
    fieldFilter: {
      field: { fieldPath: f.field },
      op: 'EQUAL',
      value: toFirestoreValue(f.value),
    },
  }));
  const where =
    fieldFilters.length === 1
      ? fieldFilters[0]
      : fieldFilters.length > 1
        ? { compositeFilter: { op: 'AND', filters: fieldFilters } }
        : undefined;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(runUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        ...(where ? { where } : {}),
        limit: 300,
      },
    }),
  });
  if (!res.ok) return [];
  const rows = (await res.json().catch(() => [])) as Array<{ document?: FirestoreDocResponse }>;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((entry) => docToRecord<T>(entry.document ?? null))
    .filter((item): item is T => item !== null);
}

function parseJsonOrValue<T>(raw: unknown, fallback: T): T {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw && typeof raw === 'object' ? (raw as T) : fallback;
}

export function serializeClientOrderDoc(o: Record<string, unknown>) {
  const createdAt = Number(o.created_at || Date.now());
  const updatedAt = Number(o.updated_at || createdAt);
  const rzPaymentId =
    typeof o.razorpay_payment_id === 'string' && o.razorpay_payment_id ? o.razorpay_payment_id : null;
  const rzOrderId =
    typeof o.razorpay_order_id === 'string' && o.razorpay_order_id ? o.razorpay_order_id : null;
  const paymentMethod = String(o.payment_method || (rzOrderId || rzPaymentId ? 'razorpay' : 'cod'));
  const parsedHistory = parseOrderHistory(o.status_history ?? o.status_history_json);

  const norm = normalizeOrderRequestsAndStatus({
    rawStatus: typeof o.status === 'string' ? o.status : undefined,
    rawFulfillmentStatus:
      typeof o.fulfillment_status === 'string' ? o.fulfillment_status : undefined,
    rawCancelRequest: o.cancel_request ?? o.cancel_request_json,
    rawReturnRequest: o.return_request ?? o.return_request_json,
    rawPaymentStatus: o.payment_status,
    rawRefundStatus: o.refund_status,
    rawCancelledAt: o.cancelled_at,
    rawCancelledBy: o.cancelled_by,
    rawCancelReason: o.cancel_reason,
    razorpayPaymentId: rzPaymentId,
    history: parsedHistory,
    paymentMethod,
  });

  const statusHistory: OrderStatusHistoryEntry[] =
    parsedHistory.length > 0
      ? (parsedHistory as OrderStatusHistoryEntry[])
      : [];

  const subtotalPaise = Number(o.subtotal_paise || 0);
  const totalPaise = Number(o.total_paise || 0);
  const items = Array.isArray(o.items) ? (o.items as Array<Record<string, unknown>>) : [];

  return {
    id: String(o.id || ''),
    orderNumber: String(o.order_number || ''),
    customerUserId: typeof o.customer_user_id === 'string' ? o.customer_user_id : null,
    customerName: String(o.customer_name || ''),
    customerPhone: String(o.customer_phone || ''),
    customerEmail: String(o.customer_email || ''),
    shippingAddress: String(o.shipping_address || ''),
    status: norm.status,
    paymentStatus: norm.paymentStatus,
    refundStatus: norm.refundStatus,
    fulfillmentStatus: norm.fulfillmentStatus,
    paymentMethod,
    paymentCollectedAt:
      typeof o.payment_collected_at === 'number' ? Number(o.payment_collected_at) : null,
    idempotencyKey: typeof o.idempotency_key === 'string' ? o.idempotency_key : null,
    razorpayOrderId: rzOrderId,
    razorpayPaymentId: rzPaymentId,
    couponCode: typeof o.coupon_code === 'string' && o.coupon_code ? o.coupon_code : null,
    giftCardCode: typeof o.gift_card_code === 'string' && o.gift_card_code ? o.gift_card_code : null,
    subtotalPaise,
    discountPaise: Number(o.discount_paise || 0),
    giftCardPaise: Number(o.gift_card_paise || 0),
    totalPaise,
    subtotal: Number((subtotalPaise / 100).toFixed(2)),
    total: Number((totalPaise / 100).toFixed(2)),
    currency: String(o.currency || 'INR'),
    statusHistory,
    cancelRequest: norm.cancelRequest,
    returnRequest: norm.returnRequest,
    cancelledAt: norm.cancelledAt,
    cancelledBy: norm.cancelledBy,
    cancelReason: norm.cancelReason,
    hiddenByCustomer: Boolean(o.hidden_by_customer === true || o.hidden_by_customer === 1),
    hiddenAt: typeof o.hidden_at === 'number' ? Number(o.hidden_at) : null,
    deliveryDetailsEditedAt:
      typeof o.delivery_details_edited_at === 'number'
        ? Number(o.delivery_details_edited_at)
        : null,
    stockRestoredAt:
      typeof o.stock_restored_at === 'number' ? Number(o.stock_restored_at) : null,
    needsAdminReview: norm.needsAdminReview,
    legacyCollisionNote: norm.legacyCollisionNote,
    notes: typeof o.notes === 'string' ? o.notes : '',
    createdAt,
    updatedAt,
    items: items.map((it) => {
      const qty = Number(it.quantity ?? it.qty ?? 1);
      const unitPaise = Number(it.unit_price_paise || 0);
      const colorName = String(it.color_name || it.color_snapshot || '').trim();
      const size = String(it.size || it.size_snapshot || '').trim();
      const imageUrl = String(it.image_url || '').trim();
      return {
        id: String(it.id || ''),
        productId: String(it.product_id || ''),
        variantId: it.variant_id ? String(it.variant_id) : null,
        productTitle: String(it.product_title || it.title_snapshot || 'Boutique Piece'),
        titleSnapshot: String(it.title_snapshot || it.product_title || 'Boutique Piece'),
        variantLabel:
          String(
            it.variant_label ||
              (colorName || size ? formatVariantDisplayLabel(colorName, size) : '') ||
              'Standard'
          ),
        colorName: colorName || undefined,
        size: size || undefined,
        imageUrl: imageUrl || undefined,
        sku: String(it.sku || it.sku_snapshot || ''),
        skuSnapshot: String(it.sku_snapshot || it.sku || ''),
        sizeSnapshot: size,
        colorSnapshot: colorName,
        unitPricePaise: unitPaise,
        unitPrice: Number((unitPaise / 100).toFixed(2)),
        quantity: qty,
        qty,
        lineTotalPaise: Number(it.line_total_paise ?? unitPaise * qty),
      };
    }),
  };
}

async function verifyRazorpayOrderStatusFromServer(
  razorpayOrderId: string,
  razorpayPaymentId: string | null,
  idToken?: string
): Promise<{
  confirmed: boolean;
  cancelled?: boolean;
  paymentId?: string;
  order?: {
    status?: string;
    fulfillmentStatus?: string;
    paymentStatus?: string;
    refundStatus?: string;
    razorpayPaymentId?: string;
  };
} | null> {
  if (!razorpayOrderId || typeof fetch !== 'function') return null;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    const res = await fetch('/api/order-status', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        razorpay_order_id: razorpayOrderId,
        ...(razorpayPaymentId ? { razorpay_payment_id: razorpayPaymentId } : {}),
      }),
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => ({}))) as {
      confirmed?: boolean;
      cancelled?: boolean;
      order?: {
        status?: string;
        fulfillmentStatus?: string;
        paymentStatus?: string;
        refundStatus?: string;
        razorpayPaymentId?: string;
      };
      payment_id?: string;
    };
    if (payload.cancelled || String(payload.order?.status || '').toLowerCase() === 'cancelled') {
      return {
        confirmed: false,
        cancelled: true,
        paymentId: payload.order?.razorpayPaymentId || payload.payment_id || razorpayPaymentId || undefined,
        order: payload.order,
      };
    }
    if (payload.confirmed && payload.order?.paymentStatus === 'paid') {
      return {
        confirmed: true,
        cancelled: false,
        paymentId: payload.order.razorpayPaymentId || payload.payment_id || razorpayPaymentId || undefined,
        order: payload.order,
      };
    }
    return { confirmed: false };
  } catch {
    return null;
  }
}

async function reconcilePendingRazorpayOrdersAsOwner(
  docs: Array<Record<string, unknown>>,
  ownerIdToken: string
): Promise<void> {
  const candidates = docs
    .filter((d) => {
      const method = String(d.payment_method || '');
      const payStatus = String(d.payment_status || '');
      const serialized = serializeClientOrderDoc(d);
      const rzpOid = typeof d.razorpay_order_id === 'string' ? d.razorpay_order_id : '';
      return (
        method === 'razorpay' &&
        payStatus !== 'paid' &&
        !['cancelled', 'returned'].includes(serialized.status) &&
        rzpOid.length > 0 &&
        typeof d.id === 'string' &&
        d.id.length > 0
      );
    })
    .slice(0, 8);

  if (candidates.length === 0) return;

  await Promise.all(
    candidates.map(async (doc) => {
      const rzpOid = String(doc.razorpay_order_id || '');
      const rzpPid = typeof doc.razorpay_payment_id === 'string' ? doc.razorpay_payment_id : null;
      const check = await verifyRazorpayOrderStatusFromServer(rzpOid, rzpPid, ownerIdToken);
      if (!check?.confirmed) return;

      const docId = String(doc.id);
      const freshMeta = await firestoreGetDocWithMeta<Record<string, unknown>>(
        'orders',
        docId,
        ownerIdToken
      ).catch(() => null);
      if (!freshMeta) return;

      const freshData = freshMeta.data;
      const freshSerialized = serializeClientOrderDoc(freshData);
      const now = Date.now();
      const existingHistory = parseJsonOrValue<OrderStatusHistoryEntry[]>(
        freshData.status_history ?? freshData.status_history_json,
        []
      );

      // Never reactivate an order that was cancelled while payment verification was in flight
      if (freshSerialized.status === 'cancelled') {
        const nextHistory: OrderStatusHistoryEntry[] = [
          ...existingHistory,
          {
            status: 'payment_received_after_cancellation',
            note: 'Payment verified via Razorpay after cancellation — flagged for refund review',
            actor: 'system',
            at: now,
          },
        ];
        const patch: Record<string, unknown> = {
          payment_status: 'paid',
          refund_status: 'pending_refund',
          status_history: nextHistory,
          status_history_json: JSON.stringify(nextHistory),
          updated_at: now,
        };
        await firestoreSetDoc(
          'orders',
          docId,
          patch,
          ownerIdToken,
          Object.keys(patch),
          { updateTime: freshMeta.updateTime }
        ).catch(() => {});
        Object.assign(doc, freshData, patch);
        return;
      }

      const nextHistory: OrderStatusHistoryEntry[] = existingHistory.some(
        (h) => h.status === 'confirmed'
      )
        ? existingHistory
        : [
            ...existingHistory,
            {
              status: 'confirmed',
              note: 'Payment verified via Razorpay',
              actor: 'system',
              at: now,
            },
          ];

      const patch: Record<string, unknown> = {
        status: 'confirmed',
        fulfillment_status: 'confirmed',
        payment_status: 'paid',
        status_history: nextHistory,
        status_history_json: JSON.stringify(nextHistory),
        updated_at: now,
      };
      await firestoreSetDoc(
        'orders',
        docId,
        patch,
        ownerIdToken,
        Object.keys(patch),
        { updateTime: freshMeta.updateTime }
      ).catch(() => {});

      Object.assign(doc, freshData, patch);
    })
  );
}

function serializeClientCouponDoc(c: Record<string, unknown>) {
  return {
    id: String(c.id || ''),
    code: String(c.code || ''),
    title: String(c.title || ''),
    description: String(c.description || ''),
    discountType: (c.discount_type === 'flat_paise' ? 'flat_paise' : 'percent') as 'percent' | 'flat_paise',
    discountValue: Number(c.discount_value || 0),
    maxDiscountPaise: c.max_discount_paise !== null && c.max_discount_paise !== undefined ? Number(c.max_discount_paise) : null,
    minSpendPaise: Number(c.min_spend_paise || 0),
    usageLimit: c.usage_limit !== null && c.usage_limit !== undefined ? Number(c.usage_limit) : null,
    usedCount: Number(c.used_count || 0),
    active: Boolean(c.active === true || c.active === 1),
    startsAt: c.starts_at ? Number(c.starts_at) : null,
    expiresAt: c.expires_at ? Number(c.expires_at) : null,
    createdAt: Number(c.created_at || Date.now()),
    updatedAt: Number(c.updated_at || Date.now()),
  };
}

function serializeClientGiftCardDoc(g: Record<string, unknown>) {
  return {
    id: String(g.id || ''),
    code: String(g.code || ''),
    recipientEmail: String(g.recipient_email || ''),
    note: String(g.note || ''),
    initialBalancePaise: Number(g.initial_balance_paise || 0),
    balancePaise: Number(g.balance_paise || 0),
    active: Boolean(g.active === true || g.active === 1),
    expiresAt: g.expires_at ? Number(g.expires_at) : null,
    lastUsedAt: g.last_used_at ? Number(g.last_used_at) : null,
    createdAt: Number(g.created_at || Date.now()),
    updatedAt: Number(g.updated_at || Date.now()),
  };
}

function serializeClientAddressDoc(a: Record<string, unknown>) {
  return {
    id: String(a.id || ''),
    fullName: String(a.full_name || ''),
    phone: String(a.phone || ''),
    line1: String(a.line1 || ''),
    line2: String(a.line2 || ''),
    city: String(a.city || ''),
    state: String(a.state || ''),
    pincode: String(a.pincode || ''),
    landmark: String(a.landmark || ''),
    label: (a.label === 'Work' || a.label === 'Other' ? a.label : 'Home') as 'Home' | 'Work' | 'Other',
    isDefault: Boolean(a.is_default === true || a.is_default === 1),
    createdAt: Number(a.created_at || Date.now()),
    updatedAt: Number(a.updated_at || Date.now()),
  };
}

function serializeClientNotificationDoc(n: Record<string, unknown>) {
  return {
    id: String(n.id || ''),
    type: String(n.type || 'order_status'),
    title: String(n.title || ''),
    message: String(n.message || ''),
    orderId: typeof n.order_id === 'string' ? n.order_id : null,
    orderNumber: typeof n.order_number === 'string' ? n.order_number : null,
    read: Boolean(n.is_read === 1 || n.is_read === true || n.read === true),
    readAt: n.read_at ? Number(n.read_at) : null,
    createdAt: Number(n.created_at || Date.now()),
  };
}

interface StoredProductDoc {
  id: string;
  sku: string;
  slug: string;
  title: string;
  description: string;
  fabric_note: string;
  included_pieces?: string;
  care_note?: string;
  category: string;
  status: 'draft' | 'active' | 'published' | 'archived';
  featured: number | boolean;
  price_paise: number;
  compare_at_paise: number | null;
  stock_qty: number;
  low_stock_threshold: number;
  colors_json: string;
  sizes_json: string;
  import_key?: string | null;
  source_image_filename?: string | null;
  pending_fields_json?: string | null;
  catalog_batch?: string | null;
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
    color_id?: string | null;
    color_name: string;
    color_hex: string;
    price_paise: number;
    price_override_paise?: number | null;
    compare_at_paise: number | null;
    stock_qty: number;
    active?: boolean | number;
    position: number;
    created_at?: number;
    updated_at?: number;
  }>;
  images?: Array<{
    id: string;
    product_id: string;
    media_id?: string | null;
    color_id?: string | null;
    url: string;
    alt_text: string;
    is_cover: number | boolean;
    position: number;
    created_at: number;
  }>;
  variant_skus?: string[];
  image_urls?: string[];
}

function buildSeedProductsDocs(): StoredProductDoc[] {
  return PRODUCTS.map((item) => {
    const ts = new Date(`${item.dateAdded}T10:00:00Z`).getTime() || Date.now();
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
    const compareAtPaise =
      item.compareAtPaise ??
      (item.compareAtPrice ? Math.round(item.compareAtPrice * 100) : null);

    let pos = 0;
    const variants: NonNullable<StoredProductDoc['variants']> = [];
    for (const size of item.sizes) {
      for (const color of item.colors) {
        const colorCode = color.name
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 3)
          .toUpperCase();
        const sizeCode = size.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        variants.push({
          id: `${item.id}-var-${pos + 1}`,
          product_id: item.id,
          sku: `${sku}-${sizeCode}-${colorCode}-${pos + 1}`,
          size,
          color_name: color.name,
          color_hex: color.hex,
          price_paise: pricePaise,
          compare_at_paise: compareAtPaise,
          stock_qty: 6,
          position: pos,
          created_at: ts,
          updated_at: ts,
        });
        pos += 1;
      }
    }

    const totalStock = variants.reduce((sum, v) => sum + v.stock_qty, 0);
    const images: NonNullable<StoredProductDoc['images']> = item.images.map((img, idx) => ({
      id: `${item.id}-img-${idx + 1}`,
      product_id: item.id,
      media_id: null,
      url: img.src,
      alt_text: img.alt || item.name,
      is_cover: idx === 0,
      position: idx,
      created_at: ts,
    }));

    return {
      id: item.id,
      sku,
      slug,
      title: item.name,
      description: item.description,
      fabric_note: item.fabricNote,
      included_pieces: item.includedPieces || '',
      care_note: item.careNote || '',
      category: item.category,
      status: 'published',
      featured: Boolean(item.featured),
      price_paise: pricePaise,
      compare_at_paise: compareAtPaise,
      stock_qty: totalStock,
      low_stock_threshold: 5,
      colors_json: JSON.stringify(item.colors),
      sizes_json: JSON.stringify(item.sizes),
      version: 1,
      published_at: ts,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
      variants,
      images,
      variant_skus: variants.map((v) => v.sku),
      image_urls: images.map((i) => i.url),
    };
  });
}

function sanitizeProductDocForFirestore(
  raw: StoredProductDoc,
  productId: string
): StoredProductDoc {
  const now = Date.now();
  const safeId = String(productId || raw.id || `prod_${now.toString(36)}`).trim();
  const safeTitle = String(raw.title || 'Sahithi Piece').trim().slice(0, 160);
  const safeTitlePadded = safeTitle.length >= 2 ? safeTitle : `${safeTitle} Piece`;
  const rawSlug = String(raw.slug || safeTitlePadded)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 140);
  const safeSlug = rawSlug.length >= 1 ? rawSlug : safeId.toLowerCase().slice(0, 140);
  const rawSku = String(
    SEED_SKU_BY_ID[safeId] && (!raw.sku || raw.sku.toUpperCase() === `SC-${safeId.toUpperCase()}`)
      ? SEED_SKU_BY_ID[safeId]
      : raw.sku || `SC-${safeId.toUpperCase()}`
  )
    .trim()
    .toUpperCase()
    .slice(0, 64);
  const safeSku = rawSku.length >= 1 ? rawSku : `SC-${safeId.toUpperCase()}`.slice(0, 64);
  const safeCategory = String(raw.category || 'Kurtis').trim().slice(0, 80) || 'Kurtis';
  const safeDescription = String(raw.description || '').slice(0, 5000);
  const safeFabricNote = String(raw.fabric_note || '').slice(0, 500);
  const safePricePaise = Math.max(
    100,
    Math.min(100_000_000, Math.round(Number(raw.price_paise) || 69900))
  );
  const rawCompare =
    raw.compare_at_paise !== null && raw.compare_at_paise !== undefined
      ? Math.round(Number(raw.compare_at_paise))
      : null;
  const safeCompareAtPaise =
    rawCompare !== null && Number.isFinite(rawCompare) && rawCompare >= 100
      ? Math.max(safePricePaise, Math.min(100_000_000, rawCompare))
      : null;

  const rawVariants = Array.isArray(raw.variants) ? raw.variants.slice(0, 100) : [];
  const safeVariants: NonNullable<StoredProductDoc['variants']> =
    rawVariants.length > 0
      ? rawVariants.map((v, idx) => {
          const vPrice = Math.max(
            100,
            Math.min(100_000_000, Math.round(Number(v.price_paise) || safePricePaise))
          );
          const vCompareRaw =
            v.compare_at_paise !== null && v.compare_at_paise !== undefined
              ? Math.round(Number(v.compare_at_paise))
              : null;
          const vCompare =
            vCompareRaw !== null && Number.isFinite(vCompareRaw) && vCompareRaw >= 100
              ? Math.max(vPrice, Math.min(100_000_000, vCompareRaw))
              : null;
          const vPriceOverride =
            v.price_override_paise !== null &&
            v.price_override_paise !== undefined &&
            Number.isFinite(Number(v.price_override_paise)) &&
            Math.round(Number(v.price_override_paise)) >= 100
              ? Math.min(100_000_000, Math.round(Number(v.price_override_paise)))
              : null;
          return {
            id: String(v.id || `${safeId}-var-${idx + 1}`),
            product_id: safeId,
            sku: String(v.sku || `${safeSku}-V${idx + 1}`).toUpperCase().slice(0, 64),
            size: String(v.size || 'Free Size').slice(0, 40),
            ...(typeof v.color_id === 'string' && v.color_id.trim()
              ? { color_id: v.color_id.trim().slice(0, 80) }
              : {}),
            color_name: String(v.color_name || 'Signature').slice(0, 60),
            color_hex: String(v.color_hex || '#49243E').slice(0, 16),
            price_paise: vPriceOverride ?? vPrice,
            ...(vPriceOverride !== null ? { price_override_paise: vPriceOverride } : {}),
            compare_at_paise: vCompare,
            stock_qty: Math.max(
              0,
              Math.min(1_000_000, Math.round(Number(v.stock_qty ?? 0) || 0))
            ),
            active: v.active === false || v.active === 0 ? false : true,
            position: idx,
          };
        })
      : [
          {
            id: `${safeId}-var-1`,
            product_id: safeId,
            sku: `${safeSku}-STD-1`.slice(0, 64),
            size: 'Free Size',
            color_name: 'Signature',
            color_hex: '#49243E',
            price_paise: safePricePaise,
            compare_at_paise: safeCompareAtPaise,
            stock_qty: Math.max(
              0,
              Math.min(1_000_000, Math.round(Number(raw.stock_qty ?? 1) || 0))
            ),
            active: true,
            position: 0,
          },
        ];

  const safeColorsJson = String(raw.colors_json || '[]').slice(0, 10_000);
  const safeStockQty = Math.max(
    0,
    Math.min(
      1_000_000,
      safeVariants
        .filter((v) => v.active !== false && isVariantColorActiveInMetadata(safeColorsJson, v))
        .reduce((sum, v) => sum + v.stock_qty, 0)
    )
  );
  const safeLowStock = Math.max(
    0,
    Math.min(10_000, Math.round(Number(raw.low_stock_threshold ?? 5) || 0))
  );
  const safeStatus: 'draft' | 'published' | 'archived' =
    raw.status === 'draft' || raw.status === 'archived' ? raw.status : 'published';
  const safeCreatedAt = Number(raw.created_at) > 0 ? Math.round(Number(raw.created_at)) : now;
  const safeUpdatedAt = Number(raw.updated_at) > 0 ? Math.round(Number(raw.updated_at)) : now;
  const safePublishedAt =
    raw.published_at !== null && raw.published_at !== undefined && Number(raw.published_at) > 0
      ? Math.round(Number(raw.published_at))
      : safeStatus === 'published'
        ? safeCreatedAt
        : null;
  const safeArchivedAt =
    safeStatus === 'archived'
      ? raw.archived_at !== null && raw.archived_at !== undefined && Number(raw.archived_at) > 0
        ? Math.round(Number(raw.archived_at))
        : now
      : null;

  const rawImages = Array.isArray(raw.images) ? raw.images.slice(0, 20) : [];
  const safeImages: NonNullable<StoredProductDoc['images']> = rawImages.map((img, idx) => ({
    id: String(img.id || `${safeId}-img-${idx + 1}`),
    product_id: safeId,
    media_id: typeof img.media_id === 'string' ? img.media_id : null,
    ...(typeof img.color_id === 'string' && img.color_id.trim()
      ? { color_id: img.color_id.trim().slice(0, 80) }
      : {}),
    url: String(img.url || ''),
    alt_text: String(img.alt_text || safeTitlePadded).slice(0, 240),
    is_cover: Boolean(img.is_cover ?? idx === 0),
    position: idx,
    created_at: Number(img.created_at) > 0 ? Math.round(Number(img.created_at)) : safeCreatedAt,
  }));

  const safeSizesJson = String(raw.sizes_json || '[]').slice(0, 5_000);
  const safeVersion = Math.max(1, Math.round(Number(raw.version || 1)));

  const safeIncludedPieces = String(raw.included_pieces || '').slice(0, 300);
  const safeCareNote = String(raw.care_note || '').slice(0, 300);
  const safeImportKey =
    typeof raw.import_key === 'string' && raw.import_key.trim()
      ? raw.import_key.trim().slice(0, 80)
      : null;
  const safeSourceImageFilename =
    typeof raw.source_image_filename === 'string' && raw.source_image_filename.trim()
      ? raw.source_image_filename.trim().slice(0, 140)
      : null;
  const safePendingFieldsJson =
    typeof raw.pending_fields_json === 'string' && raw.pending_fields_json.trim()
      ? raw.pending_fields_json.trim().slice(0, 1500)
      : null;
  const safeCatalogBatch =
    typeof raw.catalog_batch === 'string' && raw.catalog_batch.trim()
      ? raw.catalog_batch.trim().slice(0, 80)
      : null;

  return {
    id: safeId,
    slug: safeSlug,
    title: safeTitlePadded,
    description: safeDescription,
    fabric_note: safeFabricNote,
    ...(safeIncludedPieces ? { included_pieces: safeIncludedPieces } : {}),
    ...(safeCareNote ? { care_note: safeCareNote } : {}),
    category: safeCategory,
    sku: safeSku,
    price_paise: safePricePaise,
    compare_at_paise: safeCompareAtPaise,
    stock_qty: safeStockQty,
    low_stock_threshold: safeLowStock,
    featured: Boolean(raw.featured),
    status: safeStatus,
    colors_json: safeColorsJson,
    sizes_json: safeSizesJson,
    ...(safeImportKey ? { import_key: safeImportKey } : {}),
    ...(safeSourceImageFilename ? { source_image_filename: safeSourceImageFilename } : {}),
    ...(safePendingFieldsJson ? { pending_fields_json: safePendingFieldsJson } : {}),
    ...(safeCatalogBatch ? { catalog_batch: safeCatalogBatch } : {}),
    version: safeVersion,
    published_at: safePublishedAt,
    archived_at: safeArchivedAt,
    created_at: safeCreatedAt,
    updated_at: safeUpdatedAt,
    variants: safeVariants,
    images: safeImages,
    variant_skus: safeVariants.map((v) => v.sku).slice(0, 100),
    image_urls: safeImages.map((i) => i.url).slice(0, 20),
  };
}

const CLIENT_VISIBILITY_STORAGE_KEY = 'sahithi_catalog_visibility_v1';
const CLIENT_PRODUCT_OVERRIDES_KEY = 'sahithi_catalog_product_overrides_v1';
const memoryProductOverrides = new Map<string, StoredProductDoc>();

function loadClientProductOverrides(): Map<string, StoredProductDoc> {
  const merged = new Map<string, StoredProductDoc>(memoryProductOverrides);
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(CLIENT_PRODUCT_OVERRIDES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, StoredProductDoc>;
        if (parsed && typeof parsed === 'object') {
          for (const [id, doc] of Object.entries(parsed)) {
            if (doc && typeof doc === 'object' && doc.id) {
              merged.set(id, sanitizeProductDocForFirestore(doc, id));
            }
          }
        }
      }
    } catch {
      // Ignore storage read errors
    }
  }
  return merged;
}

function saveClientProductOverride(doc: StoredProductDoc): void {
  const sanitized = sanitizeProductDocForFirestore(doc, doc.id);
  memoryProductOverrides.set(sanitized.id, sanitized);
  if (typeof window !== 'undefined') {
    try {
      const current = loadClientProductOverrides();
      current.set(sanitized.id, sanitized);
      const serializedObj: Record<string, StoredProductDoc> = {};
      for (const [k, v] of current.entries()) {
        serializedObj[k] = v;
      }
      window.localStorage.setItem(
        CLIENT_PRODUCT_OVERRIDES_KEY,
        JSON.stringify(serializedObj)
      );
    } catch {
      // Ignore storage quota errors
    }
  }
}

function removeClientProductOverride(productId: string): void {
  memoryProductOverrides.delete(productId);
  if (typeof window !== 'undefined') {
    try {
      const current = loadClientProductOverrides();
      current.delete(productId);
      const serializedObj: Record<string, StoredProductDoc> = {};
      for (const [k, v] of current.entries()) {
        serializedObj[k] = v;
      }
      window.localStorage.setItem(
        CLIENT_PRODUCT_OVERRIDES_KEY,
        JSON.stringify(serializedObj)
      );
    } catch {
      // Ignore storage errors
    }
  }
}

interface ClientCatalogVisibilityMeta {
  hiddenIds: Set<string>;
  hiddenSlugs: Set<string>;
  deletedIds: Set<string>;
  suppressLegacySeed: boolean;
}

async function getClientCatalogVisibilityMeta(
  idToken?: string
): Promise<ClientCatalogVisibilityMeta> {
  const hiddenIds = new Set<string>();
  const hiddenSlugs = new Set<string>();
  const deletedIds = new Set<string>();
  let suppressLegacySeed = false;

  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(CLIENT_VISIBILITY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          hiddenIds?: string[];
          hiddenSlugs?: string[];
          deletedIds?: string[];
          suppressLegacySeed?: boolean;
        };
        (parsed.hiddenIds || []).forEach((id) => hiddenIds.add(id));
        (parsed.hiddenSlugs || []).forEach((slug) => hiddenSlugs.add(slug));
        (parsed.deletedIds || []).forEach((id) => {
          deletedIds.add(id);
          hiddenIds.add(id);
        });
        if (parsed.suppressLegacySeed === true) {
          suppressLegacySeed = true;
        }
      }
    } catch {
      // Ignore storage read errors
    }
  }

  try {
    const settingsDoc = await firestoreGetDoc<{
      hidden_product_ids?: string[];
      hidden_product_slugs?: string[];
      deleted_product_ids?: string[];
      suppress_legacy_seed?: boolean;
      value?: { catalogControl?: { suppressLegacySeed?: boolean } };
    }>('site_documents', 'settings', idToken);
    if (settingsDoc) {
      if (
        settingsDoc.suppress_legacy_seed === true ||
        settingsDoc.value?.catalogControl?.suppressLegacySeed === true
      ) {
        suppressLegacySeed = true;
      } else if (
        settingsDoc.suppress_legacy_seed === false ||
        settingsDoc.value?.catalogControl?.suppressLegacySeed === false
      ) {
        suppressLegacySeed = false;
      }
      (settingsDoc.hidden_product_ids || []).forEach((id) => hiddenIds.add(id));
      (settingsDoc.hidden_product_slugs || []).forEach((slug) => hiddenSlugs.add(slug));
      (settingsDoc.deleted_product_ids || []).forEach((id) => {
        deletedIds.add(id);
        hiddenIds.add(id);
      });
    }
  } catch {
    // Ignore transient Firestore error
  }

  return { hiddenIds, hiddenSlugs, deletedIds, suppressLegacySeed };
}

async function saveClientCatalogVisibilityMeta(
  meta: ClientCatalogVisibilityMeta,
  idToken?: string
): Promise<void> {
  if (idToken) {
    const existing = await firestoreGetDoc<Record<string, unknown>>(
      'site_documents',
      'settings',
      idToken
    );
    await firestoreSetDoc(
      'site_documents',
      'settings',
      {
        key: 'settings',
        value: existing?.value ?? DEFAULT_SITE_SETTINGS,
        suppress_legacy_seed: Boolean(meta.suppressLegacySeed),
        hidden_product_ids: Array.from(meta.hiddenIds),
        hidden_product_slugs: Array.from(meta.hiddenSlugs),
        deleted_product_ids: Array.from(meta.deletedIds),
        updated_at: Date.now(),
      },
      idToken
    );
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        CLIENT_VISIBILITY_STORAGE_KEY,
        JSON.stringify({
          hiddenIds: Array.from(meta.hiddenIds),
          hiddenSlugs: Array.from(meta.hiddenSlugs),
          deletedIds: Array.from(meta.deletedIds),
          suppressLegacySeed: Boolean(meta.suppressLegacySeed),
        })
      );
    } catch {
      // Ignore storage write errors
    }
  }
}

async function firestoreListPublishedProducts(): Promise<StoredProductDoc[]> {
  try {
    const res = await fetch(`${firestoreBaseUrl()}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      const rows = (await res.json()) as Array<{ document?: FirestoreDocResponse }>;
      const results: StoredProductDoc[] = [];
      for (const row of rows) {
        if (!row.document) continue;
        const parsed = docToRecord<StoredProductDoc>(row.document);
        if (parsed) results.push(parsed);
      }
      return results;
    }
  } catch {
    // Fallback to standard list below
  }
  return firestoreListDocs<StoredProductDoc>('products');
}

async function getMergedProductDocs(idToken?: string): Promise<StoredProductDoc[]> {
  const [remoteDocs, meta] = await Promise.all([
    idToken
      ? firestoreListDocs<StoredProductDoc>('products', idToken)
      : firestoreListPublishedProducts(),
    getClientCatalogVisibilityMeta(idToken),
  ]);
  const overrides = loadClientProductOverrides();

  const byId = new Map<string, StoredProductDoc>();
  for (const raw of remoteDocs) {
    if (!raw || !raw.id || meta.deletedIds.has(raw.id)) continue;
    const clean = sanitizeProductDocForFirestore(raw, raw.id);
    if (meta.hiddenIds.has(clean.id) && clean.status === 'published') {
      clean.status = 'draft';
    }
    byId.set(clean.id, clean);
  }

  for (const [ovId, ovDoc] of overrides.entries()) {
    if (meta.deletedIds.has(ovId)) continue;
    const existing = byId.get(ovId);
    if (!existing || Number(ovDoc.updated_at || 0) >= Number(existing.updated_at || 0)) {
      const nextDoc = { ...ovDoc };
      if (meta.hiddenIds.has(nextDoc.id) && nextDoc.status === 'published') {
        nextDoc.status = 'draft';
      }
      byId.set(ovId, nextDoc);
    }
  }

  if (!meta.suppressLegacySeed) {
    const seenIds = new Set(byId.keys());
    const seenSlugs = new Set(Array.from(byId.values()).map((d) => d.slug));

    for (const seed of buildSeedProductsDocs()) {
      if (meta.deletedIds.has(seed.id)) continue;
      if (!seenIds.has(seed.id) && !seenSlugs.has(seed.slug)) {
        if (meta.hiddenIds.has(seed.id) || meta.hiddenSlugs.has(seed.slug)) {
          byId.set(seed.id, { ...seed, status: 'draft' });
        } else {
          byId.set(seed.id, seed);
        }
        seenIds.add(seed.id);
        seenSlugs.add(seed.slug);
      }
    }
  }

  const allDocs = Array.from(byId.values());
  if (!idToken) {
    return allDocs.filter(
      (d) =>
        (d.status === 'published' || d.status === 'active') &&
        !meta.hiddenIds.has(d.id) &&
        !meta.hiddenSlugs.has(d.slug) &&
        !meta.deletedIds.has(d.id)
    );
  }
  return allDocs;
}

interface ClientOrderDoc {
  id: string;
  product_ids?: string[];
  items?: Array<{ product_id?: string }>;
}

function computeProductOrderCounts(orders: ClientOrderDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const order of orders) {
    if (Array.isArray(order.items) && order.items.length > 0) {
      for (const item of order.items) {
        if (item && typeof item.product_id === 'string' && item.product_id) {
          counts.set(item.product_id, (counts.get(item.product_id) || 0) + 1);
        }
      }
    } else if (Array.isArray(order.product_ids)) {
      for (const pid of order.product_ids) {
        if (typeof pid === 'string' && pid) {
          counts.set(pid, (counts.get(pid) || 0) + 1);
        }
      }
    }
  }
  return counts;
}

function assertProductDocWithinFirestoreSizeLimit(doc: StoredProductDoc): void {
  const json = JSON.stringify(doc);
  const byteLength =
    typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(json).length : json.length * 2;
  if (byteLength > 880_000) {
    const msg =
      'Product images and details exceed the 900 KB Firestore document size limit. Please upload fewer or smaller images.';
    throw new ClientFirebaseError(400, 'PAYLOAD_TOO_LARGE', msg, { images: msg });
  }
}

async function writeProductAuditLog(
  idToken: string,
  params: {
    productId: string;
    productTitle: string;
    actorUserId: string;
    actorEmail: string;
    action: string;
    summary: string;
    before?: unknown;
    after?: unknown;
    createdAt?: number;
  }
): Promise<void> {
  const now = params.createdAt ?? Date.now();
  const auditId = `aud_${now.toString(36)}_${randomHex(4)}`;
  await firestoreSetDoc(
    'product_audit_logs',
    auditId,
    {
      id: auditId,
      product_id: params.productId,
      product_title: params.productTitle,
      actor_user_id: params.actorUserId,
      actor_email: params.actorEmail,
      action: params.action,
      entity_type: 'product',
      entity_id: params.productId,
      summary: params.summary,
      ...(params.before !== undefined ? { before_json: JSON.stringify(params.before) } : {}),
      ...(params.after !== undefined ? { after_json: JSON.stringify(params.after) } : {}),
      created_at: now,
    },
    idToken
  ).catch(() => undefined);
}

interface ValidatedClientProductPayload {
  title: string;
  description: string;
  fabricNote: string;
  includedPieces: string;
  careNote: string;
  category: string;
  sku: string;
  pricePaise: number;
  compareAtPaise: number | null;
  lowStockThreshold: number;
  featured: boolean;
  status: 'draft' | 'published' | 'archived';
  colors: ProductColor[];
  sizes: string[];
  variants: NonNullable<StoredProductDoc['variants']>;
  images: NonNullable<StoredProductDoc['images']>;
}

function validateClientProductPayload(params: {
  body: Record<string, unknown>;
  allDocs: StoredProductDoc[];
  existing?: StoredProductDoc;
  productId: string;
}):
  | { ok: true; data: ValidatedClientProductPayload }
  | { ok: false; error: string; fieldErrors: Record<string, string> } {
  const { body, allDocs, existing, productId } = params;
  const now = Date.now();

  const rawTitle =
    typeof body.title === 'string'
      ? body.title
      : typeof body.name === 'string'
        ? body.name
        : existing?.title ?? '';
  const title = rawTitle.trim();
  if (title.length < 2 || title.length > 140) {
    const msg = 'Product title must be between 2 and 140 characters.';
    return { ok: false, error: msg, fieldErrors: { title: msg } };
  }

  const rawDescription =
    typeof body.description === 'string' ? body.description : existing?.description ?? '';
  const description = rawDescription.trim();
  if (description.length < 10 || description.length > 2500) {
    const msg = 'Product description must be between 10 and 2500 characters.';
    return { ok: false, error: msg, fieldErrors: { description: msg } };
  }

  const fabricNote = (
    typeof body.fabricNote === 'string' ? body.fabricNote : existing?.fabric_note ?? ''
  )
    .trim()
    .slice(0, 400);
  const includedPieces = (
    typeof body.includedPieces === 'string'
      ? body.includedPieces
      : existing?.included_pieces ?? ''
  )
    .trim()
    .slice(0, 240);
  const careNote = (
    typeof body.careNote === 'string' ? body.careNote : existing?.care_note ?? ''
  )
    .trim()
    .slice(0, 240);

  const category = (
    typeof body.category === 'string' ? body.category : existing?.category ?? ''
  ).trim();
  if (!category || category.length > 80) {
    const msg = 'Please choose a valid boutique collection category.';
    return { ok: false, error: msg, fieldErrors: { category: msg } };
  }

  const requestedStatus: 'draft' | 'published' | 'archived' =
    body.status === 'draft' || body.status === 'archived'
      ? body.status
      : body.status === 'published' || body.status === 'active'
        ? 'published'
        : existing
          ? existing.status === 'active'
            ? 'published'
            : existing.status
          : 'published';

  const rawSku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : existing?.sku ?? '';
  const sku = rawSku || `SC-${now.toString(36).toUpperCase()}`;
  if (!/^[A-Z0-9][A-Z0-9_-]{1,47}$/.test(sku)) {
    const msg = 'SKU must be 2–48 uppercase letters, numbers, hyphens, or underscores.';
    return { ok: false, error: msg, fieldErrors: { sku: msg } };
  }
  const duplicateMasterSku = allDocs.find(
    (d) => d.id !== existing?.id && d.sku.toUpperCase() === sku
  );
  if (duplicateMasterSku) {
    const msg = `SKU "${sku}" is already assigned to "${duplicateMasterSku.title}".`;
    return { ok: false, error: msg, fieldErrors: { sku: msg } };
  }

  let basePricePaise = existing?.price_paise ?? 0;
  if (body.pricePaise !== undefined) {
    const n = Number(body.pricePaise);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 100 || n > 100_000_000) {
      const msg = 'Selling price must be between ₹1 and ₹10,00,000.';
      return { ok: false, error: msg, fieldErrors: { price: msg } };
    }
    basePricePaise = n;
  } else if (body.priceInr !== undefined) {
    const n = Math.round(Number(body.priceInr) * 100);
    if (!Number.isFinite(n) || n < 100 || n > 100_000_000) {
      const msg = 'Selling price must be between ₹1 and ₹10,00,000.';
      return { ok: false, error: msg, fieldErrors: { price: msg } };
    }
    basePricePaise = n;
  } else if (!existing) {
    const msg = 'Selling price is required.';
    return { ok: false, error: msg, fieldErrors: { price: msg } };
  }

  let baseCompareAtPaise: number | null = existing?.compare_at_paise ?? null;
  if (body.compareAtPaise !== undefined) {
    if (body.compareAtPaise === null || body.compareAtPaise === '') {
      baseCompareAtPaise = null;
    } else {
      const n = Number(body.compareAtPaise);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 100 || n > 100_000_000) {
        const msg = 'Compare-at MRP must be a valid INR amount (₹1 or higher).';
        return { ok: false, error: msg, fieldErrors: { compareAtPrice: msg } };
      }
      if (n <= basePricePaise) {
        const msg = 'Compare-at MRP must be greater than the selling price.';
        return { ok: false, error: msg, fieldErrors: { compareAtPrice: msg } };
      }
      baseCompareAtPaise = n;
    }
  } else if (body.compareAtInr !== undefined) {
    if (body.compareAtInr === null || body.compareAtInr === '') {
      baseCompareAtPaise = null;
    } else {
      const n = Math.round(Number(body.compareAtInr) * 100);
      if (!Number.isFinite(n) || n < 100 || n > 100_000_000) {
        const msg = 'Compare-at MRP must be a valid INR amount (₹1 or higher).';
        return { ok: false, error: msg, fieldErrors: { compareAtPrice: msg } };
      }
      if (n <= basePricePaise) {
        const msg = 'Compare-at MRP must be greater than the selling price.';
        return { ok: false, error: msg, fieldErrors: { compareAtPrice: msg } };
      }
      baseCompareAtPaise = n;
    }
  }

  const lowStockThreshold =
    body.lowStockThreshold !== undefined
      ? Math.max(0, Math.min(10_000, Math.round(Number(body.lowStockThreshold) || 0)))
      : existing?.low_stock_threshold ?? 5;
  const featured =
    body.featured !== undefined ? Boolean(body.featured) : Boolean(existing?.featured);

  // Explicit colour options (optional; backward-compatible when omitted)
  let explicitColors: ProductColor[] = [];
  if (Array.isArray(body.colors) && body.colors.length > 0) {
    const seenColorNames = new Set<string>();
    const seenColorIds = new Set<string>();
    for (let idx = 0; idx < body.colors.length; idx += 1) {
      const rawC = body.colors[idx] as Record<string, unknown>;
      if (!rawC || typeof rawC !== 'object') {
        const msg = 'Invalid colour entry.';
        return { ok: false, error: msg, fieldErrors: { colors: msg } };
      }
      const name = String(rawC.name || '').trim().slice(0, 60);
      if (!name) {
        const msg = 'Every colour option must have a name.';
        return { ok: false, error: msg, fieldErrors: { colors: msg } };
      }
      const normName = name.toLowerCase();
      if (seenColorNames.has(normName)) {
        const msg = `Duplicate colour name "${name}". Each colour option must be unique.`;
        return { ok: false, error: msg, fieldErrors: { colors: msg } };
      }
      seenColorNames.add(normName);

      let cid =
        typeof rawC.id === 'string' && rawC.id.trim()
          ? rawC.id.trim().slice(0, 80)
          : makeStableColorId(name, idx);
      if (seenColorIds.has(cid)) {
        cid = `${cid}-${idx + 1}`;
      }
      seenColorIds.add(cid);

      const hex =
        typeof rawC.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(rawC.hex.trim())
          ? rawC.hex.trim()
          : '#49243E';
      const thumbUrl =
        typeof rawC.thumbnailUrl === 'string' && rawC.thumbnailUrl.trim()
          ? rawC.thumbnailUrl.trim()
          : null;
      if (
        thumbUrl &&
        !thumbUrl.startsWith('https://') &&
        !thumbUrl.startsWith('http://') &&
        !thumbUrl.startsWith('/') &&
        !thumbUrl.startsWith('data:image/')
      ) {
        const msg = `Thumbnail image URL for colour "${name}" must be a valid image path or URL.`;
        return { ok: false, error: msg, fieldErrors: { colors: msg } };
      }

      explicitColors.push({
        id: cid,
        name,
        hex,
        thumbnailUrl: thumbUrl,
        position: typeof rawC.position === 'number' ? rawC.position : idx,
        active: rawC.active === false ? false : true,
      });
    }
    explicitColors.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    explicitColors = explicitColors.map((c, idx) => ({ ...c, position: idx }));
  } else if (existing?.colors_json) {
    try {
      const parsed = JSON.parse(existing.colors_json);
      if (Array.isArray(parsed)) {
        explicitColors = parsed
          .filter((c): c is ProductColor => Boolean(c && typeof c === 'object' && typeof c.name === 'string'))
          .map((c, idx) => ({
            id: c.id || makeStableColorId(c.name, idx),
            name: c.name,
            hex: c.hex || '#49243E',
            thumbnailUrl: c.thumbnailUrl ?? null,
            position: typeof c.position === 'number' ? c.position : idx,
            active: c.active === false ? false : true,
          }));
      }
    } catch {
      explicitColors = [];
    }
  }

  const normalizedImages: NonNullable<StoredProductDoc['images']> = Array.isArray(body.images)
    ? body.images
        .slice(0, 20)
        .filter((img): img is Record<string, unknown> => Boolean(img && typeof img === 'object'))
        .map((img, idx) => ({
          id:
            typeof img.id === 'string' && img.id.trim()
              ? img.id.trim()
              : `${productId}-img-${idx + 1}`,
          product_id: productId,
          media_id: typeof img.mediaId === 'string' ? img.mediaId : null,
          color_id:
            typeof img.colorId === 'string' && img.colorId.trim()
              ? img.colorId.trim().slice(0, 80)
              : null,
          url: String(img.url || img.src || '').trim(),
          alt_text: String(img.alt || title).trim().slice(0, 240) || title,
          is_cover: Boolean(img.isCover ?? idx === 0),
          position: idx,
          created_at: now,
        }))
        .filter((img) => Boolean(img.url))
    : existing?.images ?? [];

  if (requestedStatus === 'published' && normalizedImages.length === 0) {
    const msg = 'Add at least one product photo before publishing.';
    return { ok: false, error: msg, fieldErrors: { images: msg } };
  }
  if (normalizedImages.length > 0 && !normalizedImages.some((i) => i.is_cover)) {
    normalizedImages[0].is_cover = true;
  }

  const colorById = new Map<string, ProductColor>();
  const colorByName = new Map<string, ProductColor>();
  for (const c of explicitColors) {
    if (c.id) colorById.set(c.id, c);
    colorByName.set(c.name.toLowerCase(), c);
  }

  const normalizedVariants: NonNullable<StoredProductDoc['variants']> = [];
  if (Array.isArray(body.variants)) {
    if (body.variants.length === 0) {
      const msg = 'Add at least one size/colour variant before saving.';
      return { ok: false, error: msg, fieldErrors: { variants: msg } };
    }
    if (body.variants.length > 100) {
      const msg = 'A product can have up to 100 colour/size variants.';
      return { ok: false, error: msg, fieldErrors: { variants: msg } };
    }
    const seenCombos = new Set<string>();
    const seenVariantSkus = new Set<string>();
    const otherVariantSkus = new Set<string>();
    for (const other of allDocs) {
      if (other.id === existing?.id) continue;
      for (const v of other.variants || []) {
        if (v.sku) otherVariantSkus.add(v.sku.toUpperCase());
      }
    }

    for (let idx = 0; idx < body.variants.length; idx += 1) {
      const rawV = body.variants[idx] as Record<string, unknown>;
      if (!rawV || typeof rawV !== 'object') {
        const msg = 'Invalid variant entry.';
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      const size = String(rawV.size || '').trim();
      const rawColorId =
        typeof rawV.colorId === 'string' && rawV.colorId.trim() ? rawV.colorId.trim() : null;
      const matchedColor =
        (rawColorId ? colorById.get(rawColorId) : undefined) ||
        colorByName.get(String(rawV.colorName || '').trim().toLowerCase());
      const colorName = String(rawV.colorName || matchedColor?.name || '').trim();
      const resolvedColorId = matchedColor?.id ?? rawColorId ?? (colorName ? makeStableColorId(colorName, idx) : null);
      if (!size || !colorName) {
        const msg = 'Every variant row must specify both a size and a colour name.';
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      const comboKey = `${size.toLowerCase()}::${colorName.toLowerCase()}`;
      if (seenCombos.has(comboKey)) {
        const msg = `Duplicate variant for size "${size}" and colour "${colorName}".`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      seenCombos.add(comboKey);

      const vSkuRaw = typeof rawV.sku === 'string' ? rawV.sku.trim().toUpperCase() : '';
      const vSku =
        vSkuRaw ||
        `${sku}-${size.replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase() || 'SZ'}-${idx + 1}`;
      if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(vSku)) {
        const msg = `Variant SKU "${vSku}" contains invalid characters.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      if (seenVariantSkus.has(vSku)) {
        const msg = `Duplicate variant SKU "${vSku}" within this product.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      seenVariantSkus.add(vSku);
      if (otherVariantSkus.has(vSku)) {
        const msg = `Variant SKU "${vSku}" is already used by another product.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }

      let priceOverridePaise: number | null = null;
      if (rawV.priceOverridePaise !== undefined && rawV.priceOverridePaise !== null && rawV.priceOverridePaise !== '') {
        const n = Number(rawV.priceOverridePaise);
        if (!Number.isFinite(n) || n < 100 || n > 100_000_000) {
          const msg = `Enter a valid INR price override (at least ₹1) for variant ${size} / ${colorName}.`;
          return { ok: false, error: msg, fieldErrors: { variants: msg } };
        }
        priceOverridePaise = Math.round(n);
      } else if (rawV.priceOverrideInr !== undefined && rawV.priceOverrideInr !== null && rawV.priceOverrideInr !== '') {
        const n = Math.round(Number(rawV.priceOverrideInr) * 100);
        if (!Number.isFinite(n) || n < 100 || n > 100_000_000) {
          const msg = `Enter a valid INR price override (at least ₹1) for variant ${size} / ${colorName}.`;
          return { ok: false, error: msg, fieldErrors: { variants: msg } };
        }
        priceOverridePaise = n;
      }

      const vPricePaise =
        priceOverridePaise !== null
          ? priceOverridePaise
          : rawV.pricePaise !== undefined
            ? Number(rawV.pricePaise)
            : rawV.priceInr !== undefined
              ? Math.round(Number(rawV.priceInr) * 100)
              : basePricePaise;
      if (!Number.isFinite(vPricePaise) || vPricePaise < 100 || vPricePaise > 100_000_000) {
        const msg = `Enter a valid INR price (at least ₹1) for variant ${size} / ${colorName}.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }

      let vComparePaise: number | null = baseCompareAtPaise;
      if (rawV.compareAtPaise !== undefined) {
        if (rawV.compareAtPaise === null || rawV.compareAtPaise === '') {
          vComparePaise = null;
        } else {
          const parsedC = Number(rawV.compareAtPaise);
          if (!Number.isFinite(parsedC) || parsedC <= vPricePaise) {
            const msg = `Compare-at MRP for ${size} / ${colorName} must be higher than its selling price.`;
            return { ok: false, error: msg, fieldErrors: { variants: msg } };
          }
          vComparePaise = Math.round(parsedC);
        }
      } else if (rawV.compareAtInr !== undefined) {
        if (rawV.compareAtInr === null || rawV.compareAtInr === '') {
          vComparePaise = null;
        } else {
          const parsedC = Math.round(Number(rawV.compareAtInr) * 100);
          if (!Number.isFinite(parsedC) || parsedC <= vPricePaise) {
            const msg = `Compare-at MRP for ${size} / ${colorName} must be higher than its selling price.`;
            return { ok: false, error: msg, fieldErrors: { variants: msg } };
          }
          vComparePaise = parsedC;
        }
      } else if (vComparePaise !== null && vComparePaise <= vPricePaise) {
        vComparePaise = null;
      }

      const rawStock = rawV.stockQty ?? body.stockQty ?? 0;
      const stockNum = Number(rawStock);
      if (!Number.isInteger(stockNum) || stockNum < 0 || stockNum > 100_000) {
        const msg = `Stock quantity for ${size} / ${colorName} must be an integer between 0 and 100,000.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }

      normalizedVariants.push({
        id:
          typeof rawV.id === 'string' && rawV.id && !rawV.id.startsWith('new-')
            ? rawV.id
            : `${productId}-var-${idx + 1}`,
        product_id: productId,
        sku: vSku,
        size,
        color_id: resolvedColorId,
        color_name: colorName,
        color_hex:
          typeof rawV.colorHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(rawV.colorHex.trim())
            ? rawV.colorHex.trim()
            : matchedColor?.hex || '#49243E',
        price_paise: Math.round(vPricePaise),
        price_override_paise: priceOverridePaise,
        compare_at_paise: vComparePaise,
        stock_qty: stockNum,
        active: rawV.active === false || rawV.active === 0 ? false : true,
        position: idx,
      });
    }
  } else if (existing?.variants && existing.variants.length > 0) {
    existing.variants.forEach((v, idx) => {
      const override = v.price_override_paise ?? null;
      normalizedVariants.push({
        ...v,
        position: idx,
        price_paise:
          override !== null
            ? override
            : body.pricePaise !== undefined || body.priceInr !== undefined
              ? basePricePaise
              : Number(v.price_paise),
        compare_at_paise:
          body.compareAtPaise !== undefined || body.compareAtInr !== undefined
            ? baseCompareAtPaise
            : v.compare_at_paise,
        stock_qty:
          body.stockQty !== undefined && idx === 0
            ? Math.max(0, Math.round(Number(body.stockQty)))
            : Number(v.stock_qty),
        active: v.active === false || v.active === 0 ? false : true,
      });
    });
  } else {
    const singleStock = Math.max(0, Math.round(Number(body.stockQty ?? 1)));
    normalizedVariants.push({
      id: `${productId}-var-1`,
      product_id: productId,
      sku: `${sku}-STD-1`,
      size: 'Free Size',
      color_id: explicitColors[0]?.id ?? makeStableColorId(explicitColors[0]?.name || 'Signature', 0),
      color_name: explicitColors[0]?.name || 'Signature',
      color_hex: explicitColors[0]?.hex || '#49243E',
      price_paise: basePricePaise,
      price_override_paise: null,
      compare_at_paise: baseCompareAtPaise,
      stock_qty: singleStock,
      active: true,
      position: 0,
    });
  }

  // Build final colour list preserving explicit metadata (thumbnailUrl, position, active)
  const finalColorsMap = new Map<string, ProductColor>();
  for (const c of explicitColors) {
    finalColorsMap.set(c.name.toLowerCase(), { ...c });
  }
  for (const v of normalizedVariants) {
    const key = v.color_name.toLowerCase();
    if (!finalColorsMap.has(key)) {
      finalColorsMap.set(key, {
        id: v.color_id || makeStableColorId(v.color_name, finalColorsMap.size),
        name: v.color_name,
        hex: v.color_hex,
        thumbnailUrl: null,
        position: finalColorsMap.size,
        active: true,
      });
    }
  }
  const derivedColors = Array.from(finalColorsMap.values())
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c, idx) => {
      const cid = c.id || makeStableColorId(c.name, idx);
      const colorImgs = normalizedImages.filter((img) => img.color_id === cid);
      const thumb =
        c.thumbnailUrl ||
        colorImgs.find((img) => img.is_cover)?.url ||
        colorImgs[0]?.url ||
        (finalColorsMap.size === 1
          ? normalizedImages.find((img) => img.is_cover)?.url || normalizedImages[0]?.url || null
          : null);
      return {
        ...c,
        id: cid,
        thumbnailUrl: thumb,
        position: idx,
        active: c.active !== false,
      };
    });

  // Backfill canonical color_id on variants
  const canonicalColorIdByName = new Map(derivedColors.map((c) => [c.name.toLowerCase(), c.id!]));
  for (const v of normalizedVariants) {
    const cid = canonicalColorIdByName.get(v.color_name.toLowerCase());
    if (cid) v.color_id = cid;
  }

  const matrixCheck = validateColorVariantMatrix({
    colors: derivedColors,
    variants: normalizedVariants.map((v) => ({
      sku: v.sku,
      size: v.size,
      colorId: v.color_id ?? null,
      colorName: v.color_name,
      pricePaise: v.price_paise,
      priceOverridePaise: v.price_override_paise ?? null,
      stockQty: v.stock_qty,
      active: v.active !== false,
    })),
    images: normalizedImages.map((img) => ({
      url: img.url,
      colorId: img.color_id ?? null,
    })),
    requireCompleteForPublish: requestedStatus === 'published',
  });
  if (!matrixCheck.ok) {
    const firstMsg = matrixCheck.errors[0] || 'Invalid colour variant configuration.';
    return {
      ok: false,
      error: firstMsg,
      fieldErrors: { ...matrixCheck.fieldErrors, variants: firstMsg },
    };
  }

  const activeVariantPool = normalizedVariants.filter(
    (v) => v.active !== false && isVariantColorActiveInMetadata(derivedColors, v)
  );
  const priceSourceVariants = activeVariantPool.length > 0 ? activeVariantPool : normalizedVariants;
  const derivedSizes = Array.from(new Set(priceSourceVariants.map((v) => v.size)));
  const minPricePaise = Math.min(...priceSourceVariants.map((v) => Number(v.price_paise)));
  const lowestVariant = priceSourceVariants.find((v) => Number(v.price_paise) === minPricePaise);

  return {
    ok: true,
    data: {
      title,
      description,
      fabricNote,
      includedPieces,
      careNote,
      category,
      sku,
      pricePaise: minPricePaise,
      compareAtPaise: lowestVariant?.compare_at_paise ?? baseCompareAtPaise,
      lowStockThreshold,
      featured,
      status: requestedStatus,
      colors: derivedColors,
      sizes: derivedSizes,
      variants: normalizedVariants,
      images: normalizedImages,
    },
  };
}

function formatProductDto(doc: StoredProductDoc, includeAdmin = false, orderCount = 0) {
  const variants = Array.isArray(doc.variants) ? doc.variants : [];
  const images = Array.isArray(doc.images) ? doc.images : [];

  let colors: ProductColor[] = [];
  let sizes: string[] = [];
  try {
    const parsed = JSON.parse(doc.colors_json || '[]');
    if (Array.isArray(parsed)) {
      colors = parsed
        .filter((c): c is ProductColor => Boolean(c && typeof c === 'object' && typeof c.name === 'string'))
        .map((c, idx) => ({
          id: c.id || makeStableColorId(c.name, idx),
          name: c.name,
          hex: c.hex || '#49243E',
          thumbnailUrl: c.thumbnailUrl ?? null,
          position: typeof c.position === 'number' ? c.position : idx,
          active: c.active === false ? false : true,
        }))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
  } catch {
    colors = [];
  }
  try {
    sizes = JSON.parse(doc.sizes_json || '[]') as string[];
  } catch {
    sizes = [];
  }

  const activeVariants = variants.filter(
    (v) => v.active !== false && v.active !== 0 && isVariantColorActiveInMetadata(colors, v)
  );
  const effectiveVariants = activeVariants.length > 0 ? activeVariants : variants;

  const totalStock =
    variants.length > 0
      ? activeVariants.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0)
      : Number(doc.stock_qty || 0);
  const effectivePricePaise =
    effectiveVariants.length > 0
      ? Math.min(...effectiveVariants.map((v) => Number(v.price_paise || doc.price_paise)))
      : Number(doc.price_paise || 0);
  const minVariant =
    effectiveVariants.find((v) => Number(v.price_paise) === effectivePricePaise) ||
    effectiveVariants[0] ||
    null;
  const effectiveComparePaise = minVariant
    ? minVariant.compare_at_paise
    : doc.compare_at_paise;

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
    ...(doc.included_pieces ? { includedPieces: doc.included_pieces } : {}),
    ...(doc.care_note ? { careNote: doc.care_note } : {}),
    stockQty: totalStock,
    lowStockThreshold: Number(doc.low_stock_threshold ?? 2),
    inStock: totalStock > 0,
    images: images.map((img, idx) => ({
      id: img.id,
      src: img.url,
      alt: img.alt_text || doc.title,
      isCover: Boolean(img.is_cover),
      colorId: img.color_id ?? null,
      position: Number(img.position ?? idx),
    })),
    colors,
    sizes,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      size: v.size,
      colorId: v.color_id ?? null,
      colorName: v.color_name,
      colorHex: v.color_hex,
      pricePaise: Number(v.price_paise),
      priceOverridePaise: v.price_override_paise ?? null,
      compareAtPaise: v.compare_at_paise,
      stockQty: Number(v.stock_qty),
      active: v.active === false || v.active === 0 ? false : true,
      position: Number(v.position),
    })),
    featured: Boolean(doc.featured),
    dateAdded,
    updatedAt: Number(doc.updated_at || Date.now()),
  };

  if (!includeAdmin) return pub;
  let pendingFields: string[] = [];
  if (doc.pending_fields_json) {
    try {
      const parsed = JSON.parse(doc.pending_fields_json);
      if (Array.isArray(parsed)) pendingFields = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      pendingFields = [];
    }
  }
  return {
    ...pub,
    sku: doc.sku,
    status: doc.status === 'active' ? 'published' : doc.status || 'published',
    importKey: doc.import_key ?? null,
    sourceImageFilename: doc.source_image_filename ?? null,
    pendingFields,
    catalogBatch: doc.catalog_batch ?? null,
    version: Number(doc.version || 1),
    publishedAt: doc.published_at,
    archivedAt: doc.archived_at,
    createdAt: Number(doc.created_at || Date.now()),
    orderCount,
    rawImages: images.map((img, idx) => ({
      id: img.id,
      url: img.url,
      alt: img.alt_text || doc.title,
      isCover: Boolean(img.is_cover),
      colorId: img.color_id ?? null,
      position: Number(img.position ?? idx),
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

  const lookup = await lookupFirebaseAccountDetailed(signIn.idToken);
  if (lookup.status === 'transient_error') {
    return {
      ok: false,
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      error: 'Unable to reach Firebase Authentication right now. Please try again in a moment.',
    };
  }
  if (lookup.status !== 'ok') {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_CREDENTIALS',
      error: 'Unable to verify your login token. Please try again.',
    };
  }
  const account = lookup.account;

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
  const isOwner = Boolean(
    account.email &&
      account.emailVerified &&
      account.email.toLowerCase() === AUTHORIZED_OWNER_EMAIL
  );

  // Sync user profile in Firestore using rules-compliant schema (boolean email_verified, no password_hash)
  const existingUserDoc = await firestoreGetDoc<{
    full_name?: string;
    created_at?: number;
    phone_e164?: string | null;
    phone_verified?: boolean;
    contact_phone?: string | null;
    notification_prefs_json?: string | null;
    notification_prefs?: unknown;
  }>('users', account.uid, signIn.idToken).catch(() => null);

  const fullName =
    account.displayName ||
    signIn.displayName ||
    existingUserDoc?.full_name ||
    (isOwner ? 'Store Owner' : 'Member');

  const notificationPrefs = parseNotificationPrefs(
    existingUserDoc?.notification_prefs ?? existingUserDoc?.notification_prefs_json
  );

  const verifiedPhone = account.phoneNumber || null;
  const contactPhone =
    existingUserDoc?.contact_phone ??
    existingUserDoc?.phone_e164 ??
    verifiedPhone ??
    null;

  await firestoreSetDoc(
    'users',
    account.uid,
    {
      id: account.uid,
      full_name: fullName.slice(0, 100),
      email: account.email,
      email_verified: true,
      phone_e164: verifiedPhone || existingUserDoc?.phone_e164 || null,
      phone_verified: Boolean(verifiedPhone),
      contact_phone: contactPhone,
      has_password: account.hasPassword,
      sign_in_providers: account.providerIds,
      notification_prefs_json: JSON.stringify(notificationPrefs),
      created_at: Number(existingUserDoc?.created_at || now),
      updated_at: now,
    },
    signIn.idToken
  ).catch(() => undefined);

  let boundAt = now;
  let boundVia = 'firebase_verified_owner';
  if (isOwner) {
    const existingBinding = await firestoreGetDoc<{
      owner_user_id?: string;
      bound_email?: string;
      bound_at?: number;
      bound_via?: string;
    }>('admin_bindings', 'primary', signIn.idToken).catch(() => null);

    if (
      existingBinding?.owner_user_id &&
      existingBinding.owner_user_id !== account.uid
    ) {
      return {
        ok: false,
        status: 403,
        code: 'OWNER_CONFLICT',
        error:
          'Owner access is already bound to a different Firebase Auth UID. Contact support to transfer ownership.',
      };
    }

    if (existingBinding?.bound_at) {
      boundAt = Number(existingBinding.bound_at);
      boundVia = existingBinding.bound_via || boundVia;
    } else {
      await firestoreSetDoc(
        'admin_bindings',
        'primary',
        {
          owner_user_id: account.uid,
          bound_email: account.email,
          bound_at: now,
          bound_via: boundVia,
        },
        signIn.idToken
      ).catch(() => undefined);
    }
  }

  const session: ClientFirebaseSession = {
    idToken: signIn.idToken,
    refreshToken: signIn.refreshToken,
    uid: account.uid,
    email: account.email,
    fullName,
    phone: contactPhone,
    verifiedPhone,
    notificationPrefs,
    emailVerified: true,
    phoneVerified: Boolean(verifiedPhone),
    hasPassword: account.hasPassword,
    signInProviders: account.providerIds,
    lastReauthAt: now,
    issuedAt: now,
    expiresAtMs: account.expiresAtMs,
    lastVerifiedAt: now,
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

async function establishPhoneClientSession(params: {
  idToken: string;
  refreshToken: string;
  fullName?: string;
}): Promise<
  ApiResult<{
    csrfToken: string;
    user: AuthUser;
  }>
> {
  const idToken = String(params.idToken || '').trim();
  const refreshToken = String(params.refreshToken || '').trim();
  if (!idToken || !refreshToken) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      error: 'Missing Firebase authentication tokens.',
    };
  }

  const lookup = await lookupFirebaseAccountDetailed(idToken);
  if (lookup.status === 'transient_error') {
    return {
      ok: false,
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      error: 'Unable to reach Firebase Authentication right now. Please try again in a moment.',
    };
  }
  if (lookup.status !== 'ok') {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_CREDENTIALS',
      error: 'Unable to verify your mobile OTP token. Please try again.',
    };
  }

  const account = lookup.account;
  if (!account.phoneNumber) {
    return {
      ok: false,
      status: 403,
      code: 'PHONE_NOT_VERIFIED',
      error: 'A verified mobile number is required to sign in.',
    };
  }

  const cleanRequestedName =
    typeof params.fullName === 'string' && params.fullName.trim().length >= 2
      ? params.fullName.trim().slice(0, 100)
      : '';

  if (cleanRequestedName && cleanRequestedName !== account.displayName) {
    await callIdentityToolkit('accounts:update', {
      idToken,
      displayName: cleanRequestedName,
      returnSecureToken: false,
    }).catch(() => undefined);
  }

  const now = Date.now();
  const existingUserDoc = await firestoreGetDoc<{
    full_name?: string;
    created_at?: number;
    contact_phone?: string | null;
    phone_e164?: string | null;
    notification_prefs_json?: string | null;
    notification_prefs?: unknown;
  }>('users', account.uid, idToken).catch(() => null);

  const fullName =
    cleanRequestedName ||
    account.displayName ||
    existingUserDoc?.full_name ||
    'Customer';

  const notificationPrefs = parseNotificationPrefs(
    existingUserDoc?.notification_prefs ?? existingUserDoc?.notification_prefs_json
  );
  const contactPhone = existingUserDoc?.contact_phone || account.phoneNumber;

  await firestoreSetDoc(
    'users',
    account.uid,
    {
      id: account.uid,
      full_name: fullName.slice(0, 100),
      email: account.email,
      email_verified: Boolean(account.email && account.emailVerified),
      phone_e164: account.phoneNumber,
      phone_verified: true,
      contact_phone: contactPhone,
      has_password: account.hasPassword,
      sign_in_providers: account.providerIds,
      notification_prefs_json: JSON.stringify(notificationPrefs),
      created_at: Number(existingUserDoc?.created_at || now),
      updated_at: now,
    },
    idToken
  ).catch(() => undefined);

  const session: ClientFirebaseSession = {
    idToken,
    refreshToken,
    uid: account.uid,
    email: account.email,
    fullName,
    phone: contactPhone,
    verifiedPhone: account.phoneNumber,
    notificationPrefs,
    emailVerified: Boolean(account.email && account.emailVerified),
    phoneVerified: true,
    hasPassword: account.hasPassword,
    signInProviders: account.providerIds,
    lastReauthAt: now,
    issuedAt: now,
    expiresAtMs: account.expiresAtMs,
    lastVerifiedAt: now,
    csrfToken: randomHex(16),
  };
  saveStoredSession(session);
  emitBoutiqueSyncEvent('account');

  return {
    ok: true,
    data: {
      csrfToken: session.csrfToken,
      user: buildPublicAuthUser(session),
    },
  };
}

export async function handleClientlessApiRequest<T>(
  rawPath: string,
  method: string,
  rawBody?: unknown
): Promise<ApiResult<T>> {
  const upperMethod = (method || 'GET').toUpperCase();
  const [pathname, rawQuery = ''] = rawPath.split('?');
  const queryParams = new URLSearchParams(rawQuery);
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

    // 3b. Mobile OTP Sign-In / Sign-Up Session
    if (cleanPath === '/api/auth/phone-session' && upperMethod === 'POST') {
      const res = await establishPhoneClientSession({
        idToken: typeof body.idToken === 'string' ? body.idToken : '',
        refreshToken: typeof body.refreshToken === 'string' ? body.refreshToken : '',
        fullName: typeof body.fullName === 'string' ? body.fullName : undefined,
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
      const existingBinding = await firestoreGetDoc<{
        owner_user_id?: string;
        bound_email?: string;
        bound_at?: number;
        bound_via?: string;
      }>('admin_bindings', 'primary', session.idToken).catch(() => null);

      if (
        existingBinding?.owner_user_id &&
        existingBinding.owner_user_id !== session.uid
      ) {
        return {
          ok: false,
          status: 403,
          code: 'OWNER_CONFLICT',
          error:
            'Owner access is already bound to a different Firebase Auth UID. Contact support to transfer ownership.',
        };
      }

      const boundAt = Number(existingBinding?.bound_at || session.issuedAt);
      const boundVia = existingBinding?.bound_via || 'firebase_verified_owner';
      if (!existingBinding?.owner_user_id) {
        await firestoreSetDoc(
          'admin_bindings',
          'primary',
          {
            owner_user_id: session.uid,
            bound_email: session.email,
            bound_at: boundAt,
            bound_via: boundVia,
          },
          session.idToken
        ).catch(() => undefined);
      }

      return {
        ok: true,
        data: {
          authenticated: true,
          isOwner: true,
          user: buildPublicAuthUser(session),
          ownerBinding: {
            boundAt,
            boundVia,
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
        const userDoc = await firestoreGetDoc<{
          full_name?: string;
          phone_e164?: string | null;
          phone_verified?: boolean;
          contact_phone?: string | null;
          notification_prefs_json?: string | null;
          notification_prefs?: unknown;
        }>('users', session.uid, session.idToken).catch(() => null);
        if (userDoc) {
          const verifiedPhone =
            session.phoneVerified && (session.verifiedPhone || userDoc.phone_e164)
              ? session.verifiedPhone || userDoc.phone_e164 || null
              : null;
          const synced: ClientFirebaseSession = {
            ...session,
            fullName: userDoc.full_name || session.fullName,
            verifiedPhone,
            phone:
              userDoc.contact_phone !== undefined
                ? userDoc.contact_phone
                : userDoc.phone_e164 !== undefined
                  ? userDoc.phone_e164
                  : (session.phone ?? null),
            notificationPrefs: parseNotificationPrefs(
              userDoc.notification_prefs ?? userDoc.notification_prefs_json ?? session.notificationPrefs
            ),
          };
          saveStoredSession(synced);
          return {
            ok: true,
            data: { user: buildPublicAuthUser(synced) } as unknown as T,
          };
        }
        return {
          ok: true,
          data: { user: buildPublicAuthUser(session) } as unknown as T,
        };
      }
      if (upperMethod === 'PATCH') {
        const hasFullName = body.fullName !== undefined;
        const fullName =
          typeof body.fullName === 'string' ? body.fullName.trim() : session.fullName;
        if (hasFullName && (fullName.length < 2 || fullName.length > 100)) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: 'Please enter a valid full name (2–100 characters).',
          };
        }

        let nextContactPhone = session.phone ?? null;
        if (body.phone !== undefined) {
          if (body.phone === null || String(body.phone).trim() === '') {
            nextContactPhone = null;
          } else {
            const rawPhone = String(body.phone).trim();
            const digits = rawPhone.replace(/[\s()-]/g, '');
            if (!/^\+?[0-9]{7,15}$/.test(digits)) {
              return {
                ok: false,
                status: 400,
                code: 'VALIDATION_ERROR',
                error: 'Please enter a valid phone number (7–15 digits) or leave it blank.',
              };
            }
            nextContactPhone = rawPhone.slice(0, 24);
          }
        }

        const existingUserDoc = await firestoreGetDoc<{
          created_at?: number;
          phone_e164?: string | null;
          phone_verified?: boolean;
          contact_phone?: string | null;
          notification_prefs_json?: string | null;
          notification_prefs?: unknown;
        }>('users', session.uid, session.idToken).catch(() => null);

        const basePrefs = parseNotificationPrefs(
          existingUserDoc?.notification_prefs ??
            existingUserDoc?.notification_prefs_json ??
            session.notificationPrefs
        );

        let nextPrefs = basePrefs;
        if (body.notificationPrefs !== undefined) {
          if (
            !body.notificationPrefs ||
            typeof body.notificationPrefs !== 'object' ||
            Array.isArray(body.notificationPrefs)
          ) {
            return {
              ok: false,
              status: 400,
              code: 'VALIDATION_ERROR',
              error: 'Invalid notification preferences format.',
            };
          }
          nextPrefs = parseNotificationPrefs({
            ...basePrefs,
            ...(body.notificationPrefs as Record<string, unknown>),
          });
        }

        if (hasFullName && fullName !== session.fullName) {
          await callIdentityToolkit('accounts:update', {
            idToken: session.idToken,
            displayName: fullName,
            returnSecureToken: false,
          });
        }

        const hasVerifiedLoginPhone = Boolean(
          session.phoneVerified && (session.verifiedPhone || existingUserDoc?.phone_e164)
        );
        const preservedLoginPhone = hasVerifiedLoginPhone
          ? session.verifiedPhone || existingUserDoc?.phone_e164 || null
          : body.phone !== undefined
            ? nextContactPhone
            : (existingUserDoc?.phone_e164 ?? nextContactPhone);
        const resolvedContactPhone =
          body.phone !== undefined
            ? nextContactPhone
            : (existingUserDoc?.contact_phone ?? existingUserDoc?.phone_e164 ?? nextContactPhone);

        const now = Date.now();
        await firestoreSetDoc(
          'users',
          session.uid,
          {
            id: session.uid,
            full_name: fullName,
            email: session.email,
            email_verified: Boolean(session.email && session.emailVerified),
            phone_e164: preservedLoginPhone,
            phone_verified: hasVerifiedLoginPhone,
            contact_phone: resolvedContactPhone,
            has_password: session.hasPassword !== false,
            ...(session.signInProviders ? { sign_in_providers: session.signInProviders } : {}),
            notification_prefs_json: JSON.stringify(nextPrefs),
            created_at: Number(existingUserDoc?.created_at || session.issuedAt || now),
            updated_at: now,
          },
          session.idToken
        );

        const updatedSession: ClientFirebaseSession = {
          ...session,
          fullName,
          phone: resolvedContactPhone,
          verifiedPhone: hasVerifiedLoginPhone ? preservedLoginPhone : null,
          phoneVerified: hasVerifiedLoginPhone,
          notificationPrefs: nextPrefs,
        };
        saveStoredSession(updatedSession);
        emitBoutiqueSyncEvent('account');
        return {
          ok: true,
          data: { user: buildPublicAuthUser(updatedSession) } as unknown as T,
        };
      }
      if (upperMethod === 'DELETE') {
        if ((session.email || '').toLowerCase() === AUTHORIZED_OWNER_EMAIL) {
          return {
            ok: false,
            status: 403,
            code: 'OWNER_ACCOUNT_PROTECTED',
            error: 'The verified store owner account cannot be deleted from customer settings.',
          };
        }
        if (Date.now() - session.lastReauthAt > REAUTH_WINDOW_MS) {
          return {
            ok: false,
            status: 403,
            code: 'REAUTH_REQUIRED',
            error: 'Please verify your identity above before permanently deleting your account.',
          };
        }
        const confirmText = typeof body.confirmText === 'string' ? body.confirmText.trim() : '';
        if (confirmText !== 'DELETE') {
          return {
            ok: false,
            status: 400,
            code: 'CONFIRMATION_REQUIRED',
            error: 'Type DELETE to confirm permanent account deletion.',
          };
        }

        const [addresses, paymentMethods, notifications, customerOrders] = await Promise.all([
          firestoreListDocs<{ id?: string }>(`users/${encodeURIComponent(session.uid)}/addresses`, session.idToken).catch(() => []),
          firestoreListDocs<{ id?: string }>(`users/${encodeURIComponent(session.uid)}/payment_methods`, session.idToken).catch(() => []),
          firestoreListDocs<{ id?: string }>(`users/${encodeURIComponent(session.uid)}/notifications`, session.idToken).catch(() => []),
          firestoreRunQuery<{ id?: string }>(
            'orders',
            [{ field: 'customer_user_id', value: session.uid }],
            session.idToken
          ).catch(() => []),
        ]);

        const delNow = Date.now();
        await Promise.all([
          ...addresses
            .filter((a) => typeof a.id === 'string' && a.id)
            .map((a) =>
              firestoreDeleteDoc(`users/${encodeURIComponent(session.uid)}/addresses`, String(a.id), session.idToken).catch(() => undefined)
            ),
          ...paymentMethods
            .filter((p) => typeof p.id === 'string' && p.id)
            .map((p) =>
              firestoreDeleteDoc(`users/${encodeURIComponent(session.uid)}/payment_methods`, String(p.id), session.idToken).catch(() => undefined)
            ),
          ...notifications
            .filter((n) => typeof n.id === 'string' && n.id)
            .map((n) =>
              firestoreDeleteDoc(`users/${encodeURIComponent(session.uid)}/notifications`, String(n.id), session.idToken).catch(() => undefined)
            ),
          ...customerOrders
            .filter((o) => typeof o.id === 'string' && o.id)
            .map((o) =>
              firestoreSetDoc(
                'orders',
                String(o.id),
                { customer_user_id: null, updated_at: delNow },
                session.idToken,
                ['customer_user_id', 'updated_at']
              ).catch(() => undefined)
            ),
          firestoreDeleteDoc(`users/${encodeURIComponent(session.uid)}/wishlist`, 'items', session.idToken).catch(() => undefined),
        ]);

        await firestoreDeleteDoc('users', session.uid, session.idToken);
        await callIdentityToolkit('accounts:delete', { idToken: session.idToken }).catch(
          () => undefined
        );
        clearClientFirebaseSession();
        emitBoutiqueSyncEvent('account');
        return {
          ok: true,
          data: {
            ok: true,
            deletedUserId: session.uid,
            csrfToken: randomHex(16),
            message: 'Your account and saved personal data have been permanently deleted.',
          } as unknown as T,
        };
      }
    }

    if (cleanPath === '/api/account/phone' && upperMethod === 'POST') {
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
          error: 'Please verify your identity before updating your verified mobile number.',
        };
      }

      const idToken = typeof body.idToken === 'string' ? body.idToken.trim() : '';
      const refreshToken =
        typeof body.refreshToken === 'string' && body.refreshToken.trim()
          ? body.refreshToken.trim()
          : session.refreshToken;
      if (!idToken) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Missing verified Firebase token for the updated mobile number.',
        };
      }

      const lookup = await lookupFirebaseAccountDetailed(idToken);
      if (lookup.status !== 'ok') {
        return {
          ok: false,
          status: 401,
          code: 'INVALID_CREDENTIALS',
          error: 'Unable to verify updated mobile number credentials. Please try again.',
        };
      }
      if (lookup.account.uid !== session.uid) {
        return {
          ok: false,
          status: 403,
          code: 'ACCOUNT_MISMATCH',
          error: 'This mobile verification belongs to a different account.',
        };
      }
      if (!lookup.account.phoneNumber) {
        return {
          ok: false,
          status: 400,
          code: 'PHONE_NOT_LINKED',
          error: 'No verified mobile number was found on your Firebase account.',
        };
      }

      const existingUserDoc = await firestoreGetDoc<{
        created_at?: number;
        contact_phone?: string | null;
        notification_prefs_json?: string | null;
        notification_prefs?: unknown;
      }>('users', session.uid, idToken).catch(() => null);

      const now = Date.now();
      const contactPhone = existingUserDoc?.contact_phone ?? lookup.account.phoneNumber;
      const basePrefs = parseNotificationPrefs(
        existingUserDoc?.notification_prefs ??
          existingUserDoc?.notification_prefs_json ??
          session.notificationPrefs
      );

      await firestoreSetDoc(
        'users',
        session.uid,
        {
          id: session.uid,
          full_name: lookup.account.displayName || session.fullName,
          email: lookup.account.email,
          email_verified: Boolean(lookup.account.email && lookup.account.emailVerified),
          phone_e164: lookup.account.phoneNumber,
          phone_verified: true,
          contact_phone: contactPhone,
          has_password: lookup.account.hasPassword,
          sign_in_providers: lookup.account.providerIds,
          notification_prefs_json: JSON.stringify(basePrefs),
          created_at: Number(existingUserDoc?.created_at || session.issuedAt || now),
          updated_at: now,
        },
        idToken
      );

      const updatedSession: ClientFirebaseSession = {
        ...session,
        idToken,
        refreshToken,
        email: lookup.account.email,
        emailVerified: Boolean(lookup.account.email && lookup.account.emailVerified),
        verifiedPhone: lookup.account.phoneNumber,
        phoneVerified: true,
        phone: session.phone || lookup.account.phoneNumber,
        hasPassword: lookup.account.hasPassword,
        signInProviders: lookup.account.providerIds,
        lastReauthAt: now,
        lastVerifiedAt: now,
      };
      saveStoredSession(updatedSession);
      emitBoutiqueSyncEvent('account');
      return {
        ok: true,
        data: {
          message: `Verified login mobile number updated to ${lookup.account.phoneNumber}.`,
          user: buildPublicAuthUser(updatedSession),
        } as unknown as T,
      };
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

      const idToken = typeof body.idToken === 'string' ? body.idToken.trim() : '';
      if (idToken) {
        const lookup = await lookupFirebaseAccountDetailed(idToken);
        if (lookup.status !== 'ok') {
          return {
            ok: false,
            status: 401,
            code: 'INVALID_CREDENTIALS',
            error: 'Unable to confirm mobile OTP reauthentication.',
          };
        }
        if (lookup.account.uid !== session.uid) {
          return {
            ok: false,
            status: 403,
            code: 'ACCOUNT_MISMATCH',
            error: 'Verification token does not match your signed-in account.',
          };
        }
        if (Date.now() - lookup.account.authTimeMs > 5 * 60_000) {
          return {
            ok: false,
            status: 403,
            code: 'REAUTH_REQUIRED',
            error: 'Please complete a fresh SMS verification step to confirm your identity.',
          };
        }
        const refreshToken =
          typeof body.refreshToken === 'string' && body.refreshToken.trim()
            ? body.refreshToken.trim()
            : session.refreshToken;
        const updated: ClientFirebaseSession = {
          ...session,
          idToken,
          refreshToken,
          lastReauthAt: Date.now(),
          lastVerifiedAt: Date.now(),
        };
        saveStoredSession(updated);
        return {
          ok: true,
          data: {
            message: 'Identity reauthenticated via verified mobile OTP.',
            user: buildPublicAuthUser(updated),
          } as unknown as T,
        };
      }

      const password = typeof body.password === 'string' ? body.password : '';
      if (!session.email || !session.hasPassword) {
        return {
          ok: false,
          status: 400,
          code: 'NO_PASSWORD_CONFIGURED',
          error: 'Use mobile OTP verification above to reauthenticate this account.',
        };
      }
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

    // 12b. Customer Account Menu Endpoints (/api/account/* except profile/reauth/change-password handled above)
    if (cleanPath === '/api/account/orders' && upperMethod === 'GET') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const docs = await firestoreRunQuery<Record<string, unknown>>(
        'orders',
        [{ field: 'customer_user_id', value: session.uid }],
        session.idToken
      );
      const items = docs
        .map((d) => serializeClientOrderDoc(d))
        .filter((o) => !o.hiddenByCustomer)
        .sort((a, b) => b.createdAt - a.createdAt);
      const pendingRzpItems = items
        .filter(
          (o) =>
            o.paymentMethod === 'razorpay' &&
            o.paymentStatus !== 'paid' &&
            !['cancelled', 'refunded'].includes(o.status) &&
            Boolean(o.razorpayOrderId)
        )
        .slice(0, 6);
      if (pendingRzpItems.length > 0) {
        await Promise.all(
          pendingRzpItems.map(async (item) => {
            const check = await verifyRazorpayOrderStatusFromServer(
              item.razorpayOrderId || '',
              item.razorpayPaymentId || null,
              session.idToken
            );
            if (check?.confirmed) {
              const serverOrderStatus = String(
                check.order?.status || check.order?.fulfillmentStatus || ''
              ).toLowerCase();
              if (serverOrderStatus === 'cancelled' || item.status === 'cancelled') {
                item.status = 'cancelled';
                item.fulfillmentStatus = 'cancelled';
                item.paymentStatus = 'paid';
                item.refundStatus =
                  (check.order?.refundStatus as typeof item.refundStatus) || 'pending_refund';
              } else {
                item.status = 'confirmed';
                item.paymentStatus = 'paid';
                item.fulfillmentStatus = 'confirmed';
              }
              if (check.paymentId) item.razorpayPaymentId = check.paymentId;
            }
          })
        );
      }
      return { ok: true, data: { items } as unknown as T };
    }

    if (
      cleanPath.startsWith('/api/account/orders/') &&
      cleanPath.endsWith('/request/withdraw') &&
      upperMethod === 'POST'
    ) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const orderId = decodeURIComponent(
        cleanPath.slice('/api/account/orders/'.length, -'/request/withdraw'.length)
      );
      const meta = await firestoreGetDocWithMeta<Record<string, unknown>>(
        'orders',
        orderId,
        session.idToken
      );
      if (!meta) {
        return {
          ok: false,
          status: 404,
          code: 'ORDER_NOT_FOUND',
          error: 'Order not found.',
        };
      }
      const existing = meta.data;
      if (existing.customer_user_id !== session.uid) {
        return {
          ok: false,
          status: 403,
          code: 'FORBIDDEN',
          error: 'You can only withdraw requests on your own orders.',
        };
      }
      const prevHistory = parseOrderHistory(existing.status_history ?? existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: typeof existing.status === 'string' ? existing.status : undefined,
        rawFulfillmentStatus:
          typeof existing.fulfillment_status === 'string' ? existing.fulfillment_status : undefined,
        rawCancelRequest: existing.cancel_request ?? existing.cancel_request_json,
        rawReturnRequest: existing.return_request ?? existing.return_request_json,
        history: prevHistory,
        paymentMethod:
          typeof existing.payment_method === 'string' ? existing.payment_method : undefined,
      });
      const reqType: 'cancel' | 'return' | null =
        body.type === 'cancel'
          ? 'cancel'
          : body.type === 'return'
            ? 'return'
            : norm.cancelRequest?.status === 'pending'
              ? 'cancel'
              : norm.returnRequest?.status === 'pending'
                ? 'return'
                : null;
      const target = reqType === 'cancel' ? norm.cancelRequest : reqType === 'return' ? norm.returnRequest : null;
      if (!target || !reqType) {
        return {
          ok: false,
          status: 404,
          code: 'REQUEST_NOT_FOUND',
          error: 'No active request found on this order.',
        };
      }
      if (target.status !== 'pending') {
        return {
          ok: false,
          status: 409,
          code: 'CONCURRENCY_CONFLICT',
          error: `Cannot withdraw ${reqType} request because it has already been ${target.status}.`,
        };
      }
      const now = Date.now();
      const updatedReq: OrderReturnRequest = {
        ...target,
        status: 'withdrawn',
        updatedAt: now,
        resolvedAt: now,
        resolutionNote: 'Withdrawn by customer',
      };
      const nextHistory: OrderStatusHistoryEntry[] = [
        ...(prevHistory as OrderStatusHistoryEntry[]),
        {
          status: `${reqType}_withdrawn`,
          note: `${reqType === 'cancel' ? 'Cancellation' : 'Return'} request withdrawn by customer`,
          actor: 'customer',
          at: now,
        },
      ];
      const patchFields =
        reqType === 'cancel'
          ? {
              cancel_request: updatedReq,
              cancel_request_json: JSON.stringify(updatedReq),
              return_request: norm.returnRequest ?? null,
              return_request_json: norm.returnRequest ? JSON.stringify(norm.returnRequest) : null,
            }
          : {
              return_request: updatedReq,
              return_request_json: JSON.stringify(updatedReq),
            };
      const patch: Record<string, unknown> = {
        status: norm.fulfillmentStatus,
        fulfillment_status: norm.fulfillmentStatus,
        ...patchFields,
        status_history: nextHistory,
        status_history_json: JSON.stringify(nextHistory),
        updated_at: now,
      };
      await firestoreSetDoc(
        'orders',
        orderId,
        patch,
        session.idToken,
        Object.keys(patch),
        { updateTime: meta.updateTime }
      );
      emitBoutiqueSyncEvent('orders');
      return {
        ok: true,
        data: { order: serializeClientOrderDoc({ ...existing, ...patch }) } as unknown as T,
      };
    }

    const performCustomerOrderCancellation = async (params: {
      orderId: string;
      reason: string;
      expectedUpdatedAt?: number | null;
      session: ClientFirebaseSession;
    }): Promise<ApiResult<T>> => {
      const { orderId, reason, expectedUpdatedAt = null, session } = params;
      if (reason.length > 500) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Cancellation reason must be 500 characters or fewer.',
        };
      }

      // 1. Prefer trusted backend /api/cancel-order (handles atomic stock restoration + notification + rules)
      if (typeof fetch === 'function') {
        try {
          const serverRes = await fetch('/api/cancel-order', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${session.idToken}`,
            },
            body: JSON.stringify({
              orderId,
              ...(reason ? { reason } : {}),
              ...(typeof expectedUpdatedAt === 'number' && Number.isFinite(expectedUpdatedAt)
                ? { expectedUpdatedAt }
                : {}),
            }),
          });
          const contentType = serverRes.headers.get('content-type') || '';
          const payload = contentType.includes('application/json')
            ? ((await serverRes.json().catch(() => ({}))) as Record<string, unknown>)
            : null;

          if (serverRes.ok && payload && payload.order) {
            emitBoutiqueSyncEvent('orders');
            return {
              ok: true,
              data: payload as unknown as T,
            };
          }

          // Return explicit business/auth/concurrency errors directly without falling back
          if (
            payload &&
            (serverRes.status === 400 ||
              serverRes.status === 401 ||
              serverRes.status === 403 ||
              serverRes.status === 409 ||
              serverRes.status === 422 ||
              (serverRes.status === 404 && payload.code === 'ORDER_NOT_FOUND'))
          ) {
            return {
              ok: false,
              status: serverRes.status,
              code: typeof payload.code === 'string' ? payload.code : 'CANCEL_FAILED',
              error:
                typeof payload.error === 'string'
                  ? payload.error
                  : 'Unable to cancel this order.',
            };
          }
        } catch {
          // Network unreachable (e.g. offline static host or local mock); fall through to direct Firestore path
        }
      }

      // 2. Direct Firestore atomic self-cancel fallback (optimistic updateTime precondition + strict rules)
      const meta = await firestoreGetDocWithMeta<Record<string, unknown>>(
        'orders',
        orderId,
        session.idToken
      );
      if (!meta) {
        return {
          ok: false,
          status: 404,
          code: 'ORDER_NOT_FOUND',
          error: 'Order not found.',
        };
      }
      const existing = meta.data;
      if (existing.customer_user_id !== session.uid) {
        return {
          ok: false,
          status: 403,
          code: 'FORBIDDEN',
          error: 'You can only cancel your own orders.',
        };
      }
      const prevHistory = parseOrderHistory(existing.status_history ?? existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: typeof existing.status === 'string' ? existing.status : undefined,
        rawFulfillmentStatus:
          typeof existing.fulfillment_status === 'string' ? existing.fulfillment_status : undefined,
        rawCancelRequest: existing.cancel_request ?? existing.cancel_request_json,
        rawReturnRequest: existing.return_request ?? existing.return_request_json,
        rawPaymentStatus: existing.payment_status,
        rawRefundStatus: existing.refund_status,
        rawCancelledAt: existing.cancelled_at,
        rawCancelledBy: existing.cancelled_by,
        rawCancelReason: existing.cancel_reason,
        razorpayPaymentId: existing.razorpay_payment_id,
        history: prevHistory,
        paymentMethod:
          typeof existing.payment_method === 'string' ? existing.payment_method : undefined,
      });

      if (norm.status === 'cancelled') {
        return {
          ok: true,
          data: {
            ok: true,
            alreadyCancelled: true,
            order: serializeClientOrderDoc(existing),
          } as unknown as T,
        };
      }

      const currentUpdatedAt = Number(existing.updated_at || existing.created_at || 0);
      if (
        typeof expectedUpdatedAt === 'number' &&
        Number.isFinite(expectedUpdatedAt) &&
        currentUpdatedAt !== expectedUpdatedAt
      ) {
        return {
          ok: false,
          status: 409,
          code: 'CONCURRENCY_CONFLICT',
          error:
            'This order was updated by the studio while you were viewing it. Please refresh to see the latest status.',
        };
      }

      if (!PRE_SHIPPING_CANCEL_STATES.has(norm.fulfillmentStatus)) {
        return {
          ok: false,
          status: 409,
          code: 'CANCELLATION_CUTOFF_PASSED',
          error: `Cancellation is unavailable because the order is already ${norm.fulfillmentStatus}.`,
        };
      }

      const now = Date.now();
      const { refundStatus } = normalizePaymentAndRefundStatus({
        rawPaymentStatus: existing.payment_status,
        rawRefundStatus: existing.refund_status,
        paymentMethod: existing.payment_method,
        orderStatus: 'cancelled',
        razorpayPaymentId: existing.razorpay_payment_id,
      });
      const cancelRecord: OrderReturnRequest = {
        id: norm.cancelRequest?.id || `req_${now.toString(36)}_${randomHex(3)}`,
        type: 'cancel',
        reason: reason || 'Cancelled by customer',
        status: 'approved',
        requestedAt: norm.cancelRequest?.requestedAt || now,
        updatedAt: now,
        resolvedAt: now,
        resolutionNote: 'Cancelled directly by customer prior to dispatch',
      };
      const nextHistory: OrderStatusHistoryEntry[] = [
        ...(prevHistory as OrderStatusHistoryEntry[]),
        {
          status: 'cancelled',
          note: reason ? `Order cancelled by customer: ${reason}` : 'Order cancelled by customer',
          actor: 'customer',
          at: now,
        },
      ];
      const patch: Record<string, unknown> = {
        status: 'cancelled',
        fulfillment_status: 'cancelled',
        cancelled_at: now,
        cancelled_by: 'customer',
        cancel_reason: reason || null,
        refund_status: refundStatus,
        cancel_request: cancelRecord,
        cancel_request_json: JSON.stringify(cancelRecord),
        status_history: nextHistory,
        status_history_json: JSON.stringify(nextHistory),
        updated_at: now,
      };
      try {
        await firestoreSetDoc(
          'orders',
          orderId,
          patch,
          session.idToken,
          Object.keys(patch),
          { updateTime: meta.updateTime }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('FAILED_PRECONDITION') || msg.includes('409') || msg.includes('412')) {
          return {
            ok: false,
            status: 409,
            code: 'CONCURRENCY_CONFLICT',
            error:
              'This order was updated concurrently. Please refresh and verify its latest status.',
          };
        }
        return {
          ok: false,
          status: msg.includes('PERMISSION_DENIED') || msg.includes('403') ? 403 : 500,
          code: 'CANCEL_PERSIST_FAILED',
          error: 'Could not save order cancellation. Please try again.',
        };
      }
      emitBoutiqueSyncEvent('orders');
      return {
        ok: true,
        data: {
          ok: true,
          alreadyCancelled: false,
          order: serializeClientOrderDoc({ ...existing, ...patch }),
        } as unknown as T,
      };
    };

    if (
      cleanPath.startsWith('/api/account/orders/') &&
      cleanPath.endsWith('/cancel') &&
      upperMethod === 'POST'
    ) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const orderId = decodeURIComponent(
        cleanPath.slice('/api/account/orders/'.length, -'/cancel'.length)
      );
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const expectedUpdatedAt =
        typeof body.expectedUpdatedAt === 'number' && Number.isFinite(body.expectedUpdatedAt)
          ? body.expectedUpdatedAt
          : null;
      return performCustomerOrderCancellation({
        orderId,
        reason,
        expectedUpdatedAt,
        session,
      });
    }

    if (
      cleanPath.startsWith('/api/account/orders/') &&
      cleanPath.endsWith('/request') &&
      (upperMethod === 'POST' || upperMethod === 'PATCH' || upperMethod === 'DELETE')
    ) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const orderId = decodeURIComponent(
        cleanPath.slice('/api/account/orders/'.length, -'/request'.length)
      );
      if (upperMethod === 'POST' && body.type === 'cancel') {
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        const expectedUpdatedAt =
          typeof body.expectedUpdatedAt === 'number' && Number.isFinite(body.expectedUpdatedAt)
            ? body.expectedUpdatedAt
            : null;
        return performCustomerOrderCancellation({
          orderId,
          reason,
          expectedUpdatedAt,
          session,
        });
      }
      const meta = await firestoreGetDocWithMeta<Record<string, unknown>>(
        'orders',
        orderId,
        session.idToken
      );
      if (!meta) {
        return {
          ok: false,
          status: 404,
          code: 'ORDER_NOT_FOUND',
          error: 'Order not found.',
        };
      }
      const existing = meta.data;
      if (existing.customer_user_id !== session.uid) {
        return {
          ok: false,
          status: 403,
          code: 'FORBIDDEN',
          error: 'You can only manage requests for your own orders.',
        };
      }
      const prevHistory = parseOrderHistory(existing.status_history ?? existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: typeof existing.status === 'string' ? existing.status : undefined,
        rawFulfillmentStatus:
          typeof existing.fulfillment_status === 'string' ? existing.fulfillment_status : undefined,
        rawCancelRequest: existing.cancel_request ?? existing.cancel_request_json,
        rawReturnRequest: existing.return_request ?? existing.return_request_json,
        history: prevHistory,
        paymentMethod:
          typeof existing.payment_method === 'string' ? existing.payment_method : undefined,
      });

      if (upperMethod === 'DELETE') {
        const reqType: 'cancel' | 'return' | null =
          body.type === 'cancel'
            ? 'cancel'
            : body.type === 'return'
              ? 'return'
              : norm.cancelRequest?.status === 'pending'
                ? 'cancel'
                : norm.returnRequest?.status === 'pending'
                  ? 'return'
                  : null;
        const target =
          reqType === 'cancel' ? norm.cancelRequest : reqType === 'return' ? norm.returnRequest : null;
        if (!target || !reqType) {
          return {
            ok: false,
            status: 404,
            code: 'REQUEST_NOT_FOUND',
            error: 'No active pending request found on this order.',
          };
        }
        if (target.status !== 'pending') {
          return {
            ok: false,
            status: 409,
            code: 'CONCURRENCY_CONFLICT',
            error: `Cannot withdraw ${reqType} request because it has already been ${target.status}.`,
          };
        }
        const now = Date.now();
        const updatedReq: OrderReturnRequest = {
          ...target,
          status: 'withdrawn',
          updatedAt: now,
          resolvedAt: now,
          resolutionNote: 'Withdrawn by customer',
        };
        const nextHistory: OrderStatusHistoryEntry[] = [
          ...(prevHistory as OrderStatusHistoryEntry[]),
          {
            status: `${reqType}_withdrawn`,
            note: `${reqType === 'cancel' ? 'Cancellation' : 'Return'} request withdrawn by customer`,
            actor: 'customer',
            at: now,
          },
        ];
        const patchFields =
          reqType === 'cancel'
            ? {
                cancel_request: updatedReq,
                cancel_request_json: JSON.stringify(updatedReq),
                return_request: norm.returnRequest ?? null,
                return_request_json: norm.returnRequest ? JSON.stringify(norm.returnRequest) : null,
              }
            : {
                return_request: updatedReq,
                return_request_json: JSON.stringify(updatedReq),
              };
        const patch: Record<string, unknown> = {
          status: norm.fulfillmentStatus,
          fulfillment_status: norm.fulfillmentStatus,
          ...patchFields,
          status_history: nextHistory,
          status_history_json: JSON.stringify(nextHistory),
          updated_at: now,
        };
        await firestoreSetDoc(
          'orders',
          orderId,
          patch,
          session.idToken,
          Object.keys(patch),
          { updateTime: meta.updateTime }
        );
        emitBoutiqueSyncEvent('orders');
        return {
          ok: true,
          data: { order: serializeClientOrderDoc({ ...existing, ...patch }) } as unknown as T,
        };
      }

      const reqType = body.type === 'cancel' ? 'cancel' : body.type === 'return' ? 'return' : null;
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
      if (!reqType) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Request type must be "cancel" or "return".',
        };
      }
      if (reason.length < 3 || reason.length > 500) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please provide a reason between 3 and 500 characters.',
        };
      }

      if (upperMethod === 'PATCH') {
        const target = reqType === 'cancel' ? norm.cancelRequest : norm.returnRequest;
        if (!target) {
          return {
            ok: false,
            status: 404,
            code: 'REQUEST_NOT_FOUND',
            error: 'No existing request found on this order.',
          };
        }
        if (target.status !== 'pending') {
          return {
            ok: false,
            status: 409,
            code: 'CONCURRENCY_CONFLICT',
            error: `Cannot edit ${reqType} request because it is already "${target.status}".`,
          };
        }
        if (reqType === 'cancel' && !PRE_SHIPPING_CANCEL_STATES.has(norm.fulfillmentStatus)) {
          return {
            ok: false,
            status: 409,
            code: 'CANCELLATION_CUTOFF_PASSED',
            error: `Cancellation is no longer available because the order is ${norm.fulfillmentStatus}.`,
          };
        }
        const now = Date.now();
        const updatedReq: OrderReturnRequest = {
          ...target,
          reason,
          updatedAt: now,
        };
        const nextHistory: OrderStatusHistoryEntry[] = [
          ...(prevHistory as OrderStatusHistoryEntry[]),
          {
            status: `${reqType}_request_updated`,
            note: `${reqType === 'cancel' ? 'Cancellation' : 'Return'} reason updated: ${reason}`,
            actor: 'customer',
            at: now,
          },
        ];
        const patchFields =
          reqType === 'cancel'
            ? {
                cancel_request: updatedReq,
                cancel_request_json: JSON.stringify(updatedReq),
                return_request: norm.returnRequest ?? null,
                return_request_json: norm.returnRequest ? JSON.stringify(norm.returnRequest) : null,
              }
            : {
                return_request: updatedReq,
                return_request_json: JSON.stringify(updatedReq),
              };
        const patch: Record<string, unknown> = {
          status: norm.fulfillmentStatus,
          fulfillment_status: norm.fulfillmentStatus,
          ...patchFields,
          status_history: nextHistory,
          status_history_json: JSON.stringify(nextHistory),
          updated_at: now,
        };
        await firestoreSetDoc(
          'orders',
          orderId,
          patch,
          session.idToken,
          Object.keys(patch),
          { updateTime: meta.updateTime }
        );
        emitBoutiqueSyncEvent('orders');
        return {
          ok: true,
          data: { order: serializeClientOrderDoc({ ...existing, ...patch }) } as unknown as T,
        };
      }

      // POST submit new request
      if (reqType === 'cancel') {
        if (!PRE_SHIPPING_CANCEL_STATES.has(norm.fulfillmentStatus)) {
          return {
            ok: false,
            status: 409,
            code: 'CANCELLATION_CUTOFF_PASSED',
            error: `Cancellation is unavailable once an order is ${norm.fulfillmentStatus}.`,
          };
        }
        if (norm.cancelRequest?.status === 'pending') {
          if (norm.cancelRequest.reason === reason) {
            return {
              ok: true,
              data: { order: serializeClientOrderDoc(existing) } as unknown as T,
            };
          }
          return {
            ok: false,
            status: 409,
            code: 'REQUEST_ALREADY_PENDING',
            error: 'A cancellation request is already pending for this order.',
          };
        }
      } else {
        if (!RETURN_ELIGIBLE_STATES.has(norm.fulfillmentStatus)) {
          return {
            ok: false,
            status: 409,
            code: 'RETURN_NOT_ELIGIBLE',
            error: 'Returns can only be requested after an order has been delivered.',
          };
        }
        if (norm.returnRequest?.status === 'pending') {
          if (norm.returnRequest.reason === reason) {
            return {
              ok: true,
              data: { order: serializeClientOrderDoc(existing) } as unknown as T,
            };
          }
          return {
            ok: false,
            status: 409,
            code: 'REQUEST_ALREADY_PENDING',
            error: 'A return request is already pending for this order.',
          };
        }
      }

      const now = Date.now();
      const newReq: OrderReturnRequest = {
        id: `req_${now.toString(36)}_${randomHex(3)}`,
        type: reqType,
        reason,
        status: 'pending',
        requestedAt: now,
        updatedAt: now,
        resolvedAt: null,
      };
      const nextHistory: OrderStatusHistoryEntry[] = [
        ...(prevHistory as OrderStatusHistoryEntry[]),
        {
          status: reqType === 'cancel' ? 'cancel_requested' : 'return_requested',
          note: `${reqType === 'cancel' ? 'Cancellation' : 'Return'} requested: ${reason}`,
          actor: 'customer',
          at: now,
        },
      ];
      const patchFields =
        reqType === 'cancel'
          ? {
              cancel_request: newReq,
              cancel_request_json: JSON.stringify(newReq),
            }
          : {
              return_request: newReq,
              return_request_json: JSON.stringify(newReq),
            };
      const patch: Record<string, unknown> = {
        status: norm.fulfillmentStatus,
        fulfillment_status: norm.fulfillmentStatus,
        ...patchFields,
        status_history: nextHistory,
        status_history_json: JSON.stringify(nextHistory),
        updated_at: now,
      };
      await firestoreSetDoc(
        'orders',
        orderId,
        patch,
        session.idToken,
        Object.keys(patch),
        { updateTime: meta.updateTime }
      );
      emitBoutiqueSyncEvent('orders');
      return {
        ok: true,
        data: { order: serializeClientOrderDoc({ ...existing, ...patch }) } as unknown as T,
      };
    }

    if (
      cleanPath.startsWith('/api/account/orders/') &&
      cleanPath.endsWith('/delivery') &&
      upperMethod === 'PATCH'
    ) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const orderId = decodeURIComponent(
        cleanPath.slice('/api/account/orders/'.length, -'/delivery'.length)
      );
      const meta = await firestoreGetDocWithMeta<Record<string, unknown>>(
        'orders',
        orderId,
        session.idToken
      );
      if (!meta) {
        return {
          ok: false,
          status: 404,
          code: 'ORDER_NOT_FOUND',
          error: 'Order not found.',
        };
      }
      const existing = meta.data;
      if (existing.customer_user_id !== session.uid) {
        return {
          ok: false,
          status: 403,
          code: 'FORBIDDEN',
          error: 'You can only edit delivery details for your own orders.',
        };
      }
      const prevHistory = parseOrderHistory(existing.status_history ?? existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: typeof existing.status === 'string' ? existing.status : undefined,
        rawFulfillmentStatus:
          typeof existing.fulfillment_status === 'string' ? existing.fulfillment_status : undefined,
        rawCancelRequest: existing.cancel_request ?? existing.cancel_request_json,
        rawReturnRequest: existing.return_request ?? existing.return_request_json,
        history: prevHistory,
        paymentMethod:
          typeof existing.payment_method === 'string' ? existing.payment_method : undefined,
      });
      if (!PRE_CUTOFF_DELIVERY_EDIT_STATES.has(norm.fulfillmentStatus)) {
        return {
          ok: false,
          status: 409,
          code: 'DELIVERY_EDIT_CUTOFF_PASSED',
          error: `Delivery details cannot be edited once an order is ${norm.fulfillmentStatus}.`,
        };
      }
      const nextName =
        typeof body.customerName === 'string'
          ? body.customerName.trim()
          : String(existing.customer_name || '');
      const nextPhone =
        typeof body.customerPhone === 'string'
          ? body.customerPhone.trim()
          : String(existing.customer_phone || '');
      const nextAddress =
        typeof body.shippingAddress === 'string'
          ? body.shippingAddress.trim()
          : String(existing.shipping_address || '');
      if (nextName.length < 2 || nextPhone.length < 7 || nextAddress.length < 10) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please enter a valid recipient name, phone number, and delivery address.',
        };
      }
      const now = Date.now();
      const nextHistory: OrderStatusHistoryEntry[] = [
        ...(prevHistory as OrderStatusHistoryEntry[]),
        {
          status: 'delivery_updated',
          note: 'Delivery contact/address updated by customer before dispatch',
          actor: 'customer',
          at: now,
        },
      ];
      const patch: Record<string, unknown> = {
        customer_name: nextName.slice(0, 120),
        customer_phone: nextPhone.slice(0, 32),
        shipping_address: nextAddress.slice(0, 600),
        delivery_details_edited_at: now,
        status_history: nextHistory,
        status_history_json: JSON.stringify(nextHistory),
        updated_at: now,
      };
      await firestoreSetDoc(
        'orders',
        orderId,
        patch,
        session.idToken,
        Object.keys(patch),
        { updateTime: meta.updateTime }
      );
      emitBoutiqueSyncEvent('orders');
      return {
        ok: true,
        data: { order: serializeClientOrderDoc({ ...existing, ...patch }) } as unknown as T,
      };
    }

    if (
      cleanPath.startsWith('/api/account/orders/') &&
      cleanPath.endsWith('/hide') &&
      upperMethod === 'POST'
    ) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const orderId = decodeURIComponent(
        cleanPath.slice('/api/account/orders/'.length, -'/hide'.length)
      );
      const existing = await firestoreGetDoc<Record<string, unknown>>(
        'orders',
        orderId,
        session.idToken
      );
      if (!existing) {
        return {
          ok: false,
          status: 404,
          code: 'ORDER_NOT_FOUND',
          error: 'Order not found.',
        };
      }
      if (existing.customer_user_id !== session.uid) {
        return {
          ok: false,
          status: 403,
          code: 'FORBIDDEN',
          error: 'You can only hide orders from your own account.',
        };
      }
      const now = Date.now();
      await firestoreSetDoc(
        'orders',
        orderId,
        {
          hidden_by_customer: true,
          hidden_at: now,
          updated_at: now,
        },
        session.idToken,
        ['hidden_by_customer', 'hidden_at', 'updated_at']
      );
      emitBoutiqueSyncEvent('orders');
      return {
        ok: true,
        data: { ok: true, hiddenOrderId: orderId } as unknown as T,
      };
    }

    if (cleanPath === '/api/account/addresses') {
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
        const docs = await firestoreListDocs<Record<string, unknown>>(
          `users/${encodeURIComponent(session.uid)}/addresses`,
          session.idToken
        );
        const items = docs
          .map((d) => serializeClientAddressDoc(d))
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt - a.updatedAt);
        return { ok: true, data: { items } as unknown as T };
      }
      if (upperMethod === 'POST') {
        const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
        const line1 = typeof body.line1 === 'string' ? body.line1.trim() : '';
        const line2 = typeof body.line2 === 'string' ? body.line2.trim() : '';
        const city = typeof body.city === 'string' ? body.city.trim() : '';
        const state = typeof body.state === 'string' ? body.state.trim() : '';
        const pincode = typeof body.pincode === 'string' ? body.pincode.trim() : '';
        const landmark = typeof body.landmark === 'string' ? body.landmark.trim() : '';
        const label = body.label === 'Work' || body.label === 'Other' ? body.label : 'Home';
        if (
          fullName.length < 2 ||
          phone.length < 7 ||
          line1.length < 5 ||
          city.length < 2 ||
          state.length < 2 ||
          pincode.length < 4
        ) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: 'Please complete recipient name, phone, street address, city, state, and PIN code.',
          };
        }
        const existingDocs = await firestoreListDocs<Record<string, unknown>>(
          `users/${encodeURIComponent(session.uid)}/addresses`,
          session.idToken
        );
        const id =
          typeof body.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(body.id)
            ? body.id
            : `addr_${Date.now().toString(36)}_${randomHex(3)}`;
        const isDefault = Boolean(body.isDefault) || existingDocs.length === 0;
        const now = Date.now();
        const prev = existingDocs.find((a) => String(a.id) === id);
        if (isDefault) {
          for (const a of existingDocs) {
            if (String(a.id) !== id && (a.is_default === true || a.is_default === 1)) {
              await firestoreSetDoc(
                `users/${encodeURIComponent(session.uid)}/addresses`,
                String(a.id),
                {
                  id: String(a.id),
                  full_name: String(a.full_name || ''),
                  phone: String(a.phone || ''),
                  line1: String(a.line1 || ''),
                  line2: String(a.line2 || ''),
                  city: String(a.city || ''),
                  state: String(a.state || ''),
                  pincode: String(a.pincode || ''),
                  landmark: String(a.landmark || ''),
                  label: a.label === 'Work' || a.label === 'Other' ? a.label : 'Home',
                  is_default: false,
                  created_at: Number(a.created_at || now),
                  updated_at: now,
                },
                session.idToken
              );
            }
          }
        }
        const record: Record<string, unknown> = {
          id,
          full_name: fullName.slice(0, 120),
          phone: phone.slice(0, 32),
          line1: line1.slice(0, 240),
          line2: line2.slice(0, 240),
          city: city.slice(0, 80),
          state: state.slice(0, 80),
          pincode: pincode.slice(0, 16),
          landmark: landmark.slice(0, 140),
          label,
          is_default: isDefault,
          created_at: Number(prev?.created_at || now),
          updated_at: now,
        };
        await firestoreSetDoc(
          `users/${encodeURIComponent(session.uid)}/addresses`,
          id,
          record,
          session.idToken
        );
        return {
          ok: true,
          data: { address: serializeClientAddressDoc(record) } as unknown as T,
        };
      }
    }

    if (cleanPath.startsWith('/api/account/addresses/')) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const addrId = decodeURIComponent(cleanPath.slice('/api/account/addresses/'.length));
      if (upperMethod === 'DELETE') {
        const colPath = `users/${encodeURIComponent(session.uid)}/addresses`;
        await firestoreDeleteDoc(colPath, addrId, session.idToken);
        const remaining = await firestoreListDocs<Record<string, unknown>>(
          colPath,
          session.idToken
        );
        const hasDefault = remaining.some((a) => a.is_default === true || a.is_default === 1);
        if (remaining.length > 0 && !hasDefault) {
          const sortedRemaining = [...remaining].sort(
            (a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0)
          );
          const candidate = sortedRemaining[0];
          const cid = String(candidate.id || '');
          if (cid) {
            await firestoreSetDoc(
              colPath,
              cid,
              { ...candidate, is_default: true, updated_at: Date.now() },
              session.idToken
            ).catch(() => undefined);
          }
        }
        return { ok: true, data: { deletedId: addrId, ok: true } as unknown as T };
      }
      if (upperMethod === 'PATCH' || upperMethod === 'PUT') {
        const existingDocs = await firestoreListDocs<Record<string, unknown>>(
          `users/${encodeURIComponent(session.uid)}/addresses`,
          session.idToken
        );
        const prev = existingDocs.find((a) => String(a.id) === addrId);
        const now = Date.now();
        const isDefault =
          body.isDefault !== undefined
            ? Boolean(body.isDefault)
            : Boolean(prev?.is_default === true || prev?.is_default === 1);
        if (isDefault) {
          for (const a of existingDocs) {
            if (String(a.id) !== addrId && (a.is_default === true || a.is_default === 1)) {
              await firestoreSetDoc(
                `users/${encodeURIComponent(session.uid)}/addresses`,
                String(a.id),
                {
                  id: String(a.id),
                  full_name: String(a.full_name || ''),
                  phone: String(a.phone || ''),
                  line1: String(a.line1 || ''),
                  line2: String(a.line2 || ''),
                  city: String(a.city || ''),
                  state: String(a.state || ''),
                  pincode: String(a.pincode || ''),
                  landmark: String(a.landmark || ''),
                  label: a.label === 'Work' || a.label === 'Other' ? a.label : 'Home',
                  is_default: false,
                  created_at: Number(a.created_at || now),
                  updated_at: now,
                },
                session.idToken
              );
            }
          }
        }
        const record: Record<string, unknown> = {
          id: addrId,
          full_name: String(
            typeof body.fullName === 'string' ? body.fullName.trim() : prev?.full_name || ''
          ).slice(0, 120),
          phone: String(
            typeof body.phone === 'string' ? body.phone.trim() : prev?.phone || ''
          ).slice(0, 32),
          line1: String(
            typeof body.line1 === 'string' ? body.line1.trim() : prev?.line1 || ''
          ).slice(0, 240),
          line2: String(
            typeof body.line2 === 'string' ? body.line2.trim() : prev?.line2 || ''
          ).slice(0, 240),
          city: String(
            typeof body.city === 'string' ? body.city.trim() : prev?.city || ''
          ).slice(0, 80),
          state: String(
            typeof body.state === 'string' ? body.state.trim() : prev?.state || ''
          ).slice(0, 80),
          pincode: String(
            typeof body.pincode === 'string' ? body.pincode.trim() : prev?.pincode || ''
          ).slice(0, 16),
          landmark: String(
            typeof body.landmark === 'string' ? body.landmark.trim() : prev?.landmark || ''
          ).slice(0, 140),
          label:
            body.label === 'Work' || body.label === 'Other'
              ? body.label
              : prev?.label === 'Work' || prev?.label === 'Other'
                ? prev.label
                : 'Home',
          is_default: isDefault,
          created_at: Number(prev?.created_at || now),
          updated_at: now,
        };
        await firestoreSetDoc(
          `users/${encodeURIComponent(session.uid)}/addresses`,
          addrId,
          record,
          session.idToken
        );
        return {
          ok: true,
          data: { address: serializeClientAddressDoc(record) } as unknown as T,
        };
      }
    }

    if (cleanPath === '/api/account/wishlist') {
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
        const doc = await firestoreGetDoc<{ product_ids?: string[] }>(
          `users/${encodeURIComponent(session.uid)}/wishlist`,
          'items',
          session.idToken
        );
        const productIds = Array.isArray(doc?.product_ids)
          ? doc.product_ids.filter((id): id is string => typeof id === 'string')
          : [];
        return { ok: true, data: { productIds } as unknown as T };
      }
      if (upperMethod === 'PUT') {
        const rawIds = Array.isArray(body.productIds) ? body.productIds : [];
        const unique = Array.from(
          new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
        );
        await firestoreSetDoc(
          `users/${encodeURIComponent(session.uid)}/wishlist`,
          'items',
          { product_ids: unique, updated_at: Date.now() },
          session.idToken
        );
        return { ok: true, data: { productIds: unique } as unknown as T };
      }
    }

    if (cleanPath === '/api/account/notifications' && upperMethod === 'GET') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const docs = await firestoreListDocs<Record<string, unknown>>(
        `users/${encodeURIComponent(session.uid)}/notifications`,
        session.idToken
      );
      const items = docs
        .map((d) => serializeClientNotificationDoc(d))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 60);
      return {
        ok: true,
        data: {
          items,
          unreadCount: items.filter((n) => !n.read).length,
        } as unknown as T,
      };
    }

    if (cleanPath === '/api/account/notifications/read-all' && upperMethod === 'POST') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const docs = await firestoreListDocs<Record<string, unknown>>(
        `users/${encodeURIComponent(session.uid)}/notifications`,
        session.idToken
      );
      const now = Date.now();
      for (const n of docs) {
        const isAlreadyRead = n.is_read === 1 || n.is_read === true || n.read === true;
        if (!isAlreadyRead && typeof n.id === 'string') {
          await firestoreSetDoc(
            `users/${encodeURIComponent(session.uid)}/notifications`,
            n.id,
            { is_read: 1, read: true, read_at: now },
            session.idToken,
            ['is_read', 'read', 'read_at']
          );
        }
      }
      return { ok: true, data: { ok: true } as unknown as T };
    }

    if (
      cleanPath.startsWith('/api/account/notifications/') &&
      cleanPath.endsWith('/read') &&
      upperMethod === 'PATCH'
    ) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const notifId = decodeURIComponent(
        cleanPath.slice('/api/account/notifications/'.length, -'/read'.length)
      );
      const existing = await firestoreGetDoc<Record<string, unknown>>(
        `users/${encodeURIComponent(session.uid)}/notifications`,
        notifId,
        session.idToken
      );
      if (!existing) {
        return {
          ok: false,
          status: 404,
          code: 'NOTIFICATION_NOT_FOUND',
          error: 'Notification not found.',
        };
      }
      await firestoreSetDoc(
        `users/${encodeURIComponent(session.uid)}/notifications`,
        notifId,
        { is_read: 1, read: true, read_at: Date.now() },
        session.idToken,
        ['is_read', 'read', 'read_at']
      );
      return { ok: true, data: { ok: true, id: notifId } as unknown as T };
    }

    if (
      cleanPath.startsWith('/api/account/notifications/') &&
      upperMethod === 'DELETE'
    ) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const notifId = decodeURIComponent(
        cleanPath.slice('/api/account/notifications/'.length)
      );
      const existing = await firestoreGetDoc<Record<string, unknown>>(
        `users/${encodeURIComponent(session.uid)}/notifications`,
        notifId,
        session.idToken
      );
      if (!existing) {
        return {
          ok: false,
          status: 404,
          code: 'NOTIFICATION_NOT_FOUND',
          error: 'Notification not found.',
        };
      }
      await firestoreDeleteDoc(
        `users/${encodeURIComponent(session.uid)}/notifications`,
        notifId,
        session.idToken
      );
      return { ok: true, data: { ok: true, deletedId: notifId } as unknown as T };
    }

    if (cleanPath === '/api/account/coupons' && upperMethod === 'GET') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const now = Date.now();
      const [activeNumDocs, activeBoolDocs] = await Promise.all([
        firestoreRunQuery<Record<string, unknown>>(
          'coupons',
          [{ field: 'active', value: 1 }],
          session.idToken
        ),
        firestoreRunQuery<Record<string, unknown>>(
          'coupons',
          [{ field: 'active', value: true }],
          session.idToken
        ),
      ]);
      const deduped = new Map<string, ReturnType<typeof serializeClientCouponDoc>>();
      for (const rawDoc of [...activeNumDocs, ...activeBoolDocs]) {
        const serialized = serializeClientCouponDoc(rawDoc);
        if (serialized.id) deduped.set(serialized.id, serialized);
      }
      const available = Array.from(deduped.values()).filter(
        (c) =>
          c.active &&
          (!c.startsAt || now >= c.startsAt) &&
          (!c.expiresAt || now <= c.expiresAt) &&
          (c.usageLimit === null || c.usedCount < c.usageLimit)
      );
      return { ok: true, data: { items: available } as unknown as T };
    }

    if (cleanPath === '/api/account/rewards' && upperMethod === 'GET') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const [loyaltyDoc, orderDocs] = await Promise.all([
        firestoreGetDoc<{ data?: Partial<LoyaltyConfig> }>(
          'site_documents',
          'loyalty_config',
          session.idToken
        ),
        firestoreRunQuery<Record<string, unknown>>(
          'orders',
          [{ field: 'customer_user_id', value: session.uid }],
          session.idToken
        ),
      ]);
      const config = mergeLoyaltyConfig(
        loyaltyDoc?.data ?? (loyaltyDoc as Partial<LoyaltyConfig> | null) ?? DEFAULT_LOYALTY_CONFIG
      );
      const serialized = orderDocs.map((d) => serializeClientOrderDoc(d));
      const qualifying = serialized.filter(
        (o) =>
          o.paymentStatus.toLowerCase() === 'paid' &&
          !['cancelled', 'returned'].includes(o.fulfillmentStatus.toLowerCase())
      );
      const lifetimeSpendPaise = qualifying.reduce((sum, o) => sum + o.totalPaise, 0);
      const deliveredOrdersCount = serialized.filter(
        (o) => o.fulfillmentStatus.toLowerCase() === 'delivered'
      ).length;
      const pointsBalance = config.rewardsEnabled
        ? Math.floor((lifetimeSpendPaise / 10_000) * Math.max(0, config.pointsPerHundredInr))
        : 0;
      const threshold = Math.max(100, config.plusQualificationSpendPaise || 1_000_000);
      const isPlusMember = config.plusEnabled && lifetimeSpendPaise >= threshold;

      return {
        ok: true,
        data: {
          config,
          pointsBalance,
          lifetimeEarnedPoints: pointsBalance,
          lifetimeSpendPaise,
          deliveredOrdersCount,
          isPlusMember,
          plusStatusLabel: !config.plusEnabled
            ? 'Program paused'
            : isPlusMember
              ? `${config.plusTierName} Active`
              : `${config.plusTierName} Eligible at ₹${(threshold / 100).toLocaleString('en-IN')}`,
          plusProgressPaise: Math.min(threshold, lifetimeSpendPaise),
        } as unknown as T,
      };
    }

    if (cleanPath === '/api/account/payment-methods') {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const colPath = `users/${encodeURIComponent(session.uid)}/payment_methods`;
      if (upperMethod === 'GET') {
        const docs = await firestoreListDocs<Record<string, unknown>>(colPath, session.idToken);
        const methods = docs
          .map((m) => ({
            id: String(m.id || ''),
            methodType: (m.method_type === 'upi' || m.method_type === 'wallet'
              ? m.method_type
              : 'card') as 'card' | 'upi' | 'wallet',
            label: String(m.label || ''),
            last4: typeof m.last4 === 'string' && m.last4 ? m.last4 : null,
            network: typeof m.network === 'string' && m.network ? m.network : null,
            expiry: typeof m.expiry === 'string' && m.expiry ? m.expiry : null,
            createdAt: Number(m.created_at || Date.now()),
            updatedAt: Number(m.updated_at || Date.now()),
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return {
          ok: true,
          data: {
            enabled: false,
            provider: 'razorpay',
            reason:
              'Full card entry stays inside PCI-compliant Razorpay Checkout. Save non-sensitive card, UPI, or wallet nicknames below for quick reference.',
            methods,
          } as unknown as T,
        };
      }
      if (upperMethod === 'POST') {
        const validated = validateNonSensitivePaymentMethodInput(body);
        if (!validated.ok) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: validated.error,
          };
        }
        const now = Date.now();
        const methodId =
          typeof body.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(body.id)
            ? body.id
            : `pm_${now.toString(36)}_${randomHex(3)}`;
        const prev = await firestoreGetDoc<Record<string, unknown>>(
          colPath,
          methodId,
          session.idToken
        ).catch(() => null);
        const row = {
          id: methodId,
          user_id: session.uid,
          method_type: validated.methodType,
          label: validated.label,
          last4: validated.last4,
          network: validated.network,
          expiry: validated.expiry,
          created_at: Number(prev?.created_at || now),
          updated_at: now,
        };
        await firestoreSetDoc(colPath, methodId, row, session.idToken);
        return {
          ok: true,
          data: {
            method: {
              id: row.id,
              methodType: row.method_type,
              label: row.label,
              last4: row.last4,
              network: row.network,
              expiry: row.expiry,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            },
          } as unknown as T,
        };
      }
    }

    if (cleanPath.startsWith('/api/account/payment-methods/')) {
      const session = await getValidClientSession();
      if (!session) {
        return {
          ok: false,
          status: 401,
          code: 'AUTH_REQUIRED',
          error: 'Authentication required.',
        };
      }
      const methodId = decodeURIComponent(
        cleanPath.slice('/api/account/payment-methods/'.length)
      );
      const colPath = `users/${encodeURIComponent(session.uid)}/payment_methods`;
      if (upperMethod === 'PUT' || upperMethod === 'PATCH') {
        const validated = validateNonSensitivePaymentMethodInput(body);
        if (!validated.ok) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: validated.error,
          };
        }
        const now = Date.now();
        const prev = await firestoreGetDoc<Record<string, unknown>>(
          colPath,
          methodId,
          session.idToken
        ).catch(() => null);
        const row = {
          id: methodId,
          user_id: session.uid,
          method_type: validated.methodType,
          label: validated.label,
          last4: validated.last4,
          network: validated.network,
          expiry: validated.expiry,
          created_at: Number(prev?.created_at || now),
          updated_at: now,
        };
        await firestoreSetDoc(colPath, methodId, row, session.idToken);
        return {
          ok: true,
          data: {
            method: {
              id: row.id,
              methodType: row.method_type,
              label: row.label,
              last4: row.last4,
              network: row.network,
              expiry: row.expiry,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            },
          } as unknown as T,
        };
      }
      if (upperMethod === 'DELETE') {
        const existing = await firestoreGetDoc<Record<string, unknown>>(
          colPath,
          methodId,
          session.idToken
        );
        if (!existing) {
          return {
            ok: false,
            status: 404,
            code: 'PAYMENT_METHOD_NOT_FOUND',
            error: 'Saved payment method was not found.',
          };
        }
        await firestoreDeleteDoc(colPath, methodId, session.idToken);
        return {
          ok: true,
          data: { ok: true, deletedId: methodId } as unknown as T,
        };
      }
    }

    if (cleanPath === '/api/coupons/validate' && upperMethod === 'POST') {
      const subtotalPaise = Math.max(0, Math.round(Number(body.subtotalPaise ?? 0) || 0));
      const couponCode =
        typeof body.couponCode === 'string'
          ? body.couponCode.trim().toUpperCase()
          : typeof body.code === 'string'
            ? body.code.trim().toUpperCase()
            : '';
      const giftCardCode =
        typeof body.giftCardCode === 'string' ? body.giftCardCode.trim().toUpperCase() : '';
      if (!couponCode && !giftCardCode) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Enter a coupon or gift card code to apply.',
        };
      }
      const session = await getValidClientSession().catch(() => null);
      const idToken = session?.idToken;
      const now = Date.now();
      let discountPaise = 0;
      let appliedCoupon: ReturnType<typeof serializeClientCouponDoc> | null = null;
      if (couponCode) {
        const cpnDoc = await firestoreGetDoc<Record<string, unknown>>(
          'coupons',
          `cpn_${couponCode.toLowerCase()}`,
          idToken
        );
        if (!cpnDoc) {
          return {
            ok: false,
            status: 404,
            code: 'COUPON_NOT_FOUND',
            error: `Coupon "${couponCode}" was not found.`,
          };
        }
        const c = serializeClientCouponDoc(cpnDoc);
        if (!c.active) {
          return { ok: false, status: 400, code: 'COUPON_INACTIVE', error: `Coupon "${couponCode}" is inactive.` };
        }
        if (c.startsAt && now < c.startsAt) {
          return { ok: false, status: 400, code: 'COUPON_NOT_STARTED', error: `Coupon "${couponCode}" is not active yet.` };
        }
        if (c.expiresAt && now > c.expiresAt) {
          return { ok: false, status: 400, code: 'COUPON_EXPIRED', error: `Coupon "${couponCode}" has expired.` };
        }
        if (c.usageLimit !== null && c.usedCount >= c.usageLimit) {
          return { ok: false, status: 400, code: 'COUPON_LIMIT_REACHED', error: `Coupon "${couponCode}" has reached its redemption limit.` };
        }
        if (subtotalPaise < c.minSpendPaise) {
          return {
            ok: false,
            status: 400,
            code: 'COUPON_MIN_SPEND',
            error: `Coupon "${couponCode}" requires a minimum order of ₹${(c.minSpendPaise / 100).toLocaleString('en-IN')}.`,
          };
        }
        discountPaise =
          c.discountType === 'percent'
            ? Math.round((subtotalPaise * c.discountValue) / 100)
            : c.discountValue;
        if (c.maxDiscountPaise !== null && c.maxDiscountPaise > 0) {
          discountPaise = Math.min(discountPaise, c.maxDiscountPaise);
        }
        discountPaise = Math.max(0, Math.min(subtotalPaise, discountPaise));
        appliedCoupon = c;
      }

      let giftCardPaise = 0;
      let appliedGiftCard: ReturnType<typeof serializeClientGiftCardDoc> | null = null;
      if (giftCardCode) {
        const gcDoc = await firestoreGetDoc<Record<string, unknown>>(
          'gift_cards',
          `gc_${giftCardCode.toLowerCase()}`,
          idToken
        );
        if (!gcDoc) {
          return { ok: false, status: 404, code: 'GIFT_CARD_NOT_FOUND', error: `Gift card "${giftCardCode}" was not found.` };
        }
        const gc = serializeClientGiftCardDoc(gcDoc);
        if (!gc.active) {
          return { ok: false, status: 400, code: 'GIFT_CARD_INACTIVE', error: `Gift card "${giftCardCode}" is inactive.` };
        }
        if (gc.expiresAt && now > gc.expiresAt) {
          return { ok: false, status: 400, code: 'GIFT_CARD_EXPIRED', error: `Gift card "${giftCardCode}" has expired.` };
        }
        if (gc.balancePaise <= 0) {
          return { ok: false, status: 400, code: 'GIFT_CARD_EMPTY', error: `Gift card "${giftCardCode}" has ₹0 remaining balance.` };
        }
        const afterDiscount = Math.max(0, subtotalPaise - discountPaise);
        giftCardPaise = Math.min(gc.balancePaise, afterDiscount);
        appliedGiftCard = gc;
      }

      const payablePaise = Math.max(0, subtotalPaise - discountPaise - giftCardPaise);
      return {
        ok: true,
        data: {
          valid: true,
          subtotalPaise,
          discountPaise,
          giftCardPaise,
          payablePaise,
          coupon: appliedCoupon,
          giftCard: appliedGiftCard,
        } as unknown as T,
      };
    }

    if (cleanPath === '/api/gift-cards/check' && upperMethod === 'POST') {
      const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (!rawCode || rawCode.length < 4) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Enter a valid Sahithi Gift Card code.',
        };
      }
      const session = await getValidClientSession().catch(() => null);
      const gcDoc = await firestoreGetDoc<Record<string, unknown>>(
        'gift_cards',
        `gc_${rawCode.toLowerCase()}`,
        session?.idToken
      );
      if (!gcDoc) {
        return {
          ok: false,
          status: 404,
          code: 'GIFT_CARD_NOT_FOUND',
          error: `Gift card "${rawCode}" was not found.`,
        };
      }
      const gc = serializeClientGiftCardDoc(gcDoc);
      if (!gc.active) {
        return {
          ok: false,
          status: 400,
          code: 'GIFT_CARD_INACTIVE',
          error: `Gift card "${rawCode}" is inactive.`,
        };
      }
      if (gc.expiresAt && Date.now() > gc.expiresAt) {
        return {
          ok: false,
          status: 400,
          code: 'GIFT_CARD_EXPIRED',
          error: `Gift card "${rawCode}" has expired.`,
        };
      }
      return { ok: true, data: { giftCard: gc } as unknown as T };
    }

    // 13. Public Storefront & Catalog Endpoints
    if (cleanPath === '/api/storefront' && upperMethod === 'GET') {
      const [siteSettingsDoc, legacySettingsDoc, siteContentDoc, legacyContentDoc, categoriesDocs] =
        await Promise.all([
          firestoreGetDoc<{ value?: unknown; data?: unknown }>('site_documents', 'settings'),
          firestoreGetDoc<{ data?: unknown }>('settings', 'site_settings'),
          firestoreGetDoc<{ value?: unknown; data?: unknown }>('site_documents', 'content'),
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

      const settings = mergeSiteSettings(
        (siteSettingsDoc?.value ??
          siteSettingsDoc?.data ??
          legacySettingsDoc?.data ??
          DEFAULT_SITE_SETTINGS) as Partial<typeof DEFAULT_SITE_SETTINGS>
      );
      const content = mergeStorefrontContent(
        (siteContentDoc?.value ??
          siteContentDoc?.data ??
          legacyContentDoc?.data ??
          DEFAULT_STOREFRONT_CONTENT) as Partial<typeof DEFAULT_STOREFRONT_CONTENT>
      );
      const mappedRemoteCats = [...categoriesDocs]
        .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
        .map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          subtitle: c.subtitle || '',
          imageUrl: c.image_url || '',
          altText: c.alt_text || c.name,
          position: Number(c.position || 0),
        }));
      const seenCatIds = new Set(mappedRemoteCats.map((c) => c.id));
      const seenCatNames = new Set(mappedRemoteCats.map((c) => c.name.toLowerCase()));
      for (const seedCat of INITIAL_SEED_CATEGORIES) {
        if (!seenCatIds.has(seedCat.id) && !seenCatNames.has(seedCat.name.toLowerCase())) {
          mappedRemoteCats.push({
            id: seedCat.id,
            name: seedCat.name,
            slug: seedCat.slug,
            subtitle: seedCat.subtitle,
            imageUrl: seedCat.imageUrl,
            altText: seedCat.altText,
            position: seedCat.position,
          });
        }
      }
      const categories = mappedRemoteCats.sort((a, b) => a.position - b.position);

      return {
        ok: true,
        data: { settings, content, categories } as unknown as T,
      };
    }

    if (cleanPath === '/api/products' && upperMethod === 'GET') {
      const docs = await getMergedProductDocs();
      const activeItems = docs
        .filter((d) => d.status === 'active' || d.status === 'published')
        .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
        .map((d) => formatProductDto(d, false));
      return {
        ok: true,
        data: { items: activeItems } as unknown as T,
      };
    }

    if (cleanPath.startsWith('/api/products/') && upperMethod === 'GET') {
      const idOrSlug = decodeURIComponent(cleanPath.slice('/api/products/'.length));
      const docs = await getMergedProductDocs();
      const match = docs.find(
        (d) =>
          (d.status === 'active' || d.status === 'published') &&
          (d.id === idOrSlug || d.slug === idOrSlug)
      );
      if (!match) {
        return {
          ok: false,
          status: 404,
          code: 'PRODUCT_NOT_FOUND',
          error: 'Product not found.',
        };
      }
      return {
        ok: true,
        data: { product: formatProductDto(match, false) } as unknown as T,
      };
    }

    if (cleanPath === '/api/cart/validate' && upperMethod === 'POST') {
      const rawItems = Array.isArray(body.items) ? body.items : [];
      const docs = await getMergedProductDocs();
      const productMap = new Map(
        docs
          .filter((d) => d.status === 'active' || d.status === 'published')
          .map((d) => [d.id, d])
      );

      let subtotalPaise = 0;
      let hasUnavailable = false;
      let hasPriceChanges = false;

      const validatedItems = rawItems.map((raw: Record<string, unknown>) => {
        const productId = String(raw.productId || '');
        const variantId = raw.variantId ? String(raw.variantId) : null;
        const quantity = Math.max(1, Math.min(20, Math.round(Number(raw.quantity || 1))));
        const seenPricePaise = Math.round(Number(raw.seenPricePaise || 0));

        const doc = productMap.get(productId);
        if (!doc) {
          hasUnavailable = true;
          return {
            productId,
            variantId,
            requestedQty: quantity,
            availableQty: 0,
            quantity,
            available: false,
            statusReason: 'This item is no longer available.',
            reason: 'This item is no longer available.',
            title: String(raw.fallbackTitle || 'Unavailable Item'),
            productTitle: String(raw.fallbackTitle || 'Unavailable Item'),
            variantLabel: String(raw.fallbackVariant || ''),
            sku: '',
            imageUrl: String(raw.fallbackImage || ''),
            currentPricePaise: null,
            previousPricePaise: seenPricePaise,
            priceChanged: false,
            availableStock: 0,
            lineTotalPaise: 0,
          };
        }

        const variants = Array.isArray(doc.variants) ? doc.variants : [];
        const activeVariants = variants.filter(
          (v) => v.active !== false && v.active !== 0 && isVariantColorActiveInMetadata(doc.colors_json, v)
        );
        const variant =
          (variantId ? variants.find((v) => v.id === variantId) : activeVariants[0] || variants[0]) ||
          null;
        const variantMissingOrInactive =
          (Boolean(variantId) && variants.length > 0 && !variant) ||
          Boolean(
            variant &&
              (variant.active === false ||
                variant.active === 0 ||
                !isVariantColorActiveInMetadata(doc.colors_json, variant))
          );
        const unitPricePaise = variant ? Number(variant.price_paise) : Number(doc.price_paise);
        const availableStock = variantMissingOrInactive
          ? 0
          : variant
            ? Number(variant.stock_qty)
            : Number(doc.stock_qty);
        const available = !variantMissingOrInactive && availableStock >= quantity && availableStock > 0;
        if (!available) hasUnavailable = true;

        const priceChanged = !variantMissingOrInactive && seenPricePaise > 0 && seenPricePaise !== unitPricePaise;
        if (priceChanged) hasPriceChanges = true;

        const lineTotalPaise = available ? unitPricePaise * quantity : 0;
        subtotalPaise += lineTotalPaise;
        const statusReason = variantMissingOrInactive
          ? 'This colour or size option is no longer available.'
          : !available
            ? availableStock <= 0
              ? 'Currently out of stock.'
              : `Only ${availableStock} left in stock.`
            : null;
        const resolvedImage =
          resolveVariantSnapshotImageUrl(doc.colors_json, doc.images, variant) ||
          doc.images?.[0]?.url ||
          '';

        return {
          productId: doc.id,
          variantId: variant?.id || doc.id,
          requestedQty: quantity,
          availableQty: availableStock,
          quantity,
          available,
          statusReason,
          reason: statusReason,
          title: doc.title,
          productTitle: doc.title,
          variantLabel: variant
            ? formatVariantDisplayLabel(variant.color_name, variant.size)
            : 'Standard',
          colorName: variant?.color_name || undefined,
          size: variant?.size || undefined,
          sku: variant?.sku || doc.sku,
          imageUrl: resolvedImage,
          currentPricePaise: unitPricePaise,
          previousPricePaise: seenPricePaise || unitPricePaise,
          priceChanged,
          availableStock,
          lineTotalPaise,
        };
      });

      return {
        ok: true,
        data: {
          items: validatedItems,
          subtotalPaise,
          hasUnavailable,
          hasPriceChanges,
        } as unknown as T,
      };
    }

    if (cleanPath === '/api/orders' && upperMethod === 'POST') {
      const rawCustomer =
        body.customer && typeof body.customer === 'object'
          ? (body.customer as Record<string, unknown>)
          : body;
      const customerName =
        typeof rawCustomer.customerName === 'string' ? rawCustomer.customerName.trim() : '';
      const customerEmail =
        typeof rawCustomer.customerEmail === 'string'
          ? rawCustomer.customerEmail.trim().toLowerCase()
          : '';
      const customerPhone =
        typeof rawCustomer.customerPhone === 'string' ? rawCustomer.customerPhone.trim() : '';
      const shippingAddress =
        typeof rawCustomer.shippingAddress === 'string' ? rawCustomer.shippingAddress.trim() : '';
      const rawItems = Array.isArray(body.items) ? body.items : [];

      if (
        customerName.length < 2 ||
        !EMAIL_REGEX.test(customerEmail) ||
        customerPhone.length < 7 ||
        shippingAddress.length < 8 ||
        rawItems.length === 0
      ) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Please complete your name, email, phone number, and delivery address.',
        };
      }

      const activeSession = await getValidClientSession().catch(() => null);
      const rawIdempotency =
        typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim().slice(0, 128) : '';
      const cleanIdempotencyKey =
        rawIdempotency && /^[a-zA-Z0-9_.:-]{6,128}$/.test(rawIdempotency)
          ? rawIdempotency
          : null;

      let deterministicHash = 0;
      if (cleanIdempotencyKey) {
        for (let i = 0; i < cleanIdempotencyKey.length; i += 1) {
          deterministicHash = ((deterministicHash << 5) - deterministicHash + cleanIdempotencyKey.charCodeAt(i)) >>> 0;
        }
      }
      const now = Date.now();
      const orderId = cleanIdempotencyKey
        ? `ord_cod_${cleanIdempotencyKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 14)}_${deterministicHash.toString(36)}`
        : `ord_cod_${now.toString(36)}_${randomHex(4)}`;

      if (cleanIdempotencyKey) {
        const existingOrderDoc = await firestoreGetDoc<Record<string, unknown>>(
          'orders',
          orderId,
          activeSession?.idToken
        ).catch(() => null);
        if (existingOrderDoc) {
          return {
            ok: true,
            data: {
              order: serializeClientOrderDoc(existingOrderDoc),
              duplicate: true,
            } as unknown as T,
          };
        }
      }

      const orderNumber = cleanIdempotencyKey
        ? `SC-COD-${deterministicHash.toString(36).toUpperCase().padStart(6, '0').slice(-6)}`
        : `SC-${now.toString(36).toUpperCase().slice(-5)}${randomHex(2).toUpperCase()}`;

      const docs = await getMergedProductDocs(activeSession?.idToken);
      const productMap = new Map(
        docs
          .filter((d) => d.status === 'active' || d.status === 'published')
          .map((d) => [d.id, d])
      );

      let subtotalPaise = 0;
      const productIds = new Set<string>();
      const orderItems: Array<{
        id: string;
        order_id: string;
        product_id: string;
        variant_id: string;
        product_title: string;
        variant_label: string;
        color_name: string;
        size: string;
        image_url: string;
        sku: string;
        unit_price_paise: number;
        quantity: number;
        line_total_paise: number;
      }> = [];

      for (const raw of rawItems as Array<Record<string, unknown>>) {
        const productId = String(raw.productId || '');
        const variantId = raw.variantId ? String(raw.variantId) : '';
        const quantity = Math.max(1, Math.min(20, Math.round(Number(raw.quantity || 1))));
        const expectedPricePaise =
          raw.expectedPricePaise !== undefined && raw.expectedPricePaise !== null
            ? Math.round(Number(raw.expectedPricePaise))
            : null;

        const doc = productMap.get(productId);
        if (!doc) {
          return {
            ok: false,
            status: 409,
            code: 'PRODUCT_UNAVAILABLE',
            error: 'One of the items in your bag is no longer available.',
          };
        }

        const variants = Array.isArray(doc.variants) ? doc.variants : [];
        const activeVariants = variants.filter(
          (v) => v.active !== false && v.active !== 0 && isVariantColorActiveInMetadata(doc.colors_json, v)
        );
        const variant =
          (variantId ? variants.find((v) => v.id === variantId) : activeVariants[0] || variants[0]) ||
          null;
        if (
          (variantId && variants.length > 0 && !variant) ||
          (variant &&
            (variant.active === false ||
              variant.active === 0 ||
              !isVariantColorActiveInMetadata(doc.colors_json, variant)))
        ) {
          return {
            ok: false,
            status: 409,
            code: 'VARIANT_UNAVAILABLE',
            error: `Selected colour or size for "${doc.title}" is no longer available.`,
          };
        }
        const unitPricePaise = variant ? Number(variant.price_paise) : Number(doc.price_paise);
        const availableStock = variant ? Number(variant.stock_qty) : Number(doc.stock_qty);

        if (expectedPricePaise !== null && expectedPricePaise !== unitPricePaise) {
          return {
            ok: false,
            status: 409,
            code: 'PRICE_CHANGED',
            error: `The price for "${doc.title}" has been updated. Please review your bag.`,
          };
        }

        if (availableStock < quantity || availableStock <= 0) {
          return {
            ok: false,
            status: 409,
            code: 'INSUFFICIENT_STOCK',
            error:
              availableStock <= 0
                ? `"${doc.title}" is currently out of stock.`
                : `Only ${availableStock} piece(s) left for "${doc.title}".`,
          };
        }

        const lineTotalPaise = unitPricePaise * quantity;
        subtotalPaise += lineTotalPaise;
        productIds.add(doc.id);
        const resolvedImg =
          resolveVariantSnapshotImageUrl(doc.colors_json, doc.images, variant) ||
          doc.images?.[0]?.url ||
          '';
        orderItems.push({
          id: `item_${orderId}_${orderItems.length + 1}`,
          order_id: orderId,
          product_id: doc.id,
          variant_id: variant?.id || doc.id,
          product_title: doc.title,
          variant_label: variant
            ? formatVariantDisplayLabel(variant.color_name, variant.size)
            : 'Standard',
          color_name: variant?.color_name || '',
          size: variant?.size || '',
          image_url: resolvedImg,
          sku: variant?.sku || doc.sku,
          unit_price_paise: unitPricePaise,
          quantity,
          line_total_paise: lineTotalPaise,
        });
      }

      let discountPaise = 0;
      let appliedCouponCode: string | null = null;
      const rawCouponCode =
        typeof body.couponCode === 'string' ? body.couponCode.trim().toUpperCase() : '';
      if (rawCouponCode) {
        const cpnDoc = await firestoreGetDoc<Record<string, unknown>>(
          'coupons',
          `cpn_${rawCouponCode.toLowerCase()}`,
          activeSession?.idToken
        );
        if (!cpnDoc) {
          return {
            ok: false,
            status: 400,
            code: 'INVALID_COUPON',
            error: `Coupon "${rawCouponCode}" was not found.`,
          };
        }
        const c = serializeClientCouponDoc(cpnDoc);
        if (!c.active || (c.startsAt && now < c.startsAt) || (c.expiresAt && now > c.expiresAt)) {
          return {
            ok: false,
            status: 400,
            code: 'INVALID_COUPON',
            error: `Coupon "${rawCouponCode}" is inactive or expired.`,
          };
        }
        if (c.usageLimit !== null && c.usedCount >= c.usageLimit) {
          return {
            ok: false,
            status: 400,
            code: 'COUPON_EXHAUSTED',
            error: `Coupon "${rawCouponCode}" has reached its redemption limit.`,
          };
        }
        if (subtotalPaise < c.minSpendPaise) {
          return {
            ok: false,
            status: 400,
            code: 'COUPON_MIN_SPEND',
            error: `Coupon "${rawCouponCode}" requires a minimum order of ₹${(c.minSpendPaise / 100).toLocaleString('en-IN')}.`,
          };
        }
        discountPaise =
          c.discountType === 'percent'
            ? Math.round((subtotalPaise * c.discountValue) / 100)
            : c.discountValue;
        if (c.maxDiscountPaise !== null && c.maxDiscountPaise > 0) {
          discountPaise = Math.min(discountPaise, c.maxDiscountPaise);
        }
        discountPaise = Math.max(0, Math.min(subtotalPaise, discountPaise));
        appliedCouponCode = c.code;
      }

      let giftCardPaise = 0;
      let appliedGiftCardCode: string | null = null;
      const rawGiftCardCode =
        typeof body.giftCardCode === 'string' ? body.giftCardCode.trim().toUpperCase() : '';
      if (rawGiftCardCode) {
        const gcDoc = await firestoreGetDoc<Record<string, unknown>>(
          'gift_cards',
          `gc_${rawGiftCardCode.toLowerCase()}`,
          activeSession?.idToken
        );
        if (!gcDoc) {
          return {
            ok: false,
            status: 400,
            code: 'INVALID_GIFT_CARD',
            error: `Gift card "${rawGiftCardCode}" was not found.`,
          };
        }
        const gc = serializeClientGiftCardDoc(gcDoc);
        if (!gc.active || (gc.expiresAt && now > gc.expiresAt) || gc.balancePaise <= 0) {
          return {
            ok: false,
            status: 400,
            code: 'INVALID_GIFT_CARD',
            error: `Gift card "${rawGiftCardCode}" cannot be redeemed.`,
          };
        }
        giftCardPaise = Math.min(gc.balancePaise, Math.max(0, subtotalPaise - discountPaise));
        appliedGiftCardCode = gc.code;
      }

      const finalTotalPaise = Math.max(0, subtotalPaise - discountPaise - giftCardPaise);
      const initialHistory: OrderStatusHistoryEntry[] = [
        {
          status: 'placed',
          note: 'Cash on Delivery order placed · Payment due on delivery',
          actor: activeSession ? 'customer' : 'system',
          at: now,
        },
      ];

      const orderDocPayload: Record<string, unknown> = {
        id: orderId,
        order_number: orderNumber,
        customer_user_id: activeSession ? activeSession.uid : null,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        shipping_address: shippingAddress,
        status: 'placed',
        payment_status: 'unpaid',
        fulfillment_status: 'placed',
        payment_method: 'cod',
        discount_paise: discountPaise,
        gift_card_paise: giftCardPaise,
        coupon_code: appliedCouponCode,
        gift_card_code: appliedGiftCardCode,
        idempotency_key: cleanIdempotencyKey,
        status_history: initialHistory,
        status_history_json: JSON.stringify(initialHistory),
        subtotal_paise: subtotalPaise,
        total_paise: finalTotalPaise,
        currency: 'INR',
        created_at: now,
        updated_at: now,
        product_ids: Array.from(productIds),
        items: orderItems,
      };

      await firestoreSetDoc('orders', orderId, orderDocPayload, activeSession?.idToken);

      if (activeSession?.uid) {
        await firestoreSetDoc(
          `users/${encodeURIComponent(activeSession.uid)}/notifications`,
          `notif_ord_${orderId}`,
          {
            id: `notif_ord_${orderId}`,
            user_id: activeSession.uid,
            type: 'order_placed',
            title: `Order ${orderNumber} placed`,
            message: `Cash on Delivery order ${orderNumber} placed. ₹${(finalTotalPaise / 100).toLocaleString('en-IN')} is due on delivery.`,
            order_id: orderId,
            order_number: orderNumber,
            is_read: 0,
            read: false,
            read_at: null,
            created_at: now,
          },
          activeSession.idToken
        ).catch(() => undefined);
      }

      return {
        ok: true,
        data: {
          order: serializeClientOrderDoc(orderDocPayload),
          duplicate: false,
        } as unknown as T,
      };
    }

    // 14. Public Contact Enquiry
    if (cleanPath === '/api/contact' && upperMethod === 'POST') {
      const fullName =
        typeof body.fullName === 'string'
          ? body.fullName.trim()
          : typeof body.senderName === 'string'
            ? body.senderName.trim()
            : '';
      const phone =
        typeof body.phone === 'string'
          ? body.phone.trim()
          : typeof body.senderPhone === 'string'
            ? body.senderPhone.trim()
            : '';
      const email =
        typeof body.email === 'string'
          ? body.email.trim().toLowerCase()
          : typeof body.senderEmail === 'string'
            ? body.senderEmail.trim().toLowerCase()
            : 'guest@sahithidesigns.online';
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const productInterest =
        typeof body.productInterest === 'string' && body.productInterest.trim()
          ? body.productInterest.trim()
          : typeof body.subject === 'string' && body.subject.trim()
            ? body.subject.trim()
            : 'Boutique Enquiry';

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
        sender_name: fullName.slice(0, 120),
        sender_email: (email || 'guest@sahithidesigns.online').slice(0, 254),
        sender_phone: phone.slice(0, 32),
        subject: productInterest.slice(0, 140),
        message: message.slice(0, 3000),
        status: 'unread',
        admin_note: '',
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

    // 15. Protected Admin Dashboard Operations (Overview, Products, Categories, Content, Settings, Messages, Orders, Audit, Uploads)
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

      if (cleanPath === '/api/admin/uploads' && upperMethod === 'POST') {
        const filesOut: Array<{
          id: string;
          url: string;
          originalName: string;
          mimeType: string;
          sizeBytes: number;
        }> = [];
        if (typeof FormData !== 'undefined' && rawBody instanceof FormData) {
          const entries = rawBody.getAll('files');
          const singleFile = rawBody.get('file');
          const allItems = entries.length > 0 ? entries : singleFile ? [singleFile] : [];
          for (const entry of allItems) {
            if (typeof Blob !== 'undefined' && entry instanceof Blob) {
              const fileObj = entry as File;
              const buf = await fileObj.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let binary = '';
              for (let i = 0; i < bytes.length; i += 1) {
                binary += String.fromCharCode(bytes[i]);
              }
              const base64 =
                typeof btoa === 'function'
                  ? btoa(binary)
                  : Buffer.from(bytes).toString('base64');
              const originalMime = fileObj.type || 'image/jpeg';
              // Inline images live inside Firestore docs (1 MiB cap), so shrink them first.
              const dataUrl = await compressUploadDataUrl(
                `data:${originalMime};base64,${base64}`
              );
              const mime = dataUrl.slice(5, dataUrl.indexOf(';')) || originalMime;
              filesOut.push({
                id: `media_${Date.now().toString(36)}_${randomHex(3)}`,
                url: dataUrl,
                originalName: fileObj.name || 'upload.jpg',
                mimeType: mime,
                sizeBytes: fileObj.size || bytes.length,
              });
            }
          }
        }
        return {
          ok: true,
          data: {
            uploaded: true,
            files: filesOut,
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/overview' && upperMethod === 'GET') {
        const [products, categories, messages, orders, auditLogs, usersDocs] = await Promise.all([
          getMergedProductDocs(idToken),
          firestoreListDocs<{ id: string }>('categories', idToken),
          firestoreListDocs<{ status?: string; created_at?: number }>(
            'contact_messages',
            idToken
          ),
          firestoreListDocs<Record<string, unknown>>('orders', idToken),
          firestoreListDocs<{
            id: string;
            product_id?: string | null;
            product_title?: string;
            actor_user_id?: string;
            actor_email?: string;
            action: string;
            entity_type?: string;
            entity_id?: string | null;
            summary: string;
            created_at: number;
          }>('product_audit_logs', idToken),
          firestoreListDocs<{ id: string; email_verified?: boolean }>('users', idToken).catch(() => []),
        ]);

        await reconcilePendingRazorpayOrdersAsOwner(orders, idToken).catch(() => {});
        const orderCounts = computeProductOrderCounts(orders as unknown as ClientOrderDoc[]);
        const serializedOrders = orders.map((o) => serializeClientOrderDoc(o));
        const activeCount = products.filter(
          (p) => p.status === 'active' || p.status === 'published'
        ).length;
        const draftCount = products.filter((p) => p.status === 'draft').length;
        const archivedCount = products.filter((p) => p.status === 'archived').length;
        const lowStockCount = products.filter(
          (p) =>
            (p.status === 'active' || p.status === 'published') &&
            Number(p.stock_qty) > 0 &&
            Number(p.stock_qty) <= Number(p.low_stock_threshold ?? 5)
        ).length;
        const outOfStockCount = products.filter(
          (p) => (p.status === 'active' || p.status === 'published') && Number(p.stock_qty) <= 0
        ).length;

        const paidOrders = serializedOrders.filter(
          (o) =>
            !['cancelled', 'returned'].includes(o.status) &&
            o.paymentStatus === 'paid'
        );
        const totalRevenuePaise = paidOrders.reduce(
          (sum, o) => sum + Number(o.totalPaise || 0),
          0
        );
        const pendingOrders = serializedOrders.filter((o) =>
          isOrderAwaitingDispatch(o.status)
        ).length;
        const cancelledOrders = serializedOrders.filter(
          (o) => o.status === 'cancelled'
        ).length;
        const openReturnRequests = serializedOrders.filter(
          (o) =>
            o.returnRequest?.status === 'pending' ||
            (o.status !== 'cancelled' && o.cancelRequest?.status === 'pending')
        ).length;

        return {
          ok: true,
          data: normalizeAdminOverview({
            metrics: {
              totalProducts: products.filter((p) => p.status !== 'archived').length,
              activeProducts: activeCount,
              publishedProducts: activeCount,
              draftProducts: draftCount,
              archivedProducts: archivedCount,
              lowStockProducts: lowStockCount,
              lowStockCount,
              outOfStockProducts: outOfStockCount,
              outOfStockCount,
              totalCategories: categories.length || INITIAL_SEED_CATEGORIES.length,
              totalOrders: serializedOrders.length,
              pendingOrders,
              cancelledOrders,
              totalRevenuePaise,
              totalRevenue: Number((totalRevenuePaise / 100).toFixed(2)),
              unreadMessages: messages.filter(
                (m) => m.status === 'new' || m.status === 'unread'
              ).length,
              totalMessages: messages.length,
              totalAuditEvents: auditLogs.length,
              totalCustomers: usersDocs.length,
              openReturnRequests,
            },
            lowStockItems: products
              .filter(
                (p) =>
                  (p.status === 'active' || p.status === 'published') &&
                  Number(p.stock_qty) <= Number(p.low_stock_threshold ?? 5)
              )
              .slice(0, 8)
              .map((p) => formatProductDto(p, true, orderCounts.get(p.id) || 0)),
            recentOrders: [...serializedOrders]
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, 8),
            recentMessages: [...messages]
              .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
              .slice(0, 8),
            recentAuditLogs: [...auditLogs]
              .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
              .slice(0, 12)
              .map((log) => ({
                id: log.id,
                actorEmail: log.actor_email || AUTHORIZED_OWNER_EMAIL,
                action: log.action,
                entityType: log.entity_type || 'product',
                entityId: log.entity_id ?? log.product_id ?? null,
                productTitle: log.product_title || '',
                summary: log.summary,
                createdAt: Number(log.created_at || Date.now()),
              })),
          }) as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/products' && upperMethod === 'GET') {
        const [docs, orders] = await Promise.all([
          getMergedProductDocs(idToken),
          firestoreListDocs<ClientOrderDoc>('orders', idToken),
        ]);
        const orderCounts = computeProductOrderCounts(orders);
        const queryString = rawPath.includes('?') ? rawPath.slice(rawPath.indexOf('?') + 1) : '';
        const params = new URLSearchParams(queryString);
        const statusFilter = params.get('status') || 'all';
        const categoryFilter = params.get('category') || 'All';
        const stockFilter = params.get('stock') || 'all';
        const sortFilter = params.get('sort') || 'updated';
        const qTerm = (params.get('q') || '').trim().toLowerCase();
        const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
        const pageSize = Math.max(
          1,
          Math.min(100, Number.parseInt(params.get('pageSize') || '15', 10) || 15)
        );

        let filtered = docs.map((d) => ({
          ...d,
          status: (d.status === 'active' ? 'published' : d.status) as StoredProductDoc['status'],
        }));
        if (statusFilter !== 'all') {
          filtered = filtered.filter((p) => p.status === statusFilter);
        } else {
          filtered = filtered.filter((p) => p.status !== 'archived');
        }
        if (categoryFilter && categoryFilter !== 'All') {
          filtered = filtered.filter((p) => p.category === categoryFilter);
        }
        if (stockFilter === 'low') {
          filtered = filtered.filter(
            (p) =>
              p.status !== 'archived' &&
              Number(p.stock_qty) <= Number(p.low_stock_threshold ?? 5)
          );
        } else if (stockFilter === 'out') {
          filtered = filtered.filter((p) => p.status !== 'archived' && Number(p.stock_qty) === 0);
        }
        if (qTerm) {
          filtered = filtered.filter(
            (p) =>
              p.title.toLowerCase().includes(qTerm) ||
              p.sku.toLowerCase().includes(qTerm) ||
              p.category.toLowerCase().includes(qTerm)
          );
        }

        filtered.sort((a, b) => {
          switch (sortFilter) {
            case 'price_asc':
              return Number(a.price_paise) - Number(b.price_paise);
            case 'price_desc':
              return Number(b.price_paise) - Number(a.price_paise);
            case 'stock_asc':
              return Number(a.stock_qty) - Number(b.stock_qty);
            case 'newest':
              return Number(b.created_at || 0) - Number(a.created_at || 0);
            case 'updated':
            default:
              return Number(b.updated_at || 0) - Number(a.updated_at || 0);
          }
        });

        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const offset = (page - 1) * pageSize;

        return {
          ok: true,
          data: {
            items: filtered
              .slice(offset, offset + pageSize)
              .map((d) => formatProductDto(d, true, orderCounts.get(d.id) || 0)),
            total,
            page,
            pageSize,
            totalPages,
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/content') {
        if (upperMethod === 'GET') {
          const [siteDoc, legacyDoc] = await Promise.all([
            firestoreGetDoc<{ value?: unknown; data?: unknown; updated_at?: number }>(
              'site_documents',
              'content',
              idToken
            ),
            firestoreGetDoc<{ data?: unknown; updated_at?: number }>(
              'settings',
              'storefront_content',
              idToken
            ),
          ]);
          return {
            ok: true,
            data: {
              content: mergeStorefrontContent(
                (siteDoc?.value ??
                  siteDoc?.data ??
                  legacyDoc?.data ??
                  DEFAULT_STOREFRONT_CONTENT) as Partial<typeof DEFAULT_STOREFRONT_CONTENT>
              ),
              updatedAt: Number(siteDoc?.updated_at || legacyDoc?.updated_at || Date.now()),
            } as unknown as T,
          };
        }
        if (upperMethod === 'PUT' || upperMethod === 'POST' || upperMethod === 'PATCH') {
          const now = Date.now();
          let merged = mergeStorefrontContent(body.content ?? body);
          try {
            merged = await fitInlineImagesToBudget(merged);
          } catch (err) {
            if (err instanceof DocumentTooLargeError) {
              return { ok: false, status: 400, code: 'CONTENT_TOO_LARGE', error: err.message };
            }
            throw err;
          }
          await firestoreSetDoc(
            'site_documents',
            'content',
            {
              key: 'content',
              value: merged,
              updated_at: now,
            },
            idToken
          );
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
          const [siteDoc, legacyDoc] = await Promise.all([
            firestoreGetDoc<{ value?: unknown; data?: unknown; updated_at?: number }>(
              'site_documents',
              'settings',
              idToken
            ),
            firestoreGetDoc<{ data?: unknown; updated_at?: number }>(
              'settings',
              'site_settings',
              idToken
            ),
          ]);
          return {
            ok: true,
            data: {
              settings: mergeSiteSettings(
                (siteDoc?.value ??
                  siteDoc?.data ??
                  legacyDoc?.data ??
                  DEFAULT_SITE_SETTINGS) as Partial<typeof DEFAULT_SITE_SETTINGS>
              ),
              updatedAt: Number(siteDoc?.updated_at || legacyDoc?.updated_at || Date.now()),
            } as unknown as T,
          };
        }
        if (upperMethod === 'PUT' || upperMethod === 'POST' || upperMethod === 'PATCH') {
          let merged = mergeSiteSettings(body.settings ?? body);
          try {
            merged = await fitInlineImagesToBudget(merged, 600_000);
          } catch (err) {
            if (err instanceof DocumentTooLargeError) {
              return { ok: false, status: 400, code: 'SETTINGS_TOO_LARGE', error: err.message };
            }
            throw err;
          }
          const now = Date.now();
          const meta = await getClientCatalogVisibilityMeta(idToken);
          await firestoreSetDoc(
            'site_documents',
            'settings',
            {
              key: 'settings',
              value: merged,
              hidden_product_ids: Array.from(meta.hiddenIds),
              hidden_product_slugs: Array.from(meta.hiddenSlugs),
              deleted_product_ids: Array.from(meta.deletedIds),
              updated_at: now,
            },
            idToken
          );
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
          sender_name?: string;
          full_name?: string;
          sender_phone?: string;
          phone?: string;
          sender_email?: string | null;
          email?: string | null;
          subject?: string | null;
          product_interest?: string | null;
          message: string;
          status: string;
          admin_note?: string;
          admin_notes?: string;
          created_at: number;
          updated_at: number;
        }>('contact_messages', idToken);
        const items = docs
          .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
          .map((m) => ({
            id: m.id,
            senderName: m.sender_name || m.full_name || 'Guest',
            fullName: m.sender_name || m.full_name || 'Guest',
            senderPhone: m.sender_phone || m.phone || '',
            phone: m.sender_phone || m.phone || '',
            senderEmail: m.sender_email || m.email || '',
            email: m.sender_email || m.email || null,
            subject: m.subject || m.product_interest || 'Boutique Enquiry',
            productInterest: m.product_interest || m.subject || null,
            message: m.message || '',
            status: m.status === 'new' ? 'unread' : m.status || 'unread',
            adminNote: m.admin_note ?? m.admin_notes ?? '',
            adminNotes: m.admin_note ?? m.admin_notes ?? '',
            createdAt: Number(m.created_at || Date.now()),
            updatedAt: Number(m.updated_at || Date.now()),
          }));
        return {
          ok: true,
          data: {
            items,
            total: items.length,
            page: 1,
            pageSize: 50,
            totalPages: 1,
            unreadCount: items.filter((m) => m.status === 'unread').length,
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/orders' && upperMethod === 'GET') {
        const docs = await firestoreListDocs<Record<string, unknown>>('orders', idToken);
        await reconcilePendingRazorpayOrdersAsOwner(docs, idToken).catch(() => {});
        const allItems = docs
          .map((o) => serializeClientOrderDoc(o))
          .sort((a, b) => b.createdAt - a.createdAt);
        const statusCounts: Record<string, number> = {
          all: allItems.length,
          pending: 0,
          placed: 0,
          confirmed: 0,
          packed: 0,
          shipped: 0,
          delivered: 0,
          cancelled: 0,
          returned: 0,
          unknown: 0,
        };
        for (const item of allItems) {
          if (item.status in statusCounts) {
            statusCounts[item.status] += 1;
          } else {
            statusCounts.unknown += 1;
          }
          if (item.status !== 'pending' && isOrderAwaitingDispatch(item.status)) {
            statusCounts.pending += 1;
          }
        }
        const rawStatusFilter = (queryParams.get('status') || 'all').trim().toLowerCase();
        const statusFilter =
          rawStatusFilter && rawStatusFilter !== 'all'
            ? normalizeRawOrderStatusValue(rawStatusFilter)
            : 'all';
        const filteredItems =
          statusFilter === 'all'
            ? allItems
            : statusFilter === 'pending'
              ? allItems.filter((o) => isOrderAwaitingDispatch(o.status))
              : allItems.filter((o) => o.status === statusFilter);
        return {
          ok: true,
          data: {
            items: filteredItems,
            total: filteredItems.length,
            page: 1,
            pageSize: Math.max(50, filteredItems.length),
            totalPages: 1,
            statusCounts,
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/audit' && upperMethod === 'GET') {
        const docs = await firestoreListDocs<{
          id: string;
          product_id?: string | null;
          product_title?: string;
          actor_email?: string;
          action: string;
          entity_type?: string;
          entity_id?: string | null;
          summary: string;
          created_at: number;
        }>('product_audit_logs', idToken);
        const items = docs
          .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
          .slice(0, 100)
          .map((log) => ({
            id: log.id,
            actorEmail: log.actor_email || AUTHORIZED_OWNER_EMAIL,
            action: log.action,
            entityType: log.entity_type || 'product',
            entityId: log.entity_id ?? log.product_id ?? null,
            productId: log.product_id ?? log.entity_id ?? null,
            productTitle: log.product_title || 'Catalog Item',
            summary: log.summary,
            createdAt: Number(log.created_at || Date.now()),
          }));
        return {
          ok: true,
          data: {
            items,
            total: items.length,
            page: 1,
            pageSize: 50,
            totalPages: 1,
          } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/products' && upperMethod === 'POST') {
        const now = Date.now();
        const id = `prod_${now.toString(36)}_${randomHex(3)}`;
        const allDocs = await getMergedProductDocs(idToken);
        const validated = validateClientProductPayload({
          body,
          allDocs,
          productId: id,
        });
        if (!validated.ok) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: validated.error,
            fieldErrors: validated.fieldErrors,
          };
        }

        const d = validated.data;
        const existingSlugs = new Set(allDocs.map((item) => item.slug.toLowerCase()));
        const baseSlug =
          (typeof body.slug === 'string' && body.slug.trim()) ||
          d.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') ||
          id;
        let slug = baseSlug;
        if (existingSlugs.has(slug.toLowerCase())) {
          slug = `${baseSlug}-${id.slice(-4)}`.slice(0, 140);
        }

        const totalStock = d.variants.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);
        const rawDoc: StoredProductDoc = {
          id,
          sku: d.sku,
          slug,
          title: d.title,
          description: d.description,
          fabric_note: d.fabricNote,
          included_pieces: d.includedPieces,
          care_note: d.careNote,
          category: d.category,
          status: d.status,
          featured: d.featured,
          price_paise: d.pricePaise,
          compare_at_paise: d.compareAtPaise,
          stock_qty: totalStock,
          low_stock_threshold: d.lowStockThreshold,
          colors_json: JSON.stringify(d.colors),
          sizes_json: JSON.stringify(d.sizes),
          version: 1,
          published_at: d.status === 'published' ? now : null,
          archived_at: d.status === 'archived' ? now : null,
          created_at: now,
          updated_at: now,
          images: d.images,
          variants: d.variants,
          variant_skus: d.variants.map((v) => v.sku),
          image_urls: d.images.map((i) => i.url),
        };
        const doc = sanitizeProductDocForFirestore(rawDoc, id);
        assertProductDocWithinFirestoreSizeLimit(doc);

        const meta = await getClientCatalogVisibilityMeta(idToken);
        meta.deletedIds.delete(id);
        if (d.status === 'published') {
          meta.hiddenIds.delete(id);
          meta.hiddenSlugs.delete(doc.slug);
        } else {
          meta.hiddenIds.add(id);
          meta.hiddenSlugs.add(doc.slug);
        }

        await firestoreSetDoc(
          'products',
          id,
          doc as unknown as Record<string, unknown>,
          idToken
        );
        await saveClientCatalogVisibilityMeta(meta, idToken);
        saveClientProductOverride(doc);

        await writeProductAuditLog(idToken, {
          productId: id,
          productTitle: doc.title,
          actorUserId: session.uid,
          actorEmail: session.email,
          action: d.status === 'published' ? 'publish' : 'create',
          summary:
            d.status === 'published'
              ? `Created and published "${doc.title}" at ₹${(doc.price_paise / 100).toLocaleString('en-IN')} (${totalStock} in stock).`
              : `Created draft "${doc.title}" (${totalStock} in stock).`,
          after: {
            pricePaise: doc.price_paise,
            stockQty: totalStock,
            status: doc.status,
            variantsCount: d.variants.length,
          },
          createdAt: now,
        });

        const dto = formatProductDto(doc, true, 0);
        return {
          ok: true,
          data: { product: dto, item: dto } as unknown as T,
        };
      }

      if (cleanPath.startsWith('/api/admin/products/')) {
        const sub = cleanPath.slice('/api/admin/products/'.length).replace(/\/+$/, '');
        const slashIdx = sub.lastIndexOf('/');
        const possibleAction = slashIdx > 0 ? sub.slice(slashIdx + 1).toLowerCase() : '';
        const isLifecycleOrSubAction =
          possibleAction === 'publish' ||
          possibleAction === 'unpublish' ||
          possibleAction === 'archive' ||
          possibleAction === 'restore' ||
          possibleAction === 'duplicate' ||
          possibleAction === 'status';

        if (isLifecycleOrSubAction) {
          const rawProductId = decodeURIComponent(sub.slice(0, slashIdx));
          const allDocs = await getMergedProductDocs(idToken);
          const existing = allDocs.find(
            (d) =>
              d.id === rawProductId ||
              d.id.toLowerCase() === rawProductId.toLowerCase() ||
              d.slug === rawProductId ||
              d.sku.toLowerCase() === rawProductId.toLowerCase()
          );
          if (!existing) {
            return {
              ok: false,
              status: 404,
              code: 'PRODUCT_NOT_FOUND',
              error: 'Product not found.',
            };
          }
          const canonicalId = existing.id;
          const now = Date.now();

          if (possibleAction === 'duplicate') {
            const newId = `prod_${now.toString(36)}_${randomHex(3)}`;
            const newTitle = `${existing.title} (Copy)`.slice(0, 140);
            const newSku = `${existing.sku}-COPY`.slice(0, 48);
            const copyRaw: StoredProductDoc = {
              ...existing,
              id: newId,
              slug: `${existing.slug}-copy-${randomHex(2)}`.slice(0, 140),
              title: newTitle,
              sku: newSku,
              featured: Boolean(existing.featured),
              status: 'draft',
              version: 1,
              published_at: null,
              archived_at: null,
              created_at: now,
              updated_at: now,
              variants: (existing.variants || []).map((v, idx) => ({
                ...v,
                id: `${newId}-var-${idx + 1}`,
                product_id: newId,
                sku: `${newSku}-V${idx + 1}`.slice(0, 64),
              })),
              images: (existing.images || []).map((img, idx) => ({
                ...img,
                id: `${newId}-img-${idx + 1}`,
                product_id: newId,
                media_id: img.media_id ?? null,
                is_cover: Boolean(img.is_cover),
              })),
            };
            const copyDoc = sanitizeProductDocForFirestore(copyRaw, newId);
            assertProductDocWithinFirestoreSizeLimit(copyDoc);
            await firestoreSetDoc(
              'products',
              newId,
              copyDoc as unknown as Record<string, unknown>,
              idToken
            );
            saveClientProductOverride(copyDoc);
            await writeProductAuditLog(idToken, {
              productId: newId,
              productTitle: copyDoc.title,
              actorUserId: session.uid,
              actorEmail: session.email,
              action: 'duplicate',
              summary: `Duplicated from "${existing.title}" as draft`,
              after: { status: 'draft', sku: copyDoc.sku },
              createdAt: now,
            });
            const dto = formatProductDto(copyDoc, true, 0);
            return { ok: true, data: { product: dto, item: dto } as unknown as T };
          }

          if (
            typeof body.expectedVersion === 'number' &&
            body.expectedVersion !== Number(existing.version || 1)
          ) {
            return {
              ok: false,
              status: 409,
              code: 'VERSION_CONFLICT',
              error: 'Product version changed concurrently. Refresh and retry.',
            };
          }

          const targetStatus: 'published' | 'draft' | 'archived' =
            possibleAction === 'publish'
              ? 'published'
              : possibleAction === 'archive'
                ? 'archived'
                : possibleAction === 'unpublish' || possibleAction === 'restore'
                  ? 'draft'
                  : body.status === 'published' || body.status === 'active'
                    ? 'published'
                    : body.status === 'archived'
                      ? 'archived'
                      : 'draft';

          if (targetStatus === 'published') {
            if (!existing.images || existing.images.length === 0) {
              return {
                ok: false,
                status: 400,
                code: 'VALIDATION_ERROR',
                error: 'Add at least one photo before publishing this product to the storefront.',
              };
            }
            let parsedColors: ProductColor[] = [];
            try {
              const p = JSON.parse(existing.colors_json || '[]');
              if (Array.isArray(p)) parsedColors = p;
            } catch {
              parsedColors = [];
            }
            const matrixCheck = validateColorVariantMatrix({
              colors: parsedColors,
              variants: (existing.variants || []).map((v) => ({
                sku: v.sku,
                size: v.size,
                colorId: v.color_id ?? null,
                colorName: v.color_name,
                pricePaise: Number(v.price_paise),
                priceOverridePaise: v.price_override_paise ?? null,
                stockQty: Number(v.stock_qty),
                active: v.active !== false && v.active !== 0,
              })),
              images: (existing.images || []).map((img) => ({
                url: img.url,
                colorId: img.color_id ?? null,
              })),
              requireCompleteForPublish: true,
            });
            if (!matrixCheck.ok) {
              return {
                ok: false,
                status: 400,
                code: 'INCOMPLETE_COLOR_VARIANTS',
                error: matrixCheck.errors[0] || 'Complete all active colour galleries and variants before publishing.',
              };
            }
          }

          const updatedRaw: StoredProductDoc = {
            ...existing,
            id: canonicalId,
            featured: Boolean(existing.featured),
            status: targetStatus,
            version: Number(existing.version || 1) + 1,
            published_at:
              targetStatus === 'published'
                ? existing.published_at ?? now
                : existing.published_at,
            archived_at: targetStatus === 'archived' ? now : null,
            updated_at: now,
          };
          const updated = sanitizeProductDocForFirestore(updatedRaw, canonicalId);
          assertProductDocWithinFirestoreSizeLimit(updated);

          const meta = await getClientCatalogVisibilityMeta(idToken);
          meta.deletedIds.delete(canonicalId);
          if (targetStatus === 'published') {
            meta.hiddenIds.delete(canonicalId);
            meta.hiddenSlugs.delete(updated.slug);
            meta.hiddenSlugs.delete(existing.slug);
          } else {
            meta.hiddenIds.add(canonicalId);
            meta.hiddenSlugs.add(updated.slug);
            meta.hiddenSlugs.add(existing.slug);
          }

          await firestoreSetDoc(
            'products',
            canonicalId,
            updated as unknown as Record<string, unknown>,
            idToken
          );
          await saveClientCatalogVisibilityMeta(meta, idToken);
          saveClientProductOverride(updated);

          await writeProductAuditLog(idToken, {
            productId: canonicalId,
            productTitle: updated.title,
            actorUserId: session.uid,
            actorEmail: session.email,
            action: possibleAction === 'status' ? targetStatus : possibleAction,
            summary: `${
              possibleAction === 'unpublish'
                ? 'Unpublished'
                : possibleAction === 'publish'
                  ? 'Published'
                  : possibleAction === 'archive'
                    ? 'Archived'
                    : 'Restored'
            } "${updated.title}" (${existing.status} -> ${targetStatus})`,
            before: { status: existing.status },
            after: { status: targetStatus },
            createdAt: now,
          });

          const orders = await firestoreListDocs<ClientOrderDoc>('orders', idToken).catch(() => []);
          const orderCount = computeProductOrderCounts(orders).get(canonicalId) || 0;
          const dto = formatProductDto(updated, true, orderCount);
          return { ok: true, data: { product: dto, item: dto } as unknown as T };
        }

        const productId = decodeURIComponent(sub);

        if (upperMethod === 'GET') {
          const [allDocs, orders, auditDocs] = await Promise.all([
            getMergedProductDocs(idToken),
            firestoreListDocs<ClientOrderDoc>('orders', idToken),
            firestoreListDocs<{
              id: string;
              product_id?: string | null;
              action: string;
              summary: string;
              created_at: number;
            }>('product_audit_logs', idToken),
          ]);
          const found = allDocs.find(
            (d) =>
              d.id === productId ||
              d.id.toLowerCase() === productId.toLowerCase() ||
              d.slug === productId
          );
          if (!found) {
            return {
              ok: false,
              status: 404,
              code: 'PRODUCT_NOT_FOUND',
              error: 'Product not found.',
            };
          }
          const orderCount = computeProductOrderCounts(orders).get(found.id) || 0;
          const auditLogs = auditDocs
            .filter((log) => log.product_id === found.id)
            .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
            .slice(0, 20)
            .map((log) => ({
              id: log.id,
              action: log.action,
              summary: log.summary,
              createdAt: Number(log.created_at || Date.now()),
            }));
          return {
            ok: true,
            data: {
              product: formatProductDto(found, true, orderCount),
              auditLogs,
            } as unknown as T,
          };
        }

        if (upperMethod === 'PATCH' || upperMethod === 'PUT' || upperMethod === 'POST') {
          const allDocs = await getMergedProductDocs(idToken);
          const existing = allDocs.find(
            (d) =>
              d.id === productId ||
              d.id.toLowerCase() === productId.toLowerCase() ||
              d.slug === productId
          );
          if (!existing) {
            return {
              ok: false,
              status: 404,
              code: 'PRODUCT_NOT_FOUND',
              error: 'Product not found.',
            };
          }
          const canonicalId = existing.id;
          const now = Date.now();
          const currentVersion = Number(existing.version || 1);

          // Support status-only PATCH updates
          if (
            typeof body.status === 'string' &&
            ['published', 'draft', 'archived'].includes(body.status) &&
            body.title === undefined &&
            body.name === undefined
          ) {
            if (
              typeof body.expectedVersion === 'number' &&
              body.expectedVersion !== currentVersion
            ) {
              return {
                ok: false,
                status: 409,
                code: 'VERSION_CONFLICT',
                error: 'Product version changed concurrently. Refresh and retry.',
              };
            }
            const targetStatus = body.status as 'published' | 'draft' | 'archived';
            if (targetStatus === 'published') {
              if (!existing.images || existing.images.length === 0) {
                return {
                  ok: false,
                  status: 400,
                  code: 'VALIDATION_ERROR',
                  error: 'Add at least one photo before publishing this product to the storefront.',
                  fieldErrors: {
                    images: 'Add at least one photo before publishing this product to the storefront.',
                  },
                };
              }
              let parsedColors: ProductColor[] = [];
              try {
                const p = JSON.parse(existing.colors_json || '[]');
                if (Array.isArray(p)) parsedColors = p;
              } catch {
                parsedColors = [];
              }
              const matrixCheck = validateColorVariantMatrix({
                colors: parsedColors,
                variants: (existing.variants || []).map((v) => ({
                  sku: v.sku,
                  size: v.size,
                  colorId: v.color_id ?? null,
                  colorName: v.color_name,
                  pricePaise: Number(v.price_paise),
                  priceOverridePaise: v.price_override_paise ?? null,
                  stockQty: Number(v.stock_qty),
                  active: v.active !== false && v.active !== 0,
                })),
                images: (existing.images || []).map((img) => ({
                  url: img.url,
                  colorId: img.color_id ?? null,
                })),
                requireCompleteForPublish: true,
              });
              if (!matrixCheck.ok) {
                const msg =
                  matrixCheck.errors[0] ||
                  'Complete all active colour galleries and variants before publishing.';
                return {
                  ok: false,
                  status: 400,
                  code: 'INCOMPLETE_COLOR_VARIANTS',
                  error: msg,
                  fieldErrors: { ...matrixCheck.fieldErrors, variants: msg },
                };
              }
            }
            const updatedRaw: StoredProductDoc = {
              ...existing,
              id: canonicalId,
              featured: Boolean(existing.featured),
              status: targetStatus,
              version: currentVersion + 1,
              published_at:
                targetStatus === 'published'
                  ? existing.published_at ?? now
                  : existing.published_at,
              archived_at: targetStatus === 'archived' ? now : null,
              updated_at: now,
            };
            const updated = sanitizeProductDocForFirestore(updatedRaw, canonicalId);
            assertProductDocWithinFirestoreSizeLimit(updated);
            const meta = await getClientCatalogVisibilityMeta(idToken);
            meta.deletedIds.delete(canonicalId);
            if (targetStatus === 'published') {
              meta.hiddenIds.delete(canonicalId);
              meta.hiddenSlugs.delete(updated.slug);
              meta.hiddenSlugs.delete(existing.slug);
            } else {
              meta.hiddenIds.add(canonicalId);
              meta.hiddenSlugs.add(updated.slug);
              meta.hiddenSlugs.add(existing.slug);
            }
            await firestoreSetDoc(
              'products',
              canonicalId,
              updated as unknown as Record<string, unknown>,
              idToken
            );
            await saveClientCatalogVisibilityMeta(meta, idToken);
            saveClientProductOverride(updated);
            const actionName =
              targetStatus === 'published'
                ? 'publish'
                : targetStatus === 'archived'
                  ? 'archive'
                  : existing.status === 'archived'
                    ? 'restore'
                    : 'unpublish';
            await writeProductAuditLog(idToken, {
              productId: canonicalId,
              productTitle: updated.title,
              actorUserId: session.uid,
              actorEmail: session.email,
              action: actionName,
              summary: `${actionName}ed "${updated.title}" (${existing.status} -> ${targetStatus})`,
              before: { status: existing.status },
              after: { status: targetStatus },
              createdAt: now,
            });
            const orders = await firestoreListDocs<ClientOrderDoc>('orders', idToken).catch(() => []);
            const orderCount = computeProductOrderCounts(orders).get(canonicalId) || 0;
            const dto = formatProductDto(updated, true, orderCount);
            return { ok: true, data: { product: dto, item: dto } as unknown as T };
          }

          if (
            typeof body.expectedVersion === 'number' &&
            body.expectedVersion !== currentVersion
          ) {
            return {
              ok: false,
              status: 409,
              code: 'VERSION_CONFLICT',
              error:
                'This product was updated elsewhere since you opened it. Reload the latest version before saving.',
            };
          }

          const validated = validateClientProductPayload({
            body,
            allDocs,
            existing,
            productId: canonicalId,
          });
          if (!validated.ok) {
            return {
              ok: false,
              status: 400,
              code: 'VALIDATION_ERROR',
              error: validated.error,
              fieldErrors: validated.fieldErrors,
            };
          }

          const d = validated.data;
          // Preserve existing slug when editing unless a distinct explicit slug is requested
          const nextSlug =
            typeof body.slug === 'string' && body.slug.trim() && body.slug.trim() !== existing.slug
              ? body.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 140) ||
                existing.slug
              : existing.slug;
          const totalStock = d.variants.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);
          const nextStatus: 'draft' | 'published' | 'archived' =
            body.status === 'published' || body.status === 'draft'
              ? body.status
              : existing.status === 'archived'
                ? 'archived'
                : d.status;

          const updatedRaw: StoredProductDoc = {
            ...existing,
            id: canonicalId,
            title: d.title,
            sku: d.sku,
            slug: nextSlug,
            description: d.description,
            fabric_note: d.fabricNote,
            included_pieces: d.includedPieces,
            care_note: d.careNote,
            category: d.category,
            status: nextStatus,
            featured: d.featured,
            price_paise: d.pricePaise,
            compare_at_paise: d.compareAtPaise,
            stock_qty: totalStock,
            low_stock_threshold: d.lowStockThreshold,
            colors_json: JSON.stringify(d.colors),
            sizes_json: JSON.stringify(d.sizes),
            version: currentVersion + 1,
            published_at:
              nextStatus === 'published'
                ? existing.published_at ?? now
                : existing.published_at,
            archived_at: nextStatus === 'archived' ? existing.archived_at ?? now : null,
            updated_at: now,
            variants: d.variants,
            images: d.images,
            variant_skus: d.variants.map((v) => v.sku),
            image_urls: d.images.map((i) => i.url),
          };
          const updated = sanitizeProductDocForFirestore(updatedRaw, canonicalId);
          assertProductDocWithinFirestoreSizeLimit(updated);

          const meta = await getClientCatalogVisibilityMeta(idToken);
          meta.deletedIds.delete(canonicalId);
          if (nextStatus === 'published') {
            meta.hiddenIds.delete(canonicalId);
            meta.hiddenSlugs.delete(updated.slug);
            meta.hiddenSlugs.delete(existing.slug);
          } else {
            meta.hiddenIds.add(canonicalId);
            meta.hiddenSlugs.add(updated.slug);
            meta.hiddenSlugs.add(existing.slug);
          }

          await firestoreSetDoc(
            'products',
            canonicalId,
            updated as unknown as Record<string, unknown>,
            idToken
          );
          await saveClientCatalogVisibilityMeta(meta, idToken);
          saveClientProductOverride(updated);

          const priceChanged = Number(existing.price_paise) !== updated.price_paise;
          const stockChanged = Number(existing.stock_qty) !== totalStock;
          const statusChanged =
            (existing.status === 'active' ? 'published' : existing.status) !== nextStatus;
          const auditAction = statusChanged
            ? nextStatus === 'published'
              ? 'publish'
              : 'unpublish'
            : priceChanged
              ? 'price_change'
              : stockChanged
                ? 'stock_change'
                : 'update';
          const notes: string[] = [];
          if (priceChanged) {
            notes.push(
              `price ₹${(Number(existing.price_paise) / 100).toLocaleString('en-IN')} -> ₹${(
                updated.price_paise / 100
              ).toLocaleString('en-IN')}`
            );
          }
          if (stockChanged) {
            notes.push(`stock ${existing.stock_qty} -> ${totalStock}`);
          }
          if (existing.title !== updated.title) {
            notes.push(`title updated`);
          }
          await writeProductAuditLog(idToken, {
            productId: canonicalId,
            productTitle: updated.title,
            actorUserId: session.uid,
            actorEmail: session.email,
            action: auditAction,
            summary: `Updated "${updated.title}"${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
            before: {
              title: existing.title,
              pricePaise: existing.price_paise,
              stockQty: existing.stock_qty,
              status: existing.status,
            },
            after: {
              title: updated.title,
              pricePaise: updated.price_paise,
              stockQty: totalStock,
              status: updated.status,
            },
            createdAt: now,
          });

          const orders = await firestoreListDocs<ClientOrderDoc>('orders', idToken).catch(() => []);
          const orderCount = computeProductOrderCounts(orders).get(canonicalId) || 0;
          const dto = formatProductDto(updated, true, orderCount);
          return {
            ok: true,
            data: { product: dto, item: dto } as unknown as T,
          };
        }

        if (upperMethod === 'DELETE') {
          const [allDocs, orders] = await Promise.all([
            getMergedProductDocs(idToken),
            firestoreListDocs<ClientOrderDoc>('orders', idToken),
          ]);
          const existing = allDocs.find(
            (d) =>
              d.id === productId ||
              d.id.toLowerCase() === productId.toLowerCase() ||
              d.slug === productId
          );
          if (!existing) {
            return {
              ok: false,
              status: 404,
              code: 'PRODUCT_NOT_FOUND',
              error: 'Product not found.',
            };
          }
          const canonicalId = existing.id;
          const now = Date.now();
          const refCount = computeProductOrderCounts(orders).get(canonicalId) || 0;
          const seedMatch = PRODUCTS.find((p) => p.id === canonicalId);
          const meta = await getClientCatalogVisibilityMeta(idToken);

          if (refCount > 0) {
            const archivedRaw: StoredProductDoc = {
              ...existing,
              id: canonicalId,
              status: 'archived',
              archived_at: now,
              version: Number(existing.version || 1) + 1,
              updated_at: now,
            };
            const archivedDoc = sanitizeProductDocForFirestore(archivedRaw, canonicalId);
            meta.deletedIds.delete(canonicalId);
            meta.hiddenIds.add(canonicalId);
            meta.hiddenSlugs.add(existing.slug);
            if (seedMatch?.slug) meta.hiddenSlugs.add(seedMatch.slug);

            await firestoreSetDoc(
              'products',
              canonicalId,
              archivedDoc as unknown as Record<string, unknown>,
              idToken
            );
            await saveClientCatalogVisibilityMeta(meta, idToken);
            saveClientProductOverride(archivedDoc);

            await writeProductAuditLog(idToken, {
              productId: canonicalId,
              productTitle: existing.title,
              actorUserId: session.uid,
              actorEmail: session.email,
              action: 'archive',
              summary: `Archived "${existing.title}" instead of deletion because ${refCount} historical order item(s) reference it.`,
              before: { status: existing.status },
              after: { status: 'archived' },
              createdAt: now,
            });

            const dto = formatProductDto(archivedDoc, true, refCount);
            return {
              ok: true,
              data: {
                deleted: false,
                archivedInsteadOfDeleted: true,
                id: canonicalId,
                product: dto,
                message:
                  'Product is referenced by existing customer orders and was archived to preserve order history.',
              } as unknown as T,
            };
          }

          meta.deletedIds.add(canonicalId);
          meta.hiddenIds.add(canonicalId);
          meta.hiddenSlugs.add(existing.slug);
          if (seedMatch?.slug) meta.hiddenSlugs.add(seedMatch.slug);

          await firestoreDeleteDoc('products', canonicalId, idToken);
          await saveClientCatalogVisibilityMeta(meta, idToken);
          removeClientProductOverride(canonicalId);

          await writeProductAuditLog(idToken, {
            productId: canonicalId,
            productTitle: existing.title,
            actorUserId: session.uid,
            actorEmail: session.email,
            action: 'delete',
            summary: `Permanently deleted "${existing.title}" (${existing.sku})`,
            before: { status: existing.status, sku: existing.sku },
            createdAt: now,
          });

          return {
            ok: true,
            data: {
              deleted: true,
              deletedId: canonicalId,
              archivedInsteadOfDeleted: false,
              id: canonicalId,
              message: `Deleted "${existing.title}".`,
            } as unknown as T,
          };
        }
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
        await firestoreSetDoc('categories', id, record, idToken);
        const catDto = {
          id: record.id,
          name: record.name,
          slug: record.slug,
          subtitle: record.subtitle,
          imageUrl: record.image_url,
          altText: record.alt_text,
          position: record.position,
          createdAt: now,
          updatedAt: now,
        };
        return {
          ok: true,
          data: {
            category: catDto,
            item: catDto,
          } as unknown as T,
        };
      }

      if (cleanPath.startsWith('/api/admin/categories/')) {
        const catId = decodeURIComponent(cleanPath.slice('/api/admin/categories/'.length));
        if (upperMethod === 'DELETE') {
          await firestoreDeleteDoc('categories', catId, idToken);
          return { ok: true, data: { deleted: true, deletedId: catId, id: catId } as unknown as T };
        }
        if (upperMethod === 'PATCH' || upperMethod === 'PUT') {
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
          const catDto = {
            id: String(updated.id || catId),
            name: String(updated.name || ''),
            slug: String(updated.slug || catId),
            subtitle: String(updated.subtitle || ''),
            imageUrl: String(updated.image_url || ''),
            altText: String(updated.alt_text || ''),
            position: Number(updated.position || 0),
            createdAt: Number(updated.created_at || now),
            updatedAt: now,
          };
          return {
            ok: true,
            data: {
              category: catDto,
              item: catDto,
            } as unknown as T,
          };
        }
      }

      if (cleanPath.startsWith('/api/admin/messages/')) {
        const msgId = decodeURIComponent(cleanPath.slice('/api/admin/messages/'.length));
        if (upperMethod === 'DELETE') {
          await firestoreDeleteDoc('contact_messages', msgId, idToken);
          return { ok: true, data: { deleted: true, deletedId: msgId, id: msgId } as unknown as T };
        }
        if (upperMethod === 'PATCH' || upperMethod === 'PUT') {
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
          const nextNote =
            typeof body.adminNote === 'string'
              ? body.adminNote
              : typeof body.adminNotes === 'string'
                ? body.adminNotes
                : String(existing.admin_note ?? existing.admin_notes ?? '');
          const nextStatus =
            typeof body.status === 'string'
              ? body.status === 'new'
                ? 'unread'
                : body.status
              : String(existing.status || 'unread');
          const updated: Record<string, unknown> = {
            ...existing,
            status: nextStatus,
            admin_note: nextNote,
            updated_at: now,
          };
          await firestoreSetDoc('contact_messages', msgId, updated, idToken);
          const msgDto = {
            id: msgId,
            senderName: String(updated.sender_name || updated.full_name || 'Guest'),
            fullName: String(updated.sender_name || updated.full_name || 'Guest'),
            senderPhone: String(updated.sender_phone || updated.phone || ''),
            phone: String(updated.sender_phone || updated.phone || ''),
            senderEmail: String(updated.sender_email || updated.email || ''),
            email: (updated.sender_email || updated.email || null) as string | null,
            subject: String(updated.subject || updated.product_interest || 'Boutique Enquiry'),
            productInterest: (updated.product_interest || updated.subject || null) as string | null,
            message: String(updated.message || ''),
            status: nextStatus,
            adminNote: nextNote,
            adminNotes: nextNote,
            createdAt: Number(updated.created_at || now),
            updatedAt: now,
          };
          return {
            ok: true,
            data: {
              message: msgDto,
              item: msgDto,
            } as unknown as T,
          };
        }
      }

      if (cleanPath === '/api/admin/orders/recover' && upperMethod === 'POST') {
        const rzOrderId =
          typeof body.razorpayOrderId === 'string'
            ? body.razorpayOrderId.trim()
            : typeof body.razorpay_order_id === 'string'
              ? body.razorpay_order_id.trim()
              : '';
        const rzPaymentId =
          typeof body.razorpayPaymentId === 'string'
            ? body.razorpayPaymentId.trim()
            : typeof body.razorpay_payment_id === 'string'
              ? body.razorpay_payment_id.trim()
              : '';
        if (!rzOrderId) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: 'Razorpay Order ID (order_...) is required to recover a captured payment.',
          };
        }
        const statusRes = await fetch('/api/order-status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            razorpay_order_id: rzOrderId,
            razorpay_payment_id: rzPaymentId || undefined,
          }),
        });
        const statusBody = (await statusRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (!statusRes.ok && statusRes.status !== 202) {
          return {
            ok: false,
            status: statusRes.status || 500,
            code: typeof statusBody.code === 'string' ? statusBody.code : 'RECOVER_FAILED',
            error:
              typeof statusBody.error === 'string' && statusBody.error
                ? statusBody.error
                : 'Unable to recover Razorpay order from /api/order-status.',
          };
        }
        return {
          ok: true,
          data: statusBody as unknown as T,
        };
      }

      if (cleanPath.startsWith('/api/admin/orders/') && (upperMethod === 'PATCH' || upperMethod === 'POST')) {
        const rawSub = cleanPath.slice('/api/admin/orders/'.length).replace(/\/+$/, '');
        if (rawSub.endsWith('/resolve-request') && upperMethod === 'POST') {
          const orderId = decodeURIComponent(rawSub.slice(0, -'/resolve-request'.length));
          const decision =
            body.decision === 'approved' || body.decision === 'rejected' ? body.decision : null;
          if (!decision) {
            return {
              ok: false,
              status: 400,
              code: 'VALIDATION_ERROR',
              error: 'Decision must be "approved" or "rejected".',
            };
          }
          const meta = await firestoreGetDocWithMeta<Record<string, unknown>>(
            'orders',
            orderId,
            idToken
          );
          if (!meta) {
            return { ok: false, status: 404, code: 'ORDER_NOT_FOUND', error: 'Order not found.' };
          }
          const existing = meta.data;
          const prevHistory = parseOrderHistory(
            existing.status_history ?? existing.status_history_json
          );
          const norm = normalizeOrderRequestsAndStatus({
            rawStatus: typeof existing.status === 'string' ? existing.status : undefined,
            rawFulfillmentStatus:
              typeof existing.fulfillment_status === 'string'
                ? existing.fulfillment_status
                : undefined,
            rawCancelRequest: existing.cancel_request ?? existing.cancel_request_json,
            rawReturnRequest: existing.return_request ?? existing.return_request_json,
            history: prevHistory,
            paymentMethod:
              typeof existing.payment_method === 'string' ? existing.payment_method : undefined,
          });
          const reqType =
            body.requestType === 'cancel'
              ? 'cancel'
              : body.requestType === 'return'
                ? 'return'
                : undefined;
          const currentReq =
            reqType === 'cancel'
              ? norm.cancelRequest
              : reqType === 'return'
                ? norm.returnRequest
                : norm.cancelRequest?.status === 'pending'
                  ? norm.cancelRequest
                  : norm.returnRequest?.status === 'pending'
                    ? norm.returnRequest
                    : norm.cancelRequest || norm.returnRequest;
          if (!currentReq) {
            return {
              ok: false,
              status: 404,
              code: 'REQUEST_NOT_FOUND',
              error: 'No return or cancellation request found on this order.',
            };
          }
          if (currentReq.status !== 'pending') {
            return {
              ok: false,
              status: 409,
              code: 'CONCURRENCY_CONFLICT',
              error: `Cannot ${decision === 'approved' ? 'approve' : 'reject'} request because its status is already "${currentReq.status}".`,
            };
          }
          const now = Date.now();
          const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
          const updatedReq: OrderReturnRequest = {
            ...currentReq,
            status: decision,
            updatedAt: now,
            resolvedAt: now,
            resolutionNote: note || undefined,
          };
          const nextFulfillment =
            decision === 'approved'
              ? updatedReq.type === 'cancel'
                ? 'cancelled'
                : 'returned'
              : norm.fulfillmentStatus;
          const nextHistory: OrderStatusHistoryEntry[] = [
            ...(prevHistory as OrderStatusHistoryEntry[]),
            {
              status: `${updatedReq.type}_${decision}`,
              note: note || `Request ${decision} by store owner`,
              actor: 'owner',
              at: now,
            },
          ];
          const shouldRestoreStock =
            decision === 'approved' &&
            updatedReq.type === 'cancel' &&
            !existing.stock_restored_at;
          const patch: Record<string, unknown> = {
            status: nextFulfillment,
            fulfillment_status: nextFulfillment,
            cancel_request: updatedReq.type === 'cancel' ? updatedReq : (norm.cancelRequest ?? null),
            cancel_request_json:
              updatedReq.type === 'cancel'
                ? JSON.stringify(updatedReq)
                : norm.cancelRequest
                  ? JSON.stringify(norm.cancelRequest)
                  : null,
            return_request: updatedReq.type === 'return' ? updatedReq : (norm.returnRequest ?? null),
            return_request_json:
              updatedReq.type === 'return'
                ? JSON.stringify(updatedReq)
                : norm.returnRequest
                  ? JSON.stringify(norm.returnRequest)
                  : null,
            stock_restored_at: shouldRestoreStock ? now : (existing.stock_restored_at ?? null),
            status_history: nextHistory,
            status_history_json: JSON.stringify(nextHistory),
            updated_at: now,
          };
          await firestoreSetDoc(
            'orders',
            orderId,
            patch,
            idToken,
            Object.keys(patch),
            { updateTime: meta.updateTime }
          );

          // Idempotent stock restoration AFTER optimistic lock succeeds
          if (shouldRestoreStock && Array.isArray(existing.items)) {
            const qtyByProduct = new Map<string, Map<string | null, number>>();
            for (const item of existing.items as Array<Record<string, unknown>>) {
              const pid = typeof item.product_id === 'string' ? item.product_id : '';
              if (!pid) continue;
              const vid = typeof item.variant_id === 'string' && item.variant_id ? item.variant_id : null;
              const qty = Math.max(0, Number(item.quantity ?? item.qty ?? 0));
              if (!qty) continue;
              const inner = qtyByProduct.get(pid) || new Map<string | null, number>();
              inner.set(vid, (inner.get(vid) || 0) + qty);
              qtyByProduct.set(pid, inner);
            }
            for (const [pid, varMap] of qtyByProduct.entries()) {
              const prodDoc = await firestoreGetDoc<StoredProductDoc>('products', pid, idToken).catch(() => null);
              if (!prodDoc || !Array.isArray(prodDoc.variants)) continue;
              const cloned = prodDoc.variants.map((v) => ({ ...v }));
              for (const [vid, qty] of varMap.entries()) {
                const idx = vid ? cloned.findIndex((v) => v.id === vid) : 0;
                if (idx >= 0) cloned[idx].stock_qty += qty;
              }
              const totalStock = cloned.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);
              await firestoreSetDoc(
                'products',
                pid,
                { variants: cloned, stock_qty: totalStock, updated_at: now },
                idToken,
                ['variants', 'stock_qty', 'updated_at']
              ).catch(() => undefined);
            }
          }

          const customerUid =
            typeof existing.customer_user_id === 'string' ? existing.customer_user_id : null;
          if (customerUid) {
            const custDoc = await firestoreGetDoc<{
              notification_prefs_json?: string | null;
              notification_prefs?: unknown;
            }>('users', customerUid, idToken).catch(() => null);
            const prefs = parseNotificationPrefs(
              custDoc?.notification_prefs ?? custDoc?.notification_prefs_json
            );
            if (prefs.cancelReturnUpdates) {
              const notifId = `notif_req_${orderId}_${updatedReq.id}_${decision}`;
              await firestoreSetDoc(
                `users/${encodeURIComponent(customerUid)}/notifications`,
                notifId,
                {
                  id: notifId,
                  user_id: customerUid,
                  type: 'request_update',
                  title: `${updatedReq.type === 'cancel' ? 'Cancellation' : 'Return'} request ${decision}`,
                  message:
                    note ||
                    `Your ${updatedReq.type} request for order ${String(existing.order_number || orderId)} was ${decision}.`,
                  order_id: orderId,
                  order_number: String(existing.order_number || ''),
                  is_read: 0,
                  read: false,
                  read_at: null,
                  created_at: now,
                },
                idToken
              ).catch(() => undefined);
            }
          }
          emitBoutiqueSyncEvent('orders');
          return {
            ok: true,
            data: { order: serializeClientOrderDoc({ ...existing, ...patch }) } as unknown as T,
          };
        }

        if (rawSub.endsWith('/collect-payment') && upperMethod === 'POST') {
          const orderId = decodeURIComponent(rawSub.slice(0, -'/collect-payment'.length));
          const meta = await firestoreGetDocWithMeta<Record<string, unknown>>(
            'orders',
            orderId,
            idToken
          );
          if (!meta) {
            return {
              ok: false,
              status: 404,
              code: 'ORDER_NOT_FOUND',
              error: 'Order not found.',
            };
          }
          const existing = meta.data;
          const prevHistory = parseOrderHistory(
            existing.status_history ?? existing.status_history_json
          );
          const norm = normalizeOrderRequestsAndStatus({
            rawStatus: typeof existing.status === 'string' ? existing.status : undefined,
            rawFulfillmentStatus:
              typeof existing.fulfillment_status === 'string'
                ? existing.fulfillment_status
                : undefined,
            rawCancelRequest: existing.cancel_request ?? existing.cancel_request_json,
            rawReturnRequest: existing.return_request ?? existing.return_request_json,
            rawPaymentStatus: existing.payment_status,
            rawRefundStatus: existing.refund_status,
            rawCancelledAt: existing.cancelled_at,
            rawCancelledBy: existing.cancelled_by,
            rawCancelReason: existing.cancel_reason,
            razorpayPaymentId: existing.razorpay_payment_id,
            history: prevHistory,
            paymentMethod:
              typeof existing.payment_method === 'string' ? existing.payment_method : undefined,
          });
          if (norm.status === 'cancelled') {
            return {
              ok: false,
              status: 409,
              code: 'ORDER_CANCELLED',
              error: 'Payment cannot be collected for a cancelled order.',
            };
          }
          if (norm.paymentStatus === 'paid') {
            const serialized = serializeClientOrderDoc(existing);
            return {
              ok: true,
              data: { id: orderId, paymentStatus: 'paid', order: serialized } as unknown as T,
            };
          }
          const now = Date.now();
          const note =
            typeof body.note === 'string' && body.note.trim()
              ? body.note.trim().slice(0, 300)
              : 'Cash payment collected on delivery';
          const nextHistory: OrderStatusHistoryEntry[] = [
            ...(prevHistory as OrderStatusHistoryEntry[]),
            {
              status: 'payment_collected',
              note,
              actor: 'owner',
              at: now,
            },
          ];
          const patch: Record<string, unknown> = {
            payment_status: 'paid',
            payment_collected_at: now,
            payment_collected_by: session.uid,
            status_history: nextHistory,
            status_history_json: JSON.stringify(nextHistory),
            updated_at: now,
          };
          await firestoreSetDoc(
            'orders',
            orderId,
            patch,
            idToken,
            Object.keys(patch),
            { updateTime: meta.updateTime }
          );
          const customerUid =
            typeof existing.customer_user_id === 'string' ? existing.customer_user_id : null;
          if (customerUid) {
            const custDoc = await firestoreGetDoc<{
              notification_prefs_json?: string | null;
              notification_prefs?: unknown;
            }>('users', customerUid, idToken).catch(() => null);
            const prefs = parseNotificationPrefs(
              custDoc?.notification_prefs ?? custDoc?.notification_prefs_json
            );
            if (prefs.orderUpdates) {
              const notifId = `notif_paid_${orderId}_${now}`;
              await firestoreSetDoc(
                `users/${encodeURIComponent(customerUid)}/notifications`,
                notifId,
                {
                  id: notifId,
                  user_id: customerUid,
                  type: 'order_status',
                  title: `Payment collected for ${String(existing.order_number || orderId)}`,
                  message: `We have recorded Cash on Delivery payment for order ${String(existing.order_number || orderId)}.`,
                  order_id: orderId,
                  order_number: String(existing.order_number || ''),
                  is_read: 0,
                  read: false,
                  read_at: null,
                  created_at: now,
                },
                idToken
              ).catch(() => undefined);
            }
          }
          emitBoutiqueSyncEvent('orders');
          const serialized = serializeClientOrderDoc({ ...existing, ...patch });
          return {
            ok: true,
            data: { id: orderId, paymentStatus: 'paid', order: serialized } as unknown as T,
          };
        }

        const orderId = decodeURIComponent(
          rawSub.endsWith('/status') ? rawSub.slice(0, -'/status'.length) : rawSub
        );
        const meta = await firestoreGetDocWithMeta<Record<string, unknown>>(
          'orders',
          orderId,
          idToken
        );
        if (!meta) {
          return {
            ok: false,
            status: 404,
            code: 'ORDER_NOT_FOUND',
            error: 'Order not found.',
          };
        }
        const existing = meta.data;
        const prevHistory = parseOrderHistory(
          existing.status_history ?? existing.status_history_json
        );
        const norm = normalizeOrderRequestsAndStatus({
          rawStatus: typeof existing.status === 'string' ? existing.status : undefined,
          rawFulfillmentStatus:
            typeof existing.fulfillment_status === 'string'
              ? existing.fulfillment_status
              : undefined,
          rawCancelRequest: existing.cancel_request ?? existing.cancel_request_json,
          rawReturnRequest: existing.return_request ?? existing.return_request_json,
          rawPaymentStatus: existing.payment_status,
          rawRefundStatus: existing.refund_status,
          rawCancelledAt: existing.cancelled_at,
          rawCancelledBy: existing.cancelled_by,
          rawCancelReason: existing.cancel_reason,
          razorpayPaymentId: existing.razorpay_payment_id,
          history: prevHistory,
          paymentMethod:
            typeof existing.payment_method === 'string' ? existing.payment_method : undefined,
        });

        const expectedUpdatedAt =
          typeof body.expectedUpdatedAt === 'number' && Number.isFinite(body.expectedUpdatedAt)
            ? body.expectedUpdatedAt
            : null;
        const currentUpdatedAt = Number(existing.updated_at || existing.created_at || 0);
        if (expectedUpdatedAt !== null && currentUpdatedAt !== expectedUpdatedAt) {
          return {
            ok: false,
            status: 409,
            code: 'CONCURRENCY_CONFLICT',
            error:
              'This order was modified in another session (for example, cancelled by the customer). Reloading latest status.',
          };
        }

        const nextStatus = normalizeRawOrderStatusValue(
          typeof body.status === 'string' ? body.status : norm.status
        );
        if (!VALID_FULFILLMENT_STATES.has(nextStatus)) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: 'Invalid fulfillment status.',
          };
        }
        const transitionCheck = validateOrderStatusTransition(norm.status, nextStatus);
        if (!transitionCheck.ok) {
          return {
            ok: false,
            status: 409,
            code: transitionCheck.code,
            error: transitionCheck.error,
          };
        }

        const rawRefundStatus =
          typeof body.refundStatus === 'string' ? body.refundStatus.trim().toLowerCase() : '';
        const validRefundStatuses = new Set([
          'none',
          'not_required',
          'pending_refund',
          'refund_initiated',
          'refunded',
        ]);
        if (rawRefundStatus && !validRefundStatuses.has(rawRefundStatus)) {
          return {
            ok: false,
            status: 400,
            code: 'VALIDATION_ERROR',
            error: 'Invalid refund status.',
          };
        }

        const now = Date.now();
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
        const derivedPayRef = normalizePaymentAndRefundStatus({
          rawPaymentStatus: existing.payment_status,
          rawRefundStatus: rawRefundStatus || existing.refund_status,
          paymentMethod: existing.payment_method,
          orderStatus: nextStatus,
          razorpayPaymentId: existing.razorpay_payment_id,
        });
        const historyStatus =
          rawRefundStatus && nextStatus === norm.status
            ? `refund_${rawRefundStatus}`
            : nextStatus;
        const nextHistory: OrderStatusHistoryEntry[] = [
          ...(prevHistory as OrderStatusHistoryEntry[]),
          {
            status: historyStatus,
            note:
              note ||
              (rawRefundStatus && nextStatus === norm.status
                ? `Refund status updated to ${rawRefundStatus.replace(/_/g, ' ')}`
                : `Updated to ${nextStatus.replace(/_/g, ' ')}`),
            actor: 'owner',
            at: now,
          },
        ];

        const shouldRestoreStock =
          nextStatus === 'cancelled' &&
          norm.status !== 'cancelled' &&
          !existing.stock_restored_at;

        const patch: Record<string, unknown> = {
          status: nextStatus,
          fulfillment_status: nextStatus,
          refund_status: derivedPayRef.refundStatus,
          status_history: nextHistory,
          status_history_json: JSON.stringify(nextHistory),
          updated_at: now,
        };
        if (nextStatus === 'cancelled' && norm.status !== 'cancelled') {
          patch.cancelled_at = norm.cancelledAt || now;
          patch.cancelled_by = norm.cancelledBy || 'owner';
          patch.cancel_reason = note || norm.cancelReason || null;
        }
        if (shouldRestoreStock) {
          patch.stock_restored_at = now;
        }

        try {
          await firestoreSetDoc(
            'orders',
            orderId,
            patch,
            idToken,
            Object.keys(patch),
            { updateTime: meta.updateTime }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('FAILED_PRECONDITION') || msg.includes('409') || msg.includes('412')) {
            return {
              ok: false,
              status: 409,
              code: 'CONCURRENCY_CONFLICT',
              error:
                'This order was modified concurrently. Please refresh to see the latest status.',
            };
          }
          throw err;
        }

        // Restore variant stock once and only once AFTER optimistic lock succeeds
        if (shouldRestoreStock && Array.isArray(existing.items)) {
          const qtyByProduct = new Map<string, Map<string | null, number>>();
          for (const item of existing.items as Array<Record<string, unknown>>) {
            const pid = typeof item.product_id === 'string' ? item.product_id : '';
            if (!pid) continue;
            const vid = typeof item.variant_id === 'string' && item.variant_id ? item.variant_id : null;
            const qty = Math.max(0, Number(item.quantity ?? item.qty ?? 0));
            if (!qty) continue;
            const inner = qtyByProduct.get(pid) || new Map<string | null, number>();
            inner.set(vid, (inner.get(vid) || 0) + qty);
            qtyByProduct.set(pid, inner);
          }
          for (const [pid, varMap] of qtyByProduct.entries()) {
            const prodDoc = await firestoreGetDoc<StoredProductDoc>('products', pid, idToken).catch(() => null);
            if (!prodDoc || !Array.isArray(prodDoc.variants)) continue;
            const cloned = prodDoc.variants.map((v) => ({ ...v }));
            for (const [vid, qty] of varMap.entries()) {
              const idx = vid ? cloned.findIndex((v) => v.id === vid) : 0;
              if (idx >= 0) cloned[idx].stock_qty += qty;
            }
            const totalStock = cloned.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);
            await firestoreSetDoc(
              'products',
              pid,
              { variants: cloned, stock_qty: totalStock, updated_at: now },
              idToken,
              ['variants', 'stock_qty', 'updated_at']
            ).catch(() => undefined);
          }
        }

        const customerUid =
          typeof existing.customer_user_id === 'string' ? existing.customer_user_id : null;
        if (customerUid) {
          const custDoc = await firestoreGetDoc<{
            notification_prefs_json?: string | null;
            notification_prefs?: unknown;
          }>('users', customerUid, idToken).catch(() => null);
          const prefs = parseNotificationPrefs(
            custDoc?.notification_prefs ?? custDoc?.notification_prefs_json
          );
          if (prefs.orderUpdates) {
            const notifId = `notif_st_${orderId}_${nextStatus}_${now}`;
            await firestoreSetDoc(
              `users/${encodeURIComponent(customerUid)}/notifications`,
              notifId,
              {
                id: notifId,
                user_id: customerUid,
                type: 'order_status',
                title: `Order ${String(existing.order_number || orderId)} updated`,
                message: note || `Order status updated to ${nextStatus.replace(/_/g, ' ')}.`,
                order_id: orderId,
                order_number: String(existing.order_number || ''),
                is_read: 0,
                read: false,
                read_at: null,
                created_at: now,
              },
              idToken
            ).catch(() => undefined);
          }
        }
        emitBoutiqueSyncEvent('orders');
        const serialized = serializeClientOrderDoc({ ...existing, ...patch });
        return {
          ok: true,
          data: { id: orderId, status: serialized.status, order: serialized, item: serialized } as unknown as T,
        };
      }

      if (cleanPath === '/api/admin/coupons') {
        if (upperMethod === 'GET') {
          const docs = await firestoreListDocs<Record<string, unknown>>('coupons', idToken);
          const items = docs
            .map((c) => serializeClientCouponDoc(c))
            .sort((a, b) => b.createdAt - a.createdAt);
          return { ok: true, data: { items } as unknown as T };
        }
        if (upperMethod === 'POST') {
          const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const description = typeof body.description === 'string' ? body.description.trim() : '';
          const discountType = body.discountType === 'flat_paise' ? 'flat_paise' : 'percent';
          const discountValue = Math.round(Number(body.discountValue ?? 0));
          if (!/^[A-Z0-9_-]{3,32}$/.test(code) || !title || !Number.isFinite(discountValue) || discountValue <= 0) {
            return {
              ok: false,
              status: 400,
              code: 'VALIDATION_ERROR',
              error: 'Provide a valid alphanumeric coupon code (3–32 chars), title, and discount value.',
            };
          }
          const now = Date.now();
          const id = `cpn_${code.toLowerCase()}`;
          const prev = await firestoreGetDoc<Record<string, unknown>>('coupons', id, idToken);
          const record: Record<string, unknown> = {
            id,
            code,
            title,
            description,
            discount_type: discountType,
            discount_value: discountValue,
            max_discount_paise:
              body.maxDiscountPaise !== undefined && body.maxDiscountPaise !== null && body.maxDiscountPaise !== ''
                ? Math.max(0, Math.round(Number(body.maxDiscountPaise)))
                : null,
            min_spend_paise: Math.max(0, Math.round(Number(body.minSpendPaise ?? 0) || 0)),
            usage_limit:
              body.usageLimit !== undefined && body.usageLimit !== null && body.usageLimit !== ''
                ? Math.max(1, Math.round(Number(body.usageLimit)))
                : null,
            used_count: Number(prev?.used_count || 0),
            active: body.active !== undefined ? (body.active ? 1 : 0) : 1,
            starts_at: body.startsAt ? Number(body.startsAt) : null,
            expires_at: body.expiresAt ? Number(body.expiresAt) : null,
            created_at: Number(prev?.created_at || now),
            updated_at: now,
          };
          await firestoreSetDoc('coupons', id, record, idToken);
          return { ok: true, data: { coupon: serializeClientCouponDoc(record) } as unknown as T };
        }
      }

      if (cleanPath.startsWith('/api/admin/coupons/')) {
        const id = decodeURIComponent(cleanPath.slice('/api/admin/coupons/'.length));
        if (upperMethod === 'DELETE') {
          await firestoreDeleteDoc('coupons', id, idToken);
          return { ok: true, data: { deletedId: id, ok: true } as unknown as T };
        }
        if (upperMethod === 'PUT' || upperMethod === 'PATCH') {
          const prev = await firestoreGetDoc<Record<string, unknown>>('coupons', id, idToken);
          const now = Date.now();
          const code =
            typeof body.code === 'string' && body.code.trim()
              ? body.code.trim().toUpperCase()
              : String(prev?.code || '');
          const record: Record<string, unknown> = {
            id,
            code,
            title: String(typeof body.title === 'string' ? body.title.trim() : prev?.title || ''),
            description: String(
              typeof body.description === 'string' ? body.description.trim() : prev?.description || ''
            ),
            discount_type:
              body.discountType === 'flat_paise' || body.discountType === 'percent'
                ? body.discountType
                : prev?.discount_type || 'percent',
            discount_value: Math.round(Number(body.discountValue ?? prev?.discount_value ?? 0)),
            max_discount_paise:
              body.maxDiscountPaise !== undefined
                ? body.maxDiscountPaise === null || body.maxDiscountPaise === ''
                  ? null
                  : Math.max(0, Math.round(Number(body.maxDiscountPaise)))
                : (prev?.max_discount_paise ?? null),
            min_spend_paise: Math.max(
              0,
              Math.round(Number(body.minSpendPaise ?? prev?.min_spend_paise ?? 0) || 0)
            ),
            usage_limit:
              body.usageLimit !== undefined
                ? body.usageLimit === null || body.usageLimit === ''
                  ? null
                  : Math.max(1, Math.round(Number(body.usageLimit)))
                : (prev?.usage_limit ?? null),
            used_count: Number(prev?.used_count || 0),
            active:
              body.active !== undefined ? (body.active ? 1 : 0) : (prev?.active ?? 1),
            starts_at: body.startsAt !== undefined ? body.startsAt : (prev?.starts_at ?? null),
            expires_at: body.expiresAt !== undefined ? body.expiresAt : (prev?.expires_at ?? null),
            created_at: Number(prev?.created_at || now),
            updated_at: now,
          };
          await firestoreSetDoc('coupons', id, record, idToken);
          return { ok: true, data: { coupon: serializeClientCouponDoc(record) } as unknown as T };
        }
      }

      if (cleanPath === '/api/admin/gift-cards') {
        if (upperMethod === 'GET') {
          const docs = await firestoreListDocs<Record<string, unknown>>('gift_cards', idToken);
          const items = docs
            .map((g) => serializeClientGiftCardDoc(g))
            .sort((a, b) => b.createdAt - a.createdAt);
          return { ok: true, data: { items } as unknown as T };
        }
        if (upperMethod === 'POST') {
          const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
          const initialBalancePaise = Math.round(Number(body.initialBalancePaise ?? 0));
          const balancePaise =
            body.balancePaise !== undefined ? Math.round(Number(body.balancePaise)) : initialBalancePaise;
          if (
            !/^[A-Z0-9_-]{4,36}$/.test(code) ||
            !Number.isFinite(initialBalancePaise) ||
            initialBalancePaise < 100 ||
            !Number.isFinite(balancePaise) ||
            balancePaise < 0
          ) {
            return {
              ok: false,
              status: 400,
              code: 'VALIDATION_ERROR',
              error: 'Provide a valid gift card code (4–36 chars) and positive INR balance.',
            };
          }
          const now = Date.now();
          const id = `gc_${code.toLowerCase()}`;
          const prev = await firestoreGetDoc<Record<string, unknown>>('gift_cards', id, idToken);
          const record: Record<string, unknown> = {
            id,
            code,
            recipient_email:
              typeof body.recipientEmail === 'string' ? body.recipientEmail.trim().toLowerCase() : '',
            note: typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '',
            initial_balance_paise: initialBalancePaise,
            balance_paise: balancePaise,
            active: body.active !== undefined ? (body.active ? 1 : 0) : 1,
            expires_at: body.expiresAt ? Number(body.expiresAt) : null,
            last_used_at: prev?.last_used_at ?? null,
            created_at: Number(prev?.created_at || now),
            updated_at: now,
          };
          await firestoreSetDoc('gift_cards', id, record, idToken);
          return { ok: true, data: { giftCard: serializeClientGiftCardDoc(record) } as unknown as T };
        }
      }

      if (cleanPath.startsWith('/api/admin/gift-cards/')) {
        const id = decodeURIComponent(cleanPath.slice('/api/admin/gift-cards/'.length));
        if (upperMethod === 'DELETE') {
          await firestoreDeleteDoc('gift_cards', id, idToken);
          return { ok: true, data: { deletedId: id, ok: true } as unknown as T };
        }
        if (upperMethod === 'PUT' || upperMethod === 'PATCH') {
          const prev = await firestoreGetDoc<Record<string, unknown>>('gift_cards', id, idToken);
          const now = Date.now();
          const record: Record<string, unknown> = {
            id,
            code:
              typeof body.code === 'string' && body.code.trim()
                ? body.code.trim().toUpperCase()
                : String(prev?.code || ''),
            recipient_email:
              typeof body.recipientEmail === 'string'
                ? body.recipientEmail.trim().toLowerCase()
                : String(prev?.recipient_email || ''),
            note:
              typeof body.note === 'string'
                ? body.note.trim().slice(0, 300)
                : String(prev?.note || ''),
            initial_balance_paise: Math.max(
              0,
              Math.round(Number(body.initialBalancePaise ?? prev?.initial_balance_paise ?? 0))
            ),
            balance_paise: Math.max(
              0,
              Math.round(Number(body.balancePaise ?? prev?.balance_paise ?? 0))
            ),
            active: body.active !== undefined ? (body.active ? 1 : 0) : (prev?.active ?? 1),
            expires_at: body.expiresAt !== undefined ? body.expiresAt : (prev?.expires_at ?? null),
            last_used_at: prev?.last_used_at ?? null,
            created_at: Number(prev?.created_at || now),
            updated_at: now,
          };
          await firestoreSetDoc('gift_cards', id, record, idToken);
          return { ok: true, data: { giftCard: serializeClientGiftCardDoc(record) } as unknown as T };
        }
      }

      if (cleanPath === '/api/admin/loyalty') {
        if (upperMethod === 'GET') {
          const doc = await firestoreGetDoc<{ data?: Partial<LoyaltyConfig> }>(
            'site_documents',
            'loyalty_config',
            idToken
          );
          return {
            ok: true,
            data: {
              config: mergeLoyaltyConfig(
                doc?.data ?? (doc as Partial<LoyaltyConfig> | null) ?? DEFAULT_LOYALTY_CONFIG
              ),
            } as unknown as T,
          };
        }
        if (upperMethod === 'PUT' || upperMethod === 'POST') {
          const payload = (
            body.config && typeof body.config === 'object' ? body.config : body
          ) as Partial<LoyaltyConfig>;
          const normalized = mergeLoyaltyConfig(payload);
          await firestoreSetDoc(
            'site_documents',
            'loyalty_config',
            {
              key: 'loyalty_config',
              data: normalized as unknown as Record<string, unknown>,
              updated_at: Date.now(),
            },
            idToken
          );
          return { ok: true, data: { config: normalized } as unknown as T };
        }
      }

      if (cleanPath === '/api/admin/activity' && upperMethod === 'GET') {
        const [usersDocs, orderDocs, msgDocs, cpnDocs, gcDocs] = await Promise.all([
          firestoreListDocs<{
            id: string;
            full_name?: string;
            email?: string | null;
            email_verified?: boolean;
            phone_e164?: string | null;
            phone_verified?: boolean;
            contact_phone?: string | null;
            notification_prefs_json?: string | null;
            notification_prefs?: unknown;
            deleted_at?: number | null;
            created_at?: number;
            updated_at?: number;
          }>('users', idToken).catch(() => []),
          firestoreListDocs<Record<string, unknown>>('orders', idToken).catch(() => []),
          firestoreListDocs<{
            id: string;
            sender_name?: string;
            sender_email?: string;
            subject?: string;
            message?: string;
            status?: string;
            created_at?: number;
          }>('contact_messages', idToken).catch(() => []),
          firestoreListDocs<Record<string, unknown>>('coupons', idToken).catch(() => []),
          firestoreListDocs<Record<string, unknown>>('gift_cards', idToken).catch(() => []),
        ]);

        const activeUserDocs = usersDocs.filter((u) => !u.deleted_at);
        const addrByUser = new Map<string, ReturnType<typeof serializeClientAddressDoc>[]>();
        await Promise.all(
          activeUserDocs.slice(0, 60).map(async (u) => {
            const addrDocs = await firestoreListDocs<Record<string, unknown>>(
              `users/${encodeURIComponent(u.id)}/addresses`,
              idToken
            ).catch(() => []);
            addrByUser.set(
              u.id,
              addrDocs
                .map((d) => serializeClientAddressDoc(d))
                .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt - a.updatedAt)
            );
          })
        );

        const users = activeUserDocs
          .map((u) => ({
            id: u.id,
            fullName: u.full_name || 'Member',
            email: u.email || '',
            phone: u.contact_phone || u.phone_e164 || null,
            verifiedPhone: u.phone_verified ? u.phone_e164 || null : null,
            notificationPrefs: parseNotificationPrefs(
              u.notification_prefs ?? u.notification_prefs_json
            ),
            addresses: addrByUser.get(u.id) || [],
            emailVerified: Boolean(u.email_verified),
            phoneVerified: Boolean(u.phone_verified),
            createdAt: Number(u.created_at || 0),
            updatedAt: Number(u.updated_at || u.created_at || 0),
          }))
          .sort((a, b) => b.createdAt - a.createdAt);

        const orders = orderDocs
          .map((o) => serializeClientOrderDoc(o))
          .sort((a, b) => b.createdAt - a.createdAt);

        const events: Array<{
          id: string;
          type: 'registration' | 'order' | 'enquiry' | 'return_request' | 'coupon_redemption' | 'gift_card';
          title: string;
          detail: string;
          actorLabel: string;
          refId?: string;
          status?: string;
          createdAt: number;
        }> = [];

        for (const u of users) {
          const identityLabel = u.email || u.verifiedPhone || u.phone || 'Customer';
          events.push({
            id: `reg_${u.id}`,
            type: 'registration',
            title: 'Customer Registered',
            detail: `${u.fullName} (${identityLabel})`,
            actorLabel: identityLabel,
            refId: u.id,
            status: u.emailVerified || u.phoneVerified ? 'verified' : 'pending',
            createdAt: u.createdAt,
          });
        }

        const returnRequests: Array<{
          orderId: string;
          orderNumber: string;
          customerName: string;
          customerEmail: string;
          totalPaise: number;
          request: OrderReturnRequest;
        }> = [];

        for (const ord of orders) {
          events.push({
            id: `ord_${ord.id}`,
            type: 'order',
            title: `Order ${ord.orderNumber}`,
            detail: `${ord.paymentStatus} · ${ord.fulfillmentStatus} · ₹${(ord.totalPaise / 100).toLocaleString('en-IN')}`,
            actorLabel: ord.customerEmail,
            refId: ord.id,
            status: ord.fulfillmentStatus,
            createdAt: ord.createdAt,
          });
          for (const rr of [ord.cancelRequest, ord.returnRequest]) {
            if (!rr) continue;
            returnRequests.push({
              orderId: ord.id,
              orderNumber: ord.orderNumber,
              customerName: ord.customerName,
              customerEmail: ord.customerEmail,
              totalPaise: ord.totalPaise,
              request: rr as OrderReturnRequest,
            });
            events.push({
              id: `ret_${rr.id || ord.id}_${rr.type}`,
              type: 'return_request',
              title: `${rr.type === 'cancel' ? 'Cancellation' : 'Return'} Request (${ord.orderNumber})`,
              detail: rr.reason,
              actorLabel: ord.customerEmail,
              refId: ord.id,
              status: rr.status,
              createdAt: rr.updatedAt || rr.requestedAt || ord.updatedAt,
            });
          }
          if (ord.couponCode) {
            events.push({
              id: `cpn_${ord.id}`,
              type: 'coupon_redemption',
              title: `Coupon ${ord.couponCode} Redeemed`,
              detail: `Saved ₹${((ord.discountPaise || 0) / 100).toLocaleString('en-IN')} on ${ord.orderNumber}`,
              actorLabel: ord.customerEmail,
              refId: ord.id,
              createdAt: ord.createdAt,
            });
          }
        }

        for (const m of msgDocs) {
          events.push({
            id: `msg_${m.id}`,
            type: 'enquiry',
            title: `Enquiry: ${m.subject || 'Boutique Enquiry'}`,
            detail: String(m.message || '').slice(0, 140),
            actorLabel: m.sender_email || m.sender_name || 'Guest',
            refId: m.id,
            status: m.status || 'unread',
            createdAt: Number(m.created_at || 0),
          });
        }

        events.sort((a, b) => b.createdAt - a.createdAt);

        return {
          ok: true,
          data: {
            users,
            returnRequests,
            events: events.slice(0, 60),
            coupons: cpnDocs.map((c) => serializeClientCouponDoc(c)),
            giftCards: gcDocs.map((g) => serializeClientGiftCardDoc(g)),
          } as unknown as T,
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
        ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
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
