import 'dotenv/config';
import { createRuntimeStore } from './runtime-store.ts';

async function main() {
  const { store, config, diagnostics } = await createRuntimeStore({ seedCatalog: false });
  try {
    const ownerEmail = config.ownerEmail;
    const ownerUser =
      diagnostics.authMode === 'firebase_managed'
        ? null
        : await store.getUserByEmail(ownerEmail);
    const boundOwner =
      diagnostics.authMode === 'firebase_managed'
        ? null
        : await store.resolveBoundOwner();

    console.log(
      JSON.stringify(
        {
          targetEnv: config.targetEnv,
          targetEnvSource: config.targetEnvSource,
          canonicalAppUrl: config.canonicalAppUrl || null,
          runtimeProjectId: diagnostics.runtimeProjectId,
          runtimeServiceAccountEmail: diagnostics.runtimeServiceAccountEmail,
          firebaseProjectId: diagnostics.firebaseProjectId,
          firestoreDatabaseId: diagnostics.firestoreDatabaseId,
          firestoreNamespace: diagnostics.firestoreNamespace,
          credentialSource: diagnostics.credentialSource,
          authMode: diagnostics.authMode,
          firestoreReachable: diagnostics.firestoreReachable,
          firestoreErrorCode: diagnostics.firestoreErrorCode,
          firestoreErrorMessage: diagnostics.firestoreErrorMessage,
          activeBackend: diagnostics.activeBackend,
          persistentDatabase: store.isPersistent,
          ownerEmail,
          ownerAccountExists:
            diagnostics.authMode === 'firebase_managed'
              ? 'verified-via-firebase-auth-on-login'
              : Boolean(ownerUser),
          ownerAccountVerified:
            diagnostics.authMode === 'firebase_managed'
              ? 'enforced-by-firestore-rules'
              : Boolean(ownerUser?.email_verified),
          ownerBindingConfigured:
            diagnostics.authMode === 'firebase_managed'
              ? 'auto-bound-on-verified-owner-login'
              : Boolean(boundOwner),
        },
        null,
        2
      )
    );
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error('[db-check] Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
