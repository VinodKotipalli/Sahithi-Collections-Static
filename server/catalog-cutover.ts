import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AdminProductRecord,
  BoutiqueStore,
  CategoryRow,
  ProductImageRow,
  ProductRow,
  ProductVariantRow,
  SiteSettingsData,
  StorefrontContentData,
} from './store.ts';
import { INITIAL_SEED_CATEGORIES } from './storefront-defaults.ts';

export interface CatalogManifestImage {
  url: string;
  alt: string;
  isCover?: boolean;
  mediaId?: string | null;
}

export interface CatalogManifestProduct {
  importKey: string;
  sourceImageFilename: string;
  sku: string;
  slug: string;
  title: string;
  category: string;
  featuredOnCutover?: boolean;
  description: string;
  defaultImageAlt: string;
  defaultColor: { name: string; hex: string };
  sellingPriceInr: number | null;
  compareAtInr: number | null;
  sizes: string[];
  variantStock: Record<string, number>;
  includedPieces: string;
  fabricNote: string;
  careNote: string;
  images: CatalogManifestImage[];
  requiresNonAiPhotoConfirmation?: boolean;
  imageComplianceNote?: string;
  pendingFields: string[];
}

export interface CatalogDraftManifest {
  batchId: string;
  storefront: string;
  firebaseProjectId: string;
  firestoreNamespace: string;
  notes?: string[];
  products: CatalogManifestProduct[];
}

export interface ProductReadinessReport {
  importKey: string;
  sourceImageFilename: string;
  sku: string;
  slug: string;
  title: string;
  category: string;
  productId: string | null;
  status: string | null;
  ready: boolean;
  blockers: string[];
  optionalPending: string[];
}

export interface CutoverReadinessSummary {
  batchId: string;
  ready: boolean;
  totalExpected: number;
  readyCount: number;
  blockedCount: number;
  items: ProductReadinessReport[];
}

export interface CatalogBackupProductSnapshot {
  product: ProductRow;
  variants: ProductVariantRow[];
  images: ProductImageRow[];
}

export interface CatalogBackupSnapshot {
  id: string;
  createdAt: number;
  batchId: string;
  targetEnv: string;
  backend: string;
  products: CatalogBackupProductSnapshot[];
  categories: CategoryRow[];
  siteSettings: SiteSettingsData;
  storefrontContent: StorefrontContentData;
  orderIdsAtBackup: string[];
}

export interface DraftImportResult {
  batchId: string;
  createdCount: number;
  preservedCount: number;
  backfilledMetadataCount: number;
  items: Array<{
    importKey: string;
    sourceImageFilename: string;
    productId: string;
    sku: string;
    slug: string;
    action: 'created' | 'preserved' | 'metadata_backfilled';
  }>;
}

export interface CutoverExecutionResult {
  ok: true;
  batchId: string;
  backupId: string;
  backupPath?: string;
  publishedCount: number;
  archivedCount: number;
  publishedIds: string[];
  archivedIds: string[];
}

export interface CutoverBlockedResult {
  ok: false;
  code: 'CUTOVER_BLOCKED';
  message: string;
  readiness: CutoverReadinessSummary;
}

export interface RollbackResult {
  ok: true;
  backupId: string;
  restoredProductsCount: number;
  draftedPostBackupProductsCount: number;
  preservedOrdersCount: number;
  adjustedInventoryVariantsCount: number;
}

export interface ActiveCatalogVerificationResult {
  ok: boolean;
  activeCount: number;
  expectedCount: number;
  missingImportKeys: string[];
  unexpectedActiveIds: string[];
  archivedSlugsStillPublic: string[];
  categoryFilterMismatches: string[];
  searchMismatches: string[];
}

const DEFAULT_MANIFEST_PATH = path.resolve(process.cwd(), 'data/catalog-20261121-drafts.json');
const SCREENSHOT_FILENAME_RE = /IMG-20261121-WA\d+/i;

function parsePendingFields(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export function loadCatalogManifest(manifestPath = DEFAULT_MANIFEST_PATH): CatalogDraftManifest {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as CatalogDraftManifest;
  if (!parsed || !Array.isArray(parsed.products) || parsed.products.length === 0) {
    throw new Error(`Invalid catalog manifest at ${manifestPath}: missing products array.`);
  }

  const seenImportKeys = new Set<string>();
  const seenSkus = new Set<string>();
  const seenSlugs = new Set<string>();
  const seenFiles = new Set<string>();

  for (const item of parsed.products) {
    if (!item.importKey || seenImportKeys.has(item.importKey)) {
      throw new Error(`Duplicate or missing importKey "${item.importKey}" in catalog manifest.`);
    }
    if (!item.sku || seenSkus.has(item.sku.toUpperCase())) {
      throw new Error(`Duplicate or missing SKU "${item.sku}" in catalog manifest.`);
    }
    if (!item.slug || seenSlugs.has(item.slug.toLowerCase())) {
      throw new Error(`Duplicate or missing slug "${item.slug}" in catalog manifest.`);
    }
    if (!item.sourceImageFilename || seenFiles.has(item.sourceImageFilename)) {
      throw new Error(
        `Duplicate or missing sourceImageFilename "${item.sourceImageFilename}" in catalog manifest.`
      );
    }
    seenImportKeys.add(item.importKey);
    seenSkus.add(item.sku.toUpperCase());
    seenSlugs.add(item.slug.toLowerCase());
    seenFiles.add(item.sourceImageFilename);
  }

  return parsed;
}

export async function listAllProductsInStore(store: BoutiqueStore): Promise<AdminProductRecord[]> {
  const statuses = ['published', 'draft', 'archived'] as const;
  const byId = new Map<string, AdminProductRecord>();
  for (const status of statuses) {
    let page = 1;
    while (true) {
      const res = await store.listAdminProducts({
        status,
        page,
        pageSize: 200,
        sort: 'updated',
      });
      for (const item of res.items) {
        byId.set(item.product.id, item);
      }
      if (page >= res.totalPages) break;
      page += 1;
    }
  }
  return Array.from(byId.values());
}

async function listAllOrdersInStore(store: BoutiqueStore) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await store.listAdminOrders(page, 200);
    all.push(...res.items);
    if (page >= res.totalPages) break;
    page += 1;
  }
  return all;
}

async function ensureManifestCategoriesExist(
  store: BoutiqueStore,
  manifest: CatalogDraftManifest
): Promise<void> {
  const existingCats = await store.listCategories();
  const byLowerName = new Set(existingCats.map((c) => c.name.toLowerCase()));
  const requiredNames = Array.from(new Set(manifest.products.map((p) => p.category)));
  let nextPos = existingCats.length;

  for (const name of requiredNames) {
    if (byLowerName.has(name.toLowerCase())) continue;
    const seedMatch = INITIAL_SEED_CATEGORIES.find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );
    await store.createCategory({
      name,
      subtitle: seedMatch?.subtitle || `Curated ${name.toLowerCase()} from Sahithi Collections`,
      imageUrl: seedMatch?.imageUrl || '',
      altText: seedMatch?.altText || `${name} collection`,
      position: seedMatch?.position ?? nextPos,
    });
    nextPos += 1;
    byLowerName.add(name.toLowerCase());
  }
}

function buildDraftVariantsFromManifest(
  productId: string,
  item: CatalogManifestProduct
): { variants: ProductVariantRow[]; sizes: string[]; pricePaise: number; compareAtPaise: number | null } {
  const pricePaise =
    typeof item.sellingPriceInr === 'number' && item.sellingPriceInr >= 1
      ? Math.round(item.sellingPriceInr * 100)
      : 100; // DB CHECK (price_paise >= 100) sentinel while draft awaits owner pricing
  const compareAtPaise =
    typeof item.compareAtInr === 'number' &&
    item.sellingPriceInr !== null &&
    item.compareAtInr > item.sellingPriceInr
      ? Math.round(item.compareAtInr * 100)
      : null;

  const sizes = item.sizes.length > 0 ? item.sizes : ['TBD'];
  const variants: ProductVariantRow[] = sizes.map((size, idx) => {
    const cleanSizeCode = size.replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase() || 'TBD';
    const stock =
      typeof item.variantStock?.[size] === 'number' && Number.isInteger(item.variantStock[size])
        ? Math.max(0, item.variantStock[size])
        : 0;
    return {
      id: `${productId}-v-${idx + 1}`,
      product_id: productId,
      sku: `${item.sku}-${cleanSizeCode}-${idx + 1}`,
      size,
      color_name: item.defaultColor.name,
      color_hex: item.defaultColor.hex,
      price_paise: pricePaise,
      compare_at_paise: compareAtPaise,
      stock_qty: stock,
      position: idx,
    };
  });

  return { variants, sizes, pricePaise, compareAtPaise };
}

/**
 * Idempotently creates private draft listings for every product in the manifest.
 * - Matches existing records by stable `import_key` (or fallback `sku`).
 * - Never creates duplicates on reruns.
 * - Never overwrites admin-edited fields, prices, images, statuses, or live inventory.
 */
export async function importCatalogDrafts(
  store: BoutiqueStore,
  manifest: CatalogDraftManifest,
  options?: { actorUserId?: string }
): Promise<DraftImportResult> {
  const actorUserId = options?.actorUserId || 'system-catalog-importer';
  await ensureManifestCategoriesExist(store, manifest);

  const existingAll = await listAllProductsInStore(store);
  const byImportKey = new Map<string, AdminProductRecord>();
  const bySku = new Map<string, AdminProductRecord>();
  for (const rec of existingAll) {
    if (rec.product.import_key) {
      byImportKey.set(rec.product.import_key, rec);
    }
    bySku.set(rec.product.sku.toUpperCase(), rec);
  }

  let createdCount = 0;
  let preservedCount = 0;
  let backfilledMetadataCount = 0;
  const items: DraftImportResult['items'] = [];

  for (const item of manifest.products) {
    const existing = byImportKey.get(item.importKey) || bySku.get(item.sku.toUpperCase());

    if (existing) {
      // Preserve all admin edits, prices, images, status, and live variant stock.
      // Only backfill missing import metadata if it was absent.
      const needsMetadataBackfill =
        !existing.product.import_key ||
        !existing.product.source_image_filename ||
        !existing.product.catalog_batch;

      if (needsMetadataBackfill) {
        const now = Date.now();
        await store.updateProduct({
          productId: existing.product.id,
          expectedVersion: existing.product.version,
          nextSlug: existing.product.slug,
          title: existing.product.title,
          description: existing.product.description,
          fabricNote: existing.product.fabric_note,
          includedPieces: existing.product.included_pieces ?? '',
          careNote: existing.product.care_note ?? '',
          category: existing.product.category,
          sku: existing.product.sku,
          pricePaise: existing.product.price_paise,
          compareAtPaise: existing.product.compare_at_paise,
          totalStock: existing.product.stock_qty,
          lowStockThreshold: existing.product.low_stock_threshold,
          featured: Boolean(existing.product.featured),
          nextStatus: existing.product.status,
          colorsJson: existing.product.colors_json,
          sizesJson: existing.product.sizes_json,
          importKey: existing.product.import_key || item.importKey,
          sourceImageFilename:
            existing.product.source_image_filename || item.sourceImageFilename,
          pendingFieldsJson: existing.product.pending_fields_json ?? null,
          catalogBatch: existing.product.catalog_batch || manifest.batchId,
          publishedAtIfNull: existing.product.published_at,
          now,
          variants: existing.variants,
          images: existing.images.map((img) => ({
            mediaId: img.media_id,
            url: img.url,
            alt: img.alt_text,
            isCover: Boolean(img.is_cover),
          })),
          actorUserId,
          auditAction: 'import_metadata_backfill',
          auditSummary: `Backfilled import key "${item.importKey}" while preserving existing admin edits and stock.`,
          auditBefore: { importKey: existing.product.import_key ?? null },
          auditAfter: { importKey: item.importKey, catalogBatch: manifest.batchId },
        });
        backfilledMetadataCount += 1;
        items.push({
          importKey: item.importKey,
          sourceImageFilename: item.sourceImageFilename,
          productId: existing.product.id,
          sku: existing.product.sku,
          slug: existing.product.slug,
          action: 'metadata_backfilled',
        });
      } else {
        preservedCount += 1;
        items.push({
          importKey: item.importKey,
          sourceImageFilename: item.sourceImageFilename,
          productId: existing.product.id,
          sku: existing.product.sku,
          slug: existing.product.slug,
          action: 'preserved',
        });
      }
      continue;
    }

    const now = Date.now();
    const productId = `sc-draft-${item.importKey}`;
    const slug = await store.makeUniqueSlug(item.slug);
    const { variants, sizes, pricePaise, compareAtPaise } = buildDraftVariantsFromManifest(
      productId,
      item
    );
    const totalStock = variants.reduce((sum, v) => sum + v.stock_qty, 0);
    const images = (item.images || []).map((img, idx) => ({
      mediaId: img.mediaId ?? null,
      url: img.url,
      alt: img.alt || item.defaultImageAlt,
      isCover: Boolean(img.isCover ?? idx === 0),
    }));

    const created = await store.createProduct({
      product: {
        id: productId,
        slug,
        title: item.title,
        description: item.description,
        fabric_note: item.fabricNote || '',
        included_pieces: item.includedPieces || '',
        care_note: item.careNote || '',
        category: item.category,
        sku: item.sku,
        price_paise: pricePaise,
        compare_at_paise: compareAtPaise,
        stock_qty: totalStock,
        low_stock_threshold: 5,
        featured: 0,
        status: 'draft',
        colors_json: JSON.stringify([item.defaultColor]),
        sizes_json: JSON.stringify(sizes),
        import_key: item.importKey,
        source_image_filename: item.sourceImageFilename,
        pending_fields_json: JSON.stringify(item.pendingFields),
        catalog_batch: manifest.batchId,
        version: 1,
        published_at: null,
        archived_at: null,
        created_at: now,
        updated_at: now,
      },
      variants,
      images,
      actorUserId,
      auditAction: 'import_draft',
      auditSummary: `Staged private draft "${item.title}" (${item.sku}, ref: ${item.sourceImageFilename}) awaiting real garment photos and confirmed details.`,
      auditAfter: {
        importKey: item.importKey,
        sku: item.sku,
        slug,
        status: 'draft',
        pendingFields: item.pendingFields,
      },
    });

    createdCount += 1;
    byImportKey.set(item.importKey, created);
    bySku.set(item.sku.toUpperCase(), created);
    items.push({
      importKey: item.importKey,
      sourceImageFilename: item.sourceImageFilename,
      productId: created.product.id,
      sku: created.product.sku,
      slug: created.product.slug,
      action: 'created',
    });
  }

  return {
    batchId: manifest.batchId,
    createdCount,
    preservedCount,
    backfilledMetadataCount,
    items,
  };
}

/**
 * Evaluates whether all 20 mapped products are complete and legally/commercially safe to publish.
 * Blocks cutover if any item lacks real owned garment photos, confirmed INR pricing, confirmed sizes,
 * per-variant stock confirmation, included pieces, or non-AI photo verification for WA0028.
 */
export async function evaluateCutoverReadiness(
  store: BoutiqueStore,
  manifest: CatalogDraftManifest
): Promise<CutoverReadinessSummary> {
  const all = await listAllProductsInStore(store);
  const byImportKey = new Map<string, AdminProductRecord>();
  const bySku = new Map<string, AdminProductRecord>();
  for (const rec of all) {
    if (rec.product.import_key) byImportKey.set(rec.product.import_key, rec);
    bySku.set(rec.product.sku.toUpperCase(), rec);
  }

  const seenSlugs = new Set<string>();
  const seenSkus = new Set<string>();
  const items: ProductReadinessReport[] = [];

  for (const item of manifest.products) {
    const rec = byImportKey.get(item.importKey) || bySku.get(item.sku.toUpperCase()) || null;
    const blockers: string[] = [];
    const optionalPending: string[] = [];

    if (!rec) {
      blockers.push('Draft listing has not been imported into the catalog yet.');
    } else {
      const pending = new Set(parsePendingFields(rec.product.pending_fields_json));

      if (rec.images.length === 0) {
        blockers.push('Missing real owned/licensed garment photos.');
      } else if (
        rec.images.some(
          (img) => !img.url || SCREENSHOT_FILENAME_RE.test(img.url) || img.url.startsWith('data:')
        )
      ) {
        blockers.push(
          'Product gallery references an unapproved screenshot or inline data URI instead of clean hosted garment photography.'
        );
      }
      if (pending.has('realGarmentPhotos')) {
        blockers.push('Real garment photos not yet marked confirmed.');
      }

      if (
        item.requiresNonAiPhotoConfirmation &&
        pending.has('realGarmentPhotoVerification')
      ) {
        blockers.push(
          `Must replace AI-modified reference (${item.sourceImageFilename}) with a confirmed real, non-AI photograph of the actual garment.`
        );
      }

      if (pending.has('sellingPriceInr') || rec.product.price_paise <= 100) {
        blockers.push('Missing confirmed INR selling price.');
      }

      let parsedSizes: string[] = [];
      try {
        parsedSizes = JSON.parse(rec.product.sizes_json || '[]') as string[];
      } catch {
        parsedSizes = [];
      }
      if (
        pending.has('sizes') ||
        parsedSizes.length === 0 ||
        parsedSizes.some((s) => s.trim().toUpperCase() === 'TBD')
      ) {
        blockers.push('Missing confirmed available sizes.');
      }

      if (pending.has('variantStock') || rec.variants.length === 0) {
        blockers.push('Missing confirmed stock quantity per size/variant.');
      }

      if (pending.has('includedPieces') || !(rec.product.included_pieces || '').trim()) {
        blockers.push(
          'Missing confirmed included pieces (e.g., dress only vs. kurta + pants + dupatta).'
        );
      }

      if (
        pending.has('fabricAndCareDetails') ||
        (!(rec.product.fabric_note || '').trim() && !(rec.product.care_note || '').trim())
      ) {
        optionalPending.push('Fabric composition and care instructions (recommended if available).');
      }

      const normSlug = rec.product.slug.toLowerCase();
      const normSku = rec.product.sku.toUpperCase();
      if (seenSlugs.has(normSlug)) {
        blockers.push(`Duplicate URL slug "${rec.product.slug}".`);
      }
      if (seenSkus.has(normSku)) {
        blockers.push(`Duplicate SKU "${rec.product.sku}".`);
      }
      seenSlugs.add(normSlug);
      seenSkus.add(normSku);
    }

    items.push({
      importKey: item.importKey,
      sourceImageFilename: item.sourceImageFilename,
      sku: rec?.product.sku || item.sku,
      slug: rec?.product.slug || item.slug,
      title: rec?.product.title || item.title,
      category: rec?.product.category || item.category,
      productId: rec?.product.id || null,
      status: rec?.product.status || null,
      ready: blockers.length === 0,
      blockers,
      optionalPending,
    });
  }

  const readyCount = items.filter((i) => i.ready).length;
  return {
    batchId: manifest.batchId,
    ready: readyCount === manifest.products.length,
    totalExpected: manifest.products.length,
    readyCount,
    blockedCount: manifest.products.length - readyCount,
    items,
  };
}

/**
 * Captures a complete, durable backup of the current catalog, categories, settings,
 * storefront featured/lookbook content, and active order IDs prior to cutover.
 */
export async function createCatalogBackup(
  store: BoutiqueStore,
  options: { batchId: string; backupDir?: string }
): Promise<{ backup: CatalogBackupSnapshot; backupPath?: string }> {
  const [products, categories, siteSettings, storefrontContent, orders] = await Promise.all([
    listAllProductsInStore(store),
    store.listCategories(),
    store.getSiteSettings(),
    store.getStorefrontContent(),
    listAllOrdersInStore(store),
  ]);

  const createdAt = Date.now();
  const id = `backup-${createdAt}-${crypto.randomBytes(3).toString('hex')}`;
  const backup: CatalogBackupSnapshot = {
    id,
    createdAt,
    batchId: options.batchId,
    targetEnv: store.targetEnv,
    backend: store.backend,
    products: products.map((rec) => ({
      product: structuredClone(rec.product),
      variants: structuredClone(rec.variants),
      images: structuredClone(rec.images),
    })),
    categories: structuredClone(categories),
    siteSettings: structuredClone(siteSettings),
    storefrontContent: structuredClone(storefrontContent),
    orderIdsAtBackup: orders.map((o) => o.order.id),
  };

  let backupPath: string | undefined;
  if (options.backupDir) {
    fs.mkdirSync(options.backupDir, { recursive: true });
    backupPath = path.join(options.backupDir, `${id}.json`);
    const tmpPath = `${backupPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(backup, null, 2), 'utf8');
    fs.renameSync(tmpPath, backupPath);
  }

  return { backup, backupPath };
}

/**
 * Performs a gated, atomic-intent catalog cutover:
 * 1. Refuses to proceed unless ALL 20 products pass `evaluateCutoverReadiness`.
 * 2. Takes a backup snapshot before mutating live data.
 * 3. Publishes the 20 mapped products and archives all previously active products outside the 20
 *    while preserving archived IDs, slugs, variants, images, and order history references.
 * 4. Rewires categories, hero, spotlightEdit, and lookbookEntries strictly to active listings.
 * 5. Persists `catalogControl.suppressLegacySeed = true` so legacy fallback/seed items never resurface.
 */
export async function executeCatalogCutover(
  store: BoutiqueStore,
  manifest: CatalogDraftManifest,
  options?: {
    actorUserId?: string;
    backupDir?: string;
    existingBackup?: { backup: CatalogBackupSnapshot; backupPath?: string };
  }
): Promise<CutoverExecutionResult | CutoverBlockedResult> {
  const actorUserId = options?.actorUserId || 'system-catalog-cutover';
  const readiness = await evaluateCutoverReadiness(store, manifest);
  if (!readiness.ready) {
    return {
      ok: false,
      code: 'CUTOVER_BLOCKED',
      message: `Cutover blocked: ${readiness.blockedCount} of ${readiness.totalExpected} listings still have unresolved photo or commercial data blockers.`,
      readiness,
    };
  }

  const { backup, backupPath } =
    options?.existingBackup ??
    (await createCatalogBackup(store, {
      batchId: manifest.batchId,
      backupDir: options?.backupDir,
    }));

  const allBefore = await listAllProductsInStore(store);
  const byImportKey = new Map<string, AdminProductRecord>();
  const bySku = new Map<string, AdminProductRecord>();
  for (const rec of allBefore) {
    if (rec.product.import_key) byImportKey.set(rec.product.import_key, rec);
    bySku.set(rec.product.sku.toUpperCase(), rec);
  }

  const targetIds = new Set<string>();
  const publishedRecords: AdminProductRecord[] = [];
  const now = Date.now();

  // 1. Publish all 20 mapped products
  for (const item of manifest.products) {
    const rec = byImportKey.get(item.importKey) || bySku.get(item.sku.toUpperCase());
    if (!rec) {
      throw new Error(`Unexpected missing product for importKey=${item.importKey} during cutover.`);
    }
    targetIds.add(rec.product.id);
    const shouldFeature = Boolean(item.featuredOnCutover);

    const res = await store.updateProduct({
      productId: rec.product.id,
      expectedVersion: rec.product.version,
      nextSlug: rec.product.slug,
      title: rec.product.title,
      description: rec.product.description,
      fabricNote: rec.product.fabric_note,
      includedPieces: rec.product.included_pieces ?? '',
      careNote: rec.product.care_note ?? '',
      category: rec.product.category,
      sku: rec.product.sku,
      pricePaise: rec.product.price_paise,
      compareAtPaise: rec.product.compare_at_paise,
      totalStock: rec.product.stock_qty,
      lowStockThreshold: rec.product.low_stock_threshold,
      featured: shouldFeature,
      nextStatus: 'published',
      colorsJson: rec.product.colors_json,
      sizesJson: rec.product.sizes_json,
      importKey: rec.product.import_key || item.importKey,
      sourceImageFilename: rec.product.source_image_filename || item.sourceImageFilename,
      pendingFieldsJson: '[]',
      catalogBatch: manifest.batchId,
      publishedAtIfNull: now,
      now,
      variants: rec.variants,
      images: rec.images.map((img) => ({
        mediaId: img.media_id,
        url: img.url,
        alt: img.alt_text,
        isCover: Boolean(img.is_cover),
      })),
      actorUserId,
      auditAction: 'catalog_cutover_publish',
      auditSummary: `Published "${rec.product.title}" (${rec.product.sku}) in batch ${manifest.batchId}.`,
      auditBefore: { status: rec.product.status, featured: Boolean(rec.product.featured) },
      auditAfter: { status: 'published', featured: shouldFeature, batchId: manifest.batchId },
    });
    if (!res.ok) {
      throw new Error(`Failed to publish "${rec.product.title}" (${res.code}).`);
    }
    publishedRecords.push(res.product);
  }

  // 2. Archive all previously active products outside the 20 (preserving IDs, slugs, images, orders)
  const archivedIds: string[] = [];
  for (const rec of allBefore) {
    if (targetIds.has(rec.product.id)) continue;
    if (rec.product.status === 'archived' && !rec.product.featured) continue;

    const res = await store.updateProduct({
      productId: rec.product.id,
      expectedVersion: rec.product.version,
      nextSlug: rec.product.slug,
      title: rec.product.title,
      description: rec.product.description,
      fabricNote: rec.product.fabric_note,
      includedPieces: rec.product.included_pieces ?? '',
      careNote: rec.product.care_note ?? '',
      category: rec.product.category,
      sku: rec.product.sku,
      pricePaise: rec.product.price_paise,
      compareAtPaise: rec.product.compare_at_paise,
      totalStock: rec.product.stock_qty,
      lowStockThreshold: rec.product.low_stock_threshold,
      featured: false,
      nextStatus: 'archived',
      colorsJson: rec.product.colors_json,
      sizesJson: rec.product.sizes_json,
      importKey: rec.product.import_key ?? null,
      sourceImageFilename: rec.product.source_image_filename ?? null,
      pendingFieldsJson: rec.product.pending_fields_json ?? null,
      catalogBatch: rec.product.catalog_batch ?? null,
      publishedAtIfNull: rec.product.published_at,
      now,
      variants: rec.variants,
      images: rec.images.map((img) => ({
        mediaId: img.media_id,
        url: img.url,
        alt: img.alt_text,
        isCover: Boolean(img.is_cover),
      })),
      actorUserId,
      auditAction: 'catalog_cutover_archive',
      auditSummary: `Archived legacy listing "${rec.product.title}" (${rec.product.sku}) during cutover to ${manifest.batchId}.`,
      auditBefore: { status: rec.product.status, featured: Boolean(rec.product.featured) },
      auditAfter: { status: 'archived', featured: false, batchId: manifest.batchId },
    });
    if (res.ok) {
      archivedIds.push(rec.product.id);
    }
  }

  // 3. Rewire category covers and storefront featured placements strictly to active 20 listings
  const coverByCategory = new Map<string, { url: string; alt: string }>();
  for (const rec of publishedRecords) {
    const cover = rec.images.find((i) => i.is_cover) || rec.images[0];
    if (cover && !coverByCategory.has(rec.product.category)) {
      coverByCategory.set(rec.product.category, {
        url: cover.url,
        alt: cover.alt_text || rec.product.title,
      });
    }
  }

  const existingCats = await store.listCategories();
  for (const cat of existingCats) {
    const activeCover = coverByCategory.get(cat.name);
    if (activeCover) {
      await store.updateCategory(cat.id, {
        name: cat.name,
        subtitle: cat.subtitle,
        imageUrl: activeCover.url,
        altText: activeCover.alt,
        position: cat.position,
      });
    }
  }

  const featuredProducts = publishedRecords.filter((r) => Boolean(r.product.featured));
  const primaryHero = featuredProducts[0] || publishedRecords[0];
  const secondaryHighlights = (featuredProducts.length >= 3 ? featuredProducts : publishedRecords).slice(
    1,
    3
  );
  const spotlightProd =
    publishedRecords.find((r) => r.product.category === 'Festive Collection') ||
    featuredProducts[1] ||
    publishedRecords[0];

  const getCover = (rec: AdminProductRecord) => {
    const img = rec.images.find((i) => i.is_cover) || rec.images[0];
    return { src: img?.url || '', alt: img?.alt_text || rec.product.title };
  };

  const currentContent = await store.getStorefrontContent();
  const nextLookbook = publishedRecords.slice(0, 6).map((rec, idx) => {
    const cover = getCover(rec);
    const layouts: Array<'tall' | 'wide' | 'square'> = [
      'tall',
      'square',
      'wide',
      'square',
      'tall',
      'square',
    ];
    return {
      id: `lb-${rec.product.slug.slice(0, 48)}`,
      title: rec.product.title,
      caption: rec.product.description.slice(0, 220),
      category: rec.product.category,
      image: cover.src,
      alt: cover.alt,
      layout: layouts[idx % layouts.length],
    };
  });

  await store.saveStorefrontContent({
    ...currentContent,
    hero: {
      ...currentContent.hero,
      mainImage: getCover(primaryHero),
      accentCutouts: secondaryHighlights.map((rec) => {
        const cov = getCover(rec);
        return {
          src: cov.src,
          alt: cov.alt,
          caption: rec.product.title.slice(0, 60),
        };
      }),
    },
    spotlightEdit: {
      ...currentContent.spotlightEdit,
      title: spotlightProd.product.title,
      subtitle: `${spotlightProd.product.category} · New Arrival`,
      description: spotlightProd.product.description,
      targetCategory: spotlightProd.product.category,
      image: getCover(spotlightProd),
    },
    lookbookEntries: nextLookbook,
    about: {
      ...currentContent.about,
      image: getCover(publishedRecords[publishedRecords.length - 1] || primaryHero),
    },
  });

  // 4. Suppress legacy seed resurfacing persistently in site settings
  const currentSettings = await store.getSiteSettings();
  await store.saveSiteSettings({
    ...currentSettings,
    catalogControl: {
      suppressLegacySeed: true,
      activeCatalogBatch: manifest.batchId,
      activeBackupId: backup.id,
    },
  });

  return {
    ok: true,
    batchId: manifest.batchId,
    backupId: backup.id,
    backupPath,
    publishedCount: publishedRecords.length,
    archivedCount: archivedIds.length,
    publishedIds: publishedRecords.map((r) => r.product.id),
    archivedIds,
  };
}

/**
 * Restores the previous active catalog, featured placements, categories, storefront content,
 * and site settings from a backup snapshot while strictly preserving:
 * - Every order placed after the backup
 * - Every post-backup inventory deduction (no clobbering live sold inventory back up!)
 */
export async function rollbackCatalogFromBackup(
  store: BoutiqueStore,
  backup: CatalogBackupSnapshot,
  options?: { actorUserId?: string }
): Promise<RollbackResult> {
  const actorUserId = options?.actorUserId || 'system-catalog-rollback';
  const now = Date.now();

  const [currentProducts, allOrders] = await Promise.all([
    listAllProductsInStore(store),
    listAllOrdersInStore(store),
  ]);

  const backupOrderIds = new Set(backup.orderIdsAtBackup || []);
  const postBackupOrders = allOrders.filter(
    (o) => !backupOrderIds.has(o.order.id) && o.order.created_at >= backup.createdAt
  );

  // Sum net stock deductions from non-restored post-backup orders so rollback never oversells
  const deductedByVariantId = new Map<string, number>();
  for (const ord of postBackupOrders) {
    if (ord.order.stock_restored_at) continue;
    for (const it of ord.items) {
      if (it.variant_id) {
        deductedByVariantId.set(
          it.variant_id,
          (deductedByVariantId.get(it.variant_id) || 0) + it.quantity
        );
      }
    }
  }

  const currentById = new Map(currentProducts.map((r) => [r.product.id, r]));
  const backupById = new Map(backup.products.map((b) => [b.product.id, b]));

  let restoredProductsCount = 0;
  let adjustedInventoryVariantsCount = 0;

  for (const snap of backup.products) {
    const current = currentById.get(snap.product.id);
    const currentVariantMap = new Map((current?.variants || []).map((v) => [v.id, v]));

    const adjustedVariants: ProductVariantRow[] = snap.variants.map((bv) => {
      const deducted = deductedByVariantId.get(bv.id) || 0;
      const curVar = currentVariantMap.get(bv.id);
      let safeStock = Math.max(0, bv.stock_qty - deducted);
      if (curVar && deducted > 0) {
        // Never restore higher than current remaining stock when orders deducted from it
        safeStock = Math.min(safeStock, curVar.stock_qty);
      }
      if (safeStock !== bv.stock_qty) {
        adjustedInventoryVariantsCount += 1;
      }
      return {
        ...bv,
        stock_qty: safeStock,
      };
    });

    const totalStock =
      adjustedVariants.length > 0
        ? adjustedVariants.reduce((sum, v) => sum + v.stock_qty, 0)
        : snap.product.stock_qty;

    if (current) {
      const res = await store.updateProduct({
        productId: snap.product.id,
        expectedVersion: current.product.version,
        nextSlug: snap.product.slug,
        title: snap.product.title,
        description: snap.product.description,
        fabricNote: snap.product.fabric_note,
        includedPieces: snap.product.included_pieces ?? '',
        careNote: snap.product.care_note ?? '',
        category: snap.product.category,
        sku: snap.product.sku,
        pricePaise: snap.product.price_paise,
        compareAtPaise: snap.product.compare_at_paise,
        totalStock,
        lowStockThreshold: snap.product.low_stock_threshold,
        featured: Boolean(snap.product.featured),
        nextStatus: snap.product.status,
        colorsJson: snap.product.colors_json,
        sizesJson: snap.product.sizes_json,
        importKey: snap.product.import_key ?? null,
        sourceImageFilename: snap.product.source_image_filename ?? null,
        pendingFieldsJson: snap.product.pending_fields_json ?? null,
        catalogBatch: snap.product.catalog_batch ?? null,
        publishedAtIfNull: snap.product.published_at,
        now,
        variants: adjustedVariants,
        images: snap.images.map((img) => ({
          mediaId: img.media_id,
          url: img.url,
          alt: img.alt_text,
          isCover: Boolean(img.is_cover),
        })),
        actorUserId,
        auditAction: 'catalog_rollback_restore',
        auditSummary: `Restored "${snap.product.title}" to pre-cutover state (${snap.product.status}) from backup ${backup.id} while preserving post-cutover inventory deductions.`,
        auditBefore: { status: current.product.status, stockQty: current.product.stock_qty },
        auditAfter: { status: snap.product.status, stockQty: totalStock, backupId: backup.id },
      });
      if (res.ok) restoredProductsCount += 1;
    } else {
      await store.createProduct({
        product: {
          ...snap.product,
          stock_qty: totalStock,
          updated_at: now,
        },
        variants: adjustedVariants,
        images: snap.images.map((img) => ({
          mediaId: img.media_id,
          url: img.url,
          alt: img.alt_text,
          isCover: Boolean(img.is_cover),
        })),
        actorUserId,
        auditAction: 'catalog_rollback_recreate',
        auditSummary: `Recreated "${snap.product.title}" from backup ${backup.id}.`,
        auditAfter: { status: snap.product.status, stockQty: totalStock, backupId: backup.id },
      });
      restoredProductsCount += 1;
    }
  }

  // Transition any products created after backup (not present in backup) back to draft (never delete)
  let draftedPostBackupProductsCount = 0;
  for (const current of currentProducts) {
    if (backupById.has(current.product.id)) continue;
    if (current.product.status === 'draft' && !current.product.featured) continue;

    const res = await store.updateProduct({
      productId: current.product.id,
      expectedVersion: current.product.version,
      nextSlug: current.product.slug,
      title: current.product.title,
      description: current.product.description,
      fabricNote: current.product.fabric_note,
      includedPieces: current.product.included_pieces ?? '',
      careNote: current.product.care_note ?? '',
      category: current.product.category,
      sku: current.product.sku,
      pricePaise: current.product.price_paise,
      compareAtPaise: current.product.compare_at_paise,
      totalStock: current.product.stock_qty,
      lowStockThreshold: current.product.low_stock_threshold,
      featured: false,
      nextStatus: 'draft',
      colorsJson: current.product.colors_json,
      sizesJson: current.product.sizes_json,
      importKey: current.product.import_key ?? null,
      sourceImageFilename: current.product.source_image_filename ?? null,
      pendingFieldsJson: current.product.pending_fields_json ?? null,
      catalogBatch: current.product.catalog_batch ?? null,
      publishedAtIfNull: current.product.published_at,
      now,
      variants: current.variants,
      images: current.images.map((img) => ({
        mediaId: img.media_id,
        url: img.url,
        alt: img.alt_text,
        isCover: Boolean(img.is_cover),
      })),
      actorUserId,
      auditAction: 'catalog_rollback_unpublish',
      auditSummary: `Returned post-backup listing "${current.product.title}" to draft during rollback ${backup.id}.`,
      auditBefore: { status: current.product.status },
      auditAfter: { status: 'draft', backupId: backup.id },
    });
    if (res.ok) draftedPostBackupProductsCount += 1;
  }

  // Restore categories, storefront content, and site settings
  const currentCats = await store.listCategories();
  const currentCatIds = new Set(currentCats.map((c) => c.id));
  for (const cat of backup.categories) {
    if (currentCatIds.has(cat.id)) {
      await store.updateCategory(cat.id, {
        name: cat.name,
        subtitle: cat.subtitle,
        imageUrl: cat.image_url,
        altText: cat.alt_text,
        position: cat.position,
      });
    } else {
      await store.createCategory({
        name: cat.name,
        subtitle: cat.subtitle,
        imageUrl: cat.image_url,
        altText: cat.alt_text,
        position: cat.position,
      });
    }
  }

  await store.saveStorefrontContent(backup.storefrontContent);
  await store.saveSiteSettings(backup.siteSettings);

  return {
    ok: true,
    backupId: backup.id,
    restoredProductsCount,
    draftedPostBackupProductsCount,
    preservedOrdersCount: allOrders.length,
    adjustedInventoryVariantsCount,
  };
}

/**
 * Verifies post-cutover public catalog integrity:
 * - Exactly 20 active products matching the manifest
 * - Zero legacy or archived products in public lists, category filters, or search
 * - Archived slugs return null from public detail lookup
 */
export async function verifyActiveCatalog(
  store: BoutiqueStore,
  manifest: CatalogDraftManifest,
  archivedSlugsToCheck: string[] = []
): Promise<ActiveCatalogVerificationResult> {
  const active = await store.listPublicProducts({});
  const expectedKeys = new Set(manifest.products.map((p) => p.importKey));
  const activeKeys = new Set(
    active.map((a) => a.product.import_key).filter((k): k is string => Boolean(k))
  );

  const missingImportKeys = Array.from(expectedKeys).filter((k) => !activeKeys.has(k));
  const unexpectedActiveIds = active
    .filter((a) => !a.product.import_key || !expectedKeys.has(a.product.import_key))
    .map((a) => a.product.id);

  const archivedSlugsStillPublic: string[] = [];
  for (const slug of archivedSlugsToCheck) {
    const found = await store.getPublicProductByIdOrSlug(slug);
    if (found) archivedSlugsStillPublic.push(slug);
  }

  const categoryFilterMismatches: string[] = [];
  const manifestCategories = Array.from(new Set(manifest.products.map((p) => p.category)));
  for (const cat of manifestCategories) {
    const filtered = await store.listPublicProducts({ category: cat });
    const expectedCount = active.filter((a) => a.product.category === cat).length;
    if (filtered.length !== expectedCount) {
      categoryFilterMismatches.push(
        `Category "${cat}" returned ${filtered.length} items, expected ${expectedCount}.`
      );
    }
    if (filtered.some((f) => !f.product.import_key || !expectedKeys.has(f.product.import_key))) {
      categoryFilterMismatches.push(`Category "${cat}" leaked a non-manifest product.`);
    }
  }

  const searchMismatches: string[] = [];
  for (const sample of manifest.products.slice(0, 5)) {
    const token = sample.title.split(/\s+/)[0];
    const results = await store.listPublicProducts({ q: token });
    if (results.some((r) => !r.product.import_key || !expectedKeys.has(r.product.import_key))) {
      searchMismatches.push(`Search "${token}" leaked a non-manifest product.`);
    }
  }

  return {
    ok:
      active.length === manifest.products.length &&
      missingImportKeys.length === 0 &&
      unexpectedActiveIds.length === 0 &&
      archivedSlugsStillPublic.length === 0 &&
      categoryFilterMismatches.length === 0 &&
      searchMismatches.length === 0,
    activeCount: active.length,
    expectedCount: manifest.products.length,
    missingImportKeys,
    unexpectedActiveIds,
    archivedSlugsStillPublic,
    categoryFilterMismatches,
    searchMismatches,
  };
}
