export type CollectionCategory = string;

export interface ProductColor {
  id?: string;
  name: string;
  hex: string;
  thumbnailUrl?: string | null;
  position?: number;
  active?: boolean;
}

export interface ProductImage {
  id?: string;
  src: string;
  alt: string;
  isCover?: boolean;
  colorId?: string | null;
  position?: number;
}

export interface ProductVariant {
  id: string;
  sku: string;
  size: string;
  colorId?: string | null;
  colorName: string;
  colorHex: string;
  pricePaise: number;
  priceOverridePaise?: number | null;
  compareAtPaise: number | null;
  stockQty: number;
  active?: boolean;
  position: number;
}

export interface Product {
  id: string;
  slug?: string;
  name: string;
  category: CollectionCategory;
  /** Starting / selling price in Indian Rupees (INR). */
  price: number;
  pricePaise?: number;
  compareAtPrice?: number | null;
  compareAtPaise?: number | null;
  description: string;
  fabricNote: string;
  includedPieces?: string;
  careNote?: string;
  stockQty?: number;
  lowStockThreshold?: number;
  inStock?: boolean;
  images: ProductImage[];
  colors: ProductColor[];
  sizes: string[];
  variants?: ProductVariant[];
  featured: boolean;
  /** ISO date string (YYYY-MM-DD) used for sorting by newest */
  dateAdded: string;
  updatedAt?: number;
}

export interface BagItem {
  productId: string;
  variantId: string;
  quantity: number;
  seenPricePaise: number;
  fallbackTitle: string;
  fallbackVariant: string;
  fallbackImage: string;
  fallbackColorName?: string;
  fallbackSize?: string;
  fallbackSku?: string;
}

export interface ValidatedBagItem {
  productId: string;
  variantId: string | null;
  requestedQty: number;
  availableQty: number;
  available: boolean;
  statusReason: string | null;
  priceChanged: boolean;
  previousPricePaise: number | null;
  currentPricePaise: number | null;
  lineTotalPaise: number;
  title: string;
  variantLabel: string;
  colorName?: string;
  size?: string;
  sku?: string;
  imageUrl: string;
}

export interface BagValidationResult {
  items: ValidatedBagItem[];
  subtotalPaise: number;
  hasUnavailable: boolean;
  hasPriceChanges: boolean;
}

export type OrderPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded';
export type OrderFulfillmentStatus =
  | 'pending'
  | 'placed'
  | 'confirmed'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'return_requested'
  | 'returned'
  | 'unknown';

export type OrderRefundStatus =
  | 'none'
  | 'not_required'
  | 'pending_refund'
  | 'refund_initiated'
  | 'refunded';

export interface OrderStatusHistoryEntry {
  status: string;
  note?: string;
  actor: 'customer' | 'owner' | 'system';
  at: number;
}

export type OrderRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface OrderReturnRequest {
  id: string;
  type: 'cancel' | 'return';
  reason: string;
  status: OrderRequestStatus;
  requestedAt: number;
  updatedAt?: number;
  resolvedAt?: number | null;
  resolutionNote?: string;
}

export interface NotificationPreferences {
  orderUpdates: boolean;
  cancelReturnUpdates: boolean;
  promotions: boolean;
  emailEnabled: boolean;
  smsWhatsappEnabled: boolean;
}

export interface PlacedOrderReceipt {
  id: string;
  orderNumber: string;
  customerUserId?: string | null;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  shippingAddress?: string;
  status: string;
  paymentStatus?: OrderPaymentStatus;
  refundStatus?: OrderRefundStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  statusHistory?: OrderStatusHistoryEntry[];
  subtotalPaise: number;
  discountPaise?: number;
  giftCardPaise?: number;
  totalPaise: number;
  couponCode?: string | null;
  giftCardCode?: string | null;
  currency: string;
  createdAt: number;
  updatedAt?: number;
  paymentMethod?: 'razorpay' | 'cod';
  paymentCollectedAt?: number | null;
  idempotencyKey?: string | null;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  cancelledAt?: number | null;
  cancelledBy?: 'customer' | 'owner' | 'system' | null;
  cancelReason?: string | null;
  cancelRequest?: OrderReturnRequest | null;
  returnRequest?: OrderReturnRequest | null;
  hiddenByCustomer?: boolean;
  hiddenAt?: number | null;
  deliveryDetailsEditedAt?: number | null;
  stockRestoredAt?: number | null;
  needsAdminReview?: boolean;
  legacyCollisionNote?: string | null;
  items: Array<{
    productId: string;
    variantId: string;
    productTitle: string;
    variantLabel: string;
    colorName?: string;
    size?: string;
    imageUrl?: string;
    sku: string;
    unitPricePaise: number;
    quantity: number;
    lineTotalPaise: number;
  }>;
}

export interface CustomerAddress {
  id: string;
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
  createdAt: number;
  updatedAt: number;
}

export interface CustomerNotification {
  id: string;
  type: 'order_placed' | 'order_status' | 'request_update' | 'account' | 'offer';
  title: string;
  message: string;
  orderId?: string | null;
  orderNumber?: string | null;
  read: boolean;
  readAt?: number | null;
  createdAt: number;
}

export interface BoutiqueCoupon {
  id: string;
  code: string;
  title: string;
  description: string;
  discountType: 'percent' | 'flat_paise';
  discountValue: number;
  maxDiscountPaise?: number | null;
  minSpendPaise: number;
  usageLimit?: number | null;
  usedCount: number;
  active: boolean;
  startsAt?: number | null;
  expiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BoutiqueGiftCard {
  id: string;
  code: string;
  recipientEmail?: string;
  note?: string;
  initialBalancePaise: number;
  balancePaise: number;
  active: boolean;
  expiresAt?: number | null;
  lastUsedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LoyaltyConfig {
  rewardsEnabled: boolean;
  pointsPerHundredInr: number;
  rupeeValuePerPointPaise: number;
  plusEnabled: boolean;
  plusTierName: string;
  plusQualificationSpendPaise: number;
  plusBenefits: string[];
  giftCardsEnabled: boolean;
}

export interface CustomerRewardsSummary {
  config: LoyaltyConfig;
  pointsBalance: number;
  lifetimeEarnedPoints: number;
  lifetimeSpendPaise: number;
  deliveredOrdersCount: number;
  isPlusMember: boolean;
  plusStatusLabel: string;
  plusProgressPaise: number;
}

export interface CustomerPaymentMethod {
  id: string;
  methodType: 'card' | 'upi' | 'wallet';
  label: string;
  last4?: string;
  network?: string;
  expiry?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SavedPaymentMethodsSummary {
  enabled: boolean;
  provider: 'razorpay';
  reason: string;
  methods: CustomerPaymentMethod[];
}

export interface StoreActivityEvent {
  id: string;
  type: 'registration' | 'order' | 'enquiry' | 'return_request' | 'coupon_redemption' | 'gift_card';
  title: string;
  detail: string;
  actorLabel: string;
  refId?: string;
  status?: string;
  createdAt: number;
}

export type AdminProductStatus = 'draft' | 'published' | 'archived';

export interface AdminProductImage {
  id: string;
  url: string;
  alt: string;
  isCover: boolean;
  colorId?: string | null;
  position: number;
}

export interface AdminProduct extends Product {
  sku: string;
  status: AdminProductStatus;
  importKey?: string | null;
  sourceImageFilename?: string | null;
  pendingFields?: string[];
  catalogBatch?: string | null;
  version: number;
  publishedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  orderCount: number;
  rawImages: AdminProductImage[];
}

export interface AdminOverviewMetrics {
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
}

export interface AdminAuditEntry {
  id: string;
  productId: string;
  productTitle: string;
  actorUserId?: string;
  action: string;
  summary: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  createdAt: number;
}

export interface AdminOrder {
  id: string;
  orderNumber: string;
  customerUserId?: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  status: string;
  paymentStatus?: OrderPaymentStatus;
  refundStatus?: OrderRefundStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  paymentMethod?: 'razorpay' | 'cod';
  paymentCollectedAt?: number | null;
  idempotencyKey?: string | null;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  couponCode?: string | null;
  giftCardCode?: string | null;
  discountPaise?: number;
  giftCardPaise?: number;
  subtotalPaise: number;
  totalPaise: number;
  currency: string;
  statusHistory?: OrderStatusHistoryEntry[];
  cancelledAt?: number | null;
  cancelledBy?: 'customer' | 'owner' | 'system' | null;
  cancelReason?: string | null;
  cancelRequest?: OrderReturnRequest | null;
  returnRequest?: OrderReturnRequest | null;
  hiddenByCustomer?: boolean;
  hiddenAt?: number | null;
  deliveryDetailsEditedAt?: number | null;
  stockRestoredAt?: number | null;
  needsAdminReview?: boolean;
  legacyCollisionNote?: string | null;
  createdAt: number;
  updatedAt?: number;
  items: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    productTitle: string;
    variantLabel: string;
    colorName?: string;
    size?: string;
    imageUrl?: string;
    sku: string;
    unitPricePaise: number;
    quantity: number;
    lineTotalPaise: number;
  }>;
}

export interface AdminCustomerAccountSummary {
  id: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  phone?: string | null;
  verifiedPhone?: string | null;
  phoneVerified?: boolean;
  notificationPrefs?: NotificationPreferences;
  addresses?: CustomerAddress[];
  createdAt: number;
  updatedAt?: number;
}

export type ContactMessageStatus = 'unread' | 'read' | 'replied' | 'archived';

export interface ContactMessage {
  id: string;
  senderName: string;
  senderEmail: string;
  senderPhone: string;
  subject: string;
  message: string;
  status: ContactMessageStatus;
  adminNote: string;
  createdAt: number;
  updatedAt: number;
}

export interface AdminOverviewResponse {
  metrics: AdminOverviewMetrics;
  lowStockItems: AdminProduct[];
  recentOrders: AdminOrder[];
  recentMessages: ContactMessage[];
  recentAuditLogs: AdminAuditEntry[];
}

export interface StorefrontCategory {
  id: string;
  name: string;
  slug: string;
  subtitle: string;
  imageUrl: string;
  altText: string;
  position: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface CollectionItem {
  id: string;
  category: CollectionCategory;
  subtitle: string;
  image: string;
  alt: string;
}

export interface LookbookEntry {
  id: string;
  title: string;
  caption: string;
  category: CollectionCategory;
  image: string;
  alt: string;
  layout: 'tall' | 'wide' | 'square';
}

export interface ContactConfig {
  whatsappNumber: string;
  instagramHandle: string;
  email: string;
  storeAddress: string;
  hoursNote: string;
}

export interface SiteSettings {
  brandName: string;
  tagline: string;
  logoUrl: string;
  contact: ContactConfig;
  socialLinks: {
    instagramUrl: string;
    facebookUrl: string;
    pinterestUrl: string;
    youtubeUrl: string;
  };
}

export interface StorefrontContent {
  hero: {
    eyebrow: string;
    headline: string;
    supportingText: string;
    primaryCta: string;
    secondaryCta: string;
    floatingLabels: [string, string];
    mainImage: {
      src: string;
      alt: string;
    };
    accentCutouts: Array<{
      src: string;
      alt: string;
      caption: string;
    }>;
  };
  collectionsHeader: {
    kicker: string;
    heading: string;
    subtitle: string;
  };
  showcaseHeader: {
    kicker: string;
    heading: string;
    subtitle: string;
  };
  spotlightEdit: {
    kicker: string;
    title: string;
    subtitle: string;
    description: string;
    ctaLabel: string;
    targetCategory: string;
    image: {
      src: string;
      alt: string;
    };
  };
  lookbookHeader: {
    kicker: string;
    heading: string;
    subtitle: string;
  };
  lookbookEntries: LookbookEntry[];
  about: {
    kicker: string;
    heading: string;
    paragraphs: string[];
    pillars: Array<{
      title: string;
      detail: string;
    }>;
    image: {
      src: string;
      alt: string;
    };
  };
}
