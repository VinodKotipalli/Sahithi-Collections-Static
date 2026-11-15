import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { INITIAL_SEED_CATEGORIES, INITIAL_SEED_PRODUCTS, type ProductStatus } from './db.ts';
import type { FirebaseAppletConfig, RuntimeTargetEnv } from './env.ts';
import {
  slugifyProductTitle,
  StoreHttpError,
  type AdminBindingRow,
  type AdminOverviewData,
  type AdminProductQuery,
  type AdminProductRecord,
  type BoutiqueStore,
  type CategoryRow,
  type ContactMessageRow,
  type ContactMessageStatus,
  type EmailTokenRow,
  type LegacyPhoneOnlyAccount,
  type OrderItemRow,
  type OrderRow,
  type OrderWithItems,
  type PlaceOrderInput,
  type ProductAuditLogRow,
  type ProductImageRow,
  type ProductMediaRow,
  type ProductRow,
  type ProductVariantRow,
  type ProductWithParts,
  type SaveMediaFileInput,
  type SessionRow,
  type SiteSettingsData,
  type StorefrontContentData,
  type UserRow,
} from './store.ts';
import {
  DEFAULT_SITE_SETTINGS,
  DEFAULT_STOREFRONT_CONTENT,
  extractReferencedMediaFilenames,
  mergeSiteSettings,
  mergeStorefrontContent,
} from './storefront-defaults.ts';

const MEDIA_CHUNK_BYTES = 450_000;
const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export interface FirebaseRequestTokenBox {
  idToken?: string;
}

export const firestoreTokenStorage = new AsyncLocalStorage<FirebaseRequestTokenBox>();

export function getActiveFirestoreIdToken(): string | undefined {
  return firestoreTokenStorage.getStore()?.idToken;
}

export function setActiveFirestoreIdToken(idToken: string | undefined) {
  const box = firestoreTokenStorage.getStore();
  if (box) {
    box.idToken = idToken;
  }
}

export async function runWithFirestoreIdToken<T>(
  idToken: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  return firestoreTokenStorage.run({ idToken }, fn);
}

export interface VerifiedFirebaseTokenClaims {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
  authTimeMs: number;
  expiresAtMs: number;
}

export interface FirebaseSessionEnvelope {
  idToken: string;
  refreshToken: string;
  uid: string;
  email: string;
  lastReauthAt: number;
  csrfSecret: string;
  sessionId?: string;
  issuedAt?: number;
}

export function extractOobCode(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const fromUrl = parsed.searchParams.get('oobCode') || parsed.searchParams.get('token') || '';
      return fromUrl.trim();
    } catch {
      return '';
    }
  }
  return trimmed;
}

let cachedCerts: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getFirebasePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now < cachedCerts.expiresAt) {
    return cachedCerts.certs;
  }
  try {
    const res = await fetch(FIREBASE_CERTS_URL);
    if (!res.ok) {
      throw new Error(`Unable to fetch Google Firebase public keys (${res.status}).`);
    }
    const cacheControl = res.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    const maxAgeMs = maxAgeMatch ? Number.parseInt(maxAgeMatch[1], 10) * 1000 : 3600_000;
    const certs = (await res.json()) as Record<string, string>;
    cachedCerts = {
      certs,
      expiresAt: now + Math.max(60_000, maxAgeMs),
    };
    return certs;
  } catch (err) {
    if (cachedCerts) {
      return cachedCerts.certs;
    }
    throw err;
  }
}

export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string
): Promise<VerifiedFirebaseTokenClaims | null> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    return null;
  }

  let certs = await getFirebasePublicCerts();
  let certPem = certs[header.kid];
  if (!certPem) {
    cachedCerts = null;
    certs = await getFirebasePublicCerts();
    certPem = certs[header.kid];
  }
  if (!certPem) return null;

  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const signatureValid = verifier.verify(certPem, Buffer.from(sigB64, 'base64url'));
    if (!signatureValid) return null;
  } catch {
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);
  const authTime = Number(payload.auth_time || 0);
  const expectedIss = `https://securetoken.google.com/${projectId}`;

  if (
    payload.aud !== projectId ||
    payload.iss !== expectedIss ||
    typeof payload.sub !== 'string' ||
    !payload.sub.trim() ||
    exp <= nowSec ||
    iat > nowSec + 120 ||
    authTime > nowSec + 120
  ) {
    return null;
  }

  return {
    uid: payload.sub.trim(),
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '',
    emailVerified: Boolean(payload.email_verified),
    name: typeof payload.name === 'string' ? payload.name.trim() : '',
    authTimeMs: authTime * 1000,
    expiresAtMs: exp * 1000,
  };
}

function deriveEnvelopeKey(config: FirebaseAppletConfig): Buffer {
  const secretSeed =
    (process.env.SESSION_SECRET || '').trim() ||
    `sahithi-fb-envelope:${config.projectId}:${config.appId || 'web'}:${config.firestoreDatabaseId}`;
  return crypto.createHash('sha256').update(secretSeed, 'utf8').digest();
}

export function sealFirebaseSessionCookie(
  envelope: FirebaseSessionEnvelope,
  config: FirebaseAppletConfig
): string {
  const key = deriveEnvelopeKey(config);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function unsealFirebaseSessionCookie(
  token: string,
  config: FirebaseAppletConfig
): FirebaseSessionEnvelope | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const key = deriveEnvelopeKey(config);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString('utf8')) as Partial<FirebaseSessionEnvelope>;
    if (!parsed.idToken || !parsed.refreshToken || !parsed.uid || !parsed.email) {
      return null;
    }
      return {
        idToken: String(parsed.idToken),
        refreshToken: String(parsed.refreshToken),
        uid: String(parsed.uid),
        email: String(parsed.email).toLowerCase(),
        lastReauthAt: Number(parsed.lastReauthAt || Date.now()),
        csrfSecret:
          typeof parsed.csrfSecret === 'string' && parsed.csrfSecret
            ? parsed.csrfSecret
            : crypto.randomBytes(24).toString('base64url'),
        ...(typeof parsed.sessionId === 'string' && parsed.sessionId
          ? { sessionId: parsed.sessionId }
          : {}),
        ...(typeof parsed.issuedAt === 'number' && Number.isFinite(parsed.issuedAt)
          ? { issuedAt: parsed.issuedAt }
          : {}),
      };
    } catch {
      return null;
    }
  }

export class FirebaseAuthApiError extends Error {
  readonly firebaseCode: string;
  readonly rawFirebaseCode: string;
  readonly httpStatus: number;

  constructor(
    firebaseCode: string,
    message: string,
    httpStatus = 400,
    rawFirebaseCode?: string
  ) {
    super(message);
    this.firebaseCode = firebaseCode;
    this.rawFirebaseCode = rawFirebaseCode || firebaseCode;
    this.httpStatus = httpStatus;
  }
}

export interface EmailPasswordProviderStatus {
  enabled: boolean;
  checkedAt: number;
  rawCode: string | null;
}

const providerStatusCache = new Map<string, EmailPasswordProviderStatus>();

function isProviderDisabledCode(rawCode: string): boolean {
  const clean = rawCode.split(':')[0].trim();
  return (
    clean === 'OPERATION_NOT_ALLOWED' ||
    clean === 'PASSWORD_LOGIN_DISABLED' ||
    clean === 'ADMIN_ONLY_OPERATION'
  );
}

export function setCachedEmailPasswordStatus(apiKey: string, enabled: boolean, rawCode: string | null) {
  providerStatusCache.set(apiKey, {
    enabled,
    checkedAt: Date.now(),
    rawCode,
  });
}

export async function checkFirebaseEmailPasswordStatus(
  apiKey: string,
  options: { forceRefresh?: boolean; bypassNegativeCache?: boolean } = {}
): Promise<EmailPasswordProviderStatus> {
  const now = Date.now();
  const cached = providerStatusCache.get(apiKey);
  const ttlMs = cached?.enabled ? 60_000 : 5_000;
  const useCache =
    !options.forceRefresh &&
    cached &&
    now - cached.checkedAt < ttlMs &&
    !(options.bypassNegativeCache && !cached.enabled);
  if (useCache) {
    return cached;
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: '__sahithi_provider_probe__@probe.invalid',
          password: 'ProbeCheckPassword#2026',
          returnSecureToken: false,
        }),
      }
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (res.ok) {
      const result = { enabled: true, checkedAt: now, rawCode: null };
      providerStatusCache.set(apiKey, result);
      return result;
    }
    const rawCode = String(data.error?.message || 'AUTH_ERROR').split(':')[0].trim();
    const disabled = isProviderDisabledCode(rawCode);
    const result = {
      enabled: !disabled,
      checkedAt: now,
      rawCode: disabled ? rawCode : null,
    };
    providerStatusCache.set(apiKey, result);
    return result;
  } catch {
    const result = { enabled: false, checkedAt: now, rawCode: 'NETWORK_ERROR' };
    providerStatusCache.set(apiKey, result);
    return result;
  }
}

export function mapFirebaseAuthError(rawCode: string): {
  code: string;
  message: string;
  status: number;
} {
  const clean = rawCode.split(':')[0].trim();
  switch (clean) {
    case 'OPERATION_NOT_ALLOWED':
    case 'PASSWORD_LOGIN_DISABLED':
    case 'ADMIN_ONLY_OPERATION':
      return {
        code: 'AUTH_PROVIDER_DISABLED',
        message:
          'Email and password authentication is currently disabled in Firebase Console for this project. Enable Authentication → Sign-in method → Email/Password to restore signup, login, and password reset.',
        status: 503,
      };
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS':
      return {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
        status: 401,
      };
    case 'EMAIL_EXISTS':
      return {
        code: 'EMAIL_EXISTS',
        message: 'An account with this email address already exists.',
        status: 409,
      };
    case 'INVALID_EMAIL':
      return {
        code: 'VALIDATION_ERROR',
        message: 'Please enter a valid email address.',
        status: 400,
      };
    case 'MISSING_PASSWORD':
      return {
        code: 'VALIDATION_ERROR',
        message: 'Please enter your password.',
        status: 400,
      };
    case 'USER_DISABLED':
      return {
        code: 'USER_DISABLED',
        message: 'This account has been disabled.',
        status: 403,
      };
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
    case 'RESET_PASSWORD_EXCEED_LIMIT':
      return {
        code: 'RATE_LIMITED',
        message: 'Too many authentication attempts. Please wait a few minutes and try again.',
        status: 429,
      };
    case 'QUOTA_EXCEEDED':
      return {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Authentication email quota was temporarily exceeded. Please wait and try again later.',
        status: 503,
      };
    case 'INVALID_OOB_CODE':
    case 'EXPIRED_OOB_CODE':
    case 'MISSING_OOB_CODE':
      return {
        code: 'INVALID_TOKEN',
        message:
          'This verification or reset link is invalid, expired, or has already been used. Request a fresh link if needed.',
        status: 400,
      };
    case 'UNAUTHORIZED_DOMAIN':
    case 'UNAUTHORIZED_CONTINUE_URI':
    case 'INVALID_CONTINUE_URI':
      return {
        code: 'UNAUTHORIZED_DOMAIN',
        message:
          'This application domain is not authorized in Firebase Authentication callback settings.',
        status: 400,
      };
    case 'USER_NOT_FOUND':
    case 'INVALID_ID_TOKEN':
    case 'TOKEN_EXPIRED':
    case 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN':
      return {
        code: 'SESSION_EXPIRED',
        message: 'Your authentication session expired. Please sign in again.',
        status: 401,
      };
    case 'WEAK_PASSWORD':
      return {
        code: 'WEAK_PASSWORD',
        message: 'Password must be at least 8 characters long.',
        status: 400,
      };
    default:
      return {
        code: clean || 'AUTH_FAILED',
        message: 'Authentication service failed to complete this request. Please try again shortly.',
        status: 502,
      };
  }
}

async function callIdentityToolkit<T>(
  apiKey: string,
  endpoint: string,
  payload: Record<string, unknown>
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : 'Network error';
    console.error(
      `[firebase-auth] endpoint=${endpoint} networkError=${JSON.stringify(msg)}`
    );
    throw new FirebaseAuthApiError(
      'AUTH_SERVICE_UNREACHABLE',
      'Unable to reach the authentication service. Please try again shortly.',
      503,
      'NETWORK_ERROR'
    );
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errObj = data.error as { message?: string } | undefined;
    const rawCode = String(errObj?.message || 'AUTH_ERROR');
    const cleanRaw = rawCode.split(':')[0].trim();
    const mapped = mapFirebaseAuthError(rawCode);
    if (isProviderDisabledCode(cleanRaw)) {
      setCachedEmailPasswordStatus(apiKey, false, cleanRaw);
    } else if (
      endpoint === 'accounts:signInWithPassword' &&
      (cleanRaw === 'EMAIL_NOT_FOUND' ||
        cleanRaw === 'INVALID_PASSWORD' ||
        cleanRaw === 'INVALID_LOGIN_CREDENTIALS')
    ) {
      setCachedEmailPasswordStatus(apiKey, true, null);
    }
    console.error(
      `[firebase-auth] endpoint=${endpoint} status=${res.status} rawCode=${cleanRaw} mappedCode=${mapped.code}`
    );
    throw new FirebaseAuthApiError(mapped.code, mapped.message, mapped.status, cleanRaw);
  }

  if (endpoint === 'accounts:signInWithPassword' || endpoint === 'accounts:signUp') {
    setCachedEmailPasswordStatus(apiKey, true, null);
  }
  return data as T;
}

export async function firebaseSignInWithPassword(
  apiKey: string,
  email: string,
  password: string
): Promise<{
  idToken: string;
  refreshToken: string;
  localId: string;
  email: string;
  displayName: string;
}> {
  const data = await callIdentityToolkit<{
    idToken: string;
    refreshToken: string;
    localId: string;
    email: string;
    displayName?: string;
  }>(apiKey, 'accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    localId: data.localId,
    email: (data.email || email).toLowerCase(),
    displayName: data.displayName || '',
  };
}

export async function firebaseSignUpWithPassword(
  apiKey: string,
  email: string,
  password: string,
  displayName?: string
): Promise<{
  idToken: string;
  refreshToken: string;
  localId: string;
  email: string;
}> {
  const created = await callIdentityToolkit<{
    idToken: string;
    refreshToken: string;
    localId: string;
    email: string;
  }>(apiKey, 'accounts:signUp', {
    email,
    password,
    returnSecureToken: true,
  });

  if (displayName && displayName.trim()) {
    await callIdentityToolkit(apiKey, 'accounts:update', {
      idToken: created.idToken,
      displayName: displayName.trim(),
      returnSecureToken: false,
    }).catch(() => undefined);
  }

  return {
    idToken: created.idToken,
    refreshToken: created.refreshToken,
    localId: created.localId,
    email: (created.email || email).toLowerCase(),
  };
}

export async function firebaseSendVerifyEmail(
  apiKey: string,
  idToken: string,
  continueUrl: string
): Promise<{ acceptedByProvider: true; continueUrlFallbackUsed: boolean }> {
  try {
    await callIdentityToolkit(apiKey, 'accounts:sendOobCode', {
      requestType: 'VERIFY_EMAIL',
      idToken,
      continueUrl,
    });
    return { acceptedByProvider: true, continueUrlFallbackUsed: false };
  } catch (err) {
    if (
      err instanceof FirebaseAuthApiError &&
      (err.rawFirebaseCode === 'UNAUTHORIZED_CONTINUE_URI' ||
        err.rawFirebaseCode === 'INVALID_CONTINUE_URI')
    ) {
      let origin = 'unknown';
      try {
        origin = new URL(continueUrl).origin;
      } catch {
        // Ignore malformed continueUrl
      }
      console.warn(
        `[firebase-auth] continueUrl origin ${origin} rejected (${err.rawFirebaseCode}) for VERIFY_EMAIL; retrying with project default authDomain handler.`
      );
      await callIdentityToolkit(apiKey, 'accounts:sendOobCode', {
        requestType: 'VERIFY_EMAIL',
        idToken,
      });
      return { acceptedByProvider: true, continueUrlFallbackUsed: true };
    }
    throw err;
  }
}

export async function firebaseConfirmVerifyEmailOobCode(
  apiKey: string,
  oobCode: string
): Promise<{ localId: string; email: string; emailVerified: boolean; displayName: string }> {
  const data = await callIdentityToolkit<{
    localId: string;
    email: string;
    emailVerified?: boolean;
    displayName?: string;
  }>(apiKey, 'accounts:update', { oobCode });
  return {
    localId: data.localId,
    email: (data.email || '').toLowerCase(),
    emailVerified: Boolean(data.emailVerified ?? true),
    displayName: data.displayName || '',
  };
}

export async function firebaseSendPasswordReset(
  apiKey: string,
  email: string,
  continueUrl: string
): Promise<{ acceptedByProvider: true; continueUrlFallbackUsed: boolean }> {
  try {
    await callIdentityToolkit(apiKey, 'accounts:sendOobCode', {
      requestType: 'PASSWORD_RESET',
      email,
      continueUrl,
    });
    return { acceptedByProvider: true, continueUrlFallbackUsed: false };
  } catch (err) {
    if (
      err instanceof FirebaseAuthApiError &&
      (err.rawFirebaseCode === 'UNAUTHORIZED_CONTINUE_URI' ||
        err.rawFirebaseCode === 'INVALID_CONTINUE_URI')
    ) {
      let origin = 'unknown';
      try {
        origin = new URL(continueUrl).origin;
      } catch {
        // Ignore malformed continueUrl
      }
      console.warn(
        `[firebase-auth] continueUrl origin ${origin} rejected (${err.rawFirebaseCode}) for PASSWORD_RESET; retrying with project default authDomain handler.`
      );
      await callIdentityToolkit(apiKey, 'accounts:sendOobCode', {
        requestType: 'PASSWORD_RESET',
        email,
      });
      return { acceptedByProvider: true, continueUrlFallbackUsed: true };
    }
    throw err;
  }
}

export async function firebaseConfirmPasswordResetOobCode(
  apiKey: string,
  oobCode: string,
  newPassword: string
): Promise<{ email: string }> {
  const data = await callIdentityToolkit<{ email: string }>(apiKey, 'accounts:resetPassword', {
    oobCode,
    newPassword,
  });
  return { email: (data.email || '').toLowerCase() };
}

export async function firebaseUpdatePassword(
  apiKey: string,
  idToken: string,
  newPassword: string
): Promise<{ idToken: string; refreshToken: string }> {
  const data = await callIdentityToolkit<{ idToken: string; refreshToken: string }>(
    apiKey,
    'accounts:update',
    {
      idToken,
      password: newPassword,
      returnSecureToken: true,
    }
  );
  return { idToken: data.idToken, refreshToken: data.refreshToken };
}

export async function firebaseUpdateDisplayName(
  apiKey: string,
  idToken: string,
  displayName: string
): Promise<void> {
  await callIdentityToolkit(apiKey, 'accounts:update', {
    idToken,
    displayName,
    returnSecureToken: false,
  });
}

export async function firebaseRefreshIdToken(
  apiKey: string,
  refreshToken: string
): Promise<{ idToken: string; refreshToken: string; uid: string }> {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    }
  );
  const data = (await res.json().catch(() => ({}))) as {
    id_token?: string;
    refresh_token?: string;
    user_id?: string;
  };
  if (!res.ok || !data.id_token || !data.refresh_token) {
    throw new FirebaseAuthApiError('SESSION_EXPIRED', 'Your session expired. Please sign in again.', 401);
  }
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    uid: data.user_id || '',
  };
}

export async function firebaseLookupUser(
  apiKey: string,
  idToken: string
): Promise<{
  localId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
} | null> {
  try {
    const data = await callIdentityToolkit<{
      users?: Array<{
        localId: string;
        email?: string;
        emailVerified?: boolean;
        displayName?: string;
      }>;
    }>(apiKey, 'accounts:lookup', { idToken });
    const u = data.users?.[0];
    if (!u) return null;
    return {
      localId: u.localId,
      email: (u.email || '').toLowerCase(),
      emailVerified: Boolean(u.emailVerified),
      displayName: u.displayName || '',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firestore REST v1 Serialization Helpers
// ---------------------------------------------------------------------------

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { bytesValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

function toFsValue(val: unknown): FsValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return { bytesValue: Buffer.from(val).toString('base64') };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFsValue(item)) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FsValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFsValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function toFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      fields[k] = toFsValue(v);
    }
  }
  return fields;
}

function fromFsValue(val: FsValue | undefined): unknown {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return val.stringValue;
  if ('bytesValue' in val) return Buffer.from(val.bytesValue, 'base64');
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map((item) => fromFsValue(item));
  }
  if ('mapValue' in val) {
    return fromFsFields(val.mapValue.fields || {});
  }
  return null;
}

function fromFsFields(fields: Record<string, FsValue> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fromFsValue(v);
  }
  return out;
}

interface FsDocumentResponse {
  name: string;
  fields?: Record<string, FsValue>;
  createTime?: string;
  updateTime?: string;
}

// ---------------------------------------------------------------------------
// Data mappers matching FirestoreBoutiqueStore structure
// ---------------------------------------------------------------------------

interface FirestoreProductDoc {
  id: string;
  slug: string;
  title: string;
  description: string;
  fabric_note: string;
  category: string;
  sku: string;
  price_paise: number;
  compare_at_paise: number | null;
  stock_qty: number;
  low_stock_threshold: number;
  featured: boolean;
  status: ProductStatus;
  colors_json: string;
  sizes_json: string;
  version: number;
  published_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  variants: ProductVariantRow[];
  images: Array<{
    id: string;
    product_id: string;
    media_id: string | null;
    url: string;
    alt_text: string;
    is_cover: boolean;
    position: number;
    created_at: number;
  }>;
  variant_skus: string[];
  image_urls: string[];
}

interface FirestoreOrderDoc {
  id: string;
  order_number: string;
  customer_user_id: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  shipping_address: string;
  status: string;
  subtotal_paise: number;
  total_paise: number;
  currency: string;
  created_at: number;
  product_ids: string[];
  items: OrderItemRow[];
}

function fromFirestoreProduct(doc: FirestoreProductDoc): ProductWithParts {
  const product: ProductRow = {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    description: doc.description || '',
    fabric_note: doc.fabric_note || '',
    category: doc.category,
    sku: doc.sku,
    price_paise: Number(doc.price_paise),
    compare_at_paise:
      typeof doc.compare_at_paise === 'number' ? doc.compare_at_paise : null,
    stock_qty: Number(doc.stock_qty),
    low_stock_threshold: Number(doc.low_stock_threshold ?? 5),
    featured: doc.featured ? 1 : 0,
    status: doc.status,
    colors_json: doc.colors_json || '[]',
    sizes_json: doc.sizes_json || '[]',
    version: Number(doc.version || 1),
    published_at: doc.published_at ?? null,
    archived_at: doc.archived_at ?? null,
    created_at: Number(doc.created_at || 0),
    updated_at: Number(doc.updated_at || 0),
  };

  const variants: ProductVariantRow[] = (doc.variants || [])
    .map((v, idx) => ({
      id: String(v.id),
      product_id: doc.id,
      sku: String(v.sku),
      size: String(v.size),
      color_name: String(v.color_name),
      color_hex: String(v.color_hex),
      price_paise: Number(v.price_paise),
      compare_at_paise:
        typeof v.compare_at_paise === 'number' ? v.compare_at_paise : null,
      stock_qty: Number(v.stock_qty),
      position: Number(v.position ?? idx),
    }))
    .sort((a, b) => a.position - b.position);

  const images: ProductImageRow[] = (doc.images || [])
    .map((img, idx) => ({
      id: String(img.id),
      product_id: doc.id,
      media_id: img.media_id ?? null,
      url: String(img.url),
      alt_text: String(img.alt_text || ''),
      is_cover: img.is_cover ? 1 : 0,
      position: Number(img.position ?? idx),
      created_at: Number(img.created_at || doc.created_at),
    }))
    .sort((a, b) => a.position - b.position);

  return { product, variants, images };
}

function buildSeedStarterProductDoc(
  p: (typeof INITIAL_SEED_PRODUCTS)[number],
  idx: number,
  now: number
): FirestoreProductDoc {
  const productId = p.id || crypto.randomUUID();
  const slug = p.slug || slugifyProductTitle(p.title);
  const sku = p.sku || `SC-SEED-${String(idx + 1).padStart(3, '0')}`;
  const pricePaise = Math.round(p.priceInr * 100);
  const compareAtPaise = p.compareAtInr ? Math.round(p.compareAtInr * 100) : null;
  const baseTime = now - idx * 60_000;
  const variantStock = Number(p.defaultVariantStock || 8);

  const variants: ProductVariantRow[] = [];
  let pos = 0;
  for (const size of p.sizes) {
    for (const color of p.colors) {
      variants.push({
        id: crypto.randomUUID(),
        product_id: productId,
        sku: `${sku}-${size.replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'SZ'}-${pos + 1}`,
        size,
        color_name: color.name,
        color_hex: color.hex,
        price_paise: pricePaise,
        compare_at_paise: compareAtPaise,
        stock_qty: variantStock,
        position: pos,
      });
      pos += 1;
    }
  }

  const images = p.images.map((img, imgIdx) => ({
    id: crypto.randomUUID(),
    product_id: productId,
    media_id: null,
    url: img.url,
    alt_text: img.alt,
    is_cover: imgIdx === 0,
    position: imgIdx,
    created_at: baseTime,
  }));

  return {
    id: productId,
    slug,
    title: p.title,
    description: p.description,
    fabric_note: p.fabricNote,
    category: p.category,
    sku,
    price_paise: pricePaise,
    compare_at_paise: compareAtPaise,
    stock_qty: variants.reduce((s, v) => s + v.stock_qty, 0),
    low_stock_threshold: 5,
    featured: p.featured,
    status: 'published',
    colors_json: JSON.stringify(p.colors),
    sizes_json: JSON.stringify(p.sizes),
    version: 1,
    published_at: baseTime,
    archived_at: null,
    created_at: baseTime,
    updated_at: baseTime,
    variants,
    images,
    variant_skus: variants.map((v) => v.sku),
    image_urls: images.map((i) => i.url),
  };
}

function buildStarterReadCategories(now: number): CategoryRow[] {
  return INITIAL_SEED_CATEGORIES.map((c, idx) => ({
    id: c.id,
    name: c.name,
    slug: slugifyProductTitle(c.name),
    subtitle: c.subtitle,
    image_url: c.imageUrl,
    alt_text: c.altText,
    position: idx,
    created_at: now - idx * 1000,
    updated_at: now - idx * 1000,
  }));
}

function buildStarterReadProducts(now: number): ProductWithParts[] {
  return INITIAL_SEED_PRODUCTS.map((p, idx) =>
    fromFirestoreProduct(buildSeedStarterProductDoc(p, idx, now))
  );
}

// ---------------------------------------------------------------------------
// FirestoreRestStore implementing BoutiqueStore via Firestore REST API + Rules
// ---------------------------------------------------------------------------

export interface FirestoreRestStoreOptions {
  config: FirebaseAppletConfig & { apiKey: string };
  namespace: string;
  targetEnv: RuntimeTargetEnv;
  ownerEmail: string;
}

export class FirestoreRestStore implements BoutiqueStore {
  readonly backend = 'firestore' as const;
  readonly isPersistent = true;
  readonly locationLabel: string;
  readonly targetEnv: RuntimeTargetEnv;
  readonly config: FirebaseAppletConfig & { apiKey: string };
  readonly ownerEmail: string;
  private readonly envRelPath: string;
  private readonly docBaseUrl: string;
  private readonly dbRootResource: string;

  constructor(options: FirestoreRestStoreOptions) {
    this.config = options.config;
    this.targetEnv = options.targetEnv;
    this.ownerEmail = options.ownerEmail.trim().toLowerCase();
    this.envRelPath = `environments/${options.namespace}`;
    this.dbRootResource = `projects/${options.config.projectId}/databases/${options.config.firestoreDatabaseId}/documents`;
    this.docBaseUrl = `https://firestore.googleapis.com/v1/${this.dbRootResource}`;
    this.locationLabel = `firestore://${options.config.projectId}/${options.config.firestoreDatabaseId}/environments/${options.namespace}`;
  }

  private authHeaders(bearerOverride?: string): Record<string, string> {
    const token = bearerOverride ?? getActiveFirestoreIdToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private docUrl(relPath: string): string {
    return `${this.docBaseUrl}/${this.envRelPath}/${relPath}?key=${encodeURIComponent(this.config.apiKey)}`;
  }

  private async getDoc(
    relPath: string,
    bearerOverride?: string
  ): Promise<{ id: string; data: Record<string, unknown>; updateTime?: string } | null> {
    const res = await fetch(this.docUrl(relPath), {
      method: 'GET',
      headers: this.authHeaders(bearerOverride),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new StoreHttpError(
        res.status === 403 ? 403 : 500,
        res.status === 403 ? 'FORBIDDEN' : 'FIRESTORE_ERROR',
        `Firestore read failed (${res.status}): ${errText.slice(0, 180)}`
      );
    }
    const json = (await res.json()) as FsDocumentResponse;
    const id = json.name.split('/').pop() || relPath.split('/').pop() || '';
    return {
      id,
      data: fromFsFields(json.fields),
      updateTime: json.updateTime,
    };
  }

  private async setDoc(
    relPath: string,
    data: Record<string, unknown>,
    opts: { updateTime?: string; bearerOverride?: string } = {}
  ): Promise<void> {
    let url = this.docUrl(relPath);
    if (opts.updateTime) {
      url += `&currentDocument.updateTime=${encodeURIComponent(opts.updateTime)}`;
    }
    const res = await fetch(url, {
      method: 'PATCH',
      headers: this.authHeaders(opts.bearerOverride),
      body: JSON.stringify({ fields: toFsFields(data) }),
    });
    if (!res.ok) {
      if (res.status === 409 || res.status === 412) {
        throw new StoreHttpError(409, 'VERSION_CONFLICT', 'Document was modified concurrently.');
      }
      const errText = await res.text().catch(() => '');
      throw new StoreHttpError(
        res.status === 403 ? 403 : 500,
        res.status === 403 ? 'FORBIDDEN' : 'FIRESTORE_ERROR',
        `Firestore write failed (${res.status}): ${errText.slice(0, 180)}`
      );
    }
  }

  private async patchDoc(
    relPath: string,
    patch: Record<string, unknown>,
    bearerOverride?: string
  ): Promise<void> {
    const params = new URLSearchParams({ key: this.config.apiKey });
    for (const key of Object.keys(patch)) {
      params.append('updateMask.fieldPaths', key);
    }
    const res = await fetch(
      `${this.docBaseUrl}/${this.envRelPath}/${relPath}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: this.authHeaders(bearerOverride),
        body: JSON.stringify({ fields: toFsFields(patch) }),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new StoreHttpError(
        res.status === 403 ? 403 : 500,
        res.status === 403 ? 'FORBIDDEN' : 'FIRESTORE_ERROR',
        `Firestore update failed (${res.status}): ${errText.slice(0, 180)}`
      );
    }
  }

  private async deleteDoc(relPath: string, bearerOverride?: string): Promise<void> {
    const res = await fetch(this.docUrl(relPath), {
      method: 'DELETE',
      headers: this.authHeaders(bearerOverride),
    });
    if (res.status === 404) return;
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new StoreHttpError(
        res.status === 403 ? 403 : 500,
        res.status === 403 ? 'FORBIDDEN' : 'FIRESTORE_ERROR',
        `Firestore delete failed (${res.status}): ${errText.slice(0, 180)}`
      );
    }
  }

  private async runQuery(
    collectionId: string,
    options: {
      parentRelPath?: string;
      where?: Record<string, unknown>;
      limit?: number;
      bearerOverride?: string;
    } = {}
  ): Promise<Array<{ id: string; data: Record<string, unknown>; updateTime?: string }>> {
    const parentUrl = options.parentRelPath
      ? `${this.docBaseUrl}/${this.envRelPath}/${options.parentRelPath}:runQuery?key=${encodeURIComponent(this.config.apiKey)}`
      : `${this.docBaseUrl}/${this.envRelPath}:runQuery?key=${encodeURIComponent(this.config.apiKey)}`;

    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId }],
    };
    if (options.where) {
      structuredQuery.where = options.where;
    }
    if (options.limit !== undefined) {
      structuredQuery.limit = options.limit;
    }

    const res = await fetch(parentUrl, {
      method: 'POST',
      headers: this.authHeaders(options.bearerOverride),
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new StoreHttpError(
        res.status === 403 ? 403 : 500,
        res.status === 403 ? 'FORBIDDEN' : 'FIRESTORE_ERROR',
        `Firestore query failed (${res.status}): ${errText.slice(0, 180)}`
      );
    }

    const rows = (await res.json()) as Array<{ document?: FsDocumentResponse }>;
    const results: Array<{ id: string; data: Record<string, unknown>; updateTime?: string }> = [];
    for (const row of rows) {
      if (!row.document) continue;
      const id = row.document.name.split('/').pop() || '';
      results.push({
        id,
        data: fromFsFields(row.document.fields),
        updateTime: row.document.updateTime,
      });
    }
    return results;
  }

  private async commitBatch(
    writes: Array<Record<string, unknown>>,
    bearerOverride?: string
  ): Promise<void> {
    if (writes.length === 0) return;
    const res = await fetch(
      `${this.docBaseUrl}:commit?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: 'POST',
        headers: this.authHeaders(bearerOverride),
        body: JSON.stringify({ writes }),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new StoreHttpError(
        res.status === 403 ? 403 : 500,
        res.status === 403 ? 'FORBIDDEN' : 'FIRESTORE_ERROR',
        `Firestore batch commit failed (${res.status}): ${errText.slice(0, 180)}`
      );
    }
  }

  async verifyConnectivity(): Promise<void> {
    await this.runQuery('categories', { limit: 1 });
  }

  async checkEmailPasswordAuthStatus(
    options: { forceRefresh?: boolean; bypassNegativeCache?: boolean } = {}
  ): Promise<EmailPasswordProviderStatus> {
    return checkFirebaseEmailPasswordStatus(this.config.apiKey, options);
  }

  async close(): Promise<void> {
    // Stateless HTTPS REST client
  }

  // -------------------------------------------------------------------------
  // Owner metadata for session revocation across password rotations
  // -------------------------------------------------------------------------

  async getOwnerMeta(): Promise<{ revokedBefore: number } | null> {
    const doc = await this.getDoc('site_documents/owner_meta').catch(() => null);
    if (!doc) return null;
    return {
      revokedBefore: Number(doc.data.revoked_before || 0),
    };
  }

  async setOwnerSessionRevokedBefore(timestampMs: number): Promise<void> {
    await this.setDoc('site_documents/owner_meta', {
      key: 'owner_meta',
      revoked_before: timestampMs,
      updated_at: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Users (backed by Firebase Auth + Firestore profile document)
  // -------------------------------------------------------------------------

  async getUserById(id: string): Promise<UserRow | null> {
    const doc = await this.getDoc(`users/${id}`).catch(() => null);
    if (!doc) return null;
    return {
      id: String(doc.data.id || doc.id),
      full_name: String(doc.data.full_name || ''),
      email: typeof doc.data.email === 'string' ? doc.data.email : null,
      email_verified: doc.data.email_verified ? 1 : 0,
      password_hash: 'firebase-managed',
      phone_e164: typeof doc.data.phone_e164 === 'string' ? doc.data.phone_e164 : null,
      phone_verified: doc.data.phone_verified ? 1 : 0,
      created_at: Number(doc.data.created_at || 0),
      updated_at: Number(doc.data.updated_at || 0),
    };
  }

  async syncVerifiedUserProfile(input: {
    id: string;
    fullName: string;
    email: string;
    emailVerified: boolean;
  }): Promise<UserRow> {
    const existing = await this.getUserById(input.id);
    const now = Date.now();
    const safeInputName = input.fullName.trim().length >= 2 ? input.fullName.trim().slice(0, 100) : 'Member';
    const row: Record<string, unknown> = {
      id: input.id,
      full_name: existing?.full_name && existing.full_name.length >= 2 ? existing.full_name : safeInputName,
      email: input.email.toLowerCase(),
      email_verified: Boolean(input.emailVerified),
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    await this.setDoc(`users/${input.id}`, row);
    return {
      id: input.id,
      full_name: String(row.full_name),
      email: String(row.email),
      email_verified: row.email_verified ? 1 : 0,
      password_hash: 'firebase-managed',
      phone_e164: null,
      phone_verified: 0,
      created_at: Number(row.created_at),
      updated_at: now,
    };
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const clean = email.trim().toLowerCase();
    const docs = await this.runQuery('users', {
      where: {
        fieldFilter: {
          field: { fieldPath: 'email' },
          op: 'EQUAL',
          value: { stringValue: clean },
        },
      },
      limit: 1,
    }).catch(() => []);
    if (!docs[0]) return null;
    const d = docs[0].data;
    return {
      id: String(d.id || docs[0].id),
      full_name: String(d.full_name || ''),
      email: typeof d.email === 'string' ? d.email : null,
      email_verified: d.email_verified ? 1 : 0,
      password_hash: 'firebase-managed',
      phone_e164: null,
      phone_verified: 0,
      created_at: Number(d.created_at || 0),
      updated_at: Number(d.updated_at || 0),
    };
  }

  async isEmailTakenByOtherUser(): Promise<boolean> {
    return false;
  }

  async createPendingEmailUser(): Promise<UserRow> {
    throw new Error('Use Firebase Auth endpoints when running in firebase_managed mode.');
  }

  async updatePendingEmailUser(): Promise<UserRow | null> {
    return null;
  }

  async markUserEmailVerified(userId: string, now: number): Promise<UserRow> {
    await this.patchDoc(`users/${userId}`, { email_verified: true, updated_at: now });
    const updated = await this.getUserById(userId);
    if (!updated) throw new Error('User not found.');
    return updated;
  }

  async linkVerifiedEmailToUser(userId: string, newEmail: string, now: number): Promise<UserRow> {
    await this.patchDoc(`users/${userId}`, {
      email: newEmail.toLowerCase(),
      email_verified: true,
      updated_at: now,
    });
    const updated = await this.getUserById(userId);
    if (!updated) throw new Error('User not found.');
    return updated;
  }

  async updateUserFullName(userId: string, fullName: string, now: number): Promise<UserRow> {
    await this.patchDoc(`users/${userId}`, {
      full_name: fullName,
      updated_at: now,
    });
    const updated = await this.getUserById(userId);
    if (!updated) throw new Error('User not found.');
    return updated;
  }

  async updateUserPasswordHash(): Promise<void> {
    // Managed by Firebase Auth
  }

  async listLegacyPhoneOnlyAccounts(): Promise<LegacyPhoneOnlyAccount[]> {
    return [];
  }

  // Sessions are verified via Google-signed Firebase ID Token in HttpOnly cookie
  async getActiveSessionByTokenHash(): Promise<SessionRow | null> {
    return null;
  }

  async createSession(session: SessionRow): Promise<SessionRow> {
    return session;
  }

  async updateSessionReauth(): Promise<void> {}
  async revokeSession(): Promise<void> {}
  async revokeUserSessions(): Promise<void> {}

  async createEmailToken(params: {
    id: string;
    userId: string;
    purpose: EmailTokenRow['purpose'];
    targetEmail: string;
    tokenHash: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<EmailTokenRow> {
    return {
      id: params.id,
      user_id: params.userId,
      purpose: params.purpose,
      target_email: params.targetEmail,
      token_hash: params.tokenHash,
      expires_at: params.expiresAt,
      consumed_at: null,
      created_at: params.createdAt,
    };
  }

  async deleteEmailToken(): Promise<void> {}
  async getLatestVerifyEmailTokenTimestamp(): Promise<number | null> {
    return null;
  }
  async getEmailTokenByHash(): Promise<EmailTokenRow | null> {
    return null;
  }
  async consumeEmailToken(): Promise<boolean> {
    return false;
  }

  async getStoredAdminBinding(): Promise<AdminBindingRow | null> {
    const doc = await this.getDoc('admin_bindings/primary');
    if (!doc) return null;
    return {
      id: 1,
      owner_user_id: String(doc.data.owner_user_id),
      bound_email: String(doc.data.bound_email),
      bound_at: Number(doc.data.bound_at || 0),
      bound_via: String(doc.data.bound_via || 'firebase_verified_owner'),
    };
  }

  async resolveBoundOwner(): Promise<AdminBindingRow | null> {
    return this.getStoredAdminBinding();
  }

  async bindOwnerAccount(params: {
    email: string;
    boundVia?: string;
    userId?: string;
  }): Promise<AdminBindingRow> {
    const existing = await this.getStoredAdminBinding();
    if (existing) return existing;
    const now = Date.now();
    const binding: AdminBindingRow = {
      id: 1,
      owner_user_id: params.userId || 'owner',
      bound_email: params.email.trim().toLowerCase(),
      bound_at: now,
      bound_via: params.boundVia || 'firebase_verified_owner',
    };
    await this.setDoc('admin_bindings/primary', {
      owner_user_id: binding.owner_user_id,
      bound_email: binding.bound_email,
      bound_at: binding.bound_at,
      bound_via: binding.bound_via,
    });
    return binding;
  }

  // -------------------------------------------------------------------------
  // Seeding & Public/Admin Queries
  // -------------------------------------------------------------------------

  async seedInitialCatalogIfEmpty(): Promise<void> {
    // Only writes when an authenticated owner token is present in request context.
    if (!getActiveFirestoreIdToken()) {
      return;
    }

    const now = Date.now();
    const [existingCats, existingProducts, existingSettings, existingContent] = await Promise.all([
      this.runQuery('categories', { limit: 1 }),
      this.runQuery('products', { limit: 1 }),
      this.getDoc('site_documents/settings'),
      this.getDoc('site_documents/content'),
    ]);

    if (existingCats.length === 0) {
      const catWrites = INITIAL_SEED_CATEGORIES.map((c, idx) => ({
        update: {
          name: `${this.dbRootResource}/${this.envRelPath}/categories/${c.id}`,
          fields: toFsFields({
            id: c.id,
            name: c.name,
            slug: slugifyProductTitle(c.name),
            subtitle: c.subtitle,
            image_url: c.imageUrl,
            alt_text: c.altText,
            position: idx,
            created_at: now - idx * 1000,
            updated_at: now - idx * 1000,
          }),
        },
      }));
      await this.commitBatch(catWrites);
    }

    if (!existingSettings) {
      await this.setDoc('site_documents/settings', {
        key: 'settings',
        value: DEFAULT_SITE_SETTINGS,
        updated_at: now,
      });
    }

    if (!existingContent) {
      await this.setDoc('site_documents/content', {
        key: 'content',
        value: DEFAULT_STOREFRONT_CONTENT,
        updated_at: now,
      });
    }

    if (existingProducts.length === 0) {
      const writes = INITIAL_SEED_PRODUCTS.map((p, idx) => {
        const doc = buildSeedStarterProductDoc(p, idx, now);
        return {
          update: {
            name: `${this.dbRootResource}/${this.envRelPath}/products/${doc.id}`,
            fields: toFsFields(doc as unknown as Record<string, unknown>),
          },
        };
      });
      await this.commitBatch(writes);
    }
  }

  private async getAllProductDocs(): Promise<FirestoreProductDoc[]> {
    const docs = await this.runQuery('products');
    return docs.map((d) => d.data as unknown as FirestoreProductDoc);
  }

  private async getPublishedProductDocs(): Promise<FirestoreProductDoc[]> {
    const docs = await this.runQuery('products', {
      where: {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op: 'EQUAL',
          value: { stringValue: 'published' },
        },
      },
    });
    return docs.map((d) => d.data as unknown as FirestoreProductDoc);
  }

  private async getAllOrderDocs(): Promise<FirestoreOrderDoc[]> {
    const docs = await this.runQuery('orders');
    return docs.map((d) => d.data as unknown as FirestoreOrderDoc);
  }

  private computeOrderCounts(orders: FirestoreOrderDoc[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const order of orders) {
      for (const item of order.items || []) {
        counts.set(item.product_id, (counts.get(item.product_id) || 0) + 1);
      }
    }
    return counts;
  }

  private async syncReferencedMediaPublicStatus(): Promise<void> {
    try {
      const [products, categories, settings, content, mediaDocs] = await Promise.all([
        this.getAllProductDocs(),
        this.listCategories(),
        this.getSiteSettings(),
        this.getStorefrontContent(),
        this.runQuery('product_media'),
      ]);

      const publicFilenames = new Set<string>();
      for (const p of products) {
        if (p.status !== 'published') continue;
        for (const img of p.images || []) {
          const m = String(img.url || '').trim().match(/^\/api\/media\/([a-zA-Z0-9._-]+)$/);
          if (m) publicFilenames.add(m[1]);
        }
      }
      for (const c of categories) {
        const m = String(c.image_url || '').trim().match(/^\/api\/media\/([a-zA-Z0-9._-]+)$/);
        if (m) publicFilenames.add(m[1]);
      }
      for (const f of extractReferencedMediaFilenames(settings, content)) {
        publicFilenames.add(f);
      }

      const writes: Array<Record<string, unknown>> = [];
      for (const media of mediaDocs) {
        const filename = String(media.data.filename || '');
        const shouldBePublic = publicFilenames.has(filename);
        if (Boolean(media.data.is_public) !== shouldBePublic) {
          writes.push({
            update: {
              name: `${this.dbRootResource}/${this.envRelPath}/product_media/${media.id}`,
              fields: toFsFields({
                ...media.data,
                is_public: shouldBePublic,
              }),
            },
          });
        }
      }
      for (let i = 0; i < writes.length; i += 400) {
        await this.commitBatch(writes.slice(i, i + 400));
      }
    } catch (err) {
      console.error(
        '[firestore][media-sync] Failed to sync media public visibility:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  async listPublicProducts(filters: {
    category?: string;
    q?: string;
    featuredOnly?: boolean;
  }): Promise<ProductWithParts[]> {
    const published = await this.getPublishedProductDocs();
    let list = published.map((d) => fromFirestoreProduct(d));

    // If database has not yet been seeded by owner's first dashboard login,
    // gracefully show starter boutique products on read unless owner already cleared/created products.
    if (list.length === 0) {
      const cats = await this.runQuery('categories', { limit: 1 });
      if (cats.length === 0) {
        list = buildStarterReadProducts(Date.now());
      }
    }

    if (filters.category && filters.category !== 'All') {
      list = list.filter((item) => item.product.category === filters.category);
    }
    if (filters.featuredOnly) {
      list = list.filter((item) => item.product.featured === 1);
    }
    if (filters.q && filters.q.trim()) {
      const term = filters.q.trim().toLowerCase();
      list = list.filter(
        (item) =>
          item.product.title.toLowerCase().includes(term) ||
          item.product.category.toLowerCase().includes(term) ||
          item.product.description.toLowerCase().includes(term) ||
          item.product.fabric_note.toLowerCase().includes(term)
      );
    }

    list.sort((a, b) => {
      const featDiff = Number(b.product.featured) - Number(a.product.featured);
      if (featDiff !== 0) return featDiff;
      return b.product.created_at - a.product.created_at;
    });
    return list;
  }

  async getPublicProductByIdOrSlug(idOrSlug: string): Promise<ProductWithParts | null> {
    const published = await this.getPublishedProductDocs();
    const match = published.find((d) => d.id === idOrSlug || d.slug === idOrSlug);
    if (match) return fromFirestoreProduct(match);

    if (published.length === 0) {
      const cats = await this.runQuery('categories', { limit: 1 });
      if (cats.length === 0) {
        return (
          buildStarterReadProducts(Date.now()).find(
            (item) => item.product.id === idOrSlug || item.product.slug === idOrSlug
          ) || null
        );
      }
    }
    return null;
  }

  async isProductSkuConflict(sku: string, excludeProductId?: string): Promise<boolean> {
    const clean = sku.trim().toUpperCase();
    const docs = await this.getAllProductDocs();
    return docs.some(
      (d) => d.sku.toUpperCase() === clean && (!excludeProductId || d.id !== excludeProductId)
    );
  }

  async isVariantSkuConflict(sku: string, excludeProductId?: string): Promise<boolean> {
    const clean = sku.trim().toUpperCase();
    const docs = await this.getAllProductDocs();
    return docs.some(
      (d) =>
        (!excludeProductId || d.id !== excludeProductId) &&
        (d.variant_skus || []).some((vs) => String(vs).toUpperCase() === clean)
    );
  }

  async makeUniqueSlug(baseTitle: string, excludeId?: string): Promise<string> {
    const base = slugifyProductTitle(baseTitle);
    const docs = await this.getAllProductDocs();
    const existingSlugs = new Set(
      docs.filter((d) => !excludeId || d.id !== excludeId).map((d) => d.slug)
    );
    if (!existingSlugs.has(base)) return base;
    let suffix = 2;
    while (existingSlugs.has(`${base}-${suffix}`)) {
      suffix += 1;
    }
    return `${base}-${suffix}`;
  }

  async getAdminOverview(): Promise<AdminOverviewData> {
    const [products, orders, categories, messageDocs, auditDocs] = await Promise.all([
      this.getAllProductDocs(),
      this.getAllOrderDocs(),
      this.listCategories(),
      this.runQuery('contact_messages'),
      this.runQuery('product_audit_logs'),
    ]);

    const orderCounts = this.computeOrderCounts(orders);
    const messages = messageDocs
      .map((d) => d.data as unknown as ContactMessageRow)
      .sort((a, b) => b.created_at - a.created_at);
    const auditLogs = auditDocs
      .map((d) => d.data as unknown as ProductAuditLogRow)
      .sort((a, b) => b.created_at - a.created_at);

    const publishedProducts = products.filter((p) => p.status === 'published').length;
    const draftProducts = products.filter((p) => p.status === 'draft').length;
    const archivedProducts = products.filter((p) => p.status === 'archived').length;
    const lowStockList = products
      .filter((p) => p.status !== 'archived' && p.stock_qty <= p.low_stock_threshold)
      .sort((a, b) => a.stock_qty - b.stock_qty);
    const outOfStockProducts = products.filter(
      (p) => p.status !== 'archived' && p.stock_qty === 0
    ).length;

    const totalRevenuePaise = orders
      .filter((o) => o.status !== 'cancelled')
      .reduce((sum, o) => sum + Number(o.total_paise || 0), 0);
    const pendingOrders = orders.filter((o) => o.status === 'pending').length;

    const recentOrders: OrderWithItems[] = [...orders]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5)
      .map((o) => ({
        order: {
          id: o.id,
          order_number: o.order_number,
          customer_user_id: o.customer_user_id ?? null,
          customer_name: o.customer_name,
          customer_email: o.customer_email,
          customer_phone: o.customer_phone,
          shipping_address: o.shipping_address,
          status: o.status,
          subtotal_paise: Number(o.subtotal_paise),
          total_paise: Number(o.total_paise),
          currency: o.currency,
          created_at: Number(o.created_at),
        },
        items: o.items || [],
      }));

    return {
      metrics: {
        totalProducts: products.length,
        publishedProducts,
        draftProducts,
        archivedProducts,
        lowStockProducts: lowStockList.length,
        outOfStockProducts,
        totalCategories: categories.length,
        totalOrders: orders.length,
        pendingOrders,
        totalRevenuePaise,
        unreadMessages: messages.filter((m) => m.status === 'unread').length,
        totalMessages: messages.length,
        totalAuditEvents: auditLogs.length,
      },
      lowStockItems: lowStockList.slice(0, 5).map((doc) => ({
        ...fromFirestoreProduct(doc),
        orderCount: orderCounts.get(doc.id) || 0,
      })),
      recentOrders,
      recentMessages: messages.slice(0, 5),
      recentAuditLogs: auditLogs.slice(0, 6),
    };
  }

  async listAdminProducts(query: AdminProductQuery) {
    const [products, orders] = await Promise.all([
      this.getAllProductDocs(),
      this.getAllOrderDocs(),
    ]);
    const orderCounts = this.computeOrderCounts(orders);

    let filtered = products;
    if (query.status && query.status !== 'all') {
      filtered = filtered.filter((p) => p.status === query.status);
    }
    if (query.category && query.category !== 'All') {
      filtered = filtered.filter((p) => p.category === query.category);
    }
    if (query.stockFilter === 'low') {
      filtered = filtered.filter(
        (p) => p.status !== 'archived' && p.stock_qty <= p.low_stock_threshold
      );
    } else if (query.stockFilter === 'out') {
      filtered = filtered.filter((p) => p.status !== 'archived' && p.stock_qty === 0);
    }
    if (query.q && query.q.trim()) {
      const term = query.q.trim().toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(term) ||
          p.sku.toLowerCase().includes(term) ||
          p.category.toLowerCase().includes(term)
      );
    }

    filtered = [...filtered].sort((a, b) => {
      switch (query.sort) {
        case 'price_asc':
          return a.price_paise - b.price_paise;
        case 'price_desc':
          return b.price_paise - a.price_paise;
        case 'stock_asc':
          return a.stock_qty - b.stock_qty || b.updated_at - a.updated_at;
        case 'newest':
          return b.created_at - a.created_at;
        case 'updated':
        default:
          return b.updated_at - a.updated_at;
      }
    });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const offset = (query.page - 1) * query.pageSize;
    const items: AdminProductRecord[] = filtered
      .slice(offset, offset + query.pageSize)
      .map((doc) => ({
        ...fromFirestoreProduct(doc),
        orderCount: orderCounts.get(doc.id) || 0,
      }));

    return { items, total, page: query.page, pageSize: query.pageSize, totalPages };
  }

  async getAdminProduct(id: string) {
    const doc = await this.getDoc(`products/${id}`);
    if (!doc) return null;
    const prodDoc = doc.data as unknown as FirestoreProductDoc;
    const [orders, auditDocs] = await Promise.all([
      this.getAllOrderDocs(),
      this.runQuery('product_audit_logs', {
        where: {
          fieldFilter: {
            field: { fieldPath: 'product_id' },
            op: 'EQUAL',
            value: { stringValue: id },
          },
        },
      }),
    ]);

    const orderCount = orders.reduce(
      (sum, o) => sum + (o.items || []).filter((i) => i.product_id === id).length,
      0
    );
    const auditLogs = auditDocs
      .map((d) => d.data as unknown as ProductAuditLogRow)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20);

    return {
      data: { ...fromFirestoreProduct(prodDoc), orderCount },
      auditLogs,
    };
  }

  async createProduct(input: {
    product: ProductRow;
    variants: ProductVariantRow[];
    images: Array<{ mediaId: string | null; url: string; alt: string; isCover: boolean }>;
    actorUserId: string;
    auditAction: string;
    auditSummary: string;
    auditAfter: unknown;
  }): Promise<AdminProductRecord> {
    const prodDoc: FirestoreProductDoc = {
      id: input.product.id,
      slug: input.product.slug,
      title: input.product.title,
      description: input.product.description,
      fabric_note: input.product.fabric_note,
      category: input.product.category,
      sku: input.product.sku,
      price_paise: input.product.price_paise,
      compare_at_paise: input.product.compare_at_paise,
      stock_qty: input.product.stock_qty,
      low_stock_threshold: input.product.low_stock_threshold,
      featured: Boolean(input.product.featured),
      status: input.product.status,
      colors_json: input.product.colors_json,
      sizes_json: input.product.sizes_json,
      version: input.product.version,
      published_at: input.product.published_at,
      archived_at: input.product.archived_at,
      created_at: input.product.created_at,
      updated_at: input.product.updated_at,
      variants: input.variants.map((v, idx) => ({ ...v, position: idx })),
      images: input.images.map((img, idx) => ({
        id: crypto.randomUUID(),
        product_id: input.product.id,
        media_id: img.mediaId,
        url: img.url,
        alt_text: img.alt,
        is_cover: Boolean(img.isCover),
        position: idx,
        created_at: input.product.created_at,
      })),
      variant_skus: input.variants.map((v) => v.sku),
      image_urls: input.images.map((i) => i.url),
    };

    const auditId = crypto.randomUUID();
    const auditLog: ProductAuditLogRow = {
      id: auditId,
      product_id: input.product.id,
      product_title: input.product.title,
      actor_user_id: input.actorUserId,
      action: input.auditAction,
      summary: input.auditSummary,
      before_json: null,
      after_json: JSON.stringify(input.auditAfter),
      created_at: input.product.created_at,
    };

    await this.commitBatch([
      {
        update: {
          name: `${this.dbRootResource}/${this.envRelPath}/products/${prodDoc.id}`,
          fields: toFsFields(prodDoc as unknown as Record<string, unknown>),
        },
      },
      {
        update: {
          name: `${this.dbRootResource}/${this.envRelPath}/product_audit_logs/${auditId}`,
          fields: toFsFields(auditLog as unknown as Record<string, unknown>),
        },
      },
    ]);

    await this.syncReferencedMediaPublicStatus();
    return { ...fromFirestoreProduct(prodDoc), orderCount: 0 };
  }

  async updateProduct(input: {
    productId: string;
    expectedVersion: number;
    nextSlug: string;
    title: string;
    description: string;
    fabricNote: string;
    category: string;
    sku: string;
    pricePaise: number;
    compareAtPaise: number | null;
    totalStock: number;
    lowStockThreshold: number;
    featured: boolean;
    nextStatus: ProductStatus;
    colorsJson: string;
    sizesJson: string;
    publishedAtIfNull: number | null;
    now: number;
    variants: ProductVariantRow[];
    images: Array<{ mediaId: string | null; url: string; alt: string; isCover: boolean }>;
    actorUserId: string;
    auditAction: string;
    auditSummary: string;
    auditBefore: unknown;
    auditAfter: unknown;
  }) {
    const existingDoc = await this.getDoc(`products/${input.productId}`);
    if (!existingDoc) return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    const current = existingDoc.data as unknown as FirestoreProductDoc;
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false as const, code: 'VERSION_CONFLICT' as const };
    }

    const updated: FirestoreProductDoc = {
      id: input.productId,
      slug: input.nextSlug,
      title: input.title,
      description: input.description,
      fabric_note: input.fabricNote,
      category: input.category,
      sku: input.sku,
      price_paise: input.pricePaise,
      compare_at_paise: input.compareAtPaise,
      stock_qty: input.totalStock,
      low_stock_threshold: input.lowStockThreshold,
      featured: input.featured,
      status: input.nextStatus,
      colors_json: input.colorsJson,
      sizes_json: input.sizesJson,
      version: current.version + 1,
      published_at: current.published_at ?? input.publishedAtIfNull,
      archived_at: input.nextStatus === 'archived' ? (current.archived_at ?? input.now) : null,
      created_at: current.created_at,
      updated_at: input.now,
      variants: input.variants.map((v, idx) => ({ ...v, position: idx })),
      images: input.images.map((img, idx) => ({
        id: crypto.randomUUID(),
        product_id: input.productId,
        media_id: img.mediaId,
        url: img.url,
        alt_text: img.alt,
        is_cover: Boolean(img.isCover),
        position: idx,
        created_at: input.now,
      })),
      variant_skus: input.variants.map((v) => v.sku),
      image_urls: input.images.map((i) => i.url),
    };

    try {
      await this.setDoc(`products/${input.productId}`, updated as unknown as Record<string, unknown>, {
        updateTime: existingDoc.updateTime,
      });
    } catch (err) {
      if (err instanceof StoreHttpError && err.code === 'VERSION_CONFLICT') {
        return { ok: false as const, code: 'VERSION_CONFLICT' as const };
      }
      throw err;
    }

    const auditId = crypto.randomUUID();
    await this.setDoc(`product_audit_logs/${auditId}`, {
      id: auditId,
      product_id: input.productId,
      product_title: input.title,
      actor_user_id: input.actorUserId,
      action: input.auditAction,
      summary: input.auditSummary,
      before_json: JSON.stringify(input.auditBefore),
      after_json: JSON.stringify(input.auditAfter),
      created_at: input.now,
    });

    await this.syncReferencedMediaPublicStatus();
    const orders = await this.getAllOrderDocs();
    const orderCount = this.computeOrderCounts(orders).get(input.productId) || 0;
    return {
      ok: true as const,
      product: { ...fromFirestoreProduct(updated), orderCount },
    };
  }

  async duplicateProduct(sourceId: string, actorUserId: string): Promise<AdminProductRecord | null> {
    const existingDoc = await this.getDoc(`products/${sourceId}`);
    if (!existingDoc) return null;
    const src = existingDoc.data as unknown as FirestoreProductDoc;

    const now = Date.now();
    const newId = crypto.randomUUID();
    const newTitle = `${src.title} (Copy)`;
    const newSlug = await this.makeUniqueSlug(newTitle);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const newBaseSku = `${src.sku}-${suffix}`.slice(0, 48);

    const variants: ProductVariantRow[] = (src.variants || []).map((v, idx) => ({
      id: crypto.randomUUID(),
      product_id: newId,
      sku: `${newBaseSku}-V${idx + 1}`,
      size: v.size,
      color_name: v.color_name,
      color_hex: v.color_hex,
      price_paise: v.price_paise,
      compare_at_paise: v.compare_at_paise,
      stock_qty: v.stock_qty,
      position: idx,
    }));

    const images = (src.images || []).map((img, idx) => ({
      ...img,
      id: crypto.randomUUID(),
      product_id: newId,
      position: idx,
      created_at: now,
    }));

    const copyDoc: FirestoreProductDoc = {
      ...src,
      id: newId,
      slug: newSlug,
      title: newTitle,
      sku: newBaseSku,
      status: 'draft',
      version: 1,
      published_at: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      variants,
      images,
      variant_skus: variants.map((v) => v.sku),
      image_urls: images.map((i) => i.url),
    };

    const auditId = crypto.randomUUID();
    await this.commitBatch([
      {
        update: {
          name: `${this.dbRootResource}/${this.envRelPath}/products/${newId}`,
          fields: toFsFields(copyDoc as unknown as Record<string, unknown>),
        },
      },
      {
        update: {
          name: `${this.dbRootResource}/${this.envRelPath}/product_audit_logs/${auditId}`,
          fields: toFsFields({
            id: auditId,
            product_id: newId,
            product_title: newTitle,
            actor_user_id: actorUserId,
            action: 'duplicate',
            summary: `Duplicated from "${src.title}" as draft`,
            before_json: null,
            after_json: JSON.stringify({ status: 'draft', sku: newBaseSku }),
            created_at: now,
          }),
        },
      },
    ]);

    return { ...fromFirestoreProduct(copyDoc), orderCount: 0 };
  }

  async transitionProductStatus(input: {
    productId: string;
    expectedVersion: number;
    targetStatus: ProductStatus;
    actionName: 'publish' | 'unpublish' | 'archive' | 'restore';
    actorUserId: string;
  }) {
    const existingDoc = await this.getDoc(`products/${input.productId}`);
    if (!existingDoc) return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    const current = existingDoc.data as unknown as FirestoreProductDoc;
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false as const, code: 'VERSION_CONFLICT' as const };
    }
    if (input.actionName === 'publish' && (current.images || []).length === 0) {
      return { ok: false as const, code: 'NO_IMAGES' as const };
    }

    const now = Date.now();
    const updated: FirestoreProductDoc = {
      ...current,
      status: input.targetStatus,
      version: current.version + 1,
      published_at:
        input.targetStatus === 'published'
          ? current.published_at ?? now
          : current.published_at,
      archived_at: input.targetStatus === 'archived' ? now : null,
      updated_at: now,
    };

    try {
      await this.setDoc(`products/${input.productId}`, updated as unknown as Record<string, unknown>, {
        updateTime: existingDoc.updateTime,
      });
    } catch (err) {
      if (err instanceof StoreHttpError && err.code === 'VERSION_CONFLICT') {
        return { ok: false as const, code: 'VERSION_CONFLICT' as const };
      }
      throw err;
    }

    const auditId = crypto.randomUUID();
    await this.setDoc(`product_audit_logs/${auditId}`, {
      id: auditId,
      product_id: input.productId,
      product_title: current.title,
      actor_user_id: input.actorUserId,
      action: input.actionName,
      summary: `${input.actionName}ed "${current.title}" (${current.status} -> ${input.targetStatus})`,
      before_json: JSON.stringify({ status: current.status }),
      after_json: JSON.stringify({ status: input.targetStatus }),
      created_at: now,
    });

    await this.syncReferencedMediaPublicStatus();
    const orders = await this.getAllOrderDocs();
    const orderCount = this.computeOrderCounts(orders).get(input.productId) || 0;
    return {
      ok: true as const,
      product: { ...fromFirestoreProduct(updated), orderCount },
    };
  }

  async deleteOrArchiveProduct(productId: string, actorUserId: string) {
    const existingDoc = await this.getDoc(`products/${productId}`);
    if (!existingDoc) return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    const current = existingDoc.data as unknown as FirestoreProductDoc;

    const orders = await this.getAllOrderDocs();
    const refCount = this.computeOrderCounts(orders).get(productId) || 0;
    const now = Date.now();

    if (refCount > 0) {
      const archived: FirestoreProductDoc = {
        ...current,
        status: 'archived',
        archived_at: now,
        version: current.version + 1,
        updated_at: now,
      };
      const auditId = crypto.randomUUID();
      await this.commitBatch([
        {
          update: {
            name: `${this.dbRootResource}/${this.envRelPath}/products/${productId}`,
            fields: toFsFields(archived as unknown as Record<string, unknown>),
          },
        },
        {
          update: {
            name: `${this.dbRootResource}/${this.envRelPath}/product_audit_logs/${auditId}`,
            fields: toFsFields({
              id: auditId,
              product_id: productId,
              product_title: current.title,
              actor_user_id: actorUserId,
              action: 'archive',
              summary: `Archived "${current.title}" instead of deletion because ${refCount} historical order item(s) reference it.`,
              before_json: JSON.stringify({ status: current.status }),
              after_json: JSON.stringify({ status: 'archived' }),
              created_at: now,
            }),
          },
        },
      ]);
      await this.syncReferencedMediaPublicStatus();
      return {
        ok: true as const,
        archivedInsteadOfDeleted: true,
        product: { ...fromFirestoreProduct(archived), orderCount: refCount },
      };
    }

    const auditId = crypto.randomUUID();
    await this.commitBatch([
      { delete: `${this.dbRootResource}/${this.envRelPath}/products/${productId}` },
      {
        update: {
          name: `${this.dbRootResource}/${this.envRelPath}/product_audit_logs/${auditId}`,
          fields: toFsFields({
            id: auditId,
            product_id: productId,
            product_title: current.title,
            actor_user_id: actorUserId,
            action: 'delete',
            summary: `Permanently deleted "${current.title}" (${current.sku})`,
            before_json: JSON.stringify({ status: current.status, sku: current.sku }),
            after_json: null,
            created_at: now,
          }),
        },
      },
    ]);
    await this.syncReferencedMediaPublicStatus();
    return { ok: true as const, archivedInsteadOfDeleted: false };
  }

  // -------------------------------------------------------------------------
  // Media Uploads
  // -------------------------------------------------------------------------

  async findMediaByFilename(filename: string): Promise<{ id: string } | null> {
    const docs = await this.runQuery('product_media', {
      where: {
        fieldFilter: {
          field: { fieldPath: 'filename' },
          op: 'EQUAL',
          value: { stringValue: filename },
        },
      },
      limit: 1,
    });
    return docs[0] ? { id: docs[0].id } : null;
  }

  async saveMediaFiles(files: SaveMediaFileInput[]): Promise<void> {
    for (const file of files) {
      const buf = Buffer.from(file.data);
      const chunks: string[] = [];
      for (let offset = 0; offset < buf.length; offset += MEDIA_CHUNK_BYTES) {
        chunks.push(buf.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64'));
      }

      const writes: Array<Record<string, unknown>> = [
        {
          update: {
            name: `${this.dbRootResource}/${this.envRelPath}/product_media/${file.id}`,
            fields: toFsFields({
              id: file.id,
              filename: file.filename,
              mime_type: file.mimeType,
              byte_size: file.byteSize,
              sha256: file.sha256,
              chunk_count: chunks.length,
              is_public: false,
              uploaded_by_user_id: file.uploadedByUserId,
              created_at: file.createdAt,
            }),
          },
        },
      ];

      chunks.forEach((b64, idx) => {
        writes.push({
          update: {
            name: `${this.dbRootResource}/${this.envRelPath}/product_media/${file.id}/chunks/chunk_${idx}`,
            fields: toFsFields({
              index: idx,
              data_b64: b64,
            }),
          },
        });
      });

      await this.commitBatch(writes);
    }
  }

  async getMediaWithPublicStatus(filename: string): Promise<{
    media: ProductMediaRow;
    isLinkedToPublished: boolean;
  } | null> {
    const hasToken = Boolean(getActiveFirestoreIdToken());
    const whereClause = hasToken
      ? {
          fieldFilter: {
            field: { fieldPath: 'filename' },
            op: 'EQUAL',
            value: { stringValue: filename },
          },
        }
      : {
          compositeFilter: {
            op: 'AND',
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: 'filename' },
                  op: 'EQUAL',
                  value: { stringValue: filename },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: 'is_public' },
                  op: 'EQUAL',
                  value: { booleanValue: true },
                },
              },
            ],
          },
        };

    const docs = await this.runQuery('product_media', { where: whereClause, limit: 1 });
    if (!docs[0]) return null;

    const meta = docs[0].data;
    const chunkDocs = await this.runQuery('chunks', {
      parentRelPath: `product_media/${docs[0].id}`,
    });
    chunkDocs.sort((a, b) => Number(a.data.index || 0) - Number(b.data.index || 0));

    const assembled = Buffer.concat(
      chunkDocs.map((c) => Buffer.from(String(c.data.data_b64 || ''), 'base64'))
    );

    const media: ProductMediaRow = {
      id: docs[0].id,
      filename: String(meta.filename),
      mime_type: String(meta.mime_type),
      byte_size: Number(meta.byte_size),
      sha256: String(meta.sha256),
      data: assembled,
      uploaded_by_user_id: String(meta.uploaded_by_user_id),
      created_at: Number(meta.created_at),
    };

    return {
      media,
      isLinkedToPublished: Boolean(meta.is_public),
    };
  }

  // -------------------------------------------------------------------------
  // Cart Validation & Orders
  // -------------------------------------------------------------------------

  async getProductsForCartValidation(productIds: string[]): Promise<Map<string, ProductWithParts>> {
    const uniqueIds = new Set(productIds);
    const published = await this.getPublicProductsMap();
    const map = new Map<string, ProductWithParts>();
    for (const id of uniqueIds) {
      const found = published.get(id);
      if (found) map.set(id, found);
    }
    return map;
  }

  private async getPublicProductsMap(): Promise<Map<string, ProductWithParts>> {
    const items = await this.listPublicProducts({});
    return new Map(items.map((item) => [item.product.id, item]));
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
    const publishedMap = await this.getPublicProductsMap();
    const now = Date.now();
    const orderId = crypto.randomUUID();
    const orderNumber = `SC-${now.toString(36).toUpperCase().slice(-5)}${crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;

    let subtotalPaise = 0;
    const orderItems: OrderItemRow[] = [];
    const productIds = new Set<string>();

    for (const reqItem of input.items) {
      const prodWrap = publishedMap.get(reqItem.productId);
      if (!prodWrap) {
        throw new StoreHttpError(
          409,
          'PRODUCT_UNAVAILABLE',
          'An item in your bag is no longer available.'
        );
      }
      const variant = prodWrap.variants.find((v) => v.id === reqItem.variantId);
      if (!variant) {
        throw new StoreHttpError(
          409,
          'VARIANT_UNAVAILABLE',
          `Selected size/color for "${prodWrap.product.title}" is no longer available.`
        );
      }
      if (reqItem.expectedPricePaise !== null && reqItem.expectedPricePaise !== variant.price_paise) {
        throw new StoreHttpError(
          409,
          'PRICE_CHANGED',
          `Price for "${prodWrap.product.title}" (${variant.size} / ${variant.color_name}) has been updated. Review your bag before placing the order.`
        );
      }
      if (variant.stock_qty < reqItem.quantity) {
        throw new StoreHttpError(
          409,
          'INSUFFICIENT_STOCK',
          `Only ${variant.stock_qty} piece(s) left for "${prodWrap.product.title}" (${variant.size} / ${variant.color_name}).`
        );
      }

      const lineTotal = variant.price_paise * reqItem.quantity;
      subtotalPaise += lineTotal;
      productIds.add(prodWrap.product.id);

      orderItems.push({
        id: crypto.randomUUID(),
        order_id: orderId,
        product_id: prodWrap.product.id,
        variant_id: variant.id,
        product_title: prodWrap.product.title,
        variant_label: `${variant.size} / ${variant.color_name}`,
        sku: variant.sku,
        unit_price_paise: variant.price_paise,
        quantity: reqItem.quantity,
        line_total_paise: lineTotal,
      });
    }

    const orderDoc: FirestoreOrderDoc = {
      id: orderId,
      order_number: orderNumber,
      customer_user_id: input.customerUserId,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      customer_phone: input.customerPhone,
      shipping_address: input.shippingAddress,
      status: 'pending',
      subtotal_paise: subtotalPaise,
      total_paise: subtotalPaise,
      currency: 'INR',
      created_at: now,
      product_ids: Array.from(productIds),
      items: orderItems,
    };

    await this.setDoc(`orders/${orderId}`, orderDoc as unknown as Record<string, unknown>);

    const orderRow: OrderRow = {
      id: orderDoc.id,
      order_number: orderDoc.order_number,
      customer_user_id: orderDoc.customer_user_id,
      customer_name: orderDoc.customer_name,
      customer_email: orderDoc.customer_email,
      customer_phone: orderDoc.customer_phone,
      shipping_address: orderDoc.shipping_address,
      status: orderDoc.status,
      subtotal_paise: orderDoc.subtotal_paise,
      total_paise: orderDoc.total_paise,
      currency: orderDoc.currency,
      created_at: orderDoc.created_at,
    };

    return { order: orderRow, items: orderItems };
  }

  async listAdminOrders(page: number, pageSize: number) {
    const orders = (await this.getAllOrderDocs()).sort((a, b) => b.created_at - a.created_at);
    const total = orders.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    const items: OrderWithItems[] = orders.slice(offset, offset + pageSize).map((o) => ({
      order: {
        id: o.id,
        order_number: o.order_number,
        customer_user_id: o.customer_user_id ?? null,
        customer_name: o.customer_name,
        customer_email: o.customer_email,
        customer_phone: o.customer_phone,
        shipping_address: o.shipping_address,
        status: o.status,
        subtotal_paise: Number(o.subtotal_paise),
        total_paise: Number(o.total_paise),
        currency: o.currency,
        created_at: Number(o.created_at),
      },
      items: o.items || [],
    }));

    return { items, total, page, pageSize, totalPages };
  }

  async updateOrderStatus(orderId: string, nextStatus: string): Promise<boolean> {
    const existing = await this.getDoc(`orders/${orderId}`);
    if (!existing) return false;
    await this.patchDoc(`orders/${orderId}`, { status: nextStatus });
    return true;
  }

  async listAuditLogs(params: { productId?: string; page: number; pageSize: number }) {
    const docs = params.productId
      ? await this.runQuery('product_audit_logs', {
          where: {
            fieldFilter: {
              field: { fieldPath: 'product_id' },
              op: 'EQUAL',
              value: { stringValue: params.productId },
            },
          },
        })
      : await this.runQuery('product_audit_logs');

    const sorted = docs
      .map((d) => d.data as unknown as ProductAuditLogRow)
      .sort((a, b) => b.created_at - a.created_at);

    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const offset = (params.page - 1) * params.pageSize;
    return {
      items: sorted.slice(offset, offset + params.pageSize),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  // -------------------------------------------------------------------------
  // Categories CRUD
  // -------------------------------------------------------------------------

  async listCategories(): Promise<CategoryRow[]> {
    const docs = await this.runQuery('categories');
    if (docs.length === 0 && !getActiveFirestoreIdToken()) {
      return buildStarterReadCategories(Date.now());
    }
    return docs
      .map((d) => d.data as unknown as CategoryRow)
      .sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  }

  async getCategoryById(id: string): Promise<CategoryRow | null> {
    const doc = await this.getDoc(`categories/${id}`);
    return doc ? (doc.data as unknown as CategoryRow) : null;
  }

  async createCategory(input: {
    name: string;
    subtitle: string;
    imageUrl: string;
    altText: string;
    position?: number;
  }): Promise<CategoryRow> {
    const existing = await this.listCategories();
    const cleanName = input.name.trim();
    if (existing.some((c) => c.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new StoreHttpError(
        409,
        'CATEGORY_EXISTS',
        `A collection category named "${cleanName}" already exists.`
      );
    }

    const baseSlug = slugifyProductTitle(cleanName);
    const slugSet = new Set(existing.map((c) => c.slug));
    let slug = baseSlug;
    let suffix = 2;
    while (slugSet.has(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    const now = Date.now();
    const row: CategoryRow = {
      id: `cat-${crypto.randomUUID().slice(0, 8)}`,
      name: cleanName,
      slug,
      subtitle: input.subtitle.trim(),
      image_url: input.imageUrl.trim(),
      alt_text: input.altText.trim(),
      position: input.position ?? existing.length,
      created_at: now,
      updated_at: now,
    };

    await this.setDoc(`categories/${row.id}`, row as unknown as Record<string, unknown>);
    await this.syncReferencedMediaPublicStatus();
    return row;
  }

  async updateCategory(
    id: string,
    input: {
      name: string;
      subtitle: string;
      imageUrl: string;
      altText: string;
      position?: number;
    }
  ): Promise<CategoryRow | null> {
    const existing = await this.getCategoryById(id);
    if (!existing) return null;

    const cleanName = input.name.trim();
    const allCats = await this.listCategories();
    if (allCats.some((c) => c.id !== id && c.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new StoreHttpError(
        409,
        'CATEGORY_EXISTS',
        `Another collection category named "${cleanName}" already exists.`
      );
    }

    const baseSlug = slugifyProductTitle(cleanName);
    const slugSet = new Set(allCats.filter((c) => c.id !== id).map((c) => c.slug));
    let slug = baseSlug;
    let suffix = 2;
    while (slugSet.has(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    const now = Date.now();
    const updated: CategoryRow = {
      id,
      name: cleanName,
      slug,
      subtitle: input.subtitle.trim(),
      image_url: input.imageUrl.trim(),
      alt_text: input.altText.trim(),
      position: input.position ?? existing.position,
      created_at: existing.created_at,
      updated_at: now,
    };

    await this.setDoc(`categories/${id}`, updated as unknown as Record<string, unknown>);

    if (existing.name !== cleanName) {
      const products = await this.getAllProductDocs();
      const writes: Array<Record<string, unknown>> = [];
      for (const p of products) {
        if (p.category === existing.name) {
          writes.push({
            update: {
              name: `${this.dbRootResource}/${this.envRelPath}/products/${p.id}`,
              fields: toFsFields({ ...p, category: cleanName, updated_at: now } as unknown as Record<string, unknown>),
            },
          });
        }
      }
      await this.commitBatch(writes);

      const content = await this.getStorefrontContent();
      let contentChanged = false;
      const nextContent = {
        ...content,
        spotlightEdit:
          content.spotlightEdit.targetCategory === existing.name
            ? { ...content.spotlightEdit, targetCategory: cleanName }
            : content.spotlightEdit,
        lookbookEntries: content.lookbookEntries.map((entry) => {
          if (entry.category === existing.name) {
            contentChanged = true;
            return { ...entry, category: cleanName };
          }
          return entry;
        }),
      };
      if (content.spotlightEdit.targetCategory === existing.name) {
        contentChanged = true;
      }
      if (contentChanged) {
        await this.saveStorefrontContent(nextContent);
      }
    }

    await this.syncReferencedMediaPublicStatus();
    return updated;
  }

  async deleteCategory(id: string) {
    const existing = await this.getCategoryById(id);
    if (!existing) return { ok: false as const, code: 'NOT_FOUND' as const };

    const products = await this.getAllProductDocs();
    const productCount = products.filter((p) => p.category === existing.name).length;
    if (productCount > 0) {
      return { ok: false as const, code: 'CATEGORY_IN_USE' as const, productCount };
    }

    await this.deleteDoc(`categories/${id}`);
    await this.syncReferencedMediaPublicStatus();
    return { ok: true as const };
  }

  // -------------------------------------------------------------------------
  // Storefront Settings & Content
  // -------------------------------------------------------------------------

  async getSiteSettings(): Promise<SiteSettingsData> {
    const doc = await this.getDoc('site_documents/settings');
    if (!doc || !doc.data.value) {
      return mergeSiteSettings(undefined);
    }
    return mergeSiteSettings(doc.data.value);
  }

  async saveSiteSettings(settings: SiteSettingsData): Promise<SiteSettingsData> {
    const merged = mergeSiteSettings(settings);
    await this.setDoc('site_documents/settings', {
      key: 'settings',
      value: merged,
      updated_at: Date.now(),
    });
    await this.syncReferencedMediaPublicStatus();
    return merged;
  }

  async getStorefrontContent(): Promise<StorefrontContentData> {
    const doc = await this.getDoc('site_documents/content');
    if (!doc || !doc.data.value) {
      return mergeStorefrontContent(undefined);
    }
    return mergeStorefrontContent(doc.data.value);
  }

  async saveStorefrontContent(content: StorefrontContentData): Promise<StorefrontContentData> {
    const merged = mergeStorefrontContent(content);
    await this.setDoc('site_documents/content', {
      key: 'content',
      value: merged,
      updated_at: Date.now(),
    });
    await this.syncReferencedMediaPublicStatus();
    return merged;
  }

  // -------------------------------------------------------------------------
  // Contact Messages
  // -------------------------------------------------------------------------

  async createContactMessage(input: {
    senderName: string;
    senderEmail: string;
    senderPhone: string;
    subject: string;
    message: string;
  }): Promise<ContactMessageRow> {
    const now = Date.now();
    const row: ContactMessageRow = {
      id: `msg-${crypto.randomUUID()}`,
      sender_name: input.senderName.trim(),
      sender_email: input.senderEmail.trim().toLowerCase(),
      sender_phone: input.senderPhone.trim(),
      subject: input.subject.trim(),
      message: input.message.trim(),
      status: 'unread',
      admin_note: '',
      created_at: now,
      updated_at: now,
    };

    await this.setDoc(`contact_messages/${row.id}`, row as unknown as Record<string, unknown>);
    return row;
  }

  async listAdminMessages(params: {
    status?: string;
    q?: string;
    page: number;
    pageSize: number;
  }) {
    const docs = await this.runQuery('contact_messages');
    const all = docs
      .map((d) => d.data as unknown as ContactMessageRow)
      .sort((a, b) => b.created_at - a.created_at);
    const unreadCount = all.filter((m) => m.status === 'unread').length;

    let filtered = all;
    if (params.status && params.status !== 'all') {
      filtered = filtered.filter((m) => m.status === params.status);
    }
    if (params.q && params.q.trim()) {
      const term = params.q.trim().toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.sender_name.toLowerCase().includes(term) ||
          m.sender_email.toLowerCase().includes(term) ||
          m.subject.toLowerCase().includes(term) ||
          m.message.toLowerCase().includes(term)
      );
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const offset = (params.page - 1) * params.pageSize;
    return {
      items: filtered.slice(offset, offset + params.pageSize),
      total,
      unreadCount,
      page: params.page,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  async updateContactMessage(
    id: string,
    patch: { status?: ContactMessageStatus; adminNote?: string }
  ): Promise<ContactMessageRow | null> {
    const existing = await this.getDoc(`contact_messages/${id}`);
    if (!existing) return null;
    const cur = existing.data as unknown as ContactMessageRow;

    const updated: ContactMessageRow = {
      ...cur,
      status: patch.status ?? cur.status,
      admin_note: patch.adminNote !== undefined ? patch.adminNote.trim() : cur.admin_note,
      updated_at: Date.now(),
    };

    await this.patchDoc(`contact_messages/${id}`, {
      status: updated.status,
      admin_note: updated.admin_note,
      updated_at: updated.updated_at,
    });
    return updated;
  }

  async deleteContactMessage(id: string): Promise<boolean> {
    const existing = await this.getDoc(`contact_messages/${id}`);
    if (!existing) return false;
    await this.deleteDoc(`contact_messages/${id}`);
    return true;
  }
}
