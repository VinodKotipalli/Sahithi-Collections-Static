import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

export interface ParsedPhoneResult {
  isValid: boolean;
  e164: string | null;
  masked: string;
  international: string;
  error: string | null;
}

export function validateAndNormalizePhone(
  rawInput: string,
  countryIso: CountryCode
): ParsedPhoneResult {
  const cleaned = rawInput.trim();
  if (!cleaned) {
    return {
      isValid: false,
      e164: null,
      masked: '',
      international: '',
      error: 'Please enter your mobile number.',
    };
  }

  const parsed = parsePhoneNumberFromString(cleaned, countryIso);
  if (!parsed || !parsed.isValid()) {
    return {
      isValid: false,
      e164: null,
      masked: '',
      international: '',
      error: 'Please enter a valid mobile number for the selected country.',
    };
  }

  const e164 = parsed.number;
  return {
    isValid: true,
    e164,
    masked: maskPhoneNumber(e164),
    international: parsed.formatInternational(),
    error: null,
  };
}

export function maskPhoneNumber(rawPhone: string): string {
  const trimmed = rawPhone.trim();
  if (!trimmed) return '';
  const parsed = parsePhoneNumberFromString(trimmed);
  if (parsed) {
    const cc = `+${parsed.countryCallingCode}`;
    const national = parsed.nationalNumber;
    if (national.length <= 4) {
      return `${cc} ${'•'.repeat(national.length)}`;
    }
    const visibleTail = national.slice(-4);
    const hiddenPart = '•'.repeat(Math.max(national.length - 4, 2));
    return `${cc} ${hiddenPart}${visibleTail}`;
  }

  if (trimmed.length <= 4) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, 3)} ${'•'.repeat(Math.max(trimmed.length - 7, 3))}${trimmed.slice(-4)}`;
}
