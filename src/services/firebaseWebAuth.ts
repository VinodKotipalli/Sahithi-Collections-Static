import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import firebaseAppletConfig from '../../firebase-applet-config.json';

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
 * with email + password.
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
