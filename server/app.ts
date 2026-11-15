import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import cookieParser from 'cookie-parser';
import express, {
  type CookieOptions,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import {
  generateOpaqueToken,
  hashPassword,
  sha256Hex,
  timingSafeEqualText,
  verifyPassword,
} from './crypto.ts';
import type { SessionRow, UserRow } from './db.ts';
import { normalizeCanonicalAppUrl, resolveRuntimeTarget } from './env.ts';
import {
  buildBoutiqueEmailHtml,
  createDefaultEmailSender,
  type EmailSender,
} from './providers.ts';
import { registerCatalogAndAdminRoutes } from './catalog.ts';
import {
  extractOobCode,
  FirebaseAuthApiError,
  firebaseConfirmPasswordResetOobCode,
  firebaseConfirmVerifyEmailOobCode,
  firebaseRefreshIdToken,
  firebaseSendPasswordReset,
  firebaseSendVerifyEmail,
  firebaseSignInWithPassword,
  firebaseSignUpWithPassword,
  firebaseUpdateDisplayName,
  firebaseUpdatePassword,
  firestoreTokenStorage,
  FirestoreRestStore,
  sealFirebaseSessionCookie,
  setActiveFirestoreIdToken,
  unsealFirebaseSessionCookie,
  verifyFirebaseIdToken,
  type FirebaseSessionEnvelope,
  type VerifiedFirebaseTokenClaims,
} from './firebase-rest.ts';
import { SqliteBoutiqueStore } from './sqlite-store.ts';
import { StoreHttpError, type AdminBindingRow, type BoutiqueStore } from './store.ts';

const SESSION_COOKIE_NAME = 'sc_session';
const FIREBASE_SESSION_COOKIE_NAME = 'sc_fb_session';
const CSRF_COOKIE_NAME = 'sc_csrf';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERIFY_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const RESET_PASSWORD_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REAUTH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const PASSWORD_MIN_LENGTH = 8;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateAuthAppOptions {
  store?: BoutiqueStore;
  dbPath?: string;
  emailSender?: EmailSender;
  disableRateLimit?: boolean;
  appBaseUrl?: string;
  seedCatalog?: boolean;
}

interface AuthedRequest extends Request {
  requestId?: string;
  authSession?: SessionRow;
  authUser?: UserRow;
  fbEnvelope?: FirebaseSessionEnvelope;
  fbClaims?: VerifiedFirebaseTokenClaims;
}

const EPHEMERAL_CSRF_SECRET = crypto.randomBytes(32).toString('hex');

function getGuestCsrfSigningKey(): string {
  const configured = (process.env.AUTH_HMAC_SECRET || '').trim();
  return configured.length >= 16 ? configured : EPHEMERAL_CSRF_SECRET;
}

function createSignedGuestCsrfToken(): string {
  const issuedAt = Date.now().toString(36);
  const nonce = generateOpaqueToken(16);
  const payload = `${issuedAt}.${nonce}`;
  const sig = crypto
    .createHmac('sha256', getGuestCsrfSigningKey())
    .update(payload, 'utf8')
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifySignedGuestCsrfToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [issuedAtRaw, nonce, providedSig] = parts;
  if (!issuedAtRaw || !nonce || !providedSig) return false;
  const issuedAt = Number.parseInt(issuedAtRaw, 36);
  if (!Number.isFinite(issuedAt)) return false;
  const ageMs = Date.now() - issuedAt;
  if (ageMs < -60_000 || ageMs > SESSION_TTL_MS) return false;

  const expectedSig = crypto
    .createHmac('sha256', getGuestCsrfSigningKey())
    .update(`${issuedAtRaw}.${nonce}`, 'utf8')
    .digest('base64url');
  return timingSafeEqualText(providedSig, expectedSig);
}

function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') {
    return true;
  }
  const origin = req.get('origin');
  if (origin && origin.startsWith('https://')) {
    return true;
  }
  const referer = req.get('referer');
  if (referer && referer.startsWith('https://')) {
    return true;
  }
  const forwardedHost = req.get('x-forwarded-host');
  const appUrl = (process.env.APP_URL || '').trim();
  if (forwardedHost && appUrl.startsWith('https://')) {
    return true;
  }
  return false;
}

function buildAllowedHosts(req: Request, configuredUrl?: string): Set<string> {
  const allowed = new Set<string>();
  const directHost = req.get('host')?.trim().toLowerCase();
  if (directHost) allowed.add(directHost);

  const forwardedHost = req.get('x-forwarded-host');
  if (typeof forwardedHost === 'string') {
    for (const part of forwardedHost.split(',')) {
      const cleaned = part.trim().toLowerCase();
      if (cleaned) allowed.add(cleaned);
    }
  }

  const normalizedUrl = normalizeCanonicalAppUrl(configuredUrl || process.env.APP_URL);
  if (normalizedUrl) {
    try {
      allowed.add(new URL(normalizedUrl).host.toLowerCase());
    } catch {
      // Ignore malformed APP_URL
    }
  }

  return allowed;
}

export function resolveAppBaseUrl(req: Request, configuredUrl?: string): string {
  const canonical = normalizeCanonicalAppUrl(configuredUrl || process.env.APP_URL);
  if (canonical) {
    return canonical;
  }
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host') || 'localhost:3000';
  const proto = isSecureRequest(req) ? 'https' : 'http';
  return `${proto}://${host}`;
}

function serializePublicUser(user: UserRow, session: SessionRow, isOwner = false) {
  const reauthExpiresAt = session.last_reauth_at + REAUTH_WINDOW_MS;
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    emailVerified: Boolean(user.email_verified),
    hasPassword: Boolean(user.password_hash),
    isOwner: Boolean(isOwner),
    recentReauthValid: Date.now() < reauthExpiresAt,
    recentReauthExpiresAt: reauthExpiresAt,
  };
}

function cookiePolicy(req: Request) {
  const secure = isSecureRequest(req);
  return {
    secure,
    sameSite: (secure ? 'none' : 'lax') as 'none' | 'lax',
  };
}

function buildCookieOptions(
  req: Request,
  opts: { httpOnly: boolean; maxAge?: number }
): CookieOptions {
  const { secure, sameSite } = cookiePolicy(req);
  return {
    httpOnly: opts.httpOnly,
    secure,
    sameSite,
    path: '/',
    ...(opts.maxAge !== undefined ? { maxAge: opts.maxAge } : {}),
    ...(secure ? ({ partitioned: true } as Partial<CookieOptions>) : {}),
  };
}

function setSessionCookies(
  req: Request,
  res: Response,
  rawSessionToken: string,
  csrfSecret: string
) {
  res.cookie(
    SESSION_COOKIE_NAME,
    rawSessionToken,
    buildCookieOptions(req, { httpOnly: true, maxAge: SESSION_TTL_MS })
  );
  res.cookie(
    CSRF_COOKIE_NAME,
    csrfSecret,
    buildCookieOptions(req, { httpOnly: false, maxAge: SESSION_TTL_MS })
  );
}

function setFirebaseSessionCookies(
  req: Request,
  res: Response,
  envelope: FirebaseSessionEnvelope,
  restStore: FirestoreRestStore
) {
  const sealed = sealFirebaseSessionCookie(envelope, restStore.config);
  res.cookie(
    FIREBASE_SESSION_COOKIE_NAME,
    sealed,
    buildCookieOptions(req, { httpOnly: true, maxAge: SESSION_TTL_MS })
  );
  res.cookie(
    CSRF_COOKIE_NAME,
    envelope.csrfSecret,
    buildCookieOptions(req, { httpOnly: false, maxAge: SESSION_TTL_MS })
  );
}

function clearCookieVariants(res: Response, name: string, httpOnly: boolean) {
  res.clearCookie(name, {
    path: '/',
    httpOnly,
    secure: true,
    sameSite: 'none',
    partitioned: true,
  } as CookieOptions);
  res.clearCookie(name, {
    path: '/',
    httpOnly,
    secure: true,
    sameSite: 'none',
  });
  res.clearCookie(name, {
    path: '/',
    httpOnly,
    secure: false,
    sameSite: 'lax',
  });
}

function clearAuthSessionCookies(res: Response) {
  clearCookieVariants(res, SESSION_COOKIE_NAME, true);
  clearCookieVariants(res, FIREBASE_SESSION_COOKIE_NAME, true);
}

function setNoStoreHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function rotateGuestCsrfCookie(req: Request, res: Response): string {
  const nextCsrf = createSignedGuestCsrfToken();
  clearAuthSessionCookies(res);
  clearCookieVariants(res, CSRF_COOKIE_NAME, false);
  res.cookie(
    CSRF_COOKIE_NAME,
    nextCsrf,
    buildCookieOptions(req, { httpOnly: false, maxAge: SESSION_TTL_MS })
  );
  return nextCsrf;
}

function logAuthDiagnostic(requestId: string, stage: string, err: unknown) {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  const code =
    typeof errObj?.code === 'string' || typeof errObj?.code === 'number'
      ? String(errObj.code)
      : undefined;
  const responseCode = typeof errObj?.responseCode === 'number' ? errObj.responseCode : undefined;
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error(
    `[auth][${requestId}] ${stage} failed:`,
    JSON.stringify({ name, code, responseCode, message })
  );
}

function sendError(
  req: AuthedRequest,
  res: Response,
  status: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>
) {
  return res.status(status).json({
    code,
    error,
    requestId: req.requestId,
    ...(extra || {}),
  });
}

export function createAuthApp(options: CreateAuthAppOptions = {}) {
  let store: BoutiqueStore;
  if (options.store) {
    store = options.store;
  } else {
    const targetCfg = resolveRuntimeTarget(process.env, {
      sqliteOverridePath: options.dbPath,
      disableFirestore: true,
    });
    store = new SqliteBoutiqueStore({
      dbPath: options.dbPath || targetCfg.sqliteDbPath,
      targetEnv: targetCfg.targetEnv,
      seedCatalog: options.seedCatalog,
      isPersistent: targetCfg.isPersistentDatabase,
    });
  }

  const sqliteDb: DatabaseSync | undefined =
    store instanceof SqliteBoutiqueStore ? store.db : undefined;
  const restStore: FirestoreRestStore | null =
    store instanceof FirestoreRestStore ? store : null;
  const emailSender = options.emailSender || createDefaultEmailSender();
  const pendingVerifyTokens = new Map<
    string,
    { idToken: string; lastSentAt: number; expiresAt: number }
  >();
  const inFlightTokenRefreshes = new Map<
    string,
    Promise<{ idToken: string; refreshToken: string; claims: VerifiedFirebaseTokenClaims } | null>
  >();
  const revokedFirebaseSessions = new Map<string, number>();
  const revokedFirebaseUsersBefore = new Map<string, number>();

  const pruneRevokedFirebaseState = (nowMs: number) => {
    if (revokedFirebaseSessions.size > 1000) {
      for (const [key, exp] of revokedFirebaseSessions.entries()) {
        if (exp <= nowMs) revokedFirebaseSessions.delete(key);
      }
    }
    if (revokedFirebaseUsersBefore.size > 1000) {
      for (const [uid, ts] of revokedFirebaseUsersBefore.entries()) {
        if (ts + SESSION_TTL_MS <= nowMs) revokedFirebaseUsersBefore.delete(uid);
      }
    }
  };

  const getFirebaseSessionKeys = (envelope: FirebaseSessionEnvelope): string[] => {
    if (envelope.sessionId) {
      return [`sid:${envelope.sessionId}`];
    }
    if (envelope.refreshToken) {
      return [`rt:${sha256Hex(envelope.refreshToken)}`];
    }
    return [];
  };

  const markFirebaseSessionRevoked = (envelope: FirebaseSessionEnvelope, nowMs = Date.now()) => {
    pruneRevokedFirebaseState(nowMs);
    const expiresAt = nowMs + SESSION_TTL_MS;
    for (const key of getFirebaseSessionKeys(envelope)) {
      revokedFirebaseSessions.set(key, expiresAt);
    }
  };

  const isFirebaseSessionRevoked = (envelope: FirebaseSessionEnvelope, nowMs = Date.now()): boolean => {
    for (const key of getFirebaseSessionKeys(envelope)) {
      const exp = revokedFirebaseSessions.get(key);
      if (exp !== undefined && exp > nowMs) {
        return true;
      }
    }
    return false;
  };

  const refreshFirebaseTokensOnce = (refreshToken: string) => {
    if (!restStore) return Promise.resolve(null);
    const key = sha256Hex(refreshToken);
    const existing = inFlightTokenRefreshes.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const refreshed = await firebaseRefreshIdToken(restStore.config.apiKey, refreshToken);
        const verifiedRefreshed = await verifyFirebaseIdToken(
          refreshed.idToken,
          restStore.config.projectId
        );
        if (!verifiedRefreshed) {
          return null;
        }
        return {
          idToken: refreshed.idToken,
          refreshToken: refreshed.refreshToken,
          claims: verifiedRefreshed,
        };
      } finally {
        inFlightTokenRefreshes.delete(key);
      }
    })();

    inFlightTokenRefreshes.set(key, promise);
    return promise;
  };

  const handleFirebaseError = (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
    err: unknown,
    stage = 'firebase_auth'
  ) => {
    if (err instanceof FirebaseAuthApiError) {
      logAuthDiagnostic(req.requestId || 'unknown', stage, {
        name: err.name,
        code: err.rawFirebaseCode,
        responseCode: err.httpStatus,
        message: err.message,
      });
      return sendError(req, res, err.httpStatus, err.firebaseCode, err.message);
    }
    return next(err);
  };

  const resolveIsBoundOwner = async (user: UserRow): Promise<boolean> => {
    if (!user.email_verified) return false;
    if (restStore) {
      if ((user.email || '').toLowerCase() !== restStore.ownerEmail) return false;
      const bound = await restStore.resolveBoundOwner().catch((err) => {
        logAuthDiagnostic('owner_check', 'resolve_bound_owner', err);
        throw err;
      });
      return !bound || bound.owner_user_id === user.id;
    }
    const bound = await store.resolveBoundOwner().catch((err) => {
      logAuthDiagnostic('owner_check', 'resolve_bound_owner', err);
      throw err;
    });
    return Boolean(bound && bound.owner_user_id === user.id);
  };

  const app = express();
  app.set('trust proxy', 2);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      xFrameOptions: false,
    })
  );

  app.use((_req, _res, next) => {
    firestoreTokenStorage.run({}, next);
  });

  app.use('/api', (req: AuthedRequest, res: Response, next: NextFunction) => {
    const reqId = crypto.randomUUID();
    req.requestId = reqId;
    res.setHeader('X-Request-Id', reqId);
    next();
  });

  app.use(['/api/auth', '/api/account'], (_req: Request, res: Response, next: NextFunction) => {
    setNoStoreHeaders(res);
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  const makeLimiter = (max: number, windowMs: number, message: string) =>
    options.disableRateLimit
      ? (_req: Request, _res: Response, next: NextFunction) => next()
      : rateLimit({
          windowMs,
          max,
          standardHeaders: true,
          legacyHeaders: false,
          message: { code: 'RATE_LIMITED', error: message },
        });

  const authLimiter = makeLimiter(
    30,
    15 * 60 * 1000,
    'Too many authentication requests. Please wait a few minutes and try again.'
  );

  const registerLimiter = makeLimiter(
    12,
    15 * 60 * 1000,
    'Too many registration or verification email attempts. Please wait a few minutes and try again.'
  );

  const adminLoginLimiter = makeLimiter(
    10,
    15 * 60 * 1000,
    'Too many admin login attempts. Please wait 15 minutes and try again.'
  );

  const contactLimiter = makeLimiter(
    10,
    15 * 60 * 1000,
    'Too many boutique enquiries sent recently. Please wait a few minutes and try again.'
  );

  const attachSession = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      if (restStore) {
        const sealed = req.cookies?.[FIREBASE_SESSION_COOKIE_NAME];
        if (typeof sealed !== 'string' || !sealed) {
          return next();
        }
        const envelope = unsealFirebaseSessionCookie(sealed, restStore.config);
        if (!envelope) {
          clearAuthSessionCookies(res);
          return next();
        }

        const nowMs = Date.now();
        if (isFirebaseSessionRevoked(envelope, nowMs)) {
          clearAuthSessionCookies(res);
          return next();
        }

        let activeEnvelope = envelope;
        let claims: VerifiedFirebaseTokenClaims | null = null;
        try {
          claims = await verifyFirebaseIdToken(
            activeEnvelope.idToken,
            restStore.config.projectId
          );
        } catch (verifyErr) {
          logAuthDiagnostic(req.requestId || 'session', 'verify_id_token', verifyErr);
          claims = null;
        }

        const checkTimeMs = Date.now();
        const isStillValid = Boolean(claims && claims.expiresAtMs > checkTimeMs + 5_000);
        if (!claims || claims.expiresAtMs - checkTimeMs < 120_000) {
          try {
            const refreshed = await refreshFirebaseTokensOnce(activeEnvelope.refreshToken);
            if (!refreshed) {
              if (!isStillValid) {
                clearAuthSessionCookies(res);
                return next();
              }
            } else if (isFirebaseSessionRevoked(activeEnvelope, Date.now())) {
              clearAuthSessionCookies(res);
              return next();
            } else {
              activeEnvelope = {
                ...activeEnvelope,
                idToken: refreshed.idToken,
                refreshToken: refreshed.refreshToken,
              };
              claims = refreshed.claims;
              setFirebaseSessionCookies(req, res, activeEnvelope, restStore);
            }
          } catch (refreshErr) {
            logAuthDiagnostic(req.requestId || 'session', 'refresh_id_token', refreshErr);
            if (!isStillValid) {
              clearAuthSessionCookies(res);
              return next();
            }
          }
        }

        if (!claims || isFirebaseSessionRevoked(activeEnvelope, Date.now())) {
          clearAuthSessionCookies(res);
          return next();
        }

        const effectiveSessionTime = activeEnvelope.issuedAt
          ? Math.max(activeEnvelope.issuedAt, claims.authTimeMs)
          : claims.authTimeMs;
        const userRevokedBefore = revokedFirebaseUsersBefore.get(claims.uid);
        if (userRevokedBefore && effectiveSessionTime < userRevokedBefore) {
          clearAuthSessionCookies(res);
          return next();
        }

        setActiveFirestoreIdToken(activeEnvelope.idToken);

        if (claims.email === restStore.ownerEmail && claims.emailVerified) {
          const ownerMeta = await restStore.getOwnerMeta();
          if (ownerMeta && ownerMeta.revokedBefore > 0 && effectiveSessionTime < ownerMeta.revokedBefore) {
            setActiveFirestoreIdToken(undefined);
            clearAuthSessionCookies(res);
            return next();
          }
        }

        let user = await restStore.getUserById(claims.uid);
        if (!user && claims.emailVerified) {
          user = await restStore.syncVerifiedUserProfile({
            id: claims.uid,
            fullName:
              claims.name || (claims.email === restStore.ownerEmail ? 'Store Owner' : 'Member'),
            email: claims.email,
            emailVerified: true,
          });
        }
        if (!user) {
          user = {
            id: claims.uid,
            full_name: claims.name || 'Member',
            email: claims.email,
            email_verified: claims.emailVerified ? 1 : 0,
            password_hash: 'firebase-managed',
            phone_e164: null,
            phone_verified: 0,
            created_at: claims.authTimeMs || Date.now(),
            updated_at: Date.now(),
          };
        }

        req.fbEnvelope = activeEnvelope;
        req.fbClaims = claims;
        req.authUser = user;
        req.authSession = {
          id: activeEnvelope.sessionId || claims.uid,
          user_id: claims.uid,
          token_hash: 'firebase-managed',
          csrf_secret: activeEnvelope.csrfSecret,
          last_reauth_at: activeEnvelope.lastReauthAt,
          expires_at: claims.expiresAtMs,
          created_at: activeEnvelope.issuedAt || claims.authTimeMs,
          revoked_at: null,
        };
        return next();
      }

      const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
      if (typeof rawToken !== 'string' || !rawToken) {
        return next();
      }

      const tokenHash = sha256Hex(rawToken);
      const now = Date.now();
      const session = await store.getActiveSessionByTokenHash(tokenHash, now);
      if (!session) {
        clearAuthSessionCookies(res);
        return next();
      }

      const user = await store.getUserById(session.user_id);
      if (!user) {
        clearAuthSessionCookies(res);
        return next();
      }

      req.authSession = session;
      req.authUser = user;
      return next();
    } catch (err) {
      return next(err);
    }
  };

  app.use(['/api', '/admin', '/account'], attachSession);

  const verifyCsrf = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }

    const origin = req.get('origin');
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        const allowedHosts = buildAllowedHosts(req, options.appBaseUrl);
        if (!allowedHosts.has(parsedOrigin.host.toLowerCase())) {
          return sendError(
            req,
            res,
            403,
            'CROSS_ORIGIN_REJECTED',
            'Cross-origin request rejected.'
          );
        }
      } catch {
        return sendError(req, res, 403, 'INVALID_ORIGIN', 'Invalid request origin.');
      }
    }

    const headerToken = req.get('x-csrf-token');
    if (!headerToken) {
      return sendError(req, res, 403, 'CSRF_MISSING', 'Missing CSRF protection token.');
    }

    if (req.authSession) {
      if (!timingSafeEqualText(headerToken, req.authSession.csrf_secret)) {
        return sendError(req, res, 403, 'CSRF_INVALID', 'CSRF validation failed.');
      }
      return next();
    }

    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
    if (typeof cookieToken === 'string' && cookieToken) {
      if (timingSafeEqualText(headerToken, cookieToken)) {
        return next();
      }
      return sendError(req, res, 403, 'CSRF_INVALID', 'CSRF validation failed.');
    }

    if (verifySignedGuestCsrfToken(headerToken)) {
      return next();
    }

    return sendError(
      req,
      res,
      403,
      'CSRF_EXPIRED',
      'Invalid or expired CSRF token. Please refresh the page.'
    );
  };

  app.use('/api', verifyCsrf);

  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authSession || !req.authUser) {
      return sendError(req, res, 401, 'AUTH_REQUIRED', 'Authentication required.');
    }
    return next();
  };

  const requireRecentReauth = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authSession || !req.authUser) {
      return sendError(req, res, 401, 'AUTH_REQUIRED', 'Authentication required.');
    }
    if (Date.now() - req.authSession.last_reauth_at > REAUTH_WINDOW_MS) {
      return sendError(
        req,
        res,
        403,
        'REAUTH_REQUIRED',
        'Please verify your current password before updating login details.'
      );
    }
    return next();
  };

  const createSessionForUser = async (
    req: Request,
    res: Response,
    userId: string
  ): Promise<{ session: SessionRow }> => {
    const now = Date.now();
    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    const csrfSecret = generateOpaqueToken(24);
    const session: SessionRow = {
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: tokenHash,
      csrf_secret: csrfSecret,
      last_reauth_at: now,
      expires_at: now + SESSION_TTL_MS,
      created_at: now,
      revoked_at: null,
    };

    await store.createSession(session);
    setSessionCookies(req, res, rawToken, csrfSecret);
    return { session };
  };

  const completeFirebaseSignIn = async (params: {
    req: Request;
    res: Response;
    signIn: { idToken: string; refreshToken: string; localId: string; email: string; displayName: string };
    claims: VerifiedFirebaseTokenClaims;
  }): Promise<
    | { ok: true; user: UserRow; session: SessionRow; isOwner: boolean; ownerBinding: AdminBindingRow | null }
    | { ok: false; status: number; code: string; error: string }
  > => {
    if (!restStore) {
      return { ok: false, status: 500, code: 'INTERNAL_ERROR', error: 'Firebase store unavailable.' };
    }
    const { req, res, signIn, claims } = params;
    const now = Date.now();
    setActiveFirestoreIdToken(signIn.idToken);

    const isOwnerEmail = claims.email === restStore.ownerEmail && claims.emailVerified;
    const user = await restStore.syncVerifiedUserProfile({
      id: claims.uid,
      fullName: claims.name || signIn.displayName || (isOwnerEmail ? 'Store Owner' : 'Member'),
      email: claims.email,
      emailVerified: true,
    });

    let bound: AdminBindingRow | null = null;
    let issuedAt = now;
    if (isOwnerEmail) {
      const existingBinding = await restStore.getStoredAdminBinding().catch(() => null);
      if (existingBinding && existingBinding.owner_user_id !== user.id) {
        setActiveFirestoreIdToken(undefined);
        return {
          ok: false,
          status: 403,
          code: 'OWNER_CONFLICT',
          error: 'Existing owner binding belongs to another user ID; automatic reassignment was refused.',
        };
      }
      bound =
        existingBinding ||
        (await restStore.bindOwnerAccount({
          email: claims.email,
          userId: user.id,
          boundVia: 'firebase_verified_owner',
        }));

      const ownerMeta = await restStore.getOwnerMeta();
      if (ownerMeta && ownerMeta.revokedBefore > 0) {
        issuedAt = Math.max(now, ownerMeta.revokedBefore + 1);
      }
      await restStore.seedInitialCatalogIfEmpty();
    }

    const userRevokedBefore = revokedFirebaseUsersBefore.get(user.id);
    if (userRevokedBefore && issuedAt <= userRevokedBefore) {
      issuedAt = userRevokedBefore + 1;
    }

    const csrfSecret = generateOpaqueToken(24);
    const sessionId = crypto.randomUUID();
    const envelope: FirebaseSessionEnvelope = {
      idToken: signIn.idToken,
      refreshToken: signIn.refreshToken,
      uid: user.id,
      email: claims.email,
      lastReauthAt: now,
      csrfSecret,
      sessionId,
      issuedAt,
    };
    setFirebaseSessionCookies(req, res, envelope, restStore);

    const session: SessionRow = {
      id: sessionId,
      user_id: user.id,
      token_hash: 'firebase-managed',
      csrf_secret: csrfSecret,
      last_reauth_at: now,
      expires_at: claims.expiresAtMs,
      created_at: issuedAt,
      revoked_at: null,
    };

    return { ok: true, user, session, isOwner: isOwnerEmail, ownerBinding: bound };
  };

  const issueAndSendVerificationEmail = async (params: {
    req: AuthedRequest;
    userId: string;
    email: string;
    purpose: 'verify_email' | 'link_email';
  }) => {
    const now = Date.now();
    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    const tokenId = crypto.randomUUID();

    await store.createEmailToken({
      id: tokenId,
      userId: params.userId,
      purpose: params.purpose,
      targetEmail: params.email,
      tokenHash,
      expiresAt: now + VERIFY_EMAIL_TTL_MS,
      createdAt: now,
      invalidatePreviousSamePurpose: true,
    });

    const verifyUrl = `${resolveAppBaseUrl(params.req, options.appBaseUrl)}/verify-email?token=${encodeURIComponent(rawToken)}`;

    try {
      await emailSender.sendEmail({
        to: params.email,
        subject:
          params.purpose === 'link_email'
            ? 'Verify your new email — Sahithi Collections'
            : 'Verify your Sahithi Collections email address',
        text:
          params.purpose === 'link_email'
            ? `Confirm this email address to update your Sahithi Collections account: ${verifyUrl}`
            : `Welcome to Sahithi Collections. Verify your email address to activate your account: ${verifyUrl}`,
        html: buildBoutiqueEmailHtml({
          heading: 'Verify Your Email Address',
          intro:
            params.purpose === 'link_email'
              ? 'Confirm this email address to update your signed-in Sahithi Collections profile.'
              : 'Thank you for registering with Sahithi Collections. Confirm your email address below to activate your boutique account.',
          actionLabel:
            params.purpose === 'link_email' ? 'Verify Email Address' : 'Verify Email & Activate',
          actionUrl: verifyUrl,
          footnote: 'This single-use verification link expires in 24 hours.',
        }),
      });
    } catch (err) {
      await store.deleteEmailToken(tokenId);
      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // Public Email Auth Endpoints
  // -------------------------------------------------------------------------

  app.get('/api/auth/capabilities', async (req, res, next) => {
    try {
      const boundOwner = restStore ? null : await store.resolveBoundOwner().catch(() => null);
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const fbProviderStatus = restStore
        ? await restStore.checkEmailPasswordAuthStatus({
            forceRefresh,
            bypassNegativeCache: true,
          })
        : null;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        authMode: restStore ? 'firebase_managed' : 'local',
        firebaseProjectId: restStore ? restStore.config.projectId : null,
        emailPasswordEnabled: fbProviderStatus ? fbProviderStatus.enabled : true,
        providerStatusReason: fbProviderStatus ? fbProviderStatus.rawCode : null,
        emailDeliveryConfigured: fbProviderStatus
          ? fbProviderStatus.enabled
          : emailSender.isConfigured(),
        passwordMinLength: PASSWORD_MIN_LENGTH,
        environmentTarget: store.targetEnv,
        databaseBackend: store.backend,
        persistentDatabase: store.isPersistent,
        ownerBindingConfigured: restStore ? true : Boolean(boundOwner),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/auth/session', async (req: AuthedRequest, res, next) => {
    try {
      if (req.authSession && req.authUser) {
        res.cookie(
          CSRF_COOKIE_NAME,
          req.authSession.csrf_secret,
          buildCookieOptions(req, { httpOnly: false, maxAge: SESSION_TTL_MS })
        );
        const isOwner = await resolveIsBoundOwner(req.authUser);
        return res.json({
          authenticated: true,
          csrfToken: req.authSession.csrf_secret,
          user: serializePublicUser(req.authUser, req.authSession, isOwner),
        });
      }

      let guestCsrf = req.cookies?.[CSRF_COOKIE_NAME];
      if (typeof guestCsrf !== 'string' || !verifySignedGuestCsrfToken(guestCsrf)) {
        guestCsrf = createSignedGuestCsrfToken();
        res.cookie(
          CSRF_COOKIE_NAME,
          guestCsrf,
          buildCookieOptions(req, { httpOnly: false, maxAge: SESSION_TTL_MS })
        );
      }

    return res.json({
      authenticated: false,
      csrfToken: guestCsrf,
      user: null,
    });
    } catch (err) {
      return next(err);
    }
  });

  app.post(
    '/api/auth/register',
    registerLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const requestId = req.requestId || 'unknown';
        if (!restStore && !emailSender.isConfigured()) {
          return sendError(
            req,
            res,
            500,
            'EMAIL_NOT_CONFIGURED',
            'Email verification delivery is not configured on the server yet. Configure SMTP settings in .env to enable registration.'
          );
        }

        const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const confirmPassword =
          typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : undefined;

        if (fullName.length < 2 || fullName.length > 100) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter your full name (2–100 characters).'
          );
        }
        if (!EMAIL_REGEX.test(email)) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid email address.'
          );
        }
        if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`
          );
        }
        if (confirmPassword !== undefined && confirmPassword !== password) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Password and confirmation password do not match.'
          );
        }

        const now = Date.now();
        if (restStore) {
          const providerStatus = await restStore.checkEmailPasswordAuthStatus({
            bypassNegativeCache: true,
          });
          if (!providerStatus.enabled) {
            return sendError(
              req,
              res,
              503,
              'AUTH_PROVIDER_DISABLED',
              'Email and password authentication is currently disabled in Firebase Console for this project. Enable Authentication → Sign-in method → Email/Password to restore signup, login, and password reset.'
            );
          }

          let created: Awaited<ReturnType<typeof firebaseSignUpWithPassword>>;
          try {
            created = await firebaseSignUpWithPassword(
              restStore.config.apiKey,
              email,
              password,
              fullName
            );
          } catch (fbErr) {
            if (fbErr instanceof FirebaseAuthApiError && fbErr.firebaseCode === 'EMAIL_EXISTS') {
              return res.status(200).json({
                requestId,
                message:
                  'If this email is eligible for registration, a verification link has been requested. If you already created an account earlier, sign in or use Forgot Password instead.',
              });
            }
            return handleFirebaseError(req, res, next, fbErr, 'register.firebase_signup');
          }

          if (pendingVerifyTokens.size > 500) {
            pendingVerifyTokens.clear();
          }

          try {
            await firebaseSendVerifyEmail(
              restStore.config.apiKey,
              created.idToken,
              `${resolveAppBaseUrl(req, options.appBaseUrl)}/login`
            );
            pendingVerifyTokens.set(email, {
              idToken: created.idToken,
              lastSentAt: now,
              expiresAt: now + 30 * 60_000,
            });
          } catch (verifyErr) {
            pendingVerifyTokens.set(email, {
              idToken: created.idToken,
              lastSentAt: 0,
              expiresAt: now + 30 * 60_000,
            });
            return handleFirebaseError(req, res, next, verifyErr, 'register.send_verify_email');
          }

          return res.status(200).json({
            requestId,
            acceptedByProvider: true,
            cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
            message:
              'Account created and Firebase Authentication accepted the verification email request. Check your inbox and spam folder to confirm your email address (provider acceptance does not prove inbox delivery).',
          });
        }

        const existing = await store.getUserByEmail(email);

        if (existing) {
          if (!existing.email_verified) {
            const newHash = await hashPassword(password);
            await store.updatePendingEmailUser({
              id: existing.id,
              fullName,
              passwordHash: newHash,
              now,
            });

            try {
              await issueAndSendVerificationEmail({
                req,
                userId: existing.id,
                email,
                purpose: 'verify_email',
              });
            } catch (err) {
              logAuthDiagnostic(requestId, 'register.resend_email', err);
              return sendError(
                req,
                res,
                500,
                'EMAIL_DELIVERY_FAILED',
                'Your account is saved and pending verification, but we could not send the verification email right now. Please try again in a moment.'
              );
            }
          }

          return res.status(200).json({
            requestId,
            message:
              'If this email can be registered, a verification link has been sent. Please check your inbox to activate your account.',
          });
        }

        const userId = crypto.randomUUID();
        const passwordHash = await hashPassword(password);

        await store.createPendingEmailUser({
          id: userId,
          fullName,
          email,
          passwordHash,
          now,
        });

        try {
          await issueAndSendVerificationEmail({
            req,
            userId,
            email,
            purpose: 'verify_email',
          });
        } catch (err) {
          logAuthDiagnostic(requestId, 'register.send_email', err);
          return sendError(
            req,
            res,
            500,
            'EMAIL_DELIVERY_FAILED',
            'Your account was created and is awaiting verification, but we could not deliver the verification email right now. Please retry or use Resend Verification Email.'
          );
        }

        return res.status(200).json({
          requestId,
          message:
            'If this email can be registered, a verification link has been sent. Please check your inbox to activate your account.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/auth/resend-verification',
    registerLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const requestId = req.requestId || 'unknown';
        if (!restStore && !emailSender.isConfigured()) {
          return sendError(
            req,
            res,
            500,
            'EMAIL_NOT_CONFIGURED',
            'Email verification delivery is not configured on the server yet. Configure SMTP settings in .env.'
          );
        }

        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!EMAIL_REGEX.test(email)) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid email address.'
          );
        }

        if (restStore) {
          const now = Date.now();
          const pending = pendingVerifyTokens.get(email);
          const suppliedPassword =
            typeof req.body?.password === 'string' ? req.body.password : '';
          let tokenToUse = pending && now < pending.expiresAt ? pending.idToken : '';

          if (pending && pending.lastSentAt > 0 && now - pending.lastSentAt < VERIFY_RESEND_COOLDOWN_MS) {
            const waitSec = Math.ceil((VERIFY_RESEND_COOLDOWN_MS - (now - pending.lastSentAt)) / 1000);
            return sendError(
              req,
              res,
              429,
              'RESEND_COOLDOWN',
              `Please wait ${waitSec} seconds before requesting another verification email.`,
              { retryAfterSeconds: waitSec }
            );
          }

          if (!tokenToUse && suppliedPassword) {
            try {
              const signIn = await firebaseSignInWithPassword(
                restStore.config.apiKey,
                email,
                suppliedPassword
              );
              const claims = await verifyFirebaseIdToken(
                signIn.idToken,
                restStore.config.projectId
              );
              if (claims?.emailVerified) {
                return res.status(200).json({
                  requestId,
                  alreadyVerified: true,
                  message: 'Your email address is already verified. You can sign in with your password now.',
                });
              }
              tokenToUse = signIn.idToken;
            } catch (fbErr) {
              return handleFirebaseError(req, res, next, fbErr, 'resend_verification.signin');
            }
          }

          if (!tokenToUse) {
            return sendError(
              req,
              res,
              400,
              'PASSWORD_REQUIRED_FOR_RESEND',
              'Enter your password and click Resend verification email so we can verify your session and issue a fresh verification link.'
            );
          }

          try {
            await firebaseSendVerifyEmail(
              restStore.config.apiKey,
              tokenToUse,
              `${resolveAppBaseUrl(req, options.appBaseUrl)}/login`
            );
            pendingVerifyTokens.set(email, {
              idToken: tokenToUse,
              lastSentAt: now,
              expiresAt: now + 30 * 60_000,
            });
            return res.status(200).json({
              requestId,
              acceptedByProvider: true,
              cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
              message:
                'Verification email request accepted by Firebase Authentication. Please check your inbox and spam folder (note: provider acceptance does not prove inbox delivery).',
            });
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr, 'resend_verification.send_email');
          }
        }

        const user = await store.getUserByEmail(email);

        if (user && !user.email_verified) {
          const now = Date.now();
          const latestCreatedAt = await store.getLatestVerifyEmailTokenTimestamp(user.id);

          if (latestCreatedAt && now - latestCreatedAt < VERIFY_RESEND_COOLDOWN_MS) {
            const waitSec = Math.ceil(
              (VERIFY_RESEND_COOLDOWN_MS - (now - latestCreatedAt)) / 1000
            );
            return sendError(
              req,
              res,
              429,
              'RESEND_COOLDOWN',
              `Please wait ${waitSec} seconds before requesting another verification email.`,
              { retryAfterSeconds: waitSec }
            );
          }

          try {
            await issueAndSendVerificationEmail({
              req,
              userId: user.id,
              email,
              purpose: 'verify_email',
            });
          } catch (err) {
            logAuthDiagnostic(requestId, 'resend_verification.send_email', err);
            return sendError(
              req,
              res,
              500,
              'EMAIL_DELIVERY_FAILED',
              'Unable to send the verification email right now. Please check your SMTP settings and try again.'
            );
          }
        }

        return res.status(200).json({
          requestId,
          cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
          message:
            'If an unverified account exists for that email address, a fresh verification link has been sent.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/auth/verify-email',
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        if (!rawToken) {
          return sendError(req, res, 400, 'TOKEN_MISSING', 'Verification token is missing.');
        }

        if (restStore) {
          const oobCode = extractOobCode(rawToken);
          if (!oobCode) {
            return sendError(req, res, 400, 'TOKEN_MISSING', 'Verification code is missing.');
          }
          try {
            const confirmed = await firebaseConfirmVerifyEmailOobCode(
              restStore.config.apiKey,
              oobCode
            );
            return res.json({
              message: `Email address (${confirmed.email}) verified. You can now sign in with your password.`,
              purpose: 'verify_email',
              verifiedEmail: confirmed.email,
            });
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr);
          }
        }

        const tokenHash = sha256Hex(rawToken);
        const now = Date.now();
        const record = await store.getEmailTokenByHash(tokenHash, ['verify_email', 'link_email']);

        if (!record || record.consumed_at !== null || record.expires_at <= now) {
          return sendError(
            req,
            res,
            400,
            'TOKEN_INVALID',
            'This verification link is invalid or has expired.'
          );
        }

        if (record.purpose === 'link_email') {
          const emailConflict = await store.isEmailTakenByOtherUser(
            record.target_email,
            record.user_id
          );

          if (emailConflict) {
            await store.consumeEmailToken(record.id, now);
            return sendError(
              req,
              res,
              409,
              'EMAIL_CONFLICT',
              'This email address cannot be linked to your account.'
            );
          }

          const consumed = await store.consumeEmailToken(record.id, now);
          if (!consumed) {
            return sendError(
              req,
              res,
              400,
              'TOKEN_USED',
              'This verification link has already been used.'
            );
          }

          const updatedUser = await store.linkVerifiedEmailToUser(
            record.user_id,
            record.target_email,
            now
          );

          const activeSession =
            req.authSession && req.authSession.user_id === updatedUser.id
              ? req.authSession
              : (await createSessionForUser(req, res, updatedUser.id)).session;
          const isOwner = await resolveIsBoundOwner(updatedUser);

          return res.json({
            message: 'Email address verified and updated for your account.',
            purpose: 'link_email',
            csrfToken: activeSession.csrf_secret,
            user: serializePublicUser(updatedUser, activeSession, isOwner),
          });
        }

        const consumed = await store.consumeEmailToken(record.id, now);
        if (!consumed) {
          return sendError(
            req,
            res,
            400,
            'TOKEN_USED',
            'This verification link has already been used.'
          );
        }

        const user = await store.markUserEmailVerified(record.user_id, now);
        const { session } = await createSessionForUser(req, res, user.id);
        const isOwner = await resolveIsBoundOwner(user);

        return res.json({
          message: 'Your email has been verified and your account is now active.',
          purpose: 'verify_email',
          csrfToken: session.csrf_secret,
          user: serializePublicUser(user, session, isOwner),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/auth/login',
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!EMAIL_REGEX.test(email) || !password) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid email address and password.'
          );
        }

        if (restStore) {
          let signIn: Awaited<ReturnType<typeof firebaseSignInWithPassword>>;
          try {
            signIn = await firebaseSignInWithPassword(restStore.config.apiKey, email, password);
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr);
          }

          const claims = await verifyFirebaseIdToken(signIn.idToken, restStore.config.projectId);
          if (!claims) {
            return sendError(
              req,
              res,
              401,
              'INVALID_CREDENTIALS',
              'Unable to verify your login token. Please try again.'
            );
          }

          if (!claims.emailVerified) {
            const now = Date.now();
            const existingPending = pendingVerifyTokens.get(email);
            pendingVerifyTokens.set(email, {
              idToken: signIn.idToken,
              lastSentAt: existingPending?.lastSentAt ?? 0,
              expiresAt: now + 30 * 60_000,
            });
            return sendError(
              req,
              res,
              403,
              'EMAIL_NOT_VERIFIED',
              'Your email address is not yet verified. Open the verification link in your inbox or resend a fresh link.'
            );
          }

          const completed = await completeFirebaseSignIn({ req, res, signIn, claims });
          if (!completed.ok) {
            return sendError(req, res, completed.status, completed.code, completed.error);
          }

          return res.json({
            csrfToken: completed.session.csrf_secret,
            user: serializePublicUser(completed.user, completed.session, completed.isOwner),
          });
        }

        const user = await store.getUserByEmail(email);
        const passwordMatches = await verifyPassword(password, user?.password_hash);

        if (!user || !passwordMatches || !user.email_verified) {
          return sendError(
            req,
            res,
            401,
            'INVALID_CREDENTIALS',
            'Invalid email or password, or your email address is not yet verified.'
          );
        }

        const { session } = await createSessionForUser(req, res, user.id);
        const isOwner = await resolveIsBoundOwner(user);
        return res.json({
          csrfToken: session.csrf_secret,
          user: serializePublicUser(user, session, isOwner),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/auth/forgot-password',
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const requestId = req.requestId || 'unknown';
        if (!restStore && !emailSender.isConfigured()) {
          return sendError(
            req,
            res,
            500,
            'EMAIL_NOT_CONFIGURED',
            'Email delivery is not configured on the server yet. Configure SMTP settings in .env to send password reset links.'
          );
        }

        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!EMAIL_REGEX.test(email)) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid email address.'
          );
        }

        if (restStore) {
          const providerStatus = await restStore.checkEmailPasswordAuthStatus({
            bypassNegativeCache: true,
          });
          if (!providerStatus.enabled) {
            return sendError(
              req,
              res,
              503,
              'AUTH_PROVIDER_DISABLED',
              'Password reset is unavailable because Email and Password sign-in is disabled in Firebase Console for this project.'
            );
          }
          try {
            await firebaseSendPasswordReset(
              restStore.config.apiKey,
              email,
              `${resolveAppBaseUrl(req, options.appBaseUrl)}/login`
            );
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr, 'forgot_password.send_email');
          }
          return res.json({
            requestId,
            acceptedByProvider: true,
            message:
              'If a registered email/password account exists for that address, Firebase Authentication accepted the password reset request. Please check your inbox and spam folder (note: provider acceptance alone does not guarantee inbox delivery).',
          });
        }

        const user = await store.getUserByEmail(email);
        if (user && user.email_verified) {
          const now = Date.now();
          const rawToken = generateOpaqueToken(32);
          const tokenHash = sha256Hex(rawToken);
          const tokenId = crypto.randomUUID();

          await store.createEmailToken({
            id: tokenId,
            userId: user.id,
            purpose: 'reset_password',
            targetEmail: email,
            tokenHash,
            expiresAt: now + RESET_PASSWORD_TTL_MS,
            createdAt: now,
            invalidatePreviousSamePurpose: true,
          });

          const resetUrl = `${resolveAppBaseUrl(req, options.appBaseUrl)}/reset-password?token=${encodeURIComponent(rawToken)}`;
          try {
            await emailSender.sendEmail({
              to: email,
              subject: 'Reset your Sahithi Collections password',
              text: `Use this single-use link (valid for 30 minutes) to set a new password: ${resetUrl}`,
              html: buildBoutiqueEmailHtml({
                heading: 'Reset Your Password',
                intro:
                  'We received a request to reset the password for your Sahithi Collections account. If you did not request this, you can safely ignore this email.',
                actionLabel: 'Set New Password',
                actionUrl: resetUrl,
                footnote: 'This single-use link expires in 30 minutes.',
              }),
            });
          } catch (err) {
            await store.deleteEmailToken(tokenId);
            logAuthDiagnostic(requestId, 'forgot_password.send_email', err);
            return sendError(
              req,
              res,
              500,
              'EMAIL_DELIVERY_FAILED',
              'Unable to send the reset email right now. Please try again shortly.'
            );
          }
        }

        return res.json({
          requestId,
          message:
            'If an account exists for that email address, a password reset link has been sent.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/auth/reset-password',
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        const newPassword = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!rawToken) {
          return sendError(req, res, 400, 'TOKEN_MISSING', 'Password reset token is missing.');
        }
        if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 128) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            `New password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`
          );
        }

        if (restStore) {
          const oobCode = extractOobCode(rawToken);
          if (!oobCode) {
            return sendError(req, res, 400, 'TOKEN_MISSING', 'Password reset code is missing.');
          }
          try {
            await firebaseConfirmPasswordResetOobCode(
              restStore.config.apiKey,
              oobCode,
              newPassword
            );
            const nextCsrf = rotateGuestCsrfCookie(req, res);
            return res.json({
              csrfToken: nextCsrf,
              message: 'Your password has been updated. Please sign in with your new password.',
            });
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr);
          }
        }

        const tokenHash = sha256Hex(rawToken);
        const now = Date.now();
        const record = await store.getEmailTokenByHash(tokenHash, ['reset_password']);

        if (!record || record.consumed_at !== null || record.expires_at <= now) {
          return sendError(
            req,
            res,
            400,
            'TOKEN_INVALID',
            'This password reset link is invalid or has expired.'
          );
        }

        const consumed = await store.consumeEmailToken(record.id, now);
        if (!consumed) {
          return sendError(
            req,
            res,
            400,
            'TOKEN_USED',
            'This password reset link has already been used.'
          );
        }

        const nextHash = await hashPassword(newPassword);
        await store.updateUserPasswordHash(record.user_id, nextHash, now);
        await store.revokeUserSessions(record.user_id, now);
        const nextCsrf = rotateGuestCsrfCookie(req, res);

        return res.json({
          csrfToken: nextCsrf,
          message: 'Your password has been updated. Please sign in with your new password.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post('/api/auth/logout', async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      setNoStoreHeaders(res);
      if (restStore) {
        const now = Date.now();
        if (
          req.authUser &&
          req.authUser.email_verified &&
          (req.authUser.email || '').toLowerCase() === restStore.ownerEmail
        ) {
          await restStore.setOwnerSessionRevokedBefore(
            Math.max(now, (req.authSession?.created_at || 0) + 1)
          );
        }
        if (req.fbEnvelope) {
          markFirebaseSessionRevoked(req.fbEnvelope, now);
        }
        setActiveFirestoreIdToken(undefined);
        const nextCsrf = rotateGuestCsrfCookie(req, res);
        return res.json({ csrfToken: nextCsrf, message: 'Signed out successfully.' });
      }

      if (req.authSession) {
        await store.revokeSession(req.authSession.id, Date.now());
      }
      const nextCsrf = rotateGuestCsrfCookie(req, res);
      return res.json({ csrfToken: nextCsrf, message: 'Signed out successfully.' });
    } catch (err) {
      return next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Protected Account Endpoints
  // -------------------------------------------------------------------------

  app.get('/api/account/profile', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const isOwner = await resolveIsBoundOwner(req.authUser!);
      return res.json({
        user: serializePublicUser(req.authUser!, req.authSession!, isOwner),
      });
    } catch (err) {
      return next(err);
    }
  });

  app.patch(
    '/api/account/profile',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
        if (fullName.length < 2 || fullName.length > 100) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid full name (2–100 characters).'
          );
        }

        const updated = await store.updateUserFullName(req.authUser!.id, fullName, Date.now());
        if (restStore && req.fbEnvelope) {
          await firebaseUpdateDisplayName(
            restStore.config.apiKey,
            req.fbEnvelope.idToken,
            fullName
          ).catch(() => undefined);
        }
        const isOwner = await resolveIsBoundOwner(updated);
        return res.json({
          user: serializePublicUser(updated, req.authSession!, isOwner),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/account/reauthenticate',
    requireAuth,
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const user = req.authUser!;
        const session = req.authSession!;
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (restStore && req.fbEnvelope) {
          if (!user.email || !password) {
            return sendError(req, res, 400, 'VALIDATION_ERROR', 'Current password is required.');
          }
          try {
            const signIn = await firebaseSignInWithPassword(
              restStore.config.apiKey,
              user.email,
              password
            );
            const now = Date.now();
            const updatedEnvelope: FirebaseSessionEnvelope = {
              ...req.fbEnvelope,
              idToken: signIn.idToken,
              refreshToken: signIn.refreshToken,
              lastReauthAt: now,
            };
            req.fbEnvelope = updatedEnvelope;
            session.last_reauth_at = now;
            setActiveFirestoreIdToken(signIn.idToken);
            setFirebaseSessionCookies(req, res, updatedEnvelope, restStore);
            const isOwner = await resolveIsBoundOwner(user);
            return res.json({
              message: 'Identity reauthenticated.',
              user: serializePublicUser(user, session, isOwner),
            });
          } catch (fbErr) {
            if (fbErr instanceof FirebaseAuthApiError && fbErr.httpStatus === 401) {
              return sendError(req, res, 401, 'INVALID_PASSWORD', 'Incorrect password.');
            }
            return handleFirebaseError(req, res, next, fbErr);
          }
        }

        if (!user.password_hash) {
          return sendError(
            req,
            res,
            400,
            'NO_PASSWORD_CONFIGURED',
            'No password is configured for this account.'
          );
        }

        const matches = await verifyPassword(password, user.password_hash);
        if (!matches) {
          return sendError(req, res, 401, 'INVALID_PASSWORD', 'Incorrect password.');
        }

        const now = Date.now();
        await store.updateSessionReauth(session.id, now);
        session.last_reauth_at = now;

        const isOwner = await resolveIsBoundOwner(user);
        return res.json({
          message: 'Identity reauthenticated.',
          user: serializePublicUser(user, session, isOwner),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/account/change-password',
    requireRecentReauth,
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const newPassword =
          typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
        if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 128) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`
          );
        }

        if (restStore && req.fbEnvelope) {
          try {
            const updatedTokens = await firebaseUpdatePassword(
              restStore.config.apiKey,
              req.fbEnvelope.idToken,
              newPassword
            );
            const verified = await verifyFirebaseIdToken(
              updatedTokens.idToken,
              restStore.config.projectId
            );
            const now = Date.now();
            const revokedAt = Math.max(now, verified?.authTimeMs || 0);
            const nextIssuedAt = revokedAt + 1;
            const nextSessionId = crypto.randomUUID();
            const updatedEnvelope: FirebaseSessionEnvelope = {
              ...req.fbEnvelope,
              idToken: updatedTokens.idToken,
              refreshToken: updatedTokens.refreshToken,
              sessionId: nextSessionId,
              issuedAt: nextIssuedAt,
              lastReauthAt: now,
            };
            markFirebaseSessionRevoked(req.fbEnvelope, now);
            revokedFirebaseUsersBefore.set(req.authUser!.id, revokedAt);
            req.fbEnvelope = updatedEnvelope;
            setActiveFirestoreIdToken(updatedTokens.idToken);
            if (
              verified &&
              (req.authUser!.email || '').toLowerCase() === restStore.ownerEmail
            ) {
              await restStore.setOwnerSessionRevokedBefore(revokedAt);
            }
            setFirebaseSessionCookies(req, res, updatedEnvelope, restStore);
            const isOwner = await resolveIsBoundOwner(req.authUser!);
            return res.json({
              message: 'Password updated successfully.',
              user: serializePublicUser(req.authUser!, req.authSession!, isOwner),
            });
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr);
          }
        }

        const now = Date.now();
        const nextHash = await hashPassword(newPassword);
        await store.updateUserPasswordHash(req.authUser!.id, nextHash, now);
        await store.revokeUserSessions(req.authUser!.id, now, req.authSession!.id);

        const updated = (await store.getUserById(req.authUser!.id))!;
        const isOwner = await resolveIsBoundOwner(updated);
        return res.json({
          message: 'Password updated successfully.',
          user: serializePublicUser(updated, req.authSession!, isOwner),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/account/link-email',
    requireRecentReauth,
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const requestId = req.requestId || 'unknown';
        if (restStore) {
          return sendError(
            req,
            res,
            400,
            'LINK_EMAIL_UNSUPPORTED',
            'Primary email changes are managed through owner configuration. Create and verify a new account if needed.'
          );
        }
        if (!emailSender.isConfigured()) {
          return sendError(
            req,
            res,
            500,
            'EMAIL_NOT_CONFIGURED',
            'Email delivery is not configured on the server yet. Configure SMTP settings in .env.'
          );
        }

        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!EMAIL_REGEX.test(email)) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid email address.'
          );
        }

        const conflict = await store.isEmailTakenByOtherUser(email, req.authUser!.id);
        if (conflict) {
          return sendError(
            req,
            res,
            409,
            'EMAIL_CONFLICT',
            'This email address cannot be linked to your account.'
          );
        }

        try {
          await issueAndSendVerificationEmail({
            req,
            userId: req.authUser!.id,
            email,
            purpose: 'link_email',
          });
        } catch (err) {
          logAuthDiagnostic(requestId, 'link_email.send_email', err);
          return sendError(
            req,
            res,
            500,
            'EMAIL_DELIVERY_FAILED',
            'Unable to send the verification email right now. Check your SMTP configuration and try again.'
          );
        }

        return res.json({
          requestId,
          message:
            'A verification link has been sent to your email address. Open it to finish updating.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get('/robots.txt', (req: Request, res: Response) => {
    const baseUrl = resolveAppBaseUrl(req, options.appBaseUrl);
    res.type('text/plain').send(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /admin',
        'Disallow: /admin/',
        'Disallow: /api/admin',
        'Disallow: /account',
        `Sitemap: ${baseUrl}/sitemap.xml`,
      ].join('\n')
    );
  });

  app.get('/sitemap.xml', (req: Request, res: Response) => {
    const baseUrl = resolveAppBaseUrl(req, options.appBaseUrl);
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${baseUrl}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`
    );
  });

  app.use('/account', (req: AuthedRequest, res: Response, next: NextFunction) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    setNoStoreHeaders(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    if (!req.authSession || !req.authUser) {
      return res.redirect(302, '/login?next=%2Faccount');
    }
    return next();
  });

  app.use('/admin', async (req: AuthedRequest, res: Response, next: NextFunction) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    setNoStoreHeaders(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    try {
      const subPath = req.path.replace(/\/+$/, '') || '/';
      if (subPath === '/login') {
        if (req.authSession && req.authUser && (await resolveIsBoundOwner(req.authUser))) {
          return res.redirect(302, '/admin/dashboard');
        }
        return next();
      }
      if (!req.authSession || !req.authUser) {
        return res.redirect(302, '/admin/login');
      }
      if (subPath === '/' && (await resolveIsBoundOwner(req.authUser))) {
        return res.redirect(302, '/admin/dashboard');
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Managed Owner Activation, Verification, Login & Password Recovery
  // -------------------------------------------------------------------------

  app.post(
    '/api/admin/activate',
    adminLoginLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!restStore) {
          return sendError(
            req,
            res,
            400,
            'ACTIVATION_UNAVAILABLE',
            'Owner account activation in the browser is only used in managed Firebase Auth mode. Run `npm run admin:setup` on the server.'
          );
        }

        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const fullName =
          typeof req.body?.fullName === 'string' && req.body.fullName.trim().length >= 2
            ? req.body.fullName.trim().slice(0, 100)
            : 'Store Owner';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const confirmPassword =
          typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : password;

        if (!EMAIL_REGEX.test(email)) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid owner email address.'
          );
        }
        if (email !== restStore.ownerEmail) {
          return sendError(
            req,
            res,
            403,
            'OWNER_FORBIDDEN',
            'Only the authorized boutique owner email can activate studio access.'
          );
        }
        if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            `Owner password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`
          );
        }
        if (password !== confirmPassword) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Password and confirmation password do not match.'
          );
        }

        const providerStatus = await restStore.checkEmailPasswordAuthStatus({
          bypassNegativeCache: true,
        });
        if (!providerStatus.enabled) {
          return sendError(
            req,
            res,
            503,
            'AUTH_PROVIDER_DISABLED',
            'Owner account activation is unavailable because Email and Password sign-in is disabled in Firebase Console for this project.'
          );
        }

        const now = Date.now();
        let created: Awaited<ReturnType<typeof firebaseSignUpWithPassword>>;
        try {
          created = await firebaseSignUpWithPassword(
            restStore.config.apiKey,
            email,
            password,
            fullName
          );
        } catch (fbErr) {
          if (fbErr instanceof FirebaseAuthApiError && fbErr.firebaseCode === 'EMAIL_EXISTS') {
            return sendError(
              req,
              res,
              409,
              'ACCOUNT_EXISTS',
              'An owner account already exists for this email address. Switch to Sign In or use Forgot Password to reset your password.'
            );
          }
          return handleFirebaseError(req, res, next, fbErr, 'admin_activate.signup');
        }

        try {
          await firebaseSendVerifyEmail(
            restStore.config.apiKey,
            created.idToken,
            `${resolveAppBaseUrl(req, options.appBaseUrl)}/admin/login`
          );
          if (pendingVerifyTokens.size > 500) {
            pendingVerifyTokens.clear();
          }
          pendingVerifyTokens.set(email, {
            idToken: created.idToken,
            lastSentAt: now,
            expiresAt: now + 30 * 60_000,
          });
          return res.status(201).json({
            requiresVerification: true,
            acceptedByProvider: true,
            cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
            email,
            message:
              'Owner account created and Firebase Authentication accepted the verification email request. Check your inbox and spam folder, click the link to verify, then sign in here (provider acceptance does not prove inbox delivery).',
          });
        } catch (verifyErr) {
          pendingVerifyTokens.set(email, {
            idToken: created.idToken,
            lastSentAt: 0,
            expiresAt: now + 30 * 60_000,
          });
          return handleFirebaseError(req, res, next, verifyErr, 'admin_activate.send_verify_email');
        }
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/activate/confirm',
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!restStore) {
          return sendError(
            req,
            res,
            400,
            'ACTIVATION_UNAVAILABLE',
            'Verification code confirmation is only used in managed Firebase Auth mode.'
          );
        }
        const rawCode =
          typeof req.body?.token === 'string'
            ? req.body.token
            : typeof req.body?.oobCode === 'string'
              ? req.body.oobCode
              : '';
        const oobCode = extractOobCode(rawCode);
        if (!oobCode) {
          return sendError(
            req,
            res,
            400,
            'TOKEN_MISSING',
            'Please provide a valid verification code or Firebase link.'
          );
        }

        try {
          const confirmed = await firebaseConfirmVerifyEmailOobCode(
            restStore.config.apiKey,
            oobCode
          );
          if (confirmed.email !== restStore.ownerEmail) {
            return sendError(
              req,
              res,
              403,
              'OWNER_FORBIDDEN',
              'Verification code does not match the authorized owner email.'
            );
          }
          return res.json({
            verified: true,
            email: confirmed.email,
            message: 'Owner email verified! Enter your password below to enter the dashboard.',
          });
        } catch (fbErr) {
          return handleFirebaseError(req, res, next, fbErr);
        }
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/resend-verification',
    registerLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!restStore) {
          return sendError(
            req,
            res,
            400,
            'ACTIVATION_UNAVAILABLE',
            'Owner verification resend is only used in managed Firebase Auth mode.'
          );
        }
        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!EMAIL_REGEX.test(email) || email !== restStore.ownerEmail) {
          return sendError(
            req,
            res,
            403,
            'OWNER_FORBIDDEN',
            'Verification resend on this endpoint is restricted to the authorized owner email.'
          );
        }

        const now = Date.now();
        const pending = pendingVerifyTokens.get(email);
        if (pending && pending.lastSentAt > 0 && now - pending.lastSentAt < VERIFY_RESEND_COOLDOWN_MS) {
          const waitSec = Math.ceil((VERIFY_RESEND_COOLDOWN_MS - (now - pending.lastSentAt)) / 1000);
          return sendError(
            req,
            res,
            429,
            'RESEND_COOLDOWN',
            `Please wait ${waitSec} seconds before requesting another verification email.`,
            { retryAfterSeconds: waitSec }
          );
        }

        let idTokenToUse = pending && now < pending.expiresAt ? pending.idToken : '';
        if (password) {
          try {
            const signIn = await firebaseSignInWithPassword(
              restStore.config.apiKey,
              email,
              password
            );
            const claims = await verifyFirebaseIdToken(signIn.idToken, restStore.config.projectId);
            if (claims?.emailVerified) {
              return res.json({
                alreadyVerified: true,
                message: 'Your owner email is already verified. Click Login to access the dashboard.',
              });
            }
            idTokenToUse = signIn.idToken;
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr, 'admin_resend_verification.signin');
          }
        }

        if (!idTokenToUse) {
          return sendError(
            req,
            res,
            400,
            'PASSWORD_REQUIRED_FOR_RESEND',
            'Enter your owner password and click Resend verification email to issue a fresh verification link.'
          );
        }

        try {
          await firebaseSendVerifyEmail(
            restStore.config.apiKey,
            idTokenToUse,
            `${resolveAppBaseUrl(req, options.appBaseUrl)}/admin/login`
          );
          pendingVerifyTokens.set(email, {
            idToken: idTokenToUse,
            lastSentAt: now,
            expiresAt: now + 30 * 60_000,
          });
          return res.json({
            acceptedByProvider: true,
            cooldownSeconds: Math.ceil(VERIFY_RESEND_COOLDOWN_MS / 1000),
            message:
              'Verification email request accepted by Firebase Authentication for your owner email. Check your inbox and spam folder (provider acceptance does not prove inbox delivery).',
          });
        } catch (fbErr) {
          return handleFirebaseError(req, res, next, fbErr, 'admin_resend_verification.send_email');
        }
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/forgot-password',
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!restStore) {
          return sendError(
            req,
            res,
            400,
            'PASSWORD_RESET_UNAVAILABLE',
            'Use `npm run admin:setup` on the server when running without Firebase Auth.'
          );
        }
        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!EMAIL_REGEX.test(email)) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid owner email address.'
          );
        }

        const providerStatus = await restStore.checkEmailPasswordAuthStatus({
          bypassNegativeCache: true,
        });
        if (!providerStatus.enabled) {
          return sendError(
            req,
            res,
            503,
            'AUTH_PROVIDER_DISABLED',
            'Owner password reset is unavailable because Email and Password sign-in is disabled in Firebase Console for this project.'
          );
        }

        if (email === restStore.ownerEmail) {
          try {
            await firebaseSendPasswordReset(
              restStore.config.apiKey,
              email,
              `${resolveAppBaseUrl(req, options.appBaseUrl)}/admin/login`
            );
          } catch (fbErr) {
            return handleFirebaseError(req, res, next, fbErr, 'admin_forgot_password.send_email');
          }
        }

        return res.json({
          acceptedByProvider: email === restStore.ownerEmail,
          message:
            'If this owner email has an activated email/password account, Firebase Authentication accepted the password reset request. Check your inbox and spam folder (provider acceptance alone does not guarantee inbox delivery).',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/password-reset/confirm',
    authLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!restStore) {
          return sendError(
            req,
            res,
            400,
            'PASSWORD_RESET_UNAVAILABLE',
            'Password reset confirmation via code requires Firebase Auth mode.'
          );
        }
        const rawCode =
          typeof req.body?.token === 'string'
            ? req.body.token
            : typeof req.body?.oobCode === 'string'
              ? req.body.oobCode
              : '';
        const newPassword = typeof req.body?.password === 'string' ? req.body.password : '';
        const oobCode = extractOobCode(rawCode);
        if (!oobCode) {
          return sendError(req, res, 400, 'TOKEN_MISSING', 'Password reset code is missing.');
        }
        if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 128) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            `Password must be between ${PASSWORD_MIN_LENGTH} and 128 characters.`
          );
        }

        try {
          await firebaseConfirmPasswordResetOobCode(
            restStore.config.apiKey,
            oobCode,
            newPassword
          );
          const nextCsrf = rotateGuestCsrfCookie(req, res);
          return res.json({
            csrfToken: nextCsrf,
            message: 'Your owner password has been updated. Sign in below with your new password.',
          });
        } catch (fbErr) {
          return handleFirebaseError(req, res, next, fbErr);
        }
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/login',
    adminLoginLimiter,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      if (!restStore) {
        return next();
      }
      try {
        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!EMAIL_REGEX.test(email) || !password) {
          return sendError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter your owner email and password.'
          );
        }

        if (email !== restStore.ownerEmail) {
          return sendError(
            req,
            res,
            403,
            'OWNER_FORBIDDEN',
            'This account does not have store owner permissions.'
          );
        }

        let signIn: Awaited<ReturnType<typeof firebaseSignInWithPassword>>;
        try {
          signIn = await firebaseSignInWithPassword(restStore.config.apiKey, email, password);
        } catch (fbErr) {
          return handleFirebaseError(req, res, next, fbErr);
        }

        const claims = await verifyFirebaseIdToken(signIn.idToken, restStore.config.projectId);
        if (!claims) {
          return sendError(
            req,
            res,
            401,
            'INVALID_CREDENTIALS',
            'Unable to verify authentication token.'
          );
        }

        if (!claims.emailVerified) {
          const now = Date.now();
          const existingPending = pendingVerifyTokens.get(email);
          pendingVerifyTokens.set(email, {
            idToken: signIn.idToken,
            lastSentAt: existingPending?.lastSentAt ?? 0,
            expiresAt: now + 30 * 60_000,
          });
          return sendError(
            req,
            res,
            403,
            'EMAIL_NOT_VERIFIED',
            'Your owner email is not yet verified. Open the verification link sent to your inbox or click Resend verification email below.'
          );
        }

        const completed = await completeFirebaseSignIn({ req, res, signIn, claims });
        if (!completed.ok) {
          return sendError(req, res, completed.status, completed.code, completed.error);
        }

        return res.json({
          csrfToken: completed.session.csrf_secret,
          user: serializePublicUser(completed.user, completed.session, true),
          ownerBinding: completed.ownerBinding
            ? {
                boundAt: completed.ownerBinding.bound_at,
                boundVia: completed.ownerBinding.bound_via,
              }
            : {
                boundAt: Date.now(),
                boundVia: 'firebase_verified_owner',
              },
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  registerCatalogAndAdminRoutes({
    app,
    store,
    authLimiter,
    adminLoginLimiter,
    contactLimiter,
    createSessionForUser,
    verifyPassword,
    serializePublicUser,
  });

  app.use('/api', (req: AuthedRequest, res: Response) => {
    const requestId = req.requestId || crypto.randomUUID();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.status(404).json({
      code: 'API_ROUTE_NOT_FOUND',
      error: `API endpoint not found (${req.method} ${req.originalUrl || req.url}).`,
      requestId,
    });
  });

  app.use('/api', (err: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
    const requestId = req.requestId || crypto.randomUUID();
    const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
    if (err instanceof SyntaxError && errObj?.status === 400 && 'body' in errObj) {
      return res.status(400).json({
        code: 'INVALID_JSON',
        error: 'Invalid request payload format.',
        requestId,
      });
    }
    if (err instanceof StoreHttpError) {
      logAuthDiagnostic(requestId, `store_error_${err.httpStatus}_${err.code}`, err);
      return res.status(err.httpStatus).json({
        code: err.code,
        error: err.message,
        requestId,
      });
    }
    logAuthDiagnostic(requestId, 'unhandled_api_error', err);
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Unable to complete the request due to a temporary server issue. Please try again.',
      requestId,
    });
  });

  return { app, store, db: sqliteDb };
}
