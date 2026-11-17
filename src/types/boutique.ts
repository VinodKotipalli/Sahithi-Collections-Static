export type CollectionCategory = string;

export interface ProductColor {
  name: string;
  hex: string;
}

export interface ProductImage {
  src: string;
  alt: string;
  isCover?: boolean;
}

export interface ProductVariant {
  id: string;
  sku: string;
  size: string;
  colorName: string;
  colorHex: string;
  pricePaise: number;
  compareAtPaise: number | null;
  stockQty: number;
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
  imageUrl: string;
}

export interface BagValidationResult {
  items: ValidatedBagItem[];
  subtotalPaise: number;
  hasUnavailable: boolean;
  hasPriceChanges: boolean;
}

export interface PlacedOrderReceipt {
  id: string;
  orderNumber: string;
  status: string;
  subtotalPaise: number;
  totalPaise: number;
  currency: string;
  createdAt: number;
  paymentMethod?: 'razorpay' | 'cod';
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  items: Array<{
    productId: string;
    variantId: string;
    productTitle: string;
    variantLabel: string;
    sku: string;
    unitPricePaise: number;
    quantity: number;
    lineTotalPaise: number;
  }>;
}

export type AdminProductStatus = 'draft' | 'published' | 'archived';

export interface AdminProductImage {
  id: string;
  url: string;
  alt: string;
  isCover: boolean;
  position: number;
}

export interface AdminProduct extends Product {
  sku: string;
  status: AdminProductStatus;
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
  totalRevenuePaise: number;
  unreadMessages: number;
  totalMessages: number;
  totalAuditEvents: number;
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
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  status: string;
  subtotalPaise: number;
  totalPaise: number;
  currency: string;
  createdAt: number;
  items: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    productTitle: string;
    variantLabel: string;
    sku: string;
    unitPricePaise: number;
    quantity: number;
    lineTotalPaise: number;
  }>;
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
