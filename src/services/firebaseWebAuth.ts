import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  linkWithPhoneNumber,
  PhoneAuthProvider,
  reauthenticateWithPhoneNumber,
  RecaptchaVerifier,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signOut,
  updatePhoneNumber,
  type Auth,
  type ConfirmationResult,
  type User,
} from 'firebase/auth';
import firebaseAppletConfig from '../../firebase-applet-config.json';
import { redactPhoneAuthDiagnostic } from '../utils/phoneAuth';

export interface FirebaseWebAuthSessionSnapshot {
  idToken: string;
  refreshToken: string;
  uid: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  displayName: string;
  providerIds: string[];
  hasPassword: boolean;
}

export interface MappedPhoneAuthError {
  code: string;
  message: string;
  retryable: boolean;
  resetRecaptcha: boolean;
  suggestDifferentNumber?: boolean;
  suggestSignInWithPhone?: boolean;
  requiresRecentLogin?: boolean;
}

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let emulatorConnectedHost: string | null = null;

function resolveAuthEmulatorHost(): string | null {
  try {
    const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env;
    const viteHost = metaEnv?.VITE_FIREBASE_AUTH_EMULATOR_HOST?.trim();
    if (viteHost) return viteHost;
  } catch {
    // Ignore in Node/non-Vite test environments
  }
  if (typeof process !== 'undefined' && process.env) {
    const nodeHost = (
      process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ||
      ''
    ).trim();
    if (nodeHost) return nodeHost;
  }
  return null;
}

export function isFirebaseAuthEmulatorActive(): boolean {
  return Boolean(resolveAuthEmulatorHost());
}

export function getFirebaseWebAuth(): Auth {
  if (cachedAuth) {
    return cachedAuth;
  }

  const projectId = firebaseAppletConfig.projectId;
  const authDomain =
    firebaseAppletConfig.authDomain || `${projectId}.firebaseapp.com`;

  const existingApps = getApps();
  cachedApp =
    existingApps.length > 0
      ? getApp()
      : initializeApp({
          apiKey: firebaseAppletConfig.apiKey,
          authDomain,
          projectId,
          appId: firebaseAppletConfig.appId,
          storageBucket: firebaseAppletConfig.storageBucket || undefined,
          messagingSenderId: firebaseAppletConfig.messagingSenderId || undefined,
          measurementId: firebaseAppletConfig.measurementId || undefined,
        });

  cachedAuth = getAuth(cachedApp);
  cachedAuth.languageCode = 'en';

  const emulatorHost = resolveAuthEmulatorHost();
  if (emulatorHost && emulatorConnectedHost !== emulatorHost) {
    const emulatorUrl = emulatorHost.startsWith('http')
      ? emulatorHost
      : `http://${emulatorHost}`;
    connectAuthEmulator(cachedAuth, emulatorUrl, { disableWarnings: true });
    emulatorConnectedHost = emulatorHost;
  }

  return cachedAuth;
}

export async function waitForFirebaseWebCurrentUser(): Promise<User | null> {
  const auth = getFirebaseWebAuth();
  if (typeof auth.authStateReady === 'function') {
    await auth.authStateReady();
  }
  return auth.currentUser;
}

export async function extractFirebaseWebUserSnapshot(
  fbUser: User,
  forceRefresh = false
): Promise<FirebaseWebAuthSessionSnapshot> {
  const idToken = await fbUser.getIdToken(forceRefresh);
  const providerIds = (fbUser.providerData || [])
    .map((p) => p?.providerId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const hasPassword = providerIds.includes('password');
  return {
    idToken,
    refreshToken: fbUser.refreshToken,
    uid: fbUser.uid,
    email: fbUser.email ? fbUser.email.trim().toLowerCase() : null,
    emailVerified: Boolean(fbUser.email && fbUser.emailVerified),
    phoneNumber: fbUser.phoneNumber || null,
    displayName: fbUser.displayName || '',
    providerIds,
    hasPassword,
  };
}

/**
 * Keeps Firebase Web SDK auth.currentUser aligned when the user signs in or reauthenticates
 * with email + password, enabling client SDK Phone Auth linking/replacing in /account.
 */
export async function syncEmailPasswordWithFirebaseWebSdk(
  email: string,
  password: string
): Promise<boolean> {
  if (!email || !password) return false;
  try {
    const auth = getFirebaseWebAuth();
    await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    return true;
  } catch {
    return false;
  }
}

export async function signOutFirebaseWebAuth(): Promise<void> {
  try {
    const auth = getFirebaseWebAuth();
    if (auth.currentUser) {
      await signOut(auth);
    }
  } catch {
    // Non-fatal: server/client storage session is still cleared
  }
}

export function clearRecaptchaVerifierInstance(
  verifier: RecaptchaVerifier | null | undefined,
  container?: HTMLElement | null
): void {
  if (verifier) {
    try {
      verifier.clear();
    } catch {
      // Ignore cleanup errors from detached containers
    }
  }
  if (container) {
    container.innerHTML = '';
  }
}

export function createPhoneRecaptchaVerifier(
  containerOrId: HTMLElement | string,
  size: 'invisible' | 'normal' = 'invisible',
  onExpired?: () => void
): RecaptchaVerifier {
  const auth = getFirebaseWebAuth();
  if (typeof containerOrId !== 'string' && containerOrId) {
    containerOrId.innerHTML = '';
  }
  return new RecaptchaVerifier(auth, containerOrId, {
    size,
    'expired-callback': () => {
      onExpired?.();
    },
  });
}

export function mapFirebasePhoneAuthError(err: unknown): MappedPhoneAuthError {
  const errObj = err && typeof err === 'object' ? (err as { code?: unknown; message?: unknown }) : null;
  const rawCode = typeof errObj?.code === 'string' ? errObj.code.trim() : '';
  const rawMessage = redactPhoneAuthDiagnostic(
    typeof errObj?.message === 'string'
      ? errObj.message
      : err instanceof Error
        ? err.message
        : ''
  );

  switch (rawCode) {
    case 'auth/invalid-phone-number':
    case 'auth/missing-phone-number':
      return {
        code: rawCode,
        message: 'Please enter a valid mobile number in international format (default India +91).',
        retryable: true,
        resetRecaptcha: false,
      };
    case 'auth/invalid-verification-code':
    case 'auth/missing-verification-code':
      return {
        code: rawCode,
        message: 'That 6-digit verification code is incorrect. Check your SMS and try again.',
        retryable: true,
        resetRecaptcha: false,
      };
    case 'auth/code-expired':
    case 'auth/session-expired':
      return {
        code: rawCode,
        message: 'This verification code has expired. Request a new SMS code to continue.',
        retryable: true,
        resetRecaptcha: true,
      };
    case 'auth/too-many-requests':
      return {
        code: rawCode,
        message:
          'Too many OTP requests or failed verification attempts were made from this device or number. Wait a few minutes and try again.',
        retryable: true,
        resetRecaptcha: true,
      };
    case 'auth/quota-exceeded':
      return {
        code: rawCode,
        message:
          'SMS verification quota has been temporarily reached. Please try again later or sign in using email.',
        retryable: true,
        resetRecaptcha: true,
      };
    case 'auth/captcha-check-failed':
    case 'auth/missing-client-identifier':
    case 'auth/invalid-app-credential':
      return {
        code: rawCode,
        message:
          'Security verification (reCAPTCHA) did not complete. Check that popups/scripts for Google reCAPTCHA are not blocked and try again.',
        retryable: true,
        resetRecaptcha: true,
      };
    case 'auth/network-request-failed':
      return {
        code: rawCode,
        message:
          'Network connection issue while contacting verification services. Check your connection and try again.',
        retryable: true,
        resetRecaptcha: true,
      };
    case 'auth/credential-already-in-use':
    case 'auth/account-exists-with-different-credential':
      return {
        code: rawCode,
        message:
          'This mobile number is already linked to another Sahithi Collections account. Sign out and sign in with that mobile number instead, or verify a different mobile number.',
        retryable: true,
        resetRecaptcha: true,
        suggestDifferentNumber: true,
        suggestSignInWithPhone: true,
      };
    case 'auth/requires-recent-login':
      return {
        code: rawCode,
        message:
          'For your security, please verify your identity again above before linking or replacing your mobile number.',
        retryable: true,
        resetRecaptcha: true,
        requiresRecentLogin: true,
      };
    case 'auth/operation-not-allowed':
      return {
        code: rawCode,
        message:
          'Mobile Phone sign-in is not yet enabled in Firebase Authentication for this project.',
        retryable: false,
        resetRecaptcha: true,
      };
    case 'auth/billing-not-enabled':
      return {
        code: rawCode,
        message:
          'SMS verification requires Firebase Blaze billing to be enabled on this project before sending real SMS codes.',
        retryable: false,
        resetRecaptcha: true,
      };
    case 'auth/unauthorized-domain':
      return {
        code: rawCode,
        message:
          'This website domain is not yet authorized in Firebase Authentication settings for OTP verification.',
        retryable: false,
        resetRecaptcha: true,
      };
    default: {
      if (rawMessage.includes('BILLING_NOT_ENABLED')) {
        return {
          code: 'auth/billing-not-enabled',
          message:
            'SMS verification requires Firebase Blaze billing to be enabled on this project.',
          retryable: false,
          resetRecaptcha: true,
        };
      }
      if (rawMessage.includes('OPERATION_NOT_ALLOWED')) {
        return {
          code: 'auth/operation-not-allowed',
          message:
            'Phone authentication is currently disabled in Firebase Console.',
          retryable: false,
          resetRecaptcha: true,
        };
      }
      return {
        code: rawCode || 'auth/phone-auth-failed',
        message:
          'Unable to complete mobile verification right now. Please check your number and try again.',
        retryable: true,
        resetRecaptcha: true,
      };
    }
  }
}

export async function sendSignInPhoneOtp(
  phoneE164: string,
  verifier: RecaptchaVerifier
): Promise<ConfirmationResult> {
  const auth = getFirebaseWebAuth();
  return signInWithPhoneNumber(auth, phoneE164, verifier);
}

export async function confirmSignInPhoneOtp(
  confirmation: ConfirmationResult,
  otpCode: string
): Promise<FirebaseWebAuthSessionSnapshot> {
  const cred = await confirmation.confirm(otpCode);
  return extractFirebaseWebUserSnapshot(cred.user, true);
}

export async function sendLinkPhoneOtp(
  phoneE164: string,
  verifier: RecaptchaVerifier
): Promise<ConfirmationResult> {
  const user = await waitForFirebaseWebCurrentUser();
  if (!user) {
    throw Object.assign(new Error('Recent login required.'), {
      code: 'auth/requires-recent-login',
    });
  }
  return linkWithPhoneNumber(user, phoneE164, verifier);
}

/**
 * Replaces an existing verified login phone number or links a new one if none is linked.
 * For replacement, verifies the new phone via PhoneAuthProvider + updatePhoneNumber so the
 * existing Firebase UID never changes and non-owned numbers cannot collide silently.
 */
export async function sendReplacePhoneOtp(
  phoneE164: string,
  verifier: RecaptchaVerifier
): Promise<
  | { kind: 'confirmation'; confirmation: ConfirmationResult }
  | { kind: 'verification_id'; verificationId: string }
> {
  const auth = getFirebaseWebAuth();
  const user = await waitForFirebaseWebCurrentUser();
  if (!user) {
    throw Object.assign(new Error('Recent login required.'), {
      code: 'auth/requires-recent-login',
    });
  }
  if (!user.phoneNumber) {
    const confirmation = await linkWithPhoneNumber(user, phoneE164, verifier);
    return { kind: 'confirmation', confirmation };
  }
  const provider = new PhoneAuthProvider(auth);
  const verificationId = await provider.verifyPhoneNumber(phoneE164, verifier);
  return { kind: 'verification_id', verificationId };
}

export async function confirmLinkOrReplacePhoneOtp(params: {
  handle:
    | { kind: 'confirmation'; confirmation: ConfirmationResult }
    | { kind: 'verification_id'; verificationId: string };
  otpCode: string;
}): Promise<FirebaseWebAuthSessionSnapshot> {
  if (params.handle.kind === 'confirmation') {
    const cred = await params.handle.confirmation.confirm(params.otpCode);
    return extractFirebaseWebUserSnapshot(cred.user, true);
  }
  const user = await waitForFirebaseWebCurrentUser();
  if (!user) {
    throw Object.assign(new Error('Recent login required.'), {
      code: 'auth/requires-recent-login',
    });
  }
  const credential = PhoneAuthProvider.credential(
    params.handle.verificationId,
    params.otpCode
  );
  await updatePhoneNumber(user, credential);
  await user.reload().catch(() => undefined);
  return extractFirebaseWebUserSnapshot(user, true);
}

export async function sendReauthPhoneOtp(
  expectedPhoneE164: string,
  verifier: RecaptchaVerifier
): Promise<ConfirmationResult> {
  const user = await waitForFirebaseWebCurrentUser();
  if (!user || !user.phoneNumber) {
    throw Object.assign(
      new Error('Sign in with your verified mobile number to reauthenticate.'),
      { code: 'auth/requires-recent-login' }
    );
  }
  const targetPhone = expectedPhoneE164 || user.phoneNumber;
  return reauthenticateWithPhoneNumber(user, targetPhone, verifier);
}

export async function confirmReauthPhoneOtp(
  confirmation: ConfirmationResult,
  otpCode: string
): Promise<FirebaseWebAuthSessionSnapshot> {
  const cred = await confirmation.confirm(otpCode);
  return extractFirebaseWebUserSnapshot(cred.user, true);
}
