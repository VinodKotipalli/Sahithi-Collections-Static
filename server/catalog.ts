import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import express from 'express';
import multer from 'multer';
import {
  handleCreateOrderRequest,
  handleOrderStatusRequest,
  handleRazorpayWebhookRequest,
  handleRecoverRazorpayOrder,
  handleVerifyPaymentRequest,
  validatePromoAndGiftCardForBag,
  verifyBearerFirebaseTokenFromHeader,
  type RazorpayClientFactory,
} from './razorpay-checkout.ts';
import {
  handleWhatsAppStylistRequest,
  handleWhatsAppWebhookGet,
  handleWhatsAppWebhookPost,
  type GeminiClientFactory,
} from './whatsapp-ai.ts';
import {
  StoreHttpError,
  type AdminProductRecord,
  type BoutiqueStore,
  type CategoryRow,
  type ContactMessageRow,
  type ContactMessageStatus,
  type CouponRow,
  type CustomerAddressRow,
  type CustomerNotificationRow,
  type GiftCardRow,
  type LoyaltyConfigData,
  type OrderWithItems,
  type ProductStatus,
  type ProductVariantRow,
  type ProductWithParts,
  type SessionRow,
  type SiteSettingsData,
  type StorefrontContentData,
  type UserRow,
} from './store.ts';
import { FirestoreRestStore } from './firebase-rest.ts';
import {
  mergeSiteSettings,
  mergeStorefrontContent,
} from './storefront-defaults.ts';

export const ALLOWED_CATEGORIES = [
  'Kurtis',
  'Kurta Sets',
  'Sarees',
  'Co-ord Sets',
  'Dupattas',
  'Ethnic Wear',
  'Western Wear',
  'Dresses',
  'Festive Collection',
  'Accessories',
] as const;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_UPLOAD_FILES_PER_REQUEST = 6;
const MIN_PRICE_PAISE = 100; // ₹1.00
const MAX_PRICE_PAISE = 100_000_000; // ₹10,00,000

const SAFE_MEDIA_URL_REGEX = /^\/(api\/media|boutique-media)\/[a-zA-Z0-9._-]+$/;
const SAFE_HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

export interface AuthedCatalogRequest extends Request {
  requestId?: string;
  authSession?: SessionRow;
  authUser?: UserRow;
  rawBody?: string;
}

export interface ProductColorDTO {
  name: string;
  hex: string;
}

export interface ProductImageDTO {
  id: string;
  url: string;
  alt: string;
  isCover: boolean;
  position: number;
}

export interface ProductVariantDTO {
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

export interface PublicProductDTO {
  id: string;
  slug: string;
  name: string;
  category: string;
  pricePaise: number;
  compareAtPaise: number | null;
  price: number;
  compareAtPrice: number | null;
  description: string;
  fabricNote: string;
  stockQty: number;
  lowStockThreshold: number;
  inStock: boolean;
  images: Array<{ src: string; alt: string; isCover: boolean }>;
  colors: ProductColorDTO[];
  sizes: string[];
  variants: ProductVariantDTO[];
  featured: boolean;
  dateAdded: string;
  updatedAt: number;
}

export interface AdminProductDTO extends PublicProductDTO {
  sku: string;
  status: ProductStatus;
  version: number;
  publishedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  orderCount: number;
  rawImages: ProductImageDTO[];
}

function sendJsonError(
  req: AuthedCatalogRequest,
  res: Response,
  status: number,
  code: string,
  error: string,
  fieldErrors?: Record<string, string>
) {
  const isSpaClient = req.get('x-sahithi-client') === 'web-spa';
  const wireStatus =
    isSpaClient && status === 403
      ? 400
      : isSpaClient && (status === 502 || status === 503 || status === 504)
        ? 500
        : status;
  if (wireStatus !== status) {
    res.setHeader('X-Sahithi-Original-Status', String(status));
  }
  return res.status(wireStatus).json({
    status,
    code,
    error,
    requestId: req.requestId,
    ...(fieldErrors && Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
  });
}

export async function isRequestBoundOwner(
  req: AuthedCatalogRequest,
  store: BoutiqueStore
): Promise<boolean> {
  if (!req.authSession || !req.authUser || !req.authUser.email_verified) {
    return false;
  }
  if (store instanceof FirestoreRestStore) {
    if ((req.authUser.email || '').toLowerCase() !== store.ownerEmail) {
      return false;
    }
    const bound = await store.resolveBoundOwner().catch((err) => {
      console.error('[catalog] resolveBoundOwner check failed:', err);
      throw err;
    });
    return !bound || bound.owner_user_id === req.authUser.id;
  }
  const bound = await store.resolveBoundOwner();
  if (!bound) return false;
  return req.authUser.id === bound.owner_user_id;
}

export function detectImageFormat(
  buf: Uint8Array
): { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' } | null {
  if (!buf || buf.length < 12) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }

  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mimeType: 'image/png', ext: 'png' };
  }

  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }

  return null;
}

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function serializePublicProduct(record: ProductWithParts): PublicProductDTO {
  const { product: row, variants, images } = record;
  const totalStock =
    variants.length > 0 ? variants.reduce((sum, v) => sum + v.stock_qty, 0) : row.stock_qty;
  const effectivePricePaise =
    variants.length > 0 ? Math.min(...variants.map((v) => v.price_paise)) : row.price_paise;
  const minVariant =
    variants.find((v) => v.price_paise === effectivePricePaise) || variants[0] || null;
  const effectiveComparePaise = minVariant ? minVariant.compare_at_paise : row.compare_at_paise;

  const colors = parseJsonSafe<ProductColorDTO[]>(row.colors_json, []);
  const sizes = parseJsonSafe<string[]>(row.sizes_json, []);
  const dateSource = row.published_at || row.created_at;
  const dateAdded = new Date(dateSource).toISOString().slice(0, 10);

  return {
    id: row.id,
    slug: row.slug,
    name: row.title,
    category: row.category || 'Dresses',
    pricePaise: effectivePricePaise,
    compareAtPaise: effectiveComparePaise,
    price: Number((effectivePricePaise / 100).toFixed(2)),
    compareAtPrice:
      effectiveComparePaise !== null ? Number((effectiveComparePaise / 100).toFixed(2)) : null,
    description: row.description,
    fabricNote: row.fabric_note,
    stockQty: totalStock,
    lowStockThreshold: row.low_stock_threshold,
    inStock: totalStock > 0,
    images: images.map((img) => ({
      src: img.url,
      alt: img.alt_text || row.title,
      isCover: Boolean(img.is_cover),
    })),
    colors,
    sizes,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      size: v.size,
      colorName: v.color_name,
      colorHex: v.color_hex,
      pricePaise: v.price_paise,
      compareAtPaise: v.compare_at_paise,
      stockQty: v.stock_qty,
      position: v.position,
    })),
    featured: Boolean(row.featured),
    dateAdded,
    updatedAt: row.updated_at,
  };
}

function serializeAdminProduct(record: AdminProductRecord): AdminProductDTO {
  const pub = serializePublicProduct(record);
  const { product: row, images, orderCount } = record;
  return {
    ...pub,
    sku: row.sku,
    status: row.status,
    version: row.version,
    publishedAt: row.published_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    orderCount,
    rawImages: images.map((img) => ({
      id: img.id,
      url: img.url,
      alt: img.alt_text,
      isCover: Boolean(img.is_cover),
      position: img.position,
    })),
  };
}

function parsePaiseField(
  value: unknown,
  fieldName: string
): { ok: true; paise: number } | { ok: false; error: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `${fieldName} must be a valid number.` };
  }
  const rounded = Math.round(value);
  if (rounded !== value) {
    return { ok: false, error: `${fieldName} must be provided in whole integer paise.` };
  }
  if (rounded < MIN_PRICE_PAISE || rounded > MAX_PRICE_PAISE) {
    return {
      ok: false,
      error: `${fieldName} must be between ₹${(MIN_PRICE_PAISE / 100).toFixed(0)} and ₹${(
        MAX_PRICE_PAISE / 100
      ).toLocaleString('en-IN')}.`,
    };
  }
  return { ok: true, paise: rounded };
}

function serializeCategory(cat: CategoryRow) {
  return {
    id: cat.id,
    name: cat.name,
    slug: cat.slug,
    subtitle: cat.subtitle,
    imageUrl: cat.image_url,
    altText: cat.alt_text,
    position: cat.position,
    createdAt: cat.created_at,
    updatedAt: cat.updated_at,
  };
}

function serializeOrderWithItems({ order: o, items }: OrderWithItems) {
  const statusHistory = parseJsonSafe<unknown[]>(o.status_history_json || '', []);
  const returnRequest = parseJsonSafe<unknown | null>(o.return_request_json || '', null);
  const paymentStatus = o.payment_status || 'pending';
  const fulfillmentStatus =
    o.fulfillment_status || (o.status === 'paid' ? 'confirmed' : o.status);

  return {
    id: o.id,
    orderNumber: o.order_number,
    customerUserId: o.customer_user_id ?? null,
    customerName: o.customer_name,
    customerEmail: o.customer_email,
    customerPhone: o.customer_phone,
    shippingAddress: o.shipping_address,
    status: o.status,
    paymentStatus,
    fulfillmentStatus,
    paymentMethod: (o.payment_method as 'razorpay' | 'cod') || (o.razorpay_order_id ? 'razorpay' : 'cod'),
    razorpayOrderId: o.razorpay_order_id ?? null,
    razorpayPaymentId: o.razorpay_payment_id ?? null,
    couponCode: o.coupon_code ?? null,
    giftCardCode: o.gift_card_code ?? null,
    discountPaise: o.discount_paise || 0,
    giftCardPaise: o.gift_card_paise || 0,
    subtotalPaise: o.subtotal_paise,
    totalPaise: o.total_paise,
    subtotal: Number((o.subtotal_paise / 100).toFixed(2)),
    total: Number((o.total_paise / 100).toFixed(2)),
    currency: o.currency,
    statusHistory: Array.isArray(statusHistory) ? statusHistory : [],
    returnRequest: returnRequest && typeof returnRequest === 'object' ? returnRequest : null,
    createdAt: o.created_at,
    updatedAt: o.updated_at ?? o.created_at,
    items: items.map((it) => ({
      id: it.id,
      productId: it.product_id,
      variantId: it.variant_id,
      productTitle: it.product_title,
      variantLabel: it.variant_label,
      sku: it.sku,
      unitPricePaise: it.unit_price_paise,
      quantity: it.quantity,
      lineTotalPaise: it.line_total_paise,
    })),
  };
}

function serializeCouponRow(c: CouponRow) {
  return {
    id: c.id,
    code: c.code,
    title: c.title,
    description: c.description,
    discountType: c.discount_type,
    discountValue: c.discount_value,
    maxDiscountPaise: c.max_discount_paise,
    minSpendPaise: c.min_spend_paise,
    usageLimit: c.usage_limit,
    usedCount: c.used_count,
    active: Boolean(c.active),
    startsAt: c.starts_at,
    expiresAt: c.expires_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function serializeGiftCardRow(g: GiftCardRow) {
  return {
    id: g.id,
    code: g.code,
    recipientEmail: g.recipient_email,
    note: g.note,
    initialBalancePaise: g.initial_balance_paise,
    balancePaise: g.balance_paise,
    active: Boolean(g.active),
    expiresAt: g.expires_at,
    lastUsedAt: g.last_used_at,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

function serializeCustomerAddress(a: CustomerAddressRow) {
  return {
    id: a.id,
    fullName: a.full_name,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    landmark: a.landmark,
    label: a.label,
    isDefault: Boolean(a.is_default),
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

function serializeCustomerNotification(n: CustomerNotificationRow) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    orderId: n.order_id,
    orderNumber: n.order_number,
    read: Boolean(n.is_read),
    readAt: n.read_at,
    createdAt: n.created_at,
  };
}

function serializeContactMessage(m: ContactMessageRow) {
  return {
    id: m.id,
    senderName: m.sender_name,
    senderEmail: m.sender_email,
    senderPhone: m.sender_phone,
    subject: m.subject,
    message: m.message,
    status: m.status,
    adminNote: m.admin_note,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

function isSafeHttpUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function verifySafeImageReference(
  store: BoutiqueStore,
  rawUrl: string
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const url = rawUrl.trim();
  if (!url) return { ok: true, url: '' };
  if (!SAFE_MEDIA_URL_REGEX.test(url)) {
    return {
      ok: false,
      error: 'Image URLs must reference built-in boutique media or an uploaded image from the media uploader.',
    };
  }
  if (url.startsWith('/api/media/')) {
    const filename = url.slice('/api/media/'.length);
    const mediaRow = await store.findMediaByFilename(filename);
    if (!mediaRow) {
      return {
        ok: false,
        error: `Uploaded image "${filename}" was not found in media storage.`,
      };
    }
  }
  return { ok: true, url };
}

interface ParsedProductPayload {
  title: string;
  description: string;
  fabricNote: string;
  category: string;
  sku: string;
  pricePaise: number;
  compareAtPaise: number | null;
  lowStockThreshold: number;
  featured: boolean;
  status: 'draft' | 'published';
  colors: ProductColorDTO[];
  sizes: string[];
  variants: ProductVariantDTO[];
  images: Array<{ url: string; alt: string; isCover: boolean; mediaId: string | null }>;
}

async function validateAndNormalizeProductInput(
  store: BoutiqueStore,
  body: Record<string, unknown>,
  existingProductId?: string
): Promise<
  | { ok: true; data: ParsedProductPayload }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }
> {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < 2 || title.length > 140) {
    const msg = 'Product title must be between 2 and 140 characters.';
    return { ok: false, error: msg, fieldErrors: { title: msg } };
  }

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < 10 || description.length > 2500) {
    const msg = 'Product description must be between 10 and 2500 characters.';
    return { ok: false, error: msg, fieldErrors: { description: msg } };
  }

  const fabricNote = typeof body.fabricNote === 'string' ? body.fabricNote.trim().slice(0, 240) : '';

  const categoryRaw = typeof body.category === 'string' ? body.category.trim() : '';
  const availableCategories = await store.listCategories();
  const matchedCat = availableCategories.find(
    (c) => c.name.toLowerCase() === categoryRaw.toLowerCase()
  );
  if (!matchedCat) {
    const msg = 'Please select a valid boutique collection category.';
    return { ok: false, error: msg, fieldErrors: { category: msg } };
  }
  const category = matchedCat.name;

  const rawSku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : '';
  const sku = rawSku || `SC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  if (!/^[A-Z0-9][A-Z0-9_-]{1,47}$/.test(sku)) {
    const msg = 'SKU must be 2–48 uppercase alphanumeric characters, hyphens, or underscores.';
    return {
      ok: false,
      error: msg,
      fieldErrors: { sku: msg },
    };
  }

  if (await store.isProductSkuConflict(sku, existingProductId)) {
    const msg = `SKU "${sku}" is already assigned to another product.`;
    return { ok: false, error: msg, fieldErrors: { sku: msg } };
  }

  let basePricePaise: number;
  if (body.pricePaise !== undefined) {
    const parsed = parsePaiseField(body.pricePaise, 'Selling price');
    if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { price: parsed.error } };
    basePricePaise = parsed.paise;
  } else if (
    body.priceInr !== undefined &&
    typeof body.priceInr === 'number' &&
    Number.isFinite(body.priceInr)
  ) {
    const parsed = parsePaiseField(Math.round(body.priceInr * 100), 'Selling price');
    if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { price: parsed.error } };
    basePricePaise = parsed.paise;
  } else {
    const msg = 'A valid selling price in INR is required.';
    return { ok: false, error: msg, fieldErrors: { price: msg } };
  }

  let baseCompareAtPaise: number | null = null;
  if (body.compareAtPaise !== undefined && body.compareAtPaise !== null) {
    const parsed = parsePaiseField(body.compareAtPaise, 'Compare-at price');
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, fieldErrors: { compareAtPrice: parsed.error } };
    }
    if (parsed.paise <= basePricePaise) {
      const msg = 'Compare-at price must be greater than the selling price.';
      return { ok: false, error: msg, fieldErrors: { compareAtPrice: msg } };
    }
    baseCompareAtPaise = parsed.paise;
  } else if (
    body.compareAtInr !== undefined &&
    body.compareAtInr !== null &&
    body.compareAtInr !== '' &&
    typeof body.compareAtInr === 'number' &&
    Number.isFinite(body.compareAtInr) &&
    body.compareAtInr > 0
  ) {
    const parsed = parsePaiseField(Math.round(body.compareAtInr * 100), 'Compare-at price');
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, fieldErrors: { compareAtPrice: parsed.error } };
    }
    if (parsed.paise <= basePricePaise) {
      const msg = 'Compare-at price must be greater than the selling price.';
      return { ok: false, error: msg, fieldErrors: { compareAtPrice: msg } };
    }
    baseCompareAtPaise = parsed.paise;
  }

  const lowStockThreshold =
    typeof body.lowStockThreshold === 'number' &&
    Number.isInteger(body.lowStockThreshold) &&
    body.lowStockThreshold >= 0 &&
    body.lowStockThreshold <= 500
      ? body.lowStockThreshold
      : 5;

  const featured = Boolean(body.featured);
  const requestedStatus = body.status === 'published' ? 'published' : 'draft';

  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > 12) {
    return { ok: false, error: 'A maximum of 12 product images is allowed.' };
  }

  const normalizedImages: Array<{
    url: string;
    alt: string;
    isCover: boolean;
    mediaId: string | null;
  }> = [];
  for (let i = 0; i < rawImages.length; i++) {
    const item = rawImages[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Invalid image entry in gallery.' };
    }
    const obj = item as Record<string, unknown>;
    const rawUrl =
      typeof obj.url === 'string'
        ? obj.url.trim()
        : typeof obj.src === 'string'
          ? obj.src.trim()
          : '';
    if (!SAFE_MEDIA_URL_REGEX.test(rawUrl)) {
      return {
        ok: false,
        error: 'Product image URLs must be uploaded through the atelier media uploader.',
      };
    }

    let mediaId: string | null = null;
    if (rawUrl.startsWith('/api/media/')) {
      const filename = rawUrl.slice('/api/media/'.length);
      const mediaRow = await store.findMediaByFilename(filename);
      if (!mediaRow) {
        return {
          ok: false,
          error: `Uploaded image "${filename}" was not found in media storage.`,
        };
      }
      mediaId = mediaRow.id;
    }

    const alt = typeof obj.alt === 'string' ? obj.alt.trim().slice(0, 200) : '';
    normalizedImages.push({
      url: rawUrl,
      alt: alt || title,
      isCover: Boolean(obj.isCover),
      mediaId,
    });
  }

  if (normalizedImages.length > 0 && !normalizedImages.some((img) => img.isCover)) {
    normalizedImages[0].isCover = true;
  } else if (normalizedImages.filter((img) => img.isCover).length > 1) {
    let foundFirst = false;
    for (const img of normalizedImages) {
      if (img.isCover && !foundFirst) {
        foundFirst = true;
      } else {
        img.isCover = false;
      }
    }
  }

  if (requestedStatus === 'published' && normalizedImages.length === 0) {
    const msg = 'Upload or attach at least one product photo before publishing.';
    return {
      ok: false,
      error: msg,
      fieldErrors: { images: msg },
    };
  }

  const rawVariants = Array.isArray(body.variants) ? body.variants : [];
  const normalizedVariants: ProductVariantDTO[] = [];
  const seenVariantSkus = new Set<string>();
  const seenVariantCombos = new Set<string>();

  if (rawVariants.length > 0) {
    if (rawVariants.length > 60) {
      const msg = 'A product may have at most 60 size/color variants.';
      return { ok: false, error: msg, fieldErrors: { variants: msg } };
    }

    for (let i = 0; i < rawVariants.length; i++) {
      const rv = rawVariants[i];
      if (!rv || typeof rv !== 'object') {
        const msg = 'Invalid variant entry.';
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      const vObj = rv as Record<string, unknown>;
      const size = typeof vObj.size === 'string' ? vObj.size.trim().slice(0, 32) : '';
      const colorName =
        typeof vObj.colorName === 'string' ? vObj.colorName.trim().slice(0, 48) : '';
      const colorHex = typeof vObj.colorHex === 'string' ? vObj.colorHex.trim() : '#49243E';
      if (!size || !colorName) {
        const msg = 'Each variant must specify both a size and a color name.';
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      if (!SAFE_HEX_REGEX.test(colorHex)) {
        const msg = `Color hex for ${colorName} must be a 6-digit hex code (e.g. #49243E).`;
        return {
          ok: false,
          error: msg,
          fieldErrors: { variants: msg },
        };
      }

      const comboKey = `${size.toLowerCase()}::${colorName.toLowerCase()}`;
      if (seenVariantCombos.has(comboKey)) {
        const msg = `Duplicate variant for size "${size}" and color "${colorName}".`;
        return {
          ok: false,
          error: msg,
          fieldErrors: { variants: msg },
        };
      }
      seenVariantCombos.add(comboKey);

      const vSkuRaw = typeof vObj.sku === 'string' ? vObj.sku.trim().toUpperCase() : '';
      const vSku =
        vSkuRaw ||
        `${sku}-${size.replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase() || 'SZ'}-${i + 1}`;
      if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(vSku)) {
        const msg = `Variant SKU "${vSku}" contains invalid characters.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      if (seenVariantSkus.has(vSku)) {
        const msg = `Duplicate variant SKU "${vSku}" within this product.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }
      seenVariantSkus.add(vSku);

      if (await store.isVariantSkuConflict(vSku, existingProductId)) {
        const msg = `Variant SKU "${vSku}" is already used by another product.`;
        return { ok: false, error: msg, fieldErrors: { variants: msg } };
      }

      let vPricePaise = basePricePaise;
      if (vObj.pricePaise !== undefined) {
        const parsed = parsePaiseField(vObj.pricePaise, `Price for ${size} / ${colorName}`);
        if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { variants: parsed.error } };
        vPricePaise = parsed.paise;
      }

      let vComparePaise: number | null = baseCompareAtPaise;
      if (vObj.compareAtPaise !== undefined) {
        if (vObj.compareAtPaise === null) {
          vComparePaise = null;
        } else {
          const parsed = parsePaiseField(
            vObj.compareAtPaise,
            `Compare-at price for ${size} / ${colorName}`
          );
          if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { variants: parsed.error } };
          if (parsed.paise <= vPricePaise) {
            const msg = `Compare-at price for ${size} / ${colorName} must exceed its selling price.`;
            return {
              ok: false,
              error: msg,
              fieldErrors: { variants: msg },
            };
          }
          vComparePaise = parsed.paise;
        }
      } else if (vComparePaise !== null && vComparePaise <= vPricePaise) {
        vComparePaise = null;
      }

      const stockRaw = vObj.stockQty;
      if (
        typeof stockRaw !== 'number' ||
        !Number.isInteger(stockRaw) ||
        stockRaw < 0 ||
        stockRaw > 100_000
      ) {
        const msg = `Stock quantity for ${size} / ${colorName} must be an integer between 0 and 100,000.`;
        return {
          ok: false,
          error: msg,
          fieldErrors: { variants: msg },
        };
      }

      normalizedVariants.push({
        id:
          typeof vObj.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(vObj.id)
            ? vObj.id
            : crypto.randomUUID(),
        sku: vSku,
        size,
        colorName,
        colorHex,
        pricePaise: vPricePaise,
        compareAtPaise: vComparePaise,
        stockQty: stockRaw,
        position: i,
      });
    }
  } else {
    const inputSizes = Array.isArray(body.sizes)
      ? body.sizes
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim().slice(0, 32))
      : ['Free Size'];
    const sizesList = inputSizes.length > 0 ? Array.from(new Set(inputSizes)) : ['Free Size'];

    const inputColors: ProductColorDTO[] = Array.isArray(body.colors)
      ? body.colors
          .filter((c): c is ProductColorDTO => Boolean(c && typeof c === 'object'))
          .map((c) => ({
            name: typeof c.name === 'string' ? c.name.trim().slice(0, 48) : 'Signature',
            hex:
              typeof c.hex === 'string' && SAFE_HEX_REGEX.test(c.hex.trim())
                ? c.hex.trim()
                : '#49243E',
          }))
          .filter((c) => c.name.length > 0)
      : [{ name: 'Signature', hex: '#49243E' }];
    const colorsList =
      inputColors.length > 0 ? inputColors : [{ name: 'Signature', hex: '#49243E' }];

    const rawStockVal =
      typeof body.stockQty === 'number'
        ? body.stockQty
        : typeof body.stock === 'number'
          ? body.stock
          : undefined;
    const singleStock =
      typeof rawStockVal === 'number' &&
      Number.isInteger(rawStockVal) &&
      rawStockVal >= 0 &&
      rawStockVal <= 100_000
        ? rawStockVal
        : 0;

    let idx = 0;
    for (const sz of sizesList) {
      for (const col of colorsList) {
        const vSku = `${sku}-${sz.replace(/[^A-Z0-9]/gi, '').slice(0, 5).toUpperCase() || 'SZ'}-${idx + 1}`;
        normalizedVariants.push({
          id: crypto.randomUUID(),
          sku: vSku,
          size: sz,
          colorName: col.name,
          colorHex: col.hex,
          pricePaise: basePricePaise,
          compareAtPaise: baseCompareAtPaise,
          stockQty: idx === 0 ? singleStock : 0,
          position: idx,
        });
        idx += 1;
      }
    }
  }

  const derivedColorsMap = new Map<string, ProductColorDTO>();
  const derivedSizesSet = new Set<string>();
  for (const v of normalizedVariants) {
    if (!derivedColorsMap.has(v.colorName)) {
      derivedColorsMap.set(v.colorName, { name: v.colorName, hex: v.colorHex });
    }
    derivedSizesSet.add(v.size);
  }

  const lowestPricePaise = Math.min(...normalizedVariants.map((v) => v.pricePaise));
  const lowestVariant = normalizedVariants.find((v) => v.pricePaise === lowestPricePaise);

  return {
    ok: true,
    data: {
      title,
      description,
      fabricNote,
      category,
      sku,
      pricePaise: lowestPricePaise,
      compareAtPaise: lowestVariant?.compareAtPaise ?? null,
      lowStockThreshold,
      featured,
      status: requestedStatus,
      colors: Array.from(derivedColorsMap.values()),
      sizes: Array.from(derivedSizesSet),
      variants: normalizedVariants,
      images: normalizedImages,
    },
  };
}

export function registerCatalogAndAdminRoutes(params: {
  app: Router;
  store: BoutiqueStore;
  authLimiter: RequestHandler;
  adminLoginLimiter?: RequestHandler;
  contactLimiter?: RequestHandler;
  createSessionForUser: (
    req: Request,
    res: Response,
    userId: string
  ) => Promise<{ session: SessionRow }>;
  verifyPassword: (password: string, hash: string | null | undefined) => Promise<boolean>;
  serializePublicUser: (
    user: UserRow,
    session: SessionRow,
    isOwner?: boolean
  ) => Record<string, unknown>;
  razorpayClientFactory?: RazorpayClientFactory;
  aiClientFactory?: GeminiClientFactory;
  whatsappFetchImpl?: typeof fetch;
}) {
  const {
    app,
    store,
    authLimiter,
    adminLoginLimiter,
    contactLimiter,
    createSessionForUser,
    verifyPassword,
    serializePublicUser,
    razorpayClientFactory,
    aiClientFactory,
    whatsappFetchImpl,
  } = params;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: MAX_UPLOAD_FILES_PER_REQUEST,
    },
  });

  const requireOwner = async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.authSession || !req.authUser) {
        return sendJsonError(req, res, 401, 'AUTH_REQUIRED', 'Owner sign-in is required.');
      }
      if (!req.authUser.email_verified) {
        return sendJsonError(req, res, 403, 'OWNER_FORBIDDEN', 'Verified owner account required.');
      }
      if (store instanceof FirestoreRestStore) {
        if ((req.authUser.email || '').toLowerCase() !== store.ownerEmail) {
          return sendJsonError(
            req,
            res,
            403,
            'OWNER_FORBIDDEN',
            'Access denied. Only the verified store owner account is authorized.'
          );
        }
        const bound = await store.resolveBoundOwner().catch((err) => {
          console.error('[catalog] requireOwner resolveBoundOwner failed:', err);
          throw err;
        });
        if (bound && req.authUser.id !== bound.owner_user_id) {
          return sendJsonError(
            req,
            res,
            403,
            'OWNER_FORBIDDEN',
            'Access denied. Only the verified store owner account is authorized.'
          );
        }
        return next();
      }
      const bound = await store.resolveBoundOwner();
      if (!bound) {
        return sendJsonError(
          req,
          res,
          403,
          'OWNER_NOT_BOUND',
          'Owner access has not been configured on the server yet. Run `npm run admin:setup` or set ADMIN_OWNER_PASSWORD in server secrets.'
        );
      }
      if (req.authUser.id !== bound.owner_user_id) {
        return sendJsonError(
          req,
          res,
          403,
          'OWNER_FORBIDDEN',
          'Access denied. Only the verified store owner account is authorized.'
        );
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };

  const requireCustomerAuth = async (
    req: AuthedCatalogRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      if (req.authSession && req.authUser) {
        return next();
      }
      const authHeader = req.get('authorization');
      if (authHeader) {
        const verified = await verifyBearerFirebaseTokenFromHeader(authHeader);
        if (verified.ok && verified.uid) {
          const matchedUser = await store.getUserById(verified.uid).catch(() => null);
          const now = Date.now();
          req.authUser = matchedUser || {
            id: verified.uid,
            full_name: 'Member',
            email: verified.email || null,
            email_verified: 1,
            password_hash: 'firebase-managed',
            phone_e164: null,
            phone_verified: 0,
            created_at: now,
            updated_at: now,
          };
          return next();
        }
      }
      return sendJsonError(req, res, 401, 'AUTH_REQUIRED', 'Authentication required.');
    } catch (err) {
      return next(err);
    }
  };

  app.use('/api/admin', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  // -------------------------------------------------------------------------
  // Public Storefront Catalog, Media & Cart/Order Revalidation Endpoints
  // -------------------------------------------------------------------------

  app.get('/api/storefront', async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const [settings, content, categories] = await Promise.all([
        store.getSiteSettings(),
        store.getStorefrontContent(),
        store.listCategories(),
      ]);
      return res.json({
        settings,
        content,
        categories: categories.map((c) => serializeCategory(c)),
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post(
    '/api/contact',
    contactLimiter || authLimiter,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const senderName =
          typeof req.body?.senderName === 'string' ? req.body.senderName.trim() : '';
        const senderEmail =
          typeof req.body?.senderEmail === 'string'
            ? req.body.senderEmail.trim().toLowerCase()
            : '';
        const senderPhone =
          typeof req.body?.senderPhone === 'string' ? req.body.senderPhone.trim().slice(0, 24) : '';
        const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

        if (senderName.length < 2 || senderName.length > 100) {
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', 'Please enter your name.');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a valid email address.'
          );
        }
        if (subject.length < 2 || subject.length > 140) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter a brief subject for your enquiry.'
          );
        }
        if (message.length < 5 || message.length > 2000) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please share a short message (at least 5 characters).'
          );
        }

        const created = await store.createContactMessage({
          senderName,
          senderEmail,
          senderPhone,
          subject,
          message,
        });

        return res.status(201).json({
          id: created.id,
          createdAt: created.created_at,
          message: 'Thank you. Your enquiry has been received by our boutique team.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get('/api/products', async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const featuredOnly = req.query.featured === 'true';

      const rows = await store.listPublicProducts({ category, q, featuredOnly });
      return res.json({
        items: rows.map((row) => serializePublicProduct(row)),
      });
    } catch (err) {
      return next(err);
    }
  });

  app.get(
    '/api/products/:id',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const id = String(req.params.id || '');
        const row = await store.getPublicProductByIdOrSlug(id);
        if (!row) {
          return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        }
        return res.json({ product: serializePublicProduct(row) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/media/:filename',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const filename = String(req.params.filename || '');
        if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
          return res.status(404).end();
        }

        const result = await store.getMediaWithPublicStatus(filename);
        if (!result) {
          return res.status(404).end();
        }

        if (!result.isLinkedToPublished && !(await isRequestBoundOwner(req, store))) {
          return res.status(404).end();
        }

        res.setHeader('Content-Type', result.media.mime_type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Cache-Control',
          result.isLinkedToPublished ? 'public, max-age=31536000, immutable' : 'private, no-store'
        );
        return res.send(Buffer.from(result.media.data));
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/cart/validate',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
        if (rawItems.length > 50) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Too many items in shopping bag.'
          );
        }

        const productIds = rawItems
          .map((item: unknown) =>
            item && typeof item === 'object' && typeof (item as Record<string, unknown>).productId === 'string'
              ? String((item as Record<string, unknown>).productId)
              : ''
          )
          .filter(Boolean);

        const productMap = await store.getProductsForCartValidation(productIds);

        const validatedItems: Array<{
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
        }> = [];

        let subtotalPaise = 0;

        for (const raw of rawItems) {
          if (!raw || typeof raw !== 'object') continue;
          const item = raw as Record<string, unknown>;
          const productId = typeof item.productId === 'string' ? item.productId : '';
          const variantId = typeof item.variantId === 'string' ? item.variantId : null;
          const requestedQty =
            typeof item.quantity === 'number' &&
            Number.isInteger(item.quantity) &&
            item.quantity > 0
              ? Math.min(item.quantity, 50)
              : 1;
          const seenPricePaise =
            typeof item.seenPricePaise === 'number' && Number.isFinite(item.seenPricePaise)
              ? Math.round(item.seenPricePaise)
              : null;

          const entry = productMap.get(productId);
          if (!entry || entry.product.status !== 'published') {
            validatedItems.push({
              productId,
              variantId,
              requestedQty,
              availableQty: 0,
              available: false,
              statusReason: 'This style is currently unavailable or no longer published.',
              priceChanged: false,
              previousPricePaise: seenPricePaise,
              currentPricePaise: null,
              lineTotalPaise: 0,
              title:
                typeof item.fallbackTitle === 'string' ? item.fallbackTitle : 'Unavailable style',
              variantLabel: typeof item.fallbackVariant === 'string' ? item.fallbackVariant : '',
              imageUrl: '',
            });
            continue;
          }

          const { product, variants, images } = entry;
          const coverImg = images[0];
          const variant = variantId
            ? variants.find((v) => v.id === variantId || v.sku === variantId) || variants[0]
            : variants[0];

          if (!variant) {
            validatedItems.push({
              productId: product.id,
              variantId,
              requestedQty,
              availableQty: 0,
              available: false,
              statusReason: 'Selected size or color option is no longer available.',
              priceChanged: false,
              previousPricePaise: seenPricePaise,
              currentPricePaise: product.price_paise,
              lineTotalPaise: 0,
              title: product.title,
              variantLabel: '',
              imageUrl: coverImg?.url || '',
            });
            continue;
          }

          const availableQty = variant.stock_qty;
          const isOut = availableQty <= 0;
          const insufficient = !isOut && requestedQty > availableQty;
          const effectiveQty = isOut ? 0 : Math.min(requestedQty, availableQty);
          const priceChanged = seenPricePaise !== null && seenPricePaise !== variant.price_paise;
          const lineTotal = variant.price_paise * effectiveQty;
          subtotalPaise += lineTotal;

          validatedItems.push({
            productId: product.id,
            variantId: variant.id,
            requestedQty,
            availableQty,
            available: !isOut,
            statusReason: isOut
              ? 'Out of stock.'
              : insufficient
                ? `Only ${availableQty} remaining in stock.`
                : null,
            priceChanged,
            previousPricePaise: seenPricePaise,
            currentPricePaise: variant.price_paise,
            lineTotalPaise: lineTotal,
            title: product.title,
            variantLabel: `${variant.size} · ${variant.color_name}`,
            imageUrl: coverImg?.url || '',
          });
        }

        return res.json({
          items: validatedItems,
          subtotalPaise,
          hasUnavailable: validatedItems.some(
            (i) => !i.available || i.requestedQty > i.availableQty
          ),
          hasPriceChanges: validatedItems.some((i) => i.priceChanged),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post('/api/orders', async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
    try {
      const customerName =
        typeof req.body?.customerName === 'string' ? req.body.customerName.trim() : '';
      const customerEmail =
        typeof req.body?.customerEmail === 'string'
          ? req.body.customerEmail.trim().toLowerCase()
          : '';
      const customerPhone =
        typeof req.body?.customerPhone === 'string' ? req.body.customerPhone.trim() : '';
      const shippingAddress =
        typeof req.body?.shippingAddress === 'string' ? req.body.shippingAddress.trim() : '';
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

      if (customerName.length < 2 || customerName.length > 100) {
        return sendJsonError(req, res, 400, 'VALIDATION_ERROR', 'Please enter your full name.');
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        return sendJsonError(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          'Please enter a valid email address.'
        );
      }
      if (customerPhone.length < 7 || customerPhone.length > 24) {
        return sendJsonError(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          'Please enter a valid contact phone number.'
        );
      }
      if (shippingAddress.length < 8 || shippingAddress.length > 400) {
        return sendJsonError(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          'Please enter a complete delivery address.'
        );
      }
      if (rawItems.length === 0 || rawItems.length > 30) {
        return sendJsonError(req, res, 400, 'VALIDATION_ERROR', 'Your shopping bag is empty.');
      }

      const parsedItems: Array<{
        productId: string;
        variantId: string;
        quantity: number;
        expectedPricePaise: number | null;
      }> = [];

      for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') {
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', 'Invalid cart item.');
        }
        const obj = raw as Record<string, unknown>;
        const productId = typeof obj.productId === 'string' ? obj.productId : '';
        const variantId = typeof obj.variantId === 'string' ? obj.variantId : '';
        const quantity = typeof obj.quantity === 'number' ? obj.quantity : 0;
        const expectedPricePaise =
          typeof obj.expectedPricePaise === 'number' && Number.isFinite(obj.expectedPricePaise)
            ? Math.round(obj.expectedPricePaise)
            : null;

        if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', 'Invalid item quantity in bag.');
        }

        parsedItems.push({ productId, variantId, quantity, expectedPricePaise });
      }

      try {
        const { order, items } = await store.placeOrder({
          customerUserId: req.authUser?.id || null,
          customerName,
          customerEmail,
          customerPhone,
          shippingAddress,
          items: parsedItems,
        });

        return res.status(201).json({
          order: {
            id: order.id,
            orderNumber: order.order_number,
            status: order.status,
            subtotalPaise: order.subtotal_paise,
            totalPaise: order.total_paise,
            currency: order.currency,
            createdAt: order.created_at,
            items: items.map((l) => ({
              productId: l.product_id,
              variantId: l.variant_id,
              productTitle: l.product_title,
              variantLabel: l.variant_label,
              sku: l.sku,
              unitPricePaise: l.unit_price_paise,
              quantity: l.quantity,
              lineTotalPaise: l.line_total_paise,
            })),
          },
        });
      } catch (innerErr) {
        if (innerErr instanceof StoreHttpError) {
          return sendJsonError(
            req,
            res,
            innerErr.httpStatus,
            innerErr.code,
            innerErr.message
          );
        }
        throw innerErr;
      }
    } catch (err) {
      return next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Razorpay Standard Web Checkout, Webhook, Order Status & Promo Validation
  // -------------------------------------------------------------------------

  async function resolveCheckoutAuthContext(req: AuthedCatalogRequest): Promise<{
    customerUserId: string | null;
    customerIdToken: string | null;
  }> {
    const authHeader = req.get('authorization');
    let customerIdToken: string | null = null;
    let bearerUid: string | null = null;
    if (authHeader && /^Bearer\s+(.+)$/i.test(authHeader)) {
      const m = /^Bearer\s+(.+)$/i.exec(authHeader);
      customerIdToken = m?.[1]?.trim() || null;
      const verified = await verifyBearerFirebaseTokenFromHeader(authHeader);
      bearerUid = verified.ok ? verified.uid : null;
    }
    return {
      customerUserId: req.authUser?.id || bearerUid || null,
      customerIdToken,
    };
  }

  app.post(
    '/api/create-order',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const authCtx = await resolveCheckoutAuthContext(req);
        const result = await handleCreateOrderRequest({
          body: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
            string,
            unknown
          >,
          store,
          customerUserId: authCtx.customerUserId,
          customerIdToken: authCtx.customerIdToken,
          razorpayClientFactory,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/verify-payment',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const authCtx = await resolveCheckoutAuthContext(req);
        const result = await handleVerifyPaymentRequest({
          body: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
            string,
            unknown
          >,
          store,
          customerUserId: authCtx.customerUserId,
          customerIdToken: authCtx.customerIdToken,
          razorpayClientFactory,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/razorpay-webhook',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const rawBody =
          typeof req.rawBody === 'string' && req.rawBody
            ? req.rawBody
            : JSON.stringify(req.body || {});
        const result = await handleRazorpayWebhookRequest({
          rawBody,
          signatureHeader: req.get('x-razorpay-signature'),
          store,
          razorpayClientFactory,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return next(err);
      }
    }
  );

  const handleOrderStatusHttp = async (
    req: AuthedCatalogRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const authCtx = await resolveCheckoutAuthContext(req);
      const qOid =
        typeof req.query.razorpay_order_id === 'string'
          ? req.query.razorpay_order_id
          : typeof req.query.order_id === 'string'
            ? req.query.order_id
            : '';
      const qPid =
        typeof req.query.razorpay_payment_id === 'string'
          ? req.query.razorpay_payment_id
          : typeof req.query.payment_id === 'string'
            ? req.query.payment_id
            : '';
      const bodyObj = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
        string,
        unknown
      >;
      const razorpayOrderId =
        typeof bodyObj.razorpay_order_id === 'string'
          ? bodyObj.razorpay_order_id
          : typeof bodyObj.order_id === 'string'
            ? bodyObj.order_id
            : qOid;
      const razorpayPaymentId =
        typeof bodyObj.razorpay_payment_id === 'string'
          ? bodyObj.razorpay_payment_id
          : typeof bodyObj.payment_id === 'string'
            ? bodyObj.payment_id
            : qPid;

      const result = await handleOrderStatusRequest({
        razorpayOrderId,
        razorpayPaymentId,
        store,
        customerUserId: authCtx.customerUserId,
        customerIdToken: authCtx.customerIdToken,
        razorpayClientFactory,
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return next(err);
    }
  };

  app.get('/api/order-status', handleOrderStatusHttp);
  app.post('/api/order-status', handleOrderStatusHttp);

  app.post(
    '/api/coupons/validate',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const subtotalPaise = Math.max(
          0,
          Math.round(Number(req.body?.subtotalPaise ?? 0) || 0)
        );
        const couponCode =
          typeof req.body?.couponCode === 'string'
            ? req.body.couponCode
            : typeof req.body?.code === 'string'
              ? req.body.code
              : '';
        const giftCardCode =
          typeof req.body?.giftCardCode === 'string' ? req.body.giftCardCode : '';
        if (!couponCode.trim() && !giftCardCode.trim()) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Enter a coupon or gift card code to apply.'
          );
        }
        const result = await validatePromoAndGiftCardForBag({
          subtotalPaise,
          couponCode: couponCode.trim() || null,
          giftCardCode: giftCardCode.trim() || null,
          store,
          ensurePayableMinimum: false,
        });
        return res.json({
          valid: true,
          ...result,
        });
      } catch (err) {
        if (err instanceof StoreHttpError) {
          return sendJsonError(req, res, err.httpStatus, err.code, err.message);
        }
        return next(err);
      }
    }
  );

  app.post(
    '/api/gift-cards/check',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const rawCode = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
        if (!rawCode || rawCode.length < 4) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Enter a valid Sahithi Gift Card code.'
          );
        }
        const gc = await store.getGiftCardByCode(rawCode);
        if (!gc) {
          return sendJsonError(
            req,
            res,
            404,
            'GIFT_CARD_NOT_FOUND',
            `Gift card "${rawCode}" was not found.`
          );
        }
        if (!gc.active) {
          return sendJsonError(
            req,
            res,
            400,
            'GIFT_CARD_INACTIVE',
            `Gift card "${rawCode}" is inactive.`
          );
        }
        if (gc.expires_at && Date.now() > gc.expires_at) {
          return sendJsonError(
            req,
            res,
            400,
            'GIFT_CARD_EXPIRED',
            `Gift card "${rawCode}" expired on ${new Date(gc.expires_at).toLocaleDateString('en-IN')}.`
          );
        }
        return res.json({ giftCard: serializeGiftCardRow(gc) });
      } catch (err) {
        return next(err);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Customer "Your Account" Endpoints (/api/account/*)
  // -------------------------------------------------------------------------

  app.get(
    '/api/account/orders',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const orders = await store.listCustomerOrders(req.authUser!.id);
        return res.json({
          items: orders.map((o) => serializeOrderWithItems(o)),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/account/orders/:id/request',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const orderId = String(req.params.id || '');
        const reqType = req.body?.type === 'cancel' ? 'cancel' : req.body?.type === 'return' ? 'return' : null;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (!reqType) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Request type must be "cancel" or "return".'
          );
        }
        if (reason.length < 5 || reason.length > 500) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please provide a reason between 5 and 500 characters.'
          );
        }
        const existing = await store.getOrderById(orderId);
        if (!existing) {
          return sendJsonError(req, res, 404, 'ORDER_NOT_FOUND', 'Order not found.');
        }
        if (existing.order.customer_user_id !== req.authUser!.id) {
          return sendJsonError(
            req,
            res,
            403,
            'FORBIDDEN',
            'You can only submit requests for your own orders.'
          );
        }
        const updated = await store.submitOrderReturnRequest({
          orderId,
          userId: req.authUser!.id,
          type: reqType,
          reason,
        });
        if (!updated) {
          return sendJsonError(req, res, 404, 'ORDER_NOT_FOUND', 'Order not found.');
        }
        return res.json({ order: serializeOrderWithItems(updated) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/account/addresses',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const addresses = await store.listCustomerAddresses(req.authUser!.id);
        return res.json({ items: addresses.map((a) => serializeCustomerAddress(a)) });
      } catch (err) {
        return next(err);
      }
    }
  );

  const handleSaveAddress = async (
    req: AuthedCatalogRequest,
    res: Response,
    next: NextFunction,
    fixedId?: string
  ) => {
    try {
      const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
      const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      const line1 = typeof req.body?.line1 === 'string' ? req.body.line1.trim() : '';
      const line2 = typeof req.body?.line2 === 'string' ? req.body.line2.trim() : '';
      const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
      const state = typeof req.body?.state === 'string' ? req.body.state.trim() : '';
      const pincode = typeof req.body?.pincode === 'string' ? req.body.pincode.trim() : '';
      const landmark = typeof req.body?.landmark === 'string' ? req.body.landmark.trim() : '';
      const label =
        req.body?.label === 'Work' || req.body?.label === 'Other' ? req.body.label : 'Home';
      const isDefault = Boolean(req.body?.isDefault);

      if (fullName.length < 2 || phone.length < 7 || line1.length < 5 || city.length < 2 || state.length < 2 || pincode.length < 4) {
        return sendJsonError(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          'Please complete recipient name, phone, street address, city, state, and PIN code.'
        );
      }

      const saved = await store.upsertCustomerAddress(req.authUser!.id, {
        id: fixedId || (typeof req.body?.id === 'string' ? req.body.id.trim() : undefined),
        fullName,
        phone,
        line1,
        line2,
        city,
        state,
        pincode,
        landmark,
        label,
        isDefault,
      });
      return res.json({ address: serializeCustomerAddress(saved) });
    } catch (err) {
      return next(err);
    }
  };

  app.post('/api/account/addresses', requireCustomerAuth, (req, res, next) =>
    handleSaveAddress(req, res, next)
  );
  app.patch('/api/account/addresses/:id', requireCustomerAuth, (req, res, next) =>
    handleSaveAddress(req, res, next, String(req.params.id || ''))
  );

  app.delete(
    '/api/account/addresses/:id',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const deleted = await store.deleteCustomerAddress(
          req.authUser!.id,
          String(req.params.id || '')
        );
        if (!deleted) {
          return sendJsonError(req, res, 404, 'ADDRESS_NOT_FOUND', 'Saved address not found.');
        }
        return res.json({ deletedId: String(req.params.id || ''), ok: true });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/account/wishlist',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const productIds = await store.getCustomerWishlist(req.authUser!.id);
        return res.json({ productIds });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.put(
    '/api/account/wishlist',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const rawIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
        const cleanIds = rawIds.filter(
          (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0
        );
        const productIds = await store.setCustomerWishlist(req.authUser!.id, cleanIds);
        return res.json({ productIds });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/account/notifications',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const rows = await store.listCustomerNotifications(req.authUser!.id);
        const items = rows.map((n) => serializeCustomerNotification(n));
        return res.json({
          items,
          unreadCount: items.filter((n) => !n.read).length,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.patch(
    '/api/account/notifications/:id/read',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const ok = await store.markCustomerNotificationRead(
          req.authUser!.id,
          String(req.params.id || '')
        );
        if (!ok) {
          return sendJsonError(
            req,
            res,
            404,
            'NOTIFICATION_NOT_FOUND',
            'Notification not found.'
          );
        }
        return res.json({ ok: true, id: String(req.params.id || '') });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/account/notifications/read-all',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        await store.markAllCustomerNotificationsRead(req.authUser!.id);
        return res.json({ ok: true });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/account/coupons',
    requireCustomerAuth,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const now = Date.now();
        const rows = await store.listCoupons(true);
        const available = rows.filter(
          (c) =>
            (!c.starts_at || now >= c.starts_at) &&
            (!c.expires_at || now <= c.expires_at) &&
            (c.usage_limit === null || c.used_count < c.usage_limit)
        );
        return res.json({ items: available.map((c) => serializeCouponRow(c)) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/account/rewards',
    requireCustomerAuth,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const [config, orders] = await Promise.all([
          store.getLoyaltyConfig(),
          store.listCustomerOrders(req.authUser!.id),
        ]);
        const qualifyingOrders = orders.filter(
          (entry) =>
            (entry.order.payment_status || '').toLowerCase() === 'paid' &&
            !['cancelled', 'returned'].includes((entry.order.fulfillment_status || entry.order.status).toLowerCase())
        );
        const lifetimeSpendPaise = qualifyingOrders.reduce(
          (sum, entry) => sum + Number(entry.order.total_paise || 0),
          0
        );
        const deliveredOrdersCount = orders.filter(
          (entry) =>
            (entry.order.fulfillment_status || entry.order.status).toLowerCase() === 'delivered'
        ).length;
        const pointsBalance = config.rewardsEnabled
          ? Math.floor((lifetimeSpendPaise / 10_000) * Math.max(0, config.pointsPerHundredInr))
          : 0;
        const threshold = Math.max(100, config.plusQualificationSpendPaise || 1_000_000);
        const isPlusMember = config.plusEnabled && lifetimeSpendPaise >= threshold;

        return res.json({
          config,
          pointsBalance,
          lifetimeEarnedPoints: pointsBalance,
          lifetimeSpendPaise,
          deliveredOrdersCount,
          isPlusMember,
          plusStatusLabel: !config.plusEnabled
            ? 'Program paused'
            : isPlusMember
              ? `${config.plusTierName} Active`
              : `${config.plusTierName} Eligible at ₹${(threshold / 100).toLocaleString('en-IN')}`,
          plusProgressPaise: Math.min(threshold, lifetimeSpendPaise),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/account/payment-methods',
    requireCustomerAuth,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        // Honest Saved Cards & Wallet availability: standard Razorpay Checkout handles UPI, cards, and wallets securely per payment without storing PANs locally.
        return res.json({
          enabled: false,
          provider: 'razorpay',
          reason:
            'Sahithi Collections uses PCI-compliant Razorpay Standard Checkout. Saved card tokens require Razorpay Customer Vault configuration; all UPI, Cards, Wallets, and NetBanking options remain available at checkout.',
          methods: [],
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Automated WhatsApp AI Stylist & Cloud API Webhook Endpoints
  // -------------------------------------------------------------------------

  app.post(
    '/api/whatsapp/stylist',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const result = await handleWhatsAppStylistRequest({
          body: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
            string,
            unknown
          >,
          store,
          aiClientFactory,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
    const query: Record<string, string | string[] | undefined> = {};
    for (const [key, val] of Object.entries(req.query)) {
      if (typeof val === 'string') {
        query[key] = val;
      } else if (Array.isArray(val)) {
        query[key] = val.filter((item): item is string => typeof item === 'string');
      }
    }
    const result = handleWhatsAppWebhookGet({ query });
    if (result.rawText !== undefined) {
      return res.status(result.status).type('text/plain').send(result.rawText);
    }
    return res.status(result.status).json(result.body);
  });

  app.post(
    '/api/whatsapp/webhook',
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const sigHeader = req.get('x-hub-signature-256');
        const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
          string,
          unknown
        >;
        const result = await handleWhatsAppWebhookPost({
          body,
          rawBody: JSON.stringify(body),
          signatureHeader: sigHeader,
          store,
          aiClientFactory,
          fetchImpl: whatsappFetchImpl,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return next(err);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Private Owner-Only Admin Authentication & Dashboard Endpoints (/api/admin/*)
  // -------------------------------------------------------------------------

  app.post(
    '/api/admin/login',
    adminLoginLimiter || authLimiter,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!email || !password) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Please enter your owner email and password.'
          );
        }

        const user = await store.getUserByEmail(email);
        const passwordMatches = await verifyPassword(password, user?.password_hash);
        if (!user || !passwordMatches) {
          return sendJsonError(
            req,
            res,
            401,
            'INVALID_CREDENTIALS',
            'Invalid email or password.'
          );
        }

        if (!user.email_verified) {
          return sendJsonError(
            req,
            res,
            403,
            'EMAIL_NOT_VERIFIED',
            'Your email address is not yet verified. Complete verification or run `npm run admin:setup` on the server.'
          );
        }

        const bound = await store.resolveBoundOwner();
        if (!bound) {
          return sendJsonError(
            req,
            res,
            403,
            'OWNER_NOT_BOUND',
            'Owner binding has not completed on the server yet. Run `npm run admin:setup` or set ADMIN_OWNER_PASSWORD in server secrets.'
          );
        }

        if (user.id !== bound.owner_user_id) {
          return sendJsonError(
            req,
            res,
            403,
            'OWNER_FORBIDDEN',
            'This account does not have store owner permissions.'
          );
        }

        const { session } = await createSessionForUser(req, res, user.id);
        return res.json({
          csrfToken: session.csrf_secret,
          user: serializePublicUser(user, session, true),
          ownerBinding: {
            boundAt: bound.bound_at,
            boundVia: bound.bound_via,
          },
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/session',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        let bound = await store.resolveBoundOwner().catch(() => null);
        if (!bound && store instanceof FirestoreRestStore && req.authUser) {
          bound = await store.bindOwnerAccount({
            email: store.ownerEmail,
            userId: req.authUser.id,
            boundVia: 'firebase_verified_owner',
          });
        }
        return res.json({
          authenticated: true,
          isOwner: true,
          csrfToken: req.authSession!.csrf_secret,
          user: serializePublicUser(req.authUser!, req.authSession!, true),
          ownerBinding: bound
            ? {
                boundAt: bound.bound_at,
                boundVia: bound.bound_via,
              }
            : {
                boundAt: Date.now(),
                boundVia: 'firebase_verified_owner',
              },
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/overview',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const overview = await store.getAdminOverview();
        return res.json({
          metrics: overview.metrics,
          lowStockItems: overview.lowStockItems.map((row) => serializeAdminProduct(row)),
          recentOrders: overview.recentOrders.map((o) => serializeOrderWithItems(o)),
          recentMessages: overview.recentMessages.map((m) => serializeContactMessage(m)),
          recentAuditLogs: overview.recentAuditLogs.map((a) => ({
            id: a.id,
            productId: a.product_id,
            productTitle: a.product_title,
            action: a.action,
            summary: a.summary,
            createdAt: a.created_at,
          })),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/products',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const status = typeof req.query.status === 'string' ? req.query.status.trim() : 'all';
        const category =
          typeof req.query.category === 'string' ? req.query.category.trim() : 'All';
        const stockFilter = typeof req.query.stock === 'string' ? req.query.stock.trim() : 'all';
        const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : 'updated';
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const pageSize = Math.min(
          50,
          Math.max(1, Number.parseInt(String(req.query.pageSize || '10'), 10) || 10)
        );

        const result = await store.listAdminProducts({
          q,
          status,
          category,
          stockFilter,
          sort,
          page,
          pageSize,
        });

        return res.json({
          items: result.items.map((row) => serializeAdminProduct(row)),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/products/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const found = await store.getAdminProduct(id);
        if (!found) {
          return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        }

        return res.json({
          product: serializeAdminProduct(found.data),
          auditLogs: found.auditLogs.map((a) => ({
            id: a.id,
            action: a.action,
            summary: a.summary,
            createdAt: a.created_at,
          })),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/products',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const parsed = await validateAndNormalizeProductInput(
          store,
          (req.body || {}) as Record<string, unknown>
        );
        if (!parsed.ok) {
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', parsed.error, parsed.fieldErrors);
        }

        const d = parsed.data;
        const now = Date.now();
        const id = `sc-${crypto.randomBytes(4).toString('hex')}`;
        const slug = await store.makeUniqueSlug(d.title);
        const totalStock = d.variants.reduce((sum, v) => sum + v.stockQty, 0);

        const variants: ProductVariantRow[] = d.variants.map((v) => ({
          id: v.id,
          product_id: id,
          sku: v.sku,
          size: v.size,
          color_name: v.colorName,
          color_hex: v.colorHex,
          price_paise: v.pricePaise,
          compare_at_paise: v.compareAtPaise,
          stock_qty: v.stockQty,
          position: v.position,
        }));

        const created = await store.createProduct({
          product: {
            id,
            slug,
            title: d.title,
            description: d.description,
            fabric_note: d.fabricNote,
            category: d.category,
            sku: d.sku,
            price_paise: d.pricePaise,
            compare_at_paise: d.compareAtPaise,
            stock_qty: totalStock,
            low_stock_threshold: d.lowStockThreshold,
            featured: d.featured ? 1 : 0,
            status: d.status,
            colors_json: JSON.stringify(d.colors),
            sizes_json: JSON.stringify(d.sizes),
            version: 1,
            published_at: d.status === 'published' ? now : null,
            archived_at: null,
            created_at: now,
            updated_at: now,
          },
          variants,
          images: d.images,
          actorUserId: req.authUser!.id,
          auditAction: d.status === 'published' ? 'publish' : 'create',
          auditSummary:
            d.status === 'published'
              ? `Created and published "${d.title}" at ₹${(d.pricePaise / 100).toLocaleString('en-IN')} (${totalStock} in stock).`
              : `Created draft "${d.title}" (${totalStock} in stock).`,
          auditAfter: {
            pricePaise: d.pricePaise,
            stockQty: totalStock,
            status: d.status,
            variantsCount: d.variants.length,
          },
        });

        return res.status(201).json({ product: serializeAdminProduct(created) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.patch(
    '/api/admin/products/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const existingFound = await store.getAdminProduct(id);
        if (!existingFound) {
          return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        }

        const existing = existingFound.data.product;

        // Support status-only PATCH updates (e.g. { status: 'draft' | 'published' | 'archived' })
        if (
          req.body &&
          typeof req.body.status === 'string' &&
          ['published', 'draft', 'archived'].includes(req.body.status) &&
          req.body.title === undefined &&
          req.body.name === undefined
        ) {
          const targetStatus = req.body.status as ProductStatus;
          const actionName: 'publish' | 'unpublish' | 'archive' | 'restore' =
            targetStatus === 'published'
              ? 'publish'
              : targetStatus === 'archived'
                ? 'archive'
                : existing.status === 'archived'
                  ? 'restore'
                  : 'unpublish';
          let transitionResult = await store.transitionProductStatus({
            productId: existing.id,
            expectedVersion:
              typeof req.body.expectedVersion === 'number'
                ? req.body.expectedVersion
                : existing.version,
            targetStatus,
            actionName,
            actorUserId: req.authUser!.id,
          });
          if (!transitionResult.ok && transitionResult.code === 'VERSION_CONFLICT') {
            const refreshed = await store.getAdminProduct(existing.id);
            if (refreshed) {
              transitionResult = await store.transitionProductStatus({
                productId: existing.id,
                expectedVersion: refreshed.data.product.version,
                targetStatus,
                actionName,
                actorUserId: req.authUser!.id,
              });
            }
          }
          if (!transitionResult.ok) {
            if (transitionResult.code === 'PRODUCT_NOT_FOUND') {
              return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
            }
            if (transitionResult.code === 'NO_IMAGES') {
              return sendJsonError(
                req,
                res,
                400,
                'VALIDATION_ERROR',
                'Add at least one photo before publishing this product to the storefront.'
              );
            }
            return sendJsonError(
              req,
              res,
              409,
              'VERSION_CONFLICT',
              'Product version changed concurrently. Refresh and retry.'
            );
          }
          return res.json({ product: serializeAdminProduct(transitionResult.product) });
        }

        const expectedVersion =
          typeof req.body?.expectedVersion === 'number'
            ? req.body.expectedVersion
            : existing.version;
        if (expectedVersion !== existing.version) {
          return sendJsonError(
            req,
            res,
            409,
            'VERSION_CONFLICT',
            'This product was updated elsewhere since you opened it. Reload the latest version before saving.'
          );
        }

        const parsed = await validateAndNormalizeProductInput(
          store,
          (req.body || {}) as Record<string, unknown>,
          existing.id
        );
        if (!parsed.ok) {
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', parsed.error, parsed.fieldErrors);
        }

        const d = parsed.data;
        const now = Date.now();
        const slug =
          typeof req.body?.slug === 'string' &&
          req.body.slug.trim() &&
          req.body.slug.trim() !== existing.slug
            ? await store.makeUniqueSlug(req.body.slug.trim(), existing.id)
            : existing.slug;
        const totalStock = d.variants.reduce((sum, v) => sum + v.stockQty, 0);
        const nextStatus: ProductStatus =
          req.body?.status === 'published' || req.body?.status === 'draft'
            ? req.body.status
            : existing.status === 'archived'
              ? 'archived'
              : d.status;

        if (nextStatus === 'published' && d.images.length === 0) {
          const msg = 'Upload or attach at least one product photo before publishing.';
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', msg, { images: msg });
        }

        const priceChanged = existing.price_paise !== d.pricePaise;
        const stockChanged = existing.stock_qty !== totalStock;
        const statusChanged = existing.status !== nextStatus;

        const action = statusChanged
          ? nextStatus === 'published'
            ? 'publish'
            : 'unpublish'
          : priceChanged
            ? 'price_change'
            : stockChanged
              ? 'stock_change'
              : 'update';

        const notes: string[] = [];
        if (priceChanged) {
          notes.push(
            `price ₹${(existing.price_paise / 100).toLocaleString('en-IN')} -> ₹${(
              d.pricePaise / 100
            ).toLocaleString('en-IN')}`
          );
        }
        if (stockChanged) {
          notes.push(`stock ${existing.stock_qty} -> ${totalStock}`);
        }
        if (statusChanged) {
          notes.push(`status ${existing.status} -> ${nextStatus}`);
        }
        const summary =
          notes.length > 0
            ? `Updated "${d.title}": ${notes.join(', ')}.`
            : `Updated details and gallery for "${d.title}".`;

        const result = await store.updateProduct({
          productId: existing.id,
          expectedVersion,
          nextSlug: slug,
          title: d.title,
          description: d.description,
          fabricNote: d.fabricNote,
          category: d.category,
          sku: d.sku,
          pricePaise: d.pricePaise,
          compareAtPaise: d.compareAtPaise,
          totalStock,
          lowStockThreshold: d.lowStockThreshold,
          featured: d.featured,
          nextStatus,
          colorsJson: JSON.stringify(d.colors),
          sizesJson: JSON.stringify(d.sizes),
          publishedAtIfNull: nextStatus === 'published' ? now : null,
          now,
          variants: d.variants.map((v) => ({
            id: v.id,
            product_id: existing.id,
            sku: v.sku,
            size: v.size,
            color_name: v.colorName,
            color_hex: v.colorHex,
            price_paise: v.pricePaise,
            compare_at_paise: v.compareAtPaise,
            stock_qty: v.stockQty,
            position: v.position,
          })),
          images: d.images,
          actorUserId: req.authUser!.id,
          auditAction: action,
          auditSummary: summary,
          auditBefore: {
            pricePaise: existing.price_paise,
            stockQty: existing.stock_qty,
            status: existing.status,
            version: existing.version,
          },
          auditAfter: {
            pricePaise: d.pricePaise,
            stockQty: totalStock,
            status: nextStatus,
            version: existing.version + 1,
          },
        });

        if (!result.ok) {
          if (result.code === 'PRODUCT_NOT_FOUND') {
            return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
          }
          return sendJsonError(
            req,
            res,
            409,
            'VERSION_CONFLICT',
            'Concurrent edit detected. Please reload the latest product state.'
          );
        }

        return res.json({ product: serializeAdminProduct(result.product) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/products/:id/duplicate',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const duplicated = await store.duplicateProduct(id, req.authUser!.id);
        if (!duplicated) {
          return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        }
        return res.status(201).json({ product: serializeAdminProduct(duplicated) });
      } catch (err) {
        return next(err);
      }
    }
  );

  const handleLifecycleTransition = (
    targetStatus: ProductStatus,
    actionName: 'publish' | 'unpublish' | 'archive' | 'restore'
  ) => {
    return async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const existingFound = await store.getAdminProduct(id);
        if (!existingFound) {
          return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        }
        const canonicalId = existingFound.data.product.id;
        const expectedVersion =
          typeof req.body?.expectedVersion === 'number'
            ? req.body.expectedVersion
            : existingFound.data.product.version;

        let result = await store.transitionProductStatus({
          productId: canonicalId,
          expectedVersion,
          targetStatus,
          actionName,
          actorUserId: req.authUser!.id,
        });

        if (!result.ok && result.code === 'VERSION_CONFLICT') {
          const refreshed = await store.getAdminProduct(canonicalId);
          if (refreshed) {
            result = await store.transitionProductStatus({
              productId: canonicalId,
              expectedVersion: refreshed.data.product.version,
              targetStatus,
              actionName,
              actorUserId: req.authUser!.id,
            });
          }
        }

        if (!result.ok) {
          if (result.code === 'PRODUCT_NOT_FOUND') {
            return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
          }
          if (result.code === 'NO_IMAGES') {
            return sendJsonError(
              req,
              res,
              400,
              'VALIDATION_ERROR',
              'Add at least one photo before publishing this product to the storefront.'
            );
          }
          return sendJsonError(
            req,
            res,
            409,
            'VERSION_CONFLICT',
            'Product version changed concurrently. Refresh and retry.'
          );
        }

        return res.json({ product: serializeAdminProduct(result.product) });
      } catch (err) {
        return next(err);
      }
    };
  };

  for (const method of ['post', 'patch', 'put'] as const) {
    app[method](
      '/api/admin/products/:id/publish',
      requireOwner,
      handleLifecycleTransition('published', 'publish')
    );
    app[method](
      '/api/admin/products/:id/unpublish',
      requireOwner,
      handleLifecycleTransition('draft', 'unpublish')
    );
    app[method](
      '/api/admin/products/:id/archive',
      requireOwner,
      handleLifecycleTransition('archived', 'archive')
    );
    app[method](
      '/api/admin/products/:id/restore',
      requireOwner,
      handleLifecycleTransition('draft', 'restore')
    );
  }

  app.delete(
    '/api/admin/products/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const result = await store.deleteOrArchiveProduct(id, req.authUser!.id);
        if (!result.ok) {
          return sendJsonError(req, res, 404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        }

        if (result.archivedInsteadOfDeleted && result.product) {
          return res.json({
            archivedInsteadOfDeleted: true,
            message:
              'Product is referenced by existing customer orders and was archived to preserve order history.',
            product: serializeAdminProduct(result.product),
          });
        }

        return res.json({
          archivedInsteadOfDeleted: false,
          deletedId: id,
          message: 'Product deleted.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/uploads',
    requireOwner,
    (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      upload.array('files', MAX_UPLOAD_FILES_PER_REQUEST)(req, res, async (uploadErr: unknown) => {
        try {
          if (uploadErr) {
            if (uploadErr instanceof multer.MulterError) {
              if (uploadErr.code === 'LIMIT_FILE_SIZE') {
                return sendJsonError(
                  req,
                  res,
                  400,
                  'UPLOAD_TOO_LARGE',
                  'Each photo must be 5 MB or smaller.'
                );
              }
              return sendJsonError(req, res, 400, 'UPLOAD_ERROR', uploadErr.message);
            }
            return next(uploadErr);
          }

          const files = (req.files as Express.Multer.File[] | undefined) || [];
          if (files.length === 0) {
            return sendJsonError(
              req,
              res,
              400,
              'NO_FILES',
              'Select one or more JPEG, PNG, or WebP images to upload.'
            );
          }

          const now = Date.now();
          const toSave: Array<{
            id: string;
            filename: string;
            mimeType: string;
            byteSize: number;
            sha256: string;
            data: Uint8Array;
            uploadedByUserId: string;
            createdAt: number;
          }> = [];
          const saved: Array<{
            id: string;
            filename: string;
            url: string;
            mimeType: string;
            byteSize: number;
          }> = [];

          for (const file of files) {
            const detected = detectImageFormat(file.buffer);
            if (!detected) {
              return sendJsonError(
                req,
                res,
                400,
                'INVALID_IMAGE_CONTENT',
                'Unsupported or invalid image file. Only genuine JPEG, PNG, and WebP images are permitted.'
              );
            }

            if (
              file.mimetype &&
              file.mimetype !== detected.mimeType &&
              file.mimetype !== 'application/octet-stream'
            ) {
              return sendJsonError(
                req,
                res,
                400,
                'MIME_MISMATCH',
                'Image file extension/type does not match its actual binary content.'
              );
            }

            const id = crypto.randomUUID();
            const safeFilename = `sc-${id}.${detected.ext}`;
            const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

            toSave.push({
              id,
              filename: safeFilename,
              mimeType: detected.mimeType,
              byteSize: file.buffer.byteLength,
              sha256,
              data: file.buffer,
              uploadedByUserId: req.authUser!.id,
              createdAt: now,
            });

            saved.push({
              id,
              filename: safeFilename,
              url: `/api/media/${safeFilename}`,
              mimeType: detected.mimeType,
              byteSize: file.buffer.byteLength,
            });
          }

          await store.saveMediaFiles(toSave);
          return res.status(201).json({ files: saved });
        } catch (err) {
          return next(err);
        }
      });
    }
  );

  app.get(
    '/api/admin/orders',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const pageSize = Math.min(
          50,
          Math.max(1, Number.parseInt(String(req.query.pageSize || '15'), 10) || 15)
        );

        const result = await store.listAdminOrders(page, pageSize);
        return res.json({
          items: result.items.map((o) => serializeOrderWithItems(o)),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.patch(
    '/api/admin/orders/:id/status',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const nextStatus = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
        const allowed = new Set([
          'pending',
          'confirmed',
          'packed',
          'shipped',
          'delivered',
          'cancelled',
          'return_requested',
          'returned',
        ]);
        if (!allowed.has(nextStatus)) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Invalid order fulfillment status.'
          );
        }

        const updated = await store.updateOrderStatusWithHistory(id, nextStatus, {
          actor: 'owner',
          note: note || undefined,
          notifyCustomer: true,
        });
        if (!updated) {
          return sendJsonError(req, res, 404, 'ORDER_NOT_FOUND', 'Order not found.');
        }

        return res.json({
          id,
          status: updated.order.status,
          order: serializeOrderWithItems(updated),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/orders/:id/resolve-request',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const decision =
          req.body?.decision === 'approved' || req.body?.decision === 'rejected'
            ? req.body.decision
            : null;
        if (!decision) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Decision must be "approved" or "rejected".'
          );
        }
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
        const resolved = await store.resolveOrderReturnRequest({
          orderId: id,
          decision,
          note: note || undefined,
        });
        if (!resolved) {
          return sendJsonError(
            req,
            res,
            404,
            'ORDER_OR_REQUEST_NOT_FOUND',
            'Order or pending return/cancel request not found.'
          );
        }
        return res.json({ order: serializeOrderWithItems(resolved) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/orders/recover',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const razorpayOrderId =
          typeof req.body?.razorpayOrderId === 'string'
            ? req.body.razorpayOrderId.trim()
            : typeof req.body?.razorpay_order_id === 'string'
              ? req.body.razorpay_order_id.trim()
              : '';
        const razorpayPaymentId =
          typeof req.body?.razorpayPaymentId === 'string'
            ? req.body.razorpayPaymentId.trim()
            : typeof req.body?.razorpay_payment_id === 'string'
              ? req.body.razorpay_payment_id.trim()
              : '';
        const customerFallback =
          req.body?.customer && typeof req.body.customer === 'object'
            ? {
                customerName: String((req.body.customer as Record<string, unknown>).customerName || ''),
                customerEmail: String((req.body.customer as Record<string, unknown>).customerEmail || ''),
                customerPhone: String((req.body.customer as Record<string, unknown>).customerPhone || ''),
                shippingAddress: String((req.body.customer as Record<string, unknown>).shippingAddress || ''),
              }
            : null;

        const result = await handleRecoverRazorpayOrder({
          razorpayOrderId,
          razorpayPaymentId,
          customerFallback:
            customerFallback && customerFallback.customerEmail ? customerFallback : null,
          store,
          razorpayClientFactory,
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        return next(err);
      }
    }
  );

  // Admin Coupons, Gift Cards, Loyalty & Activity
  app.get(
    '/api/admin/coupons',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const items = await store.listCoupons(false);
        return res.json({ items: items.map((c) => serializeCouponRow(c)) });
      } catch (err) {
        return next(err);
      }
    }
  );

  const handleUpsertCoupon = async (
    req: AuthedCatalogRequest,
    res: Response,
    next: NextFunction,
    fixedId?: string
  ) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      const discountType = req.body?.discountType === 'flat_paise' ? 'flat_paise' : 'percent';
      const discountValue = Math.round(Number(req.body?.discountValue ?? 0));
      const maxDiscountPaise =
        req.body?.maxDiscountPaise !== undefined && req.body?.maxDiscountPaise !== null && req.body?.maxDiscountPaise !== ''
          ? Math.max(0, Math.round(Number(req.body.maxDiscountPaise)))
          : null;
      const minSpendPaise = Math.max(0, Math.round(Number(req.body?.minSpendPaise ?? 0) || 0));
      const usageLimit =
        req.body?.usageLimit !== undefined && req.body?.usageLimit !== null && req.body?.usageLimit !== ''
          ? Math.max(1, Math.round(Number(req.body.usageLimit)))
          : null;
      const active = req.body?.active !== undefined ? Boolean(req.body.active) : true;
      const startsAt = req.body?.startsAt ? Number(req.body.startsAt) : null;
      const expiresAt = req.body?.expiresAt ? Number(req.body.expiresAt) : null;

      if (!/^[A-Z0-9_-]{3,32}$/.test(code) || !title || !Number.isFinite(discountValue) || discountValue <= 0) {
        return sendJsonError(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          'Provide a valid alphanumeric coupon code (3–32 chars), title, and discount value.'
        );
      }
      if (discountType === 'percent' && discountValue > 90) {
        return sendJsonError(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          'Percentage discount cannot exceed 90%.'
        );
      }
      const saved = await store.upsertCoupon({
        id: fixedId,
        code,
        title,
        description,
        discountType,
        discountValue,
        maxDiscountPaise,
        minSpendPaise,
        usageLimit,
        active,
        startsAt,
        expiresAt,
      });
      return res.json({ coupon: serializeCouponRow(saved) });
    } catch (err) {
      return next(err);
    }
  };

  app.post('/api/admin/coupons', requireOwner, (req, res, next) =>
    handleUpsertCoupon(req, res, next)
  );
  app.put('/api/admin/coupons/:id', requireOwner, (req, res, next) =>
    handleUpsertCoupon(req, res, next, String(req.params.id || ''))
  );
  app.delete(
    '/api/admin/coupons/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const deleted = await store.deleteCoupon(String(req.params.id || ''));
        if (!deleted) {
          return sendJsonError(req, res, 404, 'COUPON_NOT_FOUND', 'Coupon not found.');
        }
        return res.json({ deletedId: String(req.params.id || ''), ok: true });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/gift-cards',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const items = await store.listGiftCards();
        return res.json({ items: items.map((g) => serializeGiftCardRow(g)) });
      } catch (err) {
        return next(err);
      }
    }
  );

  const handleUpsertGiftCard = async (
    req: AuthedCatalogRequest,
    res: Response,
    next: NextFunction,
    fixedId?: string
  ) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
      const recipientEmail =
        typeof req.body?.recipientEmail === 'string' ? req.body.recipientEmail.trim().toLowerCase() : '';
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
      const initialBalancePaise = Math.round(Number(req.body?.initialBalancePaise ?? 0));
      const balancePaise =
        req.body?.balancePaise !== undefined
          ? Math.round(Number(req.body.balancePaise))
          : initialBalancePaise;
      const active = req.body?.active !== undefined ? Boolean(req.body.active) : true;
      const expiresAt = req.body?.expiresAt ? Number(req.body.expiresAt) : null;

      if (!/^[A-Z0-9_-]{4,36}$/.test(code) || !Number.isFinite(initialBalancePaise) || initialBalancePaise < 100 || !Number.isFinite(balancePaise) || balancePaise < 0) {
        return sendJsonError(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          'Provide a valid gift card code (4–36 chars) and positive INR balance.'
        );
      }
      const saved = await store.upsertGiftCard({
        id: fixedId,
        code,
        recipientEmail,
        note,
        initialBalancePaise,
        balancePaise,
        active,
        expiresAt,
      });
      return res.json({ giftCard: serializeGiftCardRow(saved) });
    } catch (err) {
      return next(err);
    }
  };

  app.post('/api/admin/gift-cards', requireOwner, (req, res, next) =>
    handleUpsertGiftCard(req, res, next)
  );
  app.put('/api/admin/gift-cards/:id', requireOwner, (req, res, next) =>
    handleUpsertGiftCard(req, res, next, String(req.params.id || ''))
  );
  app.delete(
    '/api/admin/gift-cards/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const deleted = await store.deleteGiftCard(String(req.params.id || ''));
        if (!deleted) {
          return sendJsonError(req, res, 404, 'GIFT_CARD_NOT_FOUND', 'Gift card not found.');
        }
        return res.json({ deletedId: String(req.params.id || ''), ok: true });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/loyalty',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const config = await store.getLoyaltyConfig();
        return res.json({ config });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.put(
    '/api/admin/loyalty',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const current = await store.getLoyaltyConfig();
        const body = (req.body?.config && typeof req.body.config === 'object' ? req.body.config : req.body || {}) as Partial<LoyaltyConfigData>;
        const nextConfig: LoyaltyConfigData = {
          rewardsEnabled: body.rewardsEnabled !== undefined ? Boolean(body.rewardsEnabled) : current.rewardsEnabled,
          pointsPerHundredInr:
            typeof body.pointsPerHundredInr === 'number' && Number.isFinite(body.pointsPerHundredInr)
              ? Math.max(0, Math.min(100, Math.round(body.pointsPerHundredInr)))
              : current.pointsPerHundredInr,
          rupeeValuePerPointPaise:
            typeof body.rupeeValuePerPointPaise === 'number' && Number.isFinite(body.rupeeValuePerPointPaise)
              ? Math.max(0, Math.min(5000, Math.round(body.rupeeValuePerPointPaise)))
              : current.rupeeValuePerPointPaise,
          plusEnabled: body.plusEnabled !== undefined ? Boolean(body.plusEnabled) : current.plusEnabled,
          plusTierName:
            typeof body.plusTierName === 'string' && body.plusTierName.trim()
              ? body.plusTierName.trim().slice(0, 60)
              : current.plusTierName,
          plusQualificationSpendPaise:
            typeof body.plusQualificationSpendPaise === 'number' && Number.isFinite(body.plusQualificationSpendPaise)
              ? Math.max(100, Math.round(body.plusQualificationSpendPaise))
              : current.plusQualificationSpendPaise,
          plusBenefits: Array.isArray(body.plusBenefits)
            ? body.plusBenefits
                .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
                .map((b) => b.trim().slice(0, 140))
            : current.plusBenefits,
          giftCardsEnabled: body.giftCardsEnabled !== undefined ? Boolean(body.giftCardsEnabled) : current.giftCardsEnabled,
        };
        const saved = await store.saveLoyaltyConfig(nextConfig);
        return res.json({ config: saved });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/activity',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const [users, ordersPage, messagesPage, coupons, giftCards] = await Promise.all([
          store.listUsersSummary(),
          store.listAdminOrders(1, 30),
          store.listAdminMessages({ page: 1, pageSize: 30 }),
          store.listCoupons(false),
          store.listGiftCards(),
        ]);

        const events: Array<{
          id: string;
          type: 'registration' | 'order' | 'enquiry' | 'return_request' | 'coupon_redemption' | 'gift_card';
          title: string;
          detail: string;
          actorLabel: string;
          refId?: string;
          status?: string;
          createdAt: number;
        }> = [];

        for (const u of users) {
          events.push({
            id: `reg_${u.id}`,
            type: 'registration',
            title: 'Customer Registered',
            detail: `${u.fullName || 'Member'} (${u.email})`,
            actorLabel: u.email,
            refId: u.id,
            status: u.emailVerified ? 'verified' : 'pending',
            createdAt: u.createdAt,
          });
        }

        const returnRequests: Array<{
          orderId: string;
          orderNumber: string;
          customerName: string;
          customerEmail: string;
          totalPaise: number;
          request: unknown;
        }> = [];

        for (const entry of ordersPage.items) {
          const serialized = serializeOrderWithItems(entry);
          events.push({
            id: `ord_${serialized.id}`,
            type: 'order',
            title: `Order ${serialized.orderNumber}`,
            detail: `${serialized.paymentStatus} · ${serialized.fulfillmentStatus} · ₹${(serialized.totalPaise / 100).toLocaleString('en-IN')}`,
            actorLabel: serialized.customerEmail,
            refId: serialized.id,
            status: serialized.fulfillmentStatus,
            createdAt: serialized.createdAt,
          });
          if (serialized.returnRequest) {
            const rr = serialized.returnRequest as {
              id?: string;
              type?: string;
              reason?: string;
              status?: string;
              requestedAt?: number;
            };
            returnRequests.push({
              orderId: serialized.id,
              orderNumber: serialized.orderNumber,
              customerName: serialized.customerName,
              customerEmail: serialized.customerEmail,
              totalPaise: serialized.totalPaise,
              request: rr,
            });
            events.push({
              id: `ret_${rr.id || serialized.id}`,
              type: 'return_request',
              title: `${rr.type === 'cancel' ? 'Cancellation' : 'Return'} Request (${serialized.orderNumber})`,
              detail: rr.reason || '',
              actorLabel: serialized.customerEmail,
              refId: serialized.id,
              status: rr.status || 'pending',
              createdAt: rr.requestedAt || serialized.updatedAt,
            });
          }
          if (serialized.couponCode) {
            events.push({
              id: `cpn_${serialized.id}`,
              type: 'coupon_redemption',
              title: `Coupon ${serialized.couponCode} Redeemed`,
              detail: `Saved ₹${((serialized.discountPaise || 0) / 100).toLocaleString('en-IN')} on ${serialized.orderNumber}`,
              actorLabel: serialized.customerEmail,
              refId: serialized.id,
              createdAt: serialized.createdAt,
            });
          }
        }

        for (const msg of messagesPage.items) {
          events.push({
            id: `msg_${msg.id}`,
            type: 'enquiry',
            title: `Enquiry: ${msg.subject}`,
            detail: msg.message.slice(0, 140),
            actorLabel: msg.sender_email || msg.sender_name,
            refId: msg.id,
            status: msg.status,
            createdAt: msg.created_at,
          });
        }

        events.sort((a, b) => b.createdAt - a.createdAt);

        return res.json({
          users,
          returnRequests,
          events: events.slice(0, 60),
          coupons: coupons.map((c) => serializeCouponRow(c)),
          giftCards: giftCards.map((g) => serializeGiftCardRow(g)),
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  // Categories CRUD
  app.get(
    '/api/admin/categories',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const items = await store.listCategories();
        return res.json({ items: items.map((c) => serializeCategory(c)) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.post(
    '/api/admin/categories',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const fieldErrors: Record<string, string> = {};
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const subtitleRaw = typeof req.body?.subtitle === 'string' ? req.body.subtitle.trim() : '';
        const altRaw = typeof req.body?.altText === 'string' ? req.body.altText.trim() : '';
        const rawImage = typeof req.body?.imageUrl === 'string' ? req.body.imageUrl.trim() : '';

        if (name.length < 2 || name.length > 64) {
          fieldErrors.name = 'Category name must be between 2 and 64 characters.';
        }
        if (subtitleRaw.length > 240) {
          fieldErrors.subtitle = 'Subtitle must be 240 characters or fewer.';
        }
        if (altRaw.length > 200) {
          fieldErrors.altText = 'Alt text must be 200 characters or fewer.';
        }

        let position: number | undefined;
        if (req.body?.position !== undefined && req.body?.position !== null && req.body?.position !== '') {
          const rawPos = req.body.position;
          if (typeof rawPos !== 'number' || !Number.isFinite(rawPos)) {
            fieldErrors.position = 'Display order must be a whole number between 0 and 999.';
          } else {
            const rounded = Math.round(rawPos);
            if (rounded < 0 || rounded > 999) {
              fieldErrors.position = 'Display order must be between 0 and 999.';
            } else {
              position = rounded;
            }
          }
        }

        const imgCheck = await verifySafeImageReference(
          store,
          rawImage || '/boutique-media/col_dresses_1794557657118.jpg'
        );
        if (!imgCheck.ok) {
          fieldErrors.imageUrl = imgCheck.error;
        }

        if (Object.keys(fieldErrors).length > 0 || !imgCheck.ok) {
          const firstMsg = Object.values(fieldErrors)[0] || 'Please review the highlighted category fields.';
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', firstMsg, fieldErrors);
        }

        try {
          const created = await store.createCategory({
            name,
            subtitle: subtitleRaw,
            imageUrl: imgCheck.url,
            altText: altRaw || name,
            position,
          });
          return res.status(201).json({ category: serializeCategory(created) });
        } catch (err) {
          if (err instanceof StoreHttpError) {
            return sendJsonError(req, res, err.httpStatus, err.code, err.message);
          }
          throw err;
        }
      } catch (err) {
        return next(err);
      }
    }
  );

  app.patch(
    '/api/admin/categories/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const existing = await store.getCategoryById(id);
        if (!existing) {
          return sendJsonError(req, res, 404, 'CATEGORY_NOT_FOUND', 'Category not found.');
        }

        const fieldErrors: Record<string, string> = {};
        const name =
          typeof req.body?.name === 'string' ? req.body.name.trim() : existing.name;
        const subtitleRaw =
          typeof req.body?.subtitle === 'string' ? req.body.subtitle.trim() : existing.subtitle;
        const altRaw =
          typeof req.body?.altText === 'string' ? req.body.altText.trim() : existing.alt_text;
        const rawImage =
          typeof req.body?.imageUrl === 'string' ? req.body.imageUrl.trim() : existing.image_url;

        let position = existing.position;
        if (req.body?.position !== undefined && req.body?.position !== null && req.body?.position !== '') {
          const rawPos = req.body.position;
          if (typeof rawPos !== 'number' || !Number.isFinite(rawPos)) {
            fieldErrors.position = 'Display order must be a whole number between 0 and 999.';
          } else {
            const rounded = Math.round(rawPos);
            if (rounded < 0 || rounded > 999) {
              fieldErrors.position = 'Display order must be between 0 and 999.';
            } else {
              position = rounded;
            }
          }
        }

        if (name.length < 2 || name.length > 64) {
          fieldErrors.name = 'Category name must be between 2 and 64 characters.';
        }
        if (subtitleRaw.length > 240) {
          fieldErrors.subtitle = 'Subtitle must be 240 characters or fewer.';
        }
        if (altRaw.length > 200) {
          fieldErrors.altText = 'Alt text must be 200 characters or fewer.';
        }

        const imgCheck = await verifySafeImageReference(
          store,
          rawImage || '/boutique-media/col_dresses_1794557657118.jpg'
        );
        if (!imgCheck.ok) {
          fieldErrors.imageUrl = imgCheck.error;
        }

        if (Object.keys(fieldErrors).length > 0 || !imgCheck.ok) {
          const firstMsg = Object.values(fieldErrors)[0] || 'Please review the highlighted category fields.';
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', firstMsg, fieldErrors);
        }

        try {
          const updated = await store.updateCategory(id, {
            name,
            subtitle: subtitleRaw,
            imageUrl: imgCheck.url,
            altText: altRaw || name,
            position,
          });
          if (!updated) {
            return sendJsonError(req, res, 404, 'CATEGORY_NOT_FOUND', 'Category not found.');
          }
          return res.json({ category: serializeCategory(updated) });
        } catch (err) {
          if (err instanceof StoreHttpError) {
            return sendJsonError(req, res, err.httpStatus, err.code, err.message);
          }
          throw err;
        }
      } catch (err) {
        return next(err);
      }
    }
  );

  app.delete(
    '/api/admin/categories/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const resDelete = await store.deleteCategory(id);
        if (!resDelete.ok) {
          if (resDelete.code === 'NOT_FOUND') {
            return sendJsonError(req, res, 404, 'CATEGORY_NOT_FOUND', 'Category not found.');
          }
          return sendJsonError(
            req,
            res,
            409,
            'CATEGORY_IN_USE',
            `Cannot delete this category while ${resDelete.productCount} product(s) are assigned to it. Reassign those products first.`
          );
        }
        return res.json({ deletedId: id, message: 'Category deleted.' });
      } catch (err) {
        return next(err);
      }
    }
  );

  // Storefront Content Management
  app.get(
    '/api/admin/content',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const content = await store.getStorefrontContent();
        return res.json({ content });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.put(
    '/api/admin/content',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const body = (req.body || {}) as Partial<StorefrontContentData>;
        const candidate = mergeStorefrontContent(body);
        const fieldErrors: Record<string, string> = {};

        if (!candidate.hero.headline) {
          fieldErrors['hero.headline'] = 'Hero headline is required.';
        } else if (candidate.hero.headline.length > 160) {
          fieldErrors['hero.headline'] = 'Hero headline must be 160 characters or fewer.';
        }
        if (!candidate.hero.supportingText) {
          fieldErrors['hero.supportingText'] = 'Supporting description is required.';
        } else if (candidate.hero.supportingText.length > 500) {
          fieldErrors['hero.supportingText'] = 'Supporting description must be 500 characters or fewer.';
        }
        if (!candidate.hero.primaryCta) {
          fieldErrors['hero.primaryCta'] = 'Primary CTA button label is required.';
        } else if (candidate.hero.primaryCta.length > 60) {
          fieldErrors['hero.primaryCta'] = 'Primary CTA button label must be 60 characters or fewer.';
        }
        if (candidate.hero.eyebrow.length > 120) {
          fieldErrors['hero.eyebrow'] = 'Eyebrow text must be 120 characters or fewer.';
        }
        if (candidate.hero.secondaryCta.length > 60) {
          fieldErrors['hero.secondaryCta'] = 'Secondary CTA label must be 60 characters or fewer.';
        }
        if (!candidate.hero.mainImage.src) {
          fieldErrors['hero.mainImage.src'] = 'Main hero photo is required.';
        }

        if (!candidate.collectionsHeader.heading) {
          fieldErrors['collectionsHeader.heading'] = 'Collections section heading is required.';
        }
        if (!candidate.showcaseHeader.heading) {
          fieldErrors['showcaseHeader.heading'] = 'Showcase section heading is required.';
        }

        if (!candidate.spotlightEdit.title) {
          fieldErrors['spotlightEdit.title'] = 'Spotlight Edit title is required.';
        }
        if (!candidate.spotlightEdit.description) {
          fieldErrors['spotlightEdit.description'] = 'Spotlight Edit description is required.';
        }
        if (!candidate.spotlightEdit.ctaLabel) {
          fieldErrors['spotlightEdit.ctaLabel'] = 'Spotlight CTA button label is required.';
        }
        if (!candidate.spotlightEdit.image.src) {
          fieldErrors['spotlightEdit.image.src'] = 'Spotlight Edit image is required.';
        }

        if (!candidate.lookbookHeader.heading) {
          fieldErrors['lookbookHeader.heading'] = 'Lookbook section heading is required.';
        }
        candidate.lookbookEntries.forEach((entry, idx) => {
          if (!entry.title) {
            fieldErrors[`lookbookEntries.${idx}.title`] = `Lookbook frame #${idx + 1} requires a title.`;
          }
          if (!entry.image) {
            fieldErrors[`lookbookEntries.${idx}.image`] = `Lookbook frame #${idx + 1} requires an image.`;
          }
        });

        if (!candidate.about.heading) {
          fieldErrors['about.heading'] = 'Brand story heading is required.';
        }
        if (candidate.about.paragraphs.length === 0) {
          fieldErrors['about.paragraphs'] = 'Please include at least one brand story paragraph.';
        }
        if (!candidate.about.image.src) {
          fieldErrors['about.image.src'] = 'About portrait image is required.';
        }

        const imageChecks: Array<{ field: string; url: string }> = [
          { field: 'hero.mainImage.src', url: candidate.hero.mainImage.src },
          ...candidate.hero.accentCutouts.map((c, idx) => ({
            field: `hero.accentCutouts.${idx}.src`,
            url: c.src,
          })),
          { field: 'spotlightEdit.image.src', url: candidate.spotlightEdit.image.src },
          { field: 'about.image.src', url: candidate.about.image.src },
          ...candidate.lookbookEntries.map((e, idx) => ({
            field: `lookbookEntries.${idx}.image`,
            url: e.image,
          })),
        ];

        for (const item of imageChecks) {
          if (!item.url) continue;
          const check = await verifySafeImageReference(store, item.url);
          if (!check.ok && !fieldErrors[item.field]) {
            fieldErrors[item.field] = check.error;
          }
        }

        if (Object.keys(fieldErrors).length > 0) {
          const firstMsg =
            Object.values(fieldErrors)[0] || 'Please fix the highlighted content fields.';
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', firstMsg, fieldErrors);
        }

        const saved = await store.saveStorefrontContent(candidate);
        return res.json({ content: saved });
      } catch (err) {
        return next(err);
      }
    }
  );

  // Storefront Settings Management
  app.get(
    '/api/admin/settings',
    requireOwner,
    async (_req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const settings = await store.getSiteSettings();
        return res.json({ settings });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.put(
    '/api/admin/settings',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const body = (req.body || {}) as Partial<SiteSettingsData>;
        const candidate = mergeSiteSettings(body);
        const fieldErrors: Record<string, string> = {};

        if (candidate.brandName.length < 2 || candidate.brandName.length > 80) {
          fieldErrors.brandName = 'Website name must be between 2 and 80 characters.';
        }
        if (candidate.tagline.length > 160) {
          fieldErrors.tagline = 'Tagline must be 160 characters or fewer.';
        }

        if (candidate.logoUrl) {
          const logoCheck = await verifySafeImageReference(store, candidate.logoUrl);
          if (!logoCheck.ok) {
            fieldErrors.logoUrl = logoCheck.error;
          }
        }

        if (
          candidate.contact.email &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.contact.email)
        ) {
          fieldErrors['contact.email'] = 'Please enter a valid concierge contact email address.';
        }

        if (
          candidate.contact.whatsappNumber &&
          candidate.contact.whatsappNumber.replace(/[^0-9]/g, '').length < 7
        ) {
          fieldErrors['contact.whatsappNumber'] =
            'WhatsApp / phone number must contain at least 7 digits (e.g. +91 98480 12345).';
        }

        const socialUrls: Array<{ key: string; label: string; url: string }> = [
          {
            key: 'socialLinks.instagramUrl',
            label: 'Instagram URL',
            url: candidate.socialLinks.instagramUrl,
          },
          {
            key: 'socialLinks.facebookUrl',
            label: 'Facebook URL',
            url: candidate.socialLinks.facebookUrl,
          },
          {
            key: 'socialLinks.pinterestUrl',
            label: 'Pinterest URL',
            url: candidate.socialLinks.pinterestUrl,
          },
          {
            key: 'socialLinks.youtubeUrl',
            label: 'YouTube URL',
            url: candidate.socialLinks.youtubeUrl,
          },
        ];
        for (const item of socialUrls) {
          if (item.url && !isSafeHttpUrl(item.url)) {
            fieldErrors[item.key] = `${item.label} must start with https:// or http://.`;
          }
        }

        if (Object.keys(fieldErrors).length > 0) {
          const firstMsg =
            Object.values(fieldErrors)[0] || 'Please review the highlighted boutique settings.';
          return sendJsonError(req, res, 400, 'VALIDATION_ERROR', firstMsg, fieldErrors);
        }

        const saved = await store.saveSiteSettings(candidate);
        return res.json({ settings: saved });
      } catch (err) {
        return next(err);
      }
    }
  );

  // Contact / Customer Messages Inbox
  app.get(
    '/api/admin/messages',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const status = typeof req.query.status === 'string' ? req.query.status.trim() : 'all';
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const pageSize = Math.min(
          50,
          Math.max(1, Number.parseInt(String(req.query.pageSize || '15'), 10) || 15)
        );

        const result = await store.listAdminMessages({ status, q, page, pageSize });
        return res.json({
          items: result.items.map((m) => serializeContactMessage(m)),
          total: result.total,
          unreadCount: result.unreadCount,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.patch(
    '/api/admin/messages/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const allowedStatuses = new Set<ContactMessageStatus>([
          'unread',
          'read',
          'replied',
          'archived',
        ]);
        const status =
          typeof req.body?.status === 'string'
            ? (req.body.status.trim() as ContactMessageStatus)
            : undefined;
        if (status !== undefined && !allowedStatuses.has(status)) {
          return sendJsonError(
            req,
            res,
            400,
            'VALIDATION_ERROR',
            'Invalid message status.',
            { status: 'Invalid message status.' }
          );
        }

        let adminNote: string | undefined;
        if (typeof req.body?.adminNote === 'string') {
          const trimmedNote = req.body.adminNote.trim();
          if (trimmedNote.length > 1000) {
            const msg = 'Internal studio note must be 1000 characters or fewer.';
            return sendJsonError(req, res, 400, 'VALIDATION_ERROR', msg, { adminNote: msg });
          }
          adminNote = trimmedNote;
        }

        const updated = await store.updateContactMessage(id, { status, adminNote });
        if (!updated) {
          return sendJsonError(req, res, 404, 'MESSAGE_NOT_FOUND', 'Message not found.');
        }

        return res.json({ message: serializeContactMessage(updated) });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.delete(
    '/api/admin/messages/:id',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        const deleted = await store.deleteContactMessage(id);
        if (!deleted) {
          return sendJsonError(req, res, 404, 'MESSAGE_NOT_FOUND', 'Message not found.');
        }
        return res.json({ deletedId: id, message: 'Message deleted.' });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.get(
    '/api/admin/audit',
    requireOwner,
    async (req: AuthedCatalogRequest, res: Response, next: NextFunction) => {
      try {
        const productId =
          typeof req.query.productId === 'string' ? req.query.productId.trim() : '';
        const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
        const pageSize = Math.min(
          50,
          Math.max(1, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20)
        );

        const result = await store.listAuditLogs({ productId, page, pageSize });
        return res.json({
          items: result.items.map((a) => ({
            id: a.id,
            productId: a.product_id,
            productTitle: a.product_title,
            actorUserId: a.actor_user_id,
            action: a.action,
            summary: a.summary,
            before: a.before_json ? parseJsonSafe(a.before_json, null) : null,
            after: a.after_json ? parseJsonSafe(a.after_json, null) : null,
            createdAt: a.created_at,
          })),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  app.use(
    '/boutique-media',
    express.static('public/boutique-media', {
      maxAge: '7d',
      fallthrough: true,
    })
  );
  app.use(
    '/boutique-media',
    express.static('src/assets/images', {
      maxAge: '7d',
      fallthrough: true,
    })
  );
  app.use('/boutique-media', (_req, res) => {
    res.status(404).end();
  });
}
