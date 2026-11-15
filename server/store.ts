import crypto from 'node:crypto';
import type {
  AdminBindingRow,
  CategoryRow,
  ContactMessageRow,
  ContactMessageStatus,
  EmailTokenRow,
  LegacyPhoneOnlyAccount,
  OrderItemRow,
  OrderRow,
  ProductAuditLogRow,
  ProductImageRow,
  ProductMediaRow,
  ProductRow,
  ProductStatus,
  ProductVariantRow,
  SessionRow,
  SiteSettingsData,
  StorefrontContentData,
  UserRow,
} from './db.ts';
import type { RuntimeTargetEnv, StorageBackend } from './env.ts';

export type {
  AdminBindingRow,
  CategoryRow,
  ContactMessageRow,
  ContactMessageStatus,
  EmailTokenRow,
  LegacyPhoneOnlyAccount,
  OrderItemRow,
  OrderRow,
  ProductAuditLogRow,
  ProductImageRow,
  ProductMediaRow,
  ProductRow,
  ProductStatus,
  ProductVariantRow,
  SessionRow,
  SiteSettingsData,
  StorefrontContentData,
  UserRow,
};

export interface ProductWithParts {
  product: ProductRow;
  variants: ProductVariantRow[];
  images: ProductImageRow[];
}

export interface AdminProductRecord extends ProductWithParts {
  orderCount: number;
}

export interface AdminOverviewData {
  metrics: {
    totalProducts: number;
    publishedProducts: number;
    draftProducts: number;
    archivedProducts: number;
    lowStockProducts: number;
    outOfStockProducts: number;
    totalCategories: number;
    totalOrders: number;
    pendingOrders: number;
    totalRevenuePaise: number;
    unreadMessages: number;
    totalMessages: number;
    totalAuditEvents: number;
  };
  lowStockItems: AdminProductRecord[];
  recentOrders: OrderWithItems[];
  recentMessages: ContactMessageRow[];
  recentAuditLogs: ProductAuditLogRow[];
}

export interface AdminProductQuery {
  q?: string;
  status?: string;
  category?: string;
  stockFilter?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

export interface OrderWithItems {
  order: OrderRow;
  items: OrderItemRow[];
}

export interface PlaceOrderInput {
  customerUserId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  items: Array<{
    productId: string;
    variantId: string;
    quantity: number;
    expectedPricePaise: number | null;
  }>;
}

export class StoreHttpError extends Error {
  readonly httpStatus: number;
  readonly code: string;

  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export interface SaveMediaFileInput {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  data: Uint8Array;
  uploadedByUserId: string;
  createdAt: number;
}

export interface BoutiqueStore {
  readonly backend: StorageBackend;
  readonly isPersistent: boolean;
  readonly locationLabel: string;
  readonly targetEnv: RuntimeTargetEnv;

  verifyConnectivity(): Promise<void>;
  close(): Promise<void>;

  // Users & legacy accounts
  getUserById(id: string): Promise<UserRow | null>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  isEmailTakenByOtherUser(email: string, excludeUserId: string): Promise<boolean>;
  createPendingEmailUser(input: {
    id: string;
    fullName: string;
    email: string;
    passwordHash: string;
    now: number;
  }): Promise<UserRow>;
  updatePendingEmailUser(input: {
    id: string;
    fullName: string;
    passwordHash: string;
    now: number;
  }): Promise<UserRow | null>;
  markUserEmailVerified(userId: string, now: number): Promise<UserRow>;
  linkVerifiedEmailToUser(userId: string, newEmail: string, now: number): Promise<UserRow>;
  updateUserFullName(userId: string, fullName: string, now: number): Promise<UserRow>;
  updateUserPasswordHash(userId: string, passwordHash: string, now: number): Promise<void>;
  listLegacyPhoneOnlyAccounts(): Promise<LegacyPhoneOnlyAccount[]>;

  // Sessions
  getActiveSessionByTokenHash(tokenHash: string, now: number): Promise<SessionRow | null>;
  createSession(session: SessionRow): Promise<SessionRow>;
  updateSessionReauth(sessionId: string, lastReauthAt: number): Promise<void>;
  revokeSession(sessionId: string, now: number): Promise<void>;
  revokeUserSessions(userId: string, now: number, exceptSessionId?: string): Promise<void>;

  // Email verification / reset tokens
  createEmailToken(params: {
    id: string;
    userId: string;
    purpose: EmailTokenRow['purpose'];
    targetEmail: string;
    tokenHash: string;
    expiresAt: number;
    createdAt: number;
    invalidatePreviousSamePurpose?: boolean;
  }): Promise<EmailTokenRow>;
  deleteEmailToken(tokenId: string): Promise<void>;
  getLatestVerifyEmailTokenTimestamp(userId: string): Promise<number | null>;
  getEmailTokenByHash(
    tokenHash: string,
    purposes: EmailTokenRow['purpose'][]
  ): Promise<EmailTokenRow | null>;
  consumeEmailToken(tokenId: string, now: number): Promise<boolean>;

  // Owner binding & verification
  getStoredAdminBinding(): Promise<AdminBindingRow | null>;
  resolveBoundOwner(): Promise<AdminBindingRow | null>;
  bindOwnerAccount(params: {
    email: string;
    boundVia?: string;
    forceRebind?: boolean;
  }): Promise<AdminBindingRow>;

  // Catalog & products
  seedInitialCatalogIfEmpty(): Promise<void>;
  listPublicProducts(filters: {
    category?: string;
    q?: string;
    featuredOnly?: boolean;
  }): Promise<ProductWithParts[]>;
  getPublicProductByIdOrSlug(idOrSlug: string): Promise<ProductWithParts | null>;
  isProductSkuConflict(sku: string, excludeProductId?: string): Promise<boolean>;
  isVariantSkuConflict(sku: string, excludeProductId?: string): Promise<boolean>;
  makeUniqueSlug(baseTitle: string, excludeId?: string): Promise<string>;
  getAdminOverview(): Promise<AdminOverviewData>;
  listAdminProducts(query: AdminProductQuery): Promise<{
    items: AdminProductRecord[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>;
  getAdminProduct(id: string): Promise<{
    data: AdminProductRecord;
    auditLogs: ProductAuditLogRow[];
  } | null>;
  createProduct(input: {
    product: ProductRow;
    variants: ProductVariantRow[];
    images: Array<{ mediaId: string | null; url: string; alt: string; isCover: boolean }>;
    actorUserId: string;
    auditAction: string;
    auditSummary: string;
    auditAfter: unknown;
  }): Promise<AdminProductRecord>;
  updateProduct(input: {
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
  }): Promise<
    | { ok: true; product: AdminProductRecord }
    | { ok: false; code: 'PRODUCT_NOT_FOUND' | 'VERSION_CONFLICT' }
  >;
  duplicateProduct(sourceId: string, actorUserId: string): Promise<AdminProductRecord | null>;
  transitionProductStatus(input: {
    productId: string;
    expectedVersion: number;
    targetStatus: ProductStatus;
    actionName: 'publish' | 'unpublish' | 'archive' | 'restore';
    actorUserId: string;
  }): Promise<
    | { ok: true; product: AdminProductRecord }
    | { ok: false; code: 'PRODUCT_NOT_FOUND' | 'VERSION_CONFLICT' | 'NO_IMAGES' }
  >;
  deleteOrArchiveProduct(
    productId: string,
    actorUserId: string
  ): Promise<
    | { ok: true; archivedInsteadOfDeleted: boolean; product?: AdminProductRecord }
    | { ok: false; code: 'PRODUCT_NOT_FOUND' }
  >;

  // Media
  findMediaByFilename(filename: string): Promise<{ id: string } | null>;
  saveMediaFiles(files: SaveMediaFileInput[]): Promise<void>;
  getMediaWithPublicStatus(filename: string): Promise<{
    media: ProductMediaRow;
    isLinkedToPublished: boolean;
  } | null>;

  // Cart & orders
  getProductsForCartValidation(productIds: string[]): Promise<Map<string, ProductWithParts>>;
  placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }>;
  listAdminOrders(page: number, pageSize: number): Promise<{
    items: OrderWithItems[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>;
  updateOrderStatus(orderId: string, nextStatus: string): Promise<boolean>;

  // Audit logs
  listAuditLogs(params: {
    productId?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    items: ProductAuditLogRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>;

  // Categories
  listCategories(): Promise<CategoryRow[]>;
  getCategoryById(id: string): Promise<CategoryRow | null>;
  createCategory(input: {
    name: string;
    subtitle: string;
    imageUrl: string;
    altText: string;
    position?: number;
  }): Promise<CategoryRow>;
  updateCategory(
    id: string,
    input: {
      name: string;
      subtitle: string;
      imageUrl: string;
      altText: string;
      position?: number;
    }
  ): Promise<CategoryRow | null>;
  deleteCategory(
    id: string
  ): Promise<
    | { ok: true }
    | { ok: false; code: 'NOT_FOUND' | 'CATEGORY_IN_USE'; productCount?: number }
  >;

  // Storefront settings & editorial content
  getSiteSettings(): Promise<SiteSettingsData>;
  saveSiteSettings(settings: SiteSettingsData): Promise<SiteSettingsData>;
  getStorefrontContent(): Promise<StorefrontContentData>;
  saveStorefrontContent(content: StorefrontContentData): Promise<StorefrontContentData>;

  // Contact / customer messages
  createContactMessage(input: {
    senderName: string;
    senderEmail: string;
    senderPhone: string;
    subject: string;
    message: string;
  }): Promise<ContactMessageRow>;
  listAdminMessages(params: {
    status?: string;
    q?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    items: ContactMessageRow[];
    total: number;
    unreadCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>;
  updateContactMessage(
    id: string,
    patch: { status?: ContactMessageStatus; adminNote?: string }
  ): Promise<ContactMessageRow | null>;
  deleteContactMessage(id: string): Promise<boolean>;
}

export function slugifyProductTitle(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return clean || `style-${crypto.randomBytes(3).toString('hex')}`;
}
