import crypto from 'node:crypto';
import type {
  AdminBindingRow,
  CategoryRow,
  ContactMessageRow,
  ContactMessageStatus,
  CouponRow,
  CustomerAddressRow,
  CustomerNotificationRow,
  CustomerPaymentMethodRow,
  EmailTokenRow,
  GiftCardRow,
  LegacyPhoneOnlyAccount,
  OrderItemRow,
  OrderRow,
  PendingCheckoutRow,
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
import type { LoyaltyConfigData } from './storefront-defaults.ts';
import type { NotificationPreferencesData } from './order-utils.ts';
import type { RuntimeTargetEnv, StorageBackend } from './env.ts';

export type {
  AdminBindingRow,
  CategoryRow,
  ContactMessageRow,
  ContactMessageStatus,
  CouponRow,
  CustomerAddressRow,
  CustomerNotificationRow,
  CustomerPaymentMethodRow,
  EmailTokenRow,
  GiftCardRow,
  LegacyPhoneOnlyAccount,
  LoyaltyConfigData,
  NotificationPreferencesData,
  OrderItemRow,
  OrderRow,
  PendingCheckoutRow,
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

export interface AdminOverviewMetricsExtra {
  totalCustomers?: number;
  openReturnRequests?: number;
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
    cancelledOrders?: number;
    totalRevenuePaise: number;
    unreadMessages: number;
    totalMessages: number;
    totalAuditEvents: number;
    totalCustomers?: number;
    openReturnRequests?: number;
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

export interface OrderStatusHistoryEntry {
  status: string;
  note?: string;
  actor: 'customer' | 'owner' | 'system';
  at: number;
}

export interface OrderReturnRequestRecord {
  id: string;
  type: 'cancel' | 'return';
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  requestedAt: number;
  updatedAt?: number;
  resolvedAt?: number | null;
  resolutionNote?: string;
}

export interface PlaceOrderInput {
  id?: string;
  orderNumber?: string;
  customerUserId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  status?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  paymentMethod?: 'razorpay' | 'cod';
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  idempotencyKey?: string | null;
  couponCode?: string | null;
  giftCardCode?: string | null;
  discountPaise?: number;
  giftCardPaise?: number;
  statusHistory?: OrderStatusHistoryEntry[];
  items: Array<{
    productId: string;
    variantId: string;
    quantity: number;
    expectedPricePaise: number | null;
  }>;
}

export interface StoreUserSummary {
  id: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  phone?: string | null;
  verifiedPhone?: string | null;
  phoneVerified?: boolean;
  notificationPrefs?: NotificationPreferencesData;
  addresses?: CustomerAddressRow[];
  createdAt: number;
  updatedAt?: number;
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
  updateCustomerProfile(
    userId: string,
    input: {
      fullName?: string;
      phone?: string | null;
      notificationPrefs?: NotificationPreferencesData;
    },
    now: number
  ): Promise<UserRow>;
  deleteCustomerAccount(
    userId: string,
    now: number
  ): Promise<{ deleted: boolean; preservedOrdersCount: number }>;
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
  }): Promise<AdminProductRecord>;
  updateProduct(input: {
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
    | {
        ok: false;
        code: 'PRODUCT_NOT_FOUND' | 'VERSION_CONFLICT' | 'NO_IMAGES' | 'INCOMPLETE_COLOR_VARIANTS';
        message?: string;
      }
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

  // Cart, pending checkouts & orders
  getProductsForCartValidation(productIds: string[]): Promise<Map<string, ProductWithParts>>;
  savePendingCheckout(record: PendingCheckoutRow): Promise<void>;
  getPendingCheckout(razorpayOrderId: string): Promise<PendingCheckoutRow | null>;
  placeOrder(input: PlaceOrderInput): Promise<{ order: OrderRow; items: OrderItemRow[] }>;
  getOrderById(orderId: string): Promise<OrderWithItems | null>;
  listCustomerOrders(userId: string): Promise<OrderWithItems[]>;
  listAdminOrders(page: number, pageSize: number): Promise<{
    items: OrderWithItems[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>;
  updateOrderStatus(orderId: string, nextStatus: string): Promise<boolean>;
  updateOrderStatusWithHistory(
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
  ): Promise<OrderWithItems | null>;
  cancelCustomerOrder(input: {
    orderId: string;
    userId: string;
    reason?: string;
    expectedUpdatedAt?: number | null;
  }): Promise<{ orderWithItems: OrderWithItems; alreadyCancelled: boolean } | null>;
  submitOrderReturnRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    reason: string;
  }): Promise<OrderWithItems | null>;
  submitOrderRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    reason: string;
  }): Promise<OrderWithItems | null>;
  updateOrderRequest(input: {
    orderId: string;
    userId: string;
    type: 'cancel' | 'return';
    action: 'edit' | 'withdraw';
    reason?: string;
  }): Promise<OrderWithItems | null>;
  updateOrderDeliveryDetails(input: {
    orderId: string;
    userId: string;
    customerName?: string;
    customerPhone?: string;
    shippingAddress?: string;
  }): Promise<OrderWithItems | null>;
  hideOrderForCustomer(orderId: string, userId: string): Promise<boolean>;
  resolveOrderReturnRequest(input: {
    orderId: string;
    requestType?: 'cancel' | 'return';
    decision: 'approved' | 'rejected';
    note?: string;
  }): Promise<OrderWithItems | null>;
  collectOrderPayment(input: {
    orderId: string;
    actorUserId?: string | null;
    note?: string;
  }): Promise<OrderWithItems | null>;

  // Customer account preferences, addresses, payment methods, wishlist, notifications, rewards
  listCustomerAddresses(userId: string): Promise<CustomerAddressRow[]>;
  upsertCustomerAddress(
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
  ): Promise<CustomerAddressRow>;
  deleteCustomerAddress(userId: string, addressId: string): Promise<boolean>;
  listCustomerPaymentMethods(userId: string): Promise<CustomerPaymentMethodRow[]>;
  upsertCustomerPaymentMethod(
    userId: string,
    input: {
      id?: string;
      methodType: 'card' | 'upi' | 'wallet';
      label: string;
      last4?: string | null;
      network?: string | null;
      expiry?: string | null;
    }
  ): Promise<CustomerPaymentMethodRow>;
  deleteCustomerPaymentMethod(userId: string, methodId: string): Promise<boolean>;
  getCustomerWishlist(userId: string): Promise<string[]>;
  setCustomerWishlist(userId: string, productIds: string[]): Promise<string[]>;
  listCustomerNotifications(userId: string): Promise<CustomerNotificationRow[]>;
  createCustomerNotification(input: {
    id?: string;
    userId: string;
    type: CustomerNotificationRow['type'];
    title: string;
    message: string;
    orderId?: string | null;
    orderNumber?: string | null;
  }): Promise<CustomerNotificationRow>;
  markCustomerNotificationRead(userId: string, notificationId: string): Promise<boolean>;
  markAllCustomerNotificationsRead(userId: string): Promise<void>;
  deleteCustomerNotification(userId: string, notificationId: string): Promise<boolean>;

  // Coupons, gift cards & loyalty
  listCoupons(activeOnly?: boolean): Promise<CouponRow[]>;
  getCouponByCode(code: string): Promise<CouponRow | null>;
  upsertCoupon(input: {
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
  }): Promise<CouponRow>;
  deleteCoupon(id: string): Promise<boolean>;
  listGiftCards(): Promise<GiftCardRow[]>;
  getGiftCardByCode(code: string): Promise<GiftCardRow | null>;
  upsertGiftCard(input: {
    id?: string;
    code: string;
    recipientEmail?: string;
    note?: string;
    initialBalancePaise: number;
    balancePaise: number;
    active: boolean;
    expiresAt?: number | null;
  }): Promise<GiftCardRow>;
  deleteGiftCard(id: string): Promise<boolean>;
  getLoyaltyConfig(): Promise<LoyaltyConfigData>;
  saveLoyaltyConfig(config: LoyaltyConfigData): Promise<LoyaltyConfigData>;
  listUsersSummary(): Promise<StoreUserSummary[]>;

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
