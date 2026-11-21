export interface CountryDialOption {
  iso: string;
  label: string;
  dialCode: string;
  example: string;
}

export const DEFAULT_COUNTRY_DIAL_CODE = '+91';

export const COUNTRY_DIAL_OPTIONS: CountryDialOption[] = [
  { iso: 'IN', label: 'India', dialCode: '+91', example: '98765 43210' },
  { iso: 'US', label: 'United States / Canada', dialCode: '+1', example: '415 555 2671' },
  { iso: 'GB', label: 'United Kingdom', dialCode: '+44', example: '7700 900123' },
  { iso: 'AE', label: 'United Arab Emirates', dialCode: '+971', example: '50 123 4567' },
  { iso: 'SG', label: 'Singapore', dialCode: '+65', example: '8123 4567' },
  { iso: 'AU', label: 'Australia', dialCode: '+61', example: '412 345 678' },
  { iso: 'DE', label: 'Germany', dialCode: '+49', example: '151 23456789' },
  { iso: 'MY', label: 'Malaysia', dialCode: '+60', example: '12 345 6789' },
];

export type PhoneNormalizationResult =
  | {
      ok: true;
      e164: string;
      dialCode: string;
      nationalDigits: string;
    }
  | {
      ok: false;
      code: 'PHONE_REQUIRED' | 'INVALID_PHONE_FORMAT' | 'INVALID_INDIA_MOBILE';
      error: string;
    };

const E164_STRICT_REGEX = /^\+[1-9][0-9]{6,14}$/;
const INDIA_MOBILE_REGEX = /^\+91[6-9][0-9]{9}$/;

/**
 * Validates and normalizes user-entered phone numbers to strict E.164 (+<country><subscriber>).
 * Defaults to India (+91) when no international prefix is supplied.
 */
export function normalizePhoneToE164(
  rawInput: string,
  defaultDialCode: string = DEFAULT_COUNTRY_DIAL_CODE
): PhoneNormalizationResult {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return {
      ok: false,
      code: 'PHONE_REQUIRED',
      error: 'Please enter a mobile number.',
    };
  }

  // Strip visual formatting characters
  let compact = trimmed.replace(/[\s\-().\u00A0]/g, '');

  // Reject clearly non-phone characters early
  if (!/^[+0-9]+$/.test(compact)) {
    return {
      ok: false,
      code: 'INVALID_PHONE_FORMAT',
      error: 'Mobile number may contain only digits, spaces, dashes, and an optional leading + country code.',
    };
  }

  if (compact.startsWith('00')) {
    compact = `+${compact.slice(2)}`;
  }

  let candidateE164 = '';
  const cleanDial = defaultDialCode.startsWith('+')
    ? `+${defaultDialCode.replace(/[^0-9]/g, '')}`
    : `+${defaultDialCode.replace(/[^0-9]/g, '') || '91'}`;

  if (compact.startsWith('+')) {
    const rest = compact.slice(1).replace(/\+/g, '');
    if (cleanDial === '+91' && rest.startsWith('910') && rest.length === 13) {
      // Normalize +910XXXXXXXXXX -> +91XXXXXXXXXX
      candidateE164 = `+91${rest.slice(3)}`;
    } else if (rest.startsWith('91') && rest.length === 13 && rest[2] === '0') {
      candidateE164 = `+91${rest.slice(3)}`;
    } else {
      candidateE164 = `+${rest}`;
    }
  } else {
    let national = compact;
    // Strip domestic trunk 0 prefix (e.g. 09876543210 -> 9876543210)
    if (national.startsWith('0')) {
      national = national.replace(/^0+/, '');
    }

    // If user typed 91XXXXXXXXXX while India (+91) is selected
    if (
      cleanDial === '+91' &&
      national.length === 12 &&
      national.startsWith('91')
    ) {
      candidateE164 = `+${national}`;
    } else {
      const dialDigits = cleanDial.slice(1);
      if (
        dialDigits &&
        dialDigits !== '91' &&
        national.startsWith(dialDigits) &&
        national.length >= dialDigits.length + 7 &&
        national.length <= 15
      ) {
        candidateE164 = `+${national}`;
      } else {
        candidateE164 = `${cleanDial}${national}`;
      }
    }
  }

  if (candidateE164.startsWith('+91')) {
    if (!INDIA_MOBILE_REGEX.test(candidateE164)) {
      return {
        ok: false,
        code: 'INVALID_INDIA_MOBILE',
        error:
          'Enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9 (e.g. 98765 43210).',
      };
    }
    return {
      ok: true,
      e164: candidateE164,
      dialCode: '+91',
      nationalDigits: candidateE164.slice(3),
    };
  }

  if (!E164_STRICT_REGEX.test(candidateE164)) {
    return {
      ok: false,
      code: 'INVALID_PHONE_FORMAT',
      error:
        'Enter a valid international mobile number in E.164 format (for example +919876543210 or +14155552671).',
    };
  }

  const matchedDial =
    COUNTRY_DIAL_OPTIONS.find((opt) => candidateE164.startsWith(opt.dialCode))?.dialCode ||
    cleanDial;
  return {
    ok: true,
    e164: candidateE164,
    dialCode: matchedDial,
    nationalDigits: candidateE164.startsWith(matchedDial)
      ? candidateE164.slice(matchedDial.length)
      : candidateE164.slice(1),
  };
}

/**
 * Extracts a 6-digit OTP code from manual entry, clipboard paste, or SMS autofill text.
 */
export function sanitizeOtpCodeInput(raw: string): string {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  return digits;
}

export function maskPhoneForDisplay(e164: string | null | undefined): string {
  const clean = String(e164 || '').trim();
  if (!clean) return '';
  if (clean.length <= 6) return clean;
  const head = clean.slice(0, Math.min(4, clean.length - 4));
  const tail = clean.slice(-4);
  return `${head}••••${tail}`;
}

export function formatPhoneForInput(e164: string | null | undefined): string {
  const clean = String(e164 || '').trim();
  if (!clean) return '';
  if (clean.startsWith('+91') && clean.length === 13) {
    return `+91 ${clean.slice(3, 8)} ${clean.slice(8)}`;
  }
  return clean;
}

/**
 * Ensures error/diagnostic strings never leak OTP codes, tokens, or secrets.
 */
export function redactPhoneAuthDiagnostic(raw: string): string {
  return String(raw || '')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/\b[0-9]{6}\b/g, '[redacted-otp]');
}
