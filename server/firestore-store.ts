import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  applicationDefault,
  cert,
  deleteApp,
  getApp,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { INITIAL_SEED_CATEGORIES, INITIAL_SEED_PRODUCTS } from './db.ts';
import type { FirebaseAppletConfig, RuntimeTargetEnv } from './env.ts';
import {
  slugifyProductTitle,
  StoreHttpError,
  type AdminBindingRow,
  type AdminOverviewData,
  type AdminProductQuery,
  type AdminProductRecord,
  type BoutiqueStore,
  type CategoryRow,
  type ContactMessageRow,
  type ContactMessageStatus,
  type EmailTokenRow,
  type LegacyPhoneOnlyAccount,
  type OrderItemRow,
  type OrderRow,
  type OrderWithItems,
  type PlaceOrderInput,
  type ProductAuditLogRow,
  type ProductImageRow,
  type ProductMediaRow,
  type ProductRow,
  type ProductStatus,
  type ProductVariantRow,
  type ProductWithParts,
  type SaveMediaFileInput,
  type SessionRow,
  type SiteSettingsData,
  type StorefrontContentData,
  type UserRow,
} from './store.ts';
import {
  extractReferencedMediaFilenames,
  mergeSiteSettings,
  mergeStorefrontContent,
} from './storefront-defaults.ts';

const INLINE_MEDIA_THRESHOLD_BYTES = 450_000;
const MEDIA_CHUNK_BYTES = 500_000;

interface FirestoreProductDoc {
  id: string;
  slug: string;
  title: string;
  description: string;
  fabric_note: string;
  category: string;
  sku: string;
  price_paise: number;
  compare_at_paise: number | null;
  stock_qty: number;
  low_stock_threshold: number;
  featured: boolean;
  status: ProductStatus;
  colors_json: string;
  sizes_json: string;
  version: number;
  published_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  variants: ProductVariantRow[];
  images: Array<{
    id: string;
    product_id: string;
    media_id: string | null;
    url: string;
    alt_text: string;
    is_cover: boolean;
    position: number;
    created_at: number;
  }>;
  variant_skus: string[];
  image_urls: string[];
}

interface FirestoreOrderDoc {
  id: string;
  order_number: string;
  customer_user_id: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  shipping_address: string;
  status: string;
  subtotal_paise: number;
  total_paise: number;
  currency: string;
  created_at: number;
  product_ids: string[];
  items: OrderItemRow[];
}

function parseServiceAccountFromEnv(rawValue: string): ServiceAccount {
  const trimmed = rawValue.trim();
  const decoded = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    throw new Error('Optional service-account credential payload is not valid JSON or base64 JSON.');
  }
  if (!parsed.project_id && !parsed.projectId) {
    throw new Error('Optional service-account credential payload is missing project_id.');
  }
  if (!parsed.client_email && !parsed.clientEmail) {
    throw new Error('Optional service-account credential payload is missing client_email.');
  }
  if (!parsed.private_key && !parsed.privateKey) {
    throw new Error('Optional service-account credential payload is missing private_key.');
  }
  return parsed as unknown as ServiceAccount;
}

export function initializeFirestoreHandle(config: FirebaseAppletConfig): {
  app: App;
  ownsApp: boolean;
  db: Firestore;
} {
  const appName = `sahithi-${config.projectId}-${config.firestoreDatabaseId}`;
  const existing = getApps().find((a) => a.name === appName);
  let app: App;
  let ownsApp = false;

  if (existing) {
    app = getApp(appName);
  } else {
    const rawSa = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    const gacPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();

    let credential;
    if (rawSa) {
      credential = cert(parseServiceAccountFromEnv(rawSa));
    } else if (gacPath && fs.existsSync(gacPath)) {
      const fileRaw = fs.readFileSync(gacPath, 'utf8');
      credential = cert(parseServiceAccountFromEnv(fileRaw));
    } else {
      credential = applicationDefault();
    }

    app = initializeApp(
      {
        credential,
        projectId: config.projectId,
        storageBucket: config.storageBucket,
      },
      appName
    );
    ownsApp = true;
  }

  const db = getFirestore(app, config.firestoreDatabaseId);
  return { app, ownsApp, db };
}

function toUserRow(data: Record<string, unknown>): UserRow {
  return {
    id: String(data.id),
    full_name: String(data.full_name || ''),
    email: typeof data.email === 'string' ? data.email : null,
    email_verified: data.email_verified ? 1 : 0,
    password_hash: typeof data.password_hash === 'string' ? data.password_hash : null,
    phone_e164: typeof data.phone_e164 === 'string' ? data.phone_e164 : null,
    phone_verified: data.phone_verified ? 1 : 0,
    created_at: Number(data.created_at || 0),
    updated_at: Number(data.updated_at || 0),
  };
}

function fromFirestoreProduct(doc: FirestoreProductDoc): ProductWithParts {
  const product: ProductRow = {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    description: doc.description,
    fabric_note: doc.fabric_note || '',
    category: doc.category,
    sku: doc.sku,
    price_paise: Number(doc.price_paise),
    compare_at_paise:
      typeof doc.compare_at_paise === 'number' ? doc.compare_at_paise : null,
    stock_qty: Number(doc.stock_qty),
    low_stock_threshold: Number(doc.low_stock_threshold ?? 5),
    featured: doc.featured ? 1 : 0,
    status: doc.status,
    colors_json: doc.colors_json || '[]',
    sizes_json: doc.sizes_json || '[]',
    version: Number(doc.version || 1),
    published_at: typeof doc.published_at === 'number' ? doc.published_at : null,
    archived_at: typeof doc.archived_at === 'number' ? doc.archived_at : null,
    created_at: Number(doc.created_at || 0),
    updated_at: Number(doc.updated_at || 0),
  };

  const variants: ProductVariantRow[] = (Array.isArray(doc.variants) ? doc.variants : [])
    .map((v) => ({
      id: String(v.id),
      product_id: doc.id,
      sku: String(v.sku),
      size: String(v.size),
      color_name: String(v.color_name),
      color_hex: String(v.color_hex),
      price_paise: Number(v.price_paise),
      compare_at_paise:
        typeof v.compare_at_paise === 'number' ? v.compare_at_paise : null,
      stock_qty: Number(v.stock_qty),
      position: Number(v.position || 0),
    }))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const images: ProductImageRow[] = (Array.isArray(doc.images) ? doc.images : [])
    .map((img) => ({
      id: String(img.id),
      product_id: doc.id,
      media_id: img.media_id ? String(img.media_id) : null,
      url: String(img.url),
      alt_text: String(img.alt_text || ''),
      is_cover: img.is_cover ? 1 : 0,
      position: Number(img.position || 0),
      created_at: Number(img.created_at || 0),
    }))
    .sort((a, b) => b.is_cover - a.is_cover || a.position - b.position || a.created_at - b.created_at);

  return { product, variants, images };
}

export class FirestoreBoutiqueStore implements BoutiqueStore {
  readonly backend = 'firestore' as const;
  readonly isPersistent = true;
  readonly locationLabel: string;
  readonly targetEnv: RuntimeTargetEnv;
  readonly namespace: string;

  private readonly firestore: Firestore;
  private readonly adminApp: App | null;
  private readonly ownsAdminApp: boolean;

  constructor(options: {
    config: FirebaseAppletConfig;
    namespace: string;
    targetEnv: RuntimeTargetEnv;
    firestoreOverride?: Firestore;
  }) {
    this.namespace = options.namespace;
    this.targetEnv = options.targetEnv;
    this.locationLabel = `firestore://${options.config.projectId}/${options.config.firestoreDatabaseId}/environments/${options.namespace}`;

    if (options.firestoreOverride) {
      this.firestore = options.firestoreOverride;
      this.adminApp = null;
      this.ownsAdminApp = false;
    } else {
      const handle = initializeFirestoreHandle(options.config);
      this.firestore = handle.db;
      this.adminApp = handle.app;
      this.ownsAdminApp = handle.ownsApp;
    }
  }

  private envDoc() {
    return this.firestore.collection('environments').doc(this.namespace);
  }

  private usersCol() {
    return this.envDoc().collection('users');
  }

  private sessionsCol() {
    return this.envDoc().collection('sessions');
  }

  private emailTokensCol() {
    return this.envDoc().collection('email_tokens');
  }

  private bindingsCol() {
    return this.envDoc().collection('admin_bindings');
  }

  private productsCol() {
    return this.envDoc().collection('products');
  }

  private mediaCol() {
    return this.envDoc().collection('product_media');
  }

  private ordersCol() {
    return this.envDoc().collection('orders');
  }

  private auditCol() {
    return this.envDoc().collection('product_audit_logs');
  }

  private categoriesCol() {
    return this.envDoc().collection('categories');
  }

  private siteDocsCol() {
    return this.envDoc().collection('site_documents');
  }

  private messagesCol() {
    return this.envDoc().collection('contact_messages');
  }

  async verifyConnectivity(): Promise<void> {
    await Promise.all([
      this.bindingsCol().doc('owner').get(),
      this.productsCol().limit(1).get(),
    ]);
  }

  async close(): Promise<void> {
    if (this.ownsAdminApp && this.adminApp) {
      await deleteApp(this.adminApp).catch(() => {});
    }
  }

  async getUserById(id: string): Promise<UserRow | null> {
    const snap = await this.usersCol().doc(id).get();
    if (!snap.exists) return null;
    return toUserRow(snap.data() as Record<string, unknown>);
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const normalized = email.trim().toLowerCase();
    const snap = await this.usersCol().where('email', '==', normalized).limit(1).get();
    if (snap.empty) return null;
    return toUserRow(snap.docs[0].data() as Record<string, unknown>);
  }

  async isEmailTakenByOtherUser(email: string, excludeUserId: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    const snap = await this.usersCol().where('email', '==', normalized).limit(5).get();
    return snap.docs.some((d) => d.id !== excludeUserId);
  }

  async createPendingEmailUser(input: {
    id: string;
    fullName: string;
    email: string;
    passwordHash: string;
    now: number;
  }): Promise<UserRow> {
    const normalized = input.email.trim().toLowerCase();
    const docData = {
      id: input.id,
      full_name: input.fullName,
      email: normalized,
      email_verified: false,
      password_hash: input.passwordHash,
      phone_e164: null,
      phone_verified: false,
      created_at: input.now,
      updated_at: input.now,
    };

    await this.firestore.runTransaction(async (tx) => {
      const dupSnap = await tx.get(this.usersCol().where('email', '==', normalized).limit(1));
      if (!dupSnap.empty) {
        throw new StoreHttpError(409, 'EMAIL_EXISTS', 'Account already exists for this email.');
      }
      tx.set(this.usersCol().doc(input.id), docData);
    });

    return toUserRow(docData);
  }

  async updatePendingEmailUser(input: {
    id: string;
    fullName: string;
    passwordHash: string;
    now: number;
  }): Promise<UserRow | null> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.usersCol().doc(input.id);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const data = snap.data() as Record<string, unknown>;
      if (data.email_verified) {
        return toUserRow(data);
      }
      const patch = {
        full_name: input.fullName,
        password_hash: input.passwordHash,
        updated_at: input.now,
      };
      tx.update(ref, patch);
      return toUserRow({ ...data, ...patch });
    });
  }

  async markUserEmailVerified(userId: string, now: number): Promise<UserRow> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.usersCol().doc(userId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(`User ${userId} not found.`);
      }
      const patch = { email_verified: true, updated_at: now };
      tx.update(ref, patch);
      return toUserRow({ ...(snap.data() as Record<string, unknown>), ...patch });
    });
  }

  async linkVerifiedEmailToUser(userId: string, newEmail: string, now: number): Promise<UserRow> {
    const normalized = newEmail.trim().toLowerCase();
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.usersCol().doc(userId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(`User ${userId} not found.`);
      }
      const patch = {
        email: normalized,
        email_verified: true,
        updated_at: now,
      };
      tx.update(ref, patch);
      return toUserRow({ ...(snap.data() as Record<string, unknown>), ...patch });
    });
  }

  async updateUserFullName(userId: string, fullName: string, now: number): Promise<UserRow> {
    const ref = this.usersCol().doc(userId);
    await ref.update({ full_name: fullName, updated_at: now });
    const updated = await this.getUserById(userId);
    if (!updated) throw new Error(`User ${userId} not found.`);
    return updated;
  }

  async updateUserPasswordHash(userId: string, passwordHash: string, now: number): Promise<void> {
    await this.usersCol().doc(userId).update({ password_hash: passwordHash, updated_at: now });
  }

  async listLegacyPhoneOnlyAccounts(): Promise<LegacyPhoneOnlyAccount[]> {
    const snap = await this.usersCol().where('phone_e164', '!=', null).get();
    return snap.docs
      .map((d) => toUserRow(d.data() as Record<string, unknown>))
      .filter((u) => u.phone_e164 && (!u.email || !u.email_verified || !u.password_hash))
      .sort((a, b) => a.created_at - b.created_at)
      .map((u) => ({
        id: u.id,
        full_name: u.full_name,
        created_at: u.created_at,
      }));
  }

  async getActiveSessionByTokenHash(tokenHash: string, now: number): Promise<SessionRow | null> {
    const snap = await this.sessionsCol().where('token_hash', '==', tokenHash).limit(1).get();
    if (snap.empty) return null;
    const row = snap.docs[0].data() as SessionRow;
    if (row.revoked_at !== null || row.expires_at <= now) return null;
    return row;
  }

  async createSession(session: SessionRow): Promise<SessionRow> {
    await this.sessionsCol().doc(session.id).set(session);
    return session;
  }

  async updateSessionReauth(sessionId: string, lastReauthAt: number): Promise<void> {
    await this.sessionsCol().doc(sessionId).update({ last_reauth_at: lastReauthAt });
  }

  async revokeSession(sessionId: string, now: number): Promise<void> {
    await this.sessionsCol().doc(sessionId).update({ revoked_at: now });
  }

  async revokeUserSessions(userId: string, now: number, exceptSessionId?: string): Promise<void> {
    const snap = await this.sessionsCol().where('user_id', '==', userId).get();
    const targets = snap.docs.filter((d) => {
      const data = d.data() as SessionRow;
      return data.revoked_at === null && (!exceptSessionId || d.id !== exceptSessionId);
    });
    if (targets.length === 0) return;

    const batch = this.firestore.batch();
    for (const doc of targets) {
      batch.update(doc.ref, { revoked_at: now });
    }
    await batch.commit();
  }

  async createEmailToken(params: {
    id: string;
    userId: string;
    purpose: EmailTokenRow['purpose'];
    targetEmail: string;
    tokenHash: string;
    expiresAt: number;
    createdAt: number;
    invalidatePreviousSamePurpose?: boolean;
  }): Promise<EmailTokenRow> {
    if (params.invalidatePreviousSamePurpose !== false) {
      const prevSnap = await this.emailTokensCol()
        .where('user_id', '==', params.userId)
        .where('purpose', '==', params.purpose)
        .get();
      const unconsumed = prevSnap.docs.filter((d) => (d.data() as EmailTokenRow).consumed_at === null);
      if (unconsumed.length > 0) {
        const batch = this.firestore.batch();
        for (const doc of unconsumed) {
          batch.update(doc.ref, { consumed_at: params.createdAt });
        }
        await batch.commit();
      }
    }

    const row: EmailTokenRow = {
      id: params.id,
      user_id: params.userId,
      purpose: params.purpose,
      target_email: params.targetEmail.trim().toLowerCase(),
      token_hash: params.tokenHash,
      expires_at: params.expiresAt,
      consumed_at: null,
      created_at: params.createdAt,
    };
    await this.emailTokensCol().doc(row.id).set(row);
    return row;
  }

  async deleteEmailToken(tokenId: string): Promise<void> {
    await this.emailTokensCol().doc(tokenId).delete();
  }

  async getLatestVerifyEmailTokenTimestamp(userId: string): Promise<number | null> {
    const snap = await this.emailTokensCol()
      .where('user_id', '==', userId)
      .where('purpose', '==', 'verify_email')
      .get();
    if (snap.empty) return null;
    let latest = 0;
    for (const doc of snap.docs) {
      const created = Number((doc.data() as EmailTokenRow).created_at || 0);
      if (created > latest) latest = created;
    }
    return latest > 0 ? latest : null;
  }

  async getEmailTokenByHash(
    tokenHash: string,
    purposes: EmailTokenRow['purpose'][]
  ): Promise<EmailTokenRow | null> {
    const snap = await this.emailTokensCol().where('token_hash', '==', tokenHash).limit(1).get();
    if (snap.empty) return null;
    const row = snap.docs[0].data() as EmailTokenRow;
    if (!purposes.includes(row.purpose)) return null;
    return row;
  }

  async consumeEmailToken(tokenId: string, now: number): Promise<boolean> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.emailTokensCol().doc(tokenId);
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = snap.data() as EmailTokenRow;
      if (data.consumed_at !== null) return false;
      tx.update(ref, { consumed_at: now });
      return true;
    });
  }

  async getStoredAdminBinding(): Promise<AdminBindingRow | null> {
    const snap = await this.bindingsCol().doc('owner').get();
    if (!snap.exists) return null;
    const data = snap.data() as Record<string, unknown>;
    return {
      id: 1,
      owner_user_id: String(data.owner_user_id),
      bound_email: String(data.bound_email),
      bound_at: Number(data.bound_at || 0),
      bound_via: String(data.bound_via || 'server_cli'),
    };
  }

  async resolveBoundOwner(): Promise<AdminBindingRow | null> {
    const row = await this.getStoredAdminBinding();
    if (!row) return null;

    const envOwnerEmail = (process.env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase();
    const boundUser = await this.getUserById(row.owner_user_id);
    if (!boundUser || !boundUser.email_verified) {
      return null;
    }
    if (envOwnerEmail && (boundUser.email || '').trim().toLowerCase() !== envOwnerEmail) {
      return null;
    }

    return row;
  }

  async bindOwnerAccount(params: {
    email: string;
    boundVia?: string;
    forceRebind?: boolean;
  }): Promise<AdminBindingRow> {
    const normalizedEmail = params.email.trim().toLowerCase();

    return this.firestore.runTransaction(async (tx) => {
      const userSnap = await tx.get(
        this.usersCol().where('email', '==', normalizedEmail).limit(2)
      );
      if (userSnap.empty) {
        throw new Error(
          `No account exists for ${normalizedEmail}. Please register and verify this email first via /signup.`
        );
      }

      const user = toUserRow(userSnap.docs[0].data() as Record<string, unknown>);
      if (!user.email_verified) {
        throw new Error(
          `Account ${normalizedEmail} exists (id=${user.id}) but email ownership is not verified yet.`
        );
      }
      if (!user.password_hash) {
        throw new Error(`Account ${normalizedEmail} does not have a password configured.`);
      }

      const bindingRef = this.bindingsCol().doc('owner');
      const existingSnap = await tx.get(bindingRef);
      if (existingSnap.exists) {
        const existingData = existingSnap.data() as Record<string, unknown>;
        const existingId = String(existingData.owner_user_id || '');
        if (existingId && existingId !== user.id && !params.forceRebind) {
          throw new Error(
            `An owner is already bound to user ID ${existingId}. Pass --force only if replacing ownership intentionally.`
          );
        }
      }

      const now = Date.now();
      const via = params.boundVia || 'server_cli';
      const nextBinding: AdminBindingRow = {
        id: 1,
        owner_user_id: user.id,
        bound_email: normalizedEmail,
        bound_at: now,
        bound_via: via,
      };
      tx.set(bindingRef, nextBinding);
      return nextBinding;
    });
  }

  async seedInitialCatalogIfEmpty(): Promise<void> {
    const existingSnap = await this.productsCol().limit(1).get();
    if (!existingSnap.empty) return;

    const batch = this.firestore.batch();
    batch.set(
      this.envDoc(),
      { targetEnv: this.targetEnv, namespace: this.namespace, updatedAt: Date.now() },
      { merge: true }
    );

    for (const item of INITIAL_SEED_PRODUCTS) {
      const ts = new Date(`${item.dateAdded}T10:00:00Z`).getTime() || Date.now();
      const pricePaise = Math.round(item.priceInr * 100);
      const compareAtPaise = item.compareAtInr ? Math.round(item.compareAtInr * 100) : null;

      let totalStock = 0;
      const variants: ProductVariantRow[] = [];
      let pos = 0;
      for (const size of item.sizes) {
        for (const color of item.colors) {
          const stockQty = item.defaultVariantStock;
          totalStock += stockQty;
          const colorCode = color.name
            .replace(/[^a-zA-Z0-9]/g, '')
            .slice(0, 3)
            .toUpperCase();
          const sizeCode = size.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
          variants.push({
            id: `${item.id}-v-${pos + 1}`,
            product_id: item.id,
            sku: `${item.sku}-${sizeCode}-${colorCode}-${pos + 1}`,
            size,
            color_name: color.name,
            color_hex: color.hex,
            price_paise: pricePaise,
            compare_at_paise: compareAtPaise,
            stock_qty: stockQty,
            position: pos,
          });
          pos += 1;
        }
      }

      const images = item.images.map((img, idx) => ({
        id: crypto.randomUUID(),
        product_id: item.id,
        media_id: null,
        url: img.url,
        alt_text: img.alt,
        is_cover: idx === 0,
        position: idx,
        created_at: ts,
      }));

      const docData: FirestoreProductDoc = {
        id: item.id,
        slug: item.slug,
        title: item.title,
        description: item.description,
        fabric_note: item.fabricNote,
        category: item.category,
        sku: item.sku,
        price_paise: pricePaise,
        compare_at_paise: compareAtPaise,
        stock_qty: totalStock,
        low_stock_threshold: 5,
        featured: item.featured,
        status: 'published',
        colors_json: JSON.stringify(item.colors),
        sizes_json: JSON.stringify(item.sizes),
        version: 1,
        published_at: ts,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
        variants,
        images,
        variant_skus: variants.map((v) => v.sku),
        image_urls: images.map((i) => i.url),
      };

      batch.create(this.productsCol().doc(item.id), docData);
    }

    try {
      await batch.commit();
    } catch {
      // Safe if another worker seeded concurrently
    }
  }

  private async getOrderCountsByProductId(): Promise<Map<string, number>> {
    const snap = await this.ordersCol().get();
    const counts = new Map<string, number>();
    for (const doc of snap.docs) {
      const order = doc.data() as FirestoreOrderDoc;
      for (const item of order.items || []) {
        counts.set(item.product_id, (counts.get(item.product_id) || 0) + 1);
      }
    }
    return counts;
  }

  async listPublicProducts(filters: {
    category?: string;
    q?: string;
    featuredOnly?: boolean;
  }): Promise<ProductWithParts[]> {
    const snap = await this.productsCol().where('status', '==', 'published').get();
    let docs = snap.docs.map((d) => fromFirestoreProduct(d.data() as FirestoreProductDoc));

    docs.sort(
      (a, b) =>
        (b.product.published_at || 0) - (a.product.published_at || 0) ||
        b.product.created_at - a.product.created_at
    );

    if (filters.category && filters.category !== 'All') {
      docs = docs.filter((r) => r.product.category === filters.category);
    }
    if (filters.featuredOnly) {
      docs = docs.filter((r) => Boolean(r.product.featured));
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      docs = docs.filter(
        (r) =>
          r.product.title.toLowerCase().includes(q) ||
          r.product.category.toLowerCase().includes(q) ||
          r.product.description.toLowerCase().includes(q) ||
          r.product.fabric_note.toLowerCase().includes(q) ||
          r.product.colors_json.toLowerCase().includes(q)
      );
    }
    return docs;
  }

  async getPublicProductByIdOrSlug(idOrSlug: string): Promise<ProductWithParts | null> {
    const byId = await this.productsCol().doc(idOrSlug).get();
    if (byId.exists) {
      const parsed = fromFirestoreProduct(byId.data() as FirestoreProductDoc);
      if (parsed.product.status === 'published') return parsed;
    }

    const bySlug = await this.productsCol()
      .where('slug', '==', idOrSlug)
      .where('status', '==', 'published')
      .limit(1)
      .get();
    if (bySlug.empty) return null;
    return fromFirestoreProduct(bySlug.docs[0].data() as FirestoreProductDoc);
  }

  async isProductSkuConflict(sku: string, excludeProductId?: string): Promise<boolean> {
    const snap = await this.productsCol().where('sku', '==', sku).limit(5).get();
    return snap.docs.some((d) => d.id !== excludeProductId);
  }

  async isVariantSkuConflict(sku: string, excludeProductId?: string): Promise<boolean> {
    const snap = await this.productsCol()
      .where('variant_skus', 'array-contains', sku)
      .limit(5)
      .get();
    return snap.docs.some((d) => d.id !== excludeProductId);
  }

  async makeUniqueSlug(baseTitle: string, excludeId?: string): Promise<string> {
    const base = slugifyProductTitle(baseTitle);
    let candidate = base;
    let counter = 2;
    while (true) {
      const snap = await this.productsCol().where('slug', '==', candidate).limit(2).get();
      const conflict = snap.docs.some((d) => d.id !== excludeId);
      if (!conflict) return candidate;
      candidate = `${base}-${counter}`;
      counter += 1;
    }
  }

  async getAdminOverview(): Promise<AdminOverviewData> {
    const [prodSnap, catList, ordersSnap, auditSnap, msgSnap] = await Promise.all([
      this.productsCol().get(),
      this.listCategories(),
      this.ordersCol().get(),
      this.auditCol().get(),
      this.messagesCol().get(),
    ]);

    const orderCounts = new Map<string, number>();
    let pendingOrders = 0;
    let totalRevenuePaise = 0;
    const allOrders: OrderWithItems[] = [];

    for (const oDoc of ordersSnap.docs) {
      const orderDoc = oDoc.data() as FirestoreOrderDoc;
      if (orderDoc.status === 'pending') pendingOrders += 1;
      if (orderDoc.status !== 'cancelled') {
        totalRevenuePaise += Number(orderDoc.total_paise || 0);
      }
      for (const item of orderDoc.items || []) {
        orderCounts.set(item.product_id, (orderCounts.get(item.product_id) || 0) + 1);
      }
      const { product_ids: _p, items: lineItems, ...orderRow } = orderDoc;
      allOrders.push({ order: orderRow, items: lineItems || [] });
    }
    allOrders.sort((a, b) => b.order.created_at - a.order.created_at);

    const allMessages = msgSnap.docs
      .map((d) => d.data() as ContactMessageRow)
      .sort((a, b) => b.created_at - a.created_at);
    const unreadMessages = allMessages.filter((m) => m.status === 'unread').length;

    const recentAuditLogs = auditSnap.docs
      .map((d) => d.data() as ProductAuditLogRow)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 6);

    const all = prodSnap.docs.map((d) => fromFirestoreProduct(d.data() as FirestoreProductDoc));
    let publishedProducts = 0;
    let draftProducts = 0;
    let archivedProducts = 0;
    let lowStockProducts = 0;
    let outOfStockProducts = 0;
    const lowStockList: ProductWithParts[] = [];

    for (const item of all) {
      const p = item.product;
      if (p.status === 'published') publishedProducts += 1;
      else if (p.status === 'draft') draftProducts += 1;
      else if (p.status === 'archived') archivedProducts += 1;

      if (p.status !== 'archived' && p.stock_qty <= p.low_stock_threshold) {
        lowStockProducts += 1;
        lowStockList.push(item);
      }
      if (p.status !== 'archived' && p.stock_qty === 0) {
        outOfStockProducts += 1;
      }
    }

    lowStockList.sort(
      (a, b) => a.product.stock_qty - b.product.stock_qty || b.product.updated_at - a.product.updated_at
    );

    return {
      metrics: {
        totalProducts: all.length,
        publishedProducts,
        draftProducts,
        archivedProducts,
        lowStockProducts,
        outOfStockProducts,
        totalCategories: catList.length,
        totalOrders: ordersSnap.size,
        pendingOrders,
        totalRevenuePaise,
        unreadMessages,
        totalMessages: allMessages.length,
        totalAuditEvents: auditSnap.size,
      },
      lowStockItems: lowStockList.slice(0, 6).map((item) => ({
        ...item,
        orderCount: orderCounts.get(item.product.id) || 0,
      })),
      recentOrders: allOrders.slice(0, 5),
      recentMessages: allMessages.slice(0, 5),
      recentAuditLogs,
    };
  }

  async listAdminProducts(query: AdminProductQuery) {
    const [prodSnap, orderCounts] = await Promise.all([
      this.productsCol().get(),
      this.getOrderCountsByProductId(),
    ]);

    let items = prodSnap.docs.map((d) => fromFirestoreProduct(d.data() as FirestoreProductDoc));

    if (query.status && query.status !== 'all') {
      items = items.filter((r) => r.product.status === query.status);
    }
    if (query.category && query.category !== 'All') {
      items = items.filter((r) => r.product.category === query.category);
    }
    if (query.stockFilter === 'low') {
      items = items.filter(
        (r) => r.product.stock_qty <= r.product.low_stock_threshold && r.product.stock_qty > 0
      );
    } else if (query.stockFilter === 'out') {
      items = items.filter((r) => r.product.stock_qty === 0);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      items = items.filter(
        (r) =>
          r.product.title.toLowerCase().includes(q) ||
          r.product.sku.toLowerCase().includes(q) ||
          r.product.category.toLowerCase().includes(q)
      );
    }

    items.sort((a, b) => {
      switch (query.sort) {
        case 'newest':
          return b.product.created_at - a.product.created_at;
        case 'price_asc':
          return a.product.price_paise - b.product.price_paise;
        case 'price_desc':
          return b.product.price_paise - a.product.price_paise;
        case 'stock_asc':
          return a.product.stock_qty - b.product.stock_qty;
        case 'updated':
        default:
          return b.product.updated_at - a.product.updated_at;
      }
    });

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const safePage = Math.min(query.page, totalPages);
    const start = (safePage - 1) * query.pageSize;
    const slice = items.slice(start, start + query.pageSize);

    return {
      items: slice.map((item) => ({
        ...item,
        orderCount: orderCounts.get(item.product.id) || 0,
      })),
      total,
      page: safePage,
      pageSize: query.pageSize,
      totalPages,
    };
  }

  async getAdminProduct(id: string) {
    const [prodSnap, ordersSnap, auditSnap] = await Promise.all([
      this.productsCol().doc(id).get(),
      this.ordersCol().where('product_ids', 'array-contains', id).get(),
      this.auditCol().where('product_id', '==', id).get(),
    ]);

    if (!prodSnap.exists) return null;
    const parsed = fromFirestoreProduct(prodSnap.data() as FirestoreProductDoc);

    let orderCount = 0;
    for (const oDoc of ordersSnap.docs) {
      const order = oDoc.data() as FirestoreOrderDoc;
      orderCount += (order.items || []).filter((it) => it.product_id === id).length;
    }

    const auditLogs = auditSnap.docs
      .map((d) => d.data() as ProductAuditLogRow)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20);

    return {
      data: {
        ...parsed,
        orderCount,
      },
      auditLogs,
    };
  }

  async createProduct(input: {
    product: ProductRow;
    variants: ProductVariantRow[];
    images: Array<{ mediaId: string | null; url: string; alt: string; isCover: boolean }>;
    actorUserId: string;
    auditAction: string;
    auditSummary: string;
    auditAfter: unknown;
  }): Promise<AdminProductRecord> {
    const p = input.product;
    const images = input.images.map((img, idx) => ({
      id: crypto.randomUUID(),
      product_id: p.id,
      media_id: img.mediaId,
      url: img.url,
      alt_text: img.alt,
      is_cover: Boolean(img.isCover),
      position: idx,
      created_at: p.created_at,
    }));

    const docData: FirestoreProductDoc = {
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
      variants: input.variants,
      images,
      variant_skus: input.variants.map((v) => v.sku),
      image_urls: images.map((i) => i.url),
    };

    const auditDoc: ProductAuditLogRow = {
      id: crypto.randomUUID(),
      product_id: p.id,
      product_title: p.title,
      actor_user_id: input.actorUserId,
      action: input.auditAction,
      summary: input.auditSummary,
      before_json: null,
      after_json: input.auditAfter !== undefined ? JSON.stringify(input.auditAfter) : null,
      created_at: p.created_at,
    };

    const batch = this.firestore.batch();
    batch.create(this.productsCol().doc(p.id), docData);
    batch.set(this.auditCol().doc(auditDoc.id), auditDoc);
    await batch.commit();

    return {
      ...fromFirestoreProduct(docData),
      orderCount: 0,
    };
  }

  async updateProduct(input: {
    productId: string;
    expectedVersion: number;
    nextSlug: string;
    title: string;
    description: string;
    fabricNote: string;
    category: string;
    sku: string;
    pricePaise: number;
    compareAtPaise: number | null;
    totalStock: number;
    lowStockThreshold: number;
    featured: boolean;
    nextStatus: ProductStatus;
    colorsJson: string;
    sizesJson: string;
    publishedAtIfNull: number | null;
    now: number;
    variants: ProductVariantRow[];
    images: Array<{ mediaId: string | null; url: string; alt: string; isCover: boolean }>;
    actorUserId: string;
    auditAction: string;
    auditSummary: string;
    auditBefore: unknown;
    auditAfter: unknown;
  }) {
    const result = await this.firestore.runTransaction(async (tx) => {
      const ref = this.productsCol().doc(input.productId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
      }

      const existing = snap.data() as FirestoreProductDoc;
      if (Number(existing.version) !== input.expectedVersion) {
        return { ok: false as const, code: 'VERSION_CONFLICT' as const };
      }

      const images = input.images.map((img, idx) => ({
        id: crypto.randomUUID(),
        product_id: existing.id,
        media_id: img.mediaId,
        url: img.url,
        alt_text: img.alt,
        is_cover: Boolean(img.isCover),
        position: idx,
        created_at: input.now,
      }));

      const updatedDoc: FirestoreProductDoc = {
        ...existing,
        slug: input.nextSlug,
        title: input.title,
        description: input.description,
        fabric_note: input.fabricNote,
        category: input.category,
        sku: input.sku,
        price_paise: input.pricePaise,
        compare_at_paise: input.compareAtPaise,
        stock_qty: input.totalStock,
        low_stock_threshold: input.lowStockThreshold,
        featured: Boolean(input.featured),
        status: input.nextStatus,
        colors_json: input.colorsJson,
        sizes_json: input.sizesJson,
        version: existing.version + 1,
        published_at:
          typeof existing.published_at === 'number'
            ? existing.published_at
            : input.publishedAtIfNull,
        archived_at:
          input.nextStatus === 'archived'
            ? (typeof existing.archived_at === 'number' ? existing.archived_at : input.now)
            : null,
        updated_at: input.now,
        variants: input.variants,
        images,
        variant_skus: input.variants.map((v) => v.sku),
        image_urls: images.map((i) => i.url),
      };

      const auditDoc: ProductAuditLogRow = {
        id: crypto.randomUUID(),
        product_id: existing.id,
        product_title: input.title,
        actor_user_id: input.actorUserId,
        action: input.auditAction,
        summary: input.auditSummary,
        before_json: input.auditBefore !== undefined ? JSON.stringify(input.auditBefore) : null,
        after_json: input.auditAfter !== undefined ? JSON.stringify(input.auditAfter) : null,
        created_at: input.now,
      };

      tx.set(ref, updatedDoc);
      tx.set(this.auditCol().doc(auditDoc.id), auditDoc);
      return { ok: true as const, doc: updatedDoc };
    });

    if (!result.ok) {
      return result;
    }

    const ordersSnap = await this.ordersCol()
      .where('product_ids', 'array-contains', input.productId)
      .get();
    let orderCount = 0;
    for (const oDoc of ordersSnap.docs) {
      const order = oDoc.data() as FirestoreOrderDoc;
      orderCount += (order.items || []).filter((it) => it.product_id === input.productId).length;
    }

    return {
      ok: true as const,
      product: {
        ...fromFirestoreProduct(result.doc),
        orderCount,
      },
    };
  }

  async duplicateProduct(sourceId: string, actorUserId: string): Promise<AdminProductRecord | null> {
    const snap = await this.productsCol().doc(sourceId).get();
    if (!snap.exists) return null;
    const source = fromFirestoreProduct(snap.data() as FirestoreProductDoc);

    const now = Date.now();
    const newId = `sc-${crypto.randomBytes(4).toString('hex')}`;
    const copyTitle = `${source.product.title} (Copy)`.slice(0, 140);
    const copySlug = await this.makeUniqueSlug(copyTitle);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const copySku = `${source.product.sku.slice(0, 38)}-COPY-${suffix}`;

    const variants: ProductVariantRow[] = source.variants.map((v, idx) => ({
      id: crypto.randomUUID(),
      product_id: newId,
      sku: `${copySku}-${idx + 1}`,
      size: v.size,
      color_name: v.color_name,
      color_hex: v.color_hex,
      price_paise: v.price_paise,
      compare_at_paise: v.compare_at_paise,
      stock_qty: v.stock_qty,
      position: v.position,
    }));

    const images = source.images.map((img) => ({
      id: crypto.randomUUID(),
      product_id: newId,
      media_id: img.media_id,
      url: img.url,
      alt_text: img.alt_text,
      is_cover: Boolean(img.is_cover),
      position: img.position,
      created_at: now,
    }));

    const docData: FirestoreProductDoc = {
      id: newId,
      slug: copySlug,
      title: copyTitle,
      description: source.product.description,
      fabric_note: source.product.fabric_note,
      category: source.product.category,
      sku: copySku,
      price_paise: source.product.price_paise,
      compare_at_paise: source.product.compare_at_paise,
      stock_qty: source.product.stock_qty,
      low_stock_threshold: source.product.low_stock_threshold,
      featured: false,
      status: 'draft',
      colors_json: source.product.colors_json,
      sizes_json: source.product.sizes_json,
      version: 1,
      published_at: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      variants,
      images,
      variant_skus: variants.map((v) => v.sku),
      image_urls: images.map((i) => i.url),
    };

    const auditDoc: ProductAuditLogRow = {
      id: crypto.randomUUID(),
      product_id: newId,
      product_title: copyTitle,
      actor_user_id: actorUserId,
      action: 'duplicate',
      summary: `Duplicated "${source.product.title}" into draft "${copyTitle}".`,
      before_json: JSON.stringify({ sourceProductId: source.product.id }),
      after_json: JSON.stringify({ newProductId: newId, status: 'draft' }),
      created_at: now,
    };

    const batch = this.firestore.batch();
    batch.create(this.productsCol().doc(newId), docData);
    batch.set(this.auditCol().doc(auditDoc.id), auditDoc);
    await batch.commit();

    return {
      ...fromFirestoreProduct(docData),
      orderCount: 0,
    };
  }

  async transitionProductStatus(input: {
    productId: string;
    expectedVersion: number;
    targetStatus: ProductStatus;
    actionName: 'publish' | 'unpublish' | 'archive' | 'restore';
    actorUserId: string;
  }) {
    const result = await this.firestore.runTransaction(async (tx) => {
      const ref = this.productsCol().doc(input.productId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
      }

      const existing = snap.data() as FirestoreProductDoc;
      if (Number(existing.version) !== input.expectedVersion) {
        return { ok: false as const, code: 'VERSION_CONFLICT' as const };
      }
      if (input.targetStatus === 'published' && (!existing.images || existing.images.length === 0)) {
        return { ok: false as const, code: 'NO_IMAGES' as const };
      }

      const now = Date.now();
      const updatedDoc: FirestoreProductDoc = {
        ...existing,
        status: input.targetStatus,
        published_at:
          input.targetStatus === 'published'
            ? typeof existing.published_at === 'number'
              ? existing.published_at
              : now
            : existing.published_at,
        archived_at: input.targetStatus === 'archived' ? now : null,
        version: existing.version + 1,
        updated_at: now,
      };

      const auditDoc: ProductAuditLogRow = {
        id: crypto.randomUUID(),
        product_id: existing.id,
        product_title: existing.title,
        actor_user_id: input.actorUserId,
        action: input.actionName,
        summary: `${input.actionName.charAt(0).toUpperCase() + input.actionName.slice(1)}ed "${existing.title}" (${existing.status} -> ${input.targetStatus}).`,
        before_json: JSON.stringify({ status: existing.status, version: existing.version }),
        after_json: JSON.stringify({ status: input.targetStatus, version: existing.version + 1 }),
        created_at: now,
      };

      tx.set(ref, updatedDoc);
      tx.set(this.auditCol().doc(auditDoc.id), auditDoc);
      return { ok: true as const, doc: updatedDoc };
    });

    if (!result.ok) return result;

    const ordersSnap = await this.ordersCol()
      .where('product_ids', 'array-contains', input.productId)
      .get();
    let orderCount = 0;
    for (const oDoc of ordersSnap.docs) {
      const order = oDoc.data() as FirestoreOrderDoc;
      orderCount += (order.items || []).filter((it) => it.product_id === input.productId).length;
    }

    return {
      ok: true as const,
      product: {
        ...fromFirestoreProduct(result.doc),
        orderCount,
      },
    };
  }

  async deleteOrArchiveProduct(productId: string, actorUserId: string) {
    const ordersSnap = await this.ordersCol()
      .where('product_ids', 'array-contains', productId)
      .get();
    let orderCount = 0;
    for (const oDoc of ordersSnap.docs) {
      const order = oDoc.data() as FirestoreOrderDoc;
      orderCount += (order.items || []).filter((it) => it.product_id === productId).length;
    }

    return this.firestore.runTransaction(async (tx) => {
      const ref = this.productsCol().doc(productId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
      }
      const existing = snap.data() as FirestoreProductDoc;
      const now = Date.now();

      if (orderCount > 0) {
        const updatedDoc: FirestoreProductDoc = {
          ...existing,
          status: 'archived',
          archived_at: now,
          version: existing.version + 1,
          updated_at: now,
        };
        const auditDoc: ProductAuditLogRow = {
          id: crypto.randomUUID(),
          product_id: existing.id,
          product_title: existing.title,
          actor_user_id: actorUserId,
          action: 'archive',
          summary: `Archived "${existing.title}" instead of deleting because it is referenced by ${orderCount} order item(s).`,
          before_json: JSON.stringify({ status: existing.status }),
          after_json: JSON.stringify({ status: 'archived' }),
          created_at: now,
        };
        tx.set(ref, updatedDoc);
        tx.set(this.auditCol().doc(auditDoc.id), auditDoc);
        return {
          ok: true as const,
          archivedInsteadOfDeleted: true,
          product: {
            ...fromFirestoreProduct(updatedDoc),
            orderCount,
          },
        };
      }

      const auditDoc: ProductAuditLogRow = {
        id: crypto.randomUUID(),
        product_id: existing.id,
        product_title: existing.title,
        actor_user_id: actorUserId,
        action: 'delete',
        summary: `Permanently deleted unused product "${existing.title}" (SKU: ${existing.sku}).`,
        before_json: JSON.stringify({ status: existing.status, sku: existing.sku }),
        after_json: null,
        created_at: now,
      };
      tx.delete(ref);
      tx.set(this.auditCol().doc(auditDoc.id), auditDoc);
      return { ok: true as const, archivedInsteadOfDeleted: false };
    });
  }

  async findMediaByFilename(filename: string): Promise<{ id: string } | null> {
    const snap = await this.mediaCol().doc(filename).get();
    if (!snap.exists) return null;
    const data = snap.data() as Record<string, unknown>;
    return { id: String(data.id) };
  }

  async saveMediaFiles(files: SaveMediaFileInput[]): Promise<void> {
    for (const file of files) {
      const buf = Buffer.from(file.data);
      const docRef = this.mediaCol().doc(file.filename);

      if (buf.byteLength <= INLINE_MEDIA_THRESHOLD_BYTES) {
        await docRef.set({
          id: file.id,
          filename: file.filename,
          mime_type: file.mimeType,
          byte_size: file.byteSize,
          sha256: file.sha256,
          chunk_count: 0,
          inline_b64: buf.toString('base64'),
          uploaded_by_user_id: file.uploadedByUserId,
          created_at: file.createdAt,
        });
      } else {
        const chunks: string[] = [];
        for (let offset = 0; offset < buf.byteLength; offset += MEDIA_CHUNK_BYTES) {
          chunks.push(buf.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64'));
        }
        const batch = this.firestore.batch();
        chunks.forEach((b64, index) => {
          batch.set(docRef.collection('chunks').doc(String(index).padStart(4, '0')), {
            index,
            b64,
          });
        });
        batch.set(docRef, {
          id: file.id,
          filename: file.filename,
          mime_type: file.mimeType,
          byte_size: file.byteSize,
          sha256: file.sha256,
          chunk_count: chunks.length,
          inline_b64: null,
          uploaded_by_user_id: file.uploadedByUserId,
          created_at: file.createdAt,
        });
        await batch.commit();
      }
    }
  }

  async getMediaWithPublicStatus(filename: string): Promise<{
    media: ProductMediaRow;
    isLinkedToPublished: boolean;
  } | null> {
    const mediaRef = this.mediaCol().doc(filename);
    const snap = await mediaRef.get();
    if (!snap.exists) return null;
    const data = snap.data() as Record<string, unknown>;

    let rawData: Uint8Array;
    if (typeof data.inline_b64 === 'string' && data.inline_b64.length > 0) {
      rawData = Buffer.from(data.inline_b64, 'base64');
    } else {
      const chunksSnap = await mediaRef.collection('chunks').get();
      const sorted = chunksSnap.docs
        .map((d) => d.data() as { index: number; b64: string })
        .sort((a, b) => a.index - b.index);
      rawData = Buffer.concat(sorted.map((c) => Buffer.from(c.b64, 'base64')));
    }

    const mediaUrl = `/api/media/${filename}`;
    const pubSnap = await this.productsCol()
      .where('status', '==', 'published')
      .where('image_urls', 'array-contains', mediaUrl)
      .limit(1)
      .get();

    let isPublic = !pubSnap.empty;
    if (!isPublic) {
      const catSnap = await this.categoriesCol().where('image_url', '==', mediaUrl).limit(1).get();
      if (!catSnap.empty) {
        isPublic = true;
      }
    }
    if (!isPublic) {
      const [settings, content] = await Promise.all([
        this.getSiteSettings(),
        this.getStorefrontContent(),
      ]);
      const referencedFiles = extractReferencedMediaFilenames(settings, content);
      isPublic = referencedFiles.has(filename);
    }

    return {
      media: {
        id: String(data.id),
        filename: String(data.filename),
        mime_type: String(data.mime_type),
        byte_size: Number(data.byte_size || rawData.byteLength),
        sha256: String(data.sha256 || ''),
        data: rawData,
        uploaded_by_user_id: String(data.uploaded_by_user_id || ''),
        created_at: Number(data.created_at || 0),
      },
      isLinkedToPublished: isPublic,
    };
  }

  async getProductsForCartValidation(productIds: string[]): Promise<Map<string, ProductWithParts>> {
    const map = new Map<string, ProductWithParts>();
    const unique = Array.from(new Set(productIds)).filter(Boolean);
    const snaps = await Promise.all(unique.map((pid) => this.productsCol().doc(pid).get()));
    for (const snap of snaps) {
      if (snap.exists) {
        map.set(snap.id, fromFirestoreProduct(snap.data() as FirestoreProductDoc));
      }
    }
    return map;
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
    const uniqueProductIds = Array.from(new Set(input.items.map((i) => i.productId)));

    return this.firestore.runTransaction(async (tx) => {
      // Firestore requires all reads before writes inside a transaction
      const productSnaps = new Map<string, FirestoreProductDoc>();
      for (const pid of uniqueProductIds) {
        const snap = await tx.get(this.productsCol().doc(pid));
        if (snap.exists) {
          productSnaps.set(pid, snap.data() as FirestoreProductDoc);
        }
      }

      let subtotalPaise = 0;
      const now = Date.now();
      const orderId = crypto.randomUUID();
      const orderNumber = `SC-${new Date(now).getUTCFullYear()}-${crypto
        .randomBytes(3)
        .toString('hex')
        .toUpperCase()}`;

      const createdItems: OrderItemRow[] = [];
      const touchedDocs = new Map<string, FirestoreProductDoc>();

      for (const raw of input.items) {
        const currentDoc = touchedDocs.get(raw.productId) || productSnaps.get(raw.productId);
        if (!currentDoc || currentDoc.status !== 'published') {
          throw new StoreHttpError(
            409,
            'PRODUCT_UNAVAILABLE',
            `"${currentDoc?.title || 'One of the items'}" is no longer available in the storefront.`
          );
        }

        const clonedVariants = currentDoc.variants.map((v) => ({ ...v }));
        const sortedVariants = [...clonedVariants].sort((a, b) => a.position - b.position);
        const variantIdx = raw.variantId
          ? clonedVariants.findIndex((v) => v.id === raw.variantId)
          : clonedVariants.findIndex((v) => v.id === sortedVariants[0]?.id);

        if (variantIdx === -1) {
          throw new StoreHttpError(
            409,
            'VARIANT_UNAVAILABLE',
            `Selected option for "${currentDoc.title}" is no longer available.`
          );
        }

        const variant = clonedVariants[variantIdx];
        if (raw.expectedPricePaise !== null && raw.expectedPricePaise !== variant.price_paise) {
          throw new StoreHttpError(
            409,
            'PRICE_CHANGED',
            `The price for "${currentDoc.title}" (${variant.size} · ${variant.color_name}) recently changed to ₹${(
              variant.price_paise / 100
            ).toLocaleString('en-IN')}. Please review your bag and confirm.`
          );
        }

        if (variant.stock_qty < raw.quantity) {
          throw new StoreHttpError(
            409,
            'INSUFFICIENT_STOCK',
            variant.stock_qty === 0
              ? `"${currentDoc.title}" (${variant.size} · ${variant.color_name}) is currently out of stock.`
              : `Only ${variant.stock_qty} unit(s) left for "${currentDoc.title}" (${variant.size} · ${variant.color_name}).`
          );
        }

        variant.stock_qty -= raw.quantity;
        const newTotalStock = clonedVariants.reduce((sum, v) => sum + v.stock_qty, 0);
        touchedDocs.set(raw.productId, {
          ...currentDoc,
          variants: clonedVariants,
          stock_qty: newTotalStock,
          updated_at: now,
        });

        const lineTotalPaise = variant.price_paise * raw.quantity;
        subtotalPaise += lineTotalPaise;

        createdItems.push({
          id: crypto.randomUUID(),
          order_id: orderId,
          product_id: currentDoc.id,
          variant_id: variant.id,
          product_title: currentDoc.title,
          variant_label: `${variant.size} · ${variant.color_name}`,
          sku: variant.sku,
          unit_price_paise: variant.price_paise,
          quantity: raw.quantity,
          line_total_paise: lineTotalPaise,
        });
      }

      for (const [pid, updatedDoc] of touchedDocs.entries()) {
        tx.set(this.productsCol().doc(pid), updatedDoc);
      }

      const orderDoc: FirestoreOrderDoc = {
        id: orderId,
        order_number: orderNumber,
        customer_user_id: input.customerUserId,
        customer_name: input.customerName,
        customer_email: input.customerEmail,
        customer_phone: input.customerPhone,
        shipping_address: input.shippingAddress,
        status: 'pending',
        subtotal_paise: subtotalPaise,
        total_paise: subtotalPaise,
        currency: 'INR',
        created_at: now,
        product_ids: Array.from(new Set(createdItems.map((it) => it.product_id))),
        items: createdItems,
      };

      tx.set(this.ordersCol().doc(orderId), orderDoc);

      const { product_ids: _pIds, items: _items, ...orderRow } = orderDoc;
      return { order: orderRow, items: createdItems };
    });
  }

  async listAdminOrders(page: number, pageSize: number) {
    const snap = await this.ordersCol().get();
    const all = snap.docs
      .map((d) => d.data() as FirestoreOrderDoc)
      .sort((a, b) => b.created_at - a.created_at);

    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const slice = all.slice((safePage - 1) * pageSize, safePage * pageSize);

    const items: OrderWithItems[] = slice.map((doc) => {
      const { product_ids: _p, items: lineItems, ...orderRow } = doc;
      return { order: orderRow, items: lineItems || [] };
    });

    return { items, total, page: safePage, pageSize, totalPages };
  }

  async updateOrderStatus(orderId: string, nextStatus: string): Promise<boolean> {
    const ref = this.ordersCol().doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.update({ status: nextStatus });
    return true;
  }

  async listAuditLogs(params: { productId?: string; page: number; pageSize: number }) {
    const snap = params.productId
      ? await this.auditCol().where('product_id', '==', params.productId).get()
      : await this.auditCol().get();

    const logs = snap.docs
      .map((d) => d.data() as ProductAuditLogRow)
      .sort((a, b) => b.created_at - a.created_at);

    const total = logs.length;
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const safePage = Math.min(params.page, totalPages);
    const slice = logs.slice((safePage - 1) * params.pageSize, safePage * params.pageSize);

    return {
      items: slice,
      total,
      page: safePage,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  private async ensureDefaultCategoriesSeeded(): Promise<void> {
    const existing = await this.categoriesCol().limit(1).get();
    if (!existing.empty) return;

    const now = Date.now();
    const batch = this.firestore.batch();
    for (const cat of INITIAL_SEED_CATEGORIES) {
      const doc: CategoryRow = {
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        subtitle: cat.subtitle,
        image_url: cat.imageUrl,
        alt_text: cat.altText,
        position: cat.position,
        created_at: now,
        updated_at: now,
      };
      batch.set(this.categoriesCol().doc(cat.id), doc);
    }
    await batch.commit().catch(() => {});
  }

  async listCategories(): Promise<CategoryRow[]> {
    await this.ensureDefaultCategoriesSeeded();
    const snap = await this.categoriesCol().get();
    return snap.docs
      .map((d) => d.data() as CategoryRow)
      .sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  }

  async getCategoryById(id: string): Promise<CategoryRow | null> {
    await this.ensureDefaultCategoriesSeeded();
    const snap = await this.categoriesCol().doc(id).get();
    if (!snap.exists) return null;
    return snap.data() as CategoryRow;
  }

  async createCategory(input: {
    name: string;
    subtitle: string;
    imageUrl: string;
    altText: string;
    position?: number;
  }): Promise<CategoryRow> {
    const existingList = await this.listCategories();
    const cleanName = input.name.trim();
    if (existingList.some((c) => c.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new StoreHttpError(
        409,
        'CATEGORY_EXISTS',
        `A category named "${cleanName}" already exists.`
      );
    }

    const baseSlug = slugifyProductTitle(cleanName);
    let slug = baseSlug;
    let counter = 2;
    const usedIds = new Set(existingList.map((c) => c.id));
    while (usedIds.has(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    const maxPos = existingList.reduce((acc, c) => Math.max(acc, c.position), -1);
    const now = Date.now();
    const row: CategoryRow = {
      id: slug,
      name: cleanName,
      slug,
      subtitle: input.subtitle.trim(),
      image_url: input.imageUrl.trim(),
      alt_text: input.altText.trim(),
      position:
        typeof input.position === 'number' && Number.isFinite(input.position)
          ? Math.max(0, Math.round(input.position))
          : maxPos + 1,
      created_at: now,
      updated_at: now,
    };

    await this.categoriesCol().doc(row.id).set(row);
    return row;
  }

  async updateCategory(
    id: string,
    input: {
      name: string;
      subtitle: string;
      imageUrl: string;
      altText: string;
      position?: number;
    }
  ): Promise<CategoryRow | null> {
    const existingList = await this.listCategories();
    const existing = existingList.find((c) => c.id === id);
    if (!existing) return null;

    const cleanName = input.name.trim();
    if (existingList.some((c) => c.id !== id && c.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new StoreHttpError(
        409,
        'CATEGORY_EXISTS',
        `Another category named "${cleanName}" already exists.`
      );
    }

    const now = Date.now();
    const updated: CategoryRow = {
      ...existing,
      name: cleanName,
      subtitle: input.subtitle.trim(),
      image_url: input.imageUrl.trim(),
      alt_text: input.altText.trim(),
      position:
        typeof input.position === 'number' && Number.isFinite(input.position)
          ? Math.max(0, Math.round(input.position))
          : existing.position,
      updated_at: now,
    };

    await this.categoriesCol().doc(id).set(updated);

    if (existing.name !== cleanName) {
      const prodSnap = await this.productsCol().where('category', '==', existing.name).get();
      if (!prodSnap.empty) {
        const batch = this.firestore.batch();
        for (const doc of prodSnap.docs) {
          batch.update(doc.ref, { category: cleanName, updated_at: now });
        }
        await batch.commit();
      }

      const content = await this.getStorefrontContent();
      let changed = false;
      if (content.spotlightEdit.targetCategory === existing.name) {
        content.spotlightEdit.targetCategory = cleanName;
        changed = true;
      }
      content.lookbookEntries = content.lookbookEntries.map((entry) => {
        if (entry.category === existing.name) {
          changed = true;
          return { ...entry, category: cleanName };
        }
        return entry;
      });
      if (changed) {
        await this.saveStorefrontContent(content);
      }
    }

    return updated;
  }

  async deleteCategory(id: string) {
    const existing = await this.getCategoryById(id);
    if (!existing) {
      return { ok: false as const, code: 'NOT_FOUND' as const };
    }

    const prodSnap = await this.productsCol().where('category', '==', existing.name).get();
    if (!prodSnap.empty) {
      return {
        ok: false as const,
        code: 'CATEGORY_IN_USE' as const,
        productCount: prodSnap.size,
      };
    }

    await this.categoriesCol().doc(id).delete();
    return { ok: true as const };
  }

  async getSiteSettings(): Promise<SiteSettingsData> {
    const snap = await this.siteDocsCol().doc('site_settings').get();
    if (!snap.exists) {
      return mergeSiteSettings(null);
    }
    const raw = snap.data() as { data?: Partial<SiteSettingsData> };
    return mergeSiteSettings(raw?.data || (raw as unknown as Partial<SiteSettingsData>));
  }

  async saveSiteSettings(settings: SiteSettingsData): Promise<SiteSettingsData> {
    const normalized = mergeSiteSettings(settings);
    await this.siteDocsCol().doc('site_settings').set({
      key: 'site_settings',
      data: normalized,
      updated_at: Date.now(),
    });
    return normalized;
  }

  async getStorefrontContent(): Promise<StorefrontContentData> {
    const snap = await this.siteDocsCol().doc('site_content').get();
    if (!snap.exists) {
      return mergeStorefrontContent(null);
    }
    const raw = snap.data() as { data?: Partial<StorefrontContentData> };
    return mergeStorefrontContent(raw?.data || (raw as unknown as Partial<StorefrontContentData>));
  }

  async saveStorefrontContent(content: StorefrontContentData): Promise<StorefrontContentData> {
    const normalized = mergeStorefrontContent(content);
    await this.siteDocsCol().doc('site_content').set({
      key: 'site_content',
      data: normalized,
      updated_at: Date.now(),
    });
    return normalized;
  }

  async createContactMessage(input: {
    senderName: string;
    senderEmail: string;
    senderPhone: string;
    subject: string;
    message: string;
  }): Promise<ContactMessageRow> {
    const now = Date.now();
    const row: ContactMessageRow = {
      id: crypto.randomUUID(),
      sender_name: input.senderName.trim(),
      sender_email: input.senderEmail.trim().toLowerCase(),
      sender_phone: input.senderPhone.trim(),
      subject: input.subject.trim(),
      message: input.message.trim(),
      status: 'unread',
      admin_note: '',
      created_at: now,
      updated_at: now,
    };
    await this.messagesCol().doc(row.id).set(row);
    return row;
  }

  async listAdminMessages(params: {
    status?: string;
    q?: string;
    page: number;
    pageSize: number;
  }) {
    const snap = await this.messagesCol().get();
    const all = snap.docs
      .map((d) => d.data() as ContactMessageRow)
      .sort((a, b) => b.created_at - a.created_at);
    const unreadCount = all.filter((m) => m.status === 'unread').length;

    let filtered = all;
    if (params.status && params.status !== 'all') {
      filtered = filtered.filter((m) => m.status === params.status);
    }
    if (params.q) {
      const q = params.q.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.sender_name.toLowerCase().includes(q) ||
          m.sender_email.toLowerCase().includes(q) ||
          m.sender_phone.toLowerCase().includes(q) ||
          m.subject.toLowerCase().includes(q) ||
          m.message.toLowerCase().includes(q)
      );
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
    const safePage = Math.min(params.page, totalPages);
    const slice = filtered.slice((safePage - 1) * params.pageSize, safePage * params.pageSize);

    return {
      items: slice,
      total,
      unreadCount,
      page: safePage,
      pageSize: params.pageSize,
      totalPages,
    };
  }

  async updateContactMessage(
    id: string,
    patch: { status?: ContactMessageStatus; adminNote?: string }
  ): Promise<ContactMessageRow | null> {
    const ref = this.messagesCol().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const existing = snap.data() as ContactMessageRow;
    const updated: ContactMessageRow = {
      ...existing,
      status: patch.status ?? existing.status,
      admin_note:
        typeof patch.adminNote === 'string' ? patch.adminNote.trim() : existing.admin_note,
      updated_at: Date.now(),
    };
    await ref.set(updated);
    return updated;
  }

  async deleteContactMessage(id: string): Promise<boolean> {
    const ref = this.messagesCol().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }
}
