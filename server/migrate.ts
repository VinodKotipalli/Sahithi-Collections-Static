import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Firestore } from 'firebase-admin/firestore';
import {
  type AdminBindingRow,
  type EmailTokenRow,
  type OrderItemRow,
  type OrderRow,
  type ProductAuditLogRow,
  type ProductImageRow,
  type ProductMediaRow,
  type ProductRow,
  type ProductVariantRow,
  type SessionRow,
  type UserRow,
} from './db.ts';
import { resolveRuntimeTarget, type RuntimeTargetEnv } from './env.ts';
import { initializeFirestoreHandle } from './firestore-store.ts';

export interface MigrationSummary {
  backupPath: string;
  targetEnv: RuntimeTargetEnv;
  namespace: string;
  usersCreated: number;
  usersSkippedExisting: number;
  sessionsCreated: number;
  emailTokensCreated: number;
  ownerBindingCreated: boolean;
  ownerBindingSkippedConflict: boolean;
  productsCreated: number;
  productsSkippedExisting: number;
  mediaCreated: number;
  ordersCreated: number;
  auditLogsCreated: number;
}

const INLINE_MEDIA_THRESHOLD_BYTES = 450_000;
const MEDIA_CHUNK_BYTES = 500_000;

export function createSqliteBackup(sqlitePath: string, backupDir?: string): string {
  const resolvedSource = path.resolve(sqlitePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Source SQLite database not found at ${resolvedSource}.`);
  }

  const targetDir = path.resolve(backupDir || path.join(path.dirname(resolvedSource), 'backups'));
  fs.mkdirSync(targetDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(targetDir, `sahithi_auth-${stamp}.db`);

  // Flush WAL cleanly into a single self-contained backup via SQLite VACUUM INTO
  const db = new DatabaseSync(resolvedSource, { readOnly: false });
  try {
    const escapedPath = backupFile.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedPath}';`);
  } finally {
    db.close();
  }

  return backupFile;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

async function createDocIfAbsent(
  ref: FirebaseFirestore.DocumentReference,
  data: Record<string, unknown>
): Promise<boolean> {
  try {
    await ref.create(data);
    return true;
  } catch (err) {
    const code = (err as { code?: number | string })?.code;
    const msg = err instanceof Error ? err.message : '';
    if (code === 6 || code === 'already-exists' || /ALREADY_EXISTS/i.test(msg)) {
      return false;
    }
    throw err;
  }
}

export async function backupAndMigrateSqliteToFirestore(params: {
  sqlitePath: string;
  firestore: Firestore;
  namespace: string;
  targetEnv: RuntimeTargetEnv;
  backupDir?: string;
}): Promise<MigrationSummary> {
  const backupPath = createSqliteBackup(params.sqlitePath, params.backupDir);
  const envDoc = params.firestore.collection('environments').doc(params.namespace);
  await envDoc.set(
    { targetEnv: params.targetEnv, namespace: params.namespace, updatedAt: Date.now() },
    { merge: true }
  );

  const summary: MigrationSummary = {
    backupPath,
    targetEnv: params.targetEnv,
    namespace: params.namespace,
    usersCreated: 0,
    usersSkippedExisting: 0,
    sessionsCreated: 0,
    emailTokensCreated: 0,
    ownerBindingCreated: false,
    ownerBindingSkippedConflict: false,
    productsCreated: 0,
    productsSkippedExisting: 0,
    mediaCreated: 0,
    ordersCreated: 0,
    auditLogsCreated: 0,
  };

  const db = new DatabaseSync(path.resolve(params.sqlitePath), { readOnly: true });
  try {
    // 1. Users (never overwrite existing records, preserve exact immutable IDs)
    if (tableExists(db, 'users')) {
      const users = db.prepare(`SELECT * FROM users`).all() as unknown as UserRow[];
      for (const u of users) {
        const created = await createDocIfAbsent(envDoc.collection('users').doc(u.id), {
          id: u.id,
          full_name: u.full_name,
          email: u.email,
          email_verified: Boolean(u.email_verified),
          password_hash: u.password_hash,
          phone_e164: u.phone_e164,
          phone_verified: Boolean(u.phone_verified),
          created_at: u.created_at,
          updated_at: u.updated_at,
        });
        if (created) summary.usersCreated += 1;
        else summary.usersSkippedExisting += 1;
      }
    }

    // 2. Active non-expired sessions
    if (tableExists(db, 'sessions')) {
      const now = Date.now();
      const sessions = db
        .prepare(`SELECT * FROM sessions WHERE revoked_at IS NULL AND expires_at > ?`)
        .all(now) as unknown as SessionRow[];
      for (const s of sessions) {
        const created = await createDocIfAbsent(
          envDoc.collection('sessions').doc(s.id),
          s as unknown as Record<string, unknown>
        );
        if (created) summary.sessionsCreated += 1;
      }
    }

    // 3. Unconsumed, unexpired email tokens
    if (tableExists(db, 'email_tokens')) {
      const now = Date.now();
      const tokens = db
        .prepare(`SELECT * FROM email_tokens WHERE consumed_at IS NULL AND expires_at > ?`)
        .all(now) as unknown as EmailTokenRow[];
      for (const t of tokens) {
        const created = await createDocIfAbsent(
          envDoc.collection('email_tokens').doc(t.id),
          t as unknown as Record<string, unknown>
        );
        if (created) summary.emailTokensCreated += 1;
      }
    }

    // 4. Owner binding (non-destructive: skip if binding already exists in Firestore)
    if (tableExists(db, 'admin_bindings')) {
      const binding = db
        .prepare(`SELECT * FROM admin_bindings WHERE id = 1 LIMIT 1`)
        .get() as AdminBindingRow | undefined;
      if (binding) {
        const created = await createDocIfAbsent(
          envDoc.collection('admin_bindings').doc('owner'),
          binding as unknown as Record<string, unknown>
        );
        if (created) summary.ownerBindingCreated = true;
        else summary.ownerBindingSkippedConflict = true;
      }
    }

    // 5. Media blobs
    if (tableExists(db, 'product_media')) {
      const mediaRows = db.prepare(`SELECT * FROM product_media`).all() as unknown as ProductMediaRow[];
      for (const m of mediaRows) {
        const docRef = envDoc.collection('product_media').doc(m.filename);
        const existing = await docRef.get();
        if (existing.exists) continue;

        const buf = Buffer.from(m.data);
        if (buf.byteLength <= INLINE_MEDIA_THRESHOLD_BYTES) {
          await docRef.create({
            id: m.id,
            filename: m.filename,
            mime_type: m.mime_type,
            byte_size: m.byte_size,
            sha256: m.sha256,
            chunk_count: 0,
            inline_b64: buf.toString('base64'),
            uploaded_by_user_id: m.uploaded_by_user_id,
            created_at: m.created_at,
          });
        } else {
          const chunks: string[] = [];
          for (let offset = 0; offset < buf.byteLength; offset += MEDIA_CHUNK_BYTES) {
            chunks.push(buf.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64'));
          }
          const batch = params.firestore.batch();
          chunks.forEach((b64, index) => {
            batch.set(docRef.collection('chunks').doc(String(index).padStart(4, '0')), {
              index,
              b64,
            });
          });
          batch.create(docRef, {
            id: m.id,
            filename: m.filename,
            mime_type: m.mime_type,
            byte_size: m.byte_size,
            sha256: m.sha256,
            chunk_count: chunks.length,
            inline_b64: null,
            uploaded_by_user_id: m.uploaded_by_user_id,
            created_at: m.created_at,
          });
          await batch.commit();
        }
        summary.mediaCreated += 1;
      }
    }

    // 6. Products + variants + images
    if (tableExists(db, 'products')) {
      const products = db.prepare(`SELECT * FROM products`).all() as unknown as ProductRow[];
      const getVariants = tableExists(db, 'product_variants')
        ? db.prepare(`SELECT * FROM product_variants WHERE product_id = ? ORDER BY position ASC`)
        : null;
      const getImages = tableExists(db, 'product_images')
        ? db.prepare(`SELECT * FROM product_images WHERE product_id = ? ORDER BY is_cover DESC, position ASC`)
        : null;

      for (const p of products) {
        const variants = getVariants
          ? (getVariants.all(p.id) as unknown as ProductVariantRow[])
          : [];
        const rawImages = getImages
          ? (getImages.all(p.id) as unknown as ProductImageRow[])
          : [];
        const images = rawImages.map((img) => ({
          ...img,
          is_cover: Boolean(img.is_cover),
        }));

        const created = await createDocIfAbsent(envDoc.collection('products').doc(p.id), {
          id: p.id,
          slug: p.slug,
          title: p.title,
          description: p.description,
          fabric_note: p.fabric_note,
          category: p.category,
          sku: p.sku,
          price_paise: p.price_paise,
          compare_at_paise: p.compare_at_paise,
          stock_qty: p.stock_qty,
          low_stock_threshold: p.low_stock_threshold,
          featured: Boolean(p.featured),
          status: p.status,
          colors_json: p.colors_json,
          sizes_json: p.sizes_json,
          version: p.version,
          published_at: p.published_at,
          archived_at: p.archived_at,
          created_at: p.created_at,
          updated_at: p.updated_at,
          variants,
          images,
          variant_skus: variants.map((v) => v.sku),
          image_urls: images.map((i) => i.url),
        });
        if (created) summary.productsCreated += 1;
        else summary.productsSkippedExisting += 1;
      }
    }

    // 7. Orders & order_items
    if (tableExists(db, 'orders')) {
      const orders = db.prepare(`SELECT * FROM orders`).all() as unknown as OrderRow[];
      const getItems = tableExists(db, 'order_items')
        ? db.prepare(`SELECT * FROM order_items WHERE order_id = ?`)
        : null;

      for (const o of orders) {
        const items = getItems ? (getItems.all(o.id) as unknown as OrderItemRow[]) : [];
        const created = await createDocIfAbsent(envDoc.collection('orders').doc(o.id), {
          ...o,
          product_ids: Array.from(new Set(items.map((it) => it.product_id))),
          items,
        });
        if (created) summary.ordersCreated += 1;
      }
    }

    // 8. Product audit logs
    if (tableExists(db, 'product_audit_logs')) {
      const logs = db
        .prepare(`SELECT * FROM product_audit_logs`)
        .all() as unknown as ProductAuditLogRow[];
      for (const log of logs) {
        const created = await createDocIfAbsent(
          envDoc.collection('product_audit_logs').doc(log.id),
          log as unknown as Record<string, unknown>
        );
        if (created) summary.auditLogsCreated += 1;
      }
    }

    // 9. Categories
    if (tableExists(db, 'categories')) {
      const cats = db.prepare(`SELECT * FROM categories`).all() as unknown as Array<
        Record<string, unknown>
      >;
      for (const cat of cats) {
        await createDocIfAbsent(envDoc.collection('categories').doc(String(cat.id)), cat);
      }
    }

    // 10. Site settings & editorial content
    if (tableExists(db, 'site_documents')) {
      const docs = db.prepare(`SELECT * FROM site_documents`).all() as unknown as Array<{
        key: string;
        data_json: string;
        updated_at: number;
      }>;
      for (const doc of docs) {
        try {
          const parsed = JSON.parse(doc.data_json) as Record<string, unknown>;
          await createDocIfAbsent(envDoc.collection('site_documents').doc(doc.key), {
            key: doc.key,
            data: parsed,
            updated_at: doc.updated_at,
          });
        } catch {
          // ignore malformed JSON row
        }
      }
    }

    // 11. Contact messages
    if (tableExists(db, 'contact_messages')) {
      const msgs = db.prepare(`SELECT * FROM contact_messages`).all() as unknown as Array<
        Record<string, unknown>
      >;
      for (const msg of msgs) {
        await createDocIfAbsent(envDoc.collection('contact_messages').doc(String(msg.id)), msg);
      }
    }
  } finally {
    db.close();
  }

  return summary;
}

async function runCli() {
  const cfg = resolveRuntimeTarget(process.env);
  if (!cfg.firebaseConfig) {
    throw new Error(
      'firebase-applet-config.json was not found. Provision Firebase before migrating to Firestore.'
    );
  }
  if (cfg.credentialSource === 'none') {
    throw new Error(
      `No runtime ADC identity or optional service-account credential was detected. Run inside a Google Cloud / Cloud Run runtime whose service account has roles/datastore.user on project "${cfg.firebaseConfig.projectId}", or run "gcloud auth application-default login".`
    );
  }

  const handle = initializeFirestoreHandle(cfg.firebaseConfig);
  try {
    await Promise.all([
      handle.db
        .collection('environments')
        .doc(cfg.firestoreNamespace)
        .collection('admin_bindings')
        .doc('owner')
        .get(),
      handle.db
        .collection('environments')
        .doc(cfg.firestoreNamespace)
        .collection('products')
        .limit(1)
        .get(),
    ]);

    const result = await backupAndMigrateSqliteToFirestore({
      sqlitePath: cfg.sqliteDbPath,
      firestore: handle.db,
      namespace: cfg.firestoreNamespace,
      targetEnv: cfg.targetEnv,
    });
    console.log('[db-migrate] Backup & non-destructive migration completed:');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (handle.ownsApp) {
      const { deleteApp } = await import('firebase-admin/app');
      await deleteApp(handle.app).catch(() => {});
    }
  }
}

const isEntrypoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  runCli().catch((err) => {
    console.error(
      '[db-migrate] Failed:',
      err instanceof Error ? err.message : 'Unable to complete migration.'
    );
    process.exit(1);
  });
}
