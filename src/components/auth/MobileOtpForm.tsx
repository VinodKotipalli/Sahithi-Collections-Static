import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { CountryCode } from 'libphonenumber-js';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { AUTH_CONFIG, SUPPORTED_COUNTRIES } from '../../config/auth';
import { useAuth } from '../../context/AuthContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { validateAndNormalizePhone } from '../../utils/phone';
import { OtpCodeInput } from './OtpCodeInput';
import { TurnstileWidget } from './TurnstileWidget';

type MobileStep = 'phone' | 'otp' | 'profile';

interface MobileOtpFormProps {
  onAuthenticated: () => void;
  externalError?: string | null;
}

export function MobileOtpForm({ onAuthenticated, externalError = null }: MobileOtpFormProps) {
  const { isSmsConfigured, sendPhoneOtp, verifyPhoneOtp, updateProfileName } = useAuth();
  const prefersReducedMotion = usePrefersReducedMotion();

  const countryId = useId();
  const phoneId = useId();
  const fullNameId = useId();

  const [step, setStep] = useState<MobileStep>('phone');
  const [countryIso, setCountryIso] = useState<CountryCode>('IN');
  const [phoneInput, setPhoneInput] = useState('');
  const [normalizedE164, setNormalizedE164] = useState('');
  const [maskedDestination, setMaskedDestination] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [fullName, setFullName] = useState('');

  const [captchaToken, setCaptchaToken] = useState<string | undefined>(undefined);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const activeError = errorMessage || externalError;
  const selectedCountry = useMemo(
    () => SUPPORTED_COUNTRIES.find((c) => c.iso === countryIso) ?? SUPPORTED_COUNTRIES[0],
    [countryIso]
  );

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  const handleTurnstileVerify = useCallback((token: string) => {
    setCaptchaToken(token);
  }, []);

  const handleTurnstileExpire = useCallback(() => {
    setCaptchaToken(undefined);
  }, []);

  const handleSendOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || !isSmsConfigured) return;
    setErrorMessage(null);
    setStatusMessage(null);

    const parsed = validateAndNormalizePhone(phoneInput, countryIso);
    if (!parsed.isValid || !parsed.e164) {
      setErrorMessage(parsed.error || 'Please enter a valid mobile number.');
      return;
    }

    if (AUTH_CONFIG.turnstileSiteKey && !captchaToken) {
      setErrorMessage('Please complete the verification check above before requesting an OTP.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await sendPhoneOtp(parsed.e164, captchaToken);
      if (result.error) {
        setErrorMessage(result.error);
        return;
      }

      setNormalizedE164(parsed.e164);
      setMaskedDestination(parsed.masked);
      setOtpCode('');
      setResendCooldown(AUTH_CONFIG.otpResendSeconds);
      setStatusMessage('Verification code requested. Enter the digits sent to your phone.');
      setStep('otp');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyOtp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || !isSmsConfigured) return;
    setErrorMessage(null);
    setStatusMessage(null);

    const digits = otpCode.replace(/\D/g, '');
    if (digits.length !== AUTH_CONFIG.otpLength) {
      setErrorMessage(
        `Please enter the complete ${AUTH_CONFIG.otpLength}-digit verification code.`
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await verifyPhoneOtp(normalizedE164, digits);
      if (result.error) {
        setErrorMessage(result.error);
        return;
      }

      if (result.needsNameCompletion) {
        setStatusMessage('Mobile number verified.');
        setStep('profile');
      } else {
        setStatusMessage('Mobile number verified. Continuing to Sahithi Collections...');
        window.setTimeout(onAuthenticated, prefersReducedMotion ? 100 : 450);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResendOtp = async () => {
    if (isSubmitting || resendCooldown > 0 || !isSmsConfigured || !normalizedE164) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setOtpCode('');

    setIsSubmitting(true);
    try {
      const result = await sendPhoneOtp(normalizedE164, captchaToken);
      if (result.error) {
        setErrorMessage(result.error);
      } else {
        setResendCooldown(AUTH_CONFIG.otpResendSeconds);
        setStatusMessage('A replacement verification code has been requested.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChangeNumber = () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setOtpCode('');
    setStep('phone');
  };

  const handleSaveProfileName = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setErrorMessage(null);

    const trimmed = fullName.trim();
    if (trimmed.length < 2) {
      setErrorMessage('Please enter your name or choose Skip for now.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await updateProfileName(trimmed);
      if (result.error) {
        setErrorMessage(result.error);
        return;
      }
      setStatusMessage('Welcome to Sahithi Collections.');
      window.setTimeout(onAuthenticated, prefersReducedMotion ? 100 : 400);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence mode="wait">
      {step === 'phone' && (
        <motion.form
          key="phone-step"
          onSubmit={handleSendOtp}
          noValidate
          initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={prefersReducedMotion ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-4"
        >
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-[2rem]">
              Login with Mobile Number
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-[#242124]/75">
              We’ll send a verification code to your mobile number.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
            <div className="sm:col-span-5">
              <label
                htmlFor={countryId}
                className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
              >
                Country
              </label>
              <select
                id={countryId}
                value={countryIso}
                onChange={(e) => setCountryIso(e.target.value as CountryCode)}
                className="mt-1.5 h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 px-3 text-base text-[#242124] transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25 sm:text-sm"
              >
                {SUPPORTED_COUNTRIES.map((country) => (
                  <option key={country.iso} value={country.iso}>
                    {country.name} ({country.dialCode})
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-7">
              <label
                htmlFor={phoneId}
                className="block text-xs font-semibold tracking-wide uppercase text-[#49243E]"
              >
                Mobile Number
              </label>
              <input
                id={phoneId}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                required
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                onFocus={(e) =>
                  e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                }
                placeholder={selectedCountry.sample}
                className="mt-1.5 h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 px-4 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
              />
            </div>
          </div>

          <p className="text-xs leading-relaxed text-[#242124]/65">
            {AUTH_CONFIG.allowPhoneSignup
              ? 'New verified mobile numbers automatically create a Sahithi Collections account. Used strictly for sign-in verification.'
              : 'Available for registered mobile numbers. Used strictly for sign-in verification.'}
          </p>

          <TurnstileWidget
            onVerify={handleTurnstileVerify}
            onExpire={handleTurnstileExpire}
          />

          {activeError && (
            <div
              role="alert"
              className="rounded-xl border border-[#B8334A]/30 bg-[#FFF2F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8E2035]"
            >
              {activeError}
            </div>
          )}

          {!isSmsConfigured && (
            <div className="rounded-xl border border-[#B76E79]/35 bg-[#F3D5DF]/30 px-3.5 py-2.5 text-xs leading-relaxed text-[#49243E]">
              SMS OTP delivery is not active yet. Configure Supabase Auth with an SMS provider and set{' '}
              <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px]">
                VITE_AUTH_ENABLE_SMS_OTP="true"
              </code>{' '}
              to enable sending verification codes.
            </div>
          )}

          <button
            type="submit"
            disabled={!isSmsConfigured || isSubmitting}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] shadow-[0_10px_24px_-12px_rgba(73,36,62,0.5)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#3A1B31] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            <span>Send OTP</span>
          </button>
        </motion.form>
      )}

      {step === 'otp' && (
        <motion.form
          key="otp-step"
          onSubmit={handleVerifyOtp}
          noValidate
          initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={prefersReducedMotion ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-4"
        >
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-[2rem]">
              Verify Your Mobile Number
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-[#242124]/75">
              Enter the {AUTH_CONFIG.otpLength}-digit code sent to{' '}
              <span className="font-semibold text-[#49243E] tabular-nums">{maskedDestination}</span>.
              Codes expire after {AUTH_CONFIG.otpExpiryMinutes}{' '}
              {AUTH_CONFIG.otpExpiryMinutes === 1 ? 'minute' : 'minutes'}.
            </p>
          </div>

          <OtpCodeInput
            value={otpCode}
            onChange={setOtpCode}
            length={AUTH_CONFIG.otpLength}
            disabled={!isSmsConfigured || isSubmitting}
            hasError={Boolean(activeError)}
          />

          {activeError && (
            <div
              role="alert"
              className="rounded-xl border border-[#B8334A]/30 bg-[#FFF2F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8E2035]"
            >
              {activeError}
            </div>
          )}

          {statusMessage && !activeError && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-xl border border-[#49243E]/15 bg-[#F3D5DF]/35 px-3.5 py-2.5 text-xs leading-relaxed text-[#49243E]"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
              <span>{statusMessage}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={!isSmsConfigured || isSubmitting}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] shadow-[0_10px_24px_-12px_rgba(73,36,62,0.5)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#3A1B31] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            <span>Verify &amp; Continue</span>
          </button>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
            <button
              type="button"
              onClick={handleChangeNumber}
              disabled={isSubmitting}
              className="min-h-[40px] font-medium text-[#49243E] underline-offset-4 hover:text-[#B76E79] hover:underline disabled:opacity-50"
            >
              Change Number
            </button>

            <button
              type="button"
              onClick={handleResendOtp}
              disabled={!isSmsConfigured || isSubmitting || resendCooldown > 0}
              className="min-h-[40px] font-medium text-[#49243E] underline-offset-4 hover:text-[#B76E79] hover:underline disabled:cursor-not-allowed disabled:text-[#242124]/45 disabled:no-underline"
            >
              {resendCooldown > 0 ? (
                <span className="tabular-nums">Resend OTP in {resendCooldown}s</span>
              ) : (
                'Resend OTP'
              )}
            </button>
          </div>
        </motion.form>
      )}

      {step === 'profile' && (
        <motion.form
          key="profile-step"
          onSubmit={handleSaveProfileName}
          noValidate
          initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={prefersReducedMotion ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="space-y-4"
        >
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-[#49243E]">
              Complete Your Profile
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-[#242124]/75">
              Your number is verified. Add your name so we can personalize your Sahithi Collections experience.
            </p>
          </div>

          <div>
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
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onFocus={(e) =>
                e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              }
              placeholder="Ananya Sharma"
              className="mt-1.5 h-12 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/80 px-4 text-base text-[#242124] placeholder:text-[#242124]/40 transition-colors focus:border-[#B76E79] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#B76E79]/25"
            />
          </div>

          {activeError && (
            <div
              role="alert"
              className="rounded-xl border border-[#B8334A]/30 bg-[#FFF2F4] px-3.5 py-2.5 text-xs leading-relaxed text-[#8E2035]"
            >
              {activeError}
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <span>Save &amp; Continue</span>
            </button>
            <button
              type="button"
              onClick={onAuthenticated}
              className="min-h-[46px] rounded-xl border border-[#49243E]/20 px-5 py-3 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35"
            >
              Skip
            </button>
          </div>
        </motion.form>
      )}
    </AnimatePresence>
  );
}
