import { useEffect, useState } from 'react';
import { ArrowLeft, Info, Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { sanitizeInternalRedirectPath } from '../../config/auth';
import { BOUTIQUE_MEDIA } from '../../config/media';
import { SITE_CONFIG } from '../../config/site';
import { getStoredOAuthReturnPath, useAuth } from '../../context/AuthContext';
import { AppRoute } from '../../hooks/useBoutiqueRouter';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { getSupabaseClient } from '../../lib/supabase';
import { BoutiqueImage } from '../BoutiqueImage';
import { HeroRibbonFallback } from '../HeroRibbonFallback';
import { EmailAuthForms, EmailViewMode } from './EmailAuthForms';
import { MobileOtpForm } from './MobileOtpForm';
import { SocialAuthButtons } from './SocialAuthButtons';

type AuthChannel = 'email' | 'mobile';

interface AuthPageProps {
  route: Exclude<AppRoute, '/'>;
  returnTo: string;
  onNavigateRoute: (route: AppRoute) => void;
  onReturnToStore: (path?: string) => void;
}

export function AuthPage({
  route,
  returnTo,
  onNavigateRoute,
  onReturnToStore,
}: AuthPageProps) {
  const {
    user,
    isConfigured,
    isGoogleConfigured,
    isAppleConfigured,
    isRecoverySession,
    signInWithOAuth,
  } = useAuth();
  const prefersReducedMotion = usePrefersReducedMotion();

  const [channel, setChannel] = useState<AuthChannel>('email');
  const [oauthSubmitting, setOauthSubmitting] = useState<'google' | 'apple' | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [callbackStatus, setCallbackStatus] = useState<'processing' | 'error' | null>(
    route === '/auth/callback' ? 'processing' : null
  );

  // Determine which EmailAuthForms view matches the active route
  const emailMode: EmailViewMode =
    route === '/signup'
      ? 'signup'
      : route === '/forgot-password'
        ? 'forgot'
        : route === '/reset-password' || isRecoverySession
          ? 'reset'
          : 'login';

  const showMethodTabs = emailMode === 'login' && route !== '/auth/callback';

  // Handle OAuth / Email confirmation callback route
  useEffect(() => {
    if (route !== '/auth/callback') return;

    const params = new URLSearchParams(window.location.search);
    const errDesc = params.get('error_description') || params.get('error');
    const code = params.get('code');
    const safeNext = sanitizeInternalRedirectPath(params.get('next') || getStoredOAuthReturnPath());

    if (errDesc) {
      setCallbackStatus('error');
      setOauthError('Sign-in was cancelled or could not be completed. Please try again.');
      return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      setCallbackStatus('error');
      setOauthError('Authentication provider is not configured.');
      return;
    }

    let cancelled = false;
    const finishCallback = async () => {
      try {
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            if (!cancelled) {
              setCallbackStatus('error');
              setOauthError('Verification link is invalid or expired. Please try signing in again.');
            }
            return;
          }
        }
        const { data } = await supabase.auth.getSession();
        if (!cancelled) {
          if (data.session) {
            onReturnToStore(safeNext);
          } else {
            setCallbackStatus('error');
            setOauthError('No active session was returned. Please sign in to continue.');
          }
        }
      } catch {
        if (!cancelled) {
          setCallbackStatus('error');
          setOauthError('Could not complete authentication callback.');
        }
      }
    };

    void finishCallback();

    return () => {
      cancelled = true;
    };
  }, [route, onReturnToStore]);

  // Redirect already authenticated visitors (except during password recovery)
  useEffect(() => {
    if (user && route !== '/reset-password' && route !== '/auth/callback' && !isRecoverySession) {
      // Keep user briefly able to see success feedback if triggered from form, or redirect on direct revisit
    }
  }, [user, route, isRecoverySession]);

  const handleOAuthClick = async (provider: 'google' | 'apple') => {
    setOauthError(null);
    setOauthSubmitting(provider);
    try {
      const res = await signInWithOAuth(provider, returnTo);
      if (res.error) {
        setOauthError(res.error);
      }
    } finally {
      setOauthSubmitting(null);
    }
  };

  const handleChannelKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: AuthChannel) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setOauthError(null);
      setChannel(current === 'email' ? 'mobile' : 'email');
    }
  };

  const handleEmailModeChange = (nextMode: EmailViewMode) => {
    setOauthError(null);
    if (nextMode === 'signup') onNavigateRoute('/signup');
    else if (nextMode === 'forgot') onNavigateRoute('/forgot-password');
    else if (nextMode === 'reset') onNavigateRoute('/reset-password');
    else onNavigateRoute('/login');
  };

  return (
    <div className="min-h-[100svh] bg-[#FFF9F5] text-[#242124] lg:grid lg:grid-cols-12">
      {/* Left Desktop Editorial Showcase */}
      <aside className="relative hidden overflow-hidden bg-[#49243E] lg:col-span-6 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <motion.div
          initial={prefersReducedMotion ? false : { scale: 1.06, opacity: 0.85 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-0"
        >
          <BoutiqueImage
            src={BOUTIQUE_MEDIA.spotlightEdit}
            alt="Sahithi Collections editorial portrait in sculpted muted rose silk gown"
            loading="eager"
            fetchPriority="high"
            className="h-full w-full object-cover object-top"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-[#49243E]/90 via-[#49243E]/35 to-[#242124]/45"
          />
        </motion.div>

        {/* Small floating decorative rose-gold ribbon separated from interactive UI */}
        <motion.div
          aria-hidden="true"
          animate={prefersReducedMotion ? undefined : { y: [0, -10, 0] }}
          transition={
            prefersReducedMotion
              ? undefined
              : { duration: 7.5, repeat: Infinity, ease: 'easeInOut' }
          }
          className="pointer-events-none absolute top-14 right-8 z-10 h-48 w-48 opacity-65"
        >
          <HeroRibbonFallback className="h-full w-full" />
        </motion.div>

        {/* Top Branding */}
        <div className="relative z-10">
          <button
            type="button"
            onClick={() => onReturnToStore('/')}
            className="font-serif text-2xl font-semibold tracking-tight text-[#FFF9F5] transition-opacity hover:opacity-85"
          >
            {SITE_CONFIG.brandName}
          </button>
          <p className="mt-1 text-xs tracking-[0.2em] uppercase text-[#F3D5DF]">
            {SITE_CONFIG.tagline}
          </p>
        </div>

        {/* Bottom Editorial Welcome */}
        <div className="relative z-10 max-w-md">
          <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#F3D5DF]">
            Boutique Member Access
          </p>
          <h2 className="mt-3 font-serif text-4xl font-semibold leading-tight tracking-[0.01em] text-[#FFF9F5] xl:text-5xl text-balance">
            Welcome Back to Your Style.
          </h2>
          <p className="mt-4 text-sm leading-relaxed tracking-[0.01em] text-[#FFF9F5]/85">
            Sign in with email, mobile OTP, Google, or Apple to continue exploring new arrivals, curated festive edits, and saved pieces.
          </p>
        </div>
      </aside>

      {/* Right Authentication Form Column */}
      <main className="flex min-h-[100svh] flex-col justify-between px-4 py-6 sm:px-8 lg:col-span-6 lg:px-12 lg:py-10">
        {/* Compact Header & Back to Collections */}
        <div className="mx-auto flex w-full max-w-[440px] items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => onReturnToStore('/')}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl px-2 py-2 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 whitespace-nowrap"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to Collections</span>
          </button>

          <span className="font-serif text-lg font-semibold text-[#49243E] lg:hidden">
            {SITE_CONFIG.brandName}
          </span>
        </div>

        {/* Form Container */}
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto my-auto w-full max-w-[432px] py-6"
        >
          <div className="rounded-3xl border border-[#49243E]/12 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(73,36,62,0.18)] sm:p-8">
            {/* Clearly Labeled Preview Notice when Auth Provider Env Vars are Missing */}
            {!isConfigured && (
              <div
                role="status"
                className="mb-5 flex items-start gap-2.5 rounded-2xl border border-[#B76E79]/35 bg-[#F3D5DF]/30 p-3.5 text-xs leading-relaxed text-[#49243E]"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
                <div>
                  <p className="font-semibold">Preview State — Auth Provider Not Configured</p>
                  <p className="mt-0.5 text-[#242124]/80">
                    You can inspect form transitions and password visibility below. Configure{' '}
                    <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px]">
                      VITE_SUPABASE_URL
                    </code>{' '}
                    and{' '}
                    <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px]">
                      VITE_SUPABASE_ANON_KEY
                    </code>{' '}
                    in <code className="font-mono text-[11px]">.env</code> to enable live sign-in, SMS OTP, and OAuth.
                  </p>
                </div>
              </div>
            )}

            {/* OAuth Callback Handler View */}
            {route === '/auth/callback' ? (
              <div className="py-6 text-center">
                {callbackStatus === 'processing' ? (
                  <>
                    <Loader2
                      className="mx-auto h-8 w-8 animate-spin text-[#49243E]"
                      aria-hidden="true"
                    />
                    <h1 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
                      Completing Sign-In
                    </h1>
                    <p className="mt-2 text-sm text-[#242124]/75">
                      Verifying your authentication session with Sahithi Collections...
                    </p>
                  </>
                ) : (
                  <>
                    <h1 className="font-serif text-2xl font-semibold text-[#49243E]">
                      Sign-In Could Not Complete
                    </h1>
                    <p className="mt-2 text-sm leading-relaxed text-[#8E2035]">
                      {oauthError || 'Unable to verify your session.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setOauthError(null);
                        onNavigateRoute('/login');
                      }}
                      className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#49243E] px-6 py-2.5 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
                    >
                      Return to Login
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                {/* Accessible Email / Mobile Number Segmented Control */}
                {showMethodTabs && (
                  <div
                    role="tablist"
                    aria-label="Choose sign-in method"
                    className="mb-6 grid grid-cols-2 gap-1 rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5] p-1"
                  >
                    {(
                      [
                        { id: 'email', label: 'Email' },
                        { id: 'mobile', label: 'Mobile Number' },
                      ] as const
                    ).map((tab) => {
                      const active = channel === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          tabIndex={active ? 0 : -1}
                          onClick={() => {
                            setOauthError(null);
                            setChannel(tab.id);
                          }}
                          onKeyDown={(e) => handleChannelKeyDown(e, tab.id)}
                          className={`relative min-h-[42px] rounded-xl px-3 py-2 text-xs font-semibold transition-colors duration-200 sm:text-sm whitespace-nowrap ${
                            active
                              ? 'text-[#FFF9F5]'
                              : 'text-[#49243E]/75 hover:text-[#49243E]'
                          }`}
                        >
                          {active && (
                            <motion.span
                              layoutId={prefersReducedMotion ? undefined : 'auth-method-pill'}
                              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                              aria-hidden="true"
                              className="absolute inset-0 rounded-xl bg-[#49243E] shadow-xs"
                            />
                          )}
                          <span className="relative z-10">{tab.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Active Form Panel */}
                <AnimatePresence mode="wait">
                  {channel === 'mobile' && showMethodTabs ? (
                    <motion.div
                      key="mobile-channel"
                      initial={prefersReducedMotion ? false : { opacity: 0, x: 8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={prefersReducedMotion ? undefined : { opacity: 0, x: -8 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <MobileOtpForm
                        onAuthenticated={() => onReturnToStore(returnTo)}
                        externalError={oauthError}
                      />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={`email-channel-${emailMode}`}
                      initial={prefersReducedMotion ? false : { opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={prefersReducedMotion ? undefined : { opacity: 0, x: 8 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <EmailAuthForms
                        mode={emailMode}
                        onChangeMode={handleEmailModeChange}
                        onAuthenticated={() => onReturnToStore(returnTo)}
                        externalError={oauthError}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Google & Apple Options + Sign Up Footer (available on Login & Sign Up) */}
                {(emailMode === 'login' || emailMode === 'signup') && (
                  <>
                    <SocialAuthButtons
                      isGoogleConfigured={isGoogleConfigured}
                      isAppleConfigured={isAppleConfigured}
                      isSubmittingProvider={oauthSubmitting}
                      disabled={!isConfigured}
                      onSelectProvider={handleOAuthClick}
                    />

                    <p className="mt-6 text-center text-sm text-[#242124]/75">
                      {emailMode === 'login' ? (
                        <>
                          Don’t have an account?{' '}
                          <button
                            type="button"
                            onClick={() => {
                              setChannel('email');
                              handleEmailModeChange('signup');
                            }}
                            className="font-semibold text-[#49243E] underline-offset-4 hover:text-[#B76E79] hover:underline"
                          >
                            Sign Up
                          </button>
                        </>
                      ) : (
                        <>
                          Already have an account?{' '}
                          <button
                            type="button"
                            onClick={() => {
                              setChannel('email');
                              handleEmailModeChange('login');
                            }}
                            className="font-semibold text-[#49243E] underline-offset-4 hover:text-[#B76E79] hover:underline"
                          >
                            Login
                          </button>
                        </>
                      )}
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </motion.div>

        <div className="mx-auto w-full max-w-[440px] text-center text-xs text-[#242124]/55">
          &copy; {new Date().getFullYear()} {SITE_CONFIG.brandName}
        </div>
      </main>
    </div>
  );
}
