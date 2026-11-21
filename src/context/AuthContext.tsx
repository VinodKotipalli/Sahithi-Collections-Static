import { fetchApi } from '../services/apiTransport';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  clearClientFirebaseSession,
  handleClientlessApiRequest,
} from '../services/firebaseClientApi';
import {
  signOutFirebaseWebAuth,
  syncEmailPasswordWithFirebaseWebSdk,
} from '../services/firebaseWebAuth';
import type { NotificationPreferences } from '../types/boutique';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string | null;
  phone?: string | null;
  verifiedPhone?: string | null;
  notificationPrefs?: NotificationPreferences;
  emailVerified: boolean;
  phoneVerified?: boolean;
  hasPassword: boolean;
  isOwner: boolean;
  recentReauthValid: boolean;
  recentReauthExpiresAt: number;
}

export interface AuthCapabilities {
  emailDeliveryConfigured: boolean;
  emailPasswordEnabled?: boolean;
  phoneOtpEnabled?: boolean;
  providerStatusReason?: string | null;
  firebaseProjectId?: string | null;
  passwordMinLength: number;
  authMode?: 'local' | 'firebase_managed';
  environmentTarget?: string;
  databaseBackend?: 'firestore' | 'sqlite';
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      code?: string;
      requestId?: string;
      retryAfterSeconds?: number;
      error: string;
      fieldErrors?: Record<string, string>;
    };

interface AuthContextValue {
  user: AuthUser | null;
  capabilities: AuthCapabilities;
  isLoadingSession: boolean;
  refreshSession: () => Promise<void>;
  refreshCapabilities: () => Promise<AuthCapabilities | null>;
  loginWithEmail: (email: string, password: string) => Promise<ApiResult<{ user: AuthUser }>>;
  establishPhoneSession: (input: {
    idToken: string;
    refreshToken: string;
    fullName?: string;
  }) => Promise<ApiResult<{ user: AuthUser }>>;
  registerWithEmail: (
    fullName: string,
    email: string,
    password: string,
    confirmPassword: string
  ) => Promise<
    ApiResult<{
      message: string;
      acceptedByProvider?: boolean;
      cooldownSeconds?: number;
      requestId?: string;
    }>
  >;
  resendVerificationEmail: (
    email: string,
    password?: string
  ) => Promise<
    ApiResult<{
      message: string;
      alreadyVerified?: boolean;
      acceptedByProvider?: boolean;
      cooldownSeconds?: number;
      requestId?: string;
    }>
  >;
  verifyEmailToken: (
    token: string
  ) => Promise<
    ApiResult<{
      message: string;
      purpose: 'verify_email' | 'link_email';
      user?: AuthUser;
      verifiedEmail?: string;
    }>
  >;
  requestPasswordReset: (email: string) => Promise<ApiResult<{ message: string }>>;
  resetPassword: (token: string, password: string) => Promise<ApiResult<{ message: string }>>;
  updateProfileName: (fullName: string) => Promise<ApiResult<{ user: AuthUser }>>;
  updateProfile: (input: {
    fullName?: string;
    phone?: string | null;
    notificationPrefs?: Partial<NotificationPreferences>;
  }) => Promise<ApiResult<{ user: AuthUser }>>;
  deleteAccount: (
    confirmText: string
  ) => Promise<ApiResult<{ ok: boolean; deletedUserId: string; message: string }>>;
  reauthenticateWithPassword: (
    password: string
  ) => Promise<ApiResult<{ message: string; user: AuthUser }>>;
  reauthenticateWithPhoneToken: (input: {
    idToken: string;
    refreshToken: string;
  }) => Promise<ApiResult<{ message: string; user: AuthUser }>>;
  syncLinkedPhone: (input: {
    idToken: string;
    refreshToken: string;
  }) => Promise<ApiResult<{ message: string; user: AuthUser }>>;
  changePassword: (newPassword: string) => Promise<ApiResult<{ message: string; user: AuthUser }>>;
  requestLinkEmail: (email: string) => Promise<ApiResult<{ message: string }>>;
  logout: () => Promise<ApiResult<{ message: string }>>;
  loginAdminWithEmail: (
    email: string,
    password: string
  ) => Promise<ApiResult<{ user: AuthUser; ownerBinding: { boundAt: number; boundVia: string } }>>;
  activateAdminAccount: (
    email: string,
    password: string,
    confirmPassword: string
  ) => Promise<
    ApiResult<{
      requiresVerification: boolean;
      email: string;
      message: string;
      acceptedByProvider?: boolean;
      cooldownSeconds?: number;
    }>
  >;
  confirmAdminActivation: (
    token: string
  ) => Promise<ApiResult<{ verified: boolean; email: string; message: string }>>;
  resendAdminVerification: (
    email: string,
    password?: string
  ) => Promise<
    ApiResult<{
      message: string;
      alreadyVerified?: boolean;
      acceptedByProvider?: boolean;
      cooldownSeconds?: number;
    }>
  >;
  requestAdminPasswordReset: (email: string) => Promise<ApiResult<{ message: string }>>;
  confirmAdminPasswordReset: (
    token: string,
    password: string
  ) => Promise<ApiResult<{ message: string }>>;
  apiRequest: <T>(path: string, options?: RequestInit) => Promise<ApiResult<T>>;
}

const DEFAULT_CAPABILITIES: AuthCapabilities = {
  emailDeliveryConfigured: false,
  emailPasswordEnabled: true,
  providerStatusReason: null,
  passwordMinLength: 8,
  authMode: 'local',
};

const AuthContext = createContext<AuthContextValue | null>(null);

function normalizeApiPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '/api';
  // Strip any accidental localhost origin so deployed frontend always uses same-origin relative /api/* paths
  const withoutLocalhost = trimmed.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i, '');
  const withLeadingSlash = withoutLocalhost.startsWith('/')
    ? withoutLocalhost
    : `/${withoutLocalhost}`;
  const [pathname, query] = withLeadingSlash.split('?');
  const cleanPathname =
    pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return query ? `${cleanPathname}?${query}` : cleanPathname;
}

async function readJsonBody(
  response: Response
): Promise<{ isJson: boolean; payload: Record<string, unknown> }> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  try {
    const text = await response.text();
    if (!text.trim()) {
      return { isJson: false, payload: {} };
    }
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { isJson: true, payload: parsed as Record<string, unknown> };
    }
    return { isJson: contentType.includes('application/json'), payload: {} };
  } catch {
    return { isJson: false, payload: {} };
  }
}

const API_SESSION_TOKEN_KEY = 'sahithi_api_session_token_v1';

function readStoredApiSessionToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(API_SESSION_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredApiSessionToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (!token || token === 'cleared') {
      window.sessionStorage.removeItem(API_SESSION_TOKEN_KEY);
    } else {
      window.sessionStorage.setItem(API_SESSION_TOKEN_KEY, token);
    }
  } catch {
    // Ignore storage errors
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities>(DEFAULT_CAPABILITIES);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const csrfTokenRef = useRef<string>('');
  const sessionTokenRef = useRef<string>(readStoredApiSessionToken());
  const isLoggingOutRef = useRef<boolean>(false);
  const sessionEpochRef = useRef<number>(0);

  const captureSessionHeader = useCallback((res: Response) => {
    const headerToken = res.headers.get('X-Sahithi-Session-Token');
    if (!headerToken) return;
    if (headerToken === 'cleared') {
      sessionTokenRef.current = '';
      writeStoredApiSessionToken('');
    } else {
      sessionTokenRef.current = headerToken;
      writeStoredApiSessionToken(headerToken);
    }
  }, []);

  const buildBaseHeaders = useCallback((existing?: HeadersInit): Headers => {
    const headers = new Headers(existing || {});
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    headers.set('X-Sahithi-Client', 'web-spa');
    const activeToken = sessionTokenRef.current || readStoredApiSessionToken();
    if (activeToken && !headers.has('X-Sahithi-Session')) {
      headers.set('X-Sahithi-Session', activeToken);
    }
    return headers;
  }, []);

  const syncSessionAndCapabilities = useCallback(async () => {
    const syncEpoch = sessionEpochRef.current;
    try {
      const [sessionRes, capRes] = await Promise.all([
        fetchApi(normalizeApiPath('/api/auth/session'), {
          credentials: 'include',
          cache: 'no-store',
          headers: buildBaseHeaders(),
        }),
        fetchApi(normalizeApiPath('/api/auth/capabilities?refresh=1'), {
          credentials: 'include',
          cache: 'no-store',
          headers: buildBaseHeaders(),
        }),
      ]);

      captureSessionHeader(sessionRes);
      const sessionBody = await readJsonBody(sessionRes);

      if (sessionRes.ok && sessionBody.isJson) {
        const sessionData = sessionBody.payload as {
          authenticated?: boolean;
          csrfToken?: string;
          user?: AuthUser | null;
        };
        if (typeof sessionData.csrfToken === 'string' && sessionData.csrfToken) {
          csrfTokenRef.current = sessionData.csrfToken;
        }
        if (syncEpoch === sessionEpochRef.current && !isLoggingOutRef.current) {
          setUser(sessionData.authenticated ? (sessionData.user ?? null) : null);
        }
      } else if (
        sessionRes.status === 404 ||
        sessionRes.status === 405 ||
        !sessionBody.isJson
      ) {
        const fallbackSession = await handleClientlessApiRequest<{
          authenticated?: boolean;
          csrfToken?: string;
          user?: AuthUser | null;
        }>('/api/auth/session', 'GET');
        if (
          fallbackSession.ok &&
          syncEpoch === sessionEpochRef.current &&
          !isLoggingOutRef.current
        ) {
          if (fallbackSession.data.csrfToken) {
            csrfTokenRef.current = fallbackSession.data.csrfToken;
          }
          setUser(fallbackSession.data.authenticated ? (fallbackSession.data.user ?? null) : null);
        }
      }

      const capBody = await readJsonBody(capRes);
      if (capRes.ok && capBody.isJson && typeof capBody.payload.passwordMinLength === 'number') {
        setCapabilities(capBody.payload as unknown as AuthCapabilities);
      } else if (capRes.status === 404 || capRes.status === 405 || !capBody.isJson) {
        const fallbackCap = await handleClientlessApiRequest<AuthCapabilities>(
          '/api/auth/capabilities?refresh=1',
          'GET'
        );
        if (fallbackCap.ok) {
          setCapabilities(fallbackCap.data);
        }
      }
    } catch {
      const fallbackSession = await handleClientlessApiRequest<{
        authenticated?: boolean;
        csrfToken?: string;
        user?: AuthUser | null;
      }>('/api/auth/session', 'GET').catch(() => null);
      if (
        fallbackSession &&
        fallbackSession.ok &&
        syncEpoch === sessionEpochRef.current &&
        !isLoggingOutRef.current
      ) {
        setUser(fallbackSession.data.authenticated ? (fallbackSession.data.user ?? null) : null);
      }
    } finally {
      setIsLoadingSession(false);
    }
  }, [buildBaseHeaders, captureSessionHeader]);

  const refreshCapabilities = useCallback(async (): Promise<AuthCapabilities | null> => {
    try {
      const capRes = await fetchApi(normalizeApiPath('/api/auth/capabilities?refresh=1'), {
        credentials: 'include',
        cache: 'no-store',
        headers: buildBaseHeaders(),
      });
      const { isJson, payload } = await readJsonBody(capRes);
      if (capRes.ok && isJson && typeof payload.passwordMinLength === 'number') {
        const capData = payload as unknown as AuthCapabilities;
        setCapabilities(capData);
        return capData;
      }
      if (capRes.status === 404 || capRes.status === 405 || !isJson) {
        const fallbackCap = await handleClientlessApiRequest<AuthCapabilities>(
          '/api/auth/capabilities?refresh=1',
          'GET'
        );
        if (fallbackCap.ok) {
          setCapabilities(fallbackCap.data);
          return fallbackCap.data;
        }
      }
      return null;
    } catch {
      return null;
    }
  }, [buildBaseHeaders]);

  useEffect(() => {
    void syncSessionAndCapabilities();
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void syncSessionAndCapabilities();
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [syncSessionAndCapabilities]);

  const ensureCsrfToken = useCallback(
    async (forceRefresh = false): Promise<string> => {
      if (!forceRefresh && csrfTokenRef.current) {
        return csrfTokenRef.current;
      }
      const csrfEpoch = sessionEpochRef.current;
      try {
        const res = await fetchApi(normalizeApiPath('/api/auth/session'), {
          credentials: 'include',
          cache: 'no-store',
          headers: buildBaseHeaders(),
        });
        captureSessionHeader(res);
        const { isJson, payload } = await readJsonBody(res);
        if (res.ok && isJson) {
          const data = payload as {
            csrfToken?: string;
            authenticated?: boolean;
            user?: AuthUser | null;
          };
          if (typeof data.csrfToken === 'string' && data.csrfToken) {
            csrfTokenRef.current = data.csrfToken;
          }
          if (csrfEpoch === sessionEpochRef.current && !isLoggingOutRef.current) {
            setUser(data.authenticated ? (data.user ?? null) : null);
          }
        } else if (res.status === 404 || res.status === 405 || !isJson) {
          const fallback = await handleClientlessApiRequest<{ csrfToken?: string }>(
            '/api/auth/session',
            'GET'
          );
          if (fallback.ok && fallback.data.csrfToken) {
            csrfTokenRef.current = fallback.data.csrfToken;
          }
        }
      } catch {
        // Fallback token so request can still proceed
      }
      if (!csrfTokenRef.current) {
        csrfTokenRef.current = `spa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      }
      return csrfTokenRef.current;
    },
    [buildBaseHeaders, captureSessionHeader]
  );

  const requestApi = useCallback(
    async <T,>(
      path: string,
      options: RequestInit = {},
      hasRetriedCsrf = false,
      hasRetriedRedirect = false
    ): Promise<ApiResult<T>> => {
      const normalizedPath = normalizeApiPath(path);
      const method = (options.method || 'GET').toUpperCase();
      try {
        const headers = buildBaseHeaders(options.headers);
        const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
        if (method !== 'GET' && method !== 'HEAD') {
          const token = await ensureCsrfToken(hasRetriedCsrf);
          if (token) {
            headers.set('X-CSRF-Token', token);
          }
          if (!isFormData && !headers.has('Content-Type') && options.body) {
            headers.set('Content-Type', 'application/json');
          }
        }

        const response = await fetchApi(normalizedPath, {
          ...options,
          headers,
          credentials: 'include',
          cache: 'no-store',
        });

        captureSessionHeader(response);
        const { isJson, payload } = await readJsonBody(response);

        if (typeof payload.csrfToken === 'string' && payload.csrfToken) {
          csrfTokenRef.current = payload.csrfToken;
        }

        const headerOrigStatus = Number(
          response.headers.get('X-Sahithi-Original-Status') || 0
        );
        const payloadOrigStatus =
          typeof payload.status === 'number' ? payload.status : 0;
        const effectiveStatus =
          headerOrigStatus || payloadOrigStatus || response.status;
        const code = typeof payload.code === 'string' ? payload.code : undefined;

        // 1. If nginx's 302 auth-bridge redirect converted our POST into a GET, retry the POST once
        if (
          !hasRetriedRedirect &&
          method !== 'GET' &&
          method !== 'HEAD' &&
          (code === 'METHOD_REDIRECTED_RETRY' ||
            (response.redirected && effectiveStatus === 404))
        ) {
          return requestApi<T>(normalizedPath, options, hasRetriedCsrf, true);
        }

        // 2. If deployed on a static frontend host without Express /api/* routes (404 / 405 / HTML SPA fallback), execute directly against Firebase Auth & Firestore REST
        const isMissingBackendRoute =
          response.headers.get('X-Sahithi-Transport') !== 'firebase' &&
          (((effectiveStatus === 404 || effectiveStatus === 405) &&
            (!isJson || code === 'API_ROUTE_NOT_FOUND')) ||
            (response.ok && !isJson));

        if (isMissingBackendRoute) {
          const clientlessResult = await handleClientlessApiRequest<T>(
            normalizedPath,
            method,
            options.body
          );
          if (!clientlessResult.ok && clientlessResult.status === 401) {
            sessionEpochRef.current += 1;
            setUser(null);
          }
          return clientlessResult;
        }

        const isErrorResponse = !response.ok || effectiveStatus >= 400;
        if (isErrorResponse) {
          if (
            effectiveStatus === 403 &&
            !hasRetriedCsrf &&
            method !== 'GET' &&
            method !== 'HEAD' &&
            (code === 'CSRF_INVALID' ||
              code === 'CSRF_EXPIRED' ||
              code === 'CSRF_MISSING' ||
              !isJson)
          ) {
            csrfTokenRef.current = '';
            return requestApi<T>(normalizedPath, options, true, hasRetriedRedirect);
          }

          if (effectiveStatus === 401) {
            sessionEpochRef.current += 1;
            setUser(null);
          }
          const serverError = typeof payload.error === 'string' ? payload.error : null;
          const rawFieldErrors =
            payload.fieldErrors &&
            typeof payload.fieldErrors === 'object' &&
            !Array.isArray(payload.fieldErrors)
              ? (payload.fieldErrors as Record<string, unknown>)
              : null;
          const fieldErrors: Record<string, string> | undefined = rawFieldErrors
            ? Object.fromEntries(
                Object.entries(rawFieldErrors).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string'
                )
              )
            : undefined;
          return {
            ok: false,
            status: effectiveStatus,
            code: code || (!isJson && effectiveStatus === 404 ? 'API_ROUTE_NOT_FOUND' : undefined),
            requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
            retryAfterSeconds:
              typeof payload.retryAfterSeconds === 'number' ? payload.retryAfterSeconds : undefined,
            ...(fieldErrors && Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
            error:
              serverError ||
              (!isJson && effectiveStatus === 404
                ? `The authentication service endpoint (${method} ${normalizedPath}) was not found on this host (HTTP 404).`
                : !isJson
                  ? `The server returned an unexpected response (HTTP ${effectiveStatus}). Please refresh the page and try again.`
                  : `Request failed (HTTP ${effectiveStatus}). Please try again.`),
          };
        }

        return { ok: true, data: payload as T };
      } catch {
        // If fetch itself failed on a static/offline proxy, attempt direct Firebase REST execution for auth/storefront endpoints
        const clientlessResult = await handleClientlessApiRequest<T>(
          normalizedPath,
          method,
          options.body
        );
        if (clientlessResult.ok || clientlessResult.status !== 404) {
          if (!clientlessResult.ok && clientlessResult.status === 401) {
            sessionEpochRef.current += 1;
            setUser(null);
          }
          return clientlessResult;
        }
        return {
          ok: false,
          status: 0,
          error: 'Network error. Please check your connection and try again.',
        };
      }
    },
    [buildBaseHeaders, captureSessionHeader, ensureCsrfToken]
  );

  const loginWithEmail = useCallback(
    async (email: string, password: string) => {
      const res = await requestApi<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
        if (capabilities.authMode === 'firebase_managed') {
          void syncEmailPasswordWithFirebaseWebSdk(email, password);
        }
      }
      return res;
    },
    [capabilities.authMode, requestApi]
  );

  const establishPhoneSession = useCallback(
    async (input: { idToken: string; refreshToken: string; fullName?: string }) => {
      const res = await requestApi<{ user: AuthUser }>('/api/auth/phone-session', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
        try {
          if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel('sahithi-boutique-sync');
            ch.postMessage({ topic: 'account', at: Date.now() });
            ch.close();
          }
        } catch {
          // ignore
        }
      }
      return res;
    },
    [requestApi]
  );

  const registerWithEmail = useCallback(
    (fullName: string, email: string, password: string, confirmPassword: string) =>
      requestApi<{
        message: string;
        acceptedByProvider?: boolean;
        cooldownSeconds?: number;
        requestId?: string;
      }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ fullName, email, password, confirmPassword }),
      }),
    [requestApi]
  );

  const resendVerificationEmail = useCallback(
    (email: string, password?: string) =>
      requestApi<{
        message: string;
        alreadyVerified?: boolean;
        acceptedByProvider?: boolean;
        cooldownSeconds?: number;
        requestId?: string;
      }>('/api/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email, ...(password ? { password } : {}) }),
      }),
    [requestApi]
  );

  const verifyEmailToken = useCallback(
    async (token: string) => {
      const res = await requestApi<{
        message: string;
        purpose: 'verify_email' | 'link_email';
        user?: AuthUser;
        verifiedEmail?: string;
      }>('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      if (res.ok && res.data.user) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
      }
      return res;
    },
    [requestApi]
  );

  const requestPasswordReset = useCallback(
    (email: string) =>
      requestApi<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    [requestApi]
  );

  const resetPassword = useCallback(
    async (token: string, password: string) => {
      const res = await requestApi<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(null);
      }
      return res;
    },
    [requestApi]
  );

  const updateProfile = useCallback(
    async (input: {
      fullName?: string;
      phone?: string | null;
      notificationPrefs?: Partial<NotificationPreferences>;
    }) => {
      const res = await requestApi<{ user: AuthUser }>('/api/account/profile', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
        try {
          if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel('sahithi-boutique-sync');
            ch.postMessage({ topic: 'account', at: Date.now() });
            ch.close();
          }
        } catch {
          // ignore
        }
      }
      return res;
    },
    [requestApi]
  );

  const updateProfileName = useCallback(
    (fullName: string) => updateProfile({ fullName }),
    [updateProfile]
  );

  const deleteAccount = useCallback(
    async (confirmText: string) => {
      const res = await requestApi<{
        ok: boolean;
        deletedUserId: string;
        csrfToken?: string;
        message: string;
      }>('/api/account/profile', {
        method: 'DELETE',
        body: JSON.stringify({ confirmText }),
      });
      if (res.ok) {
        sessionEpochRef.current += 1;
        sessionTokenRef.current = '';
        writeStoredApiSessionToken('');
        clearClientFirebaseSession();
        if (capabilities.authMode === 'firebase_managed') {
          await signOutFirebaseWebAuth();
        }
        if (typeof res.data.csrfToken === 'string' && res.data.csrfToken) {
          csrfTokenRef.current = res.data.csrfToken;
        }
        setUser(null);
        try {
          if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel('sahithi-boutique-sync');
            ch.postMessage({ topic: 'account', at: Date.now() });
            ch.close();
          }
        } catch {
          // ignore
        }
      }
      return res;
    },
    [capabilities.authMode, requestApi]
  );

  const reauthenticateWithPassword = useCallback(
    async (password: string) => {
      const res = await requestApi<{ message: string; user: AuthUser }>(
        '/api/account/reauthenticate',
        {
          method: 'POST',
          body: JSON.stringify({ password }),
        }
      );
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
        if (capabilities.authMode === 'firebase_managed' && res.data.user.email) {
          void syncEmailPasswordWithFirebaseWebSdk(res.data.user.email, password);
        }
      }
      return res;
    },
    [capabilities.authMode, requestApi]
  );

  const reauthenticateWithPhoneToken = useCallback(
    async (input: { idToken: string; refreshToken: string }) => {
      const res = await requestApi<{ message: string; user: AuthUser }>(
        '/api/account/reauthenticate',
        {
          method: 'POST',
          body: JSON.stringify(input),
        }
      );
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
      }
      return res;
    },
    [requestApi]
  );

  const syncLinkedPhone = useCallback(
    async (input: { idToken: string; refreshToken: string }) => {
      const res = await requestApi<{ message: string; user: AuthUser }>(
        '/api/account/phone',
        {
          method: 'POST',
          body: JSON.stringify(input),
        }
      );
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
        try {
          if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel('sahithi-boutique-sync');
            ch.postMessage({ topic: 'account', at: Date.now() });
            ch.close();
          }
        } catch {
          // ignore
        }
      }
      return res;
    },
    [requestApi]
  );

  const changePassword = useCallback(
    async (newPassword: string) => {
      const res = await requestApi<{ message: string; user: AuthUser }>(
        '/api/account/change-password',
        {
          method: 'POST',
          body: JSON.stringify({ newPassword }),
        }
      );
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
      }
      return res;
    },
    [requestApi]
  );

  const requestLinkEmail = useCallback(
    (email: string) =>
      requestApi<{ message: string }>('/api/account/link-email', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    [requestApi]
  );

  const loginAdminWithEmail = useCallback(
    async (email: string, password: string) => {
      const res = await requestApi<{
        user: AuthUser;
        ownerBinding: { boundAt: number; boundVia: string };
      }>('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        sessionEpochRef.current += 1;
        setUser(res.data.user);
      }
      return res;
    },
    [requestApi]
  );

  const activateAdminAccount = useCallback(
    (email: string, password: string, confirmPassword: string) =>
      requestApi<{
        requiresVerification: boolean;
        email: string;
        message: string;
        acceptedByProvider?: boolean;
        cooldownSeconds?: number;
      }>('/api/admin/activate', {
        method: 'POST',
        body: JSON.stringify({ email, password, confirmPassword }),
      }),
    [requestApi]
  );

  const confirmAdminActivation = useCallback(
    (token: string) =>
      requestApi<{ verified: boolean; email: string; message: string }>(
        '/api/admin/activate/confirm',
        {
          method: 'POST',
          body: JSON.stringify({ token }),
        }
      ),
    [requestApi]
  );

  const resendAdminVerification = useCallback(
    (email: string, password?: string) =>
      requestApi<{
        message: string;
        alreadyVerified?: boolean;
        acceptedByProvider?: boolean;
        cooldownSeconds?: number;
      }>('/api/admin/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email, ...(password ? { password } : {}) }),
      }),
    [requestApi]
  );

  const requestAdminPasswordReset = useCallback(
    (email: string) =>
      requestApi<{ message: string }>('/api/admin/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    [requestApi]
  );

  const confirmAdminPasswordReset = useCallback(
    (token: string, password: string) =>
      requestApi<{ message: string }>('/api/admin/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      }),
    [requestApi]
  );

  const logout = useCallback(async (): Promise<ApiResult<{ message: string }>> => {
    sessionEpochRef.current += 1;
    isLoggingOutRef.current = true;
    try {
      const res = await requestApi<{ message: string; csrfToken?: string }>('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        return res;
      }

      sessionTokenRef.current = '';
      writeStoredApiSessionToken('');
      clearClientFirebaseSession();
      if (capabilities.authMode === 'firebase_managed') {
        await signOutFirebaseWebAuth();
      }

      const verifyRes = await requestApi<{
        authenticated?: boolean;
        csrfToken?: string;
        user?: AuthUser | null;
      }>('/api/auth/session', { method: 'GET' });

      if (!verifyRes.ok) {
        return {
          ok: false,
          status: verifyRes.status,
          code: 'LOGOUT_VERIFY_FAILED',
          error: 'Unable to confirm that your session ended. Please try signing out again.',
        };
      }

      if (typeof verifyRes.data.csrfToken === 'string' && verifyRes.data.csrfToken) {
        csrfTokenRef.current = verifyRes.data.csrfToken;
      }

      if (verifyRes.data.authenticated) {
        setUser(verifyRes.data.user ?? null);
        return {
          ok: false,
          status: 500,
          code: 'LOGOUT_INCOMPLETE',
          error: 'Your session remained active on the server. Please try signing out again.',
        };
      }

      setUser(null);
      return res;
    } finally {
      isLoggingOutRef.current = false;
    }
  }, [capabilities.authMode, requestApi]);

  return (
    <AuthContext.Provider
      value={{
        user,
        capabilities,
        isLoadingSession,
        refreshSession: syncSessionAndCapabilities,
        refreshCapabilities,
        loginWithEmail,
        establishPhoneSession,
        registerWithEmail,
        resendVerificationEmail,
        verifyEmailToken,
        requestPasswordReset,
        resetPassword,
        updateProfileName,
        updateProfile,
        deleteAccount,
        reauthenticateWithPassword,
        reauthenticateWithPhoneToken,
        syncLinkedPhone,
        changePassword,
        requestLinkEmail,
        logout,
        loginAdminWithEmail,
        activateAdminAccount,
        confirmAdminActivation,
        resendAdminVerification,
        requestAdminPasswordReset,
        confirmAdminPasswordReset,
        apiRequest: requestApi,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return ctx;
}
