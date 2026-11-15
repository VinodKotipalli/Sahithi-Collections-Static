import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, MailCheck, RefreshCw } from 'lucide-react';
import { useAuth, type AuthUser } from '../../context/AuthContext';

export type EmailFlowMode = 'login' | 'signup' | 'forgot' | 'reset' | 'verify-email';

interface EmailAuthFormsProps {
  mode: EmailFlowMode;
  token?: string;
  initialNotice?: string | null;
  onChangeMode: (next: 'login' | 'signup' | 'forgot') => void;
  onAuthenticated: (user?: AuthUser) => void;
  onBackToCollections: () => void;
}

export function EmailAuthForms({
  mode,
  token = '',
  initialNotice = null,
  onChangeMode,
  onAuthenticated,
  onBackToCollections,
}: EmailAuthFormsProps) {
  const {
    user,
    capabilities,
    refreshCapabilities,
    loginWithEmail,
    registerWithEmail,
    resendVerificationEmail,
    verifyEmailToken,
    requestPasswordReset,
    resetPassword,
  } = useAuth();

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

  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [pendingResendEmail, setPendingResendEmail] = useState<string | null>(null);
  const [resendCooldownSec, setResendCooldownSec] = useState(0);
  const [needsResendPassword, setNeedsResendPassword] = useState(false);
  const [resendPassword, setResendPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(initialNotice || null);
  const [verifyPurpose, setVerifyPurpose] = useState<'verify_email' | 'link_email' | null>(null);
  const [checkingProvider, setCheckingProvider] = useState(false);
  const [providerCheckNote, setProviderCheckNote] = useState<string | null>(null);
  const verifiedTokenRef = useRef<string>('');
  const inFlightRef = useRef(false);

  // Reset form messages when switching modes cleanly
  useEffect(() => {
    inFlightRef.current = false;
    setErrorMessage(null);
    setSuccessMessage(mode === 'login' ? initialNotice || null : null);
    setPendingResendEmail(null);
    setNeedsResendPassword(false);
    setResendPassword('');
    setResendCooldownSec(0);
    setSubmitting(false);
    setResending(false);
    setPassword('');
    setConfirmPassword('');
  }, [mode, initialNotice]);

  // Countdown timer for resend verification cooldown
  useEffect(() => {
    if (resendCooldownSec <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldownSec]);

  // Trigger single-use email token verification when arriving at /verify-email?token=...
  useEffect(() => {
    if (mode !== 'verify-email') return;
    if (!token) {
      setErrorMessage('Verification link token is missing or incomplete.');
      return;
    }
    if (verifiedTokenRef.current === token) return;
    verifiedTokenRef.current = token;

    let cancelled = false;
    setSubmitting(true);
    setErrorMessage(null);

    void verifyEmailToken(token).then((res) => {
      if (cancelled) return;
      setSubmitting(false);
      if (res.ok) {
        setVerifyPurpose(res.data.purpose);
        setSuccessMessage(res.data.message);
      } else {
        setErrorMessage(res.error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [mode, token, verifyEmailToken]);

  const handleLoginSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current) return;

    setErrorMessage(null);
    setSuccessMessage(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (!password) {
      setErrorMessage('Please enter your password.');
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const res = await loginWithEmail(cleanEmail, password);
      if (!res.ok) {
        setErrorMessage(res.error);
        if (res.code === 'EMAIL_NOT_VERIFIED') {
          setPendingResendEmail(cleanEmail);
          setNeedsResendPassword(false);
        } else {
          setPendingResendEmail(null);
        }
        return;
      }
      onAuthenticated(res.data.user);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleSignupSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current) return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setPendingResendEmail(null);
    setNeedsResendPassword(false);
    setResendPassword('');

    const cleanName = fullName.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (cleanName.length < 2) {
      setErrorMessage('Please enter your full name (at least 2 characters).');
      return;
    }
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    if (password.length < capabilities.passwordMinLength) {
      setErrorMessage(
        `Password must be at least ${capabilities.passwordMinLength} characters long.`
      );
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Password and confirmation password do not match.');
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const res = await registerWithEmail(cleanName, cleanEmail, password, confirmPassword);
      if (!res.ok) {
        setErrorMessage(res.error);
        if (res.code === 'EMAIL_DELIVERY_FAILED' || res.code === 'RESEND_COOLDOWN') {
          setPendingResendEmail(cleanEmail);
        }
        if (res.retryAfterSeconds) {
          setResendCooldownSec(res.retryAfterSeconds);
        }
        return;
      }

      setPassword('');
      setConfirmPassword('');
      setPendingResendEmail(cleanEmail);
      if (res.data.cooldownSeconds) {
        setResendCooldownSec(res.data.cooldownSeconds);
      }
      setSuccessMessage(res.data.message);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleResendVerification = async () => {
    const targetEmail = (pendingResendEmail || email).trim().toLowerCase();
    if (!targetEmail || resending || resendCooldownSec > 0) return;

    setResending(true);
    setErrorMessage(null);
    try {
      const effectivePassword = (resendPassword || password || '').trim() ? resendPassword || password : undefined;
      const res = await resendVerificationEmail(targetEmail, effectivePassword);
      if (!res.ok) {
        setErrorMessage(res.error);
        if (res.code === 'RESEND_COOLDOWN' && res.retryAfterSeconds) {
          setResendCooldownSec(res.retryAfterSeconds);
        }
        if (res.code === 'PASSWORD_REQUIRED_FOR_RESEND') {
          setNeedsResendPassword(true);
        }
        return;
      }
      setNeedsResendPassword(false);
      setResendPassword('');
      setSuccessMessage(res.data.message);
      if (res.data.alreadyVerified) {
        setPendingResendEmail(null);
      } else if (res.data.cooldownSeconds) {
        setResendCooldownSec(res.data.cooldownSeconds);
      }
    } finally {
      setResending(false);
    }
  };

  const handleForgotSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current) return;

    setErrorMessage(null);
    setSuccessMessage(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMessage('Please enter your registered email address.');
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const res = await requestPasswordReset(cleanEmail);
      if (!res.ok) {
        setErrorMessage(res.error);
        return;
      }
      setSuccessMessage(res.data.message);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleResetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current) return;

    setErrorMessage(null);
    setSuccessMessage(null);

    if (!token) {
      setErrorMessage('Password reset token is missing. Please request a new reset link.');
      return;
    }
    if (password.length < capabilities.passwordMinLength) {
      setErrorMessage(
        `New password must be at least ${capabilities.passwordMinLength} characters long.`
      );
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('New password and confirmation do not match.');
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const res = await resetPassword(token, password);
      if (!res.ok) {
        setErrorMessage(res.error);
        return;
      }

      setPassword('');
      setConfirmPassword('');
      setSuccessMessage(res.data.message);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  if (mode === 'verify-email') {
    return (
      <div className="space-y-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F3D5DF]/55 text-[#49243E]">
          {submitting ? (
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          ) : successMessage ? (
            <MailCheck className="h-6 w-6" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-6 w-6 text-[#B76E79]" aria-hidden="true" />
          )}
        </div>

        <div>
          <h2 className="font-serif text-3xl font-semibold text-[#49243E]">
            {submitting
              ? 'Verifying Your Email'
              : successMessage
                ? verifyPurpose === 'link_email'
                  ? 'Email Linked & Verified'
                  : 'Email Verified'
                : 'Verification Unsuccessful'}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-[#242124]/75">
            {submitting
              ? 'Confirming your single-use verification link with the server...'
              : successMessage || errorMessage}
          </p>
        </div>

        {!submitting && (
          <div className="flex flex-col gap-3 pt-2">
            {successMessage ? (
              user ? (
                <button
                  type="button"
                  onClick={() => onAuthenticated()}
                  className="flex min-h-[46px] w-full items-center justify-center rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                >
                  Continue to Your Account
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onChangeMode('login')}
                  className="flex min-h-[46px] w-full items-center justify-center rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                >
                  Sign In Now
                </button>
              )
            ) : (
              <>
                <p className="rounded-xl border border-[#49243E]/12 bg-[#FFF9F5] px-3.5 py-2.5 text-xs leading-relaxed text-[#242124]/75">
                  If you already confirmed your email on the hosted verification screen or need a
                  fresh link, sign in below to request another verification email.
                </p>
                <button
                  type="button"
                  onClick={() => onChangeMode('login')}
                  className="flex min-h-[46px] w-full items-center justify-center rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                >
                  Return to Sign In
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onBackToCollections}
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-[#49243E]/20 px-5 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30"
            >
              Browse Collections
            </button>
          </div>
        )}
      </div>
    );
  }

  if (mode === 'reset') {
    return (
      <form onSubmit={handleResetSubmit} className="space-y-4" noValidate>
        {errorMessage && (
          <div
            role="alert"
            className="space-y-2 rounded-xl border border-[#B76E79]/40 bg-[#F3D5DF]/30 px-3.5 py-3 text-sm text-[#49243E]"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => onChangeMode('forgot')}
              className="ml-6 inline-flex items-center text-xs font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79]"
            >
              Request a fresh password reset link
            </button>
          </div>
        )}

        {successMessage ? (
          <div className="space-y-4">
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-3.5 py-3 text-sm text-[#49243E]"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
              <span>{successMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => onChangeMode('login')}
              className="flex min-h-[46px] w-full items-center justify-center rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
            >
              Sign In with New Password
            </button>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor={passwordId} className="block text-sm font-medium text-[#49243E]">
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
                  placeholder={`At least ${capabilities.passwordMinLength} characters`}
                  className="min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#49243E]/70 hover:text-[#49243E]"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor={confirmPasswordId}
                className="block text-sm font-medium text-[#49243E]"
              >
                Confirm New Password
              </label>
              <div className="relative mt-1.5">
                <input
                  id={confirmPasswordId}
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter your new password"
                  className="min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                  aria-label={
                    showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'
                  }
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#49243E]/70 hover:text-[#49243E]"
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-65"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <span>{submitting ? 'Updating Password...' : 'Update Password'}</span>
            </button>
          </>
        )}
      </form>
    );
  }

  const isFirebaseManaged = capabilities.authMode === 'firebase_managed';
  const firebaseProviderDisabled =
    isFirebaseManaged && capabilities.emailPasswordEnabled === false;
  const smtpMissing = !isFirebaseManaged && !capabilities.emailDeliveryConfigured;

  const handleRecheckFirebaseProvider = async () => {
    if (checkingProvider) return;
    setCheckingProvider(true);
    setProviderCheckNote(null);
    const updated = await refreshCapabilities();
    setCheckingProvider(false);
    const proj = updated?.firebaseProjectId || capabilities.firebaseProjectId || 'configured Firebase project';
    if (!updated) {
      setProviderCheckNote('Could not reach the server to verify Firebase status.');
      return;
    }
    if (updated.emailPasswordEnabled) {
      setSuccessMessage(`Email/Password authentication is active on Firebase project ${proj}.`);
      setErrorMessage(null);
    } else {
      setProviderCheckNote(
        `Checked just now: project ${proj} still returns ${updated.providerStatusReason || 'PASSWORD_LOGIN_DISABLED'}. Confirm you edited project "${proj}" and clicked Save.`
      );
    }
  };

  return (
    <form
      onSubmit={
        mode === 'login'
          ? handleLoginSubmit
          : mode === 'signup'
            ? handleSignupSubmit
            : handleForgotSubmit
      }
      className="space-y-4"
      noValidate
    >
      {firebaseProviderDisabled && (
        <div
          role="note"
          className="space-y-2 rounded-xl border border-[#B76E79]/45 bg-[#FFF9F5] px-3.5 py-3 text-xs leading-relaxed text-[#49243E]"
        >
          <p className="font-semibold">Firebase Email/Password Sign-In Is Disabled</p>
          <p className="text-[#242124]/80">
            Firebase project{' '}
            {capabilities.firebaseProjectId ? (
              <code className="rounded bg-[#F3D5DF]/45 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#49243E]">
                {capabilities.firebaseProjectId}
              </code>
            ) : (
              'connected to this app'
            )}{' '}
            currently reports Email/Password sign-in turned off
            {capabilities.providerStatusReason ? ` (${capabilities.providerStatusReason})` : ''}.
            Open{' '}
            <span className="font-medium text-[#49243E]">
              Authentication → Sign-in method → Email/Password
            </span>{' '}
            {capabilities.firebaseProjectId
              ? `in project ${capabilities.firebaseProjectId}`
              : 'in Firebase Console'}
            , enable Email/Password, and click <span className="font-medium text-[#49243E]">Save</span>.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            <button
              type="button"
              disabled={checkingProvider}
              onClick={() => void handleRecheckFirebaseProvider()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#49243E]/25 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30 disabled:opacity-60"
            >
              {checkingProvider ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{checkingProvider ? 'Checking Firebase...' : 'Re-check Firebase Status'}</span>
            </button>
            {capabilities.firebaseProjectId && (
              <a
                href={`https://console.firebase.google.com/project/${encodeURIComponent(capabilities.firebaseProjectId)}/authentication/providers`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79]"
              >
                Open Firebase Sign-in Providers
              </a>
            )}
          </div>
          {providerCheckNote && (
            <p className="text-[11px] font-medium text-[#9B2C3E]">{providerCheckNote}</p>
          )}
        </div>
      )}

      {(mode === 'signup' || mode === 'forgot') && smtpMissing && (
        <div
          role="note"
          className="rounded-xl border border-[#B76E79]/40 bg-[#FFF9F5] px-3.5 py-3 text-xs leading-relaxed text-[#49243E]"
        >
          <p className="font-semibold">Email Delivery Setup Needed</p>
          <p className="mt-1 text-[#242124]/80">
            Outgoing email is not configured on the server yet. Add{' '}
            <code className="font-mono text-[11px]">SMTP_HOST</code>,{' '}
            <code className="font-mono text-[11px]">SMTP_FROM</code>,{' '}
            <code className="font-mono text-[11px]">SMTP_USER</code>, and{' '}
            <code className="font-mono text-[11px]">SMTP_PASS</code> in{' '}
            <code className="font-mono text-[11px]">.env</code> to send real verification and
            password-reset links.
          </p>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          aria-live="polite"
          className="space-y-2.5 rounded-xl border border-[#B76E79]/40 bg-[#F3D5DF]/30 px-3.5 py-3 text-sm text-[#49243E]"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
          {pendingResendEmail && (
            <div className="ml-6 space-y-2">
              {needsResendPassword && (
                <div>
                  <label
                    htmlFor={`${passwordId}-resend-err`}
                    className="block text-xs font-medium text-[#49243E]"
                  >
                    Account Password (required to send a fresh verification link)
                  </label>
                  <input
                    id={`${passwordId}-resend-err`}
                    type="password"
                    autoComplete="current-password"
                    value={resendPassword}
                    onChange={(e) => setResendPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="mt-1 min-h-[38px] w-full rounded-lg border border-[#49243E]/20 bg-white px-3 text-xs text-[#242124] focus:border-[#49243E] focus:outline-none"
                  />
                </div>
              )}
              <button
                type="button"
                disabled={resending || resendCooldownSec > 0}
                onClick={() => void handleResendVerification()}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79] disabled:cursor-not-allowed disabled:opacity-55 disabled:no-underline"
              >
                {resending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                <span>
                  {resending
                    ? 'Sending link...'
                    : resendCooldownSec > 0
                      ? `Resend available in ${resendCooldownSec}s`
                      : 'Resend verification email'}
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          aria-live="polite"
          className="space-y-2.5 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-3.5 py-3 text-sm text-[#49243E]"
        >
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
            <span>{successMessage}</span>
          </div>
          {mode === 'signup' && pendingResendEmail && (
            <div className="ml-6 space-y-2">
              {needsResendPassword && (
                <div>
                  <label
                    htmlFor={`${passwordId}-resend-ok`}
                    className="block text-xs font-medium text-[#49243E]"
                  >
                    Account Password (required to verify and resend)
                  </label>
                  <input
                    id={`${passwordId}-resend-ok`}
                    type="password"
                    autoComplete="current-password"
                    value={resendPassword}
                    onChange={(e) => setResendPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="mt-1 min-h-[38px] w-full rounded-lg border border-[#49243E]/20 bg-white px-3 text-xs text-[#242124] focus:border-[#49243E] focus:outline-none"
                  />
                </div>
              )}
              <button
                type="button"
                disabled={resending || resendCooldownSec > 0}
                onClick={() => void handleResendVerification()}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79] disabled:cursor-not-allowed disabled:opacity-55 disabled:no-underline"
              >
                {resending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                <span>
                  {resending
                    ? 'Sending link...'
                    : resendCooldownSec > 0
                      ? `Resend available in ${resendCooldownSec}s`
                      : 'Resend verification link'}
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'signup' && (
        <div>
          <label htmlFor={fullNameId} className="block text-sm font-medium text-[#49243E]">
            Full Name
          </label>
          <input
            id={fullNameId}
            type="text"
            autoComplete="name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Ananya Reddy"
            className="mt-1.5 min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] placeholder:text-[#242124]/40 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
          />
        </div>
      )}

      <div>
        <label htmlFor={emailId} className="block text-sm font-medium text-[#49243E]">
          Email Address
        </label>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-1.5 min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] placeholder:text-[#242124]/40 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
        />
      </div>

      {mode !== 'forgot' && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={passwordId} className="block text-sm font-medium text-[#49243E]">
              Password
            </label>
            {mode === 'login' && (
              <button
                type="button"
                onClick={() => onChangeMode('forgot')}
                className="text-xs font-medium text-[#B76E79] transition-colors hover:text-[#49243E]"
              >
                Forgot password?
              </button>
            )}
          </div>
          <div className="relative mt-1.5">
            <input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                mode === 'signup'
                  ? `At least ${capabilities.passwordMinLength} characters`
                  : 'Enter your password'
              }
              className="min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#49243E]/70 hover:text-[#49243E]"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}

      {mode === 'signup' && (
        <div>
          <label htmlFor={confirmPasswordId} className="block text-sm font-medium text-[#49243E]">
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
              placeholder="Re-enter your password"
              className="min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 pr-12 text-base text-[#242124] placeholder:text-[#242124]/40 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((prev) => !prev)}
              aria-label={
                showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'
              }
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#49243E]/70 hover:text-[#49243E]"
            >
              {showConfirmPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-65"
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        <span>
          {submitting
            ? mode === 'login'
              ? 'Signing In...'
              : mode === 'signup'
                ? 'Creating Account...'
                : 'Sending Reset Link...'
            : mode === 'login'
              ? 'Login'
              : mode === 'signup'
                ? 'Create Verified Account'
                : 'Send Reset Link'}
        </span>
      </button>

      <div className="pt-2 text-center text-sm text-[#242124]/75">
        {mode === 'login' && (
          <p>
            Don&apos;t have an account?{' '}
            <button
              type="button"
              onClick={() => onChangeMode('signup')}
              className="font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79]"
            >
              Sign Up
            </button>
          </p>
        )}
        {mode === 'signup' && (
          <p>
            Already have an account?{' '}
            <button
              type="button"
              onClick={() => onChangeMode('login')}
              className="font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79]"
            >
              Login
            </button>
          </p>
        )}
        {mode === 'forgot' && (
          <p>
            Remembered your password?{' '}
            <button
              type="button"
              onClick={() => onChangeMode('login')}
              className="font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79]"
            >
              Back to Login
            </button>
          </p>
        )}
      </div>
    </form>
  );
}
