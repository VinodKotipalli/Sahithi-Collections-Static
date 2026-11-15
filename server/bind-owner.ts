import 'dotenv/config';
import { createRuntimeStore, ensureConfiguredOwnerBinding } from './runtime-store.ts';

const DEFAULT_OWNER_EMAIL = 'saivinodkotipalli2003@gmail.com';

async function main() {
  const { store, config, diagnostics } = await createRuntimeStore({ seedCatalog: false });
  try {
    const targetEmail = (process.env.ADMIN_OWNER_EMAIL || config.ownerEmail || DEFAULT_OWNER_EMAIL)
      .trim()
      .toLowerCase();
    const forceRebind = process.argv.includes('--force');
    const appUrlHint = config.canonicalAppUrl || 'http://localhost:3000';

    console.log(
      `[admin-setup] Target environment: ${config.targetEnv} (${config.targetEnvSource})`
    );
    console.log(
      `[admin-setup] Database backend: ${store.backend} (persistent=${store.isPersistent}) at ${store.locationLabel}`
    );
    if (store.backend === 'sqlite' && !store.isPersistent) {
      const saLabel =
        diagnostics.runtimeServiceAccountEmail || 'runtime service account';
      console.warn(
        `[admin-setup] Notice: Using container-local SQLite because ADC identity "${saLabel}" lacks roles/datastore.user on project "${diagnostics.firebaseProjectId || 'unknown'}" (${diagnostics.firestoreErrorCode || 'UNAVAILABLE'}).`
      );
    }

    const result = await ensureConfiguredOwnerBinding(store, targetEmail, {
      boundVia: 'server_cli',
      forceRebind,
    });

    if (result.status === 'already_bound') {
      console.log(
        `[admin-setup] Owner access is already persistently bound to verified user ID ${result.binding.owner_user_id} (${targetEmail}).`
      );
      console.log(`[admin-setup] Sign in at ${appUrlHint}/admin/login.`);
      return;
    }

    if (result.status === 'conflict') {
      throw new Error(
        `Conflicting owner binding already exists for user ID ${result.existingUserId}. Stopped without replacing ownership. Inspect before passing --force.`
      );
    }

    if (result.status === 'missing_account') {
      throw new Error(
        `No account exists for ${targetEmail} in ${config.targetEnv} (${store.backend}). Please register at ${appUrlHint}/signup, verify the emailed link, and rerun npm run admin:bind-owner.`
      );
    }

    if (result.status === 'unverified') {
      throw new Error(
        `Account ${targetEmail} exists (id=${result.userId}) in ${config.targetEnv} but email ownership is pending verification. Open the emailed verification link or request a new link at ${appUrlHint}/login before rerunning npm run admin:bind-owner.`
      );
    }

    if (result.status === 'missing_password') {
      throw new Error(
        `Account ${targetEmail} does not have a password configured. Reset or set your password before binding.`
      );
    }

    console.log(
      `[admin-setup] Successfully bound store owner access in "${config.targetEnv}" (${store.backend}) to immutable user ID ${result.binding.owner_user_id} (${result.binding.bound_email}).`
    );
    console.log(
      `[admin-setup] Binding is saved persistently in the database. You can now sign in at ${appUrlHint}/admin/login.`
    );
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(
    '[admin-setup] Failed:',
    err instanceof Error ? err.message : 'Unable to complete owner binding.'
  );
  process.exit(1);
});
