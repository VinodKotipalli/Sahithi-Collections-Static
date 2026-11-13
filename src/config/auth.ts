import { CountryCode } from 'libphonenumber-js';

export interface SupportedCountry {
  iso: CountryCode;
  name: string;
  dialCode: string;
  sample: string;
}

export const SUPPORTED_COUNTRIES: SupportedCountry[] = [
  { iso: 'IN', name: 'India', dialCode: '+91', sample: '98765 43210' },
  { iso: 'US', name: 'United States', dialCode: '+1', sample: '(415) 555-0192' },
  { iso: 'GB', name: 'United Kingdom', dialCode: '+44', sample: '7700 900123' },
  { iso: 'AE', name: 'United Arab Emirates', dialCode: '+971', sample: '50 123 4567' },
  { iso: 'SG', name: 'Singapore', dialCode: '+65', sample: '8123 4567' },
  { iso: 'AU', name: 'Australia', dialCode: '+61', sample: '412 345 678' },
  { iso: 'CA', name: 'Canada', dialCode: '+1', sample: '(604) 555-0148' },
];

function readEnvString(key: string, fallback = ''): string {
  const val = (import.meta.env as Record<string, string | undefined>)[key];
  return typeof val === 'string' ? val.trim() : fallback;
}

function readEnvBoolean(key: string, fallback = false): boolean {
  const val = readEnvString(key);
  if (!val) return fallback;
  return val.toLowerCase() === 'true' || val === '1';
}

function readEnvInt(key: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(readEnvString(key), 10);
  if (Number.isNaN(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

const supabaseUrl = readEnvString('VITE_SUPABASE_URL');
const supabaseAnonKey = readEnvString('VITE_SUPABASE_ANON_KEY');

export const AUTH_CONFIG = {
  supabaseUrl,
  supabaseAnonKey,
  enableSmsOtp: readEnvBoolean('VITE_AUTH_ENABLE_SMS_OTP', false),
  enableGoogle: readEnvBoolean('VITE_AUTH_ENABLE_GOOGLE', false),
  enableApple: readEnvBoolean('VITE_AUTH_ENABLE_APPLE', false),
  otpLength: readEnvInt('VITE_AUTH_OTP_LENGTH', 6, 4, 8),
  otpResendSeconds: readEnvInt('VITE_AUTH_OTP_RESEND_SECONDS', 60, 15, 300),
  otpExpiryMinutes: readEnvInt('VITE_AUTH_OTP_EXPIRY_MINUTES', 5, 1, 60),
  allowPhoneSignup: readEnvBoolean('VITE_AUTH_ALLOW_PHONE_SIGNUP', true),
  passwordMinLength: readEnvInt('VITE_AUTH_PASSWORD_MIN_LENGTH', 8, 6, 32),
  turnstileSiteKey: readEnvString('VITE_TURNSTILE_SITE_KEY'),
  enableWishlistSync: readEnvBoolean('VITE_AUTH_ENABLE_WISHLIST_SYNC', false),
} as const;

export function isSupabaseConfigured(): boolean {
  return Boolean(
    AUTH_CONFIG.supabaseUrl &&
      AUTH_CONFIG.supabaseAnonKey &&
      /^https:\/\/.+/.test(AUTH_CONFIG.supabaseUrl)
  );
}

export function isSmsOtpConfigured(): boolean {
  return isSupabaseConfigured() && AUTH_CONFIG.enableSmsOtp;
}

export function isGoogleAuthConfigured(): boolean {
  return isSupabaseConfigured() && AUTH_CONFIG.enableGoogle;
}

export function isAppleAuthConfigured(): boolean {
  return isSupabaseConfigured() && AUTH_CONFIG.enableApple;
}

export function isWishlistSyncConfigured(): boolean {
  return isSupabaseConfigured() && AUTH_CONFIG.enableWishlistSync;
}

export function sanitizeInternalRedirectPath(candidate: string | null | undefined): string {
  if (!candidate || typeof candidate !== 'string') return '/';
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes(':')) {
    return '/';
  }
  return trimmed;
}
