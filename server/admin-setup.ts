import 'dotenv/config';
import readline from 'node:readline';
import { createRuntimeStore, provisionOrResetOwnerAccount } from './runtime-store.ts';

const DEFAULT_OWNER_EMAIL = 'saivinodkotipalli2003@gmail.com';

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return promptLine(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const prevRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(Boolean(prevRaw));
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(Boolean(prevRaw));
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
          }
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const { store, config, diagnostics } = await createRuntimeStore({ seedCatalog: false });
  try {
    const configuredEmail = (
      process.env.ADMIN_OWNER_EMAIL ||
      config.ownerEmail ||
      DEFAULT_OWNER_EMAIL
    )
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
      const saLabel = diagnostics.runtimeServiceAccountEmail || 'runtime service account';
      console.warn(
        `[admin-setup] Notice: Using container-local SQLite because ADC identity "${saLabel}" lacks roles/datastore.user on project "${diagnostics.firebaseProjectId || 'unknown'}" (${diagnostics.firestoreErrorCode || 'UNAVAILABLE'}).`
      );
    }

    let targetEmail = configuredEmail;
    let password = typeof process.env.ADMIN_OWNER_PASSWORD === 'string' ? process.env.ADMIN_OWNER_PASSWORD : '';
    let fullName = (process.env.ADMIN_OWNER_NAME || '').trim();

    if (!password) {
      if (!process.stdin.isTTY) {
        throw new Error(
          'Provide ADMIN_OWNER_PASSWORD in the environment when running non-interactively, or run `npm run admin:setup` in an interactive terminal.'
        );
      }

      const enteredEmail = (
        await promptLine(`Owner email [${configuredEmail}]: `)
      ).trim().toLowerCase();
      if (enteredEmail) {
        targetEmail = enteredEmail;
      }

      const enteredName = (await promptLine('Owner display name [Store Owner]: ')).trim();
      if (enteredName) {
        fullName = enteredName;
      }

      const firstPassword = await promptHidden('Owner password (min 8 characters): ');
      const confirmPassword = await promptHidden('Confirm owner password: ');
      if (firstPassword !== confirmPassword) {
        throw new Error('Passwords did not match. No changes were saved.');
      }
      password = firstPassword;
    }

    const result = await provisionOrResetOwnerAccount(store, {
      email: targetEmail,
      password,
      fullName: fullName || undefined,
      boundVia: 'admin_setup_cli',
      forceRebind,
    });

    if (result.status === 'conflict') {
      throw new Error(
        `An owner account is already bound to user ID ${result.existingUserId} (${result.existingEmail}). Stopped without replacing ownership. Re-run with --force only if intentionally replacing ownership.`
      );
    }

    console.log(
      `[admin-setup] Owner account ${result.status === 'created' ? 'created and bound' : 'password updated and existing sessions revoked'} for ${result.binding.bound_email} (userId=${result.userId}).`
    );
    console.log(`[admin-setup] Sign in at ${appUrlHint}/admin/login`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(
    '[admin-setup] Failed:',
    err instanceof Error ? err.message : 'Unable to complete owner setup.'
  );
  process.exit(1);
});
