import crypto from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { hashPassword } from './crypto.ts';
import { FirestoreBoutiqueStore } from './firestore-store.ts';
import { FirestoreRestStore } from './firebase-rest.ts';
import { resolveRuntimeTarget, type RuntimeTargetConfig } from './env.ts';
import { SqliteBoutiqueStore } from './sqlite-store.ts';
import type { AdminBindingRow, BoutiqueStore } from './store.ts';

export interface CreateRuntimeStoreOptions {
  sqliteOverridePath?: string;
  disableFirestore?: boolean;
  seedCatalog?: boolean;
  verifyConnection?: boolean;
}

export interface RuntimeIdentityInfo {
  runtimeProjectId: string | null;
  runtimeServiceAccountEmail: string | null;
  adcAvailable: boolean;
}

export interface RuntimeDiagnostics {
  runtimeProjectId: string | null;
  runtimeServiceAccountEmail: string | null;
  firebaseProjectId: string | null;
  firestoreDatabaseId: string | null;
  firestoreNamespace: string;
  credentialSource: RuntimeTargetConfig['credentialSource'];
  firestoreReachable: boolean;
  firestoreErrorCode: string | null;
  firestoreErrorMessage: string | null;
  activeBackend: 'firestore' | 'sqlite';
  authMode: 'local' | 'firebase_managed';
}

async function fetchMetadataText(path: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function inspectRuntimeIdentity(
  env: NodeJS.ProcessEnv = process.env
): Promise<RuntimeIdentityInfo> {
  const envEmail = (env.AUTHORIZED_SERVICE_ACCOUNT_EMAIL || '').trim() || null;
  const envProject =
    (env.GOOGLE_CLOUD_PROJECT || env.GCP_PROJECT || env.GCLOUD_PROJECT || '').trim() || null;

  let runtimeProjectId = envProject;
  let runtimeServiceAccountEmail = envEmail;
  let adcAvailable = false;

  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/datastore'] });
    const [detectedProject, creds] = await Promise.all([
      auth.getProjectId().catch(() => null),
      auth.getCredentials().catch(() => null),
    ]);
    if (!runtimeProjectId && detectedProject) {
      runtimeProjectId = detectedProject;
    }
    const credEmail =
      creds && typeof (creds as { client_email?: unknown }).client_email === 'string'
        ? (creds as { client_email: string }).client_email.trim()
        : '';
    if (!runtimeServiceAccountEmail && credEmail) {
      runtimeServiceAccountEmail = credEmail;
    }
    if (credEmail || detectedProject) {
      adcAvailable = true;
    }
  } catch {
    // ADC unavailable in this environment
  }

  if (!runtimeServiceAccountEmail || !runtimeProjectId) {
    const [metaEmail, metaProject] = await Promise.all([
      runtimeServiceAccountEmail
        ? Promise.resolve(runtimeServiceAccountEmail)
        : fetchMetadataText('instance/service-accounts/default/email'),
      runtimeProjectId
        ? Promise.resolve(runtimeProjectId)
        : fetchMetadataText('project/project-id'),
    ]);
    if (!runtimeServiceAccountEmail && metaEmail) {
      runtimeServiceAccountEmail = metaEmail;
      adcAvailable = true;
    }
    if (!runtimeProjectId && metaProject) {
      runtimeProjectId = metaProject;
    }
  }

  return {
    runtimeProjectId,
    runtimeServiceAccountEmail,
    adcAvailable,
  };
}

function extractGrpcErrorInfo(err: unknown): { code: string | null; message: string } {
  const obj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  const rawCode = obj?.code;
  const code =
    typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : null;
  const message = err instanceof Error ? err.message : String(err);
  return { code, message };
}

export async function createRuntimeStore(
  options: CreateRuntimeStoreOptions = {}
): Promise<{
  store: BoutiqueStore;
  config: RuntimeTargetConfig;
  diagnostics: RuntimeDiagnostics;
}> {
  const config = resolveRuntimeTarget(process.env, {
    sqliteOverridePath: options.sqliteOverridePath,
    disableFirestore: options.disableFirestore,
  });

  const canAttemptFirestoreWithExplicitCreds = Boolean(
    !options.sqliteOverridePath &&
      !options.disableFirestore &&
      config.firebaseConfig &&
      config.hasExplicitFirestoreCredentials
  );
  const canAttemptFirestoreWithAdc = Boolean(
    !options.sqliteOverridePath &&
      !options.disableFirestore &&
      config.firebaseConfig &&
      !config.hasExplicitFirestoreCredentials &&
      config.credentialSource === 'application_default_credentials'
  );

  const runtimeIdentity =
    canAttemptFirestoreWithAdc || config.credentialSource === 'application_default_credentials'
      ? await inspectRuntimeIdentity()
      : {
          runtimeProjectId:
            (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '').trim() || null,
          runtimeServiceAccountEmail:
            (process.env.AUTHORIZED_SERVICE_ACCOUNT_EMAIL || '').trim() || null,
          adcAvailable: false,
        };

  let firestoreErrorCode: string | null = null;
  let firestoreErrorMessage: string | null = null;

  if ((canAttemptFirestoreWithExplicitCreds || canAttemptFirestoreWithAdc) && config.firebaseConfig) {
    const store = new FirestoreBoutiqueStore({
      config: config.firebaseConfig,
      namespace: config.firestoreNamespace,
      targetEnv: config.targetEnv,
    });

    if (canAttemptFirestoreWithExplicitCreds) {
      if (options.verifyConnection !== false) {
        try {
          await store.verifyConnectivity();
        } catch (err) {
          const info = extractGrpcErrorInfo(err);
          await store.close();
          throw new Error(
            `Unable to access Cloud Firestore project "${config.firebaseConfig.projectId}" (database "${config.firebaseConfig.firestoreDatabaseId}") for target "${config.targetEnv}": ${info.message}. Verify the configured service-account credentials have Cloud Datastore User permissions on project ${config.firebaseConfig.projectId}.`
          );
        }
      }

      if (options.seedCatalog !== false) {
        await store.seedInitialCatalogIfEmpty();
      }
      return {
        store,
        config,
        diagnostics: {
          runtimeProjectId: runtimeIdentity.runtimeProjectId,
          runtimeServiceAccountEmail: runtimeIdentity.runtimeServiceAccountEmail,
          firebaseProjectId: config.firebaseConfig.projectId,
          firestoreDatabaseId: config.firebaseConfig.firestoreDatabaseId,
          firestoreNamespace: config.firestoreNamespace,
          credentialSource: config.credentialSource,
          firestoreReachable: true,
          firestoreErrorCode: null,
          firestoreErrorMessage: null,
          activeBackend: 'firestore',
          authMode: 'local',
        },
      };
    }

    // Attempt passwordless server-side Application Default Credentials (runtime service identity).
    // If IAM permissions on the target Firebase project are not yet granted, switch seamlessly
    // to Firestore REST + Firebase Auth (zero manual IAM configuration required).
    try {
      await store.verifyConnectivity();
      if (options.seedCatalog !== false) {
        await store.seedInitialCatalogIfEmpty();
      }
      return {
        store,
        config: {
          ...config,
          storageBackend: 'firestore',
          isPersistentDatabase: true,
        },
        diagnostics: {
          runtimeProjectId: runtimeIdentity.runtimeProjectId,
          runtimeServiceAccountEmail: runtimeIdentity.runtimeServiceAccountEmail,
          firebaseProjectId: config.firebaseConfig.projectId,
          firestoreDatabaseId: config.firebaseConfig.firestoreDatabaseId,
          firestoreNamespace: config.firestoreNamespace,
          credentialSource: 'application_default_credentials',
          firestoreReachable: true,
          firestoreErrorCode: null,
          firestoreErrorMessage: null,
          activeBackend: 'firestore',
          authMode: 'local',
        },
      };
    } catch (err) {
      const info = extractGrpcErrorInfo(err);
      firestoreErrorCode = info.code;
      firestoreErrorMessage = info.message;
      await store.close();
    }
  }

  if (!options.sqliteOverridePath && !options.disableFirestore && config.firebaseConfig?.apiKey) {
    const restStore = new FirestoreRestStore({
      config: {
        ...config.firebaseConfig,
        apiKey: config.firebaseConfig.apiKey,
      },
      namespace: config.firestoreNamespace,
      targetEnv: config.targetEnv,
      ownerEmail: config.ownerEmail,
    });
    try {
      await restStore.verifyConnectivity();
      return {
        store: restStore,
        config: {
          ...config,
          storageBackend: 'firestore',
          isPersistentDatabase: true,
        },
        diagnostics: {
          runtimeProjectId: runtimeIdentity.runtimeProjectId,
          runtimeServiceAccountEmail: runtimeIdentity.runtimeServiceAccountEmail,
          firebaseProjectId: config.firebaseConfig.projectId,
          firestoreDatabaseId: config.firebaseConfig.firestoreDatabaseId,
          firestoreNamespace: config.firestoreNamespace,
          credentialSource: config.credentialSource,
          firestoreReachable: true,
          firestoreErrorCode: null,
          firestoreErrorMessage: null,
          activeBackend: 'firestore',
          authMode: 'firebase_managed',
        },
      };
    } catch (restErr) {
      const restInfo = extractGrpcErrorInfo(restErr);
      firestoreErrorCode = restInfo.code || firestoreErrorCode;
      firestoreErrorMessage = restInfo.message || firestoreErrorMessage;
      console.warn(
        `[sahithi] Firestore REST connectivity check failed for project "${config.firebaseConfig.projectId}" database "${config.firebaseConfig.firestoreDatabaseId}": ${restInfo.message}`
      );
    }
  }

  const kService = (process.env.K_SERVICE || '').trim();
  if (kService && !options.sqliteOverridePath && !options.disableFirestore) {
    throw new Error(
      `Persistent Firestore database (${config.firebaseConfig?.projectId || 'unknown'}/${config.firebaseConfig?.firestoreDatabaseId || 'unknown'}) could not be reached from Cloud Run service "${kService}" (${firestoreErrorMessage || 'connectivity error'}). Refusing to fall back to ephemeral container SQLite.`
    );
  }

  const fallbackConfig: RuntimeTargetConfig = {
    ...config,
    storageBackend: 'sqlite',
    isPersistentDatabase: config.sqliteDbPath !== ':memory:' && !Boolean(kService),
  };

  const store = new SqliteBoutiqueStore({
    dbPath: fallbackConfig.sqliteDbPath,
    targetEnv: fallbackConfig.targetEnv,
    seedCatalog: options.seedCatalog,
    isPersistent: fallbackConfig.isPersistentDatabase,
  });

  return {
    store,
    config: fallbackConfig,
    diagnostics: {
      runtimeProjectId: runtimeIdentity.runtimeProjectId,
      runtimeServiceAccountEmail: runtimeIdentity.runtimeServiceAccountEmail,
      firebaseProjectId: config.firebaseConfig?.projectId || null,
      firestoreDatabaseId: config.firebaseConfig?.firestoreDatabaseId || null,
      firestoreNamespace: config.firestoreNamespace,
      credentialSource: config.credentialSource,
      firestoreReachable: false,
      firestoreErrorCode,
      firestoreErrorMessage,
      activeBackend: 'sqlite',
      authMode: 'local',
    },
  };
}

export type OwnerBindingResolution =
  | { status: 'bound'; binding: AdminBindingRow }
  | { status: 'already_bound'; binding: AdminBindingRow }
  | { status: 'missing_account'; email: string }
  | { status: 'unverified'; email: string; userId: string }
  | { status: 'missing_password'; email: string; userId: string }
  | { status: 'conflict'; email: string; existingUserId: string; existingEmail: string };

/**
 * Resolves the configured ADMIN_OWNER_EMAIL to an existing verified user account
 * and persists its immutable user ID as the owner idempotently.
 * Never bypasses email verification, never auto-creates an account, and never
 * silently replaces an existing owner binding (including if the owner account was recreated).
 */
export async function ensureConfiguredOwnerBinding(
  store: BoutiqueStore,
  ownerEmail: string,
  options: { boundVia?: string; forceRebind?: boolean } = {}
): Promise<OwnerBindingResolution> {
  const targetEmail = ownerEmail.trim().toLowerCase();
  const storedBinding = await store.getStoredAdminBinding();
  const targetUser = await store.getUserByEmail(targetEmail);

  if (storedBinding && !options.forceRebind) {
    if (
      targetUser &&
      storedBinding.owner_user_id === targetUser.id &&
      Boolean(targetUser.email_verified)
    ) {
      return { status: 'already_bound', binding: storedBinding };
    }
    return {
      status: 'conflict',
      email: targetEmail,
      existingUserId: storedBinding.owner_user_id,
      existingEmail: storedBinding.bound_email,
    };
  }

  if (!targetUser) {
    return { status: 'missing_account', email: targetEmail };
  }
  if (!targetUser.email_verified) {
    return { status: 'unverified', email: targetEmail, userId: targetUser.id };
  }
  if (!targetUser.password_hash) {
    return { status: 'missing_password', email: targetEmail, userId: targetUser.id };
  }

  const binding = await store.bindOwnerAccount({
    email: targetEmail,
    boundVia: options.boundVia || 'server_startup',
    forceRebind: options.forceRebind,
  });
  return { status: 'bound', binding };
}

export type OwnerProvisionResult =
  | { status: 'created'; binding: AdminBindingRow; userId: string }
  | { status: 'updated'; binding: AdminBindingRow; userId: string }
  | { status: 'conflict'; email: string; existingUserId: string; existingEmail: string };

const OWNER_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates or updates the single store-owner account and binds ownership idempotently
 * without requiring SMTP email verification. Intended strictly for private server CLI
 * (`npm run admin:setup`) or server-side hosting secret bootstrap (`ADMIN_OWNER_PASSWORD`).
 */
export async function provisionOrResetOwnerAccount(
  store: BoutiqueStore,
  params: {
    email: string;
    password: string;
    fullName?: string;
    boundVia?: string;
    forceRebind?: boolean;
  }
): Promise<OwnerProvisionResult> {
  const targetEmail = params.email.trim().toLowerCase();
  if (!OWNER_EMAIL_REGEX.test(targetEmail)) {
    throw new Error('Please provide a valid owner email address.');
  }
  if (params.password.length < 8 || params.password.length > 128) {
    throw new Error('Owner password must be between 8 and 128 characters.');
  }

  const storedBinding = await store.getStoredAdminBinding();
  const existingUser = await store.getUserByEmail(targetEmail);

  if (storedBinding && !params.forceRebind) {
    if (!existingUser || storedBinding.owner_user_id !== existingUser.id) {
      return {
        status: 'conflict',
        email: targetEmail,
        existingUserId: storedBinding.owner_user_id,
        existingEmail: storedBinding.bound_email,
      };
    }
  }

  const now = Date.now();
  const passwordHash = await hashPassword(params.password);
  const boundVia = params.boundVia || 'admin_setup';

  if (!existingUser) {
    const userId = crypto.randomUUID();
    const displayName = (params.fullName || '').trim() || 'Store Owner';
    await store.createPendingEmailUser({
      id: userId,
      fullName: displayName,
      email: targetEmail,
      passwordHash,
      now,
    });
    await store.markUserEmailVerified(userId, now);
    const binding = await store.bindOwnerAccount({
      email: targetEmail,
      boundVia,
      forceRebind: params.forceRebind,
    });
    return { status: 'created', binding, userId };
  }

  await store.updateUserPasswordHash(existingUser.id, passwordHash, now);
  if (!existingUser.email_verified) {
    await store.markUserEmailVerified(existingUser.id, now);
  }
  if (params.fullName && params.fullName.trim().length >= 2) {
    await store.updateUserFullName(existingUser.id, params.fullName.trim(), now);
  }
  await store.revokeUserSessions(existingUser.id, now);

  const binding = await store.bindOwnerAccount({
    email: targetEmail,
    boundVia,
    forceRebind: params.forceRebind,
  });
  return { status: 'updated', binding, userId: existingUser.id };
}

export type BootstrapOwnerEnvResult =
  | { mode: 'already_configured'; binding: AdminBindingRow }
  | { mode: 'provisioned'; result: OwnerProvisionResult }
  | { mode: 'invalid_password'; email: string; reason: string }
  | { mode: 'binding_only'; result: OwnerBindingResolution }
  | { mode: 'firebase_managed'; email: string };

/**
 * Bootstraps owner access at server startup.
 * - When using FirestoreRestStore (firebase_managed mode), owner verification and binding happen
 *   through Firebase Auth + Firestore Security Rules with zero manual IAM or secrets.
 * - Otherwise, if ADMIN_OWNER_PASSWORD is set in server secrets and the owner is not yet configured
 *   (or ADMIN_OWNER_PASSWORD_RESET=true), hashes the password with bcrypt and binds the owner.
 * - Otherwise, falls back to idempotent verified-account owner binding.
 */
export async function bootstrapOwnerFromEnv(
  store: BoutiqueStore,
  ownerEmail: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<BootstrapOwnerEnvResult> {
  const targetEmail = ownerEmail.trim().toLowerCase();
  if (store instanceof FirestoreRestStore) {
    return { mode: 'firebase_managed', email: targetEmail };
  }
  const envPassword = typeof env.ADMIN_OWNER_PASSWORD === 'string' ? env.ADMIN_OWNER_PASSWORD : '';
  const resetRequested =
    (env.ADMIN_OWNER_PASSWORD_RESET || '').trim().toLowerCase() === 'true';

  if (!envPassword) {
    const result = await ensureConfiguredOwnerBinding(store, targetEmail, {
      boundVia: 'server_startup',
    });
    return { mode: 'binding_only', result };
  }

  if (envPassword.length < 8 || envPassword.length > 128) {
    return {
      mode: 'invalid_password',
      email: targetEmail,
      reason: 'ADMIN_OWNER_PASSWORD must be between 8 and 128 characters.',
    };
  }

  const storedBinding = await store.getStoredAdminBinding();
  const existingUser = await store.getUserByEmail(targetEmail);

  if (
    storedBinding &&
    existingUser &&
    storedBinding.owner_user_id === existingUser.id &&
    Boolean(existingUser.email_verified) &&
    Boolean(existingUser.password_hash) &&
    !resetRequested
  ) {
    return { mode: 'already_configured', binding: storedBinding };
  }

  const result = await provisionOrResetOwnerAccount(store, {
    email: targetEmail,
    password: envPassword,
    boundVia: resetRequested ? 'env_secret_reset' : 'env_secret_bootstrap',
  });
  return { mode: 'provisioned', result };
}

