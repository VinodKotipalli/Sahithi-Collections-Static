import fs from 'node:fs';
import path from 'node:path';

export type RuntimeTargetEnv = 'development' | 'shared-preview' | 'production';
export type StorageBackend = 'firestore' | 'sqlite';

export interface FirebaseAppletConfig {
  projectId: string;
  appId?: string;
  apiKey?: string;
  authDomain?: string;
  firestoreDatabaseId: string;
  storageBucket?: string;
}

export interface RuntimeTargetConfig {
  targetEnv: RuntimeTargetEnv;
  targetEnvSource: string;
  firestoreNamespace: string;
  canonicalAppUrl: string;
  ownerEmail: string;
  sqliteDbPath: string;
  firebaseConfig: FirebaseAppletConfig | null;
  credentialSource:
    | 'service_account_json'
    | 'google_application_credentials'
    | 'application_default_credentials'
    | 'none';
  hasExplicitFirestoreCredentials: boolean;
  storageBackend: StorageBackend;
  isPersistentDatabase: boolean;
}

const FIREBASE_CONFIG_CANDIDATES = [
  path.resolve(process.cwd(), 'firebase-applet-config.json'),
];

export function loadFirebaseAppletConfig(): FirebaseAppletConfig | null {
  for (const candidate of FIREBASE_CONFIG_CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Partial<FirebaseAppletConfig>;
      if (parsed.projectId && parsed.firestoreDatabaseId) {
        return {
          projectId: String(parsed.projectId).trim(),
          appId: parsed.appId ? String(parsed.appId).trim() : undefined,
          apiKey: parsed.apiKey ? String(parsed.apiKey).trim() : undefined,
          authDomain: parsed.authDomain ? String(parsed.authDomain).trim() : undefined,
          firestoreDatabaseId: String(parsed.firestoreDatabaseId).trim(),
          storageBucket: parsed.storageBucket ? String(parsed.storageBucket).trim() : undefined,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function sanitizeNamespace(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'development';
}

export function normalizeCanonicalAppUrl(raw?: string | null): string {
  const value = (raw || '').trim();
  if (!value || value.includes('MY_APP_URL')) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

export function resolveRuntimeTarget(
  env: NodeJS.ProcessEnv = process.env,
  options: { sqliteOverridePath?: string; disableFirestore?: boolean } = {}
): RuntimeTargetConfig {
  const explicitTarget = (env.SAHITHI_TARGET_ENV || '').trim().toLowerCase();
  const kService = (env.K_SERVICE || '').trim().toLowerCase();
  const canonicalAppUrl = normalizeCanonicalAppUrl(env.APP_URL);
  const appUrlLower = canonicalAppUrl.toLowerCase();

  let targetEnv: RuntimeTargetEnv;
  let targetEnvSource: string;

  if (
    explicitTarget === 'development' ||
    explicitTarget === 'shared-preview' ||
    explicitTarget === 'production'
  ) {
    targetEnv = explicitTarget;
    targetEnvSource = 'SAHITHI_TARGET_ENV';
  } else if (kService.startsWith('ais-pre-') || appUrlLower.includes('ais-pre-')) {
    targetEnv = 'shared-preview';
    targetEnvSource = kService.startsWith('ais-pre-') ? 'K_SERVICE(ais-pre-*)' : 'APP_URL(ais-pre-*)';
  } else if (kService.startsWith('ais-dev-') || appUrlLower.includes('ais-dev-')) {
    targetEnv = 'development';
    targetEnvSource = kService.startsWith('ais-dev-') ? 'K_SERVICE(ais-dev-*)' : 'APP_URL(ais-dev-*)';
  } else if ((env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    targetEnv = 'production';
    targetEnvSource = 'NODE_ENV=production';
  } else {
    targetEnv = 'development';
    targetEnvSource = 'default(development)';
  }

  const firestoreNamespace = sanitizeNamespace(
    env.SAHITHI_FIRESTORE_NAMESPACE || targetEnv
  );

  const ownerEmail = (env.ADMIN_OWNER_EMAIL || 'saivinodkotipalli2003@gmail.com')
    .trim()
    .toLowerCase();
  const sqliteDbPath = (
    options.sqliteOverridePath ||
    env.AUTH_DB_PATH ||
    './data/sahithi_auth.db'
  ).trim();

  const firebaseConfig = options.disableFirestore ? null : loadFirebaseAppletConfig();

  const hasServiceAccountJson = Boolean((env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim());
  const gacPath = (env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  const hasGacFile = Boolean(gacPath && fs.existsSync(gacPath));
  const localGcloudAdcPath = path.join(
    env.HOME || '',
    '.config',
    'gcloud',
    'application_default_credentials.json'
  );
  const hasLocalGcloudAdc = Boolean(env.HOME && fs.existsSync(localGcloudAdcPath));
  const hasRuntimeIdentity = Boolean(
    (env.AUTHORIZED_SERVICE_ACCOUNT_EMAIL || '').trim() ||
      kService ||
      (env.K_REVISION || '').trim() ||
      (env.GOOGLE_CLOUD_PROJECT || '').trim() ||
      (env.GCP_PROJECT || '').trim() ||
      (env.GCLOUD_PROJECT || '').trim() ||
      (env.FIRESTORE_EMULATOR_HOST || '').trim() ||
      hasLocalGcloudAdc
  );

  let credentialSource: RuntimeTargetConfig['credentialSource'] = 'none';
  if (hasServiceAccountJson) {
    credentialSource = 'service_account_json';
  } else if (hasGacFile) {
    credentialSource = 'google_application_credentials';
  } else if (hasRuntimeIdentity) {
    credentialSource = 'application_default_credentials';
  }

  const hasExplicitFirestoreCredentials = hasServiceAccountJson || hasGacFile;
  const useFirestore = Boolean(
    !options.sqliteOverridePath &&
      !options.disableFirestore &&
      firebaseConfig &&
      credentialSource !== 'none'
  );

  const storageBackend: StorageBackend = useFirestore ? 'firestore' : 'sqlite';
  const isPersistentDatabase =
    storageBackend === 'firestore' || (sqliteDbPath !== ':memory:' && !Boolean(kService));

  return {
    targetEnv,
    targetEnvSource,
    firestoreNamespace,
    canonicalAppUrl,
    ownerEmail,
    sqliteDbPath,
    firebaseConfig,
    credentialSource,
    hasExplicitFirestoreCredentials,
    storageBackend,
    isPersistentDatabase,
  };
}
