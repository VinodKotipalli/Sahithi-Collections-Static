import { ArrowLeft } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { BOUTIQUE_MEDIA } from '../../config/media';
import { SITE_CONFIG } from '../../config/site';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { BoutiqueImage } from '../BoutiqueImage';
import { HeroRibbonFallback } from '../HeroRibbonFallback';
import type { AuthUser } from '../../context/AuthContext';
import { EmailAuthForms, type EmailFlowMode } from './EmailAuthForms';

interface AuthPageProps {
  initialRoute: '/login' | '/signup' | '/forgot-password' | '/reset-password' | '/verify-email';
  queryToken: string;
  queryMode?: string;
  onNavigate: (target: string, options?: { replace?: boolean }) => void;
  onAuthenticated: (user?: AuthUser) => void;
}

export function AuthPage({
  initialRoute,
  queryToken,
  queryMode = '',
  onNavigate,
  onAuthenticated,
}: AuthPageProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  const emailMode: EmailFlowMode =
    initialRoute === '/signup'
      ? 'signup'
      : initialRoute === '/forgot-password'
        ? 'forgot'
        : initialRoute === '/reset-password'
          ? 'reset'
          : initialRoute === '/verify-email'
            ? 'verify-email'
            : 'login';

  const headingText =
    emailMode === 'reset'
      ? 'Set New Password'
      : emailMode === 'verify-email'
        ? 'Email Verification'
        : emailMode === 'signup'
          ? 'Create Account'
          : emailMode === 'forgot'
            ? 'Reset Password'
            : 'Login';

  const subtitleText =
    emailMode === 'reset'
      ? 'Choose a strong password for your Sahithi Collections account.'
      : emailMode === 'verify-email'
        ? 'Confirming your email ownership.'
        : emailMode === 'signup'
          ? 'Create your boutique profile and verify your email address.'
          : emailMode === 'forgot'
            ? 'Enter your email address to receive a single-use reset link.'
            : 'Sign in with your verified email address and password.';

  const handleChangeEmailMode = (nextMode: 'login' | 'signup' | 'forgot') => {
    const targetPath =
      nextMode === 'signup'
        ? '/signup'
        : nextMode === 'forgot'
          ? '/forgot-password'
          : '/login';
    onNavigate(targetPath);
  };

  const initialNotice =
    emailMode === 'login' && !queryToken
      ? queryMode === 'verifyEmail'
        ? 'If you just confirmed your email address using the verification link, sign in below with your email and password.'
        : queryMode === 'resetPassword'
          ? 'If you just completed updating your password, sign in below with your new password.'
          : null
      : null;

  return (
    <div className="min-h-screen bg-[#FFF9F5] lg:grid lg:grid-cols-12">
      {/* Left Desktop Editorial Showcase Panel */}
      <aside className="relative hidden overflow-hidden bg-[#49243E] lg:col-span-6 lg:flex lg:flex-col lg:justify-between xl:col-span-7">
        <div className="absolute inset-0">
          <BoutiqueImage
            src={BOUTIQUE_MEDIA.spotlightEdit}
            alt="Editorial boutique styling portrait from Sahithi Collections"
            className="h-full w-full object-cover object-top opacity-85"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-[#49243E]/90 via-[#49243E]/35 to-[#242124]/25"
          />
        </div>

        {/* Subtle decorative silk ribbon accent, kept strictly separate from controls */}
        <motion.div
          aria-hidden="true"
          animate={
            prefersReducedMotion
              ? undefined
              : { y: [0, -10, 0], rotate: [0, 1.5, 0] }
          }
          transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
          className="pointer-events-none absolute -right-14 top-16 h-72 w-72 opacity-55"
        >
          <HeroRibbonFallback />
        </motion.div>

        <div className="relative z-10 p-10">
          <button
            type="button"
            onClick={() => onNavigate('/')}
            className="font-serif text-2xl font-semibold tracking-tight text-[#FFF9F5] transition-opacity hover:opacity-85"
          >
            {SITE_CONFIG.brandName}
          </button>
        </div>

        <div className="relative z-10 max-w-xl p-10 pb-12">
          <p className="text-xs font-medium tracking-[0.22em] uppercase text-[#F3D5DF]">
            {SITE_CONFIG.tagline}
          </p>
          <h2 className="mt-3 font-serif text-4xl font-semibold leading-tight text-[#FFF9F5] xl:text-5xl">
            Welcome Back to Your Style.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-[#FFF9F5]/85">
            Access your boutique profile, save your styling preferences, and manage your verified
            email credentials.
          </p>
        </div>
      </aside>

      {/* Right Authentication Form Panel */}
      <main className="flex min-h-screen flex-col justify-between px-4 py-6 sm:px-8 lg:col-span-6 lg:px-12 lg:py-10 xl:col-span-5">
        <div className="mx-auto flex w-full max-w-[432px] items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => onNavigate('/')}
            className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-[#49243E] transition-colors hover:text-[#B76E79]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to Collections</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('/')}
            className="font-serif text-lg font-semibold text-[#49243E] lg:hidden"
          >
            {SITE_CONFIG.brandName}
          </button>
        </div>

        <div className="mx-auto my-auto w-full max-w-[432px] py-8">
          <div className="rounded-3xl border border-[#49243E]/12 bg-white p-6 shadow-[0_24px_60px_-28px_rgba(73,36,62,0.22)] sm:p-8">
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
              {SITE_CONFIG.brandName}
            </p>
            <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
              {headingText}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-[#242124]/75">{subtitleText}</p>

            <div className="mt-6">
              <AnimatePresence mode="wait">
                <motion.div
                  key={`email-${emailMode}`}
                  initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
                  transition={{ duration: prefersReducedMotion ? 0.01 : 0.18 }}
                >
                  <EmailAuthForms
                    mode={emailMode}
                    token={queryToken}
                    initialNotice={initialNotice}
                    onChangeMode={handleChangeEmailMode}
                    onAuthenticated={onAuthenticated}
                    onBackToCollections={() => onNavigate('/')}
                  />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>

        <p className="mx-auto w-full max-w-[432px] text-center text-xs text-[#242124]/60">
          Sessions are protected with HttpOnly cookies and CSRF verification.
        </p>
      </main>
    </div>
  );
}
