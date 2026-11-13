import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import {
  AUTH_CONFIG,
  isAppleAuthConfigured,
  isGoogleAuthConfigured,
  isSmsOtpConfigured,
  isSupabaseConfigured,
  sanitizeInternalRedirectPath,
} from '../config/auth';
import { getSupabaseClient } from '../lib/supabase';

export interface AuthActionResult {
  error: string | null;
  needsEmailVerification?: boolean;
  needsNameCompletion?: boolean;
  neutralMessage?: string;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  isLoadingSession: boolean;
  isConfigured: boolean;
  isSmsConfigured: boolean;
  isGoogleConfigured: boolean;
  isAppleConfigured: boolean;
  isRecoverySession: boolean;
  clearRecoverySession: () => void;
  signInWithEmail: (email: string, password: string) => Promise<AuthActionResult>;
  signUpWithEmail: (
    fullName: string,
    email: string,
    password: string
  ) => Promise<AuthActionResult>;
  sendPasswordReset: (email: string) => Promise<AuthActionResult>;
  updatePassword: (newPassword: string) => Promise<AuthActionResult>;
  sendPhoneOtp: (e164Phone: string, captchaToken?: string) => Promise<AuthActionResult>;
  verifyPhoneOtp: (e164Phone: string, token: string) => Promise<AuthActionResult>;
  updateProfileName: (fullName: string) => Promise<AuthActionResult>;
  signInWithOAuth: (provider: 'google' | 'apple', returnTo?: string) => Promise<AuthActionResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const OAUTH_RETURN_KEY = 'sahithi_auth_return_to';

export function getStoredOAuthReturnPath(): string {
  if (typeof window === 'undefined') return '/';
  try {
    const val = window.sessionStorage.getItem(OAUTH_RETURN_KEY);
    window.sessionStorage.removeItem(OAUTH_RETURN_KEY);
    return sanitizeInternalRedirectPath(val);
  } catch {
    return '/';
  }
}

function mapEmailSignInError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many sign-in attempts. Please wait a moment and try again.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Please verify your email address using the link sent to your inbox before signing in.';
  }
  return 'Invalid email or password. Please check your details and try again.';
}

function mapOtpError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('expired')) {
    return 'This verification code has expired. Please request a new code.';
  }
  if (lower.includes('rate limit') || lower.includes('too many') || lower.includes('wait')) {
    return 'Too many verification attempts. Please wait before requesting or entering another code.';
  }
  if (lower.includes('invalid') || lower.includes('token')) {
    return 'The verification code is incorrect. Please check the digits and try again.';
  }
  if (lower.includes('sms') || lower.includes('provider') || lower.includes('delivery')) {
    return 'Unable to deliver the SMS right now. Please check your number or try again shortly.';
  }
  return 'Could not complete mobile verification. Please try again.';
}

export function AuthProvider({
  children,
  onRecoveryDetected,
}: {
  children: ReactNode;
  onRecoveryDetected?: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState<boolean>(() => isSupabaseConfigured());
  const [isRecoverySession, setIsRecoverySession] = useState(false);

  const isConfigured = isSupabaseConfigured();
  const isSmsConfigured = isSmsOtpConfigured();
  const isGoogleConfigured = isGoogleAuthConfigured();
  const isAppleConfigured = isAppleAuthConfigured();

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setIsLoadingSession(false);
      return;
    }

    let mounted = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session ?? null);
        setIsLoadingSession(false);
      })
      .catch(() => {
        if (!mounted) return;
        setIsLoadingSession(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecoverySession(true);
        onRecoveryDetected?.();
      } else if (event === 'SIGNED_OUT') {
        setIsRecoverySession(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [onRecoveryDetected]);

  const clearRecoverySession = useCallback(() => {
    setIsRecoverySession(false);
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      const supabase = getSupabaseClient();
      if (!supabase) {
        return { error: 'Authentication provider is not configured yet.' };
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        return { error: mapEmailSignInError(error.message) };
      }
      return { error: null };
    },
    []
  );

  const signUpWithEmail = useCallback(
    async (fullName: string, email: string, password: string): Promise<AuthActionResult> => {
      const supabase = getSupabaseClient();
      if (!supabase) {
        return { error: 'Authentication provider is not configured yet.' };
      }

      const redirectUrl =
        typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined;

      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: redirectUrl,
          data: {
            full_name: fullName.trim(),
          },
        },
      });

      if (error) {
        const lower = error.message.toLowerCase();
        if (lower.includes('rate limit') || lower.includes('too many')) {
          return { error: 'Too many sign-up requests. Please wait a moment and try again.' };
        }
        if (lower.includes('password')) {
          return {
            error: `Password must be at least ${AUTH_CONFIG.passwordMinLength} characters and meet security requirements.`,
          };
        }
        return { error: 'Unable to complete registration. Please check your details and try again.' };
      }

      const needsEmailVerification = Boolean(data.user && !data.session);
      return {
        error: null,
        needsEmailVerification,
        neutralMessage: needsEmailVerification
          ? 'Please check your inbox for a verification link to activate your account.'
          : undefined,
      };
    },
    []
  );

  const sendPasswordReset = useCallback(async (email: string): Promise<AuthActionResult> => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return { error: 'Authentication provider is not configured yet.' };
    }

    const redirectTo =
      typeof window !== 'undefined' ? `${window.location.origin}/reset-password` : undefined;

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });

    if (error && error.message.toLowerCase().includes('rate limit')) {
      return { error: 'Too many reset requests. Please wait a minute before trying again.' };
    }

    return {
      error: null,
      neutralMessage:
        'If an account exists for that email address, a password reset link has been sent.',
    };
  }, []);

  const updatePassword = useCallback(async (newPassword: string): Promise<AuthActionResult> => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return { error: 'Authentication provider is not configured yet.' };
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      return { error: 'Could not update password. Your reset link may have expired.' };
    }
    setIsRecoverySession(false);
    return { error: null };
  }, []);

  const sendPhoneOtp = useCallback(
    async (e164Phone: string, captchaToken?: string): Promise<AuthActionResult> => {
      const supabase = getSupabaseClient();
      if (!supabase || !isSmsOtpConfigured()) {
        return { error: 'SMS OTP authentication is not configured yet.' };
      }

      const { error } = await supabase.auth.signInWithOtp({
        phone: e164Phone,
        options: {
          shouldCreateUser: AUTH_CONFIG.allowPhoneSignup,
          captchaToken: captchaToken || undefined,
        },
      });

      if (error) {
        return { error: mapOtpError(error.message) };
      }
      return { error: null };
    },
    []
  );

  const verifyPhoneOtp = useCallback(
    async (e164Phone: string, token: string): Promise<AuthActionResult> => {
      const supabase = getSupabaseClient();
      if (!supabase || !isSmsOtpConfigured()) {
        return { error: 'SMS OTP authentication is not configured yet.' };
      }

      const { data, error } = await supabase.auth.verifyOtp({
        phone: e164Phone,
        token: token.trim(),
        type: 'sms',
      });

      if (error || !data.session) {
        return { error: error ? mapOtpError(error.message) : 'Verification did not complete.' };
      }

      const existingName = data.user?.user_metadata?.full_name;
      const needsNameCompletion =
        typeof existingName !== 'string' || existingName.trim().length === 0;

      return { error: null, needsNameCompletion };
    },
    []
  );

  const updateProfileName = useCallback(async (fullName: string): Promise<AuthActionResult> => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return { error: 'Authentication provider is not configured yet.' };
    }
    const { error } = await supabase.auth.updateUser({
      data: { full_name: fullName.trim() },
    });
    if (error) {
      return { error: 'Could not save your name right now. You can continue shopping safely.' };
    }
    return { error: null };
  }, []);

  const signInWithOAuth = useCallback(
    async (provider: 'google' | 'apple', returnTo = '/'): Promise<AuthActionResult> => {
      const supabase = getSupabaseClient();
      if (!supabase) {
        return { error: 'Authentication provider is not configured yet.' };
      }
      if (provider === 'google' && !isGoogleAuthConfigured()) {
        return { error: 'Google sign-in is not enabled in this environment.' };
      }
      if (provider === 'apple' && !isAppleAuthConfigured()) {
        return { error: 'Apple sign-in is not enabled in this environment.' };
      }

      const safeReturn = sanitizeInternalRedirectPath(returnTo);
      try {
        window.sessionStorage.setItem(OAUTH_RETURN_KEY, safeReturn);
      } catch {
        // Ignore storage restrictions
      }

      const redirectTo =
        typeof window !== 'undefined'
          ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeReturn)}`
          : undefined;

      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
        },
      });

      if (error) {
        return { error: `Unable to start ${provider === 'google' ? 'Google' : 'Apple'} sign-in.` };
      }
      return { error: null };
    },
    []
  );

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        session,
        isLoadingSession,
        isConfigured,
        isSmsConfigured,
        isGoogleConfigured,
        isAppleConfigured,
        isRecoverySession,
        clearRecoverySession,
        signInWithEmail,
        signUpWithEmail,
        sendPasswordReset,
        updatePassword,
        sendPhoneOtp,
        verifyPhoneOtp,
        updateProfileName,
        signInWithOAuth,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
