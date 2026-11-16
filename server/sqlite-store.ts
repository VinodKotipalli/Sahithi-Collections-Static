import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  bindOwnerAccount as sqliteBindOwnerAccount,
  initAuthDatabase,
  listLegacyPhoneOnlyAccounts as sqliteListLegacyAccounts,
  resolveBoundOwner as sqliteResolveBoundOwner,
  seedInitialCatalogIfEmpty as sqliteSeedCatalog,
} from './db.ts';
import type { RuntimeTargetEnv } from './env.ts';
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

export class SqliteBoutiqueStore implements BoutiqueStore {
  readonly backend = 'sqlite' as const;
  readonly isPersistent: boolean;
  readonly locationLabel: string;
  readonly targetEnv: RuntimeTargetEnv;
  readonly db: DatabaseSync;

  constructor(options: {
    dbPath: string;
    targetEnv: RuntimeTargetEnv;
    seedCatalog?: boolean;
    isPersistent?: boolean;
  }) {
    this.db = initAuthDatabase(options.dbPath, { seedCatalog: options.seedCatalog });
    this.targetEnv = options.targetEnv;
    this.locationLabel = options.dbPath;
    this.isPersistent = options.isPersistent ?? false;
  }

  async verifyConnectivity(): Promise<void> {
    this.db.prepare('SELECT 1 AS ok').get();
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async getUserById(id: string): Promise<UserRow | null> {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ? LIMIT 1`).get(id) as
      | UserRow
      | undefined;
    return row || null;
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE email = ? LIMIT 1`)
      .get(email.trim().toLowerCase()) as UserRow | undefined;
    return row || null;
  }

  async isEmailTakenByOtherUser(email: string, excludeUserId: string): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1`)
      .get(email.trim().toLowerCase(), excludeUserId) as { id: string } | undefined;
    return Boolean(row);
  }

  async createPendingEmailUser(input: {
    id: string;
    fullName: string;
    email: string;
    passwordHash: string;
    now: number;
  }): Promise<UserRow> {
    const normalized = input.email.trim().toLowerCase();
    this.db
      .prepare(
        `INSERT INTO users (id, full_name, email, email_verified, password_hash, phone_e164, phone_verified, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, NULL, 0, ?, ?)`
      )
      .run(input.id, input.fullName, normalized, input.passwordHash, input.now, input.now);
    return (await this.getUserById(input.id))!;
  }

  async updatePendingEmailUser(input: {
    id: string;
    fullName: string;
    passwordHash: string;
    now: number;
  }): Promise<UserRow | null> {
    this.db
      .prepare(
        `UPDATE users SET full_name = ?, password_hash = ?, updated_at = ? WHERE id = ? AND email_verified = 0`
      )
      .run(input.fullName, input.passwordHash, input.now, input.id);
    return this.getUserById(input.id);
  }

  async markUserEmailVerified(userId: string, now: number): Promise<UserRow> {
    this.db
      .prepare(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`)
      .run(now, userId);
    return (await this.getUserById(userId))!;
  }

  async linkVerifiedEmailToUser(userId: string, newEmail: string, now: number): Promise<UserRow> {
    this.db
      .prepare(`UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?`)
      .run(newEmail.trim().toLowerCase(), now, userId);
    return (await this.getUserById(userId))!;
  }

  async updateUserFullName(userId: string, fullName: string, now: number): Promise<UserRow> {
    this.db
      .prepare(`UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?`)
      .run(fullName, now, userId);
    return (await this.getUserById(userId))!;
  }

  async updateUserPasswordHash(userId: string, passwordHash: string, now: number): Promise<void> {
    this.db
      .prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
      .run(passwordHash, now, userId);
  }

  async listLegacyPhoneOnlyAccounts(): Promise<LegacyPhoneOnlyAccount[]> {
    return sqliteListLegacyAccounts(this.db);
  }

  async getActiveSessionByTokenHash(tokenHash: string, now: number): Promise<SessionRow | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`
      )
      .get(tokenHash, now) as SessionRow | undefined;
    return row || null;
  }

  async createSession(session: SessionRow): Promise<SessionRow> {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_secret, last_reauth_at, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        session.id,
        session.user_id,
        session.token_hash,
        session.csrf_secret,
        session.last_reauth_at,
        session.expires_at,
        session.created_at
      );
    return session;
  }

  async updateSessionReauth(sessionId: string, lastReauthAt: number): Promise<void> {
    this.db
      .prepare(`UPDATE sessions SET last_reauth_at = ? WHERE id = ?`)
      .run(lastReauthAt, sessionId);
  }

  async revokeSession(sessionId: string, now: number): Promise<void> {
    this.db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).run(now, sessionId);
  }

  async revokeUserSessions(userId: string, now: number, exceptSessionId?: string): Promise<void> {
    if (exceptSessionId) {
      this.db
        .prepare(
          `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL`
        )
        .run(now, userId, exceptSessionId);
    } else {
      this.db
        .prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
        .run(now, userId);
    }
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
      this.db
        .prepare(
          `UPDATE email_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`
        )
        .run(params.createdAt, params.userId, params.purpose);
    }

    this.db
      .prepare(
        `INSERT INTO email_tokens (id, user_id, purpose, target_email, token_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        params.id,
        params.userId,
        params.purpose,
        params.targetEmail.trim().toLowerCase(),
        params.tokenHash,
        params.expiresAt,
        params.createdAt
      );

    return {
      id: params.id,
      user_id: params.userId,
      purpose: params.purpose,
      target_email: params.targetEmail.trim().toLowerCase(),
      token_hash: params.tokenHash,
      expires_at: params.expiresAt,
      consumed_at: null,
      created_at: params.createdAt,
    };
  }

  async deleteEmailToken(tokenId: string): Promise<void> {
    this.db.prepare(`DELETE FROM email_tokens WHERE id = ?`).run(tokenId);
  }

  async getLatestVerifyEmailTokenTimestamp(userId: string): Promise<number | null> {
    const row = this.db
      .prepare(
        `SELECT created_at FROM email_tokens
         WHERE user_id = ? AND purpose = 'verify_email'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId) as { created_at: number } | undefined;
    return row ? row.created_at : null;
  }

  async getEmailTokenByHash(
    tokenHash: string,
    purposes: EmailTokenRow['purpose'][]
  ): Promise<EmailTokenRow | null> {
    const placeholders = purposes.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT * FROM email_tokens WHERE token_hash = ? AND purpose IN (${placeholders}) LIMIT 1`
      )
      .get(tokenHash, ...purposes) as EmailTokenRow | undefined;
    return row || null;
  }

  async consumeEmailToken(tokenId: string, now: number): Promise<boolean> {
    const res = this.db
      .prepare(`UPDATE email_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
      .run(now, tokenId);
    return res.changes > 0;
  }

  async getStoredAdminBinding(): Promise<AdminBindingRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM admin_bindings WHERE id = 1 LIMIT 1`)
      .get() as AdminBindingRow | undefined;
    return row || null;
  }

  async resolveBoundOwner(): Promise<AdminBindingRow | null> {
    return sqliteResolveBoundOwner(this.db);
  }

  async bindOwnerAccount(params: {
    email: string;
    boundVia?: string;
    forceRebind?: boolean;
  }): Promise<AdminBindingRow> {
    return sqliteBindOwnerAccount(this.db, params);
  }

  async seedInitialCatalogIfEmpty(): Promise<void> {
    sqliteSeedCatalog(this.db);
  }

  private fetchProductParts(productId: string): {
    variants: ProductVariantRow[];
    images: ProductImageRow[];
  } {
    const variants = this.db
      .prepare(`SELECT * FROM product_variants WHERE product_id = ? ORDER BY position ASC, id ASC`)
      .all(productId) as unknown as ProductVariantRow[];
    const images = this.db
      .prepare(
        `SELECT * FROM product_images WHERE product_id = ? ORDER BY is_cover DESC, position ASC, created_at ASC`
      )
      .all(productId) as unknown as ProductImageRow[];
    return { variants, images };
  }

  private toAdminProductRecord(row: ProductRow): AdminProductRecord {
    const { variants, images } = this.fetchProductParts(row.id);
    const orderRef = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM order_items WHERE product_id = ?`)
      .get(row.id) as { cnt: number };
    return {
      product: row,
      variants,
      images,
      orderCount: orderRef.cnt,
    };
  }

  private recordAuditLogSync(params: {
    productId: string;
    productTitle: string;
    actorUserId: string;
    action: string;
    summary: string;
    before?: unknown;
    after?: unknown;
  }) {
    this.db
      .prepare(
        `INSERT INTO product_audit_logs (
          id, product_id, product_title, actor_user_id, action, summary, before_json, after_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        params.productId,
        params.productTitle,
        params.actorUserId,
        params.action,
        params.summary,
        params.before !== undefined ? JSON.stringify(params.before) : null,
        params.after !== undefined ? JSON.stringify(params.after) : null,
        Date.now()
      );
  }

  async listPublicProducts(filters: {
    category?: string;
    q?: string;
    featuredOnly?: boolean;
  }): Promise<ProductWithParts[]> {
    let rows = this.db
      .prepare(
        `SELECT * FROM products WHERE status = 'published' ORDER BY published_at DESC, created_at DESC`
      )
      .all() as unknown as ProductRow[];

    if (filters.category && filters.category !== 'All') {
      rows = rows.filter((r) => r.category === filters.category);
    }
    if (filters.featuredOnly) {
      rows = rows.filter((r) => Boolean(r.featured));
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.fabric_note.toLowerCase().includes(q) ||
          r.colors_json.toLowerCase().includes(q)
      );
    }

    return rows.map((row) => ({ product: row, ...this.fetchProductParts(row.id) }));
  }

  async getPublicProductByIdOrSlug(idOrSlug: string): Promise<ProductWithParts | null> {
    const row = this.db
      .prepare(`SELECT * FROM products WHERE (id = ? OR slug = ?) AND status = 'published' LIMIT 1`)
      .get(idOrSlug, idOrSlug) as ProductRow | undefined;
    if (!row) return null;
    return { product: row, ...this.fetchProductParts(row.id) };
  }

  async isProductSkuConflict(sku: string, excludeProductId?: string): Promise<boolean> {
    const row = excludeProductId
      ? (this.db
          .prepare(`SELECT id FROM products WHERE sku = ? AND id != ? LIMIT 1`)
          .get(sku, excludeProductId) as { id: string } | undefined)
      : (this.db.prepare(`SELECT id FROM products WHERE sku = ? LIMIT 1`).get(sku) as
          | { id: string }
          | undefined);
    return Boolean(row);
  }

  async isVariantSkuConflict(sku: string, excludeProductId?: string): Promise<boolean> {
    const row = excludeProductId
      ? (this.db
          .prepare(`SELECT id FROM product_variants WHERE sku = ? AND product_id != ? LIMIT 1`)
          .get(sku, excludeProductId) as { id: string } | undefined)
      : (this.db.prepare(`SELECT id FROM product_variants WHERE sku = ? LIMIT 1`).get(sku) as
          | { id: string }
          | undefined);
    return Boolean(row);
  }

  async makeUniqueSlug(baseTitle: string, excludeId?: string): Promise<string> {
    const base = slugifyProductTitle(baseTitle);
    let candidate = base;
    let counter = 2;
    while (true) {
      const existing = excludeId
        ? (this.db
            .prepare(`SELECT id FROM products WHERE slug = ? AND id != ? LIMIT 1`)
            .get(candidate, excludeId) as { id: string } | undefined)
        : (this.db.prepare(`SELECT id FROM products WHERE slug = ? LIMIT 1`).get(candidate) as
            | { id: string }
            | undefined);
      if (!existing) return candidate;
      candidate = `${base}-${counter}`;
      counter += 1;
    }
  }

  async getAdminOverview(): Promise<AdminOverviewData> {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS totalProducts,
           SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS publishedProducts,
           SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draftProducts,
           SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archivedProducts,
           SUM(CASE WHEN status != 'archived' AND stock_qty <= low_stock_threshold THEN 1 ELSE 0 END) AS lowStockProducts,
           SUM(CASE WHEN status != 'archived' AND stock_qty = 0 THEN 1 ELSE 0 END) AS outOfStockProducts
         FROM products`
      )
      .get() as Record<string, number | null>;

    const totalCategories = (
      this.db.prepare(`SELECT COUNT(*) AS cnt FROM categories`).get() as { cnt: number }
    ).cnt;

    const orderAgg = this.db
      .prepare(
        `SELECT
           COUNT(*) AS totalOrders,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingOrders,
           COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_paise ELSE 0 END), 0) AS totalRevenuePaise
         FROM orders`
      )
      .get() as Record<string, number | null>;

    const msgAgg = this.db
      .prepare(
        `SELECT
           COUNT(*) AS totalMessages,
           SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) AS unreadMessages
         FROM contact_messages`
      )
      .get() as Record<string, number | null>;

    const auditCount = (
      this.db.prepare(`SELECT COUNT(*) AS cnt FROM product_audit_logs`).get() as { cnt: number }
    ).cnt;

    const lowStockItems = this.db
      .prepare(
        `SELECT * FROM products
         WHERE status != 'archived' AND stock_qty <= low_stock_threshold
         ORDER BY stock_qty ASC, updated_at DESC
         LIMIT 6`
      )
      .all() as unknown as ProductRow[];

    const recentOrderRows = this.db
      .prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 5`)
      .all() as unknown as OrderRow[];
    const fetchItems = this.db.prepare(`SELECT * FROM order_items WHERE order_id = ?`);
    const recentOrders: OrderWithItems[] = recentOrderRows.map((order) => ({
      order,
      items: fetchItems.all(order.id) as unknown as OrderItemRow[],
    }));

    const recentMessages = this.db
      .prepare(`SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 5`)
      .all() as unknown as ContactMessageRow[];

    const recentAuditLogs = this.db
      .prepare(`SELECT * FROM product_audit_logs ORDER BY created_at DESC LIMIT 6`)
      .all() as unknown as ProductAuditLogRow[];

    return {
      metrics: {
        totalProducts: Number(counts.totalProducts || 0),
        publishedProducts: Number(counts.publishedProducts || 0),
        draftProducts: Number(counts.draftProducts || 0),
        archivedProducts: Number(counts.archivedProducts || 0),
        lowStockProducts: Number(counts.lowStockProducts || 0),
        outOfStockProducts: Number(counts.outOfStockProducts || 0),
        totalCategories,
        totalOrders: Number(orderAgg.totalOrders || 0),
        pendingOrders: Number(orderAgg.pendingOrders || 0),
        totalRevenuePaise: Number(orderAgg.totalRevenuePaise || 0),
        unreadMessages: Number(msgAgg.unreadMessages || 0),
        totalMessages: Number(msgAgg.totalMessages || 0),
        totalAuditEvents: auditCount,
      },
      lowStockItems: lowStockItems.map((row) => this.toAdminProductRecord(row)),
      recentOrders,
      recentMessages,
      recentAuditLogs,
    };
  }

  async listAdminProducts(query: AdminProductQuery) {
    let rows = this.db.prepare(`SELECT * FROM products`).all() as unknown as ProductRow[];

    if (query.status && query.status !== 'all') {
      rows = rows.filter((r) => r.status === query.status);
    } else {
      rows = rows.filter((r) => r.status !== 'archived');
    }
    if (query.category && query.category !== 'All') {
      rows = rows.filter((r) => r.category === query.category);
    }
    if (query.stockFilter === 'low') {
      rows = rows.filter((r) => r.stock_qty <= r.low_stock_threshold && r.stock_qty > 0);
    } else if (query.stockFilter === 'out') {
      rows = rows.filter((r) => r.stock_qty === 0);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q)
      );
    }

    rows.sort((a, b) => {
      switch (query.sort) {
        case 'newest':
          return b.created_at - a.created_at;
        case 'price_asc':
          return a.price_paise - b.price_paise;
        case 'price_desc':
          return b.price_paise - a.price_paise;
        case 'stock_asc':
          return a.stock_qty - b.stock_qty;
        case 'updated':
        default:
          return b.updated_at - a.updated_at;
      }
    });

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const safePage = Math.min(query.page, totalPages);
    const start = (safePage - 1) * query.pageSize;
    const pageRows = rows.slice(start, start + query.pageSize);

    return {
      items: pageRows.map((row) => this.toAdminProductRecord(row)),
      total,
      page: safePage,
      pageSize: query.pageSize,
      totalPages,
    };
  }

  async getAdminProduct(id: string) {
    const row = this.db.prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`).get(id) as
      | ProductRow
      | undefined;
    if (!row) return null;

    const audits = this.db
      .prepare(`SELECT * FROM product_audit_logs WHERE product_id = ? ORDER BY created_at DESC LIMIT 20`)
      .all(row.id) as unknown as ProductAuditLogRow[];

    return {
      data: this.toAdminProductRecord(row),
      auditLogs: audits,
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
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO products (
            id, slug, title, description, fabric_note, category, sku,
            price_paise, compare_at_paise, stock_qty, low_stock_threshold,
            featured, status, colors_json, sizes_json, version,
            published_at, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          p.id,
          p.slug,
          p.title,
          p.description,
          p.fabric_note,
          p.category,
          p.sku,
          p.price_paise,
          p.compare_at_paise,
          p.stock_qty,
          p.low_stock_threshold,
          p.featured,
          p.status,
          p.colors_json,
          p.sizes_json,
          p.version,
          p.published_at,
          p.archived_at,
          p.created_at,
          p.updated_at
        );

      const insertVariant = this.db.prepare(
        `INSERT INTO product_variants (
          id, product_id, sku, size, color_name, color_hex,
          price_paise, compare_at_paise, stock_qty, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const v of input.variants) {
        insertVariant.run(
          v.id,
          p.id,
          v.sku,
          v.size,
          v.color_name,
          v.color_hex,
          v.price_paise,
          v.compare_at_paise,
          v.stock_qty,
          v.position
        );
      }

      const insertImg = this.db.prepare(
        `INSERT INTO product_images (
          id, product_id, media_id, url, alt_text, is_cover, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      input.images.forEach((img, idx) => {
        insertImg.run(
          crypto.randomUUID(),
          p.id,
          img.mediaId,
          img.url,
          img.alt,
          img.isCover ? 1 : 0,
          idx,
          p.created_at
        );
      });

      this.recordAuditLogSync({
        productId: p.id,
        productTitle: p.title,
        actorUserId: input.actorUserId,
        action: input.auditAction,
        summary: input.auditSummary,
        after: input.auditAfter,
      });

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const created = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(p.id) as unknown as ProductRow;
    return this.toAdminProductRecord(created);
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
    const existing = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(input.productId) as ProductRow | undefined;
    if (!existing) {
      return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    }
    if (existing.version !== input.expectedVersion) {
      return { ok: false as const, code: 'VERSION_CONFLICT' as const };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const nextArchivedAt =
        input.nextStatus === 'archived' ? (existing.archived_at ?? input.now) : null;
      const updateRes = this.db
        .prepare(
          `UPDATE products SET
            slug = ?, title = ?, description = ?, fabric_note = ?, category = ?, sku = ?,
            price_paise = ?, compare_at_paise = ?, stock_qty = ?, low_stock_threshold = ?,
            featured = ?, status = ?, colors_json = ?, sizes_json = ?,
            version = version + 1,
            published_at = COALESCE(published_at, ?),
            archived_at = ?,
            updated_at = ?
           WHERE id = ? AND version = ?`
        )
        .run(
          input.nextSlug,
          input.title,
          input.description,
          input.fabricNote,
          input.category,
          input.sku,
          input.pricePaise,
          input.compareAtPaise,
          input.totalStock,
          input.lowStockThreshold,
          input.featured ? 1 : 0,
          input.nextStatus,
          input.colorsJson,
          input.sizesJson,
          input.publishedAtIfNull,
          nextArchivedAt,
          input.now,
          existing.id,
          input.expectedVersion
        );

      if (updateRes.changes === 0) {
        this.db.exec('ROLLBACK;');
        return { ok: false as const, code: 'VERSION_CONFLICT' as const };
      }

      const existingVariants = this.db
        .prepare(`SELECT id FROM product_variants WHERE product_id = ?`)
        .all(existing.id) as Array<{ id: string }>;
      const keepVariantIds = new Set(input.variants.map((v) => v.id));

      for (const ev of existingVariants) {
        if (!keepVariantIds.has(ev.id)) {
          this.db.prepare(`DELETE FROM product_variants WHERE id = ?`).run(ev.id);
        }
      }

      const upsertVariant = this.db.prepare(
        `INSERT INTO product_variants (
          id, product_id, sku, size, color_name, color_hex,
          price_paise, compare_at_paise, stock_qty, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sku = excluded.sku,
          size = excluded.size,
          color_name = excluded.color_name,
          color_hex = excluded.color_hex,
          price_paise = excluded.price_paise,
          compare_at_paise = excluded.compare_at_paise,
          stock_qty = excluded.stock_qty,
          position = excluded.position`
      );
      for (const v of input.variants) {
        upsertVariant.run(
          v.id,
          existing.id,
          v.sku,
          v.size,
          v.color_name,
          v.color_hex,
          v.price_paise,
          v.compare_at_paise,
          v.stock_qty,
          v.position
        );
      }

      this.db.prepare(`DELETE FROM product_images WHERE product_id = ?`).run(existing.id);
      const insertImg = this.db.prepare(
        `INSERT INTO product_images (
          id, product_id, media_id, url, alt_text, is_cover, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      input.images.forEach((img, idx) => {
        insertImg.run(
          crypto.randomUUID(),
          existing.id,
          img.mediaId,
          img.url,
          img.alt,
          img.isCover ? 1 : 0,
          idx,
          input.now
        );
      });

      this.recordAuditLogSync({
        productId: existing.id,
        productTitle: input.title,
        actorUserId: input.actorUserId,
        action: input.auditAction,
        summary: input.auditSummary,
        before: input.auditBefore,
        after: input.auditAfter,
      });

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const updated = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(existing.id) as unknown as ProductRow;
    return { ok: true as const, product: this.toAdminProductRecord(updated) };
  }

  async duplicateProduct(sourceId: string, actorUserId: string): Promise<AdminProductRecord | null> {
    const source = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(sourceId) as ProductRow | undefined;
    if (!source) return null;

    const { variants, images } = this.fetchProductParts(source.id);
    const now = Date.now();
    const newId = `sc-${crypto.randomBytes(4).toString('hex')}`;
    const copyTitle = `${source.title} (Copy)`.slice(0, 140);
    const copySlug = await this.makeUniqueSlug(copyTitle);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const copySku = `${source.sku.slice(0, 38)}-COPY-${suffix}`;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO products (
            id, slug, title, description, fabric_note, category, sku,
            price_paise, compare_at_paise, stock_qty, low_stock_threshold,
            featured, status, colors_json, sizes_json, version,
            published_at, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?, 1, NULL, NULL, ?, ?)`
        )
        .run(
          newId,
          copySlug,
          copyTitle,
          source.description,
          source.fabric_note,
          source.category,
          copySku,
          source.price_paise,
          source.compare_at_paise,
          source.stock_qty,
          source.low_stock_threshold,
          source.colors_json,
          source.sizes_json,
          now,
          now
        );

      const insertVar = this.db.prepare(
        `INSERT INTO product_variants (
          id, product_id, sku, size, color_name, color_hex,
          price_paise, compare_at_paise, stock_qty, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      variants.forEach((v, idx) => {
        insertVar.run(
          crypto.randomUUID(),
          newId,
          `${copySku}-${idx + 1}`,
          v.size,
          v.color_name,
          v.color_hex,
          v.price_paise,
          v.compare_at_paise,
          v.stock_qty,
          v.position
        );
      });

      const insertImg = this.db.prepare(
        `INSERT INTO product_images (
          id, product_id, media_id, url, alt_text, is_cover, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const img of images) {
        insertImg.run(
          crypto.randomUUID(),
          newId,
          img.media_id,
          img.url,
          img.alt_text,
          img.is_cover,
          img.position,
          now
        );
      }

      this.recordAuditLogSync({
        productId: newId,
        productTitle: copyTitle,
        actorUserId,
        action: 'duplicate',
        summary: `Duplicated "${source.title}" into draft "${copyTitle}".`,
        before: { sourceProductId: source.id },
        after: { newProductId: newId, status: 'draft' },
      });

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const created = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(newId) as unknown as ProductRow;
    return this.toAdminProductRecord(created);
  }

  async transitionProductStatus(input: {
    productId: string;
    expectedVersion: number;
    targetStatus: ProductStatus;
    actionName: 'publish' | 'unpublish' | 'archive' | 'restore';
    actorUserId: string;
  }) {
    const existing = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(input.productId) as ProductRow | undefined;
    if (!existing) {
      return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    }
    if (existing.version !== input.expectedVersion) {
      return { ok: false as const, code: 'VERSION_CONFLICT' as const };
    }

    if (input.targetStatus === 'published') {
      const imgCount = (
        this.db
          .prepare(`SELECT COUNT(*) AS cnt FROM product_images WHERE product_id = ?`)
          .get(existing.id) as { cnt: number }
      ).cnt;
      if (imgCount === 0) {
        return { ok: false as const, code: 'NO_IMAGES' as const };
      }
    }

    const now = Date.now();
    const updateRes = this.db
      .prepare(
        `UPDATE products SET
           status = ?,
           published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
           archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END,
           version = version + 1,
           updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .run(
        input.targetStatus,
        input.targetStatus,
        now,
        input.targetStatus,
        now,
        now,
        existing.id,
        input.expectedVersion
      );

    if (updateRes.changes === 0) {
      return { ok: false as const, code: 'VERSION_CONFLICT' as const };
    }

    this.recordAuditLogSync({
      productId: existing.id,
      productTitle: existing.title,
      actorUserId: input.actorUserId,
      action: input.actionName,
      summary: `${input.actionName.charAt(0).toUpperCase() + input.actionName.slice(1)}ed "${existing.title}" (${existing.status} -> ${input.targetStatus}).`,
      before: { status: existing.status, version: existing.version },
      after: { status: input.targetStatus, version: existing.version + 1 },
    });

    const updated = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(existing.id) as unknown as ProductRow;
    return { ok: true as const, product: this.toAdminProductRecord(updated) };
  }

  async deleteOrArchiveProduct(productId: string, actorUserId: string) {
    const existing = this.db
      .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
      .get(productId) as ProductRow | undefined;
    if (!existing) {
      return { ok: false as const, code: 'PRODUCT_NOT_FOUND' as const };
    }

    const orderCount = (
      this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM order_items WHERE product_id = ?`)
        .get(existing.id) as { cnt: number }
    ).cnt;

    const now = Date.now();
    if (orderCount > 0) {
      this.db
        .prepare(
          `UPDATE products SET status = 'archived', archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?`
        )
        .run(now, now, existing.id);

      this.recordAuditLogSync({
        productId: existing.id,
        productTitle: existing.title,
        actorUserId,
        action: 'archive',
        summary: `Archived "${existing.title}" instead of deleting because it is referenced by ${orderCount} order item(s).`,
        before: { status: existing.status },
        after: { status: 'archived' },
      });

      const archived = this.db
        .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
        .get(existing.id) as unknown as ProductRow;
      return {
        ok: true as const,
        archivedInsteadOfDeleted: true,
        product: this.toAdminProductRecord(archived),
      };
    }

    this.db.prepare(`DELETE FROM products WHERE id = ?`).run(existing.id);
    this.recordAuditLogSync({
      productId: existing.id,
      productTitle: existing.title,
      actorUserId,
      action: 'delete',
      summary: `Permanently deleted unused product "${existing.title}" (SKU: ${existing.sku}).`,
      before: { status: existing.status, sku: existing.sku },
    });

    return { ok: true as const, archivedInsteadOfDeleted: false };
  }

  async findMediaByFilename(filename: string): Promise<{ id: string } | null> {
    const row = this.db
      .prepare(`SELECT id FROM product_media WHERE filename = ? LIMIT 1`)
      .get(filename) as { id: string } | undefined;
    return row || null;
  }

  async saveMediaFiles(files: SaveMediaFileInput[]): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const insertMedia = this.db.prepare(
        `INSERT INTO product_media (
          id, filename, mime_type, byte_size, sha256, data, uploaded_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const file of files) {
        insertMedia.run(
          file.id,
          file.filename,
          file.mimeType,
          file.byteSize,
          file.sha256,
          file.data,
          file.uploadedByUserId,
          file.createdAt
        );
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async getMediaWithPublicStatus(filename: string): Promise<{
    media: ProductMediaRow;
    isLinkedToPublished: boolean;
  } | null> {
    const media = this.db
      .prepare(`SELECT * FROM product_media WHERE filename = ? LIMIT 1`)
      .get(filename) as ProductMediaRow | undefined;
    if (!media) return null;

    const mediaUrl = `/api/media/${media.filename}`;
    const publishedRef = this.db
      .prepare(
        `SELECT pi.id FROM product_images pi
         JOIN products p ON p.id = pi.product_id
         WHERE (pi.media_id = ? OR pi.url = ?) AND p.status = 'published'
         LIMIT 1`
      )
      .get(media.id, mediaUrl) as { id: string } | undefined;

    if (publishedRef) {
      return { media, isLinkedToPublished: true };
    }

    const categoryRef = this.db
      .prepare(`SELECT id FROM categories WHERE image_url = ? LIMIT 1`)
      .get(mediaUrl) as { id: string } | undefined;

    if (categoryRef) {
      return { media, isLinkedToPublished: true };
    }

    const [settings, content] = await Promise.all([
      this.getSiteSettings(),
      this.getStorefrontContent(),
    ]);
    const referencedFiles = extractReferencedMediaFilenames(settings, content);

    return {
      media,
      isLinkedToPublished: referencedFiles.has(media.filename),
    };
  }

  async getProductsForCartValidation(productIds: string[]): Promise<Map<string, ProductWithParts>> {
    const map = new Map<string, ProductWithParts>();
    for (const pid of new Set(productIds)) {
      if (!pid) continue;
      const row = this.db
        .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
        .get(pid) as ProductRow | undefined;
      if (row) {
        map.set(pid, { product: row, ...this.fetchProductParts(row.id) });
      }
    }
    return map;
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      let subtotalPaise = 0;
      const resolvedLines: Array<{
        productId: string;
        variantId: string;
        productTitle: string;
        variantLabel: string;
        sku: string;
        unitPricePaise: number;
        quantity: number;
        lineTotalPaise: number;
        remainingStock: number;
      }> = [];

      // Track cumulative deduction per variant if duplicate lines reference same variant
      const pendingVariantStock = new Map<string, number>();

      for (const raw of input.items) {
        const product = this.db
          .prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`)
          .get(raw.productId) as ProductRow | undefined;
        if (!product || product.status !== 'published') {
          throw new StoreHttpError(
            409,
            'PRODUCT_UNAVAILABLE',
            `"${product?.title || 'One of the items'}" is no longer available in the storefront.`
          );
        }

        const variant = raw.variantId
          ? (this.db
              .prepare(`SELECT * FROM product_variants WHERE id = ? AND product_id = ? LIMIT 1`)
              .get(raw.variantId, product.id) as ProductVariantRow | undefined)
          : (this.db
              .prepare(`SELECT * FROM product_variants WHERE product_id = ? ORDER BY position ASC LIMIT 1`)
              .get(product.id) as ProductVariantRow | undefined);

        if (!variant) {
          throw new StoreHttpError(
            409,
            'VARIANT_UNAVAILABLE',
            `Selected option for "${product.title}" is no longer available.`
          );
        }

        if (raw.expectedPricePaise !== null && raw.expectedPricePaise !== variant.price_paise) {
          throw new StoreHttpError(
            409,
            'PRICE_CHANGED',
            `The price for "${product.title}" (${variant.size} · ${variant.color_name}) recently changed to ₹${(
              variant.price_paise / 100
            ).toLocaleString('en-IN')}. Please review your bag and confirm.`
          );
        }

        const availableStock = pendingVariantStock.get(variant.id) ?? variant.stock_qty;
        if (availableStock < raw.quantity) {
          throw new StoreHttpError(
            409,
            'INSUFFICIENT_STOCK',
            availableStock === 0
              ? `"${product.title}" (${variant.size} · ${variant.color_name}) is currently out of stock.`
              : `Only ${availableStock} unit(s) left for "${product.title}" (${variant.size} · ${variant.color_name}).`
          );
        }

        const nextRemaining = availableStock - raw.quantity;
        pendingVariantStock.set(variant.id, nextRemaining);

        const lineTotalPaise = variant.price_paise * raw.quantity;
        subtotalPaise += lineTotalPaise;

        resolvedLines.push({
          productId: product.id,
          variantId: variant.id,
          productTitle: product.title,
          variantLabel: `${variant.size} · ${variant.color_name}`,
          sku: variant.sku,
          unitPricePaise: variant.price_paise,
          quantity: raw.quantity,
          lineTotalPaise,
          remainingStock: nextRemaining,
        });
      }

      const now = Date.now();
      const orderId = crypto.randomUUID();
      const orderNumber = `SC-${new Date(now).getUTCFullYear()}-${crypto
        .randomBytes(3)
        .toString('hex')
        .toUpperCase()}`;

      this.db
        .prepare(
          `INSERT INTO orders (
            id, order_number, customer_user_id, customer_name, customer_email,
            customer_phone, shipping_address, status, subtotal_paise, total_paise, currency, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'INR', ?)`
        )
        .run(
          orderId,
          orderNumber,
          input.customerUserId,
          input.customerName,
          input.customerEmail,
          input.customerPhone,
          input.shippingAddress,
          subtotalPaise,
          subtotalPaise,
          now
        );

      const insertOrderItem = this.db.prepare(
        `INSERT INTO order_items (
          id, order_id, product_id, variant_id, product_title, variant_label,
          sku, unit_price_paise, quantity, line_total_paise
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updateVariantStock = this.db.prepare(
        `UPDATE product_variants SET stock_qty = ? WHERE id = ?`
      );

      const createdItems: OrderItemRow[] = [];
      const touchedProducts = new Set<string>();
      for (const line of resolvedLines) {
        const itemId = crypto.randomUUID();
        insertOrderItem.run(
          itemId,
          orderId,
          line.productId,
          line.variantId,
          line.productTitle,
          line.variantLabel,
          line.sku,
          line.unitPricePaise,
          line.quantity,
          line.lineTotalPaise
        );
        updateVariantStock.run(line.remainingStock, line.variantId);
        touchedProducts.add(line.productId);
        createdItems.push({
          id: itemId,
          order_id: orderId,
          product_id: line.productId,
          variant_id: line.variantId,
          product_title: line.productTitle,
          variant_label: line.variantLabel,
          sku: line.sku,
          unit_price_paise: line.unitPricePaise,
          quantity: line.quantity,
          line_total_paise: line.lineTotalPaise,
        });
      }

      for (const pid of touchedProducts) {
        const sumRow = this.db
          .prepare(`SELECT COALESCE(SUM(stock_qty), 0) AS total FROM product_variants WHERE product_id = ?`)
          .get(pid) as { total: number };
        this.db
          .prepare(`UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?`)
          .run(sumRow.total, now, pid);
      }

      this.db.exec('COMMIT;');

      return {
        order: {
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
        },
        items: createdItems,
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async listAdminOrders(page: number, pageSize: number) {
    const allOrders = this.db
      .prepare(`SELECT * FROM orders ORDER BY created_at DESC`)
      .all() as unknown as OrderRow[];

    const total = allOrders.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const slice = allOrders.slice((safePage - 1) * pageSize, safePage * pageSize);

    const fetchItems = this.db.prepare(`SELECT * FROM order_items WHERE order_id = ?`);

    const items: OrderWithItems[] = slice.map((order) => ({
      order,
      items: fetchItems.all(order.id) as unknown as OrderItemRow[],
    }));

    return { items, total, page: safePage, pageSize, totalPages };
  }

  async updateOrderStatus(orderId: string, nextStatus: string): Promise<boolean> {
    const res = this.db
      .prepare(`UPDATE orders SET status = ? WHERE id = ?`)
      .run(nextStatus, orderId);
    return res.changes > 0;
  }

  async listAuditLogs(params: { productId?: string; page: number; pageSize: number }) {
    const logs = (params.productId
      ? this.db
          .prepare(`SELECT * FROM product_audit_logs WHERE product_id = ? ORDER BY created_at DESC`)
          .all(params.productId)
      : this.db
          .prepare(`SELECT * FROM product_audit_logs ORDER BY created_at DESC`)
          .all()) as unknown as ProductAuditLogRow[];

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

  async listCategories(): Promise<CategoryRow[]> {
    return this.db
      .prepare(`SELECT * FROM categories ORDER BY position ASC, created_at ASC`)
      .all() as unknown as CategoryRow[];
  }

  async getCategoryById(id: string): Promise<CategoryRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM categories WHERE id = ? LIMIT 1`)
      .get(id) as CategoryRow | undefined;
    return row || null;
  }

  private async makeUniqueCategorySlug(name: string, excludeId?: string): Promise<string> {
    const base = slugifyProductTitle(name);
    let candidate = base;
    let counter = 2;
    while (true) {
      const conflict = excludeId
        ? (this.db
            .prepare(`SELECT id FROM categories WHERE slug = ? AND id != ? LIMIT 1`)
            .get(candidate, excludeId) as { id: string } | undefined)
        : (this.db
            .prepare(`SELECT id FROM categories WHERE slug = ? LIMIT 1`)
            .get(candidate) as { id: string } | undefined);
      if (!conflict) return candidate;
      candidate = `${base}-${counter}`;
      counter += 1;
    }
  }

  async createCategory(input: {
    name: string;
    subtitle: string;
    imageUrl: string;
    altText: string;
    position?: number;
  }): Promise<CategoryRow> {
    const cleanName = input.name.trim();
    const dup = this.db
      .prepare(`SELECT id FROM categories WHERE LOWER(name) = LOWER(?) LIMIT 1`)
      .get(cleanName) as { id: string } | undefined;
    if (dup) {
      throw new StoreHttpError(
        409,
        'CATEGORY_EXISTS',
        `A category named "${cleanName}" already exists.`
      );
    }

    const maxPosRow = this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) AS maxPos FROM categories`)
      .get() as { maxPos: number };
    const now = Date.now();
    const id = await this.makeUniqueCategorySlug(cleanName);
    const position =
      typeof input.position === 'number' && Number.isFinite(input.position)
        ? Math.max(0, Math.round(input.position))
        : maxPosRow.maxPos + 1;

    this.db
      .prepare(
        `INSERT INTO categories (
          id, name, slug, subtitle, image_url, alt_text, position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        cleanName,
        id,
        input.subtitle.trim(),
        input.imageUrl.trim(),
        input.altText.trim(),
        position,
        now,
        now
      );

    return (await this.getCategoryById(id))!;
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
    const existing = await this.getCategoryById(id);
    if (!existing) return null;

    const cleanName = input.name.trim();
    const dup = this.db
      .prepare(`SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1`)
      .get(cleanName, id) as { id: string } | undefined;
    if (dup) {
      throw new StoreHttpError(
        409,
        'CATEGORY_EXISTS',
        `Another category named "${cleanName}" already exists.`
      );
    }

    const now = Date.now();
    const nextPosition =
      typeof input.position === 'number' && Number.isFinite(input.position)
        ? Math.max(0, Math.round(input.position))
        : existing.position;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE categories SET
            name = ?, subtitle = ?, image_url = ?, alt_text = ?, position = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          cleanName,
          input.subtitle.trim(),
          input.imageUrl.trim(),
          input.altText.trim(),
          nextPosition,
          now,
          id
        );

      if (existing.name !== cleanName) {
        this.db
          .prepare(`UPDATE products SET category = ?, updated_at = ? WHERE category = ?`)
          .run(cleanName, now, existing.name);
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    if (existing.name !== cleanName) {
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

    return (await this.getCategoryById(id))!;
  }

  async deleteCategory(id: string) {
    const existing = await this.getCategoryById(id);
    if (!existing) {
      return { ok: false as const, code: 'NOT_FOUND' as const };
    }

    const prodRef = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM products WHERE category = ?`)
      .get(existing.name) as { cnt: number };
    if (prodRef.cnt > 0) {
      return {
        ok: false as const,
        code: 'CATEGORY_IN_USE' as const,
        productCount: prodRef.cnt,
      };
    }

    this.db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
    return { ok: true as const };
  }

  async getSiteSettings(): Promise<SiteSettingsData> {
    const row = this.db
      .prepare(`SELECT data_json FROM site_documents WHERE key = 'site_settings' LIMIT 1`)
      .get() as { data_json: string } | undefined;
    if (!row) {
      return mergeSiteSettings(null);
    }
    try {
      return mergeSiteSettings(JSON.parse(row.data_json) as Partial<SiteSettingsData>);
    } catch {
      return mergeSiteSettings(null);
    }
  }

  async saveSiteSettings(settings: SiteSettingsData): Promise<SiteSettingsData> {
    const normalized = mergeSiteSettings(settings);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO site_documents (key, data_json, updated_at)
         VALUES ('site_settings', ?, ?)
         ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(normalized), now);
    return normalized;
  }

  async getStorefrontContent(): Promise<StorefrontContentData> {
    const row = this.db
      .prepare(`SELECT data_json FROM site_documents WHERE key = 'site_content' LIMIT 1`)
      .get() as { data_json: string } | undefined;
    if (!row) {
      return mergeStorefrontContent(null);
    }
    try {
      return mergeStorefrontContent(JSON.parse(row.data_json) as Partial<StorefrontContentData>);
    } catch {
      return mergeStorefrontContent(null);
    }
  }

  async saveStorefrontContent(content: StorefrontContentData): Promise<StorefrontContentData> {
    const normalized = mergeStorefrontContent(content);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO site_documents (key, data_json, updated_at)
         VALUES ('site_content', ?, ?)
         ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(normalized), now);
    return normalized;
  }

  async createContactMessage(input: {
    senderName: string;
    senderEmail: string;
    senderPhone: string;
    subject: string;
    message: string;
  }): Promise<ContactMessageRow> {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO contact_messages (
          id, sender_name, sender_email, sender_phone, subject, message,
          status, admin_note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'unread', '', ?, ?)`
      )
      .run(
        id,
        input.senderName.trim(),
        input.senderEmail.trim().toLowerCase(),
        input.senderPhone.trim(),
        input.subject.trim(),
        input.message.trim(),
        now,
        now
      );

    return this.db
      .prepare(`SELECT * FROM contact_messages WHERE id = ? LIMIT 1`)
      .get(id) as unknown as ContactMessageRow;
  }

  async listAdminMessages(params: {
    status?: string;
    q?: string;
    page: number;
    pageSize: number;
  }) {
    const all = this.db
      .prepare(`SELECT * FROM contact_messages ORDER BY created_at DESC`)
      .all() as unknown as ContactMessageRow[];
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
    const existing = this.db
      .prepare(`SELECT * FROM contact_messages WHERE id = ? LIMIT 1`)
      .get(id) as ContactMessageRow | undefined;
    if (!existing) return null;

    const now = Date.now();
    const nextStatus = patch.status ?? existing.status;
    const nextNote =
      typeof patch.adminNote === 'string' ? patch.adminNote.trim() : existing.admin_note;

    this.db
      .prepare(
        `UPDATE contact_messages SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextStatus, nextNote, now, id);

    return this.db
      .prepare(`SELECT * FROM contact_messages WHERE id = ? LIMIT 1`)
      .get(id) as unknown as ContactMessageRow;
  }

  async deleteContactMessage(id: string): Promise<boolean> {
    const res = this.db.prepare(`DELETE FROM contact_messages WHERE id = ?`).run(id);
    return res.changes > 0;
  }
}
