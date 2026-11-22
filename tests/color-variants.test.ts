import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createAuthApp } from '../server/app.ts';
import { bindOwnerAccount } from '../server/db.ts';
import type { EmailMessage, EmailSender } from '../server/providers.ts';
import type { Product } from '../src/types/boutique.ts';
import {
  countActiveColors,
  getColorGalleryImages,
  getVariantThumbnailUrl,
  normalizeProductColors,
  resolveInitialColorSelection,
  resolveSizeAfterColorSwitch,
  slugifyColorKey,
  validateColorVariantMatrix,
} from '../src/utils/colorVariants.ts';

class CookieJar {
  private store = new Map<string, string>();

  updateFromResponse(res: Response) {
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const cookieStr of setCookies) {
      const [pair] = cookieStr.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (!val) {
        this.store.delete(name);
      } else {
        this.store.set(name, val);
      }
    }
  }

  getHeader(): string {
    return Array.from(this.store.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

function extractToken(htmlOrText: string): string {
  const match = htmlOrText.match(/[?&]token=([^"&\s<]+)/);
  assert.ok(match, 'Expected token query param in email payload');
  return decodeURIComponent(match[1]);
}

// ---------------------------------------------------------------------------
// 1. Pure Unit Tests for Color Variant Engine (src/utils/colorVariants.ts)
// ---------------------------------------------------------------------------

function makeMultiColorFixture(): Product {
  return {
    id: 'prod-anarkali',
    name: 'Festive Silk Anarkali Set',
    category: 'Festive Wear',
    price: 3499,
    pricePaise: 349900,
    compareAtPrice: 4499,
    compareAtPaise: 449900,
    description: 'Handcrafted silk anarkali with organza dupatta.',
    fabricNote: 'Pure silk-blend with mulmul lining',
    stockQty: 9,
    inStock: true,
    featured: true,
    dateAdded: '2026-11-21',
    colors: [
      {
        id: 'clr-teal-pink',
        name: 'Teal & Pink',
        hex: '#1E6B7B',
        thumbnailUrl: '/assets/teal-thumb.jpg',
        position: 0,
        active: true,
      },
      {
        id: 'clr-mustard-gold',
        name: 'Mustard Gold',
        hex: '#C8962E',
        thumbnailUrl: '/assets/mustard-thumb.jpg',
        position: 1,
        active: true,
      },
      {
        id: 'clr-crimson-soldout',
        name: 'Crimson Red',
        hex: '#9E1B32',
        thumbnailUrl: '/assets/crimson-thumb.jpg',
        position: 2,
        active: true,
      },
      {
        id: 'clr-hidden-plum',
        name: 'Hidden Plum',
        hex: '#49243E',
        thumbnailUrl: '/assets/plum-thumb.jpg',
        position: 3,
        active: false,
      },
    ],
    images: [
      {
        id: 'img-t1',
        src: '/assets/teal-thumb.jpg',
        alt: 'Teal & Pink front',
        isCover: true,
        colorId: 'clr-teal-pink',
        position: 0,
      },
      {
        id: 'img-t2',
        src: '/assets/teal-back.jpg',
        alt: 'Teal & Pink back',
        isCover: false,
        colorId: 'clr-teal-pink',
        position: 1,
      },
      {
        id: 'img-m1',
        src: '/assets/mustard-thumb.jpg',
        alt: 'Mustard Gold front',
        isCover: false,
        colorId: 'clr-mustard-gold',
        position: 2,
      },
      {
        id: 'img-m2',
        src: '/assets/mustard-detail.jpg',
        alt: 'Mustard Gold detail',
        isCover: false,
        colorId: 'clr-mustard-gold',
        position: 3,
      },
      {
        id: 'img-c1',
        src: '/assets/crimson-thumb.jpg',
        alt: 'Crimson front',
        isCover: false,
        colorId: 'clr-crimson-soldout',
        position: 4,
      },
    ],
    sizes: ['S', 'M', 'L'],
    variants: [
      {
        id: 'var-tp-s',
        sku: 'SC-ANR-TP-S',
        size: 'S',
        colorId: 'clr-teal-pink',
        colorName: 'Teal & Pink',
        colorHex: '#1E6B7B',
        pricePaise: 349900,
        compareAtPaise: 449900,
        stockQty: 3,
        active: true,
        position: 0,
      },
      {
        id: 'var-tp-m',
        sku: 'SC-ANR-TP-M',
        size: 'M',
        colorId: 'clr-teal-pink',
        colorName: 'Teal & Pink',
        colorHex: '#1E6B7B',
        pricePaise: 349900,
        compareAtPaise: 449900,
        stockQty: 2,
        active: true,
        position: 1,
      },
      {
        id: 'var-mg-m',
        sku: 'SC-ANR-MG-M',
        size: 'M',
        colorId: 'clr-mustard-gold',
        colorName: 'Mustard Gold',
        colorHex: '#C8962E',
        pricePaise: 379900,
        priceOverridePaise: 379900,
        compareAtPaise: 449900,
        stockQty: 4,
        active: true,
        position: 2,
      },
      {
        id: 'var-mg-l',
        sku: 'SC-ANR-MG-L',
        size: 'L',
        colorId: 'clr-mustard-gold',
        colorName: 'Mustard Gold',
        colorHex: '#C8962E',
        pricePaise: 379900,
        priceOverridePaise: 379900,
        compareAtPaise: 449900,
        stockQty: 0,
        active: true,
        position: 3,
      },
      {
        id: 'var-cr-m',
        sku: 'SC-ANR-CR-M',
        size: 'M',
        colorId: 'clr-crimson-soldout',
        colorName: 'Crimson Red',
        colorHex: '#9E1B32',
        pricePaise: 349900,
        compareAtPaise: 449900,
        stockQty: 0,
        active: true,
        position: 4,
      },
      {
        id: 'var-hp-m',
        sku: 'SC-ANR-HP-M',
        size: 'M',
        colorId: 'clr-hidden-plum',
        colorName: 'Hidden Plum',
        colorHex: '#49243E',
        pricePaise: 349900,
        compareAtPaise: 449900,
        stockQty: 5,
        active: true,
        position: 5,
      },
    ],
  };
}

test('normalizeProductColors isolates per-colour galleries with zero cross-colour bleed', () => {
  const product = makeMultiColorFixture();
  const activeColors = normalizeProductColors(product);

  // Hidden Plum is inactive, so only 3 active colours appear to customers
  assert.equal(activeColors.length, 3);
  assert.equal(countActiveColors(product), 3);
  assert.deepEqual(
    activeColors.map((c) => c.name),
    ['Teal & Pink', 'Mustard Gold', 'Crimson Red']
  );

  // Strict per-colour image isolation
  const tealGallery = getColorGalleryImages(product, 'clr-teal-pink').map((i) => i.src);
  const mustardGallery = getColorGalleryImages(product, 'clr-mustard-gold').map((i) => i.src);
  assert.deepEqual(tealGallery, ['/assets/teal-thumb.jpg', '/assets/teal-back.jpg']);
  assert.deepEqual(mustardGallery, ['/assets/mustard-thumb.jpg', '/assets/mustard-detail.jpg']);
  assert.ok(!tealGallery.some((src) => src.includes('mustard')));
  assert.ok(!mustardGallery.some((src) => src.includes('teal')));

  // Sold-out colour still inspectable for customers
  const crimson = activeColors.find((c) => c.id === 'clr-crimson-soldout');
  assert.ok(crimson);
  assert.equal(crimson.isSoldOut, true);
  assert.equal(crimson.inStock, false);
  assert.equal(crimson.thumbnailUrl, '/assets/crimson-thumb.jpg');

  // Variant thumbnail lookup matches colour thumbnail
  assert.equal(
    getVariantThumbnailUrl(product, { colorId: 'clr-mustard-gold', colorName: 'Mustard Gold' }),
    '/assets/mustard-thumb.jpg'
  );
});

test('legacy single-colour products without colorId remain fully backward-compatible', () => {
  const legacyProduct: Product = {
    id: 'legacy-1',
    name: 'Ivory Flared Dress with Mauve Dupatta',
    category: 'Dresses',
    price: 2799,
    pricePaise: 279900,
    description: 'Classic single-colour catalog dress.',
    fabricNote: 'Cotton silk',
    stockQty: 6,
    inStock: true,
    featured: false,
    dateAdded: '2026-11-20',
    colors: [{ name: 'Ivory & Mauve', hex: '#F3EAE2' }],
    images: [
      { src: '/assets/ivory-1.jpg', alt: 'Ivory dress front', isCover: true },
      { src: '/assets/ivory-2.jpg', alt: 'Ivory dress detail', isCover: false },
    ],
    sizes: ['S', 'M'],
    variants: [
      {
        id: 'legacy-v1',
        sku: 'SC-IVR-S',
        size: 'S',
        colorName: 'Ivory & Mauve',
        colorHex: '#F3EAE2',
        pricePaise: 279900,
        compareAtPaise: null,
        stockQty: 3,
      },
      {
        id: 'legacy-v2',
        sku: 'SC-IVR-M',
        size: 'M',
        colorName: 'Ivory & Mauve',
        colorHex: '#F3EAE2',
        pricePaise: 279900,
        compareAtPaise: null,
        stockQty: 3,
      },
    ],
  };

  const options = normalizeProductColors(legacyProduct);
  assert.equal(options.length, 1);
  assert.equal(countActiveColors(legacyProduct), 1);
  assert.equal(options[0].name, 'Ivory & Mauve');
  assert.equal(options[0].thumbnailUrl, '/assets/ivory-1.jpg');
  assert.equal(options[0].images.length, 2);
  assert.equal(options[0].totalStock, 6);
});

test('resolveSizeAfterColorSwitch retains valid size, clears unavailable size, and auto-selects Free Size', () => {
  const product = makeMultiColorFixture();
  const colors = normalizeProductColors(product);
  const teal = colors[0];
  const mustard = colors[1];
  const crimson = colors[2];

  // Size M is active & in stock in Mustard Gold -> retained
  const keepM = resolveSizeAfterColorSwitch(mustard, 'M');
  assert.equal(keepM.nextSize, 'M');
  assert.equal(keepM.nextVariant?.id, 'var-mg-m');
  assert.equal(keepM.sizeCleared, false);

  // Size S does not exist in Mustard Gold -> cleared cleanly
  const clearS = resolveSizeAfterColorSwitch(mustard, 'S');
  assert.equal(clearS.nextSize, '');
  assert.equal(clearS.nextVariant, null);
  assert.equal(clearS.sizeCleared, true);

  // Size L is stock 0 in Mustard Gold -> cleared cleanly
  const clearSoldOutL = resolveSizeAfterColorSwitch(mustard, 'L');
  assert.equal(clearSoldOutL.nextSize, '');
  assert.equal(clearSoldOutL.nextVariant, null);
  assert.equal(clearSoldOutL.sizeCleared, true);

  // Switching to completely sold-out colour clears selection
  const clearOnSoldOutColor = resolveSizeAfterColorSwitch(crimson, 'M');
  assert.equal(clearOnSoldOutColor.nextSize, '');
  assert.equal(clearOnSoldOutColor.sizeCleared, true);

  // Switching back to Teal with S -> retains S
  const backToTeal = resolveSizeAfterColorSwitch(teal, 'S');
  assert.equal(backToTeal.nextSize, 'S');
  assert.equal(backToTeal.nextVariant?.id, 'var-tp-s');

  // Single 'Free Size' variant auto-selects when in stock
  const freeSizeProduct: Product = {
    ...product,
    colors: [{ id: 'clr-free', name: 'Emerald', hex: '#0E5A46', active: true }],
    variants: [
      {
        id: 'var-free',
        sku: 'SC-FREE-1',
        size: 'Free Size',
        colorId: 'clr-free',
        colorName: 'Emerald',
        colorHex: '#0E5A46',
        pricePaise: 299900,
        compareAtPaise: null,
        stockQty: 4,
        active: true,
      },
    ],
  };
  const [freeColor] = normalizeProductColors(freeSizeProduct);
  const freeResult = resolveSizeAfterColorSwitch(freeColor, 'M');
  assert.equal(freeResult.nextSize, 'Free Size');
  assert.equal(freeResult.nextVariant?.id, 'var-free');
  assert.equal(freeResult.sizeCleared, false);
});

test('resolveInitialColorSelection honors ?color= and ?variant= deep-links and handles sold-out/inactive gracefully', () => {
  const product = makeMultiColorFixture();

  // Multi-word colour slug deep link
  assert.equal(slugifyColorKey('Teal & Pink'), 'teal-and-pink');
  const byColorSlug = resolveInitialColorSelection(product, { colorParam: 'mustard-gold' });
  assert.equal(byColorSlug.colorId, 'clr-mustard-gold');
  assert.equal(byColorSlug.variant?.id, 'var-mg-m');
  assert.equal(byColorSlug.linkedVariantSoldOut, false);

  // Variant SKU deep link (in-stock)
  const bySku = resolveInitialColorSelection(product, { variantParam: 'SC-ANR-TP-M' });
  assert.equal(bySku.colorId, 'clr-teal-pink');
  assert.equal(bySku.size, 'M');
  assert.equal(bySku.variant?.id, 'var-tp-m');

  // Variant SKU deep link (sold-out)
  const bySoldOutSku = resolveInitialColorSelection(product, { variantParam: 'SC-ANR-MG-L' });
  assert.equal(bySoldOutSku.colorId, 'clr-mustard-gold');
  assert.equal(bySoldOutSku.size, '');
  assert.equal(bySoldOutSku.linkedVariantSoldOut, true);

  // Variant belonging to inactive colour -> falls back to active default & flags linkedVariantUnavailable
  const byInactiveSku = resolveInitialColorSelection(product, { variantParam: 'SC-ANR-HP-M' });
  assert.equal(byInactiveSku.colorId, 'clr-teal-pink');
  assert.equal(byInactiveSku.linkedVariantUnavailable, true);
});

test('validateColorVariantMatrix enforces uniqueness, positive pricing, non-negative stock, and publish completeness', () => {
  // Duplicate colour names rejected
  const dupColor = validateColorVariantMatrix({
    status: 'draft',
    colors: [
      { id: 'c1', name: 'Teal & Pink', active: true },
      { id: 'c2', name: 'teal & pink', active: true },
    ],
    images: [],
    variants: [{ colorId: 'c1', colorName: 'Teal & Pink', size: 'M', pricePaise: 249900, stockQty: 2 }],
  });
  assert.equal(dupColor.ok, false);
  assert.ok(dupColor.fieldErrors.colors);

  // Duplicate (colour, size) rejected
  const dupCombo = validateColorVariantMatrix({
    status: 'draft',
    colors: [{ id: 'c1', name: 'Teal & Pink', active: true }],
    images: [],
    variants: [
      { colorId: 'c1', colorName: 'Teal & Pink', size: 'M', sku: 'A-1', pricePaise: 249900, stockQty: 2 },
      { colorId: 'c1', colorName: 'Teal & Pink', size: 'm', sku: 'A-2', pricePaise: 249900, stockQty: 3 },
    ],
  });
  assert.equal(dupCombo.ok, false);
  assert.ok(dupCombo.fieldErrors.variants);

  // Negative stock rejected
  const negStock = validateColorVariantMatrix({
    status: 'draft',
    colors: [{ id: 'c1', name: 'Teal & Pink', active: true }],
    images: [],
    variants: [{ colorId: 'c1', colorName: 'Teal & Pink', size: 'M', pricePaise: 249900, stockQty: -1 }],
  });
  assert.equal(negStock.ok, false);

  // Multi-colour publish blocked if an active colour lacks an image, but draft allowed
  const incompleteInput = {
    colors: [
      { id: 'c1', name: 'Teal & Pink', active: true },
      { id: 'c2', name: 'Mustard Gold', active: true },
    ],
    images: [{ url: '/assets/teal.jpg', colorId: 'c1', isCover: true }],
    variants: [
      { colorId: 'c1', colorName: 'Teal & Pink', size: 'M', sku: 'T-M', pricePaise: 249900, stockQty: 2 },
      { colorId: 'c2', colorName: 'Mustard Gold', size: 'M', sku: 'M-M', pricePaise: 249900, stockQty: 2 },
    ],
  };
  assert.equal(validateColorVariantMatrix({ ...incompleteInput, status: 'draft' }).ok, true);
  const publishCheck = validateColorVariantMatrix({ ...incompleteInput, status: 'published' });
  assert.equal(publishCheck.ok, false);
  assert.ok(publishCheck.fieldErrors.images?.includes('Mustard Gold'));
});

// ---------------------------------------------------------------------------
// 2. Full-Stack API & SQLiteStore Integration Tests
// ---------------------------------------------------------------------------

let tmpDir = '';
let dbPath = '';
let server: http.Server;
let baseUrl = '';
let sentEmails: EmailMessage[] = [];
let appInstance: ReturnType<typeof createAuthApp>;

const testEmailSender: EmailSender = {
  isConfigured: () => true,
  sendEmail: async (msg) => {
    sentEmails.push(msg);
  },
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-color-variants-'));
  dbPath = path.join(tmpDir, 'boutique.db');
  appInstance = createAuthApp({
    dbPath,
    emailSender: testEmailSender,
    disableRateLimit: true,
    appBaseUrl: 'http://127.0.0.1:3000',
    seedCatalog: true,
  });
  server = http.createServer(appInstance.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  try {
    appInstance.db?.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getSession(jar: CookieJar) {
  const res = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jar.getHeader() ? { Cookie: jar.getHeader() } : undefined,
  });
  jar.updateFromResponse(res);
  return (await res.json()) as {
    csrfToken: string;
    authenticated: boolean;
    user: Record<string, unknown> | null;
  };
}

async function jsonReq(
  jar: CookieJar,
  method: string,
  reqPath: string,
  body: unknown,
  csrfToken: string
) {
  const headers: Record<string, string> = {
    'X-CSRF-Token': csrfToken,
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }
  if (jar.getHeader()) {
    headers.Cookie = jar.getHeader();
  }
  const res = await fetch(`${baseUrl}${reqPath}`, {
    method,
    headers,
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  jar.updateFromResponse(res);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, json };
}

async function registerVerifiedUser(jar: CookieJar, name: string, email: string, password: string) {
  const { csrfToken } = await getSession(jar);
  const startLen = sentEmails.length;
  const reg = await jsonReq(
    jar,
    'POST',
    '/api/auth/register',
    { fullName: name, email, password, confirmPassword: password },
    csrfToken
  );
  assert.equal(reg.res.status, 200, `Register failed: ${JSON.stringify(reg.json)}`);
  const verifyEmail = sentEmails.slice(startLen).find((m) => m.to.toLowerCase() === email.toLowerCase());
  assert.ok(verifyEmail, 'Expected verification email');
  const token = extractToken(verifyEmail.text || verifyEmail.html);
  const verified = await jsonReq(jar, 'POST', '/api/auth/verify-email', { token }, csrfToken);
  assert.equal(verified.res.status, 200);
  const session = await getSession(jar);
  return { csrfToken: session.csrfToken, userId: String((session.user as { id: string }).id) };
}

test('End-to-end multi-colour product authoring, cart validation, checkout, historical snapshot immutability, and race safety', async () => {
  const adminJar = new CookieJar();
  const customerJar = new CookieJar();

  const adminAuth = await registerVerifiedUser(
    adminJar,
    'Sahithi Owner',
    'owner-cv@sahithi.test',
    'StrongPass!2026'
  );
  assert.ok(appInstance.db);
  bindOwnerAccount(appInstance.db, { email: 'owner-cv@sahithi.test' });
  const adminSession = await getSession(adminJar);

  const customerAuth = await registerVerifiedUser(
    customerJar,
    'Ananya Customer',
    'ananya-cv@sahithi.test',
    'StrongPass!2026'
  );

  // 1. Publishing multi-colour product with missing photo for one active colour is blocked (400)
  const incompletePublish = await jsonReq(
    adminJar,
    'POST',
    '/api/admin/products',
    {
      title: 'Kalamkari Flared Anarkali',
      category: 'Dresses',
      sku: 'SC-KLM-01',
      description: 'Hand-printed Kalamkari flared anarkali with tissue dupatta.',
      fabricNote: 'Cotton silk',
      pricePaise: 320000,
      status: 'published',
      colors: [
        { id: 'clr-teal-pink', name: 'Teal & Pink', hex: '#1E6B7B', position: 0, active: true },
        { id: 'clr-mustard', name: 'Mustard Gold', hex: '#C8962E', position: 1, active: true },
      ],
      images: [
        { url: '/boutique-media/teal-front.jpg', alt: 'Teal front', isCover: true, colorId: 'clr-teal-pink' },
      ],
      variants: [
        {
          sku: 'SC-KLM-TP-M',
          size: 'M',
          colorId: 'clr-teal-pink',
          colorName: 'Teal & Pink',
          colorHex: '#1E6B7B',
          pricePaise: 320000,
          stockQty: 3,
          active: true,
        },
        {
          sku: 'SC-KLM-MG-M',
          size: 'M',
          colorId: 'clr-mustard',
          colorName: 'Mustard Gold',
          colorHex: '#C8962E',
          pricePaise: 350000,
          priceOverridePaise: 350000,
          stockQty: 2,
          active: true,
        },
      ],
    },
    adminSession.csrfToken
  );
  assert.equal(incompletePublish.res.status, 400);

  // 2. Saving complete multi-colour product (including an inactive colour + inactive variant + sold-out variant)
  const createRes = await jsonReq(
    adminJar,
    'POST',
    '/api/admin/products',
    {
      title: 'Kalamkari Flared Anarkali',
      category: 'Dresses',
      sku: 'SC-KLM-01',
      description: 'Hand-printed Kalamkari flared anarkali with tissue dupatta.',
      fabricNote: 'Cotton silk',
      pricePaise: 320000,
      status: 'published',
      colors: [
        {
          id: 'clr-teal-pink',
          name: 'Teal & Pink',
          hex: '#1E6B7B',
          thumbnailUrl: '/boutique-media/teal-front.jpg',
          position: 0,
          active: true,
        },
        {
          id: 'clr-mustard',
          name: 'Mustard Gold',
          hex: '#C8962E',
          thumbnailUrl: '/boutique-media/mustard-front.jpg',
          position: 1,
          active: true,
        },
        {
          id: 'clr-archived-olive',
          name: 'Olive Mist',
          hex: '#5F6F52',
          thumbnailUrl: '/boutique-media/olive-front.jpg',
          position: 2,
          active: false,
        },
      ],
      images: [
        { url: '/boutique-media/teal-front.jpg', alt: 'Teal front', isCover: true, colorId: 'clr-teal-pink' },
        { url: '/boutique-media/teal-back.jpg', alt: 'Teal back', isCover: false, colorId: 'clr-teal-pink' },
        { url: '/boutique-media/mustard-front.jpg', alt: 'Mustard front', isCover: false, colorId: 'clr-mustard' },
        { url: '/boutique-media/olive-front.jpg', alt: 'Olive front', isCover: false, colorId: 'clr-archived-olive' },
      ],
      variants: [
        {
          sku: 'SC-KLM-TP-M',
          size: 'M',
          colorId: 'clr-teal-pink',
          colorName: 'Teal & Pink',
          colorHex: '#1E6B7B',
          pricePaise: 320000,
          stockQty: 3,
          active: true,
        },
        {
          sku: 'SC-KLM-TP-L',
          size: 'L',
          colorId: 'clr-teal-pink',
          colorName: 'Teal & Pink',
          colorHex: '#1E6B7B',
          pricePaise: 320000,
          stockQty: 5,
          active: false,
        },
        {
          sku: 'SC-KLM-MG-M',
          size: 'M',
          colorId: 'clr-mustard',
          colorName: 'Mustard Gold',
          colorHex: '#C8962E',
          pricePaise: 350000,
          priceOverridePaise: 350000,
          stockQty: 1,
          active: true,
        },
        {
          sku: 'SC-KLM-MG-XL',
          size: 'XL',
          colorId: 'clr-mustard',
          colorName: 'Mustard Gold',
          colorHex: '#C8962E',
          pricePaise: 350000,
          priceOverridePaise: 350000,
          stockQty: 0,
          active: true,
        },
        {
          sku: 'SC-KLM-OL-M',
          size: 'M',
          colorId: 'clr-archived-olive',
          colorName: 'Olive Mist',
          colorHex: '#5F6F52',
          pricePaise: 320000,
          stockQty: 4,
          active: true,
        },
      ],
    },
    adminSession.csrfToken
  );
  assert.equal(createRes.res.status, 201, `Create failed: ${JSON.stringify(createRes.json)}`);
  const createdProduct = createRes.json.product as {
    id: string;
    version: number;
    stockQty: number;
    variants: Array<{ id: string; sku: string; colorId: string; pricePaise: number; active: boolean }>;
  };

  // Only active variants of active colours (3 + 1 = 4) should be counted, not inactive L(5) or inactive colour Olive(4)
  assert.equal(createdProduct.stockQty, 4);

  const varTealM = createdProduct.variants.find((v) => v.sku === 'SC-KLM-TP-M')!;
  const varTealLInactive = createdProduct.variants.find((v) => v.sku === 'SC-KLM-TP-L')!;
  const varMustardM = createdProduct.variants.find((v) => v.sku === 'SC-KLM-MG-M')!;
  const varMustardXLSoldOut = createdProduct.variants.find((v) => v.sku === 'SC-KLM-MG-XL')!;
  const varOliveInactiveColor = createdProduct.variants.find((v) => v.sku === 'SC-KLM-OL-M')!;

  // 3. Public catalog returns 1 parent product card with colour metadata intact
  const publicRes = await fetch(`${baseUrl}/api/products`);
  assert.equal(publicRes.status, 200);
  const publicData = (await publicRes.json()) as { products: Product[] };
  const listed = publicData.products.filter((p) => p.id === createdProduct.id);
  assert.equal(listed.length, 1);
  assert.equal(countActiveColors(listed[0]), 2);

  // 4. Cart validation distinguishes variants, returns colour thumbnails & price overrides, and rejects inactive/sold-out
  const cartVal = await jsonReq(
    customerJar,
    'POST',
    '/api/cart/validate',
    {
      items: [
        { productId: createdProduct.id, variantId: varTealM.id, quantity: 1 },
        { productId: createdProduct.id, variantId: varMustardM.id, quantity: 1 },
        { productId: createdProduct.id, variantId: varTealLInactive.id, quantity: 1 },
        { productId: createdProduct.id, variantId: varOliveInactiveColor.id, quantity: 1 },
        { productId: createdProduct.id, variantId: varMustardXLSoldOut.id, quantity: 1 },
      ],
    },
    customerAuth.csrfToken
  );
  assert.equal(cartVal.res.status, 200);
  const validatedItems = cartVal.json.items as Array<{
    variantId: string;
    available: boolean;
    imageUrl: string;
    colorName: string;
    size: string;
    unitPricePaise: number;
  }>;
  assert.equal(validatedItems.length, 5);
  assert.equal(validatedItems[0].available, true);
  assert.equal(validatedItems[0].imageUrl, '/boutique-media/teal-front.jpg');
  assert.equal(validatedItems[0].colorName, 'Teal & Pink');
  assert.equal(validatedItems[0].unitPricePaise, 320000);

  assert.equal(validatedItems[1].available, true);
  assert.equal(validatedItems[1].imageUrl, '/boutique-media/mustard-front.jpg');
  assert.equal(validatedItems[1].colorName, 'Mustard Gold');
  assert.equal(validatedItems[1].unitPricePaise, 350000);

  // Inactive variant, inactive colour, and sold-out variant are marked unavailable
  assert.equal(validatedItems[2].available, false);
  assert.equal(validatedItems[3].available, false);
  assert.equal(validatedItems[4].available, false);

  const validAddress = {
    fullName: 'Ananya Reddy',
    phone: '9876543210',
    line1: '12 Jubilee Hills Road',
    city: 'Hyderabad',
    state: 'Telangana',
    pincode: '500033',
  };

  // 5. Server rejects checkout for inactive variant, inactive colour, and tampered client price
  const inactiveVarOrder = await jsonReq(
    customerJar,
    'POST',
    '/api/orders',
    {
      idempotencyKey: 'idem-inactive-var',
      address: validAddress,
      items: [{ productId: createdProduct.id, variantId: varTealLInactive.id, quantity: 1 }],
    },
    customerAuth.csrfToken
  );
  assert.equal(inactiveVarOrder.res.status, 409);
  assert.equal(inactiveVarOrder.json.code, 'VARIANT_UNAVAILABLE');

  const inactiveColorOrder = await jsonReq(
    customerJar,
    'POST',
    '/api/orders',
    {
      idempotencyKey: 'idem-inactive-color',
      address: validAddress,
      items: [{ productId: createdProduct.id, variantId: varOliveInactiveColor.id, quantity: 1 }],
    },
    customerAuth.csrfToken
  );
  assert.equal(inactiveColorOrder.res.status, 409);
  assert.equal(inactiveColorOrder.json.code, 'VARIANT_UNAVAILABLE');

  const tamperedPriceOrder = await jsonReq(
    customerJar,
    'POST',
    '/api/orders',
    {
      idempotencyKey: 'idem-tampered-price',
      address: validAddress,
      items: [
        {
          productId: createdProduct.id,
          variantId: varMustardM.id,
          quantity: 1,
          expectedPricePaise: 10000,
        },
      ],
    },
    customerAuth.csrfToken
  );
  assert.equal(tamperedPriceOrder.res.status, 409);
  assert.equal(tamperedPriceOrder.json.code, 'PRICE_CHANGED');

  // 6. Place valid order for Teal & Pink / M (qty 1)
  const orderRes = await jsonReq(
    customerJar,
    'POST',
    '/api/orders',
    {
      idempotencyKey: 'idem-teal-order-1',
      address: validAddress,
      items: [
        {
          productId: createdProduct.id,
          variantId: varTealM.id,
          quantity: 1,
          expectedPricePaise: 320000,
        },
      ],
    },
    customerAuth.csrfToken
  );
  assert.equal(orderRes.res.status, 201, `Order failed: ${JSON.stringify(orderRes.json)}`);
  const placedOrder = orderRes.json.order as {
    id: string;
    orderNumber: string;
    items: Array<{
      productTitle: string;
      colorName: string;
      size: string;
      sku: string;
      imageUrl: string;
      unitPricePaise: number;
    }>;
  };
  assert.equal(placedOrder.items[0].colorName, 'Teal & Pink');
  assert.equal(placedOrder.items[0].size, 'M');
  assert.equal(placedOrder.items[0].sku, 'SC-KLM-TP-M');
  assert.equal(placedOrder.items[0].imageUrl, '/boutique-media/teal-front.jpg');
  assert.equal(placedOrder.items[0].unitPricePaise, 320000);

  // 7. Historical order snapshot immutability: admin edits colour name, price, image, and deactivates variant
  const adminRefresh = await jsonReq(
    adminJar,
    'GET',
    `/api/admin/products/${createdProduct.id}`,
    undefined,
    adminSession.csrfToken
  );
  assert.equal(adminRefresh.res.status, 200);
  const latestVersion = (adminRefresh.json.product as { version: number }).version;

  const updateRes = await jsonReq(
    adminJar,
    'PATCH',
    `/api/admin/products/${createdProduct.id}`,
    {
      expectedVersion: latestVersion,
      title: 'Kalamkari Flared Anarkali (Updated)',
      category: 'Dresses',
      sku: 'SC-KLM-01',
      description: 'Updated description after historical order placed.',
      fabricNote: 'Cotton silk',
      pricePaise: 410000,
      status: 'published',
      colors: [
        {
          id: 'clr-teal-pink',
          name: 'Peacock Teal',
          hex: '#005B66',
          thumbnailUrl: '/boutique-media/peacock-new.jpg',
          position: 0,
          active: false,
        },
        {
          id: 'clr-mustard',
          name: 'Mustard Gold',
          hex: '#C8962E',
          thumbnailUrl: '/boutique-media/mustard-front.jpg',
          position: 1,
          active: true,
        },
      ],
      images: [
        { url: '/boutique-media/peacock-new.jpg', alt: 'Peacock', isCover: false, colorId: 'clr-teal-pink' },
        { url: '/boutique-media/mustard-front.jpg', alt: 'Mustard', isCover: true, colorId: 'clr-mustard' },
      ],
      variants: [
        {
          id: varTealM.id,
          sku: 'SC-KLM-PT-M',
          size: 'M',
          colorId: 'clr-teal-pink',
          colorName: 'Peacock Teal',
          colorHex: '#005B66',
          pricePaise: 410000,
          stockQty: 2,
          active: false,
        },
        {
          id: varMustardM.id,
          sku: 'SC-KLM-MG-M',
          size: 'M',
          colorId: 'clr-mustard',
          colorName: 'Mustard Gold',
          colorHex: '#C8962E',
          pricePaise: 350000,
          priceOverridePaise: 350000,
          stockQty: 1,
          active: true,
        },
      ],
    },
    adminSession.csrfToken
  );
  assert.equal(updateRes.res.status, 200, `Update failed: ${JSON.stringify(updateRes.json)}`);

  // Verify customer order history still holds immutable original snapshot
  const customerOrdersRes = await jsonReq(
    customerJar,
    'GET',
    '/api/orders',
    undefined,
    customerAuth.csrfToken
  );
  assert.equal(customerOrdersRes.res.status, 200);
  const storedOrder = (
    customerOrdersRes.json.orders as Array<{
      id: string;
      items: Array<{
        productTitle: string;
        colorName: string;
        size: string;
        sku: string;
        imageUrl: string;
        unitPricePaise: number;
      }>;
    }>
  ).find((o) => o.id === placedOrder.id);
  assert.ok(storedOrder);
  assert.equal(storedOrder.items[0].productTitle, 'Kalamkari Flared Anarkali');
  assert.equal(storedOrder.items[0].colorName, 'Teal & Pink');
  assert.equal(storedOrder.items[0].size, 'M');
  assert.equal(storedOrder.items[0].sku, 'SC-KLM-TP-M');
  assert.equal(storedOrder.items[0].imageUrl, '/boutique-media/teal-front.jpg');
  assert.equal(storedOrder.items[0].unitPricePaise, 320000);

  // 8. Concurrent order race on last unit (Mustard Gold / M has stockQty = 1)
  const [raceA, raceB] = await Promise.all([
    jsonReq(
      customerJar,
      'POST',
      '/api/orders',
      {
        idempotencyKey: 'idem-race-a',
        address: validAddress,
        items: [
          {
            productId: createdProduct.id,
            variantId: varMustardM.id,
            quantity: 1,
            expectedPricePaise: 350000,
          },
        ],
      },
      customerAuth.csrfToken
    ),
    jsonReq(
      customerJar,
      'POST',
      '/api/orders',
      {
        idempotencyKey: 'idem-race-b',
        address: validAddress,
        items: [
          {
            productId: createdProduct.id,
            variantId: varMustardM.id,
            quantity: 1,
            expectedPricePaise: 350000,
          },
        ],
      },
      customerAuth.csrfToken
    ),
  ]);

  const statuses = [raceA.res.status, raceB.res.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  // Idempotent retry of the winning key returns 200/201 with same order and no negative stock
  const winnerKey = raceA.res.status === 201 ? 'idem-race-a' : 'idem-race-b';
  const winnerOrderId = (
    (raceA.res.status === 201 ? raceA.json.order : raceB.json.order) as { id: string }
  ).id;
  const replay = await jsonReq(
    customerJar,
    'POST',
    '/api/orders',
    {
      idempotencyKey: winnerKey,
      address: validAddress,
      items: [
        {
          productId: createdProduct.id,
          variantId: varMustardM.id,
          quantity: 1,
          expectedPricePaise: 350000,
        },
      ],
    },
    customerAuth.csrfToken
  );
  assert.equal(replay.res.status, 200);
  assert.equal((replay.json.order as { id: string }).id, winnerOrderId);

  // Confirm Mustard Gold / M stock is exactly 0 (never negative)
  const finalCheck = await jsonReq(
    adminJar,
    'GET',
    `/api/admin/products/${createdProduct.id}`,
    undefined,
    adminSession.csrfToken
  );
  const finalMustard = (
    (finalCheck.json.product as { variants: Array<{ id: string; stockQty: number }> }).variants
  ).find((v) => v.id === varMustardM.id);
  assert.equal(finalMustard?.stockQty, 0);
});
