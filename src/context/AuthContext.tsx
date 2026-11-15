import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  isOwner: boolean;
  recentReauthValid: boolean;
  recentReauthExpiresAt: number;
}

export interface AuthCapabilities {
  emailDeliveryConfigured: boolean;
  emailPasswordEnabled?: boolean;
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
  reauthenticateWithPassword: (
    password: string
  ) => Promise<ApiResult<{ message: string; user: AuthUser }>>;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities>(DEFAULT_CAPABILITIES);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const csrfTokenRef = useRef<string>('');
  const isLoggingOutRef = useRef<boolean>(false);

  const syncSessionAndCapabilities = useCallback(async () => {
    try {
      const [sessionRes, capRes] = await Promise.all([
        fetch(normalizeApiPath('/api/auth/session'), {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        }),
        fetch(normalizeApiPath('/api/auth/capabilities?refresh=1'), {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        }),
      ]);

      if (sessionRes.ok) {
        const { isJson, payload } = await readJsonBody(sessionRes);
        if (isJson) {
          const sessionData = payload as {
            authenticated?: boolean;
            csrfToken?: string;
            user?: AuthUser | null;
          };
          if (typeof sessionData.csrfToken === 'string' && sessionData.csrfToken) {
            csrfTokenRef.current = sessionData.csrfToken;
          }
          if (!isLoggingOutRef.current) {
            setUser(sessionData.authenticated ? (sessionData.user ?? null) : null);
          }
        }
      }

      if (capRes.ok) {
        const { isJson, payload } = await readJsonBody(capRes);
        if (isJson && typeof payload.passwordMinLength === 'number') {
          setCapabilities(payload as unknown as AuthCapabilities);
        }
      }
    } catch {
      // Leave current session state intact if network request fails momentarily
    } finally {
      setIsLoadingSession(false);
    }
  }, []);

  const refreshCapabilities = useCallback(async (): Promise<AuthCapabilities | null> => {
    try {
      const capRes = await fetch(normalizeApiPath('/api/auth/capabilities?refresh=1'), {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!capRes.ok) return null;
      const { isJson, payload } = await readJsonBody(capRes);
      if (!isJson || typeof payload.passwordMinLength !== 'number') return null;
      const capData = payload as unknown as AuthCapabilities;
      setCapabilities(capData);
      return capData;
    } catch {
      return null;
    }
  }, []);

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

  const ensureCsrfToken = useCallback(async (forceRefresh = false): Promise<string> => {
    if (!forceRefresh && csrfTokenRef.current) {
      return csrfTokenRef.current;
    }
    const res = await fetch(normalizeApiPath('/api/auth/session'), {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const { isJson, payload } = await readJsonBody(res);
      if (isJson) {
        const data = payload as {
          csrfToken?: string;
          authenticated?: boolean;
          user?: AuthUser | null;
        };
        if (typeof data.csrfToken === 'string' && data.csrfToken) {
          csrfTokenRef.current = data.csrfToken;
        }
        setUser(data.authenticated ? (data.user ?? null) : null);
      }
    }
    return csrfTokenRef.current;
  }, []);

  const requestApi = useCallback(
    async <T,>(
      path: string,
      options: RequestInit = {},
      hasRetriedCsrf = false
    ): Promise<ApiResult<T>> => {
      try {
        const normalizedPath = normalizeApiPath(path);
        const method = (options.method || 'GET').toUpperCase();
        const headers = new Headers(options.headers || {});
        if (!headers.has('Accept')) {
          headers.set('Accept', 'application/json');
        }
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

        const response = await fetch(normalizedPath, {
          ...options,
          headers,
          credentials: 'include',
          cache: 'no-store',
        });

        const { isJson, payload } = await readJsonBody(response);

        if (typeof payload.csrfToken === 'string' && payload.csrfToken) {
          csrfTokenRef.current = payload.csrfToken;
        }

        if (!response.ok) {
          const code = typeof payload.code === 'string' ? payload.code : undefined;
          if (
            response.status === 403 &&
            !hasRetriedCsrf &&
            method !== 'GET' &&
            method !== 'HEAD' &&
            (code === 'CSRF_INVALID' || code === 'CSRF_EXPIRED' || code === 'CSRF_MISSING')
          ) {
            csrfTokenRef.current = '';
            return requestApi<T>(normalizedPath, options, true);
          }

          if (response.status === 401) {
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
            status: response.status,
            code: code || (!isJson && response.status === 404 ? 'API_ROUTE_NOT_FOUND' : undefined),
            requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
            retryAfterSeconds:
              typeof payload.retryAfterSeconds === 'number' ? payload.retryAfterSeconds : undefined,
            ...(fieldErrors && Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
            error:
              serverError ||
              (!isJson && response.status === 404
                ? `The authentication service endpoint (${method} ${normalizedPath}) was not found on this host (HTTP 404). Ensure the backend server is running and /api/* requests are routed to it.`
                : !isJson
                  ? `The server returned an unexpected response (HTTP ${response.status}). Please refresh the page and try again.`
                  : `Request failed (HTTP ${response.status}). Please try again.`),
          };
        }

        if (!isJson) {
          return {
            ok: false,
            status: 502,
            code: 'NON_JSON_API_RESPONSE',
            error: `The server returned an HTML fallback instead of JSON for ${method} ${normalizedPath}. Ensure /api/* requests reach the backend server.`,
          };
        }

        return { ok: true, data: payload as T };
      } catch {
        return {
          ok: false,
          status: 0,
          error: 'Network error. Please check your connection and try again.',
        };
      }
    },
    [ensureCsrfToken]
  );

  const loginWithEmail = useCallback(
    async (email: string, password: string) => {
      const res = await requestApi<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) setUser(res.data.user);
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
      if (res.ok) setUser(null);
      return res;
    },
    [requestApi]
  );

  const updateProfileName = useCallback(
    async (fullName: string) => {
      const res = await requestApi<{ user: AuthUser }>('/api/account/profile', {
        method: 'PATCH',
        body: JSON.stringify({ fullName }),
      });
      if (res.ok) setUser(res.data.user);
      return res;
    },
    [requestApi]
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
      if (res.ok) setUser(res.data.user);
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
      if (res.ok) setUser(res.data.user);
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
      if (res.ok) setUser(res.data.user);
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
    isLoggingOutRef.current = true;
    try {
      const res = await requestApi<{ message: string; csrfToken?: string }>('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        return res;
      }

      try {
        const verifyRes = await fetch(normalizeApiPath('/api/auth/session'), {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!verifyRes.ok) {
          return {
            ok: false,
            status: verifyRes.status,
            code: 'LOGOUT_VERIFY_FAILED',
            error: 'Unable to confirm that your session ended. Please try signing out again.',
          };
        }
        const { isJson, payload } = await readJsonBody(verifyRes);
        if (!isJson) {
          return {
            ok: false,
            status: 502,
            code: 'LOGOUT_VERIFY_FAILED',
            error: 'Unable to confirm that your session ended. Please try signing out again.',
          };
        }
        const verifyData = payload as {
          authenticated?: boolean;
          csrfToken?: string;
          user?: AuthUser | null;
        };
        if (typeof verifyData.csrfToken === 'string' && verifyData.csrfToken) {
          csrfTokenRef.current = verifyData.csrfToken;
        }
        if (verifyData.authenticated) {
          setUser(verifyData.user ?? null);
          return {
            ok: false,
            status: 500,
            code: 'LOGOUT_INCOMPLETE',
            error: 'Your session remained active on the server. Please try signing out again.',
          };
        }
      } catch {
        return {
          ok: false,
          status: 0,
          code: 'LOGOUT_VERIFY_FAILED',
          error: 'Network error while verifying sign-out. Please try again.',
        };
      }

      setUser(null);
      return res;
    } finally {
      isLoggingOutRef.current = false;
    }
  }, [requestApi]);

  return (
    <AuthContext.Provider
      value={{
        user,
        capabilities,
        isLoadingSession,
        refreshSession: syncSessionAndCapabilities,
        refreshCapabilities,
        loginWithEmail,
        registerWithEmail,
        resendVerificationEmail,
        verifyEmailToken,
        requestPasswordReset,
        resetPassword,
        updateProfileName,
        reauthenticateWithPassword,
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
