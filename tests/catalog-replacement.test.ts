import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createAuthApp } from '../server/app.ts';
import {
  evaluateCutoverReadiness,
  executeCatalogCutover,
  importCatalogDrafts,
  listAllProductsInStore,
  loadCatalogManifest,
  rollbackCatalogFromBackup,
  verifyActiveCatalog,
  type CatalogBackupSnapshot,
} from '../server/catalog-cutover.ts';
import { bindOwnerAccount } from '../server/db.ts';
import type { EmailMessage, EmailSender } from '../server/providers.ts';

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
      if (!val) this.store.delete(name);
      else this.store.set(name, val);
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

let tmpDir = '';
let backupDir = '';
let dbPath = '';
let server: http.Server;
let baseUrl = '';
let sentEmails: EmailMessage[] = [];
let appInstance: ReturnType<typeof createAuthApp>;
let ownerJar: CookieJar;
let ownerCsrf = '';

const testEmailSender: EmailSender = {
  isConfigured: () => true,
  sendEmail: async (msg) => {
    sentEmails.push(msg);
  },
};

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
  const headers: Record<string, string> = { 'X-CSRF-Token': csrfToken };
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

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-catalog-cutover-'));
  backupDir = path.join(tmpDir, 'backups');
  dbPath = path.join(tmpDir, 'boutique.db');
  sentEmails = [];

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

  // Bootstrap and authenticate bound boutique owner
  ownerJar = new CookieJar();
  const ownerEmail = 'saivinodkotipalli2003@gmail.com';
  const ownerPass = 'CatalogCutover#2026!';
  const { csrfToken: preCsrf } = await getSession(ownerJar);
  const startLen = sentEmails.length;
  const reg = await jsonReq(
    ownerJar,
    'POST',
    '/api/auth/register',
    {
      fullName: 'Saivinod Kotipalli',
      email: ownerEmail,
      password: ownerPass,
      confirmPassword: ownerPass,
    },
    preCsrf
  );
  assert.equal(reg.res.status, 200);
  const msg = sentEmails.slice(startLen).find((m) => m.to.toLowerCase() === ownerEmail);
  assert.ok(msg, 'Verification email should be sent to owner');
  const token = extractToken(msg.text || msg.html);
  const verify = await jsonReq(ownerJar, 'POST', '/api/auth/verify-email', { token }, preCsrf);
  assert.equal(verify.res.status, 200);
  assert.ok(appInstance.db);
  bindOwnerAccount(appInstance.db, { email: ownerEmail, boundVia: 'cli_setup' });

  const login = await jsonReq(
    ownerJar,
    'POST',
    '/api/admin/login',
    { email: ownerEmail, password: ownerPass },
    String(verify.json.csrfToken || preCsrf)
  );
  assert.equal(login.res.status, 200);
  ownerCsrf = String(login.json.csrfToken);
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve()))
  );
  try {
    appInstance.db?.close();
  } catch {
    // Ignore already closed
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('1. Idempotent draft import stages 20 private drafts without duplicates, preserves admin edits, and leaves live catalog untouched', async () => {
  const manifest = loadCatalogManifest();
  assert.equal(manifest.products.length, 20);
  assert.equal(manifest.batchId, 'catalog-20261121-20');

  // Verify WA0008 single-product mapping and WA0028 non-AI photo requirement
  const wa0008 = manifest.products.filter((p) => p.sourceImageFilename === 'IMG-20261121-WA0008.jpg');
  assert.equal(wa0008.length, 1);
  assert.equal(wa0008[0].title, 'Pastel Green Kurta with Pink Dupatta');

  const wa0028 = manifest.products.find((p) => p.sourceImageFilename === 'IMG-20261121-WA0028.jpg');
  assert.ok(wa0028);
  assert.equal(wa0028.requiresNonAiPhotoConfirmation, true);
  assert.ok(wa0028.pendingFields.includes('realGarmentPhotoVerification'));

  // Capture live public catalog before import
  const publicBefore = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{ id: string; sku: string; slug: string }>;
  };
  assert.ok(publicBefore.items.length > 0, 'Expected legacy seeded storefront products before cutover');
  const legacyIdsBefore = publicBefore.items.map((p) => p.id).sort();

  // First draft import
  const firstImport = await importCatalogDrafts(appInstance.store, manifest, {
    actorUserId: 'test-owner',
  });
  assert.equal(firstImport.createdCount, 20);
  assert.equal(firstImport.preservedCount, 0);

  // Public storefront MUST remain completely untouched (zero drafts leaked)
  const publicAfterImport = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{ id: string }>;
  };
  assert.deepEqual(
    publicAfterImport.items.map((p) => p.id).sort(),
    legacyIdsBefore
  );

  // Admin edits one staged draft (SC-26-003): title, selling price, includedPieces, and stock
  const firstDraftId = firstImport.items.find((i) => i.sku === 'SC-26-003')!.productId;
  const adminGetRes = await fetch(`${baseUrl}/api/admin/products/${firstDraftId}`, {
    headers: { Cookie: ownerJar.getHeader() },
  });
  assert.equal(adminGetRes.status, 200);
  const adminDraft = ((await adminGetRes.json()) as {
    product: {
      id: string;
      version: number;
      sku: string;
      category: string;
      description: string;
      sourceImageFilename: string | null;
      pendingFields: string[];
    };
  }).product;
  assert.equal(adminDraft.sourceImageFilename, 'IMG-20261121-WA0003.jpg');
  assert.ok(adminDraft.pendingFields.includes('realGarmentPhotos'));

  const editRes = await jsonReq(
    ownerJar,
    'PATCH',
    `/api/admin/products/${firstDraftId}`,
    {
      expectedVersion: adminDraft.version,
      title: 'Ivory Flared Dress with Mauve Dupatta (Admin Confirmed Draft)',
      category: adminDraft.category,
      sku: adminDraft.sku,
      description: adminDraft.description,
      fabricNote: 'Georgette dress with organza dupatta',
      includedPieces: '1 Ivory Flared Dress + 1 Mauve Dupatta',
      careNote: 'Dry clean only',
      pricePaise: 329900,
      status: 'draft',
      variants: [
        {
          sku: 'SC-26-003-M',
          size: 'M',
          colorName: 'Ivory & Mauve',
          colorHex: '#F5EFE6',
          pricePaise: 329900,
          stockQty: 7,
        },
      ],
      images: [],
    },
    ownerCsrf
  );
  assert.equal(editRes.res.status, 200);

  // Second draft import MUST be idempotent: 0 duplicates, 20 preserved, admin edits intact
  const secondImport = await importCatalogDrafts(appInstance.store, manifest, {
    actorUserId: 'test-owner',
  });
  assert.equal(secondImport.createdCount, 0);
  assert.equal(secondImport.preservedCount, 20);

  const allAfterRerun = await listAllProductsInStore(appInstance.store);
  const batchItems = allAfterRerun.filter((r) => r.product.catalog_batch === manifest.batchId);
  assert.equal(batchItems.length, 20);

  const preservedDraft = batchItems.find((r) => r.product.id === firstDraftId);
  assert.ok(preservedDraft);
  assert.equal(
    preservedDraft.product.title,
    'Ivory Flared Dress with Mauve Dupatta (Admin Confirmed Draft)'
  );
  assert.equal(preservedDraft.product.price_paise, 329900);
  assert.equal(preservedDraft.product.stock_qty, 7);
  assert.equal(preservedDraft.product.included_pieces, '1 Ivory Flared Dress + 1 Mauve Dupatta');
  assert.equal(preservedDraft.product.care_note, 'Dry clean only');
});

test('2. Readiness gate blocks cutover when photos or commercial details are incomplete and leaves live catalog untouched', async () => {
  const manifest = loadCatalogManifest();
  const readiness = await evaluateCutoverReadiness(appInstance.store, manifest);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.totalExpected, 20);
  assert.equal(readiness.blockedCount, 20);

  // WA0028 must explicitly call out the non-AI real photo requirement
  const wa0028Report = readiness.items.find(
    (item) => item.sourceImageFilename === 'IMG-20261121-WA0028.jpg'
  );
  assert.ok(wa0028Report);
  assert.equal(wa0028Report.ready, false);
  assert.ok(
    wa0028Report.blockers.some((b) => /non-AI photograph/i.test(b)),
    'Expected WA0028 to flag non-AI garment photo blocker'
  );

  // Attempt cutover -> strictly blocked
  const cutoverAttempt = await executeCatalogCutover(appInstance.store, manifest, {
    actorUserId: 'test-owner',
    backupDir,
  });
  assert.equal(cutoverAttempt.ok, false);
  if (!cutoverAttempt.ok) {
    assert.equal(cutoverAttempt.code, 'CUTOVER_BLOCKED');
    assert.equal(cutoverAttempt.readiness.blockedCount, 20);
  }

  // Settings must NOT have suppressLegacySeed enabled yet
  const settings = await appInstance.store.getSiteSettings();
  assert.notEqual(settings.catalogControl?.suppressLegacySeed, true);
});

test('3. Full preview cutover replaces live catalog with exact 20 items, validates cart/checkout/admin sync, preserves historical orders, and rolls back safely', async () => {
  const manifest = loadCatalogManifest();

  // 3A. Place a pre-cutover COD order against an existing legacy product to verify order history survival
  const legacyPublic = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{
      id: string;
      slug: string;
      name: string;
      pricePaise: number;
      variants: Array<{ id: string; sku: string; pricePaise: number; stockQty: number }>;
    }>;
  };
  const legacyItem = legacyPublic.items[0];
  assert.ok(legacyItem);
  const legacyVariant = legacyItem.variants[0];
  assert.ok(legacyVariant);
  const legacySlugsBefore = legacyPublic.items.map((p) => p.slug);

  const shopperJar = new CookieJar();
  const { csrfToken: shopperCsrf } = await getSession(shopperJar);
  const preOrderRes = await jsonReq(
    shopperJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Kavya Reddy',
      customerEmail: 'kavya.legacy@example.com',
      customerPhone: '+91 9848011223',
      shippingAddress: '42 Banjara Hills Road 12, Hyderabad 500034',
      paymentMethod: 'cod',
      items: [
        {
          productId: legacyItem.id,
          variantId: legacyVariant.id,
          quantity: 1,
          expectedPricePaise: legacyVariant.pricePaise,
        },
      ],
    },
    shopperCsrf
  );
  assert.equal(preOrderRes.res.status, 201);
  const preCutoverOrder = preOrderRes.json.order as {
    id: string;
    totalPaise: number;
    items: Array<{ title: string; sku: string; unitPricePaise: number }>;
  };

  // 3B. Populate all 20 drafts in isolated test DB with approved garment photos & confirmed commercial details
  const allProducts = await listAllProductsInStore(appInstance.store);
  const byImportKey = new Map(
    allProducts
      .filter((r) => Boolean(r.product.import_key))
      .map((r) => [r.product.import_key!, r])
  );

  for (let i = 0; i < manifest.products.length; i += 1) {
    const m = manifest.products[i];
    const rec = byImportKey.get(m.importKey);
    assert.ok(rec, `Missing staged draft for ${m.importKey}`);

    const pricePaise = (2499 + i * 150) * 100;
    const compareAtPaise = pricePaise + 50000;
    const sizes = ['S', 'M', 'L'];
    const now = Date.now();
    const res = await appInstance.store.updateProduct({
      productId: rec.product.id,
      expectedVersion: rec.product.version,
      nextSlug: m.slug,
      title: m.title,
      description: m.description,
      fabricNote: 'Confirmed boutique fabric blend',
      includedPieces: m.category === 'Kurta Sets' ? 'Kurta, Bottom & Dupatta' : '1 Complete Outfit',
      careNote: 'Gentle dry clean recommended',
      category: m.category,
      sku: m.sku,
      pricePaise,
      compareAtPaise,
      totalStock: 12,
      lowStockThreshold: 3,
      featured: Boolean(m.featuredOnCutover),
      nextStatus: 'draft',
      colorsJson: JSON.stringify([m.defaultColor]),
      sizesJson: JSON.stringify(sizes),
      importKey: m.importKey,
      sourceImageFilename: m.sourceImageFilename,
      pendingFieldsJson: '[]',
      catalogBatch: manifest.batchId,
      publishedAtIfNull: null,
      now,
      variants: sizes.map((size, idx) => ({
        id: `${rec.product.id}-v-${size.toLowerCase()}`,
        product_id: rec.product.id,
        sku: `${m.sku}-${size}`,
        size,
        color_name: m.defaultColor.name,
        color_hex: m.defaultColor.hex,
        price_paise: pricePaise,
        compare_at_paise: compareAtPaise,
        stock_qty: 4,
        position: idx,
      })),
      images: [
        {
          mediaId: null,
          url: `/boutique-media/confirmed-${m.sku.toLowerCase()}.jpg`,
          alt: m.defaultImageAlt,
          isCover: true,
        },
      ],
      actorUserId: 'test-owner',
      auditAction: 'update',
      auditSummary: `Confirmed garment photo & pricing for ${m.sku}`,
      auditBefore: { status: rec.product.status, pricePaise: rec.product.price_paise },
      auditAfter: { status: 'draft', pricePaise, pendingFields: [] },
    });
    assert.equal(res.ok, true);
  }

  // Readiness must now pass for all 20
  const readyCheck = await evaluateCutoverReadiness(appInstance.store, manifest);
  assert.equal(readyCheck.ready, true);
  assert.equal(readyCheck.readyCount, 20);
  assert.equal(readyCheck.blockedCount, 0);

  // 3C. Execute cutover (with backup written to backupDir)
  const cutover = await executeCatalogCutover(appInstance.store, manifest, {
    actorUserId: 'test-owner',
    backupDir,
  });
  assert.equal(cutover.ok, true);
  if (!cutover.ok) throw new Error('Expected cutover to succeed');
  assert.equal(cutover.publishedCount, 20);
  assert.equal(cutover.archivedCount, legacyPublic.items.length);
  assert.ok(cutover.backupPath && fs.existsSync(cutover.backupPath), 'Backup JSON must exist on disk');

  const backupSnapshot = JSON.parse(
    fs.readFileSync(cutover.backupPath!, 'utf8')
  ) as CatalogBackupSnapshot;
  assert.equal(backupSnapshot.id, cutover.backupId);
  assert.ok(backupSnapshot.orderIdsAtBackup.includes(preCutoverOrder.id));

  // 3D. Verify active public catalog integrity
  const verification = await verifyActiveCatalog(
    appInstance.store,
    manifest,
    legacySlugsBefore
  );
  assert.equal(verification.ok, true, JSON.stringify(verification));
  assert.equal(verification.activeCount, 20);
  assert.equal(verification.missingImportKeys.length, 0);
  assert.equal(verification.unexpectedActiveIds.length, 0);
  assert.equal(verification.archivedSlugsStillPublic.length, 0);
  assert.equal(verification.categoryFilterMismatches.length, 0);
  assert.equal(verification.searchMismatches.length, 0);

  // Public HTTP checks: exact 20 items, new fields exposed, archived slug -> 404
  const publicNow = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{
      id: string;
      slug: string;
      name: string;
      category: string;
      includedPieces: string;
      careNote: string;
      pricePaise: number;
      variants: Array<{ id: string; sku: string; size: string; pricePaise: number; stockQty: number }>;
    }>;
  };
  assert.equal(publicNow.items.length, 20);
  assert.ok(publicNow.items.every((p) => p.variants[0]?.sku.startsWith('SC-26-')));
  assert.ok(publicNow.items.every((p) => p.includedPieces.length > 0 && p.careNote.length > 0));

  // Lehengas category filter returns the Coral Pink Lehenga
  const lehengasRes = (await (
    await fetch(`${baseUrl}/api/products?category=${encodeURIComponent('Lehengas')}`)
  ).json()) as { items: Array<{ slug: string; variants: Array<{ sku: string }> }> };
  assert.equal(lehengasRes.items.length, 1);
  assert.equal(lehengasRes.items[0].slug, 'coral-pink-lehenga-with-illustrated-border');
  assert.ok(lehengasRes.items[0].variants[0].sku.startsWith('SC-26-033'));

  // Archived legacy product slug returns 404
  const archivedDetailRes = await fetch(`${baseUrl}/api/products/${legacyItem.slug}`);
  assert.equal(archivedDetailRes.status, 404);

  // Storefront CMS content & settings updated cleanly (zero legacy images, suppressLegacySeed = true)
  const storefrontRes = (await (await fetch(`${baseUrl}/api/storefront`)).json()) as {
    settings: { catalogControl?: { suppressLegacySeed?: boolean; activeCatalogBatch?: string } };
    content: {
      hero: { mainImage: { src: string } };
      spotlightEdit: { image: { src: string } };
      lookbookEntries: Array<{ image: string }>;
    };
  };
  assert.equal(storefrontRes.settings.catalogControl?.suppressLegacySeed, true);
  assert.equal(storefrontRes.settings.catalogControl?.activeCatalogBatch, manifest.batchId);
  assert.match(storefrontRes.content.hero.mainImage.src, /\/boutique-media\/confirmed-sc-26-/);
  assert.match(storefrontRes.content.spotlightEdit.image.src, /\/boutique-media\/confirmed-sc-26-/);
  assert.ok(
    storefrontRes.content.lookbookEntries.every((entry) =>
      entry.image.includes('/boutique-media/confirmed-sc-26-')
    )
  );

  // 3E. Stale cart holding archived legacy item -> blocked in validation & checkout
  const staleCartVal = await jsonReq(
    shopperJar,
    'POST',
    '/api/cart/validate',
    {
      items: [
        {
          productId: legacyItem.id,
          variantId: legacyVariant.id,
          quantity: 1,
          seenPricePaise: legacyVariant.pricePaise,
        },
      ],
    },
    shopperCsrf
  );
  assert.equal(staleCartVal.res.status, 200);
  assert.equal(staleCartVal.json.hasUnavailable, true);

  const staleLegacyOrder = await jsonReq(
    shopperJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Kavya Reddy',
      customerEmail: 'kavya.stale@example.com',
      customerPhone: '+91 9848011223',
      shippingAddress: '42 Banjara Hills Road 12, Hyderabad 500034',
      paymentMethod: 'cod',
      items: [
        {
          productId: legacyItem.id,
          variantId: legacyVariant.id,
          quantity: 1,
          expectedPricePaise: legacyVariant.pricePaise,
        },
      ],
    },
    shopperCsrf
  );
  assert.equal(staleLegacyOrder.res.status, 409);
  assert.equal(staleLegacyOrder.json.code, 'PRODUCT_UNAVAILABLE');

  // 3F. Admin price/stock edit propagates to storefront + checkout guards + live order stock deduction
  const targetProd = publicNow.items.find((p) => p.slug === 'pink-floral-puff-sleeve-dress')!;
  const targetAdminBefore = ((await (
    await fetch(`${baseUrl}/api/admin/products/${targetProd.id}`, {
      headers: { Cookie: ownerJar.getHeader() },
    })
  ).json()) as {
    product: {
      id: string;
      version: number;
      name: string;
      category: string;
      sku: string;
      description: string;
      fabricNote: string;
      includedPieces: string;
      careNote: string;
      variants: Array<{
        id: string;
        sku: string;
        size: string;
        colorName: string;
        colorHex: string;
        pricePaise: number;
        stockQty: number;
      }>;
      rawImages: Array<{ url: string; alt: string; isCover: boolean }>;
    };
  }).product;

  const updatedPricePaise = 299900;
  const adminPatch = await jsonReq(
    ownerJar,
    'PATCH',
    `/api/admin/products/${targetProd.id}`,
    {
      expectedVersion: targetAdminBefore.version,
      title: targetAdminBefore.name,
      category: targetAdminBefore.category,
      sku: targetAdminBefore.sku,
      description: targetAdminBefore.description,
      fabricNote: targetAdminBefore.fabricNote,
      includedPieces: targetAdminBefore.includedPieces,
      careNote: targetAdminBefore.careNote,
      pricePaise: updatedPricePaise,
      status: 'published',
      variants: targetAdminBefore.variants.map((v) => ({
        ...v,
        pricePaise: updatedPricePaise,
        stockQty: v.size === 'M' ? 3 : v.stockQty,
      })),
      images: targetAdminBefore.rawImages.map((img) => ({
        url: img.url,
        alt: img.alt,
        isCover: img.isCover,
      })),
    },
    ownerCsrf
  );
  assert.equal(adminPatch.res.status, 200);

  const publicTargetAfterEdit = (await (
    await fetch(`${baseUrl}/api/products/${targetProd.slug}`)
  ).json()) as {
    product: {
      pricePaise: number;
      variants: Array<{ id: string; size: string; pricePaise: number; stockQty: number }>;
    };
  };
  assert.equal(publicTargetAfterEdit.product.pricePaise, updatedPricePaise);
  const variantM = publicTargetAfterEdit.product.variants.find((v) => v.size === 'M')!;
  assert.equal(variantM.stockQty, 3);

  // Stale expectedPricePaise -> 409 PRICE_CHANGED
  const stalePriceAttempt = await jsonReq(
    shopperJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Divya Sharma',
      customerEmail: 'divya@example.com',
      customerPhone: '+91 9848055667',
      shippingAddress: '10 Jubilee Hills, Hyderabad 500033',
      paymentMethod: 'cod',
      items: [
        {
          productId: targetProd.id,
          variantId: variantM.id,
          quantity: 1,
          expectedPricePaise: targetProd.pricePaise, // old price
        },
      ],
    },
    shopperCsrf
  );
  assert.equal(stalePriceAttempt.res.status, 409);
  assert.equal(stalePriceAttempt.json.code, 'PRICE_CHANGED');

  // Excess qty (4 > 3) -> 409 INSUFFICIENT_STOCK
  const overStockAttempt = await jsonReq(
    shopperJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Divya Sharma',
      customerEmail: 'divya@example.com',
      customerPhone: '+91 9848055667',
      shippingAddress: '10 Jubilee Hills, Hyderabad 500033',
      paymentMethod: 'cod',
      items: [
        {
          productId: targetProd.id,
          variantId: variantM.id,
          quantity: 4,
          expectedPricePaise: updatedPricePaise,
        },
      ],
    },
    shopperCsrf
  );
  assert.equal(overStockAttempt.res.status, 409);
  assert.equal(overStockAttempt.json.code, 'INSUFFICIENT_STOCK');

  // Valid order (qty 2) succeeds & decrements variant M stock 3 -> 1
  const postCutoverOrderRes = await jsonReq(
    shopperJar,
    'POST',
    '/api/orders',
    {
      customerName: 'Divya Sharma',
      customerEmail: 'divya@example.com',
      customerPhone: '+91 9848055667',
      shippingAddress: '10 Jubilee Hills, Hyderabad 500033',
      paymentMethod: 'cod',
      items: [
        {
          productId: targetProd.id,
          variantId: variantM.id,
          quantity: 2,
          expectedPricePaise: updatedPricePaise,
        },
      ],
    },
    shopperCsrf
  );
  assert.equal(postCutoverOrderRes.res.status, 201);
  const postCutoverOrder = postCutoverOrderRes.json.order as { id: string; totalPaise: number };
  assert.equal(postCutoverOrder.totalPaise, updatedPricePaise * 2);

  // Verify pre-cutover order history remains completely intact in Admin Orders
  const adminOrdersRes = (await (
    await fetch(`${baseUrl}/api/admin/orders`, {
      headers: { Cookie: ownerJar.getHeader() },
    })
  ).json()) as {
    items: Array<{
      id: string;
      totalPaise: number;
      items: Array<{ productTitle: string; sku: string; unitPricePaise: number }>;
    }>;
  };
  const historical = adminOrdersRes.items.find((o) => o.id === preCutoverOrder.id);
  assert.ok(historical, 'Pre-cutover order must remain intact');
  assert.equal(historical.totalPaise, legacyVariant.pricePaise);
  assert.equal(historical.items[0].productTitle, legacyItem.name);
  assert.equal(historical.items[0].sku, legacyVariant.sku);

  // 3G. Verified Rollback from pre-cutover backup preserves BOTH orders and post-cutover inventory deductions
  const rollback = await rollbackCatalogFromBackup(appInstance.store, backupSnapshot, {
    actorUserId: 'test-owner',
  });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.preservedOrdersCount, 2);
  assert.ok(
    rollback.adjustedInventoryVariantsCount >= 1,
    'Expected rollback to preserve post-cutover variant stock deduction'
  );

  // Previous legacy catalog is restored as active on GET /api/products
  const publicAfterRollback = (await (await fetch(`${baseUrl}/api/products`)).json()) as {
    items: Array<{ id: string; variants: Array<{ sku: string }> }>;
  };
  assert.equal(publicAfterRollback.items.length, legacyPublic.items.length);
  assert.ok(publicAfterRollback.items.some((p) => p.id === legacyItem.id));
  assert.ok(!publicAfterRollback.items.some((p) => p.variants[0]?.sku.startsWith('SC-26-')));

  // Settings restored (suppressLegacySeed no longer true)
  const settingsAfterRollback = await appInstance.store.getSiteSettings();
  assert.notEqual(settingsAfterRollback.catalogControl?.suppressLegacySeed, true);

  // Both orders still exist intact
  const ordersAfterRollback = await appInstance.store.listAdminOrders(1, 50);
  const orderIdsAfterRollback = new Set(ordersAfterRollback.items.map((o) => o.order.id));
  assert.ok(orderIdsAfterRollback.has(preCutoverOrder.id));
  assert.ok(orderIdsAfterRollback.has(postCutoverOrder.id));

  // Verify SC-26-004 variant M stock was NOT clobbered back up to pre-order backup stock (4 -> stays 1)
  const targetAfterRollback = await appInstance.store.getAdminProduct(targetProd.id);
  assert.ok(targetAfterRollback);
  assert.equal(targetAfterRollback.data.product.status, 'draft');
  const variantMAfterRollback = targetAfterRollback.data.variants.find((v) => v.id === variantM.id);
  assert.ok(variantMAfterRollback);
  assert.equal(variantMAfterRollback.stock_qty, 1);
});
