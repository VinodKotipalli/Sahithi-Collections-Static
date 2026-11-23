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
  type CouponRow,
  type CustomerAddressRow,
  type CustomerNotificationRow,
  type CustomerPaymentMethodRow,
  type EmailTokenRow,
  type GiftCardRow,
  type LegacyPhoneOnlyAccount,
  type LoyaltyConfigData,
  type NotificationPreferencesData,
  type OrderItemRow,
  type OrderReturnRequestRecord,
  type OrderRow,
  type OrderStatusHistoryEntry,
  type OrderWithItems,
  type PendingCheckoutRow,
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
  type StoreUserSummary,
  type UserRow,
} from './store.ts';
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
  validateNonSensitivePaymentMethodInput,
  validateOrderStatusTransition,
} from './order-utils.ts';
import {
  DEFAULT_SITE_SETTINGS,
  DEFAULT_STOREFRONT_CONTENT,
  extractReferencedMediaFilenames,
  mergeLoyaltyConfig,
  mergeSiteSettings,
  mergeStorefrontContent,
} from './storefront-defaults.ts';
import {
  formatVariantDisplayLabel,
  isVariantColorActiveInMetadata,
  resolveVariantSnapshotImageUrl,
  validateColorVariantMatrix,
} from '../src/utils/colorVariants.ts';

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
  phoneNumber: string;
  phoneVerified: boolean;
  signInProvider: string;
  name: string;
  authTimeMs: number;
  expiresAtMs: number;
}

export interface FirebaseSessionEnvelope {
  idToken: string;
  refreshToken: string;
  uid: string;
  email: string | null;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  hasPassword?: boolean;
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

function resolveFirebaseAuthEmulatorOrigin(): string {
  const raw = (process.env.FIREBASE_AUTH_EMULATOR_HOST || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/\/+$/, '')}`;
}

export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string
): Promise<VerifiedFirebaseTokenClaims | null> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64) return null;

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const emulatorOrigin = resolveFirebaseAuthEmulatorOrigin();
  const isEmulatorToken = Boolean(emulatorOrigin && header.alg === 'none');

  if (!isEmulatorToken) {
    if (!sigB64 || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
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

  const phoneNumber =
    typeof payload.phone_number === 'string' ? payload.phone_number.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const emailVerified = Boolean(email && payload.email_verified);
  const phoneVerified = Boolean(phoneNumber);
  const firebaseMeta =
    payload.firebase && typeof payload.firebase === 'object'
      ? (payload.firebase as { sign_in_provider?: unknown })
      : undefined;
  const signInProvider =
    typeof firebaseMeta?.sign_in_provider === 'string' && firebaseMeta.sign_in_provider
      ? firebaseMeta.sign_in_provider
      : phoneVerified && !email
        ? 'phone'
        : 'password';

  return {
    uid: payload.sub.trim(),
    email,
    emailVerified,
    phoneNumber,
    phoneVerified,
    signInProvider,
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
    const normalizedEmail =
      typeof parsed.email === 'string' && parsed.email.trim()
        ? parsed.email.trim().toLowerCase()
        : null;
    const normalizedPhone =
      typeof parsed.phoneNumber === 'string' && parsed.phoneNumber.trim()
        ? parsed.phoneNumber.trim()
        : null;
    if (
      !parsed.idToken ||
      !parsed.refreshToken ||
      !parsed.uid ||
      (!normalizedEmail && !normalizedPhone && !parsed.phoneVerified)
    ) {
      return null;
    }
    return {
      idToken: String(parsed.idToken),
      refreshToken: String(parsed.refreshToken),
      uid: String(parsed.uid),
      email: normalizedEmail,
      ...(normalizedPhone ? { phoneNumber: normalizedPhone } : {}),
      ...(typeof parsed.phoneVerified === 'boolean'
        ? { phoneVerified: parsed.phoneVerified }
        : {}),
      ...(typeof parsed.hasPassword === 'boolean' ? { hasPassword: parsed.hasPassword } : {}),
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
  const emulatorOrigin = resolveFirebaseAuthEmulatorOrigin();
  const baseUrl = emulatorOrigin
    ? `${emulatorOrigin}/identitytoolkit.googleapis.com/v1`
    : 'https://identitytoolkit.googleapis.com/v1';
  let res: Response;
  try {
    res = await fetch(
      `${baseUrl}/${endpoint}?key=${encodeURIComponent(apiKey)}`,
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

export async function firebaseDeleteAccount(apiKey: string, idToken: string): Promise<void> {
  await callIdentityToolkit(apiKey, 'accounts:delete', {
    idToken,
  });
}

export async function firebaseRefreshIdToken(
  apiKey: string,
  refreshToken: string
): Promise<{ idToken: string; refreshToken: string; uid: string }> {
  const emulatorOrigin = resolveFirebaseAuthEmulatorOrigin();
  const tokenBase = emulatorOrigin
    ? `${emulatorOrigin}/securetoken.googleapis.com/v1`
    : 'https://securetoken.googleapis.com/v1';
  const res = await fetch(
    `${tokenBase}/token?key=${encodeURIComponent(apiKey)}`,
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
  phoneNumber: string;
  phoneVerified: boolean;
  displayName: string;
  providerIds: string[];
  hasPassword: boolean;
} | null> {
  try {
    const data = await callIdentityToolkit<{
      users?: Array<{
        localId: string;
        email?: string;
        emailVerified?: boolean;
        phoneNumber?: string;
        displayName?: string;
        providerUserInfo?: Array<{ providerId?: string }>;
      }>;
    }>(apiKey, 'accounts:lookup', { idToken });
    const u = data.users?.[0];
    if (!u) return null;
    const providerIds = Array.isArray(u.providerUserInfo)
      ? u.providerUserInfo
          .map((p) => (typeof p.providerId === 'string' ? p.providerId : ''))
          .filter(Boolean)
      : [];
    const cleanPhone = typeof u.phoneNumber === 'string' ? u.phoneNumber.trim() : '';
    const cleanEmail = (u.email || '').trim().toLowerCase();
    return {
      localId: u.localId,
      email: cleanEmail,
      emailVerified: Boolean(cleanEmail && u.emailVerified),
      phoneNumber: cleanPhone,
      phoneVerified: Boolean(cleanPhone),
      displayName: u.displayName || '',
      providerIds,
      hasPassword: providerIds.includes('password'),
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
  included_pieces?: string;
  care_note?: string;
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
  import_key?: string | null;
  source_image_filename?: string | null;
  pending_fields_json?: string | null;
  catalog_batch?: string | null;
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
    color_id?: string | null;
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
  payment_status?: string;
  refund_status?: string;
  fulfillment_status?: string;
  cancelled_at?: number | null;
  cancelled_by?: string | null;
  cancel_reason?: string | null;
  payment_method?: string;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
  coupon_code?: string | null;
  gift_card_code?: string | null;
  discount_paise?: number;
  gift_card_paise?: number;
  status_history_json?: string;
  cancel_request_json?: string | null;
  return_request_json?: string | null;
  hidden_by_customer?: boolean | number;
  hidden_at?: number | null;
  stock_restored_at?: number | null;
  delivery_details_edited_at?: number | null;
  idempotency_key?: string | null;
  payment_collected_at?: number | null;
  payment_collected_by?: string | null;
  subtotal_paise: number;
  total_paise: number;
  currency: string;
  created_at: number;
  updated_at?: number;
  product_ids: string[];
  items: OrderItemRow[];
}

function normalizeRestOrderRow(o: FirestoreOrderDoc): OrderRow {
  return {
    id: o.id,
    order_number: o.order_number,
    customer_user_id: o.customer_user_id ?? null,
    customer_name: o.customer_name,
    customer_email: o.customer_email,
    customer_phone: o.customer_phone,
    shipping_address: o.shipping_address,
    status: o.status,
    payment_status: o.payment_status ?? (o.razorpay_payment_id ? 'paid' : 'unpaid'),
    refund_status: o.refund_status ?? undefined,
    fulfillment_status: o.fulfillment_status ?? o.status ?? 'unknown',
    cancelled_at: typeof o.cancelled_at === 'number' ? Number(o.cancelled_at) : null,
    cancelled_by: typeof o.cancelled_by === 'string' ? o.cancelled_by : null,
    cancel_reason: typeof o.cancel_reason === 'string' ? o.cancel_reason : null,
    payment_method:
      o.payment_method ?? (o.razorpay_order_id || o.razorpay_payment_id ? 'razorpay' : 'cod'),
    razorpay_order_id: o.razorpay_order_id ?? null,
    razorpay_payment_id: o.razorpay_payment_id ?? null,
    coupon_code: o.coupon_code ?? null,
    gift_card_code: o.gift_card_code ?? null,
    discount_paise: Number(o.discount_paise || 0),
    gift_card_paise: Number(o.gift_card_paise || 0),
    status_history_json: o.status_history_json || '[]',
    cancel_request_json: o.cancel_request_json ?? null,
    return_request_json: o.return_request_json ?? null,
    hidden_by_customer: o.hidden_by_customer ? 1 : 0,
    hidden_at: typeof o.hidden_at === 'number' ? Number(o.hidden_at) : null,
    stock_restored_at:
      typeof o.stock_restored_at === 'number' ? Number(o.stock_restored_at) : null,
    delivery_details_edited_at:
      typeof o.delivery_details_edited_at === 'number'
        ? Number(o.delivery_details_edited_at)
        : null,
    idempotency_key: o.idempotency_key ?? null,
    payment_collected_at:
      typeof o.payment_collected_at === 'number' ? Number(o.payment_collected_at) : null,
    payment_collected_by: o.payment_collected_by ?? null,
    subtotal_paise: Number(o.subtotal_paise || 0),
    total_paise: Number(o.total_paise || 0),
    currency: o.currency || 'INR',
    created_at: Number(o.created_at || 0),
    updated_at: Number(o.updated_at || o.created_at || 0),
  };
}

function fromFirestoreProduct(doc: FirestoreProductDoc): ProductWithParts {
  const product: ProductRow = {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    description: doc.description || '',
    fabric_note: doc.fabric_note || '',
    included_pieces: typeof doc.included_pieces === 'string' ? doc.included_pieces : '',
    care_note: typeof doc.care_note === 'string' ? doc.care_note : '',
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
    import_key: typeof doc.import_key === 'string' ? doc.import_key : null,
    source_image_filename:
      typeof doc.source_image_filename === 'string' ? doc.source_image_filename : null,
    pending_fields_json:
      typeof doc.pending_fields_json === 'string' ? doc.pending_fields_json : null,
    catalog_batch: typeof doc.catalog_batch === 'string' ? doc.catalog_batch : null,
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
      color_id: typeof v.color_id === 'string' && v.color_id.trim() ? v.color_id.trim() : null,
      color_name: String(v.color_name),
      color_hex: String(v.color_hex),
      price_paise: Number(v.price_paise),
      price_override_paise:
        typeof v.price_override_paise === 'number' ? v.price_override_paise : null,
      compare_at_paise:
        typeof v.compare_at_paise === 'number' ? v.compare_at_paise : null,
      stock_qty: Number(v.stock_qty),
      active: v.active === undefined || v.active === null ? 1 : v.active ? 1 : 0,
      position: Number(v.position ?? idx),
    }))
    .sort((a, b) => a.position - b.position);

  const images: ProductImageRow[] = (doc.images || [])
    .map((img, idx) => ({
      id: String(img.id),
      product_id: doc.id,
      media_id: img.media_id ?? null,
      color_id: typeof img.color_id === 'string' && img.color_id.trim() ? img.color_id.trim() : null,
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
        id: `${productId}-var-${pos + 1}`,
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
    id: `${productId}-img-${imgIdx + 1}`,
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
    included_pieces: p.includedPieces || '',
    care_note: p.careNote || '',
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
    opts?: string | { updateTime?: string; bearerOverride?: string }
  ): Promise<void> {
    const resolvedOpts =
      typeof opts === 'string' ? { bearerOverride: opts } : opts || {};
    const params = new URLSearchParams({ key: this.config.apiKey });
    for (const key of Object.keys(patch)) {
      params.append('updateMask.fieldPaths', key);
    }
    if (resolvedOpts.updateTime) {
      params.append('currentDocument.updateTime', resolvedOpts.updateTime);
    }
    const res = await fetch(
      `${this.docBaseUrl}/${this.envRelPath}/${relPath}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: this.authHeaders(resolvedOpts.bearerOverride),
        body: JSON.stringify({ fields: toFsFields(patch) }),
      }
    );
    if (!res.ok) {
      if (res.status === 409 || res.status === 412) {
        throw new StoreHttpError(409, 'CONCURRENCY_CONFLICT', 'Order or record was modified concurrently.');
      }
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
    const phoneVerified = Boolean(doc.data.phone_verified && doc.data.phone_e164);
    const hasPassword =
      typeof doc.data.has_password === 'boolean'
        ? doc.data.has_password
        : Array.isArray(doc.data.sign_in_providers)
          ? (doc.data.sign_in_providers as unknown[]).includes('password')
          : Boolean(doc.data.email);
    const contactPhone =
      typeof doc.data.contact_phone === 'string' && doc.data.contact_phone.trim()
        ? doc.data.contact_phone.trim()
        : typeof doc.data.phone_e164 === 'string' && doc.data.phone_e164.trim()
          ? doc.data.phone_e164.trim()
          : null;
    return {
      id: String(doc.data.id || doc.id),
      full_name: String(doc.data.full_name || ''),
      email: typeof doc.data.email === 'string' && doc.data.email.trim() ? doc.data.email : null,
      email_verified: doc.data.email_verified ? 1 : 0,
      password_hash: hasPassword ? 'firebase-managed' : '',
      phone_e164: typeof doc.data.phone_e164 === 'string' ? doc.data.phone_e164 : null,
      phone_verified: phoneVerified ? 1 : 0,
      contact_phone: contactPhone,
      has_password: hasPassword,
      notification_prefs_json:
        typeof doc.data.notification_prefs_json === 'string'
          ? doc.data.notification_prefs_json
          : doc.data.notification_prefs && typeof doc.data.notification_prefs === 'object'
            ? JSON.stringify(doc.data.notification_prefs)
            : null,
      deleted_at: typeof doc.data.deleted_at === 'number' ? doc.data.deleted_at : null,
      created_at: Number(doc.data.created_at || 0),
      updated_at: Number(doc.data.updated_at || 0),
    };
  }

  async syncVerifiedUserProfile(input: {
    id: string;
    fullName: string;
    email?: string | null;
    emailVerified: boolean;
    phoneE164?: string | null;
    phoneVerified?: boolean;
    hasPassword?: boolean;
    signInProviders?: string[];
  }): Promise<UserRow> {
    const existing = await this.getUserById(input.id);
    const now = Date.now();
    const safeInputName = input.fullName.trim().length >= 2 ? input.fullName.trim().slice(0, 100) : 'Customer';
    const nextEmail =
      typeof input.email === 'string' && input.email.trim()
        ? input.email.trim().toLowerCase()
        : existing?.email || null;
    const nextEmailVerified = Boolean(nextEmail && (input.emailVerified || existing?.email_verified));
    const verifiedPhone =
      input.phoneVerified && typeof input.phoneE164 === 'string' && input.phoneE164.trim()
        ? input.phoneE164.trim()
        : existing?.phone_verified && existing.phone_e164
          ? existing.phone_e164
          : null;
    const nextPhoneVerified = Boolean(verifiedPhone);
    const nextPhoneE164 = verifiedPhone || existing?.phone_e164 || null;
    const nextContactPhone = existing?.contact_phone ?? nextPhoneE164 ?? null;
    const hasPassword =
      typeof input.hasPassword === 'boolean'
        ? input.hasPassword
        : existing?.has_password !== undefined
          ? existing.has_password
          : Boolean(nextEmail);

    const row: Record<string, unknown> = {
      id: input.id,
      full_name:
        existing?.full_name && existing.full_name.length >= 2 && existing.full_name !== 'Customer'
          ? existing.full_name
          : safeInputName,
      email: nextEmail,
      email_verified: nextEmailVerified,
      phone_e164: nextPhoneE164,
      phone_verified: nextPhoneVerified,
      contact_phone: nextContactPhone,
      has_password: hasPassword,
      ...(Array.isArray(input.signInProviders) && input.signInProviders.length > 0
        ? { sign_in_providers: input.signInProviders }
        : {}),
      ...(existing?.notification_prefs_json
        ? { notification_prefs_json: existing.notification_prefs_json }
        : {}),
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    await this.setDoc(`users/${input.id}`, row);
    return {
      id: input.id,
      full_name: String(row.full_name),
      email: nextEmail,
      email_verified: nextEmailVerified ? 1 : 0,
      password_hash: hasPassword ? 'firebase-managed' : '',
      phone_e164: nextPhoneE164,
      phone_verified: nextPhoneVerified ? 1 : 0,
      contact_phone: nextContactPhone,
      has_password: hasPassword,
      notification_prefs_json: existing?.notification_prefs_json ?? null,
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
      email: typeof d.email === 'string' && d.email.trim() ? d.email : null,
      email_verified: d.email_verified ? 1 : 0,
      password_hash: d.has_password === false ? '' : 'firebase-managed',
      phone_e164: typeof d.phone_e164 === 'string' ? d.phone_e164 : null,
      phone_verified: d.phone_verified ? 1 : 0,
      contact_phone:
        typeof d.contact_phone === 'string'
          ? d.contact_phone
          : typeof d.phone_e164 === 'string'
            ? d.phone_e164
            : null,
      has_password: typeof d.has_password === 'boolean' ? d.has_password : Boolean(d.email),
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

  async updateCustomerProfile(
    userId: string,
    input: {
      fullName?: string;
      phone?: string | null;
      notificationPrefs?: NotificationPreferencesData;
    },
    now: number
  ): Promise<UserRow> {
    const existing = await this.getUserById(userId);
    if (!existing) {
      throw new StoreHttpError(404, 'USER_NOT_FOUND', 'Customer account was not found.');
    }
    const nextName =
      typeof input.fullName === 'string' && input.fullName.trim().length >= 2
        ? input.fullName.trim().slice(0, 100)
        : existing.full_name;
    const nextContactPhone =
      input.phone === null
        ? null
        : typeof input.phone === 'string'
          ? input.phone.trim() || null
          : existing.contact_phone ?? existing.phone_e164;
    const nextPrefsJson = input.notificationPrefs
      ? JSON.stringify(parseNotificationPrefs(input.notificationPrefs))
      : existing.notification_prefs_json ?? null;

    // Never overwrite a verified login mobile number (phone_e164) with editable contact_phone
    const nextPhoneE164 = existing.phone_verified ? existing.phone_e164 : nextContactPhone;

    await this.patchDoc(`users/${userId}`, {
      full_name: nextName,
      phone_e164: nextPhoneE164,
      contact_phone: nextContactPhone,
      notification_prefs_json: nextPrefsJson,
      updated_at: now,
    });
    const updated = await this.getUserById(userId);
    if (!updated) throw new Error('User not found.');
    return updated;
  }

  async deleteCustomerAccount(
    userId: string,
    _now: number
  ): Promise<{ deleted: boolean; preservedOrdersCount: number }> {
    const existing = await this.getUserById(userId);
    if (!existing) return { deleted: false, preservedOrdersCount: 0 };
    if ((existing.email || '').toLowerCase() === this.ownerEmail) {
      throw new StoreHttpError(
        403,
        'OWNER_ACCOUNT_PROTECTED',
        'The primary store owner account cannot be deleted from customer settings.'
      );
    }

    const [orders, addrs, pms, notifs] = await Promise.all([
      this.listCustomerOrders(userId).catch(() => []),
      this.listCustomerAddresses(userId).catch(() => []),
      this.listCustomerPaymentMethods(userId).catch(() => []),
      this.listCustomerNotifications(userId).catch(() => []),
    ]);

    for (const a of addrs) {
      await this.deleteDoc(`users/${userId}/addresses/${a.id}`).catch(() => {});
    }
    for (const p of pms) {
      await this.deleteDoc(`users/${userId}/payment_methods/${p.id}`).catch(() => {});
    }
    for (const n of notifs) {
      await this.deleteDoc(`users/${userId}/notifications/${n.id}`).catch(() => {});
    }
    await this.deleteDoc(`users/${userId}/wishlist/items`).catch(() => {});
    await this.deleteDoc(`users/${userId}`);
    return { deleted: true, preservedOrdersCount: orders.length };
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

  private hiddenProductIds = new Set<string>();
  private hiddenProductSlugs = new Set<string>();
  private deletedProductIds = new Set<string>();

  private suppressLegacySeed = false;

  private async getCatalogVisibilityMeta(): Promise<{
    hiddenIds: Set<string>;
    hiddenSlugs: Set<string>;
    deletedIds: Set<string>;
    suppressLegacySeed: boolean;
  }> {
    const hiddenIds = new Set<string>(this.hiddenProductIds);
    const hiddenSlugs = new Set<string>(this.hiddenProductSlugs);
    const deletedIds = new Set<string>(this.deletedProductIds);
    let suppressLegacySeed = this.suppressLegacySeed;

    try {
      const settingsDoc = await this.getDoc('site_documents/settings');
      if (settingsDoc && settingsDoc.data) {
        const valueObj =
          settingsDoc.data.value && typeof settingsDoc.data.value === 'object'
            ? (settingsDoc.data.value as Record<string, unknown>)
            : null;
        const catalogCtrl =
          valueObj?.catalogControl && typeof valueObj.catalogControl === 'object'
            ? (valueObj.catalogControl as Record<string, unknown>)
            : null;
        if (
          settingsDoc.data.suppress_legacy_seed === true ||
          catalogCtrl?.suppressLegacySeed === true
        ) {
          suppressLegacySeed = true;
          this.suppressLegacySeed = true;
        } else if (
          settingsDoc.data.suppress_legacy_seed === false ||
          catalogCtrl?.suppressLegacySeed === false
        ) {
          suppressLegacySeed = false;
          this.suppressLegacySeed = false;
        }
        const rawHiddenIds = settingsDoc.data.hidden_product_ids;
        if (Array.isArray(rawHiddenIds)) {
          for (const id of rawHiddenIds) {
            if (typeof id === 'string' && id) {
              hiddenIds.add(id);
              this.hiddenProductIds.add(id);
            }
          }
        }
        const rawHiddenSlugs = settingsDoc.data.hidden_product_slugs;
        if (Array.isArray(rawHiddenSlugs)) {
          for (const slug of rawHiddenSlugs) {
            if (typeof slug === 'string' && slug) {
              hiddenSlugs.add(slug);
              this.hiddenProductSlugs.add(slug);
            }
          }
        }
        const rawDeletedIds = settingsDoc.data.deleted_product_ids;
        if (Array.isArray(rawDeletedIds)) {
          for (const id of rawDeletedIds) {
            if (typeof id === 'string' && id) {
              deletedIds.add(id);
              hiddenIds.add(id);
              this.deletedProductIds.add(id);
              this.hiddenProductIds.add(id);
            }
          }
        }
      }
    } catch {
      // Ignore transient settings read failure
    }

    if (getActiveFirestoreIdToken()) {
      try {
        const [allProductDocs, auditDocs] = await Promise.all([
          this.runQuery('products'),
          this.runQuery('product_audit_logs'),
        ]);
        for (const a of auditDocs) {
          if (a.data.action === 'delete' && typeof a.data.product_id === 'string') {
            const pid = a.data.product_id;
            deletedIds.add(pid);
            hiddenIds.add(pid);
            this.deletedProductIds.add(pid);
            this.hiddenProductIds.add(pid);
            const starter = INITIAL_SEED_PRODUCTS.find((s) => s.id === pid);
            if (starter) {
              hiddenSlugs.add(starter.slug);
              this.hiddenProductSlugs.add(starter.slug);
            }
          }
        }
        for (const d of allProductDocs) {
          const p = d.data as unknown as FirestoreProductDoc;
          if (p.status === 'published') {
            deletedIds.delete(p.id);
            this.deletedProductIds.delete(p.id);
          } else {
            hiddenIds.add(p.id);
            hiddenSlugs.add(p.slug);
            this.hiddenProductIds.add(p.id);
            this.hiddenProductSlugs.add(p.slug);
          }
        }
      } catch {
        // Ignore transient owner query error
      }
    }

    for (const id of deletedIds) {
      const starter = INITIAL_SEED_PRODUCTS.find((s) => s.id === id);
      if (starter) {
        hiddenSlugs.add(starter.slug);
        this.hiddenProductSlugs.add(starter.slug);
      }
    }

    return { hiddenIds, hiddenSlugs, deletedIds, suppressLegacySeed };
  }

  private async persistCatalogVisibilityMeta(): Promise<void> {
    if (!getActiveFirestoreIdToken()) return;
    try {
      const existing = await this.getDoc('site_documents/settings');
      const currentValue =
        existing && existing.data && existing.data.value
          ? existing.data.value
          : DEFAULT_SITE_SETTINGS;
      await this.setDoc('site_documents/settings', {
        key: 'settings',
        value: currentValue,
        suppress_legacy_seed: this.suppressLegacySeed,
        hidden_product_ids: Array.from(this.hiddenProductIds),
        hidden_product_slugs: Array.from(this.hiddenProductSlugs),
        deleted_product_ids: Array.from(this.deletedProductIds),
        updated_at: Date.now(),
      });
    } catch {
      // Non-fatal if settings write fails
    }
  }

  async seedInitialCatalogIfEmpty(): Promise<void> {
    // Only writes when an authenticated owner token is present in request context.
    if (!getActiveFirestoreIdToken()) {
      return;
    }

    const now = Date.now();
    const [existingCats, existingProducts, existingSettings, existingContent, meta] =
      await Promise.all([
        this.runQuery('categories'),
        this.runQuery('products'),
        this.getDoc('site_documents/settings'),
        this.getDoc('site_documents/content'),
        this.getCatalogVisibilityMeta(),
      ]);

    const existingCatIds = new Set(existingCats.map((c) => c.id));
    const missingCats = INITIAL_SEED_CATEGORIES.filter((c) => !existingCatIds.has(c.id));
    if (missingCats.length > 0) {
      const catWrites = missingCats.map((c, idx) => ({
        update: {
          name: `${this.dbRootResource}/${this.envRelPath}/categories/${c.id}`,
          fields: toFsFields({
            id: c.id,
            name: c.name,
            slug: slugifyProductTitle(c.name),
            subtitle: c.subtitle,
            image_url: c.imageUrl,
            alt_text: c.altText,
            position: c.position ?? idx,
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
        hidden_product_ids: Array.from(meta.hiddenIds),
        hidden_product_slugs: Array.from(meta.hiddenSlugs),
        deleted_product_ids: Array.from(meta.deletedIds),
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

    if (meta.suppressLegacySeed) {
      return;
    }

    const existingProductIds = new Set(existingProducts.map((p) => p.id));
    const missingProducts = INITIAL_SEED_PRODUCTS.filter(
      (p) => !existingProductIds.has(p.id) && !meta.deletedIds.has(p.id)
    );
    if (missingProducts.length > 0) {
      const writes = missingProducts.map((p, idx) => {
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
    const [docs, meta] = await Promise.all([
      this.runQuery('products'),
      this.getCatalogVisibilityMeta(),
    ]);
    const list = docs
      .map((d) => d.data as unknown as FirestoreProductDoc)
      .filter((d) => !meta.deletedIds.has(d.id));
    if (meta.suppressLegacySeed) {
      return list;
    }
    const existingIds = new Set(list.map((d) => d.id));
    const existingSlugs = new Set(list.map((d) => d.slug));
    const now = Date.now();
    INITIAL_SEED_PRODUCTS.forEach((p, idx) => {
      if (
        !existingIds.has(p.id) &&
        !existingSlugs.has(p.slug) &&
        !meta.deletedIds.has(p.id)
      ) {
        const doc = buildSeedStarterProductDoc(p, idx, now);
        if (meta.hiddenIds.has(doc.id) && doc.status === 'published') {
          doc.status = 'draft';
        }
        list.push(doc);
      }
    });
    return list;
  }

  private async getOrMaterializeProductDoc(id: string): Promise<{
    data: FirestoreProductDoc;
    updateTime?: string;
    isStarterFallback: boolean;
  } | null> {
    if (this.deletedProductIds.has(id)) return null;
    const existing = await this.getDoc(`products/${id}`);
    if (existing) {
      return {
        data: existing.data as unknown as FirestoreProductDoc,
        updateTime: existing.updateTime,
        isStarterFallback: false,
      };
    }
    const meta = await this.getCatalogVisibilityMeta();
    if (meta.suppressLegacySeed || meta.deletedIds.has(id)) return null;
    const seedIdx = INITIAL_SEED_PRODUCTS.findIndex(
      (p) => p.id === id || p.id.toLowerCase() === id.toLowerCase() || p.slug === id
    );
    if (seedIdx < 0) return null;
    const seedProduct = INITIAL_SEED_PRODUCTS[seedIdx];
    if (meta.deletedIds.has(seedProduct.id)) return null;
    const doc = buildSeedStarterProductDoc(seedProduct, seedIdx, Date.now());
    if (meta.hiddenIds.has(doc.id) && doc.status === 'published') {
      doc.status = 'draft';
    }
    return {
      data: doc,
      isStarterFallback: true,
    };
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
    const [published, meta] = await Promise.all([
      this.getPublishedProductDocs(),
      this.getCatalogVisibilityMeta(),
    ]);
    let list = published
      .filter((d) => !meta.hiddenIds.has(d.id) && !meta.deletedIds.has(d.id))
      .map((d) => fromFirestoreProduct(d));

    // Ensure starter/catalog products are available unless suppressed, hidden, unpublished, archived, or deleted
    if (!meta.suppressLegacySeed) {
      const existingIds = new Set(list.map((item) => item.product.id));
      const existingSlugs = new Set(list.map((item) => item.product.slug));
      for (const starter of buildStarterReadProducts(Date.now())) {
        if (
          !existingIds.has(starter.product.id) &&
          !existingSlugs.has(starter.product.slug) &&
          !meta.hiddenIds.has(starter.product.id) &&
          !meta.deletedIds.has(starter.product.id) &&
          !meta.hiddenSlugs.has(starter.product.slug)
        ) {
          list.push(starter);
        }
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
          item.product.fabric_note.toLowerCase().includes(term) ||
          (item.product.included_pieces || '').toLowerCase().includes(term) ||
          (item.product.care_note || '').toLowerCase().includes(term)
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
    const [published, meta] = await Promise.all([
      this.getPublishedProductDocs(),
      this.getCatalogVisibilityMeta(),
    ]);
    const match = published.find(
      (d) =>
        !meta.hiddenIds.has(d.id) &&
        !meta.deletedIds.has(d.id) &&
        (d.id === idOrSlug || d.slug === idOrSlug)
    );
    if (match) return fromFirestoreProduct(match);
    if (meta.suppressLegacySeed) return null;

    const starter = buildStarterReadProducts(Date.now()).find(
      (item) => item.product.id === idOrSlug || item.product.slug === idOrSlug
    );
    if (!starter) return null;
    if (
      meta.hiddenIds.has(starter.product.id) ||
      meta.deletedIds.has(starter.product.id) ||
      meta.hiddenSlugs.has(starter.product.slug)
    ) {
      return null;
    }
    // Also check if another published product already replaced this starter ID with a different slug
    if (published.some((d) => d.id === starter.product.id)) {
      return null;
    }
    return starter;
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
    const [products, orders, categories, messageDocs, auditDocs, userDocs] = await Promise.all([
      this.getAllProductDocs(),
      this.getAllOrderDocs(),
      this.listCategories(),
      this.runQuery('contact_messages'),
      this.runQuery('product_audit_logs'),
      this.runQuery('users').catch(() => []),
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

    let totalRevenuePaise = 0;
    let pendingOrders = 0;
    let cancelledOrders = 0;
    let openReturnRequests = 0;

    for (const o of orders) {
      const history = parseOrderHistory(o.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: o.status,
        rawFulfillmentStatus: o.fulfillment_status,
        rawCancelRequest: o.cancel_request_json,
        rawReturnRequest: o.return_request_json,
        rawPaymentStatus: o.payment_status,
        rawRefundStatus: o.refund_status,
        rawCancelledAt: o.cancelled_at,
        rawCancelledBy: o.cancelled_by,
        rawCancelReason: o.cancel_reason,
        razorpayPaymentId: o.razorpay_payment_id,
        history,
        paymentMethod: o.payment_method,
      });

      if (norm.status === 'cancelled') {
        cancelledOrders += 1;
      } else if (isOrderAwaitingDispatch(norm.status)) {
        pendingOrders += 1;
      }

      const isCod =
        o.payment_method === 'cod' || (!o.razorpay_order_id && !o.razorpay_payment_id);
      if (
        norm.status !== 'cancelled' &&
        norm.refundStatus !== 'refunded' &&
        (norm.paymentStatus === 'paid' || (!isCod && ['paid', 'fulfilled'].includes(o.status)))
      ) {
        totalRevenuePaise += Number(o.total_paise || 0);
      }

      if (
        norm.returnRequest?.status === 'pending' ||
        (norm.status !== 'cancelled' && norm.cancelRequest?.status === 'pending')
      ) {
        openReturnRequests += 1;
      }
    }

    const totalCustomers = userDocs.filter(
      (u) => !u.data?.deleted_at && (Boolean(u.data?.email_verified) || Boolean(u.data?.phone_verified))
    ).length;

    const recentOrders: OrderWithItems[] = [...orders]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5)
      .map((o) => ({
        order: normalizeRestOrderRow(o),
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
        cancelledOrders,
        totalRevenuePaise,
        unreadMessages: messages.filter((m) => m.status === 'unread').length,
        totalMessages: messages.length,
        totalAuditEvents: auditLogs.length,
        totalCustomers,
        openReturnRequests,
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
    } else {
      filtered = filtered.filter((p) => p.status !== 'archived');
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
    const doc = await this.getOrMaterializeProductDoc(id);
    if (!doc) return null;
    const prodDoc = doc.data;
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
    images: Array<{
      mediaId: string | null;
      colorId?: string | null;
      url: string;
      alt: string;
      isCover: boolean;
    }>;
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
      included_pieces: input.product.included_pieces ?? '',
      care_note: input.product.care_note ?? '',
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
      import_key: input.product.import_key ?? null,
      source_image_filename: input.product.source_image_filename ?? null,
      pending_fields_json: input.product.pending_fields_json ?? null,
      catalog_batch: input.product.catalog_batch ?? null,
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
        color_id: img.colorId ?? null,
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

    this.deletedProductIds.delete(prodDoc.id);
    if (prodDoc.status === 'published') {
      this.hiddenProductIds.delete(prodDoc.id);
      this.hiddenProductSlugs.delete(prodDoc.slug);
    } else {
      this.hiddenProductIds.add(prodDoc.id);
      this.hiddenProductSlugs.add(prodDoc.slug);
    }
    await this.persistCatalogVisibilityMeta();
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
    includedPieces?: string;
    careNote?: string;
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
    importKey?: string | null;
    sourceImageFilename?: string | null;
    pendingFieldsJson?: string | null;
    catalogBatch?: string | null;
    publishedAtIfNull: number | null;
    now: number;
    variants: ProductVariantRow[];
    images: Array<{
      mediaId: string | null;
      colorId?: string | null;
      url: string;
      alt: string;
      isCover: boolean;
    }>;
    actorUserId: string;
    auditAction: string;
    auditSummary: string;
    auditBefore: unknown;
    auditAfter: unknown;
  }) {
    const existingDoc = await this.getOrMaterializeProductDoc(input.productId);
    if (!existingDoc) return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    const current = existingDoc.data;
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false as const, code: 'VERSION_CONFLICT' as const };
    }

    const updated: FirestoreProductDoc = {
      id: input.productId,
      slug: input.nextSlug,
      title: input.title,
      description: input.description,
      fabric_note: input.fabricNote,
      included_pieces:
        input.includedPieces !== undefined
          ? input.includedPieces
          : (current.included_pieces ?? ''),
      care_note:
        input.careNote !== undefined ? input.careNote : (current.care_note ?? ''),
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
      import_key:
        input.importKey !== undefined ? input.importKey : (current.import_key ?? null),
      source_image_filename:
        input.sourceImageFilename !== undefined
          ? input.sourceImageFilename
          : (current.source_image_filename ?? null),
      pending_fields_json:
        input.pendingFieldsJson !== undefined
          ? input.pendingFieldsJson
          : (current.pending_fields_json ?? null),
      catalog_batch:
        input.catalogBatch !== undefined ? input.catalogBatch : (current.catalog_batch ?? null),
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
        color_id: img.colorId ?? null,
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
      await this.setDoc(
        `products/${input.productId}`,
        updated as unknown as Record<string, unknown>,
        existingDoc.updateTime ? { updateTime: existingDoc.updateTime } : undefined
      );
    } catch (err) {
      if (err instanceof StoreHttpError && err.code === 'VERSION_CONFLICT') {
        return { ok: false as const, code: 'VERSION_CONFLICT' as const };
      }
      throw err;
    }

    this.deletedProductIds.delete(input.productId);
    if (input.nextStatus === 'published') {
      this.hiddenProductIds.delete(input.productId);
      this.hiddenProductSlugs.delete(updated.slug);
    } else {
      this.hiddenProductIds.add(input.productId);
      this.hiddenProductSlugs.add(updated.slug);
      this.hiddenProductSlugs.add(current.slug);
    }
    await this.persistCatalogVisibilityMeta();

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
    const existingDoc = await this.getOrMaterializeProductDoc(sourceId);
    if (!existingDoc) return null;
    const src = existingDoc.data;

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
      color_id: v.color_id ?? null,
      color_name: v.color_name,
      color_hex: v.color_hex,
      price_paise: v.price_paise,
      price_override_paise: v.price_override_paise ?? null,
      compare_at_paise: v.compare_at_paise,
      stock_qty: v.stock_qty,
      active: v.active === undefined || v.active === null ? 1 : v.active ? 1 : 0,
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
    const existingDoc = await this.getOrMaterializeProductDoc(input.productId);
    if (!existingDoc) return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    const current = existingDoc.data;
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false as const, code: 'VERSION_CONFLICT' as const };
    }
    if (input.targetStatus === 'published') {
      if ((current.images || []).length === 0) {
        return { ok: false as const, code: 'NO_IMAGES' as const };
      }
      let parsedColors: Array<{
        id?: string;
        name: string;
        hex?: string;
        thumbnailUrl?: string | null;
        position?: number;
        active?: boolean;
      }> = [];
      try {
        const raw = JSON.parse(current.colors_json || '[]');
        if (Array.isArray(raw)) parsedColors = raw;
      } catch {
        parsedColors = [];
      }
      const matrixCheck = validateColorVariantMatrix({
        status: 'published',
        colors: parsedColors,
        images: (current.images || []).map((img) => ({
          id: img.id,
          url: img.url,
          alt: img.alt_text,
          isCover: Boolean(img.is_cover),
          colorId: img.color_id ?? null,
          position: img.position,
        })),
        variants: (current.variants || []).map((v) => ({
          id: v.id,
          sku: v.sku,
          size: v.size,
          colorId: v.color_id ?? null,
          colorName: v.color_name,
          colorHex: v.color_hex,
          pricePaise: v.price_paise,
          priceOverridePaise: v.price_override_paise ?? null,
          compareAtPaise: v.compare_at_paise,
          stockQty: v.stock_qty,
          active: v.active === undefined || v.active === null ? true : Boolean(v.active),
        })),
      });
      if (!matrixCheck.ok) {
        return {
          ok: false as const,
          code: 'INCOMPLETE_COLOR_VARIANTS' as const,
          message: matrixCheck.error,
        };
      }
    }

    const now = Date.now();
    const canonicalId = String(current.id || input.productId);
    const updated: FirestoreProductDoc = {
      id: canonicalId,
      slug: String(current.slug || canonicalId),
      title: String(current.title || 'Boutique Piece'),
      description: String(current.description || ''),
      fabric_note: String(current.fabric_note || ''),
      category: String(current.category || 'Kurtis'),
      sku: String(current.sku || canonicalId.toUpperCase()),
      price_paise: Math.max(100, Math.round(Number(current.price_paise) || 100)),
      compare_at_paise:
        current.compare_at_paise !== null &&
        current.compare_at_paise !== undefined &&
        Number(current.compare_at_paise) >= 100
          ? Math.round(Number(current.compare_at_paise))
          : null,
      stock_qty: Math.max(0, Math.round(Number(current.stock_qty) || 0)),
      low_stock_threshold: Math.max(0, Math.round(Number(current.low_stock_threshold) ?? 5)),
      featured: Boolean(current.featured),
      status: input.targetStatus,
      colors_json:
        typeof current.colors_json === 'string' && current.colors_json
          ? current.colors_json
          : '[]',
      sizes_json:
        typeof current.sizes_json === 'string' && current.sizes_json
          ? current.sizes_json
          : '["S","M","L","XL"]',
      version: Math.max(1, Math.round(Number(current.version) || 1)) + 1,
      published_at:
        input.targetStatus === 'published'
          ? current.published_at ?? now
          : current.published_at ?? null,
      archived_at: input.targetStatus === 'archived' ? now : null,
      created_at: Math.max(1, Math.round(Number(current.created_at) || now)),
      updated_at: now,
      variants: Array.isArray(current.variants) ? current.variants : [],
      images: Array.isArray(current.images) ? current.images : [],
      variant_skus: Array.isArray(current.variant_skus)
        ? current.variant_skus
        : (current.variants || []).map((v) => v.sku),
      image_urls: Array.isArray(current.image_urls)
        ? current.image_urls
        : (current.images || []).map((i) => i.url),
    };

    try {
      await this.setDoc(
        `products/${canonicalId}`,
        updated as unknown as Record<string, unknown>,
        existingDoc.updateTime ? { updateTime: existingDoc.updateTime } : undefined
      );
    } catch (err) {
      if (err instanceof StoreHttpError && err.code === 'VERSION_CONFLICT') {
        return { ok: false as const, code: 'VERSION_CONFLICT' as const };
      }
      throw err;
    }

    this.deletedProductIds.delete(input.productId);
    if (input.targetStatus === 'published') {
      this.hiddenProductIds.delete(input.productId);
      this.hiddenProductSlugs.delete(updated.slug);
    } else {
      this.hiddenProductIds.add(input.productId);
      this.hiddenProductSlugs.add(updated.slug);
    }
    await this.persistCatalogVisibilityMeta();

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
    const existingDoc = await this.getOrMaterializeProductDoc(productId);
    if (!existingDoc) return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    const current = existingDoc.data;

    const orders = await this.getAllOrderDocs();
    const refCount = this.computeOrderCounts(orders).get(productId) || 0;
    const now = Date.now();
    const starterMatch = INITIAL_SEED_PRODUCTS.find((p) => p.id === productId);

    if (refCount > 0) {
      const archived: FirestoreProductDoc = {
        ...current,
        status: 'archived',
        archived_at: now,
        version: current.version + 1,
        updated_at: now,
      };
      this.hiddenProductIds.add(productId);
      this.hiddenProductSlugs.add(current.slug);
      if (starterMatch) {
        this.hiddenProductSlugs.add(starterMatch.slug);
      }
      await this.persistCatalogVisibilityMeta();

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

    this.deletedProductIds.add(productId);
    this.hiddenProductIds.add(productId);
    this.hiddenProductSlugs.add(current.slug);
    if (starterMatch) {
      this.hiddenProductSlugs.add(starterMatch.slug);
    }
    await this.persistCatalogVisibilityMeta();

    const auditId = crypto.randomUUID();
    const writes: Array<Record<string, unknown>> = [
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
    ];
    if (!existingDoc.isStarterFallback) {
      writes.unshift({
        delete: `${this.dbRootResource}/${this.envRelPath}/products/${productId}`,
      });
    }
    await this.commitBatch(writes);
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

  async savePendingCheckout(record: PendingCheckoutRow): Promise<void> {
    await this.setDoc(
      `pending_checkouts/${record.id}`,
      record as unknown as Record<string, unknown>
    );
  }

  async getPendingCheckout(razorpayOrderId: string): Promise<PendingCheckoutRow | null> {
    const doc = await this.getDoc(`pending_checkouts/${razorpayOrderId}`);
    if (!doc) return null;
    return doc.data as unknown as PendingCheckoutRow;
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
    if (input.id) {
      const existingById = await this.getDoc(`orders/${input.id}`).catch(() => null);
      if (existingById) {
        const d = existingById.data as unknown as FirestoreOrderDoc;
        return { order: normalizeRestOrderRow(d), items: d.items || [] };
      }
    }
    const cleanIdempotencyKey = input.idempotencyKey?.trim() || null;
    if (cleanIdempotencyKey) {
      const existingByKey = await this.runQuery('orders', {
        where: {
          fieldFilter: {
            field: { fieldPath: 'idempotency_key' },
            op: 'EQUAL',
            value: { stringValue: cleanIdempotencyKey },
          },
        },
        limit: 1,
      }).catch(() => []);
      if (existingByKey[0]) {
        const d = existingByKey[0].data as unknown as FirestoreOrderDoc;
        return { order: normalizeRestOrderRow(d), items: d.items || [] };
      }
    }
    if (input.razorpayOrderId) {
      const existingByRzp = await this.runQuery('orders', {
        where: {
          fieldFilter: {
            field: { fieldPath: 'razorpay_order_id' },
            op: 'EQUAL',
            value: { stringValue: input.razorpayOrderId },
          },
        },
        limit: 1,
      }).catch(() => []);
      if (existingByRzp[0]) {
        const d = existingByRzp[0].data as unknown as FirestoreOrderDoc;
        return { order: normalizeRestOrderRow(d), items: d.items || [] };
      }
    }

    const publishedMap = await this.getPublicProductsMap();
    const now = Date.now();
    const orderId = input.id || crypto.randomUUID();
    const orderNumber =
      input.orderNumber ||
      `SC-${now.toString(36).toUpperCase().slice(-5)}${crypto
        .randomBytes(2)
        .toString('hex')
        .toUpperCase()}`;

    let subtotalPaise = 0;
    const orderItems: OrderItemRow[] = [];
    const productIds = new Set<string>();
    const pendingStockUpdates = new Map<string, ProductWithParts>();

    for (const reqItem of input.items) {
      const prodWrap = pendingStockUpdates.get(reqItem.productId) || publishedMap.get(reqItem.productId);
      if (!prodWrap) {
        throw new StoreHttpError(
          409,
          'PRODUCT_UNAVAILABLE',
          'An item in your bag is no longer available.'
        );
      }
      const variant =
        prodWrap.variants.find((v) => v.id === reqItem.variantId || v.sku === reqItem.variantId) ||
        prodWrap.variants.find((v) => (v.active === undefined || v.active === null ? true : Boolean(v.active))) ||
        prodWrap.variants[0];
      if (!variant) {
        throw new StoreHttpError(
          409,
          'VARIANT_UNAVAILABLE',
          `Selected size/color for "${prodWrap.product.title}" is no longer available.`
        );
      }
      const variantActive =
        variant.active === undefined || variant.active === null ? true : Boolean(variant.active);
      const colorActive = isVariantColorActiveInMetadata(prodWrap.product.colors_json, variant);
      if (!variantActive || !colorActive) {
        throw new StoreHttpError(
          409,
          'VARIANT_UNAVAILABLE',
          `Selected colour/size (${variant.color_name} · ${variant.size}) for "${prodWrap.product.title}" is no longer available.`
        );
      }
      if (reqItem.expectedPricePaise !== null && reqItem.expectedPricePaise !== variant.price_paise) {
        throw new StoreHttpError(
          409,
          'PRICE_CHANGED',
          `Price for "${prodWrap.product.title}" (${variant.color_name} · ${variant.size}) has been updated. Review your bag before placing the order.`
        );
      }
      if (variant.stock_qty < reqItem.quantity) {
        throw new StoreHttpError(
          409,
          'INSUFFICIENT_STOCK',
          `Only ${variant.stock_qty} piece(s) left for "${prodWrap.product.title}" (${variant.color_name} · ${variant.size}).`
        );
      }

      const nextVariants = prodWrap.variants.map((v) =>
        v.id === variant.id ? { ...v, stock_qty: v.stock_qty - reqItem.quantity } : v
      );
      const nextTotalStock = nextVariants.reduce(
        (sum, v) =>
          sum +
          ((v.active === undefined || v.active === null ? true : Boolean(v.active))
            ? v.stock_qty
            : 0),
        0
      );
      pendingStockUpdates.set(prodWrap.product.id, {
        ...prodWrap,
        product: { ...prodWrap.product, stock_qty: nextTotalStock, updated_at: now },
        variants: nextVariants,
      });

      const lineTotal = variant.price_paise * reqItem.quantity;
      subtotalPaise += lineTotal;
      productIds.add(prodWrap.product.id);
      const imageUrl = resolveVariantSnapshotImageUrl(
        prodWrap.product.colors_json,
        prodWrap.images || [],
        variant
      );

      orderItems.push({
        id: crypto.randomUUID(),
        order_id: orderId,
        product_id: prodWrap.product.id,
        variant_id: variant.id,
        product_title: prodWrap.product.title,
        variant_label: formatVariantDisplayLabel(variant.color_name, variant.size),
        color_name: variant.color_name,
        size: variant.size,
        image_url: imageUrl,
        sku: variant.sku,
        unit_price_paise: variant.price_paise,
        quantity: reqItem.quantity,
        line_total_paise: lineTotal,
      });
    }

    const cleanCouponCode = input.couponCode?.trim().toUpperCase() || null;
    const cleanGiftCardCode = input.giftCardCode?.trim().toUpperCase() || null;
    const discountPaise = Math.max(0, Math.min(subtotalPaise, Math.round(input.discountPaise || 0)));
    const giftCardPaise = Math.max(
      0,
      Math.min(subtotalPaise - discountPaise, Math.round(input.giftCardPaise || 0))
    );
    const totalPaise = Math.max(0, subtotalPaise - discountPaise - giftCardPaise);

    const paymentMethod = input.paymentMethod || 'cod';
    const status = input.status || (paymentMethod === 'cod' ? 'placed' : 'pending');
    const paymentStatus = input.paymentStatus || (paymentMethod === 'razorpay' ? 'paid' : 'unpaid');
    const fulfillmentStatus =
      input.fulfillmentStatus || (status === 'confirmed' ? 'confirmed' : 'placed');
    const paymentCollectedAt =
      paymentStatus === 'paid' ? now : null;
    const statusHistory: OrderStatusHistoryEntry[] =
      input.statusHistory && input.statusHistory.length > 0
        ? input.statusHistory
        : [
            {
              status: fulfillmentStatus,
              note:
                paymentMethod === 'razorpay'
                  ? 'Payment verified via Razorpay'
                  : 'Cash on Delivery order placed · Payment due on delivery',
              actor: 'system',
              at: now,
            },
          ];
    const statusHistoryJson = JSON.stringify(statusHistory);

    const orderDoc: FirestoreOrderDoc = {
      id: orderId,
      order_number: orderNumber,
      customer_user_id: input.customerUserId,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      customer_phone: input.customerPhone,
      shipping_address: input.shippingAddress,
      status,
      payment_status: paymentStatus,
      fulfillment_status: fulfillmentStatus,
      payment_method: paymentMethod,
      razorpay_order_id: input.razorpayOrderId || null,
      razorpay_payment_id: input.razorpayPaymentId || null,
      coupon_code: cleanCouponCode,
      gift_card_code: cleanGiftCardCode,
      discount_paise: discountPaise,
      gift_card_paise: giftCardPaise,
      status_history_json: statusHistoryJson,
      return_request_json: null,
      idempotency_key: cleanIdempotencyKey,
      payment_collected_at: paymentCollectedAt,
      payment_collected_by: null,
      subtotal_paise: subtotalPaise,
      total_paise: totalPaise,
      currency: 'INR',
      created_at: now,
      updated_at: now,
      product_ids: Array.from(productIds),
      items: orderItems,
    };

    await this.setDoc(`orders/${orderId}`, orderDoc as unknown as Record<string, unknown>);

    // Best-effort stock, coupon, gift card, and notification updates when permissions allow
    for (const [pid, updatedWrap] of pendingStockUpdates.entries()) {
      const prodDoc = await this.getDoc(`products/${pid}`).catch(() => null);
      if (prodDoc) {
        await this.patchDoc(`products/${pid}`, {
          variants: updatedWrap.variants,
          stock_qty: updatedWrap.product.stock_qty,
          updated_at: now,
        }).catch(() => {});
      }
    }
    if (cleanCouponCode) {
      const cpn = await this.getCouponByCode(cleanCouponCode).catch(() => null);
      if (cpn) {
        await this.patchDoc(`coupons/${cpn.id}`, {
          used_count: Number(cpn.used_count || 0) + 1,
          updated_at: now,
        }).catch(() => {});
      }
    }
    if (cleanGiftCardCode && giftCardPaise > 0) {
      const gc = await this.getGiftCardByCode(cleanGiftCardCode).catch(() => null);
      if (gc) {
        await this.patchDoc(`gift_cards/${gc.id}`, {
          balance_paise: Math.max(0, Number(gc.balance_paise || 0) - giftCardPaise),
          last_used_at: now,
          updated_at: now,
        }).catch(() => {});
      }
    }
    if (input.customerUserId) {
      await this.createCustomerNotification({
        id: `notif_placed_${orderId}`,
        userId: input.customerUserId,
        type: 'order_placed',
        title: `Order ${orderNumber} placed`,
        message:
          paymentMethod === 'razorpay'
            ? `Payment verified for order ${orderNumber} (₹${(totalPaise / 100).toLocaleString('en-IN')}).`
            : `Your boutique order ${orderNumber} has been received.`,
        orderId,
        orderNumber,
      }).catch(() => {});
    }

    return { order: normalizeRestOrderRow(orderDoc), items: orderItems };
  }

  async getOrderById(orderId: string): Promise<OrderWithItems | null> {
    const doc = await this.getDoc(`orders/${orderId}`);
    if (!doc) return null;
    const d = doc.data as unknown as FirestoreOrderDoc;
    return { order: normalizeRestOrderRow(d), items: d.items || [] };
  }

  async listCustomerOrders(userId: string): Promise<OrderWithItems[]> {
    const docs = await this.runQuery('orders', {
      where: {
        fieldFilter: {
          field: { fieldPath: 'customer_user_id' },
          op: 'EQUAL',
          value: { stringValue: userId },
        },
      },
    });
    return docs
      .map((d) => d.data as unknown as FirestoreOrderDoc)
      .filter((d) => !d.hidden_by_customer)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at))
      .map((d) => ({ order: normalizeRestOrderRow(d), items: d.items || [] }));
  }

  async listAdminOrders(page: number, pageSize: number) {
    const orders = (await this.getAllOrderDocs()).sort((a, b) => b.created_at - a.created_at);
    const total = orders.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    const items: OrderWithItems[] = orders.slice(offset, offset + pageSize).map((o) => ({
      order: normalizeRestOrderRow(o),
      items: o.items || [],
    }));

    return { items, total, page, pageSize, totalPages };
  }

  async updateOrderStatus(orderId: string, nextStatus: string): Promise<boolean> {
    const updated = await this.updateOrderStatusWithHistory(orderId, nextStatus, {
      actor: 'owner',
      notifyCustomer: true,
    });
    return Boolean(updated);
  }

  private async restoreRestOrderStock(items: OrderItemRow[], now: number): Promise<void> {
    const qtyByProductAndVariant = new Map<string, Map<string | null, number>>();
    for (const item of items) {
      const qty = Math.max(0, Number(item.quantity || 0));
      if (qty <= 0) continue;
      const inner = qtyByProductAndVariant.get(item.product_id) || new Map<string | null, number>();
      inner.set(item.variant_id || null, (inner.get(item.variant_id || null) || 0) + qty);
      qtyByProductAndVariant.set(item.product_id, inner);
    }
    for (const [pid, varMap] of qtyByProductAndVariant.entries()) {
      const pDoc = await this.getDoc(`products/${pid}`).catch(() => null);
      if (!pDoc) continue;
      const prodData = pDoc.data as unknown as FirestoreProductDoc;
      const clonedVariants = (prodData.variants || []).map((v) => ({ ...v }));
      for (const [vid, qty] of varMap.entries()) {
        const vIdx = vid ? clonedVariants.findIndex((v) => v.id === vid) : 0;
        if (vIdx >= 0) {
          clonedVariants[vIdx].stock_qty = Number(clonedVariants[vIdx].stock_qty || 0) + qty;
        }
      }
      const nextStock = clonedVariants.reduce(
        (sum, v) =>
          sum + ((v.active === undefined || v.active === null ? true : Boolean(v.active)) ? Number(v.stock_qty || 0) : 0),
        0
      );
      await this.patchDoc(`products/${pid}`, {
        variants: clonedVariants,
        stock_qty: nextStock,
        updated_at: now,
      }).catch(() => {});
    }
  }

  async updateOrderStatusWithHistory(
    orderId: string,
    nextStatus: string,
    options?: {
      actor?: 'owner' | 'system' | 'customer';
      note?: string;
      notifyCustomer?: boolean;
      expectedUpdatedAt?: number | null;
      paymentStatus?: string;
      refundStatus?: string;
    }
  ): Promise<OrderWithItems | null> {
    const existing = await this.getDoc(`orders/${orderId}`);
    if (!existing) return null;
    const docData = existing.data as unknown as FirestoreOrderDoc;

    if (
      typeof options?.expectedUpdatedAt === 'number' &&
      Number.isFinite(options.expectedUpdatedAt) &&
      Number(docData.updated_at || docData.created_at || 0) !== Number(options.expectedUpdatedAt)
    ) {
      throw new StoreHttpError(
        409,
        'CONCURRENCY_CONFLICT',
        'This order was updated elsewhere. Refresh to view the latest status before saving.'
      );
    }

    const history = parseOrderHistory(docData.status_history_json);
    const norm = normalizeOrderRequestsAndStatus({
      rawStatus: docData.status,
      rawFulfillmentStatus: docData.fulfillment_status,
      rawCancelRequest: docData.cancel_request_json,
      rawReturnRequest: docData.return_request_json,
      rawPaymentStatus: docData.payment_status,
      rawRefundStatus: docData.refund_status,
      rawCancelledAt: docData.cancelled_at,
      rawCancelledBy: docData.cancelled_by,
      rawCancelReason: docData.cancel_reason,
      razorpayPaymentId: docData.razorpay_payment_id,
      history,
      paymentMethod: docData.payment_method,
    });

    const transition = validateOrderStatusTransition(norm.status, nextStatus);
    if (!transition.ok) {
      throw new StoreHttpError(
        transition.code === 'VALIDATION_ERROR' ? 400 : 409,
        transition.code,
        transition.error
      );
    }

    const normalizedNext = normalizeRawOrderStatusValue(nextStatus);
    const now = Date.now();
    const payNorm = normalizePaymentAndRefundStatus({
      rawPaymentStatus: options?.paymentStatus ?? docData.payment_status,
      rawRefundStatus: options?.refundStatus ?? docData.refund_status,
      paymentMethod: docData.payment_method,
      orderStatus: normalizedNext,
      razorpayPaymentId: docData.razorpay_payment_id,
    });

    const changed =
      norm.status !== normalizedNext ||
      docData.status !== normalizedNext ||
      docData.fulfillment_status !== normalizedNext;
    const refundChanged =
      Boolean(options?.refundStatus) && payNorm.refundStatus !== norm.refundStatus;

    if (changed || refundChanged || options?.note) {
      history.push({
        status: changed ? normalizedNext : `refund_${payNorm.refundStatus}`,
        note: options?.note?.trim() || undefined,
        actor: options?.actor || 'owner',
        at: now,
      });
    }

    const shouldRestoreStock = normalizedNext === 'cancelled' && !docData.stock_restored_at;
    const patch: Record<string, unknown> = {
      status: normalizedNext,
      fulfillment_status: normalizedNext,
      payment_status: payNorm.paymentStatus,
      refund_status: payNorm.refundStatus,
      cancelled_at:
        normalizedNext === 'cancelled'
          ? docData.cancelled_at ?? norm.cancelledAt ?? now
          : docData.cancelled_at ?? null,
      cancelled_by:
        normalizedNext === 'cancelled'
          ? docData.cancelled_by ?? norm.cancelledBy ?? options?.actor ?? 'owner'
          : docData.cancelled_by ?? null,
      cancel_reason:
        normalizedNext === 'cancelled'
          ? docData.cancel_reason ?? norm.cancelReason ?? (options?.note?.trim().slice(0, 500) || null)
          : docData.cancel_reason ?? null,
      stock_restored_at: shouldRestoreStock ? now : docData.stock_restored_at ?? null,
      status_history_json: JSON.stringify(history),
      updated_at: now,
    };

    await this.patchDoc(`orders/${orderId}`, patch, {
      updateTime: existing.updateTime,
    });

    if (shouldRestoreStock) {
      await this.restoreRestOrderStock(docData.items || [], now);
    }

    if (options?.notifyCustomer !== false && changed && docData.customer_user_id) {
      const label = normalizedNext.replace(/_/g, ' ');
      await this.createCustomerNotification({
        id: `notif_status_${orderId}_${normalizedNext}_${now}`,
        userId: docData.customer_user_id,
        type: 'order_status',
        title: `Order ${docData.order_number} is now ${label}`,
        message: options?.note?.trim()
          ? `${options.note.trim()} (Order ${docData.order_number})`
          : `Your order ${docData.order_number} status has been updated to ${label}.`,
        orderId,
        orderNumber: docData.order_number,
      }).catch(() => {});
    }

    const updatedDoc: FirestoreOrderDoc = { ...docData, ...(patch as Partial<FirestoreOrderDoc>) };
    return { order: normalizeRestOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async cancelCustomerOrder(input: {
    orderId: string;
    userId: string;
    reason?: string;
    expectedUpdatedAt?: number | null;
  }): Promise<{ orderWithItems: OrderWithItems; alreadyCancelled: boolean } | null> {
    const cleanReason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    const existing = await this.getDoc(`orders/${input.orderId}`);
    if (!existing) return null;
    const docData = existing.data as unknown as FirestoreOrderDoc;

    if (docData.customer_user_id !== input.userId) {
      throw new StoreHttpError(
        403,
        'FORBIDDEN',
        'You can only cancel orders belonging to your own account.'
      );
    }

    const history = parseOrderHistory(docData.status_history_json);
    const norm = normalizeOrderRequestsAndStatus({
      rawStatus: docData.status,
      rawFulfillmentStatus: docData.fulfillment_status,
      rawCancelRequest: docData.cancel_request_json,
      rawReturnRequest: docData.return_request_json,
      rawPaymentStatus: docData.payment_status,
      rawRefundStatus: docData.refund_status,
      rawCancelledAt: docData.cancelled_at,
      rawCancelledBy: docData.cancelled_by,
      rawCancelReason: docData.cancel_reason,
      razorpayPaymentId: docData.razorpay_payment_id,
      history,
      paymentMethod: docData.payment_method,
    });

    if (norm.status === 'cancelled') {
      return {
        orderWithItems: { order: normalizeRestOrderRow(docData), items: docData.items || [] },
        alreadyCancelled: true,
      };
    }

    if (
      typeof input.expectedUpdatedAt === 'number' &&
      Number.isFinite(input.expectedUpdatedAt) &&
      Number(docData.updated_at || docData.created_at || 0) !== Number(input.expectedUpdatedAt)
    ) {
      throw new StoreHttpError(
        409,
        'CONCURRENCY_CONFLICT',
        'This order was updated just before your request. Please refresh and check its latest status.'
      );
    }

    if (!PRE_SHIPPING_CANCEL_STATES.has(norm.status)) {
      throw new StoreHttpError(
        409,
        'CANCELLATION_CUTOFF_PASSED',
        `Cancellation is unavailable once an order is ${norm.status}.`
      );
    }

    const now = Date.now();
    const refundStatus = norm.paymentStatus === 'paid' ? 'pending_refund' : 'not_required';
    const cancelRequestRecord: OrderReturnRequestRecord = {
      id: norm.cancelRequest?.id || `req_${crypto.randomUUID().slice(0, 12)}`,
      type: 'cancel',
      reason: cleanReason || norm.cancelRequest?.reason || 'Cancelled by customer',
      status: 'approved',
      requestedAt: norm.cancelRequest?.requestedAt || now,
      updatedAt: now,
      resolvedAt: now,
      resolutionNote: 'Cancelled directly by customer before shipment',
    };

    history.push({
      status: 'cancelled',
      note: cleanReason || 'Cancelled by customer before shipment',
      actor: 'customer',
      at: now,
    });

    const patch: Record<string, unknown> = {
      status: 'cancelled',
      fulfillment_status: 'cancelled',
      refund_status: refundStatus,
      cancelled_at: now,
      cancelled_by: 'customer',
      cancel_reason: cleanReason || null,
      cancel_request: cancelRequestRecord,
      cancel_request_json: JSON.stringify(cancelRequestRecord),
      status_history_json: JSON.stringify(history),
      updated_at: now,
    };

    await this.patchDoc(`orders/${input.orderId}`, patch, {
      updateTime: existing.updateTime,
    });

    if (!docData.stock_restored_at) {
      await this.restoreRestOrderStock(docData.items || [], now).catch(() => {});
    }

    if (docData.customer_user_id) {
      await this.createCustomerNotification({
        id: `notif_cancelled_${input.orderId}`,
        userId: docData.customer_user_id,
        type: 'order_status',
        title: `Order ${docData.order_number} cancelled`,
        message: cleanReason
          ? `Your order ${docData.order_number} has been cancelled (${cleanReason}).`
          : `Your order ${docData.order_number} has been cancelled.`,
        orderId: input.orderId,
        orderNumber: docData.order_number,
      }).catch(() => {});
    }

    const updatedDoc: FirestoreOrderDoc = { ...docData, ...(patch as Partial<FirestoreOrderDoc>) };
    return {
      orderWithItems: { order: normalizeRestOrderRow(updatedDoc), items: updatedDoc.items || [] },
      alreadyCancelled: false,
    };
  }

  async collectOrderPayment(input: {
    orderId: string;
    actorUserId?: string | null;
    note?: string;
  }): Promise<OrderWithItems | null> {
    const existing = await this.getDoc(`orders/${input.orderId}`);
    if (!existing) return null;
    const docData = existing.data as unknown as FirestoreOrderDoc;
    const fulfillment = docData.fulfillment_status || docData.status || 'placed';
    if (fulfillment === 'cancelled' || docData.status === 'cancelled') {
      throw new StoreHttpError(
        409,
        'ORDER_CANCELLED',
        'Payment cannot be collected for a cancelled order.'
      );
    }
    if (docData.payment_status === 'paid') {
      return { order: normalizeRestOrderRow(docData), items: docData.items || [] };
    }

    const now = Date.now();
    let history: OrderStatusHistoryEntry[] = [];
    try {
      const parsed = JSON.parse(docData.status_history_json || '[]') as unknown;
      if (Array.isArray(parsed)) history = parsed as OrderStatusHistoryEntry[];
    } catch {
      history = [];
    }
    const cleanNote = input.note?.trim() || 'Cash payment collected on delivery';
    history.push({
      status: 'payment_collected',
      note: cleanNote,
      actor: 'owner',
      at: now,
    });

    const patch = {
      payment_status: 'paid',
      payment_collected_at: now,
      payment_collected_by: input.actorUserId || null,
      status_history_json: JSON.stringify(history),
      updated_at: now,
    };
    await this.patchDoc(`orders/${input.orderId}`, patch);

    if (docData.customer_user_id) {
      await this.createCustomerNotification({
        id: `notif_paid_${input.orderId}_${now}`,
        userId: docData.customer_user_id,
        type: 'order_status',
        title: `Payment collected for ${docData.order_number}`,
        message: `We have recorded payment collection for order ${docData.order_number}.`,
        orderId: input.orderId,
        orderNumber: docData.order_number,
      }).catch(() => {});
    }

    const updatedDoc: FirestoreOrderDoc = { ...docData, ...patch };
    return { order: normalizeRestOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async submitOrderReturnRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    reason: string;
  }): Promise<OrderWithItems | null> {
    return this.submitOrderRequest(input);
  }

  async submitOrderRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    reason: string;
  }): Promise<OrderWithItems | null> {
    if (input.type === 'cancel') {
      const result = await this.cancelCustomerOrder({
        orderId: input.orderId,
        userId: input.userId,
        reason: input.reason,
      });
      return result ? result.orderWithItems : null;
    }

    const cleanReason = input.reason.trim().slice(0, 500);
    if (cleanReason.length < 3) {
      throw new StoreHttpError(
        400,
        'VALIDATION_ERROR',
        'Please provide a brief reason (at least 3 characters).'
      );
    }

    const existing = await this.getDoc(`orders/${input.orderId}`);
    if (!existing) return null;
    const docData = existing.data as unknown as FirestoreOrderDoc;
    if (docData.customer_user_id !== input.userId) {
      throw new StoreHttpError(403, 'FORBIDDEN', 'You can only request changes for your own orders.');
    }

    const history = parseOrderHistory(docData.status_history_json);
    const norm = normalizeOrderRequestsAndStatus({
      rawStatus: docData.status,
      rawFulfillmentStatus: docData.fulfillment_status,
      rawCancelRequest: docData.cancel_request_json,
      rawReturnRequest: docData.return_request_json,
      rawPaymentStatus: docData.payment_status,
      rawRefundStatus: docData.refund_status,
      rawCancelledAt: docData.cancelled_at,
      rawCancelledBy: docData.cancelled_by,
      rawCancelReason: docData.cancel_reason,
      razorpayPaymentId: docData.razorpay_payment_id,
      history,
      paymentMethod: docData.payment_method,
    });

    if (!RETURN_ELIGIBLE_STATES.has(norm.fulfillmentStatus)) {
      throw new StoreHttpError(
        409,
        'RETURN_NOT_ELIGIBLE',
        'Return requests can only be submitted after your order is delivered.'
      );
    }
    if (norm.returnRequest?.status === 'pending') {
      if (norm.returnRequest.reason === cleanReason) {
        return { order: normalizeRestOrderRow(docData), items: docData.items || [] };
      }
      throw new StoreHttpError(
        409,
        'REQUEST_ALREADY_PENDING',
        'A return request is already pending for this order. You can edit or withdraw it below.'
      );
    }

    const now = Date.now();
    const requestRecord: OrderReturnRequestRecord = {
      id: `req_${crypto.randomUUID().slice(0, 12)}`,
      type: 'return',
      reason: cleanReason,
      status: 'pending',
      requestedAt: now,
      updatedAt: now,
      resolvedAt: null,
    };

    history.push({
      status: 'return_requested',
      note: cleanReason,
      actor: 'customer',
      at: now,
    });

    const patch: Record<string, unknown> = {
      status_history_json: JSON.stringify(history),
      updated_at: now,
      return_request: requestRecord,
      return_request_json: JSON.stringify(requestRecord),
    };
    await this.patchDoc(`orders/${input.orderId}`, patch, {
      updateTime: existing.updateTime,
    });

    const updatedDoc: FirestoreOrderDoc = { ...docData, ...(patch as Partial<FirestoreOrderDoc>) };
    return { order: normalizeRestOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async updateOrderRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    action: 'edit' | 'withdraw';
    reason?: string;
  }): Promise<OrderWithItems | null> {
    const existing = await this.getDoc(`orders/${input.orderId}`);
    if (!existing) return null;
    const docData = existing.data as unknown as FirestoreOrderDoc;
    if (docData.customer_user_id !== input.userId) {
      throw new StoreHttpError(403, 'FORBIDDEN', 'You can only update requests for your own orders.');
    }

    const history = parseOrderHistory(docData.status_history_json);
    const norm = normalizeOrderRequestsAndStatus({
      rawStatus: docData.status,
      rawFulfillmentStatus: docData.fulfillment_status,
      rawCancelRequest: docData.cancel_request_json,
      rawReturnRequest: docData.return_request_json,
      history,
      paymentMethod: docData.payment_method,
    });

    const target = input.type === 'cancel' ? norm.cancelRequest : norm.returnRequest;
    if (!target) {
      throw new StoreHttpError(404, 'REQUEST_NOT_FOUND', 'No request was found on this order.');
    }
    if (target.status !== 'pending') {
      throw new StoreHttpError(
        409,
        'CONCURRENCY_CONFLICT',
        `This request is already ${target.status} and can no longer be changed.`
      );
    }

    const now = Date.now();
    let updatedTarget: OrderReturnRequestRecord;
    if (input.action === 'withdraw') {
      updatedTarget = {
        ...target,
        status: 'withdrawn',
        updatedAt: now,
        resolvedAt: now,
      };
      history.push({
        status: `${input.type}_withdrawn`,
        note: 'Customer withdrew pending request',
        actor: 'customer',
        at: now,
      });
    } else {
      const cleanReason = (input.reason || '').trim().slice(0, 500);
      if (cleanReason.length < 3) {
        throw new StoreHttpError(
          400,
          'VALIDATION_ERROR',
          'Please provide a reason of at least 3 characters.'
        );
      }
      updatedTarget = {
        ...target,
        reason: cleanReason,
        updatedAt: now,
      };
      history.push({
        status: `${input.type}_request_updated`,
        note: cleanReason,
        actor: 'customer',
        at: now,
      });
    }

    const patch: Record<string, unknown> = {
      status_history_json: JSON.stringify(history),
      updated_at: now,
      ...(input.type === 'cancel'
        ? {
            cancel_request: updatedTarget,
            cancel_request_json: JSON.stringify(updatedTarget),
          }
        : {
            return_request: updatedTarget,
            return_request_json: JSON.stringify(updatedTarget),
          }),
    };
    await this.patchDoc(`orders/${input.orderId}`, patch, {
      updateTime: existing.updateTime,
    });

    const updatedDoc: FirestoreOrderDoc = { ...docData, ...patch };
    return { order: normalizeRestOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async updateOrderDeliveryDetails(input: {
    orderId: string;
    userId: string;
    customerName?: string;
    customerPhone?: string;
    shippingAddress?: string;
  }): Promise<OrderWithItems | null> {
    const existing = await this.getDoc(`orders/${input.orderId}`);
    if (!existing) return null;
    const docData = existing.data as unknown as FirestoreOrderDoc;
    if (docData.customer_user_id !== input.userId) {
      throw new StoreHttpError(403, 'FORBIDDEN', 'You can only edit delivery details for your own orders.');
    }

    const history = parseOrderHistory(docData.status_history_json);
    const norm = normalizeOrderRequestsAndStatus({
      rawStatus: docData.status,
      rawFulfillmentStatus: docData.fulfillment_status,
      rawCancelRequest: docData.cancel_request_json,
      rawReturnRequest: docData.return_request_json,
      history,
      paymentMethod: docData.payment_method,
    });

    if (!PRE_CUTOFF_DELIVERY_EDIT_STATES.has(norm.fulfillmentStatus)) {
      throw new StoreHttpError(
        409,
        'DELIVERY_CUTOFF_PASSED',
        `Delivery details cannot be changed once your order is ${norm.fulfillmentStatus}.`
      );
    }

    const cleanName =
      typeof input.customerName === 'string'
        ? input.customerName.trim()
        : String(docData.customer_name || '').trim();
    const cleanPhone =
      typeof input.customerPhone === 'string'
        ? input.customerPhone.trim()
        : String(docData.customer_phone || '').trim();
    const cleanAddress =
      typeof input.shippingAddress === 'string'
        ? input.shippingAddress.trim()
        : String(docData.shipping_address || '').trim();
    if (cleanName.length < 2 || cleanPhone.length < 6 || cleanAddress.length < 5) {
      throw new StoreHttpError(
        400,
        'VALIDATION_ERROR',
        'Please provide valid recipient name, phone number, and delivery address.'
      );
    }

    const now = Date.now();
    history.push({
      status: 'delivery_updated',
      note: 'Customer updated recipient / delivery address before dispatch',
      actor: 'customer',
      at: now,
    });

    const patch: Record<string, unknown> = {
      customer_name: cleanName.slice(0, 120),
      customer_phone: cleanPhone.slice(0, 32),
      shipping_address: cleanAddress.slice(0, 600),
      delivery_details_edited_at: now,
      status_history_json: JSON.stringify(history),
      updated_at: now,
    };
    await this.patchDoc(`orders/${input.orderId}`, patch, {
      updateTime: existing.updateTime,
    });

    const updatedDoc: FirestoreOrderDoc = { ...docData, ...patch };
    return { order: normalizeRestOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async hideOrderForCustomer(orderId: string, userId: string): Promise<boolean> {
    const existing = await this.getDoc(`orders/${orderId}`);
    if (!existing) return false;
    const docData = existing.data as unknown as FirestoreOrderDoc;
    if (docData.customer_user_id !== userId) {
      throw new StoreHttpError(403, 'FORBIDDEN', 'You can only hide orders from your own account.');
    }
    const now = Date.now();
    await this.patchDoc(`orders/${orderId}`, {
      hidden_by_customer: true,
      hidden_at: now,
      updated_at: now,
    });
    return true;
  }

  async resolveOrderReturnRequest(input: {
    orderId: string;
    requestType?: 'cancel' | 'return';
    decision: 'approved' | 'rejected';
    note?: string;
  }): Promise<OrderWithItems | null> {
    const existing = await this.getDoc(`orders/${input.orderId}`);
    if (!existing) return null;
    const docData = existing.data as unknown as FirestoreOrderDoc;

    const history = parseOrderHistory(docData.status_history_json);
    const norm = normalizeOrderRequestsAndStatus({
      rawStatus: docData.status,
      rawFulfillmentStatus: docData.fulfillment_status,
      rawCancelRequest: docData.cancel_request_json,
      rawReturnRequest: docData.return_request_json,
      history,
      paymentMethod: docData.payment_method,
    });

    const target =
      input.requestType === 'cancel'
        ? norm.cancelRequest
        : input.requestType === 'return'
          ? norm.returnRequest
          : norm.cancelRequest?.status === 'pending'
            ? norm.cancelRequest
            : norm.returnRequest?.status === 'pending'
              ? norm.returnRequest
              : norm.cancelRequest || norm.returnRequest;

    if (!target) return null;
    if (target.status !== 'pending') {
      throw new StoreHttpError(
        409,
        'CONCURRENCY_CONFLICT',
        `Cannot ${input.decision === 'approved' ? 'approve' : 'reject'} request because its status is already "${target.status}".`
      );
    }

    const now = Date.now();
    const updatedReq: OrderReturnRequestRecord = {
      ...target,
      status: input.decision,
      updatedAt: now,
      resolvedAt: now,
      ...(input.note?.trim() ? { resolutionNote: input.note.trim().slice(0, 300) } : {}),
    };

    const nextFulfillment =
      input.decision === 'approved'
        ? updatedReq.type === 'cancel'
          ? 'cancelled'
          : 'returned'
        : norm.fulfillmentStatus;
    const nextStatus = nextFulfillment;

    history.push({
      status: `${updatedReq.type}_${input.decision}`,
      note: updatedReq.resolutionNote || `Request ${input.decision} by store owner`,
      actor: 'owner',
      at: now,
    });

    const payNorm = normalizePaymentAndRefundStatus({
      rawPaymentStatus: docData.payment_status,
      rawRefundStatus: docData.refund_status,
      paymentMethod: docData.payment_method,
      orderStatus: nextStatus,
      razorpayPaymentId: docData.razorpay_payment_id,
    });

    const patch: Record<string, unknown> = {
      status: nextStatus,
      fulfillment_status: nextFulfillment,
      refund_status: payNorm.refundStatus,
      cancelled_at: nextStatus === 'cancelled' ? docData.cancelled_at ?? now : docData.cancelled_at ?? null,
      cancelled_by: nextStatus === 'cancelled' ? docData.cancelled_by ?? 'owner' : docData.cancelled_by ?? null,
      cancel_reason: nextStatus === 'cancelled' ? docData.cancel_reason ?? updatedReq.reason ?? null : docData.cancel_reason ?? null,
      cancel_request_json:
        updatedReq.type === 'cancel'
          ? JSON.stringify(updatedReq)
          : norm.cancelRequest
            ? JSON.stringify(norm.cancelRequest)
            : null,
      return_request_json:
        updatedReq.type === 'return'
          ? JSON.stringify(updatedReq)
          : norm.returnRequest
            ? JSON.stringify(norm.returnRequest)
            : null,
      stock_restored_at:
        input.decision === 'approved' && updatedReq.type === 'cancel' && !docData.stock_restored_at
          ? now
          : docData.stock_restored_at ?? null,
      status_history_json: JSON.stringify(history),
      updated_at: now,
    };
    await this.patchDoc(`orders/${input.orderId}`, patch, {
      updateTime: existing.updateTime,
    });

    // Idempotent stock restoration AFTER optimistic lock succeeds
    if (input.decision === 'approved' && updatedReq.type === 'cancel' && !docData.stock_restored_at) {
      const qtyByProductAndVariant = new Map<string, Map<string | null, number>>();
      for (const item of docData.items || []) {
        const inner = qtyByProductAndVariant.get(item.product_id) || new Map<string | null, number>();
        inner.set(item.variant_id || null, (inner.get(item.variant_id || null) || 0) + Number(item.quantity || 0));
        qtyByProductAndVariant.set(item.product_id, inner);
      }
      for (const [pid, varMap] of qtyByProductAndVariant.entries()) {
        const pDoc = await this.getDoc(`products/${pid}`).catch(() => null);
        if (!pDoc) continue;
        const prodData = pDoc.data as unknown as FirestoreProductDoc;
        const clonedVariants = (prodData.variants || []).map((v) => ({ ...v }));
        for (const [vid, qty] of varMap.entries()) {
          const vIdx = vid ? clonedVariants.findIndex((v) => v.id === vid) : 0;
          if (vIdx >= 0) {
            clonedVariants[vIdx].stock_qty += qty;
          }
        }
        const totalStock = clonedVariants.reduce((sum, v) => sum + v.stock_qty, 0);
        await this.patchDoc(`products/${pid}`, {
          variants: clonedVariants,
          stock_qty: totalStock,
          updated_at: now,
        }).catch(() => {});
      }
    }

    if (docData.customer_user_id) {
      await this.createCustomerNotification({
        id: `notif_req_${docData.id}_${updatedReq.id}_${input.decision}`,
        userId: docData.customer_user_id,
        type: 'request_update',
        title: `${updatedReq.type === 'cancel' ? 'Cancellation' : 'Return'} request ${input.decision}`,
        message:
          updatedReq.resolutionNote ||
          `Your ${updatedReq.type} request for order ${docData.order_number} was ${input.decision}.`,
        orderId: docData.id,
        orderNumber: docData.order_number,
      }).catch(() => {});
    }

    const updatedDoc: FirestoreOrderDoc = { ...docData, ...patch };
    return { order: normalizeRestOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async listCustomerAddresses(userId: string): Promise<CustomerAddressRow[]> {
    const docs = await this.runQuery('addresses', { parentRelPath: `users/${userId}` });
    return docs
      .map((d) => d.data as unknown as CustomerAddressRow)
      .sort((a, b) => Number(b.is_default) - Number(a.is_default) || Number(b.updated_at) - Number(a.updated_at));
  }

  async upsertCustomerAddress(
    userId: string,
    input: {
      id?: string;
      fullName: string;
      phone: string;
      line1: string;
      line2?: string;
      city: string;
      state: string;
      pincode: string;
      landmark?: string;
      label: 'Home' | 'Work' | 'Other';
      isDefault: boolean;
    }
  ): Promise<CustomerAddressRow> {
    const now = Date.now();
    const id = input.id && /^[a-zA-Z0-9_-]{3,80}$/.test(input.id) ? input.id : `addr_${crypto.randomUUID().slice(0, 12)}`;
    const existingList = await this.listCustomerAddresses(userId);
    const shouldBeDefault = input.isDefault || existingList.length === 0 ? 1 : 0;
    const prev = existingList.find((a) => a.id === id);

    if (shouldBeDefault) {
      for (const addr of existingList) {
        if (addr.id !== id && addr.is_default) {
          await this.patchDoc(`users/${userId}/addresses/${addr.id}`, { is_default: 0 }).catch(() => {});
        }
      }
    }

    const row: CustomerAddressRow = {
      id,
      user_id: userId,
      full_name: input.fullName.trim(),
      phone: input.phone.trim(),
      line1: input.line1.trim(),
      line2: (input.line2 || '').trim(),
      city: input.city.trim(),
      state: input.state.trim(),
      pincode: input.pincode.trim(),
      landmark: (input.landmark || '').trim(),
      label: input.label,
      is_default: shouldBeDefault,
      created_at: prev?.created_at || now,
      updated_at: now,
    };

    await this.setDoc(`users/${userId}/addresses/${id}`, row as unknown as Record<string, unknown>);
    return row;
  }

  async deleteCustomerAddress(userId: string, addressId: string): Promise<boolean> {
    const existing = await this.getDoc(`users/${userId}/addresses/${addressId}`);
    if (!existing) return false;
    const wasDefault = Boolean(existing.data.is_default);
    await this.deleteDoc(`users/${userId}/addresses/${addressId}`);
    if (wasDefault) {
      const remaining = await this.listCustomerAddresses(userId);
      if (remaining.length > 0 && !remaining.some((a) => Boolean(a.is_default))) {
        const sorted = [...remaining].sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
        const nextDefault = sorted[0];
        if (nextDefault) {
          await this.setDoc(`users/${userId}/addresses/${nextDefault.id}`, {
            ...nextDefault,
            is_default: 1,
            updated_at: Date.now(),
          });
        }
      }
    }
    return true;
  }

  async getCustomerWishlist(userId: string): Promise<string[]> {
    const doc = await this.getDoc(`users/${userId}/wishlist/items`);
    if (!doc) return [];
    const list = doc.data.product_ids;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  }

  async setCustomerWishlist(userId: string, productIds: string[]): Promise<string[]> {
    const unique = Array.from(new Set(productIds.filter((id) => typeof id === 'string' && id.trim())));
    await this.setDoc(`users/${userId}/wishlist/items`, {
      product_ids: unique,
      updated_at: Date.now(),
    });
    return unique;
  }

  async listCustomerNotifications(userId: string): Promise<CustomerNotificationRow[]> {
    const docs = await this.runQuery('notifications', { parentRelPath: `users/${userId}` });
    return docs
      .map((d) => d.data as unknown as CustomerNotificationRow)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at))
      .slice(0, 60);
  }

  async createCustomerNotification(input: {
    id?: string;
    userId: string;
    type: CustomerNotificationRow['type'];
    title: string;
    message: string;
    orderId?: string | null;
    orderNumber?: string | null;
  }): Promise<CustomerNotificationRow> {
    const id = input.id || `notif_${crypto.randomUUID().slice(0, 12)}`;
    const existing = await this.getDoc(`users/${input.userId}/notifications/${id}`).catch(() => null);
    if (existing) {
      return existing.data as unknown as CustomerNotificationRow;
    }
    const row: CustomerNotificationRow = {
      id,
      user_id: input.userId,
      type: input.type,
      title: input.title.trim().slice(0, 140),
      message: input.message.trim().slice(0, 500),
      order_id: input.orderId || null,
      order_number: input.orderNumber || null,
      is_read: 0,
      read_at: null,
      created_at: Date.now(),
    };
    await this.setDoc(
      `users/${input.userId}/notifications/${id}`,
      row as unknown as Record<string, unknown>
    );
    return row;
  }

  async markCustomerNotificationRead(userId: string, notificationId: string): Promise<boolean> {
    const existing = await this.getDoc(`users/${userId}/notifications/${notificationId}`);
    if (!existing) return false;
    await this.patchDoc(`users/${userId}/notifications/${notificationId}`, {
      is_read: 1,
      read_at: Date.now(),
    });
    return true;
  }

  async listCustomerPaymentMethods(userId: string): Promise<CustomerPaymentMethodRow[]> {
    const docs = await this.runQuery('payment_methods', { parentRelPath: `users/${userId}` });
    return docs
      .map((d) => d.data as unknown as CustomerPaymentMethodRow)
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  }

  async upsertCustomerPaymentMethod(
    userId: string,
    input: {
      id?: string;
      methodType: 'card' | 'upi' | 'wallet';
      label: string;
      last4?: string | null;
      network?: string | null;
      expiry?: string | null;
    }
  ): Promise<CustomerPaymentMethodRow> {
    const validated = validateNonSensitivePaymentMethodInput(input);
    if (!validated.ok) {
      throw new StoreHttpError(400, 'VALIDATION_ERROR', validated.error);
    }
    const now = Date.now();
    const id =
      input.id && /^[a-zA-Z0-9_-]{3,80}$/.test(input.id)
        ? input.id
        : `pm_${crypto.randomUUID().slice(0, 12)}`;
    const existing = await this.getDoc(`users/${userId}/payment_methods/${id}`).catch(() => null);
    const row: CustomerPaymentMethodRow = {
      id,
      user_id: userId,
      method_type: validated.methodType,
      label: validated.label,
      last4: validated.last4,
      network: validated.network,
      expiry: validated.expiry,
      created_at: Number(existing?.data.created_at || now),
      updated_at: now,
    };
    await this.setDoc(
      `users/${userId}/payment_methods/${id}`,
      row as unknown as Record<string, unknown>
    );
    return row;
  }

  async deleteCustomerPaymentMethod(userId: string, methodId: string): Promise<boolean> {
    const existing = await this.getDoc(`users/${userId}/payment_methods/${methodId}`);
    if (!existing) return false;
    await this.deleteDoc(`users/${userId}/payment_methods/${methodId}`);
    return true;
  }

  async markAllCustomerNotificationsRead(userId: string): Promise<void> {
    const list = await this.listCustomerNotifications(userId);
    const now = Date.now();
    for (const item of list) {
      if (!item.is_read) {
        await this.patchDoc(`users/${userId}/notifications/${item.id}`, {
          is_read: 1,
          read_at: now,
        }).catch(() => {});
      }
    }
  }

  async deleteCustomerNotification(userId: string, notificationId: string): Promise<boolean> {
    const existing = await this.getDoc(`users/${userId}/notifications/${notificationId}`);
    if (!existing) return false;
    await this.deleteDoc(`users/${userId}/notifications/${notificationId}`);
    return true;
  }

  async listCoupons(activeOnly = false): Promise<CouponRow[]> {
    const docs = await this.runQuery('coupons');
    return docs
      .map((d) => d.data as unknown as CouponRow)
      .filter((c) => !activeOnly || Boolean(c.active))
      .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  }

  async getCouponByCode(code: string): Promise<CouponRow | null> {
    const clean = code.trim().toUpperCase();
    const docs = await this.runQuery('coupons', {
      where: {
        fieldFilter: {
          field: { fieldPath: 'code' },
          op: 'EQUAL',
          value: { stringValue: clean },
        },
      },
      limit: 1,
    });
    return docs[0] ? (docs[0].data as unknown as CouponRow) : null;
  }

  async upsertCoupon(input: {
    id?: string;
    code: string;
    title: string;
    description: string;
    discountType: 'percent' | 'flat_paise';
    discountValue: number;
    maxDiscountPaise?: number | null;
    minSpendPaise: number;
    usageLimit?: number | null;
    active: boolean;
    startsAt?: number | null;
    expiresAt?: number | null;
  }): Promise<CouponRow> {
    const now = Date.now();
    const cleanCode = input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const id = input.id || `cpn_${cleanCode.toLowerCase()}`;
    const existing = await this.getDoc(`coupons/${id}`).catch(() => null);
    const prev = existing ? (existing.data as unknown as CouponRow) : null;
    const row: CouponRow = {
      id,
      code: cleanCode,
      title: input.title.trim(),
      description: input.description.trim(),
      discount_type: input.discountType,
      discount_value: Math.round(input.discountValue),
      max_discount_paise: input.maxDiscountPaise ?? null,
      min_spend_paise: Math.max(0, Math.round(input.minSpendPaise)),
      usage_limit: input.usageLimit ?? null,
      used_count: prev ? Number(prev.used_count || 0) : 0,
      active: input.active ? 1 : 0,
      starts_at: input.startsAt ?? null,
      expires_at: input.expiresAt ?? null,
      created_at: prev?.created_at || now,
      updated_at: now,
    };
    await this.setDoc(`coupons/${id}`, row as unknown as Record<string, unknown>);
    return row;
  }

  async deleteCoupon(id: string): Promise<boolean> {
    const existing = await this.getDoc(`coupons/${id}`);
    if (!existing) return false;
    await this.deleteDoc(`coupons/${id}`);
    return true;
  }

  async listGiftCards(): Promise<GiftCardRow[]> {
    const docs = await this.runQuery('gift_cards');
    return docs
      .map((d) => d.data as unknown as GiftCardRow)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  }

  async getGiftCardByCode(code: string): Promise<GiftCardRow | null> {
    const clean = code.trim().toUpperCase();
    const docs = await this.runQuery('gift_cards', {
      where: {
        fieldFilter: {
          field: { fieldPath: 'code' },
          op: 'EQUAL',
          value: { stringValue: clean },
        },
      },
      limit: 1,
    });
    return docs[0] ? (docs[0].data as unknown as GiftCardRow) : null;
  }

  async upsertGiftCard(input: {
    id?: string;
    code: string;
    recipientEmail?: string;
    note?: string;
    initialBalancePaise: number;
    balancePaise: number;
    active: boolean;
    expiresAt?: number | null;
  }): Promise<GiftCardRow> {
    const now = Date.now();
    const cleanCode = input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const id = input.id || `gc_${cleanCode.toLowerCase()}`;
    const existing = await this.getDoc(`gift_cards/${id}`).catch(() => null);
    const prev = existing ? (existing.data as unknown as GiftCardRow) : null;
    const row: GiftCardRow = {
      id,
      code: cleanCode,
      recipient_email: (input.recipientEmail || '').trim().toLowerCase(),
      note: (input.note || '').trim(),
      initial_balance_paise: Math.max(0, Math.round(input.initialBalancePaise)),
      balance_paise: Math.max(0, Math.round(input.balancePaise)),
      active: input.active ? 1 : 0,
      expires_at: input.expiresAt ?? null,
      last_used_at: prev?.last_used_at ?? null,
      created_at: prev?.created_at || now,
      updated_at: now,
    };
    await this.setDoc(`gift_cards/${id}`, row as unknown as Record<string, unknown>);
    return row;
  }

  async deleteGiftCard(id: string): Promise<boolean> {
    const existing = await this.getDoc(`gift_cards/${id}`);
    if (!existing) return false;
    await this.deleteDoc(`gift_cards/${id}`);
    return true;
  }

  async getLoyaltyConfig(): Promise<LoyaltyConfigData> {
    const doc = await this.getDoc('site_documents/loyalty_config');
    if (!doc || !doc.data.value) {
      return mergeLoyaltyConfig(undefined);
    }
    return mergeLoyaltyConfig(doc.data.value);
  }

  async saveLoyaltyConfig(config: LoyaltyConfigData): Promise<LoyaltyConfigData> {
    const merged = mergeLoyaltyConfig(config);
    await this.setDoc('site_documents/loyalty_config', {
      key: 'loyalty_config',
      value: merged,
      updated_at: Date.now(),
    });
    return merged;
  }

  async listUsersSummary(): Promise<StoreUserSummary[]> {
    const docs = await this.runQuery('users');
    const verifiedUsers = docs
      .map((d) => d.data)
      .filter((d) => (Boolean(d.email_verified) || Boolean(d.phone_verified)) && !d.deleted_at)
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
      .slice(0, 100);

    return Promise.all(
      verifiedUsers.map(async (d) => {
        const uid = String(d.id || '');
        const addrs = uid ? await this.listCustomerAddresses(uid).catch(() => []) : [];
        const verifiedPhone =
          d.phone_verified && typeof d.phone_e164 === 'string' ? d.phone_e164 : null;
        const contactPhone =
          typeof d.contact_phone === 'string'
            ? d.contact_phone
            : typeof d.phone_e164 === 'string'
              ? d.phone_e164
              : null;
        return {
          id: uid,
          fullName: String(d.full_name || ''),
          email: typeof d.email === 'string' ? d.email : '',
          emailVerified: Boolean(d.email_verified),
          phone: contactPhone,
          verifiedPhone,
          phoneVerified: Boolean(verifiedPhone),
          notificationPrefs: parseNotificationPrefs(
            d.notification_prefs_json ?? d.notification_prefs
          ),
          addresses: addrs,
          createdAt: Number(d.created_at || 0),
          updatedAt: Number(d.updated_at || d.created_at || 0),
        };
      })
    );
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
    const rows = docs.map((d) => d.data as unknown as CategoryRow);
    if (!getActiveFirestoreIdToken()) {
      const seenIds = new Set(rows.map((r) => r.id));
      const seenNames = new Set(rows.map((r) => r.name.toLowerCase()));
      for (const starter of buildStarterReadCategories(Date.now())) {
        if (!seenIds.has(starter.id) && !seenNames.has(starter.name.toLowerCase())) {
          rows.push(starter);
        }
      }
    }
    return rows.sort((a, b) => a.position - b.position || a.created_at - b.created_at);
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
    await this.getCatalogVisibilityMeta();
    if (merged.catalogControl && typeof merged.catalogControl.suppressLegacySeed === 'boolean') {
      this.suppressLegacySeed = merged.catalogControl.suppressLegacySeed;
    }
    await this.setDoc('site_documents/settings', {
      key: 'settings',
      value: merged,
      suppress_legacy_seed: this.suppressLegacySeed,
      hidden_product_ids: Array.from(this.hiddenProductIds),
      hidden_product_slugs: Array.from(this.hiddenProductSlugs),
      deleted_product_ids: Array.from(this.deletedProductIds),
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
