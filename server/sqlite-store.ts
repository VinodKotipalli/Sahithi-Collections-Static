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
  formatVariantDisplayLabel,
  isVariantColorActiveInMetadata,
  resolveVariantSnapshotImageUrl,
  validateColorVariantMatrix,
} from '../src/utils/colorVariants.ts';
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
  isOrderAwaitingDispatch,
  normalizeOrderRequestsAndStatus,
  normalizePaymentAndRefundStatus,
  normalizeRawOrderStatusValue,
  parseNotificationPrefs,
  parseOrderHistory,
  PRE_CUTOFF_DELIVERY_EDIT_STATES,
  PRE_SHIPPING_CANCEL_STATES,
  RETURN_ELIGIBLE_STATES,
  validateNonSensitivePaymentMethodInput,
  validateOrderStatusTransition,
} from './order-utils.ts';

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

  async updateCustomerProfile(
    userId: string,
    input: {
      fullName?: string;
      phone?: string | null;
      notificationPrefs?: NotificationPreferencesData;
    },
    now: number
  ): Promise<UserRow> {
    const existing = await this.getUserById(userId);
    if (!existing) {
      throw new StoreHttpError(404, 'USER_NOT_FOUND', 'Customer account was not found.');
    }
    const nextName =
      typeof input.fullName === 'string' && input.fullName.trim().length >= 2
        ? input.fullName.trim().slice(0, 100)
        : existing.full_name;
    const nextPhone =
      input.phone === null
        ? null
        : typeof input.phone === 'string'
          ? input.phone.trim() || null
          : existing.phone_e164;
    const nextPrefsJson = input.notificationPrefs
      ? JSON.stringify(parseNotificationPrefs(input.notificationPrefs))
      : existing.notification_prefs_json ?? null;

    this.db
      .prepare(
        `UPDATE users SET full_name = ?, phone_e164 = ?, notification_prefs_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextName, nextPhone, nextPrefsJson, now, userId);
    return (await this.getUserById(userId))!;
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

    const orderCountRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM orders WHERE customer_user_id = ?`)
      .get(userId) as { cnt: number };
    const preservedOrdersCount = Number(orderCountRow?.cnt || 0);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // Detach orders so historical ledger & audit snapshot stay intact while user record is removed
      this.db
        .prepare(`UPDATE orders SET customer_user_id = NULL, updated_at = ? WHERE customer_user_id = ?`)
        .run(now, userId);
      this.db.prepare(`UPDATE pending_checkouts SET customer_user_id = NULL WHERE customer_user_id = ?`).run(userId);
      this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
      this.db.prepare(`DELETE FROM email_tokens WHERE user_id = ?`).run(userId);
      this.db.prepare(`DELETE FROM customer_addresses WHERE user_id = ?`).run(userId);
      this.db.prepare(`DELETE FROM customer_payment_methods WHERE user_id = ?`).run(userId);
      this.db.prepare(`DELETE FROM customer_wishlists WHERE user_id = ?`).run(userId);
      this.db.prepare(`DELETE FROM customer_notifications WHERE user_id = ?`).run(userId);
      const res = this.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
      this.db.exec('COMMIT;');
      return { deleted: res.changes > 0, preservedOrdersCount };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
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
          (r.included_pieces || '').toLowerCase().includes(q) ||
          (r.care_note || '').toLowerCase().includes(q) ||
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

    const allOrderRows = this.db
      .prepare(`SELECT * FROM orders ORDER BY created_at DESC`)
      .all() as unknown as OrderRow[];

    let pendingOrders = 0;
    let cancelledOrders = 0;
    let totalRevenuePaise = 0;
    let openReturnRequests = 0;

    for (const row of allOrderRows) {
      const history = parseOrderHistory(row.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: row.status,
        rawFulfillmentStatus: row.fulfillment_status,
        rawCancelRequest: row.cancel_request_json,
        rawReturnRequest: row.return_request_json,
        rawPaymentStatus: row.payment_status,
        rawRefundStatus: row.refund_status,
        rawCancelledAt: row.cancelled_at,
        rawCancelledBy: row.cancelled_by,
        rawCancelReason: row.cancel_reason,
        razorpayPaymentId: row.razorpay_payment_id,
        history,
        paymentMethod: row.payment_method,
      });

      if (norm.status === 'cancelled') {
        cancelledOrders += 1;
      } else if (isOrderAwaitingDispatch(norm.status)) {
        pendingOrders += 1;
      }

      if (
        norm.status !== 'cancelled' &&
        norm.refundStatus !== 'refunded' &&
        (norm.paymentStatus === 'paid' ||
          (row.payment_method !== 'cod' && ['paid', 'fulfilled'].includes(row.status)))
      ) {
        totalRevenuePaise += Number(row.total_paise || 0);
      }

      if (
        norm.returnRequest?.status === 'pending' ||
        (norm.status !== 'cancelled' && norm.cancelRequest?.status === 'pending')
      ) {
        openReturnRequests += 1;
      }
    }

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

    const totalCustomers = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM users WHERE (email_verified = 1 OR phone_verified = 1) AND deleted_at IS NULL`
        )
        .get() as { cnt: number }
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
        totalOrders: allOrderRows.length,
        pendingOrders,
        cancelledOrders,
        totalRevenuePaise,
        unreadMessages: Number(msgAgg.unreadMessages || 0),
        totalMessages: Number(msgAgg.totalMessages || 0),
        totalAuditEvents: auditCount,
        totalCustomers,
        openReturnRequests,
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
    images: Array<{
      mediaId: string | null;
      colorId?: string | null;
      url: string;
      alt: string;
      isCover: boolean;
    }>;
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
            id, slug, title, description, fabric_note, included_pieces, care_note, category, sku,
            price_paise, compare_at_paise, stock_qty, low_stock_threshold,
            featured, status, colors_json, sizes_json,
            import_key, source_image_filename, pending_fields_json, catalog_batch,
            version, published_at, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          p.id,
          p.slug,
          p.title,
          p.description,
          p.fabric_note,
          p.included_pieces ?? '',
          p.care_note ?? '',
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
          p.import_key ?? null,
          p.source_image_filename ?? null,
          p.pending_fields_json ?? null,
          p.catalog_batch ?? null,
          p.version,
          p.published_at,
          p.archived_at,
          p.created_at,
          p.updated_at
        );

      const insertVariant = this.db.prepare(
        `INSERT INTO product_variants (
          id, product_id, sku, size, color_id, color_name, color_hex,
          price_paise, price_override_paise, compare_at_paise, stock_qty, active, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const v of input.variants) {
        insertVariant.run(
          v.id,
          p.id,
          v.sku,
          v.size,
          v.color_id ?? null,
          v.color_name,
          v.color_hex,
          v.price_paise,
          v.price_override_paise ?? null,
          v.compare_at_paise,
          v.stock_qty,
          v.active === undefined || v.active === null ? 1 : v.active ? 1 : 0,
          v.position
        );
      }

      const insertImg = this.db.prepare(
        `INSERT INTO product_images (
          id, product_id, media_id, color_id, url, alt_text, is_cover, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      input.images.forEach((img, idx) => {
        insertImg.run(
          crypto.randomUUID(),
          p.id,
          img.mediaId,
          img.colorId ?? null,
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
    images: Array<{
      mediaId: string | null;
      colorId?: string | null;
      url: string;
      alt: string;
      isCover: boolean;
    }>;
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
      const nextIncludedPieces =
        input.includedPieces !== undefined ? input.includedPieces : (existing.included_pieces ?? '');
      const nextCareNote =
        input.careNote !== undefined ? input.careNote : (existing.care_note ?? '');
      const nextImportKey =
        input.importKey !== undefined ? input.importKey : (existing.import_key ?? null);
      const nextSourceFilename =
        input.sourceImageFilename !== undefined
          ? input.sourceImageFilename
          : (existing.source_image_filename ?? null);
      const nextPendingFieldsJson =
        input.pendingFieldsJson !== undefined
          ? input.pendingFieldsJson
          : (existing.pending_fields_json ?? null);
      const nextCatalogBatch =
        input.catalogBatch !== undefined ? input.catalogBatch : (existing.catalog_batch ?? null);
      const updateRes = this.db
        .prepare(
          `UPDATE products SET
            slug = ?, title = ?, description = ?, fabric_note = ?,
            included_pieces = ?, care_note = ?,
            category = ?, sku = ?,
            price_paise = ?, compare_at_paise = ?, stock_qty = ?, low_stock_threshold = ?,
            featured = ?, status = ?, colors_json = ?, sizes_json = ?,
            import_key = ?, source_image_filename = ?, pending_fields_json = ?, catalog_batch = ?,
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
          nextIncludedPieces,
          nextCareNote,
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
          nextImportKey,
          nextSourceFilename,
          nextPendingFieldsJson,
          nextCatalogBatch,
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
          id, product_id, sku, size, color_id, color_name, color_hex,
          price_paise, price_override_paise, compare_at_paise, stock_qty, active, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sku = excluded.sku,
          size = excluded.size,
          color_id = excluded.color_id,
          color_name = excluded.color_name,
          color_hex = excluded.color_hex,
          price_paise = excluded.price_paise,
          price_override_paise = excluded.price_override_paise,
          compare_at_paise = excluded.compare_at_paise,
          stock_qty = excluded.stock_qty,
          active = excluded.active,
          position = excluded.position`
      );
      for (const v of input.variants) {
        upsertVariant.run(
          v.id,
          existing.id,
          v.sku,
          v.size,
          v.color_id ?? null,
          v.color_name,
          v.color_hex,
          v.price_paise,
          v.price_override_paise ?? null,
          v.compare_at_paise,
          v.stock_qty,
          v.active === undefined || v.active === null ? 1 : v.active ? 1 : 0,
          v.position
        );
      }

      this.db.prepare(`DELETE FROM product_images WHERE product_id = ?`).run(existing.id);
      const insertImg = this.db.prepare(
        `INSERT INTO product_images (
          id, product_id, media_id, color_id, url, alt_text, is_cover, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      input.images.forEach((img, idx) => {
        insertImg.run(
          crypto.randomUUID(),
          existing.id,
          img.mediaId,
          img.colorId ?? null,
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
            id, slug, title, description, fabric_note, included_pieces, care_note, category, sku,
            price_paise, compare_at_paise, stock_qty, low_stock_threshold,
            featured, status, colors_json, sizes_json, version,
            published_at, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?, 1, NULL, NULL, ?, ?)`
        )
        .run(
          newId,
          copySlug,
          copyTitle,
          source.description,
          source.fabric_note,
          source.included_pieces ?? '',
          source.care_note ?? '',
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
          id, product_id, sku, size, color_id, color_name, color_hex,
          price_paise, price_override_paise, compare_at_paise, stock_qty, active, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      variants.forEach((v, idx) => {
        insertVar.run(
          crypto.randomUUID(),
          newId,
          `${copySku}-${idx + 1}`,
          v.size,
          v.color_id ?? null,
          v.color_name,
          v.color_hex,
          v.price_paise,
          v.price_override_paise ?? null,
          v.compare_at_paise,
          v.stock_qty,
          v.active === undefined || v.active === null ? 1 : v.active ? 1 : 0,
          v.position
        );
      });

      const insertImg = this.db.prepare(
        `INSERT INTO product_images (
          id, product_id, media_id, color_id, url, alt_text, is_cover, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const img of images) {
        insertImg.run(
          crypto.randomUUID(),
          newId,
          img.media_id,
          img.color_id ?? null,
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
      const { variants, images } = this.fetchProductParts(existing.id);
      if (images.length === 0) {
        return { ok: false as const, code: 'NO_IMAGES' as const };
      }
      let parsedColors: Array<{
        id?: string;
        name: string;
        hex?: string;
        thumbnailUrl?: string | null;
        position?: number;
        active?: boolean;
      }> = [];
      try {
        const raw = JSON.parse(existing.colors_json || '[]');
        if (Array.isArray(raw)) parsedColors = raw;
      } catch {
        parsedColors = [];
      }
      const matrixCheck = validateColorVariantMatrix({
        status: 'published',
        colors: parsedColors,
        images: images.map((img) => ({
          id: img.id,
          url: img.url,
          alt: img.alt_text,
          isCover: Boolean(img.is_cover),
          colorId: img.color_id ?? null,
          position: img.position,
        })),
        variants: variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          size: v.size,
          colorId: v.color_id ?? null,
          colorName: v.color_name,
          colorHex: v.color_hex,
          pricePaise: v.price_paise,
          priceOverridePaise: v.price_override_paise ?? null,
          compareAtPaise: v.compare_at_paise,
          stockQty: v.stock_qty,
          active: v.active === undefined || v.active === null ? true : Boolean(v.active),
        })),
      });
      if (!matrixCheck.ok) {
        return {
          ok: false as const,
          code: 'INCOMPLETE_COLOR_VARIANTS' as const,
          message: matrixCheck.error,
        };
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

  async savePendingCheckout(record: PendingCheckoutRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pending_checkouts (
          id, customer_user_id, amount_paise, subtotal_paise, discount_paise, gift_card_paise,
          coupon_code, gift_card_code, currency, receipt, items_json, customer_json, status,
          razorpay_payment_id, confirmed_order_id, confirmed_order_json, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          customer_user_id = COALESCE(excluded.customer_user_id, pending_checkouts.customer_user_id),
          amount_paise = excluded.amount_paise,
          subtotal_paise = excluded.subtotal_paise,
          discount_paise = excluded.discount_paise,
          gift_card_paise = excluded.gift_card_paise,
          coupon_code = excluded.coupon_code,
          gift_card_code = excluded.gift_card_code,
          items_json = excluded.items_json,
          customer_json = COALESCE(excluded.customer_json, pending_checkouts.customer_json),
          status = excluded.status,
          razorpay_payment_id = COALESCE(excluded.razorpay_payment_id, pending_checkouts.razorpay_payment_id),
          confirmed_order_id = COALESCE(excluded.confirmed_order_id, pending_checkouts.confirmed_order_id),
          confirmed_order_json = COALESCE(excluded.confirmed_order_json, pending_checkouts.confirmed_order_json),
          updated_at = excluded.updated_at`
      )
      .run(
        record.id,
        record.customer_user_id,
        record.amount_paise,
        record.subtotal_paise,
        record.discount_paise,
        record.gift_card_paise,
        record.coupon_code,
        record.gift_card_code,
        record.currency,
        record.receipt,
        record.items_json,
        record.customer_json,
        record.status,
        record.razorpay_payment_id,
        record.confirmed_order_id,
        record.confirmed_order_json,
        record.created_at,
        record.updated_at,
        record.expires_at
      );
  }

  async getPendingCheckout(razorpayOrderId: string): Promise<PendingCheckoutRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM pending_checkouts WHERE id = ? LIMIT 1`)
      .get(razorpayOrderId) as PendingCheckoutRow | undefined;
    return row || null;
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // Idempotency guard by explicit order ID or razorpay_order_id
      if (input.id) {
        const existingById = this.db
          .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
          .get(input.id) as OrderRow | undefined;
        if (existingById) {
          const items = this.db
            .prepare(`SELECT * FROM order_items WHERE order_id = ?`)
            .all(existingById.id) as unknown as OrderItemRow[];
          this.db.exec('COMMIT;');
          return { order: existingById, items };
        }
      }
      if (input.razorpayOrderId) {
        const existingByRzp = this.db
          .prepare(`SELECT * FROM orders WHERE razorpay_order_id = ? LIMIT 1`)
          .get(input.razorpayOrderId) as OrderRow | undefined;
        if (existingByRzp) {
          const items = this.db
            .prepare(`SELECT * FROM order_items WHERE order_id = ?`)
            .all(existingByRzp.id) as unknown as OrderItemRow[];
          this.db.exec('COMMIT;');
          return { order: existingByRzp, items };
        }
      }
      const cleanIdempotencyKey =
        typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
          ? input.idempotencyKey.trim().slice(0, 128)
          : null;
      if (cleanIdempotencyKey) {
        const existingByKey = this.db
          .prepare(`SELECT * FROM orders WHERE idempotency_key = ? LIMIT 1`)
          .get(cleanIdempotencyKey) as OrderRow | undefined;
        if (existingByKey) {
          const items = this.db
            .prepare(`SELECT * FROM order_items WHERE order_id = ?`)
            .all(existingByKey.id) as unknown as OrderItemRow[];
          this.db.exec('COMMIT;');
          return { order: existingByKey, items };
        }
      }

      const fetchProduct = this.db.prepare(`SELECT * FROM products WHERE id = ? LIMIT 1`);
      const fetchVariantById = this.db.prepare(
        `SELECT * FROM product_variants WHERE id = ? AND product_id = ? LIMIT 1`
      );
      const fetchFirstVariant = this.db.prepare(
        `SELECT * FROM product_variants WHERE product_id = ? AND COALESCE(active, 1) = 1 ORDER BY position ASC LIMIT 1`
      );
      const fetchProductImages = this.db.prepare(
        `SELECT * FROM product_images WHERE product_id = ? ORDER BY is_cover DESC, position ASC, created_at ASC`
      );

      let subtotalPaise = 0;
      const pendingVariantStock = new Map<string, number>();
      const productImagesCache = new Map<string, ProductImageRow[]>();
      const resolvedLines: Array<{
        productId: string;
        variantId: string;
        productTitle: string;
        variantLabel: string;
        colorName: string;
        size: string;
        imageUrl: string;
        sku: string;
        unitPricePaise: number;
        quantity: number;
        lineTotalPaise: number;
        remainingStock: number;
      }> = [];

      for (const raw of input.items) {
        const product = fetchProduct.get(raw.productId) as ProductRow | undefined;
        if (!product || product.status !== 'published') {
          throw new StoreHttpError(
            409,
            'PRODUCT_UNAVAILABLE',
            `"${product?.title || 'One of the items'}" is no longer available in the storefront.`
          );
        }

        const variant = raw.variantId
          ? (fetchVariantById.get(raw.variantId, product.id) as ProductVariantRow | undefined)
          : (fetchFirstVariant.get(product.id) as ProductVariantRow | undefined);

        if (!variant) {
          throw new StoreHttpError(
            409,
            'VARIANT_UNAVAILABLE',
            `Selected option for "${product.title}" is no longer available.`
          );
        }

        const variantActive = variant.active === undefined || variant.active === null ? true : Boolean(variant.active);
        const colorActive = isVariantColorActiveInMetadata(product.colors_json, variant);
        if (!variantActive || !colorActive) {
          throw new StoreHttpError(
            409,
            'VARIANT_UNAVAILABLE',
            `The selected colour/size (${variant.color_name} · ${variant.size}) for "${product.title}" is no longer available.`
          );
        }

        if (raw.expectedPricePaise !== null && raw.expectedPricePaise !== variant.price_paise) {
          throw new StoreHttpError(
            409,
            'PRICE_CHANGED',
            `The price for "${product.title}" (${variant.color_name} · ${variant.size}) recently changed to ₹${(
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
              ? `"${product.title}" (${variant.color_name} · ${variant.size}) is currently out of stock.`
              : `Only ${availableStock} unit(s) left for "${product.title}" (${variant.color_name} · ${variant.size}).`
          );
        }

        const nextRemaining = availableStock - raw.quantity;
        pendingVariantStock.set(variant.id, nextRemaining);

        const lineTotalPaise = variant.price_paise * raw.quantity;
        subtotalPaise += lineTotalPaise;

        let pImages = productImagesCache.get(product.id);
        if (!pImages) {
          pImages = fetchProductImages.all(product.id) as unknown as ProductImageRow[];
          productImagesCache.set(product.id, pImages);
        }
        const imageUrl = resolveVariantSnapshotImageUrl(product.colors_json, pImages, variant);

        resolvedLines.push({
          productId: product.id,
          variantId: variant.id,
          productTitle: product.title,
          variantLabel: formatVariantDisplayLabel(variant.color_name, variant.size),
          colorName: variant.color_name,
          size: variant.size,
          imageUrl,
          sku: variant.sku,
          unitPricePaise: variant.price_paise,
          quantity: raw.quantity,
          lineTotalPaise,
          remainingStock: nextRemaining,
        });
      }

      const now = Date.now();
      const orderId = input.id || crypto.randomUUID();
      const orderNumber =
        input.orderNumber ||
        `SC-${new Date(now).getUTCFullYear()}-${crypto
          .randomBytes(3)
          .toString('hex')
          .toUpperCase()}`;

      const discountPaise = Math.max(0, Math.min(subtotalPaise, Math.round(input.discountPaise || 0)));
      const giftCardPaise = Math.max(
        0,
        Math.min(subtotalPaise - discountPaise, Math.round(input.giftCardPaise || 0))
      );
      const totalPaise = Math.max(0, subtotalPaise - discountPaise - giftCardPaise);

      if (input.couponCode) {
        this.db
          .prepare(
            `UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE UPPER(code) = UPPER(?)`
          )
          .run(now, input.couponCode.trim());
      }
      if (input.giftCardCode && giftCardPaise > 0) {
        this.db
          .prepare(
            `UPDATE gift_cards SET balance_paise = MAX(0, balance_paise - ?), last_used_at = ?, updated_at = ? WHERE UPPER(code) = UPPER(?)`
          )
          .run(giftCardPaise, now, now, input.giftCardCode.trim());
      }

      const paymentMethod = input.paymentMethod || 'cod';
      const status = input.status || (paymentMethod === 'cod' ? 'placed' : 'pending');
      const paymentStatus = input.paymentStatus || (paymentMethod === 'razorpay' ? 'paid' : 'unpaid');
      const fulfillmentStatus =
        input.fulfillmentStatus || (status === 'confirmed' ? 'confirmed' : 'placed');
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

      this.db
        .prepare(
          `INSERT INTO orders (
            id, order_number, customer_user_id, customer_name, customer_email,
            customer_phone, shipping_address, status, payment_status, fulfillment_status,
            payment_method, razorpay_order_id, razorpay_payment_id, coupon_code, gift_card_code,
            discount_paise, gift_card_paise, status_history_json, return_request_json,
            idempotency_key, payment_collected_at, payment_collected_by,
            subtotal_paise, total_paise, currency, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'INR', ?, ?)`
        )
        .run(
          orderId,
          orderNumber,
          input.customerUserId,
          input.customerName,
          input.customerEmail,
          input.customerPhone,
          input.shippingAddress,
          status,
          paymentStatus,
          fulfillmentStatus,
          paymentMethod,
          input.razorpayOrderId || null,
          input.razorpayPaymentId || null,
          input.couponCode || null,
          input.giftCardCode || null,
          discountPaise,
          giftCardPaise,
          statusHistoryJson,
          cleanIdempotencyKey,
          paymentCollectedAt,
          paymentCollectedBy,
          subtotalPaise,
          totalPaise,
          now,
          now
        );

      const insertOrderItem = this.db.prepare(
        `INSERT INTO order_items (
          id, order_id, product_id, variant_id, product_title, variant_label,
          color_name, size, image_url, sku, unit_price_paise, quantity, line_total_paise
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          line.colorName,
          line.size,
          line.imageUrl,
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
          color_name: line.colorName,
          size: line.size,
          image_url: line.imageUrl,
          sku: line.sku,
          unit_price_paise: line.unitPricePaise,
          quantity: line.quantity,
          line_total_paise: line.lineTotalPaise,
        });
      }

      for (const pid of touchedProducts) {
        const sumRow = this.db
          .prepare(`SELECT COALESCE(SUM(stock_qty), 0) AS total FROM product_variants WHERE product_id = ? AND COALESCE(active, 1) = 1`)
          .get(pid) as { total: number };
        this.db
          .prepare(`UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?`)
          .run(sumRow.total, now, pid);
      }

      if (input.customerUserId) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO customer_notifications (
              id, user_id, type, title, message, order_id, order_number, is_read, read_at, created_at
            ) VALUES (?, ?, 'order_placed', ?, ?, ?, ?, 0, NULL, ?)`
          )
          .run(
            `notif_placed_${orderId}`,
            input.customerUserId,
            `Order ${orderNumber} placed`,
            paymentMethod === 'razorpay'
              ? `Payment verified for order ${orderNumber} (₹${(totalPaise / 100).toLocaleString('en-IN')}).`
              : `Your Cash on Delivery order ${orderNumber} is placed. ₹${(totalPaise / 100).toLocaleString('en-IN')} is due on delivery.`,
            orderId,
            orderNumber,
            now
          );
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
          status,
          payment_status: paymentStatus,
          fulfillment_status: fulfillmentStatus,
          payment_method: paymentMethod,
          razorpay_order_id: input.razorpayOrderId || null,
          razorpay_payment_id: input.razorpayPaymentId || null,
          coupon_code: input.couponCode || null,
          gift_card_code: input.giftCardCode || null,
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
        },
        items: createdItems,
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async getOrderById(orderId: string): Promise<OrderWithItems | null> {
    const order = this.db
      .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
      .get(orderId) as OrderRow | undefined;
    if (!order) return null;
    const items = this.db
      .prepare(`SELECT * FROM order_items WHERE order_id = ?`)
      .all(order.id) as unknown as OrderItemRow[];
    return { order, items };
  }

  async listCustomerOrders(userId: string): Promise<OrderWithItems[]> {
    const orders = this.db
      .prepare(
        `SELECT * FROM orders WHERE customer_user_id = ? AND COALESCE(hidden_by_customer, 0) = 0 ORDER BY created_at DESC`
      )
      .all(userId) as unknown as OrderRow[];
    const fetchItems = this.db.prepare(`SELECT * FROM order_items WHERE order_id = ?`);
    return orders.map((order) => ({
      order,
      items: fetchItems.all(order.id) as unknown as OrderItemRow[],
    }));
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
    const updated = await this.updateOrderStatusWithHistory(orderId, nextStatus, {
      actor: 'owner',
      notifyCustomer: true,
    });
    return Boolean(updated);
  }

  private restoreOrderStockSync(orderId: string, now: number): void {
    const orderItems = this.db
      .prepare(`SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?`)
      .all(orderId) as Array<{ product_id: string; variant_id: string | null; quantity: number }>;
    const touchedProducts = new Set<string>();
    for (const item of orderItems) {
      const qty = Math.max(0, Number(item.quantity || 0));
      if (qty <= 0) continue;
      if (item.variant_id) {
        this.db
          .prepare(`UPDATE product_variants SET stock_qty = stock_qty + ? WHERE id = ?`)
          .run(qty, item.variant_id);
      }
      touchedProducts.add(item.product_id);
    }
    for (const pid of touchedProducts) {
      const sumRow = this.db
        .prepare(
          `SELECT COALESCE(SUM(stock_qty), 0) AS total FROM product_variants WHERE product_id = ? AND COALESCE(active, 1) = 1`
        )
        .get(pid) as { total: number } | undefined;
      if (sumRow) {
        this.db
          .prepare(`UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?`)
          .run(sumRow.total, now, pid);
      }
    }
  }

  async updateOrderStatusWithHistory(
    orderId: string,
    nextStatus: string,
    options?: {
      actor?: 'owner' | 'system' | 'customer';
      note?: string;
      notifyCustomer?: boolean;
      expectedUpdatedAt?: number | null;
      paymentStatus?: string;
      refundStatus?: string;
    }
  ): Promise<OrderWithItems | null> {
    this.db.exec('BEGIN IMMEDIATE;');
    let existing: OrderRow | undefined;
    let normalizedNext = normalizeRawOrderStatusValue(nextStatus);
    let changed = false;
    let now = Date.now();
    try {
      existing = this.db
        .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
        .get(orderId) as OrderRow | undefined;
      if (!existing) {
        this.db.exec('ROLLBACK;');
        return null;
      }

      if (
        typeof options?.expectedUpdatedAt === 'number' &&
        Number.isFinite(options.expectedUpdatedAt) &&
        Number(existing.updated_at || existing.created_at || 0) !== Number(options.expectedUpdatedAt)
      ) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          409,
          'CONCURRENCY_CONFLICT',
          'This order was updated elsewhere. Refresh to view the latest status before saving.'
        );
      }

      const history = parseOrderHistory(existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: existing.status,
        rawFulfillmentStatus: existing.fulfillment_status,
        rawCancelRequest: existing.cancel_request_json,
        rawReturnRequest: existing.return_request_json,
        rawPaymentStatus: existing.payment_status,
        rawRefundStatus: existing.refund_status,
        rawCancelledAt: existing.cancelled_at,
        rawCancelledBy: existing.cancelled_by,
        rawCancelReason: existing.cancel_reason,
        razorpayPaymentId: existing.razorpay_payment_id,
        history,
        paymentMethod: existing.payment_method,
      });

      const transition = validateOrderStatusTransition(norm.status, nextStatus);
      if (!transition.ok) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          transition.code === 'VALIDATION_ERROR' ? 400 : 409,
          transition.code,
          transition.error
        );
      }
      normalizedNext = normalizeRawOrderStatusValue(nextStatus);

      now = Date.now();
      const payNorm = normalizePaymentAndRefundStatus({
        rawPaymentStatus: options?.paymentStatus ?? existing.payment_status,
        rawRefundStatus: options?.refundStatus ?? existing.refund_status,
        paymentMethod: existing.payment_method,
        orderStatus: normalizedNext,
        razorpayPaymentId: existing.razorpay_payment_id,
      });

      const statusChanged =
        norm.status !== normalizedNext ||
        existing.status !== normalizedNext ||
        existing.fulfillment_status !== normalizedNext;
      const refundChanged =
        Boolean(options?.refundStatus) && payNorm.refundStatus !== norm.refundStatus;
      changed = statusChanged;

      let cancelledAt = existing.cancelled_at ?? norm.cancelledAt ?? null;
      let cancelledBy = existing.cancelled_by ?? norm.cancelledBy ?? null;
      let cancelReason = existing.cancel_reason ?? norm.cancelReason ?? null;
      let stockRestoredAt = existing.stock_restored_at ?? null;

      if (normalizedNext === 'cancelled') {
        if (!cancelledAt) cancelledAt = now;
        if (!cancelledBy) cancelledBy = options?.actor || 'owner';
        if (!cancelReason && options?.note?.trim()) {
          cancelReason = options.note.trim().slice(0, 500);
        }
        if (!stockRestoredAt) {
          this.restoreOrderStockSync(orderId, now);
          stockRestoredAt = now;
        }
      }

      if (statusChanged || refundChanged || options?.note) {
        history.push({
          status: statusChanged ? normalizedNext : `refund_${payNorm.refundStatus}`,
          note: options?.note?.trim() || undefined,
          actor: options?.actor || 'owner',
          at: now,
        });
      }

      const historyJson = JSON.stringify(history);
      this.db
        .prepare(
          `UPDATE orders
           SET status = ?,
               fulfillment_status = ?,
               payment_status = ?,
               refund_status = ?,
               cancelled_at = ?,
               cancelled_by = ?,
               cancel_reason = ?,
               stock_restored_at = ?,
               status_history_json = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          normalizedNext,
          normalizedNext,
          payNorm.paymentStatus,
          payNorm.refundStatus,
          cancelledAt,
          cancelledBy,
          cancelReason,
          stockRestoredAt,
          historyJson,
          now,
          orderId
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    }

    if (
      options?.notifyCustomer !== false &&
      changed &&
      existing.customer_user_id
    ) {
      const custRow = this.db
        .prepare(`SELECT notification_prefs_json FROM users WHERE id = ? LIMIT 1`)
        .get(existing.customer_user_id) as { notification_prefs_json?: string | null } | undefined;
      const prefs = parseNotificationPrefs(custRow?.notification_prefs_json);
      if (prefs.orderUpdates) {
        const label = normalizedNext.replace(/_/g, ' ');
        const notifId = `notif_status_${orderId}_${normalizedNext}_${now}`;
        this.db
          .prepare(
            `INSERT INTO customer_notifications (
              id, user_id, type, title, message, order_id, order_number, is_read, read_at, created_at
            ) VALUES (?, ?, 'order_status', ?, ?, ?, ?, 0, NULL, ?)`
          )
          .run(
            notifId,
            existing.customer_user_id,
            `Order ${existing.order_number} is now ${label}`,
            options?.note?.trim()
              ? `${options.note.trim()} (Order ${existing.order_number})`
              : `Your order ${existing.order_number} status has been updated to ${label}.`,
            orderId,
            existing.order_number,
            now
          );
      }
    }

    return this.getOrderById(orderId);
  }

  async cancelCustomerOrder(input: {
    orderId: string;
    userId: string;
    reason?: string;
    expectedUpdatedAt?: number | null;
  }): Promise<{ orderWithItems: OrderWithItems; alreadyCancelled: boolean } | null> {
    const cleanReason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
    let existingOrderNumber = '';
    let existingCustomerUserId: string | null = null;
    let alreadyCancelled = false;
    let now = Date.now();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db
        .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
        .get(input.orderId) as OrderRow | undefined;
      if (!existing) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      if (existing.customer_user_id !== input.userId) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          403,
          'FORBIDDEN',
          'You can only cancel orders belonging to your own account.'
        );
      }

      existingOrderNumber = existing.order_number;
      existingCustomerUserId = existing.customer_user_id;

      const history = parseOrderHistory(existing.status_history_json);
      const norm = normalizeOrderRequestsAndStatus({
        rawStatus: existing.status,
        rawFulfillmentStatus: existing.fulfillment_status,
        rawCancelRequest: existing.cancel_request_json,
        rawReturnRequest: existing.return_request_json,
        rawPaymentStatus: existing.payment_status,
        rawRefundStatus: existing.refund_status,
        rawCancelledAt: existing.cancelled_at,
        rawCancelledBy: existing.cancelled_by,
        rawCancelReason: existing.cancel_reason,
        razorpayPaymentId: existing.razorpay_payment_id,
        history,
        paymentMethod: existing.payment_method,
      });

      // Idempotent handling: already cancelled orders return current cancelled state without re-restoring stock
      if (norm.status === 'cancelled') {
        alreadyCancelled = true;
        this.db.exec('COMMIT;');
        const current = await this.getOrderById(input.orderId);
        return current ? { orderWithItems: current, alreadyCancelled: true } : null;
      }

      if (
        typeof input.expectedUpdatedAt === 'number' &&
        Number.isFinite(input.expectedUpdatedAt) &&
        Number(existing.updated_at || existing.created_at || 0) !== Number(input.expectedUpdatedAt)
      ) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          409,
          'CONCURRENCY_CONFLICT',
          'This order was updated just before your request. Please refresh and check its latest status.'
        );
      }

      if (!PRE_SHIPPING_CANCEL_STATES.has(norm.status)) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          409,
          'CANCELLATION_CUTOFF_PASSED',
          `Cancellation is unavailable once an order is ${norm.status}.`
        );
      }

      now = Date.now();
      const refundStatus = norm.paymentStatus === 'paid' ? 'pending_refund' : 'not_required';
      const cancelRequestRecord: OrderReturnRequestRecord = {
        id: norm.cancelRequest?.id || `req_${crypto.randomUUID().slice(0, 12)}`,
        type: 'cancel',
        reason: cleanReason || norm.cancelRequest?.reason || 'Cancelled by customer',
        status: 'approved',
        requestedAt: norm.cancelRequest?.requestedAt || now,
        updatedAt: now,
        resolvedAt: now,
        resolutionNote: 'Cancelled directly by customer before shipment',
      };

      history.push({
        status: 'cancelled',
        note: cleanReason || 'Cancelled by customer before shipment',
        actor: 'customer',
        at: now,
      });

      let stockRestoredAt = existing.stock_restored_at ?? null;
      if (!stockRestoredAt) {
        this.restoreOrderStockSync(input.orderId, now);
        stockRestoredAt = now;
      }

      this.db
        .prepare(
          `UPDATE orders
           SET status = 'cancelled',
               fulfillment_status = 'cancelled',
               payment_status = ?,
               refund_status = ?,
               cancelled_at = ?,
               cancelled_by = 'customer',
               cancel_reason = ?,
               cancel_request_json = ?,
               stock_restored_at = ?,
               status_history_json = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          norm.paymentStatus,
          refundStatus,
          now,
          cleanReason || null,
          JSON.stringify(cancelRequestRecord),
          stockRestoredAt,
          JSON.stringify(history),
          now,
          input.orderId
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    }

    if (!alreadyCancelled && existingCustomerUserId) {
      const customerRow = await this.getUserById(existingCustomerUserId);
      const prefs = parseNotificationPrefs(customerRow?.notification_prefs_json);
      if (prefs.cancelReturnUpdates || prefs.orderUpdates) {
        await this.createCustomerNotification({
          id: `notif_cancelled_${input.orderId}`,
          userId: existingCustomerUserId,
          type: 'order_status',
          title: `Order ${existingOrderNumber} cancelled`,
          message: cleanReason
            ? `Your order ${existingOrderNumber} has been cancelled (${cleanReason}).`
            : `Your order ${existingOrderNumber} has been cancelled.`,
          orderId: input.orderId,
          orderNumber: existingOrderNumber,
        }).catch(() => {});
      }
    }

    const updated = await this.getOrderById(input.orderId);
    return updated ? { orderWithItems: updated, alreadyCancelled: false } : null;
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
    // Customer cancellations transition immediately and authoritatively to 'cancelled'
    if (input.type === 'cancel') {
      const result = await this.cancelCustomerOrder({
        orderId: input.orderId,
        userId: input.userId,
        reason: input.reason,
      });
      return result ? result.orderWithItems : null;
    }

    const cleanReason = input.reason.trim().slice(0, 500);
    if (cleanReason.length < 3) {
      throw new StoreHttpError(
        400,
        'VALIDATION_ERROR',
        'Please provide a brief reason (at least 3 characters).'
      );
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db
        .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
        .get(input.orderId) as OrderRow | undefined;
      if (!existing) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      if (existing.customer_user_id !== input.userId) {
        this.db.exec('ROLLBACK;');
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
        rawPaymentStatus: existing.payment_status,
        rawRefundStatus: existing.refund_status,
        rawCancelledAt: existing.cancelled_at,
        rawCancelledBy: existing.cancelled_by,
        rawCancelReason: existing.cancel_reason,
        razorpayPaymentId: existing.razorpay_payment_id,
        history,
        paymentMethod: existing.payment_method,
      });

      if (!RETURN_ELIGIBLE_STATES.has(norm.fulfillmentStatus)) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          409,
          'RETURN_NOT_ELIGIBLE',
          'Return requests can only be submitted after your order is delivered.'
        );
      }
      if (norm.returnRequest?.status === 'pending') {
        if (norm.returnRequest.reason === cleanReason) {
          this.db.exec('COMMIT;');
          return this.getOrderById(input.orderId);
        }
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          409,
          'REQUEST_ALREADY_PENDING',
          'A return request is already pending for this order. You can edit or withdraw it below.'
        );
      }

      const now = Date.now();
      const requestRecord: OrderReturnRequestRecord = {
        id: `req_${crypto.randomUUID().slice(0, 12)}`,
        type: 'return',
        reason: cleanReason,
        status: 'pending',
        requestedAt: now,
        updatedAt: now,
        resolvedAt: null,
      };

      history.push({
        status: 'return_requested',
        note: cleanReason,
        actor: 'customer',
        at: now,
      });

      this.db
        .prepare(
          `UPDATE orders SET status = ?, fulfillment_status = ?, return_request_json = ?, status_history_json = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          norm.fulfillmentStatus,
          norm.fulfillmentStatus,
          JSON.stringify(requestRecord),
          JSON.stringify(history),
          now,
          input.orderId
        );

      this.db.exec('COMMIT;');
      return this.getOrderById(input.orderId);
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  async updateOrderRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    action: 'edit' | 'withdraw';
    reason?: string;
  }): Promise<OrderWithItems | null> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db
        .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
        .get(input.orderId) as OrderRow | undefined;
      if (!existing) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      if (existing.customer_user_id !== input.userId) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          403,
          'FORBIDDEN',
          'You can only update requests for your own orders.'
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

      const target = input.type === 'cancel' ? norm.cancelRequest : norm.returnRequest;
      if (!target) {
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(404, 'REQUEST_NOT_FOUND', 'No request was found on this order.');
      }
      if (target.status !== 'pending') {
        this.db.exec('ROLLBACK;');
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
          this.db.exec('ROLLBACK;');
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

      const nextCancelJson =
        input.type === 'cancel'
          ? JSON.stringify(updatedTarget)
          : norm.cancelRequest
            ? JSON.stringify(norm.cancelRequest)
            : null;
      const nextReturnJson =
        input.type === 'return'
          ? JSON.stringify(updatedTarget)
          : norm.returnRequest
            ? JSON.stringify(norm.returnRequest)
            : null;

      this.db
        .prepare(
          `UPDATE orders
           SET status = ?, fulfillment_status = ?, cancel_request_json = ?, return_request_json = ?, status_history_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          norm.fulfillmentStatus,
          norm.fulfillmentStatus,
          nextCancelJson,
          nextReturnJson,
          JSON.stringify(history),
          now,
          input.orderId
        );

      this.db.exec('COMMIT;');
      return this.getOrderById(input.orderId);
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  async updateOrderDeliveryDetails(input: {
    orderId: string;
    userId: string;
    customerName?: string;
    customerPhone?: string;
    shippingAddress?: string;
  }): Promise<OrderWithItems | null> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db
        .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
        .get(input.orderId) as OrderRow | undefined;
      if (!existing) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      if (existing.customer_user_id !== input.userId) {
        this.db.exec('ROLLBACK;');
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
        this.db.exec('ROLLBACK;');
        throw new StoreHttpError(
          409,
          'DELIVERY_CUTOFF_PASSED',
          `Delivery details cannot be changed once your order is ${norm.fulfillmentStatus}.`
        );
      }

      const cleanName =
        typeof input.customerName === 'string' ? input.customerName.trim() : existing.customer_name.trim();
      const cleanPhone =
        typeof input.customerPhone === 'string' ? input.customerPhone.trim() : existing.customer_phone.trim();
      const cleanAddress =
        typeof input.shippingAddress === 'string'
          ? input.shippingAddress.trim()
          : existing.shipping_address.trim();
      if (cleanName.length < 2 || cleanPhone.length < 6 || cleanAddress.length < 5) {
        this.db.exec('ROLLBACK;');
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

      this.db
        .prepare(
          `UPDATE orders
           SET customer_name = ?, customer_phone = ?, shipping_address = ?, delivery_details_edited_at = ?, status_history_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          cleanName.slice(0, 120),
          cleanPhone.slice(0, 32),
          cleanAddress.slice(0, 600),
          now,
          JSON.stringify(history),
          now,
          input.orderId
        );

      this.db.exec('COMMIT;');
      return this.getOrderById(input.orderId);
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  async hideOrderForCustomer(orderId: string, userId: string): Promise<boolean> {
    const existing = this.db
      .prepare(`SELECT customer_user_id FROM orders WHERE id = ? LIMIT 1`)
      .get(orderId) as { customer_user_id: string | null } | undefined;
    if (!existing) return false;
    if (existing.customer_user_id !== userId) {
      throw new StoreHttpError(403, 'FORBIDDEN', 'You can only hide orders from your own account.');
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE orders SET hidden_by_customer = 1, hidden_at = ?, updated_at = ? WHERE id = ? AND customer_user_id = ?`
      )
      .run(now, now, orderId, userId);
    return true;
  }

  async resolveOrderReturnRequest(input: {
    orderId: string;
    requestType?: 'cancel' | 'return';
    decision: 'approved' | 'rejected';
    note?: string;
  }): Promise<OrderWithItems | null> {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db
        .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
        .get(input.orderId) as OrderRow | undefined;
      if (!existing) {
        this.db.exec('ROLLBACK;');
        return null;
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

      let target =
        input.requestType === 'cancel'
          ? norm.cancelRequest
          : input.requestType === 'return'
            ? norm.returnRequest
            : norm.cancelRequest?.status === 'pending'
              ? norm.cancelRequest
              : norm.returnRequest?.status === 'pending'
                ? norm.returnRequest
                : norm.cancelRequest || norm.returnRequest;

      if (!target) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      if (target.status !== 'pending') {
        this.db.exec('ROLLBACK;');
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
        this.restoreOrderStockSync(input.orderId, now);
        stockRestoredAt = now;
      }

      const payNorm = normalizePaymentAndRefundStatus({
        rawPaymentStatus: existing.payment_status,
        rawRefundStatus: existing.refund_status,
        paymentMethod: existing.payment_method,
        orderStatus: nextStatus,
        razorpayPaymentId: existing.razorpay_payment_id,
      });
      const cancelledAt =
        nextStatus === 'cancelled' ? existing.cancelled_at ?? now : existing.cancelled_at ?? null;
      const cancelledBy =
        nextStatus === 'cancelled' ? existing.cancelled_by ?? 'owner' : existing.cancelled_by ?? null;
      const cancelReason =
        nextStatus === 'cancelled'
          ? existing.cancel_reason ?? updatedReq.reason ?? null
          : existing.cancel_reason ?? null;

      const nextCancelJson =
        updatedReq.type === 'cancel'
          ? JSON.stringify(updatedReq)
          : norm.cancelRequest
            ? JSON.stringify(norm.cancelRequest)
            : null;
      const nextReturnJson =
        updatedReq.type === 'return'
          ? JSON.stringify(updatedReq)
          : norm.returnRequest
            ? JSON.stringify(norm.returnRequest)
            : null;

      this.db
        .prepare(
          `UPDATE orders
           SET status = ?, fulfillment_status = ?, refund_status = ?,
               cancelled_at = ?, cancelled_by = ?, cancel_reason = ?,
               cancel_request_json = ?, return_request_json = ?,
               stock_restored_at = ?, status_history_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextStatus,
          nextFulfillment,
          payNorm.refundStatus,
          cancelledAt,
          cancelledBy,
          cancelReason,
          nextCancelJson,
          nextReturnJson,
          stockRestoredAt,
          JSON.stringify(history),
          now,
          input.orderId
        );

      this.db.exec('COMMIT;');

      if (existing.customer_user_id) {
        const customerRow = await this.getUserById(existing.customer_user_id);
        const prefs = parseNotificationPrefs(customerRow?.notification_prefs_json);
        if (prefs.cancelReturnUpdates) {
          await this.createCustomerNotification({
            id: `notif_req_${existing.id}_${updatedReq.id}_${input.decision}`,
            userId: existing.customer_user_id,
            type: 'request_update',
            title: `${updatedReq.type === 'cancel' ? 'Cancellation' : 'Return'} request ${input.decision}`,
            message:
              updatedReq.resolutionNote ||
              `Your ${updatedReq.type} request for order ${existing.order_number} was ${input.decision}.`,
            orderId: existing.id,
            orderNumber: existing.order_number,
          });
        }
      }

      return this.getOrderById(input.orderId);
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  async collectOrderPayment(input: {
    orderId: string;
    actorUserId?: string | null;
    note?: string;
  }): Promise<OrderWithItems | null> {
    const existing = this.db
      .prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`)
      .get(input.orderId) as OrderRow | undefined;
    if (!existing) return null;

    if (existing.status === 'cancelled' || existing.fulfillment_status === 'cancelled') {
      throw new StoreHttpError(
        409,
        'ORDER_CANCELLED',
        'Cannot record payment collection for a cancelled order.'
      );
    }

    if (existing.payment_status === 'paid') {
      return this.getOrderById(input.orderId);
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
      `Cash on Delivery payment of ₹${(existing.total_paise / 100).toLocaleString('en-IN')} collected`;
    history.push({
      status: 'payment_collected',
      note: noteText,
      actor: 'owner',
      at: now,
    });

    this.db
      .prepare(
        `UPDATE orders
         SET payment_status = 'paid',
             payment_collected_at = ?,
             payment_collected_by = ?,
             status_history_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        now,
        input.actorUserId || 'owner',
        JSON.stringify(history),
        now,
        input.orderId
      );

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

    return this.getOrderById(input.orderId);
  }

  async listCustomerAddresses(userId: string): Promise<CustomerAddressRow[]> {
    return this.db
      .prepare(
        `SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC`
      )
      .all(userId) as unknown as CustomerAddressRow[];
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

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (shouldBeDefault) {
        this.db.prepare(`UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?`).run(userId);
      }
      const existing = existingList.find((a) => a.id === id);
      if (existing) {
        this.db
          .prepare(
            `UPDATE customer_addresses SET
              full_name = ?, phone = ?, line1 = ?, line2 = ?, city = ?, state = ?,
              pincode = ?, landmark = ?, label = ?, is_default = ?, updated_at = ?
             WHERE id = ? AND user_id = ?`
          )
          .run(
            input.fullName.trim(),
            input.phone.trim(),
            input.line1.trim(),
            (input.line2 || '').trim(),
            input.city.trim(),
            input.state.trim(),
            input.pincode.trim(),
            (input.landmark || '').trim(),
            input.label,
            shouldBeDefault,
            now,
            id,
            userId
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO customer_addresses (
              id, user_id, full_name, phone, line1, line2, city, state, pincode,
              landmark, label, is_default, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            userId,
            input.fullName.trim(),
            input.phone.trim(),
            input.line1.trim(),
            (input.line2 || '').trim(),
            input.city.trim(),
            input.state.trim(),
            input.pincode.trim(),
            (input.landmark || '').trim(),
            input.label,
            shouldBeDefault,
            now,
            now
          );
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.db
      .prepare(`SELECT * FROM customer_addresses WHERE id = ? LIMIT 1`)
      .get(id) as unknown as CustomerAddressRow;
  }

  async deleteCustomerAddress(userId: string, addressId: string): Promise<boolean> {
    const existing = this.db
      .prepare(`SELECT is_default FROM customer_addresses WHERE id = ? AND user_id = ? LIMIT 1`)
      .get(addressId, userId) as { is_default?: number } | undefined;
    const res = this.db
      .prepare(`DELETE FROM customer_addresses WHERE id = ? AND user_id = ?`)
      .run(addressId, userId);
    if (res.changes > 0 && Number(existing?.is_default || 0) === 1) {
      const next = this.db
        .prepare(
          `SELECT id FROM customer_addresses WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1`
        )
        .get(userId) as { id?: string } | undefined;
      if (next?.id) {
        this.db
          .prepare(`UPDATE customer_addresses SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?`)
          .run(Date.now(), next.id, userId);
      }
    }
    return res.changes > 0;
  }

  async getCustomerWishlist(userId: string): Promise<string[]> {
    const rows = this.db
      .prepare(`SELECT product_id FROM customer_wishlists WHERE user_id = ? ORDER BY updated_at DESC`)
      .all(userId) as Array<{ product_id: string }>;
    return rows.map((r) => r.product_id);
  }

  async setCustomerWishlist(userId: string, productIds: string[]): Promise<string[]> {
    const unique = Array.from(new Set(productIds.filter((id) => typeof id === 'string' && id.trim())));
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`DELETE FROM customer_wishlists WHERE user_id = ?`).run(userId);
      const insert = this.db.prepare(
        `INSERT INTO customer_wishlists (user_id, product_id, updated_at) VALUES (?, ?, ?)`
      );
      for (const pid of unique) {
        insert.run(userId, pid, now);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    return unique;
  }

  async listCustomerNotifications(userId: string): Promise<CustomerNotificationRow[]> {
    return this.db
      .prepare(`SELECT * FROM customer_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60`)
      .all(userId) as unknown as CustomerNotificationRow[];
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
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO customer_notifications (
          id, user_id, type, title, message, order_id, order_number, is_read, read_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
      )
      .run(
        id,
        input.userId,
        input.type,
        input.title.trim().slice(0, 140),
        input.message.trim().slice(0, 500),
        input.orderId || null,
        input.orderNumber || null,
        now
      );
    return this.db
      .prepare(`SELECT * FROM customer_notifications WHERE id = ? LIMIT 1`)
      .get(id) as unknown as CustomerNotificationRow;
  }

  async markCustomerNotificationRead(userId: string, notificationId: string): Promise<boolean> {
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE customer_notifications SET is_read = 1, read_at = ? WHERE id = ? AND user_id = ?`
      )
      .run(now, notificationId, userId);
    return res.changes > 0;
  }

  async listCustomerPaymentMethods(userId: string): Promise<CustomerPaymentMethodRow[]> {
    return this.db
      .prepare(
        `SELECT * FROM customer_payment_methods WHERE user_id = ? ORDER BY updated_at DESC`
      )
      .all(userId) as unknown as CustomerPaymentMethodRow[];
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
    const existing = this.db
      .prepare(`SELECT id FROM customer_payment_methods WHERE id = ? AND user_id = ? LIMIT 1`)
      .get(id, userId) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE customer_payment_methods
           SET method_type = ?, label = ?, last4 = ?, network = ?, expiry = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`
        )
        .run(
          validated.methodType,
          validated.label,
          validated.last4,
          validated.network,
          validated.expiry,
          now,
          id,
          userId
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO customer_payment_methods (
            id, user_id, method_type, label, last4, network, expiry, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          userId,
          validated.methodType,
          validated.label,
          validated.last4,
          validated.network,
          validated.expiry,
          now,
          now
        );
    }

    return this.db
      .prepare(`SELECT * FROM customer_payment_methods WHERE id = ? LIMIT 1`)
      .get(id) as unknown as CustomerPaymentMethodRow;
  }

  async deleteCustomerPaymentMethod(userId: string, methodId: string): Promise<boolean> {
    const res = this.db
      .prepare(`DELETE FROM customer_payment_methods WHERE id = ? AND user_id = ?`)
      .run(methodId, userId);
    return res.changes > 0;
  }

  async markAllCustomerNotificationsRead(userId: string): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE customer_notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0`
      )
      .run(now, userId);
  }

  async deleteCustomerNotification(userId: string, notificationId: string): Promise<boolean> {
    const res = this.db
      .prepare(`DELETE FROM customer_notifications WHERE id = ? AND user_id = ?`)
      .run(notificationId, userId);
    return res.changes > 0;
  }

  async listCoupons(activeOnly = false): Promise<CouponRow[]> {
    const rows = this.db
      .prepare(
        activeOnly
          ? `SELECT * FROM coupons WHERE active = 1 ORDER BY created_at DESC`
          : `SELECT * FROM coupons ORDER BY created_at DESC`
      )
      .all() as unknown as CouponRow[];
    return rows;
  }

  async getCouponByCode(code: string): Promise<CouponRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM coupons WHERE UPPER(code) = UPPER(?) LIMIT 1`)
      .get(code.trim()) as CouponRow | undefined;
    return row || null;
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
    const existing = this.db
      .prepare(`SELECT * FROM coupons WHERE id = ? LIMIT 1`)
      .get(id) as CouponRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE coupons SET
            code = ?, title = ?, description = ?, discount_type = ?, discount_value = ?,
            max_discount_paise = ?, min_spend_paise = ?, usage_limit = ?, active = ?,
            starts_at = ?, expires_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          cleanCode,
          input.title.trim(),
          input.description.trim(),
          input.discountType,
          Math.round(input.discountValue),
          input.maxDiscountPaise ?? null,
          Math.max(0, Math.round(input.minSpendPaise)),
          input.usageLimit ?? null,
          input.active ? 1 : 0,
          input.startsAt ?? null,
          input.expiresAt ?? null,
          now,
          id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO coupons (
            id, code, title, description, discount_type, discount_value, max_discount_paise,
            min_spend_paise, usage_limit, used_count, active, starts_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          cleanCode,
          input.title.trim(),
          input.description.trim(),
          input.discountType,
          Math.round(input.discountValue),
          input.maxDiscountPaise ?? null,
          Math.max(0, Math.round(input.minSpendPaise)),
          input.usageLimit ?? null,
          input.active ? 1 : 0,
          input.startsAt ?? null,
          input.expiresAt ?? null,
          now,
          now
        );
    }
    return this.db
      .prepare(`SELECT * FROM coupons WHERE id = ? LIMIT 1`)
      .get(id) as unknown as CouponRow;
  }

  async deleteCoupon(id: string): Promise<boolean> {
    const res = this.db.prepare(`DELETE FROM coupons WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  async listGiftCards(): Promise<GiftCardRow[]> {
    return this.db
      .prepare(`SELECT * FROM gift_cards ORDER BY created_at DESC`)
      .all() as unknown as GiftCardRow[];
  }

  async getGiftCardByCode(code: string): Promise<GiftCardRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM gift_cards WHERE UPPER(code) = UPPER(?) LIMIT 1`)
      .get(code.trim()) as GiftCardRow | undefined;
    return row || null;
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
    const existing = this.db
      .prepare(`SELECT * FROM gift_cards WHERE id = ? LIMIT 1`)
      .get(id) as GiftCardRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE gift_cards SET
            code = ?, recipient_email = ?, note = ?, initial_balance_paise = ?, balance_paise = ?,
            active = ?, expires_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          cleanCode,
          (input.recipientEmail || '').trim().toLowerCase(),
          (input.note || '').trim(),
          Math.max(0, Math.round(input.initialBalancePaise)),
          Math.max(0, Math.round(input.balancePaise)),
          input.active ? 1 : 0,
          input.expiresAt ?? null,
          now,
          id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO gift_cards (
            id, code, recipient_email, note, initial_balance_paise, balance_paise,
            active, expires_at, last_used_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          id,
          cleanCode,
          (input.recipientEmail || '').trim().toLowerCase(),
          (input.note || '').trim(),
          Math.max(0, Math.round(input.initialBalancePaise)),
          Math.max(0, Math.round(input.balancePaise)),
          input.active ? 1 : 0,
          input.expiresAt ?? null,
          now,
          now
        );
    }

    return this.db
      .prepare(`SELECT * FROM gift_cards WHERE id = ? LIMIT 1`)
      .get(id) as unknown as GiftCardRow;
  }

  async deleteGiftCard(id: string): Promise<boolean> {
    const res = this.db.prepare(`DELETE FROM gift_cards WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  async getLoyaltyConfig(): Promise<LoyaltyConfigData> {
    const row = this.db
      .prepare(`SELECT data_json FROM site_documents WHERE key = 'loyalty_config' LIMIT 1`)
      .get() as { data_json: string } | undefined;
    if (!row) return mergeLoyaltyConfig(null);
    try {
      return mergeLoyaltyConfig(JSON.parse(row.data_json) as Partial<LoyaltyConfigData>);
    } catch {
      return mergeLoyaltyConfig(null);
    }
  }

  async saveLoyaltyConfig(config: LoyaltyConfigData): Promise<LoyaltyConfigData> {
    const normalized = mergeLoyaltyConfig(config);
    this.db
      .prepare(
        `INSERT INTO site_documents (key, data_json, updated_at)
         VALUES ('loyalty_config', ?, ?)
         ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(normalized), Date.now());
    return normalized;
  }

  async listUsersSummary(): Promise<StoreUserSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT id, full_name, email, email_verified, phone_e164, phone_verified, notification_prefs_json, created_at, updated_at
         FROM users WHERE (email_verified = 1 OR phone_verified = 1) AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 100`
      )
      .all() as Array<{
      id: string;
      full_name: string;
      email: string | null;
      email_verified: number;
      phone_e164: string | null;
      phone_verified: number;
      notification_prefs_json: string | null;
      created_at: number;
      updated_at: number;
    }>;

    const addrStmt = this.db.prepare(
      `SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC`
    );

    return rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      email: r.email || '',
      emailVerified: Boolean(r.email_verified),
      phone: r.phone_e164 || null,
      verifiedPhone: r.phone_verified ? r.phone_e164 || null : null,
      phoneVerified: Boolean(r.phone_verified && r.phone_e164),
      notificationPrefs: parseNotificationPrefs(r.notification_prefs_json),
      addresses: addrStmt.all(r.id) as unknown as CustomerAddressRow[],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
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
