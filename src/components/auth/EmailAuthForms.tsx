import { useId, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { AUTH_CONFIG } from '../../config/auth';
import { useAuth } from '../../context/AuthContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

export type EmailViewMode = 'login' | 'signup' | 'forgot' | 'reset';

interface EmailAuthFormsProps {
  mode: EmailViewMode;
  onChangeMode: (nextMode: EmailViewMode) => void;
  onAuthenticated: () => void;
  externalError?: string | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailAuthForms({
  mode,
  onChangeMode,
  onAuthenticated,
  externalError = null,
}: EmailAuthFormsProps) {
  const { isConfigured, signInWithEmail, signUpWithEmail, sendPasswordReset, updatePassword } =
    useAuth();
  const prefersReducedMotion = usePrefersReducedMotion();

  const fullNameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const activeError = errorMessage || externalError;

  const scrollFieldIntoView = (event: React.FocusEvent<HTMLInputElement>) => {
    event.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const resetMessages = () => {
    setErrorMessage(null);
    setStatusMessage(null);
  };

  const switchMode = (nextMode: EmailViewMode) => {
    resetMessages();
    setPassword('');
    setConfirmPassword('');
    onChangeMode(nextMode);
  };

  const handleLoginSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || !isConfigured) return;
    resetMessages();

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !EMAIL_REGEX.test(trimmedEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (!password) {
      setErrorMessage('Please enter your password.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await signInWithEmail(trimmedEmail, password);
      if (result.error) {
        setErrorMessage(result.error);
      } else {
        setStatusMessage('Signed in successfully. Returning to Sahithi Collections...');
        window.setTimeout(onAuthenticated, prefersReducedMotion ? 100 : 450);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignUpSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || !isConfigured) return;
    resetMessages();

    const trimmedName = fullName.trim();
    const trimmedEmail = email.trim();

    if (trimmedName.length < 2) {
      setErrorMessage('Please enter your full name.');
      return;
    }
    if (!trimmedEmail || !EMAIL_REGEX.test(trimmedEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (password.length < AUTH_CONFIG.passwordMinLength) {
      setErrorMessage(
        `Password must be at least ${AUTH_CONFIG.passwordMinLength} characters long.`
      );
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match. Please re-enter carefully.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await signUpWithEmail(trimmedName, trimmedEmail, password);
      if (result.error) {
        setErrorMessage(result.error);
      } else if (result.needsEmailVerification) {
        setStatusMessage(
          result.neutralMessage ||
            'Verification email sent. Please confirm your email address before signing in.'
        );
      } else {
        setStatusMessage('Account created. Welcome to Sahithi Collections.');
        window.setTimeout(onAuthenticated, prefersReducedMotion ? 100 : 500);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForgotSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || !isConfigured) return;
    resetMessages();

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !EMAIL_REGEX.test(trimmedEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await sendPasswordReset(trimmedEmail);
      if (result.error) {
        setErrorMessage(result.error);
      } else {
        setStatusMessage(
          result.neutralMessage ||
            'If an account exists for that email address, a password reset link has been sent.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || !isConfigured) return;
    resetMessages();

    if (password.length < AUTH_CONFIG.passwordMinLength) {
      setErrorMessage(
        `New password must be at least ${AUTH_CONFIG.passwordMinLength} characters long.`
      );
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await updatePassword(password);
      if (result.error) {
        setErrorMessage(result.error);
      } else {
        setStatusMessage('Your password has been updated. Continuing to Sahithi Collections...');
        window.setTimeout(onAuthenticated, prefersReducedMotion ? 100 : 600);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const staggerItem = (index: number) =>
    prefersReducedMotion
      ? {}
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.34, delay: index * 0.055, ease: [0.16, 1, 0.3, 1] as const },
        };

  if (mode === 'forgot') {
    return (
      <form onSubmit={handleForgotSubmit} noValidate className="space-y-4">
        <motion.div {...staggerItem(0)}>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
            Forgot Password
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#242124]/75">
            Enter your email address and we will send a link to create a new password.
          </p>
        </motion.div>

        <motion.div {...staggerItem(1)}>
          <label
            htmlFor={emailId}
            className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
          >
            Email
          </label>
          <input
            id={emailId}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onFocus={scrollFieldIntoView}
            placeholder="you@example.com"
            className="mt-1.5 h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 px-4 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
          />
        </motion.div>

        {activeError && (
          <motion.div
            role="alert"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-xl border border-[#B8334A]/30 bg-[#FFF2F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8E2035]"
          >
            {activeError}
          </motion.div>
        )}

        {statusMessage && (
          <motion.div
            role="status"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-start gap-2 rounded-xl border border-[#49243E]/15 bg-[#F3D5DF]/35 px-3.5 py-3 text-xs leading-relaxed text-[#49243E]"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
            <span>{statusMessage}</span>
          </motion.div>
        )}

        <motion.div {...staggerItem(2)}>
          <button
            type="submit"
            disabled={!isConfigured || isSubmitting}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#3A1B31] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            <span>Send Reset Link</span>
          </button>
        </motion.div>

        <div className="pt-1 text-center">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className="min-h-[44px] px-3 text-sm font-medium text-[#49243E] underline-offset-4 hover:text-[#B76E79] hover:underline"
          >
            Back to Login
          </button>
        </div>
      </form>
    );
  }

  if (mode === 'reset') {
    return (
      <form onSubmit={handleResetSubmit} noValidate className="space-y-4">
        <motion.div {...staggerItem(0)}>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
            Create New Password
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#242124]/75">
            Choose a strong password of at least {AUTH_CONFIG.passwordMinLength} characters for your boutique account.
          </p>
        </motion.div>

        <motion.div {...staggerItem(1)}>
          <label
            htmlFor={passwordId}
            className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
          >
            New Password
          </label>
          <div className="relative mt-1.5">
            <input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={scrollFieldIntoView}
              placeholder="Enter new password"
              className="h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 pl-4 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="absolute top-1/2 right-1 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
            >
              {showPassword ? (
                <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : (
                <Eye className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>
          </div>
        </motion.div>

        <motion.div {...staggerItem(2)}>
          <label
            htmlFor={confirmPasswordId}
            className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
          >
            Confirm Password
          </label>
          <div className="relative mt-1.5">
            <input
              id={confirmPasswordId}
              type={showConfirmPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onFocus={scrollFieldIntoView}
              placeholder="Re-enter password"
              className="h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 pl-4 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((prev) => !prev)}
              aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
              aria-pressed={showConfirmPassword}
              className="absolute top-1/2 right-1 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
            >
              {showConfirmPassword ? (
                <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : (
                <Eye className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>
          </div>
        </motion.div>

        {activeError && (
          <motion.div
            role="alert"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-xl border border-[#B8334A]/30 bg-[#FFF2F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8E2035]"
          >
            {activeError}
          </motion.div>
        )}

        {statusMessage && (
          <motion.div
            role="status"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-start gap-2 rounded-xl border border-[#49243E]/15 bg-[#F3D5DF]/35 px-3.5 py-3 text-xs leading-relaxed text-[#49243E]"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
            <span>{statusMessage}</span>
          </motion.div>
        )}

        <button
          type="submit"
          disabled={!isConfigured || isSubmitting}
          className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#3A1B31] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          <span>Update Password</span>
        </button>

        <div className="pt-1 text-center">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className="min-h-[44px] px-3 text-sm font-medium text-[#49243E] underline-offset-4 hover:text-[#B76E79] hover:underline"
          >
            Back to Login
          </button>
        </div>
      </form>
    );
  }

  if (mode === 'signup') {
    return (
      <form onSubmit={handleSignUpSubmit} noValidate className="space-y-4">
        <motion.div {...staggerItem(0)}>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
            Sign Up
          </h1>
          <p className="mt-1.5 text-sm text-[#242124]/70">
            Create your personal Sahithi Collections account.
          </p>
        </motion.div>

        <motion.div {...staggerItem(1)}>
          <label
            htmlFor={fullNameId}
            className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
          >
            Full Name
          </label>
          <input
            id={fullNameId}
            type="text"
            autoComplete="name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            onFocus={scrollFieldIntoView}
            placeholder="Ananya Sharma"
            className="mt-1.5 h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 px-4 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
          />
        </motion.div>

        <motion.div {...staggerItem(2)}>
          <label
            htmlFor={emailId}
            className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
          >
            Email
          </label>
          <input
            id={emailId}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onFocus={scrollFieldIntoView}
            placeholder="you@example.com"
            className="mt-1.5 h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 px-4 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
          />
        </motion.div>

        <motion.div {...staggerItem(3)}>
          <label
            htmlFor={passwordId}
            className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
          >
            Password
          </label>
          <div className="relative mt-1.5">
            <input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={scrollFieldIntoView}
              placeholder={`Minimum ${AUTH_CONFIG.passwordMinLength} characters`}
              className="h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 pl-4 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="absolute top-1/2 right-1 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
            >
              {showPassword ? (
                <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : (
                <Eye className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>
          </div>
        </motion.div>

        <motion.div {...staggerItem(4)}>
          <label
            htmlFor={confirmPasswordId}
            className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
          >
            Confirm Password
          </label>
          <div className="relative mt-1.5">
            <input
              id={confirmPasswordId}
              type={showConfirmPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onFocus={scrollFieldIntoView}
              placeholder="Re-enter your password"
              className="h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 pl-4 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((prev) => !prev)}
              aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
              aria-pressed={showConfirmPassword}
              className="absolute top-1/2 right-1 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
            >
              {showConfirmPassword ? (
                <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : (
                <Eye className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>
          </div>
        </motion.div>

        {activeError && (
          <motion.div
            role="alert"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-xl border border-[#B8334A]/30 bg-[#FFF2F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8E2035]"
          >
            {activeError}
          </motion.div>
        )}

        {statusMessage && (
          <motion.div
            role="status"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-start gap-2 rounded-xl border border-[#49243E]/15 bg-[#F3D5DF]/35 px-3.5 py-3 text-xs leading-relaxed text-[#49243E]"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
            <span>{statusMessage}</span>
          </motion.div>
        )}

        <motion.div {...staggerItem(5)}>
          <button
            type="submit"
            disabled={!isConfigured || isSubmitting}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#3A1B31] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            <span>Create Account</span>
          </button>
        </motion.div>

        <div className="pt-1 text-center">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className="min-h-[44px] px-3 text-sm font-medium text-[#49243E] underline-offset-4 hover:text-[#B76E79] hover:underline"
          >
            Back to Login
          </button>
        </div>
      </form>
    );
  }

  // Default: Email Login View matching the clean screenshot hierarchy
  return (
    <form onSubmit={handleLoginSubmit} noValidate className="space-y-4">
      <motion.div {...staggerItem(0)}>
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
          Login
        </h1>
      </motion.div>

      <motion.div {...staggerItem(1)}>
        <label
          htmlFor={emailId}
          className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
        >
          Email
        </label>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onFocus={scrollFieldIntoView}
          placeholder="you@example.com"
          className="mt-1.5 h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 px-4 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
        />
      </motion.div>

      <motion.div {...staggerItem(2)}>
        <label
          htmlFor={passwordId}
          className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
        >
          Password
        </label>
        <div className="relative mt-1.5">
          <input
            id={passwordId}
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onFocus={scrollFieldIntoView}
            placeholder="Enter your password"
            className="h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 pl-4 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            className="absolute top-1/2 right-1 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
          >
            {showPassword ? (
              <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" />
            ) : (
              <Eye className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>
        </div>

        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={() => switchMode('forgot')}
            className="min-h-[36px] py-1 text-xs font-medium text-[#49243E]/80 underline-offset-4 transition-colors hover:text-[#B76E79] hover:underline"
          >
            Forgot Password?
          </button>
        </div>
      </motion.div>

      {activeError && (
        <motion.div
          role="alert"
          initial={prefersReducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          className="rounded-xl border border-[#B8334A]/30 bg-[#FFF2F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8E2035]"
        >
          {activeError}
        </motion.div>
      )}

      {statusMessage && (
        <motion.div
          role="status"
          initial={prefersReducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-start gap-2 rounded-xl border border-[#49243E]/15 bg-[#F3D5DF]/35 px-3.5 py-3 text-xs leading-relaxed text-[#49243E]"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
          <span>{statusMessage}</span>
        </motion.div>
      )}

      <motion.div {...staggerItem(3)}>
        <button
          type="submit"
          disabled={!isConfigured || isSubmitting}
          className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] shadow-[0_10px_24px_-12px_rgba(73,36,62,0.5)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#3A1B31] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          <span>Login</span>
        </button>
      </motion.div>
    </form>
  );
}
