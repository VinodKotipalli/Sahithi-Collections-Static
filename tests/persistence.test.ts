import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import { createAuthApp } from '../server/app.ts';
import { initAuthDatabase } from '../server/db.ts';
import { resolveRuntimeTarget } from '../server/env.ts';
import { FirestoreBoutiqueStore } from '../server/firestore-store.ts';
import { backupAndMigrateSqliteToFirestore } from '../server/migrate.ts';
import {
  bootstrapOwnerFromEnv,
  ensureConfiguredOwnerBinding,
  provisionOrResetOwnerAccount,
} from '../server/runtime-store.ts';
import { SqliteBoutiqueStore } from '../server/sqlite-store.ts';
import type { EmailMessage, EmailSender } from '../server/providers.ts';

class FakeDocSnapshot {
  constructor(
    readonly id: string,
    readonly ref: FakeDocRef,
    private readonly raw: Record<string, unknown> | undefined
  ) {}

  get exists(): boolean {
    return this.raw !== undefined;
  }

  data(): Record<string, unknown> | undefined {
    return this.raw ? structuredClone(this.raw) : undefined;
  }
}

class FakeQuerySnapshot {
  constructor(readonly docs: FakeDocSnapshot[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
}

type WhereClause = { field: string; op: '==' | '!=' | 'array-contains'; value: unknown };

class FakeQuery {
  constructor(
    protected readonly mem: Map<string, Record<string, unknown>>,
    protected readonly prefix: string,
    private readonly wheres: WhereClause[] = [],
    private readonly limitVal?: number
  ) {}

  where(field: string, op: '==' | '!=' | 'array-contains', value: unknown): FakeQuery {
    return new FakeQuery(this.mem, this.prefix, [...this.wheres, { field, op, value }], this.limitVal);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.mem, this.prefix, this.wheres, n);
  }

  async get(): Promise<FakeQuerySnapshot> {
    const matched: FakeDocSnapshot[] = [];
    for (const [docPath, data] of this.mem.entries()) {
      if (!docPath.startsWith(this.prefix)) continue;
      const rest = docPath.slice(this.prefix.length);
      if (rest.includes('/')) continue; // direct children only

      let ok = true;
      for (const w of this.wheres) {
        const fieldVal = data[w.field];
        if (w.op === '==') {
          if (fieldVal !== w.value) {
            ok = false;
            break;
          }
        } else if (w.op === '!=') {
          if (fieldVal === w.value || fieldVal === undefined) {
            ok = false;
            break;
          }
        } else if (w.op === 'array-contains') {
          if (!Array.isArray(fieldVal) || !fieldVal.includes(w.value)) {
            ok = false;
            break;
          }
        }
      }

      if (ok) {
        matched.push(new FakeDocSnapshot(rest, new FakeDocRef(this.mem, docPath), data));
        if (this.limitVal !== undefined && matched.length >= this.limitVal) {
          break;
        }
      }
    }
    return new FakeQuerySnapshot(matched);
  }
}

class FakeCollectionRef extends FakeQuery {
  constructor(mem: Map<string, Record<string, unknown>>, readonly pathStr: string) {
    super(mem, `${pathStr}/`);
  }

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.mem, `${this.pathStr}/${id}`);
  }
}

class FakeDocRef {
  constructor(
    private readonly mem: Map<string, Record<string, unknown>>,
    readonly path: string
  ) {}

  get id(): string {
    const idx = this.path.lastIndexOf('/');
    return idx === -1 ? this.path : this.path.slice(idx + 1);
  }

  collection(subName: string): FakeCollectionRef {
    return new FakeCollectionRef(this.mem, `${this.path}/${subName}`);
  }

  async get(): Promise<FakeDocSnapshot> {
    return new FakeDocSnapshot(this.id, this, this.mem.get(this.path));
  }

  async set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<void> {
    if (options?.merge && this.mem.has(this.path)) {
      this.mem.set(this.path, { ...this.mem.get(this.path)!, ...structuredClone(data) });
    } else {
      this.mem.set(this.path, structuredClone(data));
    }
  }

  async create(data: Record<string, unknown>): Promise<void> {
    if (this.mem.has(this.path)) {
      const err = new Error(`6 ALREADY_EXISTS: Document ${this.path} already exists.`);
      Object.assign(err, { code: 6 });
      throw err;
    }
    this.mem.set(this.path, structuredClone(data));
  }

  async update(patch: Record<string, unknown>): Promise<void> {
    const existing = this.mem.get(this.path);
    if (!existing) throw new Error(`NOT_FOUND: ${this.path}`);
    this.mem.set(this.path, { ...existing, ...structuredClone(patch) });
  }

  async delete(): Promise<void> {
    this.mem.delete(this.path);
  }
}

function createInMemoryFirestore(): Firestore {
  const mem = new Map<string, Record<string, unknown>>();
  const fake = {
    collection(name: string) {
      return new FakeCollectionRef(mem, name);
    },
    batch() {
      const ops: Array<() => Promise<void>> = [];
      return {
        set(ref: FakeDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) {
          ops.push(() => ref.set(data, options));
        },
        create(ref: FakeDocRef, data: Record<string, unknown>) {
          ops.push(() => ref.create(data));
        },
        update(ref: FakeDocRef, patch: Record<string, unknown>) {
          ops.push(() => ref.update(patch));
        },
        delete(ref: FakeDocRef) {
          ops.push(() => ref.delete());
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const txOps: Array<() => Promise<void>> = [];
      const tx = {
        get(refOrQuery: FakeDocRef | FakeQuery) {
          return refOrQuery.get();
        },
        set(ref: FakeDocRef, data: Record<string, unknown>) {
          txOps.push(() => ref.set(data));
        },
        update(ref: FakeDocRef, patch: Record<string, unknown>) {
          txOps.push(() => ref.update(patch));
        },
        delete(ref: FakeDocRef) {
          txOps.push(() => ref.delete());
        },
      };
      const result = await fn(tx);
      for (const op of txOps) await op();
      return result;
    },
  };
  return fake as unknown as Firestore;
}

function extractToken(htmlOrText: string): string {
  const match = htmlOrText.match(/[?&]token=([^"&\s<]+)/);
  assert.ok(match, 'Expected token query param in email');
  return decodeURIComponent(match[1]);
}

function extractUrl(htmlOrText: string): string {
  const match = htmlOrText.match(/https?:\/\/[^\s"<]+/);
  assert.ok(match, 'Expected URL in email');
  return match[0];
}

test('resolveRuntimeTarget cleanly isolates development, shared-preview, and production environments and supports ADC without FIREBASE_SERVICE_ACCOUNT_JSON', () => {
  const devCfg = resolveRuntimeTarget({
    NODE_ENV: 'development',
    K_SERVICE: 'ais-dev-he6gvzowfyhzbcmqd65c7h',
    APP_URL: 'https://ais-dev-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app',
  });
  assert.equal(devCfg.targetEnv, 'development');
  assert.equal(devCfg.firestoreNamespace, 'development');
  assert.equal(devCfg.credentialSource, 'application_default_credentials');
  assert.equal(devCfg.hasExplicitFirestoreCredentials, false);
  assert.equal(devCfg.storageBackend, 'firestore');
  assert.equal(
    devCfg.canonicalAppUrl,
    'https://ais-dev-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app'
  );

  const previewCfg = resolveRuntimeTarget({
    NODE_ENV: 'production',
    K_SERVICE: 'ais-pre-he6gvzowfyhzbcmqd65c7h',
    APP_URL: 'https://ais-pre-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app/ignored',
  });
  assert.equal(previewCfg.targetEnv, 'shared-preview');
  assert.equal(previewCfg.firestoreNamespace, 'shared-preview');
  assert.equal(previewCfg.credentialSource, 'application_default_credentials');
  assert.equal(previewCfg.storageBackend, 'firestore');
  assert.equal(
    previewCfg.canonicalAppUrl,
    'https://ais-pre-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app'
  );

  const gcpProdCfg = resolveRuntimeTarget({
    NODE_ENV: 'production',
    GOOGLE_CLOUD_PROJECT: 'celtic-pattern-fmln4',
    APP_URL: 'https://sahithicollections.com',
  });
  assert.equal(gcpProdCfg.targetEnv, 'production');
  assert.equal(gcpProdCfg.firestoreNamespace, 'production');
  assert.equal(gcpProdCfg.credentialSource, 'application_default_credentials');
  assert.equal(gcpProdCfg.storageBackend, 'firestore');
  assert.equal(gcpProdCfg.isPersistentDatabase, true);

  const prodCfg = resolveRuntimeTarget({
    NODE_ENV: 'production',
    SAHITHI_TARGET_ENV: 'production',
    APP_URL: 'https://sahithicollections.com',
    FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"demo","client_email":"a@b","private_key":"k"}',
  });
  assert.equal(prodCfg.targetEnv, 'production');
  assert.equal(prodCfg.firestoreNamespace, 'production');
  assert.equal(prodCfg.credentialSource, 'service_account_json');
  assert.equal(prodCfg.storageBackend, 'firestore');
  assert.equal(prodCfg.isPersistentDatabase, true);
  assert.notEqual(devCfg.firestoreNamespace, prodCfg.firestoreNamespace);
  assert.notEqual(devCfg.firestoreNamespace, previewCfg.firestoreNamespace);
});

test('FirestoreBoutiqueStore supports persistent registration, canonical URL verification, idempotent owner binding, conflict guard, and environment isolation', async () => {
  const sharedFirestore = createInMemoryFirestore();
  const config = {
    projectId: 'celtic-pattern-fmln4',
    firestoreDatabaseId: 'test-db',
  };

  const devStore = new FirestoreBoutiqueStore({
    config,
    namespace: 'development',
    targetEnv: 'development',
    firestoreOverride: sharedFirestore,
  });
  await devStore.seedInitialCatalogIfEmpty();

  const previewStore = new FirestoreBoutiqueStore({
    config,
    namespace: 'shared-preview',
    targetEnv: 'shared-preview',
    firestoreOverride: sharedFirestore,
  });
  await previewStore.seedInitialCatalogIfEmpty();

  const sentEmails: EmailMessage[] = [];
  const emailSender: EmailSender = {
    isConfigured: () => true,
    sendEmail: async (m) => {
      sentEmails.push(m);
    },
  };

  const previewUrlCanonical =
    'https://ais-pre-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app';
  const appWrapper = createAuthApp({
    store: previewStore,
    emailSender,
    disableRateLimit: true,
    appBaseUrl: previewUrlCanonical,
  });

  const server = http.createServer(appWrapper.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Capabilities report environmentTarget & firestore backend cleanly without leaking PII
    const capsRes = await fetch(`${baseUrl}/api/auth/capabilities`);
    assert.equal(capsRes.status, 200);
    const caps = (await capsRes.json()) as Record<string, unknown>;
    assert.equal(caps.environmentTarget, 'shared-preview');
    assert.equal(caps.databaseBackend, 'firestore');
    assert.equal(caps.persistentDatabase, true);
    assert.equal(caps.ownerBindingConfigured, false);

    // 2. Register unrelated verified non-owner account
    const bootRes1 = await fetch(`${baseUrl}/api/auth/session`);
    const cookie1 = bootRes1.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const { csrfToken: csrf1 } = (await bootRes1.json()) as { csrfToken: string };

    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie1,
        'X-CSRF-Token': csrf1,
      },
      body: JSON.stringify({
        fullName: 'Existing Customer',
        email: 'customer.other@example.com',
        password: 'CustomerPassword!2026',
        confirmPassword: 'CustomerPassword!2026',
      }),
    });
    const custToken = extractToken(sentEmails[0].text);
    const custVerify = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1, 'X-CSRF-Token': csrf1 },
      body: JSON.stringify({ token: custToken }),
    });
    assert.equal(custVerify.status, 200);
    const custCookies = custVerify.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

    // Existing verified customer MUST be denied on admin routes even before owner is bound
    const custAdminAttempt = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: custCookies },
    });
    assert.equal(custAdminAttempt.status, 403);

    // 3. Target owner missing -> bindOwnerAccount throws without changing any account
    await assert.rejects(
      () =>
        previewStore.bindOwnerAccount({
          email: 'saivinodkotipalli2003@gmail.com',
          boundVia: 'server_cli',
        }),
      /No account exists/i
    );

    // 4. Register intended owner legitimately -> verify email link uses canonical shared-preview APP_URL
    const bootOwner = await fetch(`${baseUrl}/api/auth/session`);
    const ownerCookiePre = bootOwner.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const { csrfToken: ownerCsrfPre } = (await bootOwner.json()) as { csrfToken: string };

    const ownerPass = 'SahithiAtelierOwner#2026';
    const ownerRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookiePre,
        'X-CSRF-Token': ownerCsrfPre,
      },
      body: JSON.stringify({
        fullName: 'Saivinod Kotipalli',
        email: 'saivinodkotipalli2003@gmail.com',
        password: ownerPass,
        confirmPassword: ownerPass,
      }),
    });
    assert.equal(ownerRegRes.status, 200);

    const ownerEmailMsg = sentEmails.find(
      (e) => e.to.toLowerCase() === 'saivinodkotipalli2003@gmail.com'
    );
    assert.ok(ownerEmailMsg);
    const emailLink = extractUrl(ownerEmailMsg.text);
    assert.ok(
      emailLink.startsWith(`${previewUrlCanonical}/verify-email?token=`),
      `Verification URL should target canonical APP_URL, got ${emailLink}`
    );

    // Unverified owner -> bindOwnerAccount still refuses cleanly
    await assert.rejects(
      () =>
        previewStore.bindOwnerAccount({
          email: 'saivinodkotipalli2003@gmail.com',
          boundVia: 'server_cli',
        }),
      /not verified/i
    );

    // Complete email verification
    const ownerVerifyToken = extractToken(ownerEmailMsg.text);
    const ownerVerifyRes = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookiePre,
        'X-CSRF-Token': ownerCsrfPre,
      },
      body: JSON.stringify({ token: ownerVerifyToken }),
    });
    assert.equal(ownerVerifyRes.status, 200);
    const ownerCookiePost = ownerVerifyRes.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

    // Confirm dev namespace did NOT receive preview user (environment isolation!)
    assert.equal(await devStore.getUserByEmail('saivinodkotipalli2003@gmail.com'), null);

    // 5. Complete binding -> idempotent on repeat run & rejects conflicting rebind without --force
    const bound1 = await previewStore.bindOwnerAccount({
      email: 'SAIVINODKOTIPALLI2003@GMAIL.COM',
      boundVia: 'server_cli',
    });
    const bound2 = await previewStore.bindOwnerAccount({
      email: 'saivinodkotipalli2003@gmail.com',
      boundVia: 'server_cli',
    });
    assert.equal(bound1.owner_user_id, bound2.owner_user_id);

    await assert.rejects(
      () =>
        previewStore.bindOwnerAccount({
          email: 'customer.other@example.com',
          boundVia: 'server_cli',
        }),
      /already bound/i
    );

    // 6. Owner accesses /api/admin/overview cleanly while unrelated verified user still receives 403
    const ownerOverview = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: ownerCookiePost },
    });
    assert.equal(ownerOverview.status, 200);

    const custStillBlocked = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: custCookies },
    });
    assert.equal(custStillBlocked.status, 403);

    // 7. Chunked large media upload (> 450KB) saves and reads back byte-for-byte
    const bigPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(600_000, 0x42),
    ]);
    await previewStore.saveMediaFiles([
      {
        id: 'big-media-1',
        filename: 'sc-big-media-1.png',
        mimeType: 'image/png',
        byteSize: bigPng.byteLength,
        sha256: 'abc',
        data: bigPng,
        uploadedByUserId: bound1.owner_user_id,
        createdAt: Date.now(),
      },
    ]);
    const loadedMedia = await previewStore.getMediaWithPublicStatus('sc-big-media-1.png');
    assert.ok(loadedMedia);
    assert.equal(loadedMedia.media.data.byteLength, bigPng.byteLength);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('backupAndMigrateSqliteToFirestore backs up SQLite first and migrates without overwriting existing users or promoting unrelated accounts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-migrate-test-'));
  const sqlitePath = path.join(tmpDir, 'source.db');
  const backupDir = path.join(tmpDir, 'backups');

  try {
    const db = initAuthDatabase(sqlitePath, { seedCatalog: true });
    const now = Date.now();
    db.prepare(
      `INSERT INTO users (id, full_name, email, email_verified, password_hash, phone_e164, phone_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, NULL, 0, ?, ?)`
    ).run('existing-other-id', 'Other Verified User', 'other@example.com', '$2b$10$hash1', now, now);
    db.close();

    const firestore = createInMemoryFirestore();
    // Pre-seed a user in Firestore with the same ID to verify migration NEVER overwrites existing records
    await firestore
      .collection('environments')
      .doc('development')
      .collection('users')
      .doc('preexisting-id')
      .set({
        id: 'preexisting-id',
        full_name: 'Already In Firestore',
        email: 'already@example.com',
        email_verified: true,
        password_hash: '$2b$10$keepme',
        created_at: now - 1000,
        updated_at: now - 1000,
      });

    const summary = await backupAndMigrateSqliteToFirestore({
      sqlitePath,
      firestore,
      namespace: 'development',
      targetEnv: 'development',
      backupDir,
    });

    assert.ok(fs.existsSync(summary.backupPath), 'Backup DB file must exist');
    assert.equal(summary.usersCreated, 1);
    assert.ok(summary.productsCreated >= 12);
    assert.equal(summary.ownerBindingCreated, false, 'Unrelated user must NOT become bound owner');

    // Second run is non-destructive and skips existing users/products
    const secondRun = await backupAndMigrateSqliteToFirestore({
      sqlitePath,
      firestore,
      namespace: 'development',
      targetEnv: 'development',
      backupDir,
    });
    assert.equal(secondRun.usersCreated, 0);
    assert.equal(secondRun.usersSkippedExisting, 1);
    assert.equal(secondRun.productsCreated, 0);

    const migratedStore = new FirestoreBoutiqueStore({
      config: { projectId: 'celtic-pattern-fmln4', firestoreDatabaseId: 'test-db' },
      namespace: 'development',
      targetEnv: 'development',
      firestoreOverride: firestore,
    });
    const preserved = await migratedStore.getUserById('existing-other-id');
    assert.ok(preserved);
    assert.equal(preserved.email, 'other@example.com');
    assert.equal(preserved.email_verified, 1);
    assert.equal(await migratedStore.resolveBoundOwner(), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureConfiguredOwnerBinding resolves verified owner email idempotently without needing ADMIN_OWNER_USER_ID or replacing existing bindings', async () => {
  const store = new SqliteBoutiqueStore({
    dbPath: ':memory:',
    targetEnv: 'development',
    seedCatalog: false,
    isPersistent: false,
  });

  try {
    const ownerEmail = 'saivinodkotipalli2003@gmail.com';
    const now = Date.now();

    // 1. Missing account -> does not bind or create account
    const missing = await ensureConfiguredOwnerBinding(store, ownerEmail);
    assert.equal(missing.status, 'missing_account');
    assert.equal(await store.resolveBoundOwner(), null);

    // 2. Unverified account -> refuses to bypass verification
    await store.createPendingEmailUser({
      id: 'owner-user-1',
      fullName: 'Saivinod Kotipalli',
      email: ownerEmail,
      passwordHash: '$2b$10$validhash',
      now,
    });
    const unverified = await ensureConfiguredOwnerBinding(store, ownerEmail);
    assert.equal(unverified.status, 'unverified');
    assert.equal(await store.resolveBoundOwner(), null);

    // 3. Verified account -> automatically binds immutable user ID idempotently
    await store.markUserEmailVerified('owner-user-1', now + 10);
    const bound = await ensureConfiguredOwnerBinding(store, ownerEmail);
    assert.equal(bound.status, 'bound');
    assert.equal(bound.binding.owner_user_id, 'owner-user-1');

    const repeat = await ensureConfiguredOwnerBinding(store, ownerEmail);
    assert.equal(repeat.status, 'already_bound');
    assert.equal(repeat.binding.owner_user_id, 'owner-user-1');

    // 4. Never silently reassigns ownership if a binding already points to another ID
    await store.createPendingEmailUser({
      id: 'other-verified-id',
      fullName: 'Another User',
      email: 'other@example.com',
      passwordHash: '$2b$10$otherhash',
      now: now + 20,
    });
    await store.markUserEmailVerified('other-verified-id', now + 21);

    const conflict = await ensureConfiguredOwnerBinding(store, 'other@example.com');
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.existingUserId, 'owner-user-1');

    const stillBound = await store.getStoredAdminBinding();
    assert.equal(stillBound?.owner_user_id, 'owner-user-1');
  } finally {
    await store.close();
  }
});

test('provisionOrResetOwnerAccount & bootstrapOwnerFromEnv configure and reset owner without SMTP while preserving password changes and revoking old sessions', async () => {
  const store = new SqliteBoutiqueStore({
    dbPath: ':memory:',
    targetEnv: 'development',
    seedCatalog: false,
    isPersistent: false,
  });

  // Intentionally construct createAuthApp WITHOUT an emailSender (no SMTP configured)
  const appWrapper = createAuthApp({
    store,
    disableRateLimit: true,
    appBaseUrl: 'http://127.0.0.1:3000',
  });
  const server = http.createServer(appWrapper.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const ownerEmail = 'saivinodkotipalli2003@gmail.com';
    const initialPass = 'InitialSecret#2026';

    // 1. Weak password is rejected
    const weak = await bootstrapOwnerFromEnv(store, ownerEmail, {
      ADMIN_OWNER_PASSWORD: 'short',
    });
    assert.equal(weak.mode, 'invalid_password');
    assert.equal(await store.resolveBoundOwner(), null);

    // 2. First bootstrap via hosting secret creates verified bound owner without SMTP
    const created = await bootstrapOwnerFromEnv(store, ownerEmail, {
      ADMIN_OWNER_PASSWORD: initialPass,
    });
    assert.equal(created.mode, 'provisioned');
    assert.equal(created.result.status, 'created');
    const boundOwner = await store.resolveBoundOwner();
    assert.ok(boundOwner);
    assert.equal(boundOwner.bound_email, ownerEmail);

    // Verify stored password is a bcrypt hash, never plaintext
    const storedUser = await store.getUserByEmail(ownerEmail);
    assert.ok(storedUser?.password_hash?.startsWith('$2'));
    assert.notEqual(storedUser?.password_hash, initialPass);

    // 3. Log in at /api/admin/login with initial password
    const bootRes = await fetch(`${baseUrl}/api/auth/session`);
    const csrf1 = ((await bootRes.json()) as { csrfToken: string }).csrfToken;
    const cookiePre = bootRes.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

    const login1 = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf1,
        Cookie: cookiePre,
      },
      body: JSON.stringify({ email: ownerEmail, password: initialPass }),
    });
    assert.equal(login1.status, 200);
    const ownerCookie = login1.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

    // 4. Subsequent normal startup does NOT overwrite existing password even if env var differs
    const repeatBoot = await bootstrapOwnerFromEnv(store, ownerEmail, {
      ADMIN_OWNER_PASSWORD: 'DifferentEnvPassword!99',
    });
    assert.equal(repeatBoot.mode, 'already_configured');

    // 5. Email-free password reset via provisionOrResetOwnerAccount (same logic as `npm run admin:setup`)
    //    updates password hash and immediately revokes active sessions
    const resetPass = 'ResetSecret#2026';
    const resetRes = await provisionOrResetOwnerAccount(store, {
      email: ownerEmail,
      password: resetPass,
      boundVia: 'admin_setup_cli',
    });
    assert.equal(resetRes.status, 'updated');

    // Old session is immediately revoked
    const oldSessionCheck = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(oldSessionCheck.status, 401);

    // Old password fails; new password succeeds
    const oldPassLogin = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf1,
        Cookie: cookiePre,
      },
      body: JSON.stringify({ email: ownerEmail, password: initialPass }),
    });
    assert.equal(oldPassLogin.status, 401);

    const newPassLogin = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf1,
        Cookie: cookiePre,
      },
      body: JSON.stringify({ email: ownerEmail, password: resetPass }),
    });
    assert.equal(newPassLogin.status, 200);

    // 6. Never allows reassigning existing owner binding to a different email without --force
    const conflict = await provisionOrResetOwnerAccount(store, {
      email: 'attacker@example.com',
      password: 'AttackerPassword#2026',
    });
    assert.equal(conflict.status, 'conflict');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await store.close();
  }
});

test('FirestoreRestStore + firebase_managed mode handles owner activation, email verification, RBAC, catalog persistence, container restarts, and revocation without IAM or SMTP', async () => {
  const crypto = await import('node:crypto');
  const { FirestoreRestStore } = await import('../server/firebase-rest.ts');

  const projectId = 'celtic-pattern-fmln4';
  const dbId = 'test-rest-db';
  const apiKey = 'AIzaSyMockRestKey12345';
  const kid = 'test-key-1';
  const ownerEmail = 'saivinodkotipalli2003@gmail.com';
  const customerEmail = 'customer.managed@example.com';

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  function signJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString(
      'base64url'
    );
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    signer.end();
    const sig = signer.sign(privateKey).toString('base64url');
    return `${header}.${body}.${sig}`;
  }

  interface MockAuthUser {
    localId: string;
    email: string;
    password: string;
    emailVerified: boolean;
    displayName: string;
    authTimeSec: number;
  }

  const fbUsers = new Map<string, MockAuthUser>();
  const fbOobCodes = new Map<string, { mode: 'VERIFY_EMAIL' | 'PASSWORD_RESET'; email: string }>();
  const refreshTokens = new Map<string, string>();
  let oobSeq = 0;

  function mintIdToken(u: MockAuthUser): string {
    const nowSec = Math.floor(Date.now() / 1000);
    return signJwt({
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      sub: u.localId,
      email: u.email,
      email_verified: u.emailVerified,
      name: u.displayName,
      auth_time: u.authTimeSec,
      iat: nowSec,
      exp: nowSec + 3600,
    });
  }

  // Minimal Firestore REST v1 in-memory document store
  const fsDocs = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  const docRootPrefix = `projects/${projectId}/databases/${dbId}/documents/`;
  let fsRev = 1;

  function decodeFsVal(val: unknown): unknown {
    if (!val || typeof val !== 'object') return undefined;
    const v = val as Record<string, unknown>;
    if ('nullValue' in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('stringValue' in v) return v.stringValue;
    if ('bytesValue' in v) return v.bytesValue;
    if ('arrayValue' in v) {
      const arr = ((v.arrayValue as { values?: unknown[] }).values || []).map(decodeFsVal);
      return arr;
    }
    if ('mapValue' in v) {
      const out: Record<string, unknown> = {};
      const mf = (v.mapValue as { fields?: Record<string, unknown> }).fields || {};
      for (const [k, fv] of Object.entries(mf)) {
        out[k] = decodeFsVal(fv);
      }
      return out;
    }
    return undefined;
  }

  function matchFsFilter(fields: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    if (filter.compositeFilter) {
      const cf = filter.compositeFilter as { op: string; filters?: Record<string, unknown>[] };
      const filters = cf.filters || [];
      return filters.every((f) => matchFsFilter(fields, f));
    }
    if (filter.fieldFilter) {
      const ff = filter.fieldFilter as {
        field: { fieldPath: string };
        op: string;
        value: unknown;
      };
      const actual = decodeFsVal(fields[ff.field.fieldPath]);
      const expected = decodeFsVal(ff.value);
      if (ff.op === 'EQUAL') return actual === expected;
      if (ff.op === 'NOT_EQUAL') return actual !== expected && actual !== undefined;
      if (ff.op === 'ARRAY_CONTAINS') return Array.isArray(actual) && actual.includes(expected);
    }
    return true;
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith('http://127.0.0.1:')) {
      return realFetch(input, init);
    }

    const url = new URL(urlStr);
    const bodyText = typeof init?.body === 'string' ? init.body : '';

    // 1. Public Google X.509 certs endpoint
    if (urlStr.includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ [kid]: publicKey }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
      });
    }

    // 2. Identity Toolkit endpoints
    if (url.hostname === 'identitytoolkit.googleapis.com') {
      const payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      const action = url.pathname.split('/').pop() || '';
      const fbErr = (msg: string, status = 400) =>
        new Response(JSON.stringify({ error: { code: status, message: msg } }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (action === 'accounts:signUp') {
        const email = String(payload.email || '').toLowerCase();
        const password = String(payload.password || '');
        if ([...fbUsers.values()].some((u) => u.email === email)) {
          return fbErr('EMAIL_EXISTS');
        }
        const localId = `fb-${crypto.randomUUID()}`;
        const user: MockAuthUser = {
          localId,
          email,
          password,
          emailVerified: false,
          displayName: String(payload.displayName || ''),
          authTimeSec: Math.floor(Date.now() / 1000),
        };
        fbUsers.set(localId, user);
        const rt = `rt-${crypto.randomUUID()}`;
        refreshTokens.set(rt, localId);
        return new Response(
          JSON.stringify({
            idToken: mintIdToken(user),
            refreshToken: rt,
            localId,
            email,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (action === 'accounts:signInWithPassword') {
        const email = String(payload.email || '').toLowerCase();
        const password = String(payload.password || '');
        const user = [...fbUsers.values()].find((u) => u.email === email);
        if (!user || user.password !== password) {
          return fbErr('INVALID_LOGIN_CREDENTIALS');
        }
        user.authTimeSec = Math.floor(Date.now() / 1000);
        const rt = `rt-${crypto.randomUUID()}`;
        refreshTokens.set(rt, user.localId);
        return new Response(
          JSON.stringify({
            idToken: mintIdToken(user),
            refreshToken: rt,
            localId: user.localId,
            email: user.email,
            displayName: user.displayName,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (action === 'accounts:sendOobCode') {
        const reqType = String(payload.requestType || '');
        let targetEmail = String(payload.email || '').toLowerCase();
        if (reqType === 'VERIFY_EMAIL' && typeof payload.idToken === 'string') {
          const claims = JSON.parse(
            Buffer.from(payload.idToken.split('.')[1], 'base64url').toString('utf8')
          ) as { email?: string };
          targetEmail = String(claims.email || '').toLowerCase();
        }
        oobSeq += 1;
        const oobCode = `oob-${oobSeq}-${crypto.randomBytes(6).toString('hex')}`;
        fbOobCodes.set(oobCode, {
          mode: reqType === 'VERIFY_EMAIL' ? 'VERIFY_EMAIL' : 'PASSWORD_RESET',
          email: targetEmail,
        });
        return new Response(JSON.stringify({ email: targetEmail }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (action === 'accounts:update') {
        if (typeof payload.oobCode === 'string') {
          const entry = fbOobCodes.get(payload.oobCode);
          if (!entry || entry.mode !== 'VERIFY_EMAIL') {
            return fbErr('INVALID_OOB_CODE');
          }
          const u = [...fbUsers.values()].find((x) => x.email === entry.email);
          if (!u) return fbErr('USER_NOT_FOUND');
          u.emailVerified = true;
          fbOobCodes.delete(payload.oobCode);
          return new Response(JSON.stringify({ email: u.email, emailVerified: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (typeof payload.idToken === 'string' && typeof payload.password === 'string') {
          const claims = JSON.parse(
            Buffer.from(payload.idToken.split('.')[1], 'base64url').toString('utf8')
          ) as { sub?: string };
          const u = fbUsers.get(String(claims.sub || ''));
          if (!u) return fbErr('INVALID_ID_TOKEN');
          u.password = payload.password;
          u.authTimeSec = Math.floor(Date.now() / 1000);
          const rt = `rt-${crypto.randomUUID()}`;
          refreshTokens.set(rt, u.localId);
          return new Response(
            JSON.stringify({
              idToken: mintIdToken(u),
              refreshToken: rt,
              localId: u.localId,
              email: u.email,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      if (action === 'accounts:resetPassword') {
        const entry = fbOobCodes.get(String(payload.oobCode || ''));
        if (!entry || entry.mode !== 'PASSWORD_RESET') {
          return fbErr('INVALID_OOB_CODE');
        }
        const u = [...fbUsers.values()].find((x) => x.email === entry.email);
        if (u && typeof payload.newPassword === 'string') {
          u.password = payload.newPassword;
        }
        fbOobCodes.delete(String(payload.oobCode || ''));
        return new Response(JSON.stringify({ email: entry.email }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return fbErr(`UNSUPPORTED_MOCK_ACTION:${action}`);
    }

    // 3. Token refresh endpoint
    if (url.hostname === 'securetoken.googleapis.com') {
      const form = new URLSearchParams(bodyText);
      const rt = form.get('refresh_token') || '';
      const uid = refreshTokens.get(rt);
      const u = uid ? fbUsers.get(uid) : undefined;
      if (!u) {
        return new Response(JSON.stringify({ error: { message: 'INVALID_REFRESH_TOKEN' } }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({ id_token: mintIdToken(u), refresh_token: rt, user_id: u.localId }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Firestore REST v1 endpoint
    if (url.hostname === 'firestore.googleapis.com') {
      const v1Idx = url.pathname.indexOf('/v1/');
      const rel = url.pathname.slice(v1Idx + 4);

      if (rel.endsWith(':commit')) {
        const parsed = JSON.parse(bodyText) as { writes?: Array<Record<string, unknown>> };
        for (const w of parsed.writes || []) {
          if (w.update && typeof w.update === 'object') {
            const upd = w.update as { name: string; fields?: Record<string, unknown> };
            const docPath = upd.name.slice(docRootPrefix.length);
            fsRev += 1;
            fsDocs.set(docPath, {
              fields: upd.fields || {},
              updateTime: `2026-11-15T00:00:${String(fsRev).padStart(2, '0')}Z`,
            });
          } else if (typeof w.delete === 'string') {
            const docPath = w.delete.slice(docRootPrefix.length);
            fsDocs.delete(docPath);
          }
        }
        return new Response(JSON.stringify({ writeResults: [] }), { status: 200 });
      }

      if (rel.endsWith(':runQuery')) {
        const parentFull = rel.slice(0, -':runQuery'.length);
        const parentRel = parentFull.slice(docRootPrefix.length);
        const parsed = JSON.parse(bodyText) as {
          structuredQuery: {
            from: Array<{ collectionId: string }>;
            where?: Record<string, unknown>;
            limit?: number;
          };
        };
        const colId = parsed.structuredQuery.from[0].collectionId;
        const colPrefix = parentRel ? `${parentRel}/${colId}/` : `${colId}/`;
        const rows: Array<{ document: { name: string; fields: Record<string, unknown>; updateTime: string } }> = [];
        for (const [docPath, docVal] of fsDocs.entries()) {
          if (!docPath.startsWith(colPrefix)) continue;
          const tail = docPath.slice(colPrefix.length);
          if (tail.includes('/')) continue;
          if (parsed.structuredQuery.where && !matchFsFilter(docVal.fields, parsed.structuredQuery.where)) {
            continue;
          }
          rows.push({
            document: {
              name: `${docRootPrefix}${docPath}`,
              fields: docVal.fields,
              updateTime: docVal.updateTime,
            },
          });
          if (parsed.structuredQuery.limit && rows.length >= parsed.structuredQuery.limit) {
            break;
          }
        }
        if (rows.length === 0) {
          return new Response(JSON.stringify([{ readTime: new Date().toISOString() }]), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(rows), { status: 200 });
      }

      const docPath = rel.slice(docRootPrefix.length);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        const existing = fsDocs.get(docPath);
        if (!existing) {
          return new Response(JSON.stringify({ error: { code: 404, message: 'NOT_FOUND' } }), {
            status: 404,
          });
        }
        return new Response(
          JSON.stringify({
            name: `${docRootPrefix}${docPath}`,
            fields: existing.fields,
            updateTime: existing.updateTime,
          }),
          { status: 200 }
        );
      }

      if (method === 'PATCH') {
        const parsed = JSON.parse(bodyText) as { fields?: Record<string, unknown> };
        const expectedUpdateTime = url.searchParams.get('currentDocument.updateTime');
        const existing = fsDocs.get(docPath);
        if (expectedUpdateTime && existing && existing.updateTime !== expectedUpdateTime) {
          return new Response(JSON.stringify({ error: { code: 409, message: 'ABORTED' } }), {
            status: 409,
          });
        }
        const fieldMasks = url.searchParams.getAll('updateMask.fieldPaths');
        fsRev += 1;
        const nextUpdateTime = `2026-11-15T00:00:${String(fsRev).padStart(2, '0')}Z`;
        if (fieldMasks.length > 0 && existing) {
          const merged = { ...existing.fields };
          for (const key of fieldMasks) {
            if (parsed.fields && key in parsed.fields) {
              merged[key] = parsed.fields[key];
            }
          }
          fsDocs.set(docPath, { fields: merged, updateTime: nextUpdateTime });
        } else {
          fsDocs.set(docPath, { fields: parsed.fields || {}, updateTime: nextUpdateTime });
        }
        return new Response(
          JSON.stringify({ name: `${docRootPrefix}${docPath}`, updateTime: nextUpdateTime }),
          { status: 200 }
        );
      }

      if (method === 'DELETE') {
        fsDocs.delete(docPath);
        return new Response(JSON.stringify({}), { status: 200 });
      }
    }

    throw new Error(`Unexpected unmocked fetch URL in test: ${urlStr}`);
  }) as typeof fetch;

  const restStore = new FirestoreRestStore({
    config: {
      projectId,
      firestoreDatabaseId: dbId,
      apiKey,
      authDomain: `${projectId}.firebaseapp.com`,
    },
    namespace: 'development',
    targetEnv: 'development',
    ownerEmail,
  });

  const server1Wrapper = createAuthApp({ store: restStore, disableRateLimit: true });
  const server1 = http.createServer(server1Wrapper.app);
  await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => resolve()));
  const addr1 = server1.address();
  assert.ok(addr1 && typeof addr1 === 'object');
  const baseUrl1 = `http://127.0.0.1:${addr1.port}`;

  let server2: http.Server | null = null;

  try {
    // 1. Capabilities confirm zero-IAM firebase_managed mode + emailDeliveryConfigured: true
    const capRes = await fetch(`${baseUrl1}/api/auth/capabilities`);
    assert.equal(capRes.status, 200);
    const caps = (await capRes.json()) as Record<string, unknown>;
    assert.equal(caps.authMode, 'firebase_managed');
    assert.equal(caps.databaseBackend, 'firestore');
    assert.equal(caps.persistentDatabase, true);
    assert.equal(caps.emailDeliveryConfigured, true);

    const boot = await fetch(`${baseUrl1}/api/auth/session`);
    const bootCookie = boot.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const { csrfToken: bootCsrf } = (await boot.json()) as { csrfToken: string };

    // 2. Public visitor cannot activate owner access
    const nonOwnerAct = await fetch(`${baseUrl1}/api/admin/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({
        email: customerEmail,
        password: 'CustomerPassword#2026',
        confirmPassword: 'CustomerPassword#2026',
      }),
    });
    assert.equal(nonOwnerAct.status, 403);

    // 3. Owner activates via /api/admin/activate -> sends verification email, blocks unverified login
    const ownerPass = 'SahithiManaged#2026';
    const actRes = await fetch(`${baseUrl1}/api/admin/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPass,
        confirmPassword: ownerPass,
      }),
    });
    assert.equal(actRes.status, 201);

    const dupAct = await fetch(`${baseUrl1}/api/admin/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPass,
        confirmPassword: ownerPass,
      }),
    });
    assert.equal(dupAct.status, 409);

    const unverifiedLogin = await fetch(`${baseUrl1}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({ email: ownerEmail, password: ownerPass }),
    });
    assert.equal(unverifiedLogin.status, 403);
    const unverifiedBody = (await unverifiedLogin.json()) as { code?: string };
    assert.equal(unverifiedBody.code, 'EMAIL_NOT_VERIFIED');

    // 4. Owner confirms email link -> logs into /api/admin/login -> gets owner session + auto-seeded Firestore catalog
    const latestVerifyCode = [...fbOobCodes.entries()].find(
      ([, v]) => v.mode === 'VERIFY_EMAIL' && v.email === ownerEmail
    )?.[0];
    assert.ok(latestVerifyCode);

    const confirmRes = await fetch(`${baseUrl1}/api/admin/activate/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({
        token: `https://celtic-pattern-fmln4.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=${latestVerifyCode}`,
      }),
    });
    assert.equal(confirmRes.status, 200);

    const loginRes = await fetch(`${baseUrl1}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({ email: ownerEmail, password: ownerPass }),
    });
    assert.equal(loginRes.status, 200);
    const loginBody = (await loginRes.json()) as {
      csrfToken: string;
      user: { isOwner: boolean; email: string };
    };
    assert.equal(loginBody.user.isOwner, true);
    assert.equal(loginBody.user.email, ownerEmail);

    const ownerCookie = loginRes.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    assert.ok(ownerCookie.includes('sc_fb_session='));

    // 5. Verified regular customer is still blocked from /api/admin/*
    const custReg = await fetch(`${baseUrl1}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({
        fullName: 'Verified Shopper',
        email: customerEmail,
        password: 'ShopperPassword#2026',
        confirmPassword: 'ShopperPassword#2026',
      }),
    });
    assert.equal(custReg.status, 200);
    const custCode = [...fbOobCodes.entries()].find(
      ([, v]) => v.mode === 'VERIFY_EMAIL' && v.email === customerEmail
    )?.[0];
    assert.ok(custCode);
    await fetch(`${baseUrl1}/api/auth/verify-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({ token: custCode }),
    });
    const custLogin = await fetch(`${baseUrl1}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({ email: customerEmail, password: 'ShopperPassword#2026' }),
    });
    assert.equal(custLogin.status, 200);
    const custCookie = custLogin.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const custAdminCheck = await fetch(`${baseUrl1}/api/admin/overview`, {
      headers: { Cookie: custCookie },
    });
    assert.equal(custAdminCheck.status, 403);

    // 6. Owner creates a published product, updates boutique settings, and manages customer enquiry in Firestore
    const createProd = await fetch(`${baseUrl1}/api/admin/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
        'X-CSRF-Token': loginBody.csrfToken,
      },
      body: JSON.stringify({
        title: 'Royal Roseberry Organza Saree',
        category: 'Ethnic Wear',
        priceInr: 6850,
        stock: 9,
        status: 'published',
        description: 'Hand-dyed organza drape with delicate zari border for evening celebrations.',
        fabricNote: 'Pure silk organza',
        images: [
          {
            url: '/boutique-media/col_ethnic_wear_1794557657086.jpg',
            alt: 'Royal Roseberry Organza Saree',
            isCover: true,
          },
        ],
        colors: [{ name: 'Roseberry', hex: '#B76E79' }],
        sizes: ['Free Size'],
      }),
    });
    assert.equal(createProd.status, 201);

    const updateSettingsRes = await fetch(`${baseUrl1}/api/admin/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
        'X-CSRF-Token': loginBody.csrfToken,
      },
      body: JSON.stringify({
        brandName: 'Sahithi Collections',
        tagline: 'Artisanal Heritage Couture',
      }),
    });
    assert.equal(updateSettingsRes.status, 200);

    const contactRes = await fetch(`${baseUrl1}/api/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({
        senderName: 'Meera Nair',
        senderEmail: 'meera@example.com',
        subject: 'Bridal Trousseau Consultation',
        message: 'Would love to book a private studio fitting next weekend.',
      }),
    });
    assert.equal(contactRes.status, 201);
    const contactJson = (await contactRes.json()) as { id: string };

    const msgListRes = await fetch(`${baseUrl1}/api/admin/messages`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(msgListRes.status, 200);
    const msgListJson = (await msgListRes.json()) as { items: Array<{ id: string }> };
    assert.ok(msgListJson.items.some((m) => m.id === contactJson.id));

    const msgPatchRes = await fetch(`${baseUrl1}/api/admin/messages/${contactJson.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
        'X-CSRF-Token': loginBody.csrfToken,
      },
      body: JSON.stringify({ status: 'read', adminNotes: 'Scheduled Saturday 4pm.' }),
    });
    assert.equal(msgPatchRes.status, 200);

    // 7. Brand-new Express server instance (simulating Cloud Run container restart) still honors sc_fb_session cookie and returns persisted Firestore data
    const server2Wrapper = createAuthApp({ store: restStore, disableRateLimit: true });
    server2 = http.createServer(server2Wrapper.app);
    await new Promise<void>((resolve) => server2!.listen(0, '127.0.0.1', () => resolve()));
    const addr2 = server2.address();
    assert.ok(addr2 && typeof addr2 === 'object');
    const baseUrl2 = `http://127.0.0.1:${addr2.port}`;

    const restartedSession = await fetch(`${baseUrl2}/api/admin/session`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(restartedSession.status, 200);
    const restartedBody = (await restartedSession.json()) as {
      isOwner: boolean;
      csrfToken: string;
    };
    assert.equal(restartedBody.isOwner, true);

    const publicProducts = await fetch(`${baseUrl2}/api/products`);
    assert.equal(publicProducts.status, 200);
    const publicJson = (await publicProducts.json()) as { items: Array<{ name: string }> };
    assert.ok(
      publicJson.items.some((p) => p.name === 'Royal Roseberry Organza Saree'),
      'Newly created product should persist across server restart'
    );

    const publicStorefront = await fetch(`${baseUrl2}/api/storefront`);
    assert.equal(publicStorefront.status, 200);
    const sfJson = (await publicStorefront.json()) as { settings: { tagline: string } };
    assert.equal(sfJson.settings.tagline, 'Artisanal Heritage Couture');

    // 8. Logout invalidates the existing sc_fb_session cookie immediately via owner_meta.revoked_before
    const logoutRes = await fetch(`${baseUrl2}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: ownerCookie,
        'X-CSRF-Token': restartedBody.csrfToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(logoutRes.status, 200);

    const replayAfterLogout = await fetch(`${baseUrl2}/api/admin/session`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(replayAfterLogout.status, 401);

    // 9. Password reset flow updates Firebase password cleanly without SMTP
    const forgotRes = await fetch(`${baseUrl2}/api/admin/forgot-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({ email: ownerEmail }),
    });
    assert.equal(forgotRes.status, 200);

    const resetCode = [...fbOobCodes.entries()].find(
      ([, v]) => v.mode === 'PASSWORD_RESET' && v.email === ownerEmail
    )?.[0];
    assert.ok(resetCode);

    const resetConfirm = await fetch(`${baseUrl2}/api/admin/password-reset/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({
        token: resetCode,
        password: 'RotatedOwnerPass#2026',
      }),
    });
    assert.equal(resetConfirm.status, 200);

    const reloginNewPass = await fetch(`${baseUrl2}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bootCookie,
        'X-CSRF-Token': bootCsrf,
      },
      body: JSON.stringify({ email: ownerEmail, password: 'RotatedOwnerPass#2026' }),
    });
    assert.equal(reloginNewPass.status, 200);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server1.close((e) => (e ? reject(e) : resolve())));
    if (server2) {
      await new Promise<void>((resolve, reject) =>
        server2!.close((e) => (e ? reject(e) : resolve()))
      );
    }
  }
});

test('firebase_managed auth surfaces provider-disabled diagnostics (503), enforces resend password/cooldown without fake 200s, and isolates customer signup from owner privileges', async () => {
  const crypto = await import('node:crypto');
  const { FirestoreRestStore } = await import('../server/firebase-rest.ts');

  const projectId = 'celtic-pattern-fmln4';
  const dbId = 'test-auth-edge-db';
  const apiKey = 'AIzaSyMockEdgeKey12345';
  const kid = 'edge-key-1';
  const ownerEmail = 'saivinodkotipalli2003@gmail.com';
  const customerEmail = 'shopper.edge@example.com';

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  function signJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString(
      'base64url'
    );
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    signer.end();
    const sig = signer.sign(privateKey).toString('base64url');
    return `${header}.${body}.${sig}`;
  }

  let emailPasswordEnabled = false;
  let verifyDispatchCalls = 0;

  interface EdgeUser {
    localId: string;
    email: string;
    password: string;
    emailVerified: boolean;
    displayName: string;
    authTimeSec: number;
  }
  const fbUsers = new Map<string, EdgeUser>();
  const fsDocs = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  const docRootPrefix = `projects/${projectId}/databases/${dbId}/documents/`;

  function mintIdToken(u: EdgeUser): string {
    const nowSec = Math.floor(Date.now() / 1000);
    return signJwt({
      aud: projectId,
      iss: `https://securetoken.google.com/${projectId}`,
      sub: u.localId,
      email: u.email,
      email_verified: u.emailVerified,
      name: u.displayName,
      auth_time: u.authTimeSec,
      iat: nowSec,
      exp: nowSec + 3600,
    });
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith('http://127.0.0.1:')) {
      return realFetch(input, init);
    }

    const url = new URL(urlStr);
    const bodyText = typeof init?.body === 'string' ? init.body : '';

    if (urlStr.includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ [kid]: publicKey }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
      });
    }

    if (url.hostname === 'identitytoolkit.googleapis.com') {
      const payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      const action = url.pathname.split('/').pop() || '';
      const fbErr = (msg: string, status = 400) =>
        new Response(JSON.stringify({ error: { code: status, message: msg } }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (action === 'accounts:signUp') {
        if (!emailPasswordEnabled) {
          return fbErr('OPERATION_NOT_ALLOWED');
        }
        const email = String(payload.email || '').toLowerCase();
        const password = String(payload.password || '');
        if ([...fbUsers.values()].some((u) => u.email === email)) {
          return fbErr('EMAIL_EXISTS');
        }
        const localId = `edge-${crypto.randomUUID()}`;
        const u: EdgeUser = {
          localId,
          email,
          password,
          emailVerified: false,
          displayName: String(payload.displayName || ''),
          authTimeSec: Math.floor(Date.now() / 1000),
        };
        fbUsers.set(localId, u);
        return new Response(
          JSON.stringify({
            idToken: mintIdToken(u),
            refreshToken: `rt-${localId}`,
            localId,
            email,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (action === 'accounts:signInWithPassword') {
        if (!emailPasswordEnabled) {
          return fbErr('PASSWORD_LOGIN_DISABLED');
        }
        const email = String(payload.email || '').toLowerCase();
        const password = String(payload.password || '');
        const u = [...fbUsers.values()].find((x) => x.email === email);
        if (!u || u.password !== password) {
          return fbErr('INVALID_LOGIN_CREDENTIALS');
        }
        return new Response(
          JSON.stringify({
            idToken: mintIdToken(u),
            refreshToken: `rt-${u.localId}`,
            localId: u.localId,
            email: u.email,
            displayName: u.displayName,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (action === 'accounts:sendOobCode') {
        verifyDispatchCalls += 1;
        return new Response(JSON.stringify({ email: String(payload.email || 'ok@example.com') }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return fbErr(`UNEXPECTED_EDGE_ACTION:${action}`);
    }

    if (url.hostname === 'firestore.googleapis.com') {
      const v1Idx = url.pathname.indexOf('/v1/');
      const rel = url.pathname.slice(v1Idx + 4);
      if (rel.endsWith(':runQuery')) {
        return new Response(JSON.stringify([{ readTime: new Date().toISOString() }]), { status: 200 });
      }
      const docPath = rel.slice(docRootPrefix.length);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        const existing = fsDocs.get(docPath);
        if (!existing) {
          return new Response(JSON.stringify({ error: { code: 404, message: 'NOT_FOUND' } }), {
            status: 404,
          });
        }
        return new Response(
          JSON.stringify({
            name: `${docRootPrefix}${docPath}`,
            fields: existing.fields,
            updateTime: existing.updateTime,
          }),
          { status: 200 }
        );
      }
      if (method === 'PATCH') {
        const parsed = JSON.parse(bodyText) as { fields?: Record<string, unknown> };
        const ts = new Date().toISOString();
        fsDocs.set(docPath, { fields: parsed.fields || {}, updateTime: ts });
        return new Response(JSON.stringify({ name: `${docRootPrefix}${docPath}`, updateTime: ts }), {
          status: 200,
        });
      }
    }

    throw new Error(`Unexpected unmocked fetch URL: ${urlStr}`);
  }) as typeof fetch;

  const restStore = new FirestoreRestStore({
    config: {
      projectId,
      firestoreDatabaseId: dbId,
      apiKey,
      authDomain: `${projectId}.firebaseapp.com`,
    },
    namespace: 'development',
    targetEnv: 'development',
    ownerEmail,
  });

  const serverWrapper = createAuthApp({ store: restStore, disableRateLimit: true });
  const server = http.createServer(serverWrapper.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. When Email/Password is disabled on Firebase Auth:
    //    - capabilities reports emailPasswordEnabled: false and emailDeliveryConfigured: false
    //    - signup/login/forgot-password return 503 AUTH_PROVIDER_DISABLED (never fake 200 or generic error)
    const capDisabledRes = await fetch(`${baseUrl}/api/auth/capabilities`);
    assert.equal(capDisabledRes.status, 200);
    const capDisabled = (await capDisabledRes.json()) as Record<string, unknown>;
    assert.equal(capDisabled.authMode, 'firebase_managed');
    assert.equal(capDisabled.firebaseProjectId, projectId);
    assert.equal(capDisabled.emailPasswordEnabled, false);
    assert.equal(capDisabled.emailDeliveryConfigured, false);
    assert.equal(capDisabled.providerStatusReason, 'PASSWORD_LOGIN_DISABLED');

    const boot = await fetch(`${baseUrl}/api/auth/session`);
    const cookie = boot.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const { csrfToken } = (await boot.json()) as { csrfToken: string };

    const regDisabled = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        fullName: 'Shopper One',
        email: customerEmail,
        password: 'ValidPassword#2026',
        confirmPassword: 'ValidPassword#2026',
      }),
    });
    assert.equal(regDisabled.status, 503);
    const regDisabledBody = (await regDisabled.json()) as { code?: string; error?: string };
    assert.equal(regDisabledBody.code, 'AUTH_PROVIDER_DISABLED');
    assert.match(regDisabledBody.error || '', /Email\/Password/i);

    const loginDisabled = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email: customerEmail, password: 'ValidPassword#2026' }),
    });
    assert.equal(loginDisabled.status, 503);
    assert.equal(((await loginDisabled.json()) as { code?: string }).code, 'AUTH_PROVIDER_DISABLED');

    const forgotDisabled = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email: customerEmail }),
    });
    assert.equal(forgotDisabled.status, 503);
    assert.equal(((await forgotDisabled.json()) as { code?: string }).code, 'AUTH_PROVIDER_DISABLED');

    const adminForgotDisabled = await fetch(`${baseUrl}/api/admin/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email: ownerEmail }),
    });
    assert.equal(adminForgotDisabled.status, 503);
    assert.equal(verifyDispatchCalls, 0, 'Must never report email sent when provider is disabled');

    // 2. Enable Email/Password in Firebase Auth -> ?refresh=1 immediately reports enabled: true
    emailPasswordEnabled = true;

    const capRefreshedRes = await fetch(`${baseUrl}/api/auth/capabilities?refresh=1`);
    assert.equal(capRefreshedRes.status, 200);
    const capRefreshed = (await capRefreshedRes.json()) as Record<string, unknown>;
    assert.equal(capRefreshed.emailPasswordEnabled, true);
    assert.equal(capRefreshed.emailDeliveryConfigured, true);
    assert.equal(capRefreshed.providerStatusReason, null);

    // Without cached token OR password -> 400 PASSWORD_REQUIRED_FOR_RESEND (never fake 200!)
    const resendNoPwd = await fetch(`${baseUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email: customerEmail }),
    });
    assert.equal(resendNoPwd.status, 400);
    assert.equal(
      ((await resendNoPwd.json()) as { code?: string }).code,
      'PASSWORD_REQUIRED_FOR_RESEND'
    );

    // Signup succeeds, marks acceptedByProvider + cooldownSeconds
    const regOk = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        fullName: 'Shopper One',
        email: customerEmail,
        password: 'ValidPassword#2026',
        confirmPassword: 'ValidPassword#2026',
      }),
    });
    assert.equal(regOk.status, 200);
    const regOkBody = (await regOk.json()) as {
      acceptedByProvider?: boolean;
      cooldownSeconds?: number;
    };
    assert.equal(regOkBody.acceptedByProvider, true);
    assert.equal(regOkBody.cooldownSeconds, 60);

    // Unverified login returns 403 EMAIL_NOT_VERIFIED and preserves cooldown
    const unverifiedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email: customerEmail, password: 'ValidPassword#2026' }),
    });
    assert.equal(unverifiedLogin.status, 403);
    assert.equal(((await unverifiedLogin.json()) as { code?: string }).code, 'EMAIL_NOT_VERIFIED');

    // Resend immediately after signup/unverified login hits 429 RESEND_COOLDOWN with retryAfterSeconds
    const resendCooldown = await fetch(`${baseUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email: customerEmail }),
    });
    assert.equal(resendCooldown.status, 429);
    const cooldownBody = (await resendCooldown.json()) as {
      code?: string;
      retryAfterSeconds?: number;
    };
    assert.equal(cooldownBody.code, 'RESEND_COOLDOWN');
    assert.ok(typeof cooldownBody.retryAfterSeconds === 'number' && cooldownBody.retryAfterSeconds > 0);

    // 3. Even a restarted server (no cached token) with a valid password resends or reports alreadyVerified
    const server2Wrapper = createAuthApp({ store: restStore, disableRateLimit: true });
    const server2 = http.createServer(server2Wrapper.app);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));
    const addr2 = server2.address();
    assert.ok(addr2 && typeof addr2 === 'object');
    const baseUrl2 = `http://127.0.0.1:${addr2.port}`;

    try {
      const resendWithPwd = await fetch(`${baseUrl2}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ email: customerEmail, password: 'ValidPassword#2026' }),
      });
      assert.equal(resendWithPwd.status, 200);
      assert.equal(((await resendWithPwd.json()) as { acceptedByProvider?: boolean }).acceptedByProvider, true);

      // Simulate verifying customer, then on a fresh server instance (no cached cooldown) confirm
      // resend-verification with password detects verified status and returns alreadyVerified: true
      const custUser = [...fbUsers.values()].find((u) => u.email === customerEmail)!;
      custUser.emailVerified = true;

      const server3Wrapper = createAuthApp({ store: restStore, disableRateLimit: true });
      const server3 = http.createServer(server3Wrapper.app);
      await new Promise<void>((resolve) => server3.listen(0, '127.0.0.1', () => resolve()));
      const addr3 = server3.address();
      assert.ok(addr3 && typeof addr3 === 'object');
      const baseUrl3 = `http://127.0.0.1:${addr3.port}`;

      try {
        const resendAfterVerify = await fetch(`${baseUrl3}/api/auth/resend-verification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ email: customerEmail, password: 'ValidPassword#2026' }),
        });
        assert.equal(resendAfterVerify.status, 200);
        assert.equal(
          ((await resendAfterVerify.json()) as { alreadyVerified?: boolean }).alreadyVerified,
          true
        );

        const custLogin = await fetch(`${baseUrl3}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ email: customerEmail, password: 'ValidPassword#2026' }),
        });
        assert.equal(custLogin.status, 200);
        const custCookies = custLogin.headers.getSetCookie();
        const custSessionCookie = custCookies.find((c) => c.startsWith('sc_fb_session='));
        assert.ok(custSessionCookie);
        const custCookiePair = custSessionCookie.split(';')[0];
        const custLoginJson = (await custLogin.json()) as {
          csrfToken: string;
          user: { isOwner: boolean };
        };
        assert.equal(custLoginJson.user.isOwner, false);

        // Customer logout revokes the Firebase session cookie server-side even on replay
        const custLogoutRes = await fetch(`${baseUrl3}/api/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: custCookiePair,
            'X-CSRF-Token': custLoginJson.csrfToken,
          },
          body: JSON.stringify({}),
        });
        assert.equal(custLogoutRes.status, 200);
        const logoutClearCookies = custLogoutRes.headers.getSetCookie();
        assert.ok(logoutClearCookies.some((c) => c.startsWith('sc_fb_session=;') && c.includes('Partitioned')));

        const replayCustProfile = await fetch(`${baseUrl3}/api/account/profile`, {
          headers: { Cookie: custCookiePair },
        });
        assert.equal(replayCustProfile.status, 401);

        const replayCustSession = await fetch(`${baseUrl3}/api/auth/session`, {
          headers: { Cookie: custCookiePair },
        });
        assert.equal(replayCustSession.status, 200);
        assert.equal(((await replayCustSession.json()) as { authenticated: boolean }).authenticated, false);

        // Signing back in cleanly issues a fresh working session without keeping old cookie valid
        const reLoginRes = await fetch(`${baseUrl3}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ email: customerEmail, password: 'ValidPassword#2026' }),
        });
        assert.equal(reLoginRes.status, 200);
        const newCustPair = reLoginRes.headers.getSetCookie().find((c) => c.startsWith('sc_fb_session='))!.split(';')[0];
        const newProfile = await fetch(`${baseUrl3}/api/account/profile`, {
          headers: { Cookie: newCustPair },
        });
        assert.equal(newProfile.status, 200);

        const oldReplayStillDead = await fetch(`${baseUrl3}/api/account/profile`, {
          headers: { Cookie: custCookiePair },
        });
        assert.equal(oldReplayStillDead.status, 401);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server3.close((e) => (e ? reject(e) : resolve()))
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server2.close((e) => (e ? reject(e) : resolve()))
      );
    }
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});




