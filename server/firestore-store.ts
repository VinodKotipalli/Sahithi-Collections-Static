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
  type CouponRow,
  type CustomerAddressRow,
  type CustomerNotificationRow,
  type CustomerPaymentMethodRow,
  type EmailTokenRow,
  type GiftCardRow,
  type LegacyPhoneOnlyAccount,
  type LoyaltyConfigData,
  type NotificationPreferencesData,
  type OrderItemRow,
  type OrderReturnRequestRecord,
  type OrderRow,
  type OrderStatusHistoryEntry,
  type OrderWithItems,
  type PendingCheckoutRow,
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
  type StoreUserSummary,
  type UserRow,
} from './store.ts';
import {
  extractReferencedMediaFilenames,
  mergeLoyaltyConfig,
  mergeSiteSettings,
  mergeStorefrontContent,
} from './storefront-defaults.ts';
import {
  normalizeOrderRequestsAndStatus,
  parseNotificationPrefs,
  parseOrderHistory,
  PRE_CUTOFF_DELIVERY_EDIT_STATES,
  PRE_SHIPPING_CANCEL_STATES,
  RETURN_ELIGIBLE_STATES,
  validateNonSensitivePaymentMethodInput,
} from './order-utils.ts';

const INLINE_MEDIA_THRESHOLD_BYTES = 450_000;
const MEDIA_CHUNK_BYTES = 500_000;

interface FirestoreProductDoc {
  id: string;
  slug: string;
  title: string;
  description: string;
  fabric_note: string;
  included_pieces?: string;
  care_note?: string;
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
  import_key?: string | null;
  source_image_filename?: string | null;
  pending_fields_json?: string | null;
  catalog_batch?: string | null;
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
  payment_status?: string;
  fulfillment_status?: string;
  payment_method?: string;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
  coupon_code?: string | null;
  gift_card_code?: string | null;
  discount_paise?: number;
  gift_card_paise?: number;
  status_history_json?: string;
  cancel_request_json?: string | null;
  return_request_json?: string | null;
  hidden_by_customer?: boolean | number;
  hidden_at?: number | null;
  stock_restored_at?: number | null;
  delivery_details_edited_at?: number | null;
  idempotency_key?: string | null;
  payment_collected_at?: number | null;
  payment_collected_by?: string | null;
  subtotal_paise: number;
  total_paise: number;
  currency: string;
  created_at: number;
  updated_at?: number;
  product_ids: string[];
  items: OrderItemRow[];
}

function normalizeFirestoreOrderRow(doc: FirestoreOrderDoc): OrderRow {
  return {
    id: doc.id,
    order_number: doc.order_number,
    customer_user_id: doc.customer_user_id ?? null,
    customer_name: doc.customer_name,
    customer_email: doc.customer_email,
    customer_phone: doc.customer_phone,
    shipping_address: doc.shipping_address,
    status: doc.status,
    payment_status:
      doc.payment_status ?? (doc.razorpay_payment_id ? 'paid' : 'unpaid'),
    fulfillment_status: doc.fulfillment_status ?? doc.status ?? 'placed',
    payment_method:
      doc.payment_method ?? (doc.razorpay_order_id || doc.razorpay_payment_id ? 'razorpay' : 'cod'),
    razorpay_order_id: doc.razorpay_order_id ?? null,
    razorpay_payment_id: doc.razorpay_payment_id ?? null,
    coupon_code: doc.coupon_code ?? null,
    gift_card_code: doc.gift_card_code ?? null,
    discount_paise: Number(doc.discount_paise || 0),
    gift_card_paise: Number(doc.gift_card_paise || 0),
    status_history_json: doc.status_history_json || '[]',
    cancel_request_json: doc.cancel_request_json ?? null,
    return_request_json: doc.return_request_json ?? null,
    hidden_by_customer: doc.hidden_by_customer ? 1 : 0,
    hidden_at: typeof doc.hidden_at === 'number' ? doc.hidden_at : null,
    stock_restored_at:
      typeof doc.stock_restored_at === 'number' ? doc.stock_restored_at : null,
    delivery_details_edited_at:
      typeof doc.delivery_details_edited_at === 'number' ? doc.delivery_details_edited_at : null,
    idempotency_key: doc.idempotency_key ?? null,
    payment_collected_at:
      typeof doc.payment_collected_at === 'number' ? doc.payment_collected_at : null,
    payment_collected_by: doc.payment_collected_by ?? null,
    subtotal_paise: Number(doc.subtotal_paise || 0),
    total_paise: Number(doc.total_paise || 0),
    currency: doc.currency || 'INR',
    created_at: Number(doc.created_at || 0),
    updated_at: Number(doc.updated_at || doc.created_at || 0),
  };
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
  const phoneVerified = Boolean(data.phone_verified && data.phone_e164);
  const contactPhone =
    typeof data.contact_phone === 'string' && data.contact_phone.trim()
      ? data.contact_phone.trim()
      : typeof data.phone_e164 === 'string' && data.phone_e164.trim()
        ? data.phone_e164.trim()
        : null;
  const hasPassword =
    typeof data.has_password === 'boolean'
      ? data.has_password
      : Array.isArray(data.sign_in_providers)
        ? (data.sign_in_providers as unknown[]).includes('password')
        : Boolean(data.password_hash);
  return {
    id: String(data.id),
    full_name: String(data.full_name || ''),
    email: typeof data.email === 'string' && data.email.trim() ? data.email : null,
    email_verified: data.email_verified ? 1 : 0,
    password_hash: typeof data.password_hash === 'string' ? data.password_hash : null,
    phone_e164: typeof data.phone_e164 === 'string' ? data.phone_e164 : null,
    phone_verified: phoneVerified ? 1 : 0,
    contact_phone: contactPhone,
    has_password: hasPassword,
    notification_prefs_json:
      typeof data.notification_prefs_json === 'string'
        ? data.notification_prefs_json
        : data.notification_prefs && typeof data.notification_prefs === 'object'
          ? JSON.stringify(data.notification_prefs)
          : null,
    deleted_at: typeof data.deleted_at === 'number' ? data.deleted_at : null,
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
    included_pieces: typeof doc.included_pieces === 'string' ? doc.included_pieces : '',
    care_note: typeof doc.care_note === 'string' ? doc.care_note : '',
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
    import_key: typeof doc.import_key === 'string' ? doc.import_key : null,
    source_image_filename:
      typeof doc.source_image_filename === 'string' ? doc.source_image_filename : null,
    pending_fields_json:
      typeof doc.pending_fields_json === 'string' ? doc.pending_fields_json : null,
    catalog_batch: typeof doc.catalog_batch === 'string' ? doc.catalog_batch : null,
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

  private pendingCheckoutsCol() {
    return this.envDoc().collection('pending_checkouts');
  }

  private couponsCol() {
    return this.envDoc().collection('coupons');
  }

  private giftCardsCol() {
    return this.envDoc().collection('gift_cards');
  }

  private addressesCol(userId: string) {
    return this.usersCol().doc(userId).collection('addresses');
  }

  private paymentMethodsCol(userId: string) {
    return this.usersCol().doc(userId).collection('payment_methods');
  }

  private wishlistDoc(userId: string) {
    return this.usersCol().doc(userId).collection('wishlist').doc('items');
  }

  private notificationsCol(userId: string) {
    return this.usersCol().doc(userId).collection('notifications');
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

  async updateCustomerProfile(
    userId: string,
    input: {
      fullName?: string;
      phone?: string | null;
      notificationPrefs?: NotificationPreferencesData;
    },
    now: number
  ): Promise<UserRow> {
    const ref = this.usersCol().doc(userId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new StoreHttpError(404, 'USER_NOT_FOUND', 'Customer account was not found.');
    }
    const existing = snap.data() as Record<string, unknown>;
    const nextName =
      typeof input.fullName === 'string' && input.fullName.trim().length >= 2
        ? input.fullName.trim().slice(0, 100)
        : String(existing.full_name || '');
    const nextPhone =
      input.phone === null
        ? null
        : typeof input.phone === 'string'
          ? input.phone.trim() || null
          : typeof existing.phone_e164 === 'string'
            ? existing.phone_e164
            : null;
    const nextPrefsJson = input.notificationPrefs
      ? JSON.stringify(parseNotificationPrefs(input.notificationPrefs))
      : typeof existing.notification_prefs_json === 'string'
        ? existing.notification_prefs_json
        : null;

    await ref.update({
      full_name: nextName,
      phone_e164: nextPhone,
      notification_prefs_json: nextPrefsJson,
      updated_at: now,
    });
    const updated = await this.getUserById(userId);
    if (!updated) throw new Error(`User ${userId} not found.`);
    return updated;
  }

  async deleteCustomerAccount(
    userId: string,
    now: number
  ): Promise<{ deleted: boolean; preservedOrdersCount: number }> {
    const user = await this.getUserById(userId);
    if (!user) return { deleted: false, preservedOrdersCount: 0 };

    const boundOwner = await this.resolveBoundOwner();
    if (boundOwner && boundOwner.owner_user_id === userId) {
      throw new StoreHttpError(
        403,
        'OWNER_ACCOUNT_PROTECTED',
        'The primary store owner account cannot be deleted from customer settings.'
      );
    }

    const ordersSnap = await this.ordersCol().where('customer_user_id', '==', userId).get();
    const preservedOrdersCount = ordersSnap.size;
    const batch = this.firestore.batch();
    for (const oDoc of ordersSnap.docs) {
      batch.update(oDoc.ref, { customer_user_id: null, updated_at: now });
    }

    const [addrSnap, pmSnap, notifSnap, sessionsSnap, tokensSnap] = await Promise.all([
      this.addressesCol(userId).get(),
      this.paymentMethodsCol(userId).get(),
      this.notificationsCol(userId).get(),
      this.sessionsCol().where('user_id', '==', userId).get(),
      this.emailTokensCol().where('user_id', '==', userId).get(),
    ]);
    for (const d of [...addrSnap.docs, ...pmSnap.docs, ...notifSnap.docs, ...sessionsSnap.docs, ...tokensSnap.docs]) {
      batch.delete(d.ref);
    }
    batch.delete(this.wishlistDoc(userId));
    batch.delete(this.usersCol().doc(userId));
    await batch.commit();
    return { deleted: true, preservedOrdersCount };
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
    const [existingSnap, deleteAuditsSnap, settingsSnap] = await Promise.all([
      this.productsCol().get(),
      this.auditCol().where('action', '==', 'delete').get(),
      this.siteDocsCol().doc('settings').get(),
    ]);
    if (settingsSnap.exists) {
      const sData = settingsSnap.data() as Record<string, unknown> | undefined;
      const val = sData?.value as Record<string, unknown> | undefined;
      const ctrl = val?.catalogControl as Record<string, unknown> | undefined;
      if (sData?.suppress_legacy_seed === true || ctrl?.suppressLegacySeed === true) {
        return;
      }
    }
    const existingIds = new Set(existingSnap.docs.map((d) => d.id));
    for (const doc of deleteAuditsSnap.docs) {
      const pid = String(doc.data().product_id || '');
      if (pid) existingIds.add(pid);
    }
    const missingItems = INITIAL_SEED_PRODUCTS.filter((item) => !existingIds.has(item.id));
    if (missingItems.length === 0) return;

    const batch = this.firestore.batch();
    batch.set(
      this.envDoc(),
      { targetEnv: this.targetEnv, namespace: this.namespace, updatedAt: Date.now() },
      { merge: true }
    );

    for (const item of missingItems) {
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
          (r.product.included_pieces || '').toLowerCase().includes(q) ||
          (r.product.care_note || '').toLowerCase().includes(q) ||
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
    const [prodSnap, catList, ordersSnap, auditSnap, msgSnap, usersSnap] = await Promise.all([
      this.productsCol().get(),
      this.listCategories(),
      this.ordersCol().get(),
      this.auditCol().get(),
      this.messagesCol().get(),
      this.usersCol().get(),
    ]);

    const orderCounts = new Map<string, number>();
    let pendingOrders = 0;
    let openReturnRequests = 0;
    let totalRevenuePaise = 0;
    const allOrders: OrderWithItems[] = [];

    for (const oDoc of ordersSnap.docs) {
      const orderDoc = oDoc.data() as FirestoreOrderDoc;
      const fulfillment = orderDoc.fulfillment_status || orderDoc.status || 'placed';
      const paymentStatus =
        orderDoc.payment_status ?? (orderDoc.razorpay_payment_id ? 'paid' : 'unpaid');
      const paymentMethod =
        orderDoc.payment_method ??
        (orderDoc.razorpay_order_id || orderDoc.razorpay_payment_id ? 'razorpay' : 'cod');

      if (!['delivered', 'cancelled', 'returned'].includes(fulfillment)) {
        pendingOrders += 1;
      }
      const isCancelled = orderDoc.status === 'cancelled' || fulfillment === 'cancelled';
      const isPaid =
        paymentStatus === 'paid' ||
        (paymentMethod !== 'cod' && ['paid', 'fulfilled'].includes(orderDoc.status));
      if (!isCancelled && isPaid) {
        totalRevenuePaise += Number(orderDoc.total_paise || 0);
      }
      let pendingReqCount = 0;
      if (orderDoc.return_request_json) {
        try {
          const parsedReq = JSON.parse(orderDoc.return_request_json) as { status?: string };
          if (parsedReq?.status === 'pending') pendingReqCount += 1;
        } catch {
          // ignore
        }
      }
      if (orderDoc.cancel_request_json) {
        try {
          const parsedCancel = JSON.parse(orderDoc.cancel_request_json) as { status?: string };
          if (parsedCancel?.status === 'pending') pendingReqCount += 1;
        } catch {
          // ignore
        }
      }
      if (pendingReqCount > 0) openReturnRequests += 1;
      for (const item of orderDoc.items || []) {
        orderCounts.set(item.product_id, (orderCounts.get(item.product_id) || 0) + 1);
      }
      allOrders.push({
        order: normalizeFirestoreOrderRow(orderDoc),
        items: orderDoc.items || [],
      });
    }
    allOrders.sort((a, b) => b.order.created_at - a.order.created_at);
    const totalCustomers = usersSnap.docs.filter((d) => {
      const data = d.data();
      return !data?.deleted_at && (Boolean(data?.email_verified) || Boolean(data?.phone_verified));
    }).length;

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
        totalCustomers,
        openReturnRequests,
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
    } else {
      items = items.filter((r) => r.product.status !== 'archived');
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
      included_pieces: p.included_pieces ?? '',
      care_note: p.care_note ?? '',
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
      import_key: p.import_key ?? null,
      source_image_filename: p.source_image_filename ?? null,
      pending_fields_json: p.pending_fields_json ?? null,
      catalog_batch: p.catalog_batch ?? null,
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
    includedPieces?: string;
    careNote?: string;
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
    importKey?: string | null;
    sourceImageFilename?: string | null;
    pendingFieldsJson?: string | null;
    catalogBatch?: string | null;
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
        included_pieces:
          input.includedPieces !== undefined
            ? input.includedPieces
            : (existing.included_pieces ?? ''),
        care_note:
          input.careNote !== undefined ? input.careNote : (existing.care_note ?? ''),
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
        import_key:
          input.importKey !== undefined ? input.importKey : (existing.import_key ?? null),
        source_image_filename:
          input.sourceImageFilename !== undefined
            ? input.sourceImageFilename
            : (existing.source_image_filename ?? null),
        pending_fields_json:
          input.pendingFieldsJson !== undefined
            ? input.pendingFieldsJson
            : (existing.pending_fields_json ?? null),
        catalog_batch:
          input.catalogBatch !== undefined ? input.catalogBatch : (existing.catalog_batch ?? null),
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

  async savePendingCheckout(record: PendingCheckoutRow): Promise<void> {
    await this.pendingCheckoutsCol().doc(record.id).set(record, { merge: true });
  }

  async getPendingCheckout(razorpayOrderId: string): Promise<PendingCheckoutRow | null> {
    const snap = await this.pendingCheckoutsCol().doc(razorpayOrderId).get();
    if (!snap.exists) return null;
    return snap.data() as PendingCheckoutRow;
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
    const uniqueProductIds = Array.from(new Set(input.items.map((i) => i.productId)));

    return this.firestore.runTransaction(async (tx) => {
      if (input.id) {
        const existingSnap = await tx.get(this.ordersCol().doc(input.id));
        if (existingSnap.exists) {
          const doc = existingSnap.data() as FirestoreOrderDoc;
          return { order: normalizeFirestoreOrderRow(doc), items: doc.items || [] };
        }
      }
      if (input.razorpayOrderId) {
        const existingByRzp = await tx.get(
          this.ordersCol().where('razorpay_order_id', '==', input.razorpayOrderId).limit(1)
        );
        if (!existingByRzp.empty) {
          const doc = existingByRzp.docs[0].data() as FirestoreOrderDoc;
          return { order: normalizeFirestoreOrderRow(doc), items: doc.items || [] };
        }
      }
      const cleanIdempotencyKey =
        typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
          ? input.idempotencyKey.trim().slice(0, 128)
          : null;
      if (cleanIdempotencyKey) {
        const existingByKey = await tx.get(
          this.ordersCol().where('idempotency_key', '==', cleanIdempotencyKey).limit(1)
        );
        if (!existingByKey.empty) {
          const doc = existingByKey.docs[0].data() as FirestoreOrderDoc;
          return { order: normalizeFirestoreOrderRow(doc), items: doc.items || [] };
        }
      }

      // Firestore requires all reads before writes inside a transaction
      const productSnaps = new Map<string, FirestoreProductDoc>();
      for (const pid of uniqueProductIds) {
        const snap = await tx.get(this.productsCol().doc(pid));
        if (snap.exists) {
          productSnaps.set(pid, snap.data() as FirestoreProductDoc);
        }
      }

      const cleanCouponCode = input.couponCode?.trim().toUpperCase() || null;
      const cleanGiftCardCode = input.giftCardCode?.trim().toUpperCase() || null;
      let couponDocSnap: { ref: FirebaseFirestore.DocumentReference; data: CouponRow } | null = null;
      let giftCardDocSnap: { ref: FirebaseFirestore.DocumentReference; data: GiftCardRow } | null = null;

      if (cleanCouponCode) {
        const cSnap = await tx.get(
          this.couponsCol().where('code', '==', cleanCouponCode).limit(1)
        );
        if (!cSnap.empty) {
          couponDocSnap = { ref: cSnap.docs[0].ref, data: cSnap.docs[0].data() as CouponRow };
        }
      }
      if (cleanGiftCardCode) {
        const gcSnap = await tx.get(
          this.giftCardsCol().where('code', '==', cleanGiftCardCode).limit(1)
        );
        if (!gcSnap.empty) {
          giftCardDocSnap = { ref: gcSnap.docs[0].ref, data: gcSnap.docs[0].data() as GiftCardRow };
        }
      }

      let subtotalPaise = 0;
      const now = Date.now();
      const orderId = input.id || crypto.randomUUID();
      const orderNumber =
        input.orderNumber ||
        `SC-${new Date(now).getUTCFullYear()}-${crypto
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

      const discountPaise = Math.max(0, Math.min(subtotalPaise, Math.round(input.discountPaise || 0)));
      const giftCardPaise = Math.max(
        0,
        Math.min(subtotalPaise - discountPaise, Math.round(input.giftCardPaise || 0))
      );
      const totalPaise = Math.max(0, subtotalPaise - discountPaise - giftCardPaise);

      for (const [pid, updatedDoc] of touchedDocs.entries()) {
        tx.set(this.productsCol().doc(pid), updatedDoc);
      }
      if (couponDocSnap) {
        tx.update(couponDocSnap.ref, {
          used_count: Number(couponDocSnap.data.used_count || 0) + 1,
          updated_at: now,
        });
      }
      if (giftCardDocSnap && giftCardPaise > 0) {
        tx.update(giftCardDocSnap.ref, {
          balance_paise: Math.max(0, Number(giftCardDocSnap.data.balance_paise || 0) - giftCardPaise),
          last_used_at: now,
          updated_at: now,
        });
      }

      const paymentMethod = input.paymentMethod || 'cod';
      const status = input.status || (paymentMethod === 'cod' ? 'placed' : 'pending');
      const paymentStatus = input.paymentStatus || (input.paymentMethod === 'razorpay' ? 'paid' : 'unpaid');
      const fulfillmentStatus = input.fulfillmentStatus || (status === 'confirmed' ? 'confirmed' : 'placed');
      const paymentCollectedAt = paymentStatus === 'paid' ? now : null;
      const paymentCollectedBy = null;
      const statusHistory: OrderStatusHistoryEntry[] =
        input.statusHistory && input.statusHistory.length > 0
          ? input.statusHistory
          : [
              {
                status: fulfillmentStatus,
                note:
                  paymentMethod === 'razorpay'
                    ? 'Payment verified via Razorpay'
                    : 'Cash on Delivery order placed · Payment due on delivery',
                actor: input.customerUserId ? 'customer' : 'system',
                at: now,
              },
            ];
      const statusHistoryJson = JSON.stringify(statusHistory);

      const orderDoc: FirestoreOrderDoc = {
        id: orderId,
        order_number: orderNumber,
        customer_user_id: input.customerUserId,
        customer_name: input.customerName,
        customer_email: input.customerEmail,
        customer_phone: input.customerPhone,
        shipping_address: input.shippingAddress,
        status,
        payment_status: paymentStatus,
        fulfillment_status: fulfillmentStatus,
        payment_method: paymentMethod,
        razorpay_order_id: input.razorpayOrderId || null,
        razorpay_payment_id: input.razorpayPaymentId || null,
        coupon_code: cleanCouponCode,
        gift_card_code: cleanGiftCardCode,
        discount_paise: discountPaise,
        gift_card_paise: giftCardPaise,
        status_history_json: statusHistoryJson,
        return_request_json: null,
        idempotency_key: cleanIdempotencyKey,
        payment_collected_at: paymentCollectedAt,
        payment_collected_by: paymentCollectedBy,
        subtotal_paise: subtotalPaise,
        total_paise: totalPaise,
        currency: 'INR',
        created_at: now,
        updated_at: now,
        product_ids: Array.from(new Set(createdItems.map((it) => it.product_id))),
        items: createdItems,
      };

      tx.set(this.ordersCol().doc(orderId), orderDoc);

      if (input.customerUserId) {
        const notifId = `notif_placed_${orderId}`;
        const notifDoc: CustomerNotificationRow = {
          id: notifId,
          user_id: input.customerUserId,
          type: 'order_placed',
          title: `Order ${orderNumber} placed`,
          message:
            paymentMethod === 'razorpay'
              ? `Payment verified for order ${orderNumber} (₹${(totalPaise / 100).toLocaleString('en-IN')}).`
              : `Your Cash on Delivery order ${orderNumber} is placed. ₹${(totalPaise / 100).toLocaleString('en-IN')} is due on delivery.`,
          order_id: orderId,
          order_number: orderNumber,
          is_read: 0,
          read_at: null,
          created_at: now,
        };
        tx.set(this.notificationsCol(input.customerUserId).doc(notifId), notifDoc);
      }

      return { order: normalizeFirestoreOrderRow(orderDoc), items: createdItems };
    });
  }

  async getOrderById(orderId: string): Promise<OrderWithItems | null> {
    const snap = await this.ordersCol().doc(orderId).get();
    if (!snap.exists) return null;
    const doc = snap.data() as FirestoreOrderDoc;
    return { order: normalizeFirestoreOrderRow(doc), items: doc.items || [] };
  }

  async listCustomerOrders(userId: string): Promise<OrderWithItems[]> {
    const snap = await this.ordersCol().where('customer_user_id', '==', userId).get();
    return snap.docs
      .map((d) => d.data() as FirestoreOrderDoc)
      .filter((doc) => !doc.hidden_by_customer)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at))
      .map((doc) => ({ order: normalizeFirestoreOrderRow(doc), items: doc.items || [] }));
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

    const items: OrderWithItems[] = slice.map((doc) => ({
      order: normalizeFirestoreOrderRow(doc),
      items: doc.items || [],
    }));

    return { items, total, page: safePage, pageSize, totalPages };
  }

  async updateOrderStatus(orderId: string, nextStatus: string): Promise<boolean> {
    const updated = await this.updateOrderStatusWithHistory(orderId, nextStatus, {
      actor: 'owner',
      notifyCustomer: true,
    });
    return Boolean(updated);
  }

  async updateOrderStatusWithHistory(
    orderId: string,
    nextStatus: string,
    options?: {
      actor?: 'owner' | 'system' | 'customer';
      note?: string;
      notifyCustomer?: boolean;
    }
  ): Promise<OrderWithItems | null> {
    const ref = this.ordersCol().doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) return null;

    const existing = snap.data() as FirestoreOrderDoc;
    const now = Date.now();
    let history: OrderStatusHistoryEntry[] = [];
    try {
      const parsed = JSON.parse(existing.status_history_json || '[]') as unknown;
      if (Array.isArray(parsed)) history = parsed as OrderStatusHistoryEntry[];
    } catch {
      history = [];
    }

    const changed = existing.status !== nextStatus || existing.fulfillment_status !== nextStatus;
    if (changed || options?.note) {
      history.push({
        status: nextStatus,
        note: options?.note?.trim() || undefined,
        actor: options?.actor || 'owner',
        at: now,
      });
    }

    const patch = {
      status: nextStatus,
      fulfillment_status: nextStatus,
      status_history_json: JSON.stringify(history),
      updated_at: now,
    };
    await ref.update(patch);

    if (options?.notifyCustomer !== false && changed && existing.customer_user_id) {
      const label = nextStatus.replace(/_/g, ' ');
      const notifId = `notif_status_${orderId}_${nextStatus}_${now}`;
      await this.createCustomerNotification({
        id: notifId,
        userId: existing.customer_user_id,
        type: 'order_status',
        title: `Order ${existing.order_number} is now ${label}`,
        message: options?.note?.trim()
          ? `${options.note.trim()} (Order ${existing.order_number})`
          : `Your order ${existing.order_number} status has been updated to ${label}.`,
        orderId,
        orderNumber: existing.order_number,
      });
    }

    const updatedDoc: FirestoreOrderDoc = { ...existing, ...patch };
    return { order: normalizeFirestoreOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async submitOrderReturnRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    reason: string;
  }): Promise<OrderWithItems | null> {
    return this.submitOrderRequest(input);
  }

  async submitOrderRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    reason: string;
  }): Promise<OrderWithItems | null> {
    const cleanReason = input.reason.trim().slice(0, 500);
    if (cleanReason.length < 3) {
      throw new StoreHttpError(
        400,
        'VALIDATION_ERROR',
        'Please provide a brief reason (at least 3 characters).'
      );
    }

    return this.firestore.runTransaction(async (tx) => {
      const ref = this.ordersCol().doc(input.orderId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;

      const existing = snap.data() as FirestoreOrderDoc;
      if (existing.customer_user_id !== input.userId) {
        throw new StoreHttpError(
          403,
          'FORBIDDEN',
          'You can only request changes for your own orders.'
        );
      }

      const history = parseOrderHistory(existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: existing.status,
        rawFulfillmentStatus: existing.fulfillment_status,
        rawCancelRequest: existing.cancel_request_json,
        rawReturnRequest: existing.return_request_json,
        history,
        paymentMethod: existing.payment_method,
      });

      if (input.type === 'cancel') {
        if (!PRE_SHIPPING_CANCEL_STATES.has(norm.fulfillmentStatus)) {
          throw new StoreHttpError(
            409,
            'CANCELLATION_CUTOFF_PASSED',
            `Cancellation is unavailable once an order is ${norm.fulfillmentStatus}.`
          );
        }
        if (norm.cancelRequest?.status === 'pending') {
          if (norm.cancelRequest.reason === cleanReason) {
            return { order: normalizeFirestoreOrderRow(existing), items: existing.items || [] };
          }
          throw new StoreHttpError(
            409,
            'REQUEST_ALREADY_PENDING',
            'A cancellation request is already pending for this order. You can edit or withdraw it below.'
          );
        }
      } else {
        if (!RETURN_ELIGIBLE_STATES.has(norm.fulfillmentStatus)) {
          throw new StoreHttpError(
            409,
            'RETURN_NOT_ELIGIBLE',
            'Return requests can only be submitted after your order is delivered.'
          );
        }
        if (norm.returnRequest?.status === 'pending') {
          if (norm.returnRequest.reason === cleanReason) {
            return { order: normalizeFirestoreOrderRow(existing), items: existing.items || [] };
          }
          throw new StoreHttpError(
            409,
            'REQUEST_ALREADY_PENDING',
            'A return request is already pending for this order. You can edit or withdraw it below.'
          );
        }
      }

      const now = Date.now();
      const requestRecord: OrderReturnRequestRecord = {
        id: `req_${crypto.randomUUID().slice(0, 12)}`,
        type: input.type,
        reason: cleanReason,
        status: 'pending',
        requestedAt: now,
        updatedAt: now,
        resolvedAt: null,
      };

      history.push({
        status: input.type === 'cancel' ? 'cancellation_requested' : 'return_requested',
        note: cleanReason,
        actor: 'customer',
        at: now,
      });

      const patch: Partial<FirestoreOrderDoc> = {
        status: norm.fulfillmentStatus,
        fulfillment_status: norm.fulfillmentStatus,
        ...(input.type === 'cancel'
          ? { cancel_request_json: JSON.stringify(requestRecord) }
          : { return_request_json: JSON.stringify(requestRecord) }),
        status_history_json: JSON.stringify(history),
        updated_at: now,
      };
      tx.update(ref, patch);

      const updatedDoc: FirestoreOrderDoc = { ...existing, ...patch };
      return { order: normalizeFirestoreOrderRow(updatedDoc), items: updatedDoc.items || [] };
    });
  }

  async updateOrderRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    action: 'edit' | 'withdraw';
    reason?: string;
  }): Promise<OrderWithItems | null> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.ordersCol().doc(input.orderId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;

      const existing = snap.data() as FirestoreOrderDoc;
      if (existing.customer_user_id !== input.userId) {
        throw new StoreHttpError(403, 'FORBIDDEN', 'You can only update requests for your own orders.');
      }

      const history = parseOrderHistory(existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: existing.status,
        rawFulfillmentStatus: existing.fulfillment_status,
        rawCancelRequest: existing.cancel_request_json,
        rawReturnRequest: existing.return_request_json,
        history,
        paymentMethod: existing.payment_method,
      });

      const target = input.type === 'cancel' ? norm.cancelRequest : norm.returnRequest;
      if (!target) {
        throw new StoreHttpError(404, 'REQUEST_NOT_FOUND', 'No request was found on this order.');
      }
      if (target.status !== 'pending') {
        throw new StoreHttpError(
          409,
          'CONCURRENCY_CONFLICT',
          `This request is already ${target.status} and can no longer be changed.`
        );
      }

      const now = Date.now();
      let updatedTarget: OrderReturnRequestRecord;

      if (input.action === 'withdraw') {
        updatedTarget = {
          ...target,
          status: 'withdrawn',
          updatedAt: now,
          resolvedAt: now,
        };
        history.push({
          status: `${input.type}_withdrawn`,
          note: 'Customer withdrew pending request',
          actor: 'customer',
          at: now,
        });
      } else {
        const cleanReason = (input.reason || '').trim().slice(0, 500);
        if (cleanReason.length < 3) {
          throw new StoreHttpError(
            400,
            'VALIDATION_ERROR',
            'Please provide a reason of at least 3 characters.'
          );
        }
        updatedTarget = {
          ...target,
          reason: cleanReason,
          updatedAt: now,
        };
        history.push({
          status: `${input.type}_request_updated`,
          note: cleanReason,
          actor: 'customer',
          at: now,
        });
      }

      const patch: Partial<FirestoreOrderDoc> = {
        status: norm.fulfillmentStatus,
        fulfillment_status: norm.fulfillmentStatus,
        cancel_request_json:
          input.type === 'cancel'
            ? JSON.stringify(updatedTarget)
            : norm.cancelRequest
              ? JSON.stringify(norm.cancelRequest)
              : null,
        return_request_json:
          input.type === 'return'
            ? JSON.stringify(updatedTarget)
            : norm.returnRequest
              ? JSON.stringify(norm.returnRequest)
              : null,
        status_history_json: JSON.stringify(history),
        updated_at: now,
      };
      tx.update(ref, patch);

      const updatedDoc: FirestoreOrderDoc = { ...existing, ...patch };
      return { order: normalizeFirestoreOrderRow(updatedDoc), items: updatedDoc.items || [] };
    });
  }

  async updateOrderDeliveryDetails(input: {
    orderId: string;
    userId: string;
    customerName?: string;
    customerPhone?: string;
    shippingAddress?: string;
  }): Promise<OrderWithItems | null> {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.ordersCol().doc(input.orderId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;

      const existing = snap.data() as FirestoreOrderDoc;
      if (existing.customer_user_id !== input.userId) {
        throw new StoreHttpError(403, 'FORBIDDEN', 'You can only edit delivery details for your own orders.');
      }

      const history = parseOrderHistory(existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: existing.status,
        rawFulfillmentStatus: existing.fulfillment_status,
        rawCancelRequest: existing.cancel_request_json,
        rawReturnRequest: existing.return_request_json,
        history,
        paymentMethod: existing.payment_method,
      });

      if (!PRE_CUTOFF_DELIVERY_EDIT_STATES.has(norm.fulfillmentStatus)) {
        throw new StoreHttpError(
          409,
          'DELIVERY_CUTOFF_PASSED',
          `Delivery details cannot be changed once your order is ${norm.fulfillmentStatus}.`
        );
      }

      const cleanName =
        typeof input.customerName === 'string'
          ? input.customerName.trim()
          : String(existing.customer_name || '').trim();
      const cleanPhone =
        typeof input.customerPhone === 'string'
          ? input.customerPhone.trim()
          : String(existing.customer_phone || '').trim();
      const cleanAddress =
        typeof input.shippingAddress === 'string'
          ? input.shippingAddress.trim()
          : String(existing.shipping_address || '').trim();
      if (cleanName.length < 2 || cleanPhone.length < 6 || cleanAddress.length < 5) {
        throw new StoreHttpError(
          400,
          'VALIDATION_ERROR',
          'Please provide valid recipient name, phone number, and delivery address.'
        );
      }

      const now = Date.now();
      history.push({
        status: 'delivery_updated',
        note: 'Customer updated recipient / delivery address before dispatch',
        actor: 'customer',
        at: now,
      });

      const patch: Partial<FirestoreOrderDoc> = {
        customer_name: cleanName.slice(0, 120),
        customer_phone: cleanPhone.slice(0, 32),
        shipping_address: cleanAddress.slice(0, 600),
        delivery_details_edited_at: now,
        status_history_json: JSON.stringify(history),
        updated_at: now,
      };
      tx.update(ref, patch);

      const updatedDoc: FirestoreOrderDoc = { ...existing, ...patch };
      return { order: normalizeFirestoreOrderRow(updatedDoc), items: updatedDoc.items || [] };
    });
  }

  async hideOrderForCustomer(orderId: string, userId: string): Promise<boolean> {
    const ref = this.ordersCol().doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    const existing = snap.data() as FirestoreOrderDoc;
    if (existing.customer_user_id !== userId) {
      throw new StoreHttpError(403, 'FORBIDDEN', 'You can only hide orders from your own account.');
    }
    const now = Date.now();
    await ref.update({
      hidden_by_customer: true,
      hidden_at: now,
      updated_at: now,
    });
    return true;
  }

  async resolveOrderReturnRequest(input: {
    orderId: string;
    requestType?: 'cancel' | 'return';
    decision: 'approved' | 'rejected';
    note?: string;
  }): Promise<OrderWithItems | null> {
    const result = await this.firestore.runTransaction(async (tx) => {
      const ref = this.ordersCol().doc(input.orderId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;

      const existing = snap.data() as FirestoreOrderDoc;
      const history = parseOrderHistory(existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: existing.status,
        rawFulfillmentStatus: existing.fulfillment_status,
        rawCancelRequest: existing.cancel_request_json,
        rawReturnRequest: existing.return_request_json,
        history,
        paymentMethod: existing.payment_method,
      });

      const target =
        input.requestType === 'cancel'
          ? norm.cancelRequest
          : input.requestType === 'return'
            ? norm.returnRequest
            : norm.cancelRequest?.status === 'pending'
              ? norm.cancelRequest
              : norm.returnRequest?.status === 'pending'
                ? norm.returnRequest
                : norm.cancelRequest || norm.returnRequest;

      if (!target) return null;
      if (target.status !== 'pending') {
        throw new StoreHttpError(
          409,
          'CONCURRENCY_CONFLICT',
          `Cannot ${input.decision === 'approved' ? 'approve' : 'reject'} request because its status is already "${target.status}".`
        );
      }

      const now = Date.now();
      const updatedReq: OrderReturnRequestRecord = {
        ...target,
        status: input.decision,
        updatedAt: now,
        resolvedAt: now,
        ...(input.note?.trim() ? { resolutionNote: input.note.trim().slice(0, 300) } : {}),
      };

      const nextFulfillment =
        input.decision === 'approved'
          ? updatedReq.type === 'cancel'
            ? 'cancelled'
            : 'returned'
          : norm.fulfillmentStatus;
      const nextStatus = nextFulfillment;

      history.push({
        status: `${updatedReq.type}_${input.decision}`,
        note: updatedReq.resolutionNote || `Request ${input.decision} by store owner`,
        actor: 'owner',
        at: now,
      });

      let stockRestoredAt = existing.stock_restored_at ?? null;
      if (input.decision === 'approved' && updatedReq.type === 'cancel' && !stockRestoredAt) {
        const productIds = Array.from(new Set((existing.items || []).map((it) => it.product_id)));
        const prodSnaps = new Map<string, FirestoreProductDoc>();
        for (const pid of productIds) {
          const pSnap = await tx.get(this.productsCol().doc(pid));
          if (pSnap.exists) {
            prodSnaps.set(pid, pSnap.data() as FirestoreProductDoc);
          }
        }
        for (const item of existing.items || []) {
          const pDoc = prodSnaps.get(item.product_id);
          if (!pDoc) continue;
          const clonedVariants = pDoc.variants.map((v) => ({ ...v }));
          const vIdx = item.variant_id
            ? clonedVariants.findIndex((v) => v.id === item.variant_id)
            : 0;
          if (vIdx >= 0) {
            clonedVariants[vIdx].stock_qty += Number(item.quantity || 0);
          }
          pDoc.variants = clonedVariants;
          pDoc.stock_qty = clonedVariants.reduce((sum, v) => sum + v.stock_qty, 0);
          pDoc.updated_at = now;
        }
        for (const [pid, updatedProd] of prodSnaps.entries()) {
          tx.set(this.productsCol().doc(pid), updatedProd);
        }
        stockRestoredAt = now;
      }

      const patch: Partial<FirestoreOrderDoc> = {
        status: nextStatus,
        fulfillment_status: nextFulfillment,
        cancel_request_json:
          updatedReq.type === 'cancel'
            ? JSON.stringify(updatedReq)
            : norm.cancelRequest
              ? JSON.stringify(norm.cancelRequest)
              : null,
        return_request_json:
          updatedReq.type === 'return'
            ? JSON.stringify(updatedReq)
            : norm.returnRequest
              ? JSON.stringify(norm.returnRequest)
              : null,
        stock_restored_at: stockRestoredAt,
        status_history_json: JSON.stringify(history),
        updated_at: now,
      };
      tx.update(ref, patch);

      const updatedDoc: FirestoreOrderDoc = { ...existing, ...patch };
      return {
        orderWithItems: { order: normalizeFirestoreOrderRow(updatedDoc), items: updatedDoc.items || [] },
        updatedReq,
      };
    });

    if (!result) return null;

    if (result.orderWithItems.order.customer_user_id) {
      const customerRow = await this.getUserById(result.orderWithItems.order.customer_user_id);
      const prefs = parseNotificationPrefs(customerRow?.notification_prefs_json);
      if (prefs.cancelReturnUpdates) {
        await this.createCustomerNotification({
          id: `notif_req_${result.orderWithItems.order.id}_${result.updatedReq.id}_${input.decision}`,
          userId: result.orderWithItems.order.customer_user_id,
          type: 'request_update',
          title: `${result.updatedReq.type === 'cancel' ? 'Cancellation' : 'Return'} request ${input.decision}`,
          message:
            result.updatedReq.resolutionNote ||
            `Your ${result.updatedReq.type} request for order ${result.orderWithItems.order.order_number} was ${input.decision}.`,
          orderId: result.orderWithItems.order.id,
          orderNumber: result.orderWithItems.order.order_number,
        });
      }
    }

    return result.orderWithItems;
  }

  async collectOrderPayment(input: {
    orderId: string;
    actorUserId?: string | null;
    note?: string;
  }): Promise<OrderWithItems | null> {
    const ref = this.ordersCol().doc(input.orderId);
    const snap = await ref.get();
    if (!snap.exists) return null;

    const existing = snap.data() as FirestoreOrderDoc;
    if (existing.status === 'cancelled' || existing.fulfillment_status === 'cancelled') {
      throw new StoreHttpError(
        409,
        'ORDER_CANCELLED',
        'Cannot record payment collection for a cancelled order.'
      );
    }

    if (existing.payment_status === 'paid') {
      return { order: normalizeFirestoreOrderRow(existing), items: existing.items || [] };
    }

    const now = Date.now();
    let history: OrderStatusHistoryEntry[] = [];
    try {
      const parsed = JSON.parse(existing.status_history_json || '[]') as unknown;
      if (Array.isArray(parsed)) history = parsed as OrderStatusHistoryEntry[];
    } catch {
      history = [];
    }

    const noteText =
      input.note?.trim() ||
      `Cash on Delivery payment of ₹${(Number(existing.total_paise || 0) / 100).toLocaleString('en-IN')} collected`;
    history.push({
      status: 'payment_collected',
      note: noteText,
      actor: 'owner',
      at: now,
    });

    const patch = {
      payment_status: 'paid',
      payment_collected_at: now,
      payment_collected_by: input.actorUserId || 'owner',
      status_history_json: JSON.stringify(history),
      updated_at: now,
    };
    await ref.update(patch);

    if (existing.customer_user_id) {
      await this.createCustomerNotification({
        id: `notif_paid_${existing.id}_${now}`,
        userId: existing.customer_user_id,
        type: 'order_status',
        title: `Payment received for order ${existing.order_number}`,
        message: `${noteText} for order ${existing.order_number}.`,
        orderId: existing.id,
        orderNumber: existing.order_number,
      });
    }

    const updatedDoc: FirestoreOrderDoc = { ...existing, ...patch };
    return { order: normalizeFirestoreOrderRow(updatedDoc), items: updatedDoc.items || [] };
  }

  async listCustomerAddresses(userId: string): Promise<CustomerAddressRow[]> {
    const snap = await this.addressesCol(userId).get();
    return snap.docs
      .map((d) => d.data() as CustomerAddressRow)
      .sort((a, b) => Number(b.is_default) - Number(a.is_default) || b.updated_at - a.updated_at);
  }

  async upsertCustomerAddress(
    userId: string,
    input: {
      id?: string;
      fullName: string;
      phone: string;
      line1: string;
      line2?: string;
      city: string;
      state: string;
      pincode: string;
      landmark?: string;
      label: 'Home' | 'Work' | 'Other';
      isDefault: boolean;
    }
  ): Promise<CustomerAddressRow> {
    const now = Date.now();
    const id = input.id && /^[a-zA-Z0-9_-]{3,80}$/.test(input.id) ? input.id : `addr_${crypto.randomUUID().slice(0, 12)}`;
    const existingList = await this.listCustomerAddresses(userId);
    const shouldBeDefault = input.isDefault || existingList.length === 0 ? 1 : 0;
    const prev = existingList.find((a) => a.id === id);

    const row: CustomerAddressRow = {
      id,
      user_id: userId,
      full_name: input.fullName.trim(),
      phone: input.phone.trim(),
      line1: input.line1.trim(),
      line2: (input.line2 || '').trim(),
      city: input.city.trim(),
      state: input.state.trim(),
      pincode: input.pincode.trim(),
      landmark: (input.landmark || '').trim(),
      label: input.label,
      is_default: shouldBeDefault,
      created_at: prev?.created_at || now,
      updated_at: now,
    };

    const batch = this.firestore.batch();
    if (shouldBeDefault) {
      for (const addr of existingList) {
        if (addr.id !== id && addr.is_default) {
          batch.update(this.addressesCol(userId).doc(addr.id), { is_default: 0 });
        }
      }
    }
    batch.set(this.addressesCol(userId).doc(id), row);
    await batch.commit();
    return row;
  }

  async deleteCustomerAddress(userId: string, addressId: string): Promise<boolean> {
    const ref = this.addressesCol(userId).doc(addressId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    const wasDefault = Boolean((snap.data() as { is_default?: unknown } | undefined)?.is_default);
    await ref.delete();
    if (wasDefault) {
      const remaining = await this.addressesCol(userId).get();
      if (!remaining.empty) {
        const sorted = remaining.docs.sort(
          (a, b) => Number((b.data()?.updated_at as number) || 0) - Number((a.data()?.updated_at as number) || 0)
        );
        const alreadyDefault = sorted.some((d) => Boolean(d.data()?.is_default));
        if (!alreadyDefault && sorted[0]) {
          await sorted[0].ref.set({ is_default: 1, updated_at: Date.now() }, { merge: true });
        }
      }
    }
    return true;
  }

  async getCustomerWishlist(userId: string): Promise<string[]> {
    const snap = await this.wishlistDoc(userId).get();
    if (!snap.exists) return [];
    const data = snap.data() as { product_ids?: unknown };
    return Array.isArray(data.product_ids)
      ? data.product_ids.filter((id): id is string => typeof id === 'string')
      : [];
  }

  async setCustomerWishlist(userId: string, productIds: string[]): Promise<string[]> {
    const unique = Array.from(new Set(productIds.filter((id) => typeof id === 'string' && id.trim())));
    await this.wishlistDoc(userId).set({
      product_ids: unique,
      updated_at: Date.now(),
    });
    return unique;
  }

  async listCustomerNotifications(userId: string): Promise<CustomerNotificationRow[]> {
    const snap = await this.notificationsCol(userId).get();
    return snap.docs
      .map((d) => d.data() as CustomerNotificationRow)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 60);
  }

  async createCustomerNotification(input: {
    id?: string;
    userId: string;
    type: CustomerNotificationRow['type'];
    title: string;
    message: string;
    orderId?: string | null;
    orderNumber?: string | null;
  }): Promise<CustomerNotificationRow> {
    const id = input.id || `notif_${crypto.randomUUID().slice(0, 12)}`;
    const ref = this.notificationsCol(input.userId).doc(id);
    const existing = await ref.get();
    if (existing.exists) {
      return existing.data() as CustomerNotificationRow;
    }
    const row: CustomerNotificationRow = {
      id,
      user_id: input.userId,
      type: input.type,
      title: input.title.trim().slice(0, 140),
      message: input.message.trim().slice(0, 500),
      order_id: input.orderId || null,
      order_number: input.orderNumber || null,
      is_read: 0,
      read_at: null,
      created_at: Date.now(),
    };
    await ref.set(row);
    return row;
  }

  async markCustomerNotificationRead(userId: string, notificationId: string): Promise<boolean> {
    const ref = this.notificationsCol(userId).doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.update({ is_read: 1, read_at: Date.now() });
    return true;
  }

  async listCustomerPaymentMethods(userId: string): Promise<CustomerPaymentMethodRow[]> {
    const snap = await this.paymentMethodsCol(userId).get();
    return snap.docs
      .map((d) => d.data() as CustomerPaymentMethodRow)
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  }

  async upsertCustomerPaymentMethod(
    userId: string,
    input: {
      id?: string;
      methodType: 'card' | 'upi' | 'wallet';
      label: string;
      last4?: string | null;
      network?: string | null;
      expiry?: string | null;
    }
  ): Promise<CustomerPaymentMethodRow> {
    const validated = validateNonSensitivePaymentMethodInput(input);
    if (!validated.ok) {
      throw new StoreHttpError(400, 'VALIDATION_ERROR', validated.error);
    }
    const now = Date.now();
    const id =
      input.id && /^[a-zA-Z0-9_-]{3,80}$/.test(input.id)
        ? input.id
        : `pm_${crypto.randomUUID().slice(0, 12)}`;
    const ref = this.paymentMethodsCol(userId).doc(id);
    const snap = await ref.get();
    const prev = snap.exists ? (snap.data() as CustomerPaymentMethodRow) : null;
    const row: CustomerPaymentMethodRow = {
      id,
      user_id: userId,
      method_type: validated.methodType,
      label: validated.label,
      last4: validated.last4,
      network: validated.network,
      expiry: validated.expiry,
      created_at: prev?.created_at || now,
      updated_at: now,
    };
    await ref.set(row);
    return row;
  }

  async deleteCustomerPaymentMethod(userId: string, methodId: string): Promise<boolean> {
    const ref = this.paymentMethodsCol(userId).doc(methodId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }

  async markAllCustomerNotificationsRead(userId: string): Promise<void> {
    const snap = await this.notificationsCol(userId).where('is_read', '==', 0).get();
    if (snap.empty) return;
    const now = Date.now();
    const batch = this.firestore.batch();
    for (const d of snap.docs) {
      batch.update(d.ref, { is_read: 1, read_at: now });
    }
    await batch.commit();
  }

  async deleteCustomerNotification(userId: string, notificationId: string): Promise<boolean> {
    const ref = this.notificationsCol(userId).doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }

  async listCoupons(activeOnly = false): Promise<CouponRow[]> {
    const snap = activeOnly
      ? await this.couponsCol().where('active', '==', 1).get()
      : await this.couponsCol().get();
    return snap.docs
      .map((d) => d.data() as CouponRow)
      .sort((a, b) => b.created_at - a.created_at);
  }

  async getCouponByCode(code: string): Promise<CouponRow | null> {
    const clean = code.trim().toUpperCase();
    const snap = await this.couponsCol().where('code', '==', clean).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as CouponRow;
  }

  async upsertCoupon(input: {
    id?: string;
    code: string;
    title: string;
    description: string;
    discountType: 'percent' | 'flat_paise';
    discountValue: number;
    maxDiscountPaise?: number | null;
    minSpendPaise: number;
    usageLimit?: number | null;
    active: boolean;
    startsAt?: number | null;
    expiresAt?: number | null;
  }): Promise<CouponRow> {
    const now = Date.now();
    const cleanCode = input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const id = input.id || `cpn_${cleanCode.toLowerCase()}`;
    const ref = this.couponsCol().doc(id);
    const snap = await ref.get();
    const prev = snap.exists ? (snap.data() as CouponRow) : null;
    const row: CouponRow = {
      id,
      code: cleanCode,
      title: input.title.trim(),
      description: input.description.trim(),
      discount_type: input.discountType,
      discount_value: Math.round(input.discountValue),
      max_discount_paise: input.maxDiscountPaise ?? null,
      min_spend_paise: Math.max(0, Math.round(input.minSpendPaise)),
      usage_limit: input.usageLimit ?? null,
      used_count: prev ? Number(prev.used_count || 0) : 0,
      active: input.active ? 1 : 0,
      starts_at: input.startsAt ?? null,
      expires_at: input.expiresAt ?? null,
      created_at: prev?.created_at || now,
      updated_at: now,
    };
    await ref.set(row);
    return row;
  }

  async deleteCoupon(id: string): Promise<boolean> {
    const ref = this.couponsCol().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }

  async listGiftCards(): Promise<GiftCardRow[]> {
    const snap = await this.giftCardsCol().get();
    return snap.docs
      .map((d) => d.data() as GiftCardRow)
      .sort((a, b) => b.created_at - a.created_at);
  }

  async getGiftCardByCode(code: string): Promise<GiftCardRow | null> {
    const clean = code.trim().toUpperCase();
    const snap = await this.giftCardsCol().where('code', '==', clean).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as GiftCardRow;
  }

  async upsertGiftCard(input: {
    id?: string;
    code: string;
    recipientEmail?: string;
    note?: string;
    initialBalancePaise: number;
    balancePaise: number;
    active: boolean;
    expiresAt?: number | null;
  }): Promise<GiftCardRow> {
    const now = Date.now();
    const cleanCode = input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const id = input.id || `gc_${cleanCode.toLowerCase()}`;
    const ref = this.giftCardsCol().doc(id);
    const snap = await ref.get();
    const prev = snap.exists ? (snap.data() as GiftCardRow) : null;
    const row: GiftCardRow = {
      id,
      code: cleanCode,
      recipient_email: (input.recipientEmail || '').trim().toLowerCase(),
      note: (input.note || '').trim(),
      initial_balance_paise: Math.max(0, Math.round(input.initialBalancePaise)),
      balance_paise: Math.max(0, Math.round(input.balancePaise)),
      active: input.active ? 1 : 0,
      expires_at: input.expiresAt ?? null,
      last_used_at: prev?.last_used_at ?? null,
      created_at: prev?.created_at || now,
      updated_at: now,
    };
    await ref.set(row);
    return row;
  }

  async deleteGiftCard(id: string): Promise<boolean> {
    const ref = this.giftCardsCol().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }

  async getLoyaltyConfig(): Promise<LoyaltyConfigData> {
    const snap = await this.siteDocsCol().doc('loyalty_config').get();
    if (!snap.exists) return mergeLoyaltyConfig(null);
    const raw = snap.data() as { data?: Partial<LoyaltyConfigData> };
    return mergeLoyaltyConfig(raw?.data || (raw as unknown as Partial<LoyaltyConfigData>));
  }

  async saveLoyaltyConfig(config: LoyaltyConfigData): Promise<LoyaltyConfigData> {
    const normalized = mergeLoyaltyConfig(config);
    await this.siteDocsCol().doc('loyalty_config').set({
      key: 'loyalty_config',
      data: normalized,
      updated_at: Date.now(),
    });
    return normalized;
  }

  async listUsersSummary(): Promise<StoreUserSummary[]> {
    const snap = await this.usersCol().get();
    const verifiedUsers = snap.docs
      .map((d) => toUserRow(d.data() as Record<string, unknown>))
      .filter((u) => (Boolean(u.email_verified) || Boolean(u.phone_verified)) && !u.deleted_at)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 100);

    return Promise.all(
      verifiedUsers.map(async (u) => ({
        id: u.id,
        fullName: u.full_name,
        email: u.email || '',
        emailVerified: Boolean(u.email_verified),
        phone: u.contact_phone || u.phone_e164 || null,
        verifiedPhone: u.phone_verified ? u.phone_e164 || null : null,
        phoneVerified: Boolean(u.phone_verified && u.phone_e164),
        notificationPrefs: parseNotificationPrefs(u.notification_prefs_json),
        addresses: await this.listCustomerAddresses(u.id).catch(() => []),
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      }))
    );
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
    const existing = await this.categoriesCol().get();
    const existingIds = new Set(existing.docs.map((d) => d.id));
    const missingCats = INITIAL_SEED_CATEGORIES.filter((c) => !existingIds.has(c.id));
    if (missingCats.length === 0) return;

    const now = Date.now();
    const batch = this.firestore.batch();
    for (const cat of missingCats) {
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
