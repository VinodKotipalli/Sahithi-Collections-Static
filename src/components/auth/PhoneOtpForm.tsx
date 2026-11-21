import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Phone,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';
import {
  clearRecaptchaVerifierInstance,
  confirmLinkOrReplacePhoneOtp,
  confirmReauthPhoneOtp,
  confirmSignInPhoneOtp,
  createPhoneRecaptchaVerifier,
  mapFirebasePhoneAuthError,
  sendLinkPhoneOtp,
  sendReauthPhoneOtp,
  sendReplacePhoneOtp,
  sendSignInPhoneOtp,
  waitForFirebaseWebCurrentUser,
  type FirebaseWebAuthSessionSnapshot,
} from '../../services/firebaseWebAuth';
import {
  COUNTRY_DIAL_OPTIONS,
  DEFAULT_COUNTRY_DIAL_CODE,
  formatPhoneForInput,
  normalizePhoneToE164,
  sanitizeOtpCodeInput,
} from '../../utils/phoneAuth';

export type PhoneOtpFormMode = 'signin' | 'link' | 'replace' | 'reauth';

interface PhoneOtpFormProps {
  mode: PhoneOtpFormMode;
  /** Required/prefilled verified phone when mode is 'reauth', optional prefill otherwise */
  fixedPhoneE164?: string | null;
  /** Optional display name on signup flows */
  showFullNameField?: boolean;
  /** Triggered after Firebase SDK OTP confirmation completes */
  onVerified: (
    snapshot: FirebaseWebAuthSessionSnapshot,
    options?: { fullName?: string }
  ) => Promise<{ ok: boolean; error?: string; code?: string }>;
  onRequiresRecentLogin?: () => void;
  onCancel?: () => void;
  submitLabel?: string;
}

const RESEND_COOLDOWN_SECONDS = 60;

type ActiveChallenge =
  | { kind: 'confirmation'; confirmation: ConfirmationResult }
  | { kind: 'verification_id'; verificationId: string };

export function PhoneOtpForm({
  mode,
  fixedPhoneE164 = null,
  showFullNameField = false,
  onVerified,
  onRequiresRecentLogin,
  onCancel,
  submitLabel,
}: PhoneOtpFormProps) {
  const fullNameId = useId();
  const countryId = useId();
  const phoneInputId = useId();
  const consentId = useId();
  const otpInputId = useId();
  const recaptchaContainerRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const sendInFlightRef = useRef(false);
  const verifyInFlightRef = useRef(false);

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [fullName, setFullName] = useState('');
  const [countryDialCode, setCountryDialCode] = useState(DEFAULT_COUNTRY_DIAL_CODE);
  const [phoneInput, setPhoneInput] = useState(() =>
    fixedPhoneE164 ? formatPhoneForInput(fixedPhoneE164) : ''
  );
  const [consentChecked, setConsentChecked] = useState(false);

  const [challenge, setChallenge] = useState<ActiveChallenge | null>(null);
  const [sentPhoneE164, setSentPhoneE164] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [resendSeconds, setResendSeconds] = useState(0);

  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [useVisibleRecaptcha, setUseVisibleRecaptcha] = useState(false);

  useEffect(() => {
    if (fixedPhoneE164 && mode === 'reauth') {
      setPhoneInput(formatPhoneForInput(fixedPhoneE164));
    }
  }, [fixedPhoneE164, mode]);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setResendSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  useEffect(() => {
    return () => {
      clearRecaptchaVerifierInstance(verifierRef.current, recaptchaContainerRef.current);
      verifierRef.current = null;
    };
  }, []);

  const resetRecaptcha = () => {
    clearRecaptchaVerifierInstance(verifierRef.current, recaptchaContainerRef.current);
    verifierRef.current = null;
  };

  const normalizedPreview = normalizePhoneToE164(
    mode === 'reauth' && fixedPhoneE164 ? fixedPhoneE164 : phoneInput,
    countryDialCode
  );

  const getOrCreateVerifier = async (size: 'invisible' | 'normal'): Promise<RecaptchaVerifier> => {
    resetRecaptcha();
    if (!recaptchaContainerRef.current) {
      throw new Error('Verification container is unavailable.');
    }
    const verifier = createPhoneRecaptchaVerifier(
      recaptchaContainerRef.current,
      size,
      () => {
        setErrorMessage('Security check expired. Click Send Verification Code to try again.');
        resetRecaptcha();
      }
    );
    verifierRef.current = verifier;
    await verifier.render();
    return verifier;
  };

  const executeSendOtp = async (forceVisibleCaptcha = useVisibleRecaptcha) => {
    if (sendInFlightRef.current || verifyInFlightRef.current) return;

    setErrorMessage(null);
    setInfoMessage(null);

    if (showFullNameField && fullName.trim().length < 2) {
      setErrorMessage('Please enter your full name (at least 2 characters) before requesting an OTP.');
      return;
    }

    const phoneSource = mode === 'reauth' && fixedPhoneE164 ? fixedPhoneE164 : phoneInput;
    const normalized = normalizePhoneToE164(phoneSource, countryDialCode);
    if (!normalized.ok) {
      setErrorMessage(normalized.error);
      return;
    }

    if (!consentChecked) {
      setErrorMessage(
        'Please confirm consent to receive a one-time verification SMS and complete Google security verification.'
      );
      return;
    }

    if ((mode === 'link' || mode === 'replace' || mode === 'reauth')) {
      const fbCurrent = await waitForFirebaseWebCurrentUser().catch(() => null);
      if (!fbCurrent) {
        onRequiresRecentLogin?.();
        setErrorMessage(
          'Your browser security session needs a fresh verification. Verify your identity above or sign in again first.'
        );
        return;
      }
    }

    sendInFlightRef.current = true;
    setSending(true);
    try {
      const verifier = await getOrCreateVerifier(forceVisibleCaptcha ? 'normal' : 'invisible');
      let nextChallenge: ActiveChallenge;
      if (mode === 'signin') {
        const confirmation = await sendSignInPhoneOtp(normalized.e164, verifier);
        nextChallenge = { kind: 'confirmation', confirmation };
      } else if (mode === 'link') {
        const confirmation = await sendLinkPhoneOtp(normalized.e164, verifier);
        nextChallenge = { kind: 'confirmation', confirmation };
      } else if (mode === 'replace') {
        nextChallenge = await sendReplacePhoneOtp(normalized.e164, verifier);
      } else {
        const confirmation = await sendReauthPhoneOtp(normalized.e164, verifier);
        nextChallenge = { kind: 'confirmation', confirmation };
      }

      setChallenge(nextChallenge);
      setSentPhoneE164(normalized.e164);
      setOtpCode('');
      setStep('otp');
      setResendSeconds(RESEND_COOLDOWN_SECONDS);
      setInfoMessage(`We sent a 6-digit verification SMS to ${normalized.e164}.`);
    } catch (err) {
      const mapped = mapFirebasePhoneAuthError(err);
      setErrorMessage(mapped.message);
      if (mapped.resetRecaptcha) {
        resetRecaptcha();
      }
      if (mapped.code === 'auth/captcha-check-failed') {
        setUseVisibleRecaptcha(true);
      }
      if (mapped.requiresRecentLogin) {
        onRequiresRecentLogin?.();
      }
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };

  const handleSendFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void executeSendOtp();
  };

  const handleOtpSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (verifyInFlightRef.current || sendInFlightRef.current || !challenge) return;

    setErrorMessage(null);
    const cleanOtp = sanitizeOtpCodeInput(otpCode);
    if (cleanOtp.length !== 6) {
      setErrorMessage('Enter the 6-digit verification code sent via SMS.');
      return;
    }

    verifyInFlightRef.current = true;
    setVerifying(true);
    try {
      let snapshot: FirebaseWebAuthSessionSnapshot;
      if (mode === 'signin') {
        if (challenge.kind !== 'confirmation') {
          throw new Error('Missing verification confirmation handle.');
        }
        snapshot = await confirmSignInPhoneOtp(challenge.confirmation, cleanOtp);
      } else if (mode === 'reauth') {
        if (challenge.kind !== 'confirmation') {
          throw new Error('Missing reauthentication confirmation handle.');
        }
        snapshot = await confirmReauthPhoneOtp(challenge.confirmation, cleanOtp);
      } else {
        snapshot = await confirmLinkOrReplacePhoneOtp({
          handle: challenge,
          otpCode: cleanOtp,
        });
      }

      const appRes = await onVerified(snapshot, {
        ...(fullName.trim().length >= 2 ? { fullName: fullName.trim() } : {}),
      });
      if (!appRes.ok) {
        setErrorMessage(
          appRes.error || 'Unable to complete verification with the store server. Please try again.'
        );
        return;
      }
      resetRecaptcha();
    } catch (err) {
      const mapped = mapFirebasePhoneAuthError(err);
      setErrorMessage(mapped.message);
      if (mapped.code === 'auth/code-expired' || mapped.code === 'auth/session-expired') {
        setResendSeconds(0);
      }
      if (mapped.resetRecaptcha) {
        resetRecaptcha();
      }
      if (mapped.requiresRecentLogin) {
        onRequiresRecentLogin?.();
      }
    } finally {
      verifyInFlightRef.current = false;
      setVerifying(false);
    }
  };

  const handleOtpPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData?.getData('text') || '';
    const extracted = sanitizeOtpCodeInput(pasted);
    if (extracted.length === 6) {
      e.preventDefault();
      setOtpCode(extracted);
      setErrorMessage(null);
    }
  };

  const handleChangeNumber = () => {
    if (sending || verifying) return;
    resetRecaptcha();
    setChallenge(null);
    setOtpCode('');
    setResendSeconds(0);
    setErrorMessage(null);
    setInfoMessage(null);
    setStep('phone');
  };

  const selectedCountry =
    COUNTRY_DIAL_OPTIONS.find((c) => c.dialCode === countryDialCode) || COUNTRY_DIAL_OPTIONS[0];

  return (
    <div className="space-y-4">
      {errorMessage && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-start gap-2.5 rounded-xl border border-[#B76E79]/40 bg-[#F3D5DF]/30 px-3.5 py-3 text-sm text-[#49243E]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      {infoMessage && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2.5 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5] px-3.5 py-3 text-xs leading-relaxed text-[#49243E]"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
          <span>{infoMessage}</span>
        </div>
      )}

      {step === 'phone' ? (
        <form onSubmit={handleSendFormSubmit} className="space-y-3.5" noValidate>
          {showFullNameField && (
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

          {mode === 'reauth' && fixedPhoneE164 ? (
            <div className="rounded-xl border border-[#49243E]/15 bg-[#FFF9F5] px-3.5 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#B76E79]">
                Verified Login Mobile Number
              </p>
              <p className="mt-1 flex items-center gap-2 font-mono text-sm font-semibold text-[#49243E]">
                <Phone className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                <span>{fixedPhoneE164}</span>
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor={phoneInputId} className="block text-sm font-medium text-[#49243E]">
                Mobile Number
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                <div className="sm:col-span-5">
                  <label htmlFor={countryId} className="sr-only">
                    Country calling code
                  </label>
                  <select
                    id={countryId}
                    value={countryDialCode}
                    onChange={(e) => setCountryDialCode(e.target.value)}
                    disabled={sending}
                    className="min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm font-medium text-[#49243E] focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15"
                  >
                    {COUNTRY_DIAL_OPTIONS.map((opt) => (
                      <option key={opt.iso} value={opt.dialCode}>
                        {opt.label} ({opt.dialCode})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-7">
                  <input
                    id={phoneInputId}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    required
                    disabled={sending}
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder={selectedCountry.example}
                    className="min-h-[46px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] placeholder:text-[#242124]/40 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
                  />
                </div>
              </div>

              {phoneInput.trim() && normalizedPreview.ok && (
                <p className="text-[11px] text-[#242124]/65">
                  Normalized E.164 format:{' '}
                  <span className="font-mono font-semibold text-[#49243E]">
                    {normalizedPreview.e164}
                  </span>
                </p>
              )}
            </div>
          )}

          <div className="rounded-xl border border-[#49243E]/12 bg-[#FFF9F5]/80 p-3 text-xs leading-relaxed text-[#242124]/80">
            <p className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
              <span>
                We will send a one-time 6-digit SMS verification code to confirm this mobile number.
                Phone numbers are processed with Google Firebase Authentication &amp; Google reCAPTCHA
                for spam and abuse prevention; standard SMS rates may apply.
              </span>
            </p>
            <label
              htmlFor={consentId}
              className="mt-2.5 flex cursor-pointer items-start gap-2.5 border-t border-[#49243E]/10 pt-2.5 font-medium text-[#49243E]"
            >
              <input
                id={consentId}
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                disabled={sending}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#49243E]"
              />
              <span>
                I consent to receive a one-time verification SMS and allow Google reCAPTCHA abuse
                verification for this mobile number.
              </span>
            </label>
          </div>

          {/* reCAPTCHA widget mount container (renders visible widget if fallback triggered) */}
          <div
            ref={recaptchaContainerRef}
            className={useVisibleRecaptcha ? 'min-h-[78px] overflow-x-auto py-1' : ''}
          />

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="submit"
              disabled={sending || !consentChecked || !normalizedPreview.ok}
              className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <span>
                {sending
                  ? 'Sending OTP...'
                  : submitLabel ||
                    (mode === 'replace'
                      ? 'Send OTP to Replace Number'
                      : mode === 'link'
                        ? 'Send OTP to Link Number'
                        : mode === 'reauth'
                          ? 'Send Verification SMS'
                          : 'Send Verification OTP')}
              </span>
            </button>

            {onCancel && (
              <button
                type="button"
                disabled={sending}
                onClick={onCancel}
                className="flex min-h-[46px] items-center justify-center rounded-xl border border-[#49243E]/20 px-4 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30 disabled:opacity-60"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <form onSubmit={handleOtpSubmit} className="space-y-4" noValidate>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#49243E]/15 bg-[#FFF9F5] px-3.5 py-2.5 text-xs">
            <span className="font-mono font-semibold text-[#49243E]">{sentPhoneE164}</span>
            {mode !== 'reauth' && (
              <button
                type="button"
                disabled={sending || verifying}
                onClick={handleChangeNumber}
                className="inline-flex items-center gap-1 font-semibold text-[#B76E79] underline underline-offset-4 hover:text-[#49243E] disabled:opacity-50"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Change number</span>
              </button>
            )}
          </div>

          <div>
            <label htmlFor={otpInputId} className="block text-sm font-medium text-[#49243E]">
              6-Digit Verification Code
            </label>
            <input
              id={otpInputId}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              disabled={verifying}
              value={otpCode}
              onPaste={handleOtpPaste}
              onChange={(e) => setOtpCode(sanitizeOtpCodeInput(e.target.value))}
              placeholder="123456"
              className="mt-1.5 min-h-[48px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-4 text-center font-mono text-lg tracking-[0.42em] text-[#49243E] placeholder:tracking-[0.25em] placeholder:text-[#242124]/30 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15"
            />
            <p className="mt-1.5 text-[11px] text-[#242124]/65">
              Supports SMS autofill and pasting your 6-digit code directly.
            </p>
          </div>

          <div
            ref={recaptchaContainerRef}
            className={useVisibleRecaptcha ? 'min-h-[78px] overflow-x-auto py-1' : ''}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <button
              type="button"
              disabled={sending || verifying || resendSeconds > 0}
              onClick={() => void executeSendOtp()}
              className="inline-flex items-center gap-1.5 font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79] disabled:cursor-not-allowed disabled:opacity-55 disabled:no-underline"
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {sending
                  ? 'Resending OTP...'
                  : resendSeconds > 0
                    ? `Resend OTP in ${resendSeconds}s`
                    : 'Resend verification OTP'}
              </span>
            </button>

            {onCancel && (
              <button
                type="button"
                disabled={sending || verifying}
                onClick={onCancel}
                className="font-medium text-[#242124]/70 hover:text-[#49243E]"
              >
                Cancel
              </button>
            )}
          </div>

          <button
            type="submit"
            disabled={verifying || sending || otpCode.length !== 6}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {verifying && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            <span>
              {verifying
                ? 'Verifying Code...'
                : mode === 'reauth'
                  ? 'Confirm Identity'
                  : mode === 'link'
                    ? 'Confirm & Link Mobile Number'
                    : mode === 'replace'
                      ? 'Confirm & Replace Mobile Number'
                      : 'Verify & Continue'}
            </span>
          </button>
        </form>
      )}
    </div>
  );
}
