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
  // Preserved on existing records for legacy/contact continuity; never used for authentication
  phone_e164: string | null;
  phone_verified: number;
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
  return_request_json?: string | null;
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
    CREATE INDEX IF NOT EXISTS idx_orders_customer_user_id ON orders(customer_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_addresses_user ON customer_addresses(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_notif_user ON customer_notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_categories_position ON categories(position ASC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_contact_messages_status_created ON contact_messages(status, created_at DESC);
  `);

  const orderCols = (
    db.prepare(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const ensureOrderCol = (name: string, ddl: string) => {
    if (!orderCols.includes(name)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${ddl};`);
    }
  };
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
  ensureOrderCol('return_request_json', `return_request_json TEXT`);
  ensureOrderCol('updated_at', `updated_at INTEGER`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_razorpay_order_id ON orders(razorpay_order_id);
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
  featured: boolean;
  dateAdded: string;
  images: Array<{ url: string; alt: string }>;
  colors: Array<{ name: string; hex: string }>;
  sizes: string[];
  defaultVariantStock: number;
}

export const INITIAL_SEED_PRODUCTS: SeedProductDef[] = [
  {
    id: 'sc-001',
    slug: 'noor-pearl-embroidered-organza-gown',
    title: 'Noor Pearl-Embroidered Organza Gown',
    category: 'Dresses',
    sku: 'SC-DRS-001',
    priceInr: 4850,
    compareAtInr: 5600,
    description:
      'Airy blush-ivory silk organza tiered gown finished with delicate hand-placed pearl botanical motifs along the bodice and sheer full sleeves.',
    fabricNote: 'Silk organza with soft mulmul lining',
    featured: true,
    dateAdded: '2026-11-10',
    images: [
      {
        url: '/boutique-media/hero_editorial_couture_1794557656265.jpg',
        alt: 'Noor Pearl-Embroidered Organza Gown in blush ivory',
      },
      {
        url: '/boutique-media/col_dresses_1794557657118.jpg',
        alt: 'Flowing tiered organza skirt silhouette in movement',
      },
    ],
    colors: [
      { name: 'Blush Ivory', hex: '#F4DFDF' },
      { name: 'Warm Cream', hex: '#F6EDE4' },
      { name: 'Dusty Rose', hex: '#C98A95' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 4,
  },
  {
    id: 'sc-002',
    slug: 'zoya-zari-plum-anarkali-ensemble',
    title: 'Zoya Zari Plum Anarkali Ensemble',
    category: 'Ethnic Wear',
    sku: 'SC-ETH-002',
    priceInr: 5490,
    description:
      'Floor-sweeping mulberry plum silk blend Anarkali contrasted with a muted rose border, woven zari hem, and gossamer organza dupatta.',
    fabricNote: 'Chanderi silk blend with organza dupatta',
    featured: true,
    dateAdded: '2026-11-08',
    images: [
      {
        url: '/boutique-media/col_ethnic_wear_1794557657086.jpg',
        alt: 'Zoya Zari Plum Anarkali Ensemble with rose organza dupatta',
      },
      {
        url: '/boutique-media/spotlight_edit_1794557658400.jpg',
        alt: 'Close look at rich plum and rose tonal embroidery',
      },
    ],
    colors: [
      { name: 'Deep Plum', hex: '#49243E' },
      { name: 'Muted Rose', hex: '#B76E79' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 5,
  },
  {
    id: 'sc-003',
    slug: 'ivory-atelier-satin-blazer-trouser-set',
    title: 'Ivory Atelier Satin Blazer & Trouser Set',
    category: 'Western Wear',
    sku: 'SC-WST-003',
    priceInr: 4290,
    description:
      'Clean-lined single-breasted satin blazer paired with high-waisted pleated trousers for effortless daytime tailoring or evening dinners.',
    fabricNote: 'Matte crepe-back satin, lined',
    featured: true,
    dateAdded: '2026-11-06',
    images: [
      {
        url: '/boutique-media/col_western_wear_1794557656476.jpg',
        alt: 'Ivory Atelier Satin Blazer and Pleated Trouser Set',
      },
      {
        url: '/boutique-media/prod_co_ord_set_1794557660472.jpg',
        alt: 'Alternative tailored co-ord silhouette',
      },
    ],
    colors: [
      { name: 'Warm Ivory', hex: '#F4ECE2' },
      { name: 'Mauve Plum', hex: '#7A4E61' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    defaultVariantStock: 6,
  },
  {
    id: 'sc-004',
    slug: 'aanya-flutter-sleeve-tiered-midi-dress',
    title: 'Aanya Flutter-Sleeve Tiered Midi Dress',
    category: 'Dresses',
    sku: 'SC-DRS-004',
    priceInr: 3250,
    description:
      'Romantic blush-pink georgette midi dress featuring soft flutter sleeves, a self-tie waist sash, and three cascading skirt tiers.',
    fabricNote: 'Lightweight crinkle chiffon, cotton-voile lining',
    featured: true,
    dateAdded: '2026-11-05',
    images: [
      {
        url: '/boutique-media/col_dresses_1794557657118.jpg',
        alt: 'Aanya Flutter-Sleeve Tiered Midi Dress in soft blush',
      },
      {
        url: '/boutique-media/prod_floral_wrap_dress_1794557659364.jpg',
        alt: 'Soft afternoon drape styling inspiration',
      },
    ],
    colors: [
      { name: 'Blush Pink', hex: '#F3D5DF' },
      { name: 'Rosewood', hex: '#B76E79' },
      { name: 'Ivory', hex: '#FAF3EB' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 4,
  },
  {
    id: 'sc-005',
    slug: 'meher-velvet-scalloped-sharara-set',
    title: 'Meher Velvet Scalloped Sharara Set',
    category: 'Festive Collection',
    sku: 'SC-FST-005',
    priceInr: 6890,
    compareAtInr: 7600,
    description:
      'Lustrous mulberry plum micro-velvet short kurta and flared sharara detailed with antique-gold resham work and a scalloped organza dupatta.',
    fabricNote: 'Silk-viscose velvet with embroidered organza',
    featured: true,
    dateAdded: '2026-11-03',
    images: [
      {
        url: '/boutique-media/col_festive_wear_1794557658541.jpg',
        alt: 'Meher Velvet Scalloped Sharara Set in mulberry plum',
      },
      {
        url: '/boutique-media/col_ethnic_wear_1794557657086.jpg',
        alt: 'Festive silhouette with sheer embroidered dupatta',
      },
    ],
    colors: [
      { name: 'Mulberry Plum', hex: '#49243E' },
      { name: 'Wine Rose', hex: '#7C3E57' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
    defaultVariantStock: 3,
  },
  {
    id: 'sc-006',
    slug: 'ira-pearl-border-tissue-organza-saree',
    title: 'Ira Pearl-Border Tissue Organza Saree',
    category: 'Festive Collection',
    sku: 'SC-FST-006',
    priceInr: 5950,
    description:
      'Translucent blush-ivory tissue organza saree edged with hand-sewn pearl scallops and delicate floral threadwork, paired with an embroidered blouse.',
    fabricNote: 'Handloom tissue organza with unstitched silk blouse',
    featured: true,
    dateAdded: '2026-11-01',
    images: [
      {
        url: '/boutique-media/prod_pearl_organza_saree_1794557659748.jpg',
        alt: 'Ira Pearl-Border Tissue Organza Saree with embroidered blouse',
      },
      {
        url: '/boutique-media/hero_editorial_couture_1794557656265.jpg',
        alt: 'Luminous sheer ivory-blush organza texture detail',
      },
    ],
    colors: [
      { name: 'Champagne Blush', hex: '#EEDAD4' },
      { name: 'Warm Ivory', hex: '#F6EEE6' },
    ],
    sizes: ['Free Size'],
    defaultVariantStock: 5,
  },
  {
    id: 'sc-007',
    slug: 'kavya-chikankari-cotton-silk-kurta-set',
    title: 'Kavya Chikankari Cotton-Silk Kurta Set',
    category: 'Ethnic Wear',
    sku: 'SC-ETH-007',
    priceInr: 2890,
    description:
      'Breathable ivory cotton-silk straight kurta adorned with tonal shadow-work botanical embroidery and wide-leg embroidered palazzos.',
    fabricNote: 'Cotton-silk blend, breathable weave',
    featured: false,
    dateAdded: '2026-10-28',
    images: [
      {
        url: '/boutique-media/prod_pastel_kurti_1794557659380.jpg',
        alt: 'Kavya Chikankari Cotton-Silk Kurta Set in warm ivory',
      },
      {
        url: '/boutique-media/prod_pearl_organza_saree_1794557659748.jpg',
        alt: 'Subtle ivory tonal craftsmanship detail',
      },
    ],
    colors: [
      { name: 'Alabaster Ivory', hex: '#F5EFE6' },
      { name: 'Soft Blush', hex: '#F3D5DF' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 6,
  },
  {
    id: 'sc-008',
    slug: 'sia-rose-floral-satin-wrap-dress',
    title: 'Sia Rose-Floral Satin Wrap Dress',
    category: 'Dresses',
    sku: 'SC-DRS-008',
    priceInr: 3490,
    description:
      'Fluid dusty-rose satin wrap midi printed with painterly ivory blooms, kimono-style sleeves, and a gently ruffled asymmetrical hem.',
    fabricNote: 'Fluid viscose satin',
    featured: false,
    dateAdded: '2026-10-25',
    images: [
      {
        url: '/boutique-media/prod_floral_wrap_dress_1794557659364.jpg',
        alt: 'Sia Rose-Floral Satin Wrap Dress with waist tie',
      },
      {
        url: '/boutique-media/col_dresses_1794557657118.jpg',
        alt: 'Alternative romantic midi dress movement',
      },
    ],
    colors: [
      { name: 'Dusty Rose', hex: '#B76E79' },
      { name: 'Blush', hex: '#F3D5DF' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    defaultVariantStock: 5,
  },
  {
    id: 'sc-009',
    slug: 'tara-mauve-linen-silk-co-ord-set',
    title: 'Tara Mauve Linen-Silk Co-ord Set',
    category: 'Western Wear',
    sku: 'SC-WST-009',
    priceInr: 3890,
    description:
      'Structured cropped jacket with patch pockets paired with belted wide-leg pleated trousers in a rich mauve-plum linen-silk weave.',
    fabricNote: 'Linen-silk blend with breathable finish',
    featured: false,
    dateAdded: '2026-10-22',
    images: [
      {
        url: '/boutique-media/prod_co_ord_set_1794557660472.jpg',
        alt: 'Tara Mauve Linen-Silk Cropped Jacket and Trouser Co-ord Set',
      },
      {
        url: '/boutique-media/col_western_wear_1794557656476.jpg',
        alt: 'Tailored trouser silhouette in studio daylight',
      },
    ],
    colors: [
      { name: 'Mauve Plum', hex: '#7A4E61' },
      { name: 'Warm Ivory', hex: '#F4ECE2' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 4,
  },
  {
    id: 'sc-010',
    slug: 'rhea-draped-rose-silk-cape-gown',
    title: 'Rhea Draped Rose Silk Cape Gown',
    category: 'Festive Collection',
    sku: 'SC-FST-010',
    priceInr: 7250,
    description:
      'The centerpiece of The Spotlight Edit — a sculptural muted-rose draped gown featuring architectural cape sleeves and fine metallic threadwork.',
    fabricNote: 'Pure crepe silk with metallic zardozi accents',
    featured: true,
    dateAdded: '2026-11-09',
    images: [
      {
        url: '/boutique-media/spotlight_edit_1794557658400.jpg',
        alt: 'Rhea Draped Rose Silk Cape Gown from The Spotlight Edit',
      },
      {
        url: '/boutique-media/col_festive_wear_1794557658541.jpg',
        alt: 'Evening festive collection inspiration',
      },
    ],
    colors: [
      { name: 'Muted Rose', hex: '#B76E79' },
      { name: 'Deep Plum', hex: '#49243E' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    defaultVariantStock: 2,
  },
  {
    id: 'sc-011',
    slug: 'miraya-pearl-tassel-silk-potli-hairpin-duo',
    title: 'Miraya Pearl-Tassel Silk Potli & Hairpin Duo',
    category: 'Accessories',
    sku: 'SC-ACC-011',
    priceInr: 1850,
    description:
      'Hand-embroidered blush raw silk potli clutch finished with freshwater-style pearl drawstring tassels and a pair of rose-gold baroque pearl hairpins.',
    fabricNote: 'Raw silk exterior, satin lining, alloy pins',
    featured: false,
    dateAdded: '2026-10-18',
    images: [
      {
        url: '/boutique-media/prod_silk_potli_bag_1794557659980.jpg',
        alt: 'Miraya Pearl-Tassel Silk Potli and Baroque Pearl Hairpin Duo',
      },
      {
        url: '/boutique-media/col_accessories_1794557657836.jpg',
        alt: 'Coordinated pearl clutch and accessory styling',
      },
    ],
    colors: [
      { name: 'Rose Blush', hex: '#D99FA9' },
      { name: 'Champagne Ivory', hex: '#EFE4D8' },
    ],
    sizes: ['One Size'],
    defaultVariantStock: 8,
  },
  {
    id: 'sc-012',
    slug: 'naina-kundan-drop-silk-stole-set',
    title: 'Naina Kundan Drop & Silk Stole Set',
    category: 'Accessories',
    sku: 'SC-ACC-012',
    priceInr: 1990,
    description:
      'Curated finishing set pairing rose-gold kundan pearl drop earrings with a lustrous dusty-rose pure silk stole and pearl-beaded evening pouch.',
    fabricNote: 'Pure mulberry silk stole, rose-gold plated earrings',
    featured: false,
    dateAdded: '2026-10-15',
    images: [
      {
        url: '/boutique-media/col_accessories_1794557657836.jpg',
        alt: 'Naina Kundan Drop Earrings, Dusty Rose Silk Stole, and Pearl Potli',
      },
      {
        url: '/boutique-media/prod_silk_potli_bag_1794557659980.jpg',
        alt: 'Complementary rose-gold pearl detail view',
      },
    ],
    colors: [
      { name: 'Dusty Rose', hex: '#B76E79' },
      { name: 'Pearl Ivory', hex: '#F7F0E9' },
    ],
    sizes: ['One Size'],
    defaultVariantStock: 2,
  },
  {
    id: 'sc-101',
    slug: 'floral-cotton-kurti',
    title: 'Floral Cotton Kurti',
    category: 'Kurtis',
    sku: 'SC-KRT-101',
    priceInr: 699,
    description: 'Lightweight breathable cotton daily kurti with delicate floral block print and comfortable straight fit.',
    fabricNote: '100% Cambric Cotton',
    featured: true,
    dateAdded: '2026-11-12',
    images: [
      { url: '/boutique-media/prod_pastel_kurti_1794557659380.jpg', alt: 'Floral Cotton Kurti in fresh pastel' },
      { url: '/boutique-media/col_ethnic_wear_1794557657086.jpg', alt: 'Cotton block print closeup' },
    ],
    colors: [
      { name: 'Soft Peach', hex: '#FADADD' },
      { name: 'Alabaster Ivory', hex: '#F5EFE6' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 10,
  },
  {
    id: 'sc-102',
    slug: 'embroidered-rayon-kurti',
    title: 'Embroidered Rayon Kurti',
    category: 'Kurtis',
    sku: 'SC-KRT-102',
    priceInr: 899,
    description: 'Soft fluid rayon kurti featuring exquisite yoke thread embroidery and three-quarter sleeves.',
    fabricNote: 'Premium Rayon Silk',
    featured: true,
    dateAdded: '2026-11-12',
    images: [
      { url: '/boutique-media/col_ethnic_wear_1794557657086.jpg', alt: 'Embroidered Rayon Kurti' },
      { url: '/boutique-media/spotlight_edit_1794557658400.jpg', alt: 'Embroidery detail view' },
    ],
    colors: [
      { name: 'Deep Plum', hex: '#49243E' },
      { name: 'Muted Rose', hex: '#B76E79' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
    defaultVariantStock: 8,
  },
  {
    id: 'sc-103',
    slug: 'straight-cut-printed-kurti',
    title: 'Straight-Cut Printed Kurti',
    category: 'Kurtis',
    sku: 'SC-KRT-103',
    priceInr: 749,
    description: 'Elegant straight-cut daily wear kurti with geometric print and side slits for effortless styling.',
    fabricNote: 'Pure Cotton Slub',
    featured: false,
    dateAdded: '2026-11-11',
    images: [
      { url: '/boutique-media/prod_pastel_kurti_1794557659380.jpg', alt: 'Straight-Cut Printed Kurti' },
    ],
    colors: [
      { name: 'Warm Ivory', hex: '#F6EEE6' },
      { name: 'Dusty Blue', hex: '#A4B0BE' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 12,
  },
  {
    id: 'sc-104',
    slug: 'anarkali-kurti',
    title: 'Anarkali Kurti',
    category: 'Kurtis',
    sku: 'SC-KRT-104',
    priceInr: 1199,
    description: 'Graceful flared Anarkali kurti with intricate border detailing and flowing silhouette.',
    fabricNote: 'Cotton Chanderi',
    featured: true,
    dateAdded: '2026-11-11',
    images: [
      { url: '/boutique-media/col_ethnic_wear_1794557657086.jpg', alt: 'Anarkali Kurti flared silhouette' },
    ],
    colors: [
      { name: 'Mulberry Wine', hex: '#7C3E57' },
      { name: 'Blush Pink', hex: '#F3D5DF' },
    ],
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    defaultVariantStock: 7,
  },
  {
    id: 'sc-105',
    slug: 'cotton-kurta-and-pant-set',
    title: 'Cotton Kurta and Pant Set',
    category: 'Kurta Sets',
    sku: 'SC-KSET-101',
    priceInr: 1299,
    description: 'Coordinated daily kurta paired with matching elasticated trousers for all-day comfort and poise.',
    fabricNote: 'Breathable Cotton Weave',
    featured: true,
    dateAdded: '2026-11-10',
    images: [
      { url: '/boutique-media/prod_co_ord_set_1794557660472.jpg', alt: 'Cotton Kurta and Pant Set' },
    ],
    colors: [
      { name: 'Alabaster', hex: '#F5EFE6' },
      { name: 'Mauve', hex: '#7A4E61' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 9,
  },
  {
    id: 'sc-106',
    slug: 'floral-kurta-and-dupatta-set',
    title: 'Floral Kurta and Dupatta Set',
    category: 'Kurta Sets',
    sku: 'SC-KSET-102',
    priceInr: 1599,
    description: 'Charming floral printed kurta set complete with a lightweight matching soft dupatta.',
    fabricNote: 'Cotton Voile with Organza Dupatta',
    featured: true,
    dateAdded: '2026-11-10',
    images: [
      { url: '/boutique-media/prod_floral_wrap_dress_1794557659364.jpg', alt: 'Floral Kurta and Dupatta Set' },
    ],
    colors: [
      { name: 'Rose Blush', hex: '#D99FA9' },
      { name: 'Ivory', hex: '#FAF3EB' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
    defaultVariantStock: 6,
  },
  {
    id: 'sc-107',
    slug: 'embroidered-three-piece-kurta-set',
    title: 'Embroidered Three-Piece Kurta Set',
    category: 'Kurta Sets',
    sku: 'SC-KSET-103',
    priceInr: 1999,
    description: 'Luxurious three-piece ensemble featuring an embroidered kurta, coordinating pants, and elegant sheer dupatta.',
    fabricNote: 'Chanderi Silk Blend',
    featured: true,
    dateAdded: '2026-11-09',
    images: [
      { url: '/boutique-media/spotlight_edit_1794557658400.jpg', alt: 'Embroidered Three-Piece Kurta Set' },
    ],
    colors: [
      { name: 'Deep Plum', hex: '#49243E' },
      { name: 'Champagne', hex: '#EEDAD4' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 5,
  },
  {
    id: 'sc-108',
    slug: 'printed-cotton-saree',
    title: 'Printed Cotton Saree',
    category: 'Sarees',
    sku: 'SC-SAR-101',
    priceInr: 1099,
    description: 'Easy-drape everyday cotton saree adorned with contemporary botanical block prints and unstitched blouse piece.',
    fabricNote: 'Pure Cotton Handloom',
    featured: false,
    dateAdded: '2026-11-08',
    images: [
      { url: '/boutique-media/prod_pearl_organza_saree_1794557659748.jpg', alt: 'Printed Cotton Saree' },
    ],
    colors: [
      { name: 'Indigo Blue', hex: '#2C3E50' },
      { name: 'Warm Ivory', hex: '#F6EEE6' },
    ],
    sizes: ['Free Size'],
    defaultVariantStock: 8,
  },
  {
    id: 'sc-109',
    slug: 'soft-silk-blend-saree',
    title: 'Soft Silk-Blend Saree',
    category: 'Sarees',
    sku: 'SC-SAR-102',
    priceInr: 1799,
    description: 'Luminous soft silk-blend saree with subtle zari border and graceful drape for family gatherings.',
    fabricNote: 'Silk Blend with Zari Weave',
    featured: true,
    dateAdded: '2026-11-08',
    images: [
      { url: '/boutique-media/hero_editorial_couture_1794557656265.jpg', alt: 'Soft Silk-Blend Saree' },
    ],
    colors: [
      { name: 'Muted Rose', hex: '#B76E79' },
      { name: 'Gold Tissue', hex: '#E2C9A0' },
    ],
    sizes: ['Free Size'],
    defaultVariantStock: 6,
  },
  {
    id: 'sc-110',
    slug: 'floral-georgette-saree',
    title: 'Floral Georgette Saree',
    category: 'Sarees',
    sku: 'SC-SAR-103',
    priceInr: 1499,
    description: 'Lightweight airy georgette saree printed with romantic watercolor florals and finished with a delicate trim.',
    fabricNote: 'Crinkle Georgette',
    featured: false,
    dateAdded: '2026-11-07',
    images: [
      { url: '/boutique-media/col_dresses_1794557657118.jpg', alt: 'Floral Georgette Saree' },
    ],
    colors: [
      { name: 'Blush Pink', hex: '#F3D5DF' },
      { name: 'Lavender', hex: '#D7BDE2' },
    ],
    sizes: ['Free Size'],
    defaultVariantStock: 7,
  },
  {
    id: 'sc-111',
    slug: 'festive-woven-border-saree',
    title: 'Festive Woven-Border Saree',
    category: 'Sarees',
    sku: 'SC-SAR-104',
    priceInr: 1899,
    description: 'Celebratory saree highlighted by a rich traditional woven zari border and pallu.',
    fabricNote: 'Tissue Silk Blend',
    featured: true,
    dateAdded: '2026-11-07',
    images: [
      { url: '/boutique-media/col_festive_wear_1794557658541.jpg', alt: 'Festive Woven-Border Saree' },
    ],
    colors: [
      { name: 'Mulberry Plum', hex: '#49243E' },
      { name: 'Antique Gold', hex: '#C5A059' },
    ],
    sizes: ['Free Size'],
    defaultVariantStock: 4,
  },
  {
    id: 'sc-112',
    slug: 'printed-cotton-co-ord-set',
    title: 'Printed Cotton Co-ord Set',
    category: 'Co-ord Sets',
    sku: 'SC-CORD-101',
    priceInr: 1399,
    description: 'Modern matching shirt and relaxed trousers in a vibrant artisanal print for effortless chic.',
    fabricNote: 'Breathable Cotton Poplin',
    featured: true,
    dateAdded: '2026-11-06',
    images: [
      { url: '/boutique-media/prod_co_ord_set_1794557660472.jpg', alt: 'Printed Cotton Co-ord Set' },
    ],
    colors: [
      { name: 'Sage Green', hex: '#A3B18B' },
      { name: 'Warm Ivory', hex: '#F4ECE2' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    defaultVariantStock: 8,
  },
  {
    id: 'sc-113',
    slug: 'solid-two-piece-co-ord-set',
    title: 'Solid Two-Piece Co-ord Set',
    category: 'Co-ord Sets',
    sku: 'SC-CORD-102',
    priceInr: 1599,
    description: 'Tailored solid-hue top and wide-leg trouser set designed for minimalist sophistication.',
    fabricNote: 'Linen-Cotton Blend',
    featured: false,
    dateAdded: '2026-11-06',
    images: [
      { url: '/boutique-media/col_western_wear_1794557656476.jpg', alt: 'Solid Two-Piece Co-ord Set' },
    ],
    colors: [
      { name: 'Mauve Plum', hex: '#7A4E61' },
      { name: 'Alabaster', hex: '#F5EFE6' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    defaultVariantStock: 6,
  },
  {
    id: 'sc-114',
    slug: 'embroidered-chiffon-dupatta',
    title: 'Embroidered Chiffon Dupatta',
    category: 'Dupattas',
    sku: 'SC-DUP-101',
    priceInr: 499,
    description: 'Lightweight sheer chiffon dupatta finished with delicate thread embroidery along the borders.',
    fabricNote: 'Fine Chiffon',
    featured: false,
    dateAdded: '2026-11-05',
    images: [
      { url: '/boutique-media/col_accessories_1794557657836.jpg', alt: 'Embroidered Chiffon Dupatta' },
    ],
    colors: [
      { name: 'Ivory', hex: '#FAF3EB' },
      { name: 'Blush', hex: '#F3D5DF' },
    ],
    sizes: ['One Size'],
    defaultVariantStock: 15,
  },
  {
    id: 'sc-115',
    slug: 'woven-border-dupatta',
    title: 'Woven-Border Dupatta',
    category: 'Dupattas',
    sku: 'SC-DUP-102',
    priceInr: 599,
    description: 'Elegant ethnic drape featuring a traditional woven zari border to elevate any basic kurti or suit.',
    fabricNote: 'Banarasi Cotton-Silk',
    featured: true,
    dateAdded: '2026-11-05',
    images: [
      { url: '/boutique-media/prod_silk_potli_bag_1794557659980.jpg', alt: 'Woven-Border Dupatta' },
    ],
    colors: [
      { name: 'Gold Tissue', hex: '#E2C9A0' },
      { name: 'Deep Plum', hex: '#49243E' },
    ],
    sizes: ['One Size'],
    defaultVariantStock: 12,
  },
];

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
        id, slug, title, description, fabric_note, category, sku,
        price_paise, compare_at_paise, stock_qty, low_stock_threshold,
        featured, status, colors_json, sizes_json, version,
        published_at, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, 1, ?, NULL, ?, ?)`
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
