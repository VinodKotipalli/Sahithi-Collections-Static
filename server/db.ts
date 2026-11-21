import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  INITIAL_SEED_CATEGORIES,
  type CategoryRow,
  type ContactMessageRow,
  type ContactMessageStatus,
  type SiteSettingsData,
  type StorefrontContentData,
} from './storefront-defaults.ts';
import { PRODUCTS } from '../src/config/products.ts';

export type {
  CategoryRow,
  ContactMessageRow,
  ContactMessageStatus,
  SiteSettingsData,
  StorefrontContentData,
};
export { INITIAL_SEED_CATEGORIES };

export interface UserRow {
  id: string;
  full_name: string;
  email: string | null;
  email_verified: number;
  password_hash: string | null;
  // Verified Firebase Auth mobile number (when phone_verified == 1) or legacy contact phone
  phone_e164: string | null;
  phone_verified: number;
  contact_phone?: string | null;
  has_password?: boolean;
  notification_prefs_json?: string | null;
  deleted_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_secret: string;
  last_reauth_at: number;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
}

export interface EmailTokenRow {
  id: string;
  user_id: string;
  purpose: 'verify_email' | 'reset_password' | 'link_email';
  target_email: string;
  token_hash: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export interface LegacyPhoneOnlyAccount {
  id: string;
  full_name: string;
  created_at: number;
}

export interface AdminBindingRow {
  id: number;
  owner_user_id: string;
  bound_email: string;
  bound_at: number;
  bound_via: string;
}

export type ProductStatus = 'draft' | 'published' | 'archived';

export interface ProductRow {
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
  featured: number;
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
}

export interface ProductVariantRow {
  id: string;
  product_id: string;
  sku: string;
  size: string;
  color_name: string;
  color_hex: string;
  price_paise: number;
  compare_at_paise: number | null;
  stock_qty: number;
  position: number;
}

export interface ProductImageRow {
  id: string;
  product_id: string;
  media_id: string | null;
  url: string;
  alt_text: string;
  is_cover: number;
  position: number;
  created_at: number;
}

export interface ProductMediaRow {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  data: Uint8Array;
  uploaded_by_user_id: string;
  created_at: number;
}

export interface ProductAuditLogRow {
  id: string;
  product_id: string;
  product_title: string;
  actor_user_id: string;
  action: string;
  summary: string;
  before_json: string | null;
  after_json: string | null;
  created_at: number;
}

export interface OrderRow {
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
  hidden_by_customer?: number;
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
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string | null;
  product_title: string;
  variant_label: string;
  sku: string;
  unit_price_paise: number;
  quantity: number;
  line_total_paise: number;
}

export interface PendingCheckoutRow {
  id: string;
  customer_user_id: string | null;
  amount_paise: number;
  subtotal_paise: number;
  discount_paise: number;
  gift_card_paise: number;
  coupon_code: string | null;
  gift_card_code: string | null;
  currency: string;
  receipt: string;
  items_json: string;
  customer_json: string | null;
  status: string;
  razorpay_payment_id: string | null;
  confirmed_order_id: string | null;
  confirmed_order_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface CustomerAddressRow {
  id: string;
  user_id: string;
  full_name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  landmark: string;
  label: 'Home' | 'Work' | 'Other';
  is_default: number;
  created_at: number;
  updated_at: number;
}

export interface CustomerPaymentMethodRow {
  id: string;
  user_id: string;
  method_type: 'card' | 'upi' | 'wallet';
  label: string;
  last4: string | null;
  network: string | null;
  expiry: string | null;
  created_at: number;
  updated_at: number;
}

export interface CustomerNotificationRow {
  id: string;
  user_id: string;
  type: 'order_placed' | 'order_status' | 'request_update' | 'account' | 'offer';
  title: string;
  message: string;
  order_id: string | null;
  order_number: string | null;
  is_read: number;
  read_at: number | null;
  created_at: number;
}

export interface CouponRow {
  id: string;
  code: string;
  title: string;
  description: string;
  discount_type: 'percent' | 'flat_paise';
  discount_value: number;
  max_discount_paise: number | null;
  min_spend_paise: number;
  usage_limit: number | null;
  used_count: number;
  active: number;
  starts_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GiftCardRow {
  id: string;
  code: string;
  recipient_email: string;
  note: string;
  initial_balance_paise: number;
  balance_paise: number;
  active: number;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface InitDatabaseOptions {
  seedCatalog?: boolean;
}

export function initAuthDatabase(
  dbPath: string,
  options: InitDatabaseOptions = {}
): DatabaseSync {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      phone_e164 TEXT UNIQUE,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_secret TEXT NOT NULL,
      last_reauth_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS email_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      target_email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Enforces strictly one single immutable store owner binding row (id = 1).
    CREATE TABLE IF NOT EXISTS admin_bindings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      bound_email TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      bound_via TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_media (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      uploaded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      fabric_note TEXT NOT NULL DEFAULT '',
      included_pieces TEXT NOT NULL DEFAULT '',
      care_note TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE,
      price_paise INTEGER NOT NULL CHECK (price_paise >= 100),
      compare_at_paise INTEGER,
      stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
      low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
      featured INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
      colors_json TEXT NOT NULL DEFAULT '[]',
      sizes_json TEXT NOT NULL DEFAULT '[]',
      import_key TEXT,
      source_image_filename TEXT,
      pending_fields_json TEXT,
      catalog_batch TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      published_at INTEGER,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku TEXT NOT NULL UNIQUE,
      size TEXT NOT NULL,
      color_name TEXT NOT NULL,
      color_hex TEXT NOT NULL,
      price_paise INTEGER NOT NULL CHECK (price_paise >= 100),
      compare_at_paise INTEGER,
      stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      media_id TEXT REFERENCES product_media(id) ON DELETE SET NULL,
      url TEXT NOT NULL,
      alt_text TEXT NOT NULL DEFAULT '',
      is_cover INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_audit_logs (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      product_title TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      customer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      shipping_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      fulfillment_status TEXT NOT NULL DEFAULT 'placed',
      payment_method TEXT NOT NULL DEFAULT 'cod',
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      coupon_code TEXT,
      gift_card_code TEXT,
      discount_paise INTEGER NOT NULL DEFAULT 0,
      gift_card_paise INTEGER NOT NULL DEFAULT 0,
      status_history_json TEXT NOT NULL DEFAULT '[]',
      return_request_json TEXT,
      idempotency_key TEXT,
      payment_collected_at INTEGER,
      payment_collected_by TEXT,
      subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
      total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      variant_id TEXT REFERENCES product_variants(id) ON DELETE SET NULL,
      product_title TEXT NOT NULL,
      variant_label TEXT NOT NULL,
      sku TEXT NOT NULL,
      unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      line_total_paise INTEGER NOT NULL CHECK (line_total_paise >= 0)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      subtitle TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      alt_text TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_documents (
      key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_messages (
      id TEXT PRIMARY KEY,
      sender_name TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      sender_phone TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'replied', 'archived')),
      admin_note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_checkouts (
      id TEXT PRIMARY KEY,
      customer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      amount_paise INTEGER NOT NULL,
      subtotal_paise INTEGER NOT NULL DEFAULT 0,
      discount_paise INTEGER NOT NULL DEFAULT 0,
      gift_card_paise INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT,
      gift_card_code TEXT,
      currency TEXT NOT NULL DEFAULT 'INR',
      receipt TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL DEFAULT '[]',
      customer_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      razorpay_payment_id TEXT,
      confirmed_order_id TEXT,
      confirmed_order_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_addresses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      line1 TEXT NOT NULL,
      line2 TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      pincode TEXT NOT NULL,
      landmark TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT 'Home',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_wishlists (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS customer_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      order_id TEXT,
      order_number TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_payment_methods (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method_type TEXT NOT NULL CHECK (method_type IN ('card', 'upi', 'wallet')),
      label TEXT NOT NULL,
      last4 TEXT,
      network TEXT,
      expiry TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'flat_paise')),
      discount_value INTEGER NOT NULL,
      max_discount_paise INTEGER,
      min_spend_paise INTEGER NOT NULL DEFAULT 0,
      usage_limit INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      starts_at INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gift_cards (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      recipient_email TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      initial_balance_paise INTEGER NOT NULL,
      balance_paise INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_email_tokens_user_purpose ON email_tokens(user_id, purpose);
    CREATE INDEX IF NOT EXISTS idx_products_status_category ON products(status, category);
    CREATE INDEX IF NOT EXISTS idx_variants_product_id ON product_variants(product_id);
    CREATE INDEX IF NOT EXISTS idx_images_product_id ON product_images(product_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON product_audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_customer_addresses_user ON customer_addresses(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_payment_methods_user ON customer_payment_methods(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_notif_user ON customer_notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_categories_position ON categories(position ASC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_contact_messages_status_created ON contact_messages(status, created_at DESC);
  `);

  const userCols = (
    db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const ensureUserCol = (name: string, ddl: string) => {
    if (!userCols.includes(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${ddl};`);
    }
  };
  ensureUserCol('notification_prefs_json', `notification_prefs_json TEXT`);
  ensureUserCol('deleted_at', `deleted_at INTEGER`);

  const orderCols = (
    db.prepare(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const ensureOrderCol = (name: string, ddl: string) => {
    if (!orderCols.includes(name)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${ddl};`);
    }
  };
  ensureOrderCol('customer_user_id', `customer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  ensureOrderCol('payment_status', `payment_status TEXT NOT NULL DEFAULT 'unpaid'`);
  ensureOrderCol('fulfillment_status', `fulfillment_status TEXT NOT NULL DEFAULT 'placed'`);
  ensureOrderCol('payment_method', `payment_method TEXT NOT NULL DEFAULT 'cod'`);
  ensureOrderCol('razorpay_order_id', `razorpay_order_id TEXT`);
  ensureOrderCol('razorpay_payment_id', `razorpay_payment_id TEXT`);
  ensureOrderCol('coupon_code', `coupon_code TEXT`);
  ensureOrderCol('gift_card_code', `gift_card_code TEXT`);
  ensureOrderCol('discount_paise', `discount_paise INTEGER NOT NULL DEFAULT 0`);
  ensureOrderCol('gift_card_paise', `gift_card_paise INTEGER NOT NULL DEFAULT 0`);
  ensureOrderCol('status_history_json', `status_history_json TEXT NOT NULL DEFAULT '[]'`);
  ensureOrderCol('cancel_request_json', `cancel_request_json TEXT`);
  ensureOrderCol('return_request_json', `return_request_json TEXT`);
  ensureOrderCol('hidden_by_customer', `hidden_by_customer INTEGER NOT NULL DEFAULT 0`);
  ensureOrderCol('hidden_at', `hidden_at INTEGER`);
  ensureOrderCol('stock_restored_at', `stock_restored_at INTEGER`);
  ensureOrderCol('delivery_details_edited_at', `delivery_details_edited_at INTEGER`);
  ensureOrderCol('idempotency_key', `idempotency_key TEXT`);
  ensureOrderCol('payment_collected_at', `payment_collected_at INTEGER`);
  ensureOrderCol('payment_collected_by', `payment_collected_by TEXT`);
  ensureOrderCol('updated_at', `updated_at INTEGER`);

  const productCols = (
    db.prepare(`PRAGMA table_info(products)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const ensureProductCol = (name: string, ddl: string) => {
    if (!productCols.includes(name)) {
      db.exec(`ALTER TABLE products ADD COLUMN ${ddl};`);
    }
  };
  ensureProductCol('included_pieces', `included_pieces TEXT NOT NULL DEFAULT ''`);
  ensureProductCol('care_note', `care_note TEXT NOT NULL DEFAULT ''`);
  ensureProductCol('import_key', `import_key TEXT`);
  ensureProductCol('source_image_filename', `source_image_filename TEXT`);
  ensureProductCol('pending_fields_json', `pending_fields_json TEXT`);
  ensureProductCol('catalog_batch', `catalog_batch TEXT`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_customer_user_id ON orders(customer_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_razorpay_order_id ON orders(razorpay_order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_import_key ON products(import_key) WHERE import_key IS NOT NULL;
  `);

  seedStorefrontCategoriesIfEmpty(db);

  if (options.seedCatalog !== false) {
    seedInitialCatalogIfEmpty(db);
  }

  return db;
}

export function seedStorefrontCategoriesIfEmpty(db: DatabaseSync): void {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO categories (
      id, name, slug, subtitle, image_url, alt_text, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const cat of INITIAL_SEED_CATEGORIES) {
    insert.run(
      cat.id,
      cat.name,
      cat.slug,
      cat.subtitle,
      cat.imageUrl,
      cat.altText,
      cat.position,
      now,
      now
    );
  }
}

/**
 * Trusted server-side helper to bind admin ownership to an existing verified user's immutable ID.
 * Never exposed on public HTTP routes.
 */
export function bindOwnerAccount(
  db: DatabaseSync,
  params: { email: string; boundVia?: string; forceRebind?: boolean }
): AdminBindingRow {
  const normalizedEmail = params.email.trim().toLowerCase();
  const user = db
    .prepare(`SELECT * FROM users WHERE email = ? LIMIT 1`)
    .get(normalizedEmail) as UserRow | undefined;

  if (!user) {
    throw new Error(
      `No account exists for ${normalizedEmail}. Please register and verify this email first via /signup.`
    );
  }
  if (!user.email_verified) {
    throw new Error(
      `Account ${normalizedEmail} exists (id=${user.id}) but email ownership is not verified yet.`
    );
  }
  if (!user.password_hash) {
    throw new Error(`Account ${normalizedEmail} does not have a password configured.`);
  }

  const existing = db
    .prepare(`SELECT * FROM admin_bindings WHERE id = 1 LIMIT 1`)
    .get() as AdminBindingRow | undefined;

  if (existing && existing.owner_user_id !== user.id && !params.forceRebind) {
    throw new Error(
      `An owner is already bound to user ID ${existing.owner_user_id}. Pass --force only if replacing ownership intentionally.`
    );
  }

  const now = Date.now();
  const via = params.boundVia || 'server_cli';
  if (existing) {
    db.prepare(
      `UPDATE admin_bindings SET owner_user_id = ?, bound_email = ?, bound_at = ?, bound_via = ? WHERE id = 1`
    ).run(user.id, normalizedEmail, now, via);
  } else {
    db.prepare(
      `INSERT INTO admin_bindings (id, owner_user_id, bound_email, bound_at, bound_via) VALUES (1, ?, ?, ?, ?)`
    ).run(user.id, normalizedEmail, now, via);
  }

  return db
    .prepare(`SELECT * FROM admin_bindings WHERE id = 1 LIMIT 1`)
    .get() as unknown as AdminBindingRow;
}

/**
 * Resolves the trusted bound owner record from the persistent SQLite admin_bindings table,
 * verifying that the user still exists, has a verified email, and matches ADMIN_OWNER_EMAIL
 * when configured.
 */
export function resolveBoundOwner(db: DatabaseSync): AdminBindingRow | null {
  const row = db
    .prepare(`SELECT * FROM admin_bindings WHERE id = 1 LIMIT 1`)
    .get() as AdminBindingRow | undefined;

  if (!row) return null;

  const envOwnerEmail = (process.env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase();
  const boundUser = db
    .prepare(`SELECT id, email, email_verified FROM users WHERE id = ? LIMIT 1`)
    .get(row.owner_user_id) as { id: string; email: string | null; email_verified: number } | undefined;
  if (!boundUser || !boundUser.email_verified) {
    return null;
  }
  if (envOwnerEmail && (boundUser.email || '').trim().toLowerCase() !== envOwnerEmail) {
    return null;
  }

  return row;
}

/**
 * Identifies existing phone-only accounts (created prior to removing mobile authentication)
 * that do not yet have a verified email + password, without deleting, auto-verifying, or merging them.
 */
export function listLegacyPhoneOnlyAccounts(db: DatabaseSync): LegacyPhoneOnlyAccount[] {
  return db
    .prepare(
      `SELECT id, full_name, created_at
       FROM users
       WHERE phone_e164 IS NOT NULL
         AND (email IS NULL OR email_verified = 0 OR password_hash IS NULL)
       ORDER BY created_at ASC`
    )
    .all() as unknown as LegacyPhoneOnlyAccount[];
}

export interface SeedProductDef {
  id: string;
  slug: string;
  title: string;
  category: string;
  sku: string;
  priceInr: number;
  compareAtInr?: number;
  description: string;
  fabricNote: string;
  includedPieces?: string;
  careNote?: string;
  featured: boolean;
  dateAdded: string;
  images: Array<{ url: string; alt: string }>;
  colors: Array<{ name: string; hex: string }>;
  sizes: string[];
  defaultVariantStock: number;
}

export const INITIAL_SEED_PRODUCTS: SeedProductDef[] = PRODUCTS.map((item) => ({
  id: item.id,
  slug: item.slug,
  title: item.name,
  category: item.category,
  sku: item.sku,
  priceInr: item.price,
  compareAtInr: item.compareAtPrice ?? undefined,
  description: item.description,
  fabricNote: item.fabricNote,
  includedPieces: item.includedPieces || '',
  careNote: item.careNote || '',
  featured: item.featured,
  dateAdded: item.dateAdded,
  images: item.images.map((img) => ({
    url: img.src,
    alt: img.alt,
  })),
  colors: item.colors,
  sizes: item.sizes,
  defaultVariantStock: item.defaultVariantStock ?? 6,
}));

export function seedInitialCatalogIfEmpty(db: DatabaseSync): void {
  const checkExisting = db.prepare(
    `SELECT id FROM products WHERE id = ? OR sku = ? OR slug = ? LIMIT 1`
  );
  const checkDeleted = db.prepare(
    `SELECT id FROM product_audit_logs WHERE product_id = ? AND action = 'delete' LIMIT 1`
  );
  const missingItems = INITIAL_SEED_PRODUCTS.filter(
    (item) =>
      !checkExisting.get(item.id, item.sku, item.slug) && !checkDeleted.get(item.id)
  );
  if (missingItems.length === 0) return;

  db.exec('BEGIN IMMEDIATE;');
  try {
    const insertProduct = db.prepare(
      `INSERT OR IGNORE INTO products (
        id, slug, title, description, fabric_note, included_pieces, care_note, category, sku,
        price_paise, compare_at_paise, stock_qty, low_stock_threshold,
        featured, status, colors_json, sizes_json, version,
        published_at, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, 1, ?, NULL, ?, ?)`
    );

    const insertVariant = db.prepare(
      `INSERT OR IGNORE INTO product_variants (
        id, product_id, sku, size, color_name, color_hex,
        price_paise, compare_at_paise, stock_qty, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertImage = db.prepare(
      `INSERT OR IGNORE INTO product_images (
        id, product_id, media_id, url, alt_text, is_cover, position, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
    );

    for (const item of missingItems) {
      const ts = new Date(`${item.dateAdded}T10:00:00Z`).getTime() || Date.now();
      const pricePaise = Math.round(item.priceInr * 100);
      const compareAtPaise = item.compareAtInr ? Math.round(item.compareAtInr * 100) : null;

      let totalStock = 0;
      const variantRows: Array<{
        id: string;
        sku: string;
        size: string;
        colorName: string;
        colorHex: string;
        stockQty: number;
        pos: number;
      }> = [];

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
          variantRows.push({
            id: `${item.id}-v-${pos + 1}`,
            sku: `${item.sku}-${sizeCode}-${colorCode}-${pos + 1}`,
            size,
            colorName: color.name,
            colorHex: color.hex,
            stockQty,
            pos,
          });
          pos += 1;
        }
      }

      insertProduct.run(
        item.id,
        item.slug,
        item.title,
        item.description,
        item.fabricNote,
        item.includedPieces || '',
        item.careNote || '',
        item.category,
        item.sku,
        pricePaise,
        compareAtPaise,
        totalStock,
        5,
        item.featured ? 1 : 0,
        JSON.stringify(item.colors),
        JSON.stringify(item.sizes),
        ts,
        ts,
        ts
      );

      for (const v of variantRows) {
        insertVariant.run(
          v.id,
          item.id,
          v.sku,
          v.size,
          v.colorName,
          v.colorHex,
          pricePaise,
          compareAtPaise,
          v.stockQty,
          v.pos
        );
      }

      item.images.forEach((img, idx) => {
        insertImage.run(
          crypto.randomUUID(),
          item.id,
          img.url,
          img.alt,
          idx === 0 ? 1 : 0,
          idx,
          ts
        );
      });
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}
