import type {
  Product,
  ProductColor,
  ProductImage,
  ProductVariant,
} from '../types/boutique';

export interface NormalizedColorOption {
  id: string;
  name: string;
  hex: string;
  thumbnailUrl: string;
  images: ProductImage[];
  position: number;
  active: boolean;
  variants: ProductVariant[];
  activeVariants: ProductVariant[];
  totalStock: number;
  inStock: boolean;
  isSoldOut: boolean;
  minPricePaise: number | null;
  compareAtPaise: number | null;
}

export interface ColorSelectionResolution {
  colorId: string;
  size: string;
  variant: ProductVariant | null;
  linkedVariantSoldOut: boolean;
  linkedVariantUnavailable: boolean;
}

export function slugifyColorKey(name: string): string {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'signature';
}

export function makeStableColorId(name: string, index = 0, existingIds?: Set<string>): string {
  const base = `clr-${slugifyColorKey(name)}`;
  if (!existingIds || !existingIds.has(base)) {
    return base;
  }
  let suffix = index + 2;
  while (existingIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function isVariantActive(variant: Pick<ProductVariant, 'active'> | null | undefined): boolean {
  if (!variant) return false;
  if (variant.active === undefined || variant.active === null) return true;
  return Boolean(variant.active);
}

export function isColorActive(color: Pick<ProductColor, 'active'> | null | undefined): boolean {
  if (!color) return false;
  if (color.active === undefined || color.active === null) return true;
  return Boolean(color.active);
}

export function isFreeSizeLabel(size: string | null | undefined): boolean {
  const normalized = String(size || '').trim().toLowerCase();
  return (
    normalized === 'free size' ||
    normalized === 'one size' ||
    normalized === 'standard' ||
    normalized === 'freesize'
  );
}

/**
 * Normalizes a product's colour options, per-colour gallery images, and variants
 * cleanly for both new multi-colour products and legacy single-colour products.
 *
 * By default (`includeInactive = false`), returns only active customer-facing colour options.
 */
export function normalizeProductColors(
  product: Pick<Product, 'id' | 'name' | 'price' | 'pricePaise' | 'compareAtPaise' | 'images' | 'colors' | 'sizes' | 'variants' | 'stockQty'>,
  options?: { includeInactive?: boolean }
): NormalizedColorOption[] {
  const includeInactive = Boolean(options?.includeInactive);
  const rawImages: ProductImage[] = Array.isArray(product.images)
    ? product.images.filter((img) => Boolean(img && img.src))
    : [];
  const rawVariants: ProductVariant[] = Array.isArray(product.variants) ? product.variants : [];
  const rawColors: ProductColor[] = Array.isArray(product.colors) ? product.colors : [];

  const coverFallback =
    rawImages.find((img) => img.isCover)?.src || rawImages[0]?.src || '';

  // Build ordered unique colour map from explicit colors first, then variants if missing
  interface MutableColorSeed {
    id: string;
    name: string;
    hex: string;
    thumbnailUrl: string;
    position: number;
    active: boolean;
  }

  const byKey = new Map<string, MutableColorSeed>();
  const byId = new Map<string, MutableColorSeed>();
  const usedIds = new Set<string>();

  const sortedRawColors = [...rawColors].sort(
    (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)
  );

  sortedRawColors.forEach((c, idx) => {
    const name = String(c?.name || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (byKey.has(key)) return;
    const id =
      typeof c.id === 'string' && c.id.trim()
        ? c.id.trim()
        : makeStableColorId(name, idx, usedIds);
    usedIds.add(id);
    const seed: MutableColorSeed = {
      id,
      name,
      hex: typeof c.hex === 'string' && c.hex.trim() ? c.hex.trim() : '#49243E',
      thumbnailUrl: typeof c.thumbnailUrl === 'string' ? c.thumbnailUrl.trim() : '',
      position: typeof c.position === 'number' && Number.isFinite(c.position) ? c.position : idx,
      active: isColorActive(c),
    };
    byKey.set(key, seed);
    byId.set(id, seed);
  });

  rawVariants.forEach((v, idx) => {
    const name = String(v?.colorName || '').trim() || 'Signature';
    const key = name.toLowerCase();
    if (v.colorId && byId.has(v.colorId)) return;
    if (byKey.has(key)) return;
    const id =
      typeof v.colorId === 'string' && v.colorId.trim()
        ? v.colorId.trim()
        : makeStableColorId(name, byKey.size + idx, usedIds);
    usedIds.add(id);
    const seed: MutableColorSeed = {
      id,
      name,
      hex: typeof v.colorHex === 'string' && v.colorHex.trim() ? v.colorHex.trim() : '#49243E',
      thumbnailUrl: '',
      position: byKey.size,
      active: true,
    };
    byKey.set(key, seed);
    byId.set(id, seed);
  });

  if (byKey.size === 0) {
    const fallbackId = makeStableColorId('Signature', 0, usedIds);
    const seed: MutableColorSeed = {
      id: fallbackId,
      name: 'Signature',
      hex: '#49243E',
      thumbnailUrl: coverFallback,
      position: 0,
      active: true,
    };
    byKey.set('signature', seed);
    byId.set(fallbackId, seed);
  }

  const seeds = Array.from(byKey.values()).sort((a, b) => a.position - b.position);
  const isSingleColorProduct = seeds.length === 1;
  const anyColorTaggedImages = rawImages.some(
    (img) => typeof img.colorId === 'string' && img.colorId.trim().length > 0
  );

  const normalized: NormalizedColorOption[] = seeds.map((seed, idx) => {
    const matchedVariants = rawVariants
      .filter((v) => {
        if (v.colorId && v.colorId === seed.id) return true;
        return String(v.colorName || '').trim().toLowerCase() === seed.name.toLowerCase();
      })
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));

    const activeVariants = seed.active
      ? matchedVariants.filter((v) => isVariantActive(v))
      : [];

    // Resolve images strictly for this colour
    const taggedForColor = rawImages
      .filter((img) => {
        if (!img.colorId) return false;
        return (
          img.colorId === seed.id ||
          img.colorId.toLowerCase() === seed.name.toLowerCase()
        );
      })
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));

    const untaggedImages = rawImages
      .filter((img) => !img.colorId)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));

    let galleryImages: ProductImage[];
    if (taggedForColor.length > 0) {
      galleryImages = taggedForColor;
    } else if (seed.thumbnailUrl) {
      // Colour has an explicit thumbnail URL even if extra gallery images aren't tagged
      galleryImages = [
        {
          src: seed.thumbnailUrl,
          alt: `${product.name} — ${seed.name}`,
          isCover: true,
          colorId: seed.id,
          position: 0,
        },
      ];
    } else if (isSingleColorProduct || !anyColorTaggedImages) {
      // Legacy product with untagged images
      galleryImages = untaggedImages.length > 0 ? untaggedImages : rawImages;
    } else {
      // Multi-colour product where other colours have tagged images, do NOT bleed another colour's images
      galleryImages = untaggedImages;
    }

    const thumbnailUrl =
      seed.thumbnailUrl ||
      galleryImages.find((img) => img.isCover)?.src ||
      galleryImages[0]?.src ||
      (isSingleColorProduct ? coverFallback : '');

    // Ensure thumbnailUrl is present in gallery if missing
    if (thumbnailUrl && !galleryImages.some((img) => img.src === thumbnailUrl)) {
      galleryImages = [
        {
          src: thumbnailUrl,
          alt: `${product.name} — ${seed.name}`,
          isCover: true,
          colorId: seed.id,
          position: 0,
        },
        ...galleryImages,
      ];
    }

    const totalStock =
      matchedVariants.length > 0
        ? activeVariants.reduce((sum, v) => sum + Math.max(0, Number(v.stockQty || 0)), 0)
        : Math.max(0, Number(product.stockQty ?? 0));

    const pricePool = activeVariants.length > 0 ? activeVariants : matchedVariants;
    const minPricePaise =
      pricePool.length > 0
        ? Math.min(...pricePool.map((v) => Number(v.pricePaise || 0)))
        : (product.pricePaise ?? Math.round((product.price || 0) * 100));
    const minPriceVariant = pricePool.find((v) => Number(v.pricePaise) === minPricePaise) || null;
    const compareAtPaise =
      minPriceVariant?.compareAtPaise !== undefined
        ? minPriceVariant.compareAtPaise
        : (product.compareAtPaise ?? null);

    return {
      id: seed.id,
      name: seed.name,
      hex: seed.hex,
      thumbnailUrl,
      images: galleryImages,
      position: idx,
      active: seed.active,
      variants: matchedVariants,
      activeVariants,
      totalStock,
      inStock: seed.active && totalStock > 0,
      isSoldOut: !seed.active || totalStock <= 0,
      minPricePaise,
      compareAtPaise,
    };
  });

  if (includeInactive) return normalized;
  return normalized.filter((c) => c.active);
}

/**
 * Count active customer-facing colour options for a product.
 * Used for the storefront ProductCard "Available in X colours" indicator.
 */
export function countActiveColors(
  product: Pick<Product, 'id' | 'name' | 'price' | 'pricePaise' | 'compareAtPaise' | 'images' | 'colors' | 'sizes' | 'variants' | 'stockQty'>
): number {
  return normalizeProductColors(product, { includeInactive: false }).length;
}

/**
 * Returns ONLY the gallery images belonging to the given colour option.
 */
export function getColorGalleryImages(
  product: Pick<Product, 'id' | 'name' | 'price' | 'pricePaise' | 'compareAtPaise' | 'images' | 'colors' | 'sizes' | 'variants' | 'stockQty'>,
  colorIdOrName: string | null | undefined
): ProductImage[] {
  const options = normalizeProductColors(product, { includeInactive: true });
  if (options.length === 0) return product.images || [];
  if (!colorIdOrName) return options[0].images;

  const target = colorIdOrName.trim().toLowerCase();
  const matched = options.find(
    (c) => c.id.toLowerCase() === target || c.name.toLowerCase() === target
  );
  return matched ? matched.images : options[0].images;
}

/**
 * Resolves the best variant-specific thumbnail image URL for cart, checkout, and order snapshots.
 */
export function getVariantThumbnailUrl(
  product: Pick<Product, 'id' | 'name' | 'price' | 'pricePaise' | 'compareAtPaise' | 'images' | 'colors' | 'sizes' | 'variants' | 'stockQty'>,
  variant?: Pick<ProductVariant, 'colorId' | 'colorName'> | null
): string {
  const fallbackCover =
    product.images?.find((img) => img.isCover)?.src || product.images?.[0]?.src || '';
  if (!variant) return fallbackCover;

  const options = normalizeProductColors(product, { includeInactive: true });
  const matched = options.find(
    (c) =>
      (variant.colorId && c.id === variant.colorId) ||
      c.name.toLowerCase() === String(variant.colorName || '').trim().toLowerCase()
  );
  return matched?.thumbnailUrl || matched?.images[0]?.src || fallbackCover;
}

/**
 * Resolves initial colour and size selection on product open:
 * - Honours valid deep-link `?variant=` (by ID or SKU) or `?color=` (by ID, slugified key, or name).
 * - Otherwise defaults to the first active in-stock colour by display position, falling back to first active colour.
 */
export function resolveInitialColorSelection(
  product: Pick<Product, 'id' | 'name' | 'price' | 'pricePaise' | 'compareAtPaise' | 'images' | 'colors' | 'sizes' | 'variants' | 'stockQty'>,
  params?: { colorParam?: string | null; variantParam?: string | null }
): ColorSelectionResolution {
  const activeColors = normalizeProductColors(product, { includeInactive: false });
  if (activeColors.length === 0) {
    return {
      colorId: '',
      size: '',
      variant: null,
      linkedVariantSoldOut: false,
      linkedVariantUnavailable: Boolean(params?.variantParam || params?.colorParam),
    };
  }

  const variantParam = params?.variantParam?.trim() || '';
  const colorParam = params?.colorParam?.trim() || '';

  // 1. Check explicit variant deep-link first
  if (variantParam) {
    const targetLower = variantParam.toLowerCase();
    for (const color of activeColors) {
      const matchedVariant = color.activeVariants.find(
        (v) => v.id.toLowerCase() === targetLower || v.sku.toLowerCase() === targetLower
      );
      if (matchedVariant) {
        const soldOut = matchedVariant.stockQty <= 0;
        return {
          colorId: color.id,
          size: soldOut ? '' : matchedVariant.size,
          variant: matchedVariant,
          linkedVariantSoldOut: soldOut,
          linkedVariantUnavailable: false,
        };
      }
    }
    // Check if it referred to an inactive variant so UI can show a notice
    const allColors = normalizeProductColors(product, { includeInactive: true });
    const inactiveMatch = allColors
      .flatMap((c) => c.variants)
      .find((v) => v.id.toLowerCase() === targetLower || v.sku.toLowerCase() === targetLower);
    if (inactiveMatch) {
      const defaultColor = activeColors.find((c) => c.inStock) || activeColors[0];
      const defaultVariant =
        defaultColor.activeVariants.find((v) => v.stockQty > 0) ||
        defaultColor.activeVariants[0] ||
        null;
      return {
        colorId: defaultColor.id,
        size: defaultVariant && defaultVariant.stockQty > 0 ? defaultVariant.size : '',
        variant: defaultVariant && defaultVariant.stockQty > 0 ? defaultVariant : null,
        linkedVariantSoldOut: false,
        linkedVariantUnavailable: true,
      };
    }
  }

  // 2. Check explicit colour deep-link
  if (colorParam) {
    const targetLower = colorParam.toLowerCase();
    const targetSlug = slugifyColorKey(colorParam);
    const matchedColor = activeColors.find(
      (c) =>
        c.id.toLowerCase() === targetLower ||
        c.name.toLowerCase() === targetLower ||
        slugifyColorKey(c.name) === targetSlug
    );
    if (matchedColor) {
      const firstInStock = matchedColor.activeVariants.find((v) => v.stockQty > 0) || null;
      return {
        colorId: matchedColor.id,
        size: firstInStock ? firstInStock.size : '',
        variant: firstInStock,
        linkedVariantSoldOut: !matchedColor.inStock,
        linkedVariantUnavailable: false,
      };
    }
  }

  // 3. Default to first active colour with stock, else first active colour
  const defaultColor = activeColors.find((c) => c.inStock) || activeColors[0];
  const firstInStockVariant = defaultColor.activeVariants.find((v) => v.stockQty > 0) || null;
  return {
    colorId: defaultColor.id,
    size: firstInStockVariant ? firstInStockVariant.size : '',
    variant: firstInStockVariant,
    linkedVariantSoldOut: false,
    linkedVariantUnavailable: false,
  };
}

/**
 * Determines the selected size when switching from one colour to another:
 * - Retains `prevSize` ONLY if an active variant with stockQty > 0 exists for the new colour.
 * - If the new colour is sizeless (single 'Free Size' / 'One Size' variant) and in stock, selects it automatically.
 * - Otherwise clears the selection (`''`) and returns `sizeCleared: true` so UI prompts the customer.
 */
export function resolveSizeAfterColorSwitch(
  nextColor: NormalizedColorOption | null | undefined,
  prevSize: string
): { nextSize: string; nextVariant: ProductVariant | null; sizeCleared: boolean } {
  if (!nextColor || !nextColor.active) {
    return { nextSize: '', nextVariant: null, sizeCleared: Boolean(prevSize) };
  }

  const trimmedPrev = prevSize.trim();
  if (trimmedPrev) {
    const matchingVariant = nextColor.activeVariants.find(
      (v) => v.size.toLowerCase() === trimmedPrev.toLowerCase() && v.stockQty > 0
    );
    if (matchingVariant) {
      return {
        nextSize: matchingVariant.size,
        nextVariant: matchingVariant,
        sizeCleared: false,
      };
    }
  }

  // Auto-select single sizeless ('Free Size') variant if in stock
  if (
    nextColor.activeVariants.length === 1 &&
    isFreeSizeLabel(nextColor.activeVariants[0].size) &&
    nextColor.activeVariants[0].stockQty > 0
  ) {
    return {
      nextSize: nextColor.activeVariants[0].size,
      nextVariant: nextColor.activeVariants[0],
      sizeCleared: false,
    };
  }

  return {
    nextSize: '',
    nextVariant: null,
    sizeCleared: Boolean(trimmedPrev),
  };
}

/**
 * Formats a clean customer-facing variant label combining colour and size.
 */
export function formatVariantDisplayLabel(colorName?: string | null, size?: string | null): string {
  const c = String(colorName || '').trim();
  const s = String(size || '').trim();
  if (c && s) return `${c} · ${s}`;
  return c || s || 'Standard';
}

export interface ColorVariantValidationInput {
  status: 'draft' | 'published' | 'archived';
  colors: Array<{
    id?: string;
    name: string;
    hex?: string;
    thumbnailUrl?: string | null;
    position?: number;
    active?: boolean;
  }>;
  images: Array<{
    id?: string;
    url: string;
    alt?: string;
    isCover?: boolean;
    colorId?: string | null;
    position?: number;
  }>;
  variants: Array<{
    id?: string;
    sku?: string;
    size: string;
    colorId?: string | null;
    colorName: string;
    colorHex?: string;
    pricePaise?: number;
    priceOverridePaise?: number | null;
    compareAtPaise?: number | null;
    stockQty: number;
    active?: boolean;
  }>;
}

export interface ColorVariantValidationResult {
  ok: boolean;
  error?: string;
  fieldErrors: Record<string, string>;
}

/**
 * Shared validation rules for multi-colour product authoring & publishing.
 * Enforces:
 * - No duplicate colour names (case-insensitive)
 * - No duplicate (colour, size) combinations
 * - Non-negative integer stock & valid prices
 * - When publishing: at least one active colour, every active colour has at least one active variant,
 *   and in multi-colour products every active colour has at least one assigned image/thumbnail.
 */
export function validateColorVariantMatrix(
  input: ColorVariantValidationInput
): ColorVariantValidationResult {
  const fieldErrors: Record<string, string> = {};

  // 1. Validate colour definitions (if provided)
  const seenColorNames = new Set<string>();
  const colorById = new Map<string, { id: string; name: string; active: boolean; thumbnailUrl: string }>();
  const colorByLowerName = new Map<string, { id: string; name: string; active: boolean; thumbnailUrl: string }>();

  for (let i = 0; i < input.colors.length; i += 1) {
    const c = input.colors[i];
    const name = String(c?.name || '').trim();
    if (!name) {
      const msg = `Colour #${i + 1} must have a colour name (e.g. "Teal & Pink").`;
      fieldErrors.colors = msg;
      return { ok: false, error: msg, fieldErrors };
    }
    if (name.length > 60) {
      const msg = `Colour name "${name.slice(0, 30)}..." must be 60 characters or fewer.`;
      fieldErrors.colors = msg;
      return { ok: false, error: msg, fieldErrors };
    }
    const lower = name.toLowerCase();
    if (seenColorNames.has(lower)) {
      const msg = `Duplicate colour name "${name}". Each colour option must have a unique name.`;
      fieldErrors.colors = msg;
      return { ok: false, error: msg, fieldErrors };
    }
    seenColorNames.add(lower);
    const id = (c.id && c.id.trim()) || makeStableColorId(name, i);
    const entry = {
      id,
      name,
      active: c.active === undefined ? true : Boolean(c.active),
      thumbnailUrl: String(c.thumbnailUrl || '').trim(),
    };
    colorById.set(id, entry);
    colorByLowerName.set(lower, entry);
  }

  // 2. Validate variants (duplicates, prices, stock)
  if (!Array.isArray(input.variants) || input.variants.length === 0) {
    const msg = 'Add at least one colour and size variant before saving.';
    fieldErrors.variants = msg;
    return { ok: false, error: msg, fieldErrors };
  }

  const seenCombos = new Set<string>();
  const seenSkus = new Set<string>();

  for (const v of input.variants) {
    const colorName = String(v.colorName || '').trim();
    const size = String(v.size || '').trim();
    if (!colorName || !size) {
      const msg = 'Every variant must specify both a colour name and a size (or "Free Size").';
      fieldErrors.variants = msg;
      return { ok: false, error: msg, fieldErrors };
    }
    const comboKey = `${colorName.toLowerCase()}::${size.toLowerCase()}`;
    if (seenCombos.has(comboKey)) {
      const msg = `Duplicate variant for colour "${colorName}" and size "${size}".`;
      fieldErrors.variants = msg;
      return { ok: false, error: msg, fieldErrors };
    }
    seenCombos.add(comboKey);

    if (v.sku) {
      const normSku = v.sku.trim().toUpperCase();
      if (seenSkus.has(normSku)) {
        const msg = `Duplicate variant SKU "${normSku}" within this product.`;
        fieldErrors.variants = msg;
        return { ok: false, error: msg, fieldErrors };
      }
      seenSkus.add(normSku);
    }

    if (v.pricePaise !== undefined) {
      if (!Number.isFinite(v.pricePaise) || v.pricePaise < 100 || v.pricePaise > 100_000_000) {
        const msg = `Enter a valid INR price (at least ₹1) for ${colorName} / ${size}.`;
        fieldErrors.variants = msg;
        return { ok: false, error: msg, fieldErrors };
      }
    }
    if (v.priceOverridePaise !== undefined && v.priceOverridePaise !== null) {
      if (
        !Number.isFinite(v.priceOverridePaise) ||
        v.priceOverridePaise < 100 ||
        v.priceOverridePaise > 100_000_000
      ) {
        const msg = `Price override for ${colorName} / ${size} must be at least ₹1.`;
        fieldErrors.variants = msg;
        return { ok: false, error: msg, fieldErrors };
      }
    }
    if (
      !Number.isInteger(v.stockQty) ||
      v.stockQty < 0 ||
      v.stockQty > 100_000
    ) {
      const msg = `Stock quantity for ${colorName} / ${size} must be a whole number (0 or higher).`;
      fieldErrors.variants = msg;
      return { ok: false, error: msg, fieldErrors };
    }
  }

  // 3. Publishing completeness checks
  if (input.status === 'published') {
    const validImages = input.images.filter((img) => Boolean(String(img?.url || '').trim()));
    if (validImages.length === 0) {
      const msg = 'Add at least one product photo before publishing.';
      fieldErrors.images = msg;
      return { ok: false, error: msg, fieldErrors };
    }

    // Build effective list of colours
    const effectiveColors =
      input.colors.length > 0
        ? Array.from(colorByLowerName.values())
        : Array.from(
            new Map(
              input.variants.map((v, idx) => [
                v.colorName.trim().toLowerCase(),
                {
                  id: (v.colorId && v.colorId.trim()) || makeStableColorId(v.colorName, idx),
                  name: v.colorName.trim(),
                  active: true,
                  thumbnailUrl: '',
                },
              ])
            ).values()
          );

    const activeColors = effectiveColors.filter((c) => c.active);
    if (activeColors.length === 0) {
      const msg = 'Enable at least one active colour option before publishing.';
      fieldErrors.colors = msg;
      return { ok: false, error: msg, fieldErrors };
    }

    const isMultiColor = activeColors.length > 1;

    for (const color of activeColors) {
      const matchingVariants = input.variants.filter((v) => {
        if (v.colorId && v.colorId === color.id) return true;
        return v.colorName.trim().toLowerCase() === color.name.toLowerCase();
      });
      const activeVariantsForColor = matchingVariants.filter((v) =>
        v.active === undefined ? true : Boolean(v.active)
      );
      if (activeVariantsForColor.length === 0) {
        const msg = `Colour "${color.name}" needs at least one active size/variant before publishing.`;
        fieldErrors.variants = msg;
        return { ok: false, error: msg, fieldErrors };
      }

      if (isMultiColor) {
        const hasTaggedImage = validImages.some(
          (img) =>
            (img.colorId && img.colorId === color.id) ||
            (img.colorId && img.colorId.toLowerCase() === color.name.toLowerCase())
        );
        if (!hasTaggedImage && !color.thumbnailUrl) {
          const msg = `Upload at least one photo for colour "${color.name}" before publishing.`;
          fieldErrors.images = msg;
          return { ok: false, error: msg, fieldErrors };
        }
      }
    }
  }

  return { ok: true, fieldErrors };
}

/**
 * Checks whether a variant's parent colour option is active (defaults to true for legacy products).
 */
export function isVariantColorActiveInMetadata(
  colorsSource: string | ProductColor[] | null | undefined,
  variant: { color_id?: string | null; colorId?: string | null; color_name?: string; colorName?: string }
): boolean {
  let colors: ProductColor[] = [];
  if (typeof colorsSource === 'string') {
    try {
      const parsed = JSON.parse(colorsSource || '[]');
      if (Array.isArray(parsed)) colors = parsed as ProductColor[];
    } catch {
      colors = [];
    }
  } else if (Array.isArray(colorsSource)) {
    colors = colorsSource;
  }
  if (colors.length === 0) return true;

  const vColorId = (variant.color_id ?? variant.colorId ?? '').trim();
  const vColorName = String(variant.color_name ?? variant.colorName ?? '').trim().toLowerCase();
  const matched = colors.find(
    (c) =>
      (vColorId && c.id && c.id.trim() === vColorId) ||
      (vColorName && String(c.name || '').trim().toLowerCase() === vColorName)
  );
  if (!matched) return true;
  return matched.active === undefined || matched.active === null ? true : Boolean(matched.active);
}

/**
 * Resolves the variant's colour-specific thumbnail URL for cart, checkout, and order snapshots.
 */
export function resolveVariantSnapshotImageUrl(
  colorsSource: string | ProductColor[] | null | undefined,
  images: Array<{
    url?: string;
    src?: string;
    is_cover?: number | boolean;
    isCover?: boolean;
    color_id?: string | null;
    colorId?: string | null;
    position?: number;
  }>,
  variant?: { color_id?: string | null; colorId?: string | null; color_name?: string; colorName?: string } | null
): string {
  const safeImages = Array.isArray(images) ? images : [];
  const getImgUrl = (img: (typeof safeImages)[number] | undefined) =>
    String(img?.url ?? img?.src ?? '').trim();
  const isImgCover = (img: (typeof safeImages)[number]) =>
    Boolean(img.is_cover ?? img.isCover);

  const fallbackCover =
    getImgUrl(safeImages.find((img) => isImgCover(img))) || getImgUrl(safeImages[0]) || '';

  if (!variant) return fallbackCover;

  let colors: ProductColor[] = [];
  if (typeof colorsSource === 'string') {
    try {
      const parsed = JSON.parse(colorsSource || '[]');
      if (Array.isArray(parsed)) colors = parsed as ProductColor[];
    } catch {
      colors = [];
    }
  } else if (Array.isArray(colorsSource)) {
    colors = colorsSource;
  }

  const vColorId = (variant.color_id ?? variant.colorId ?? '').trim();
  const vColorName = String(variant.color_name ?? variant.colorName ?? '').trim().toLowerCase();

  const matchedColor = colors.find(
    (c) =>
      (vColorId && c.id && c.id.trim() === vColorId) ||
      (vColorName && String(c.name || '').trim().toLowerCase() === vColorName)
  );

  if (matchedColor?.thumbnailUrl && matchedColor.thumbnailUrl.trim()) {
    return matchedColor.thumbnailUrl.trim();
  }

  const effectiveColorId = (matchedColor?.id || vColorId || '').trim();
  if (effectiveColorId || vColorName) {
    const colorImages = safeImages
      .filter((img) => {
        const imgColorId = String(img.color_id ?? img.colorId ?? '').trim();
        if (!imgColorId) return false;
        return (
          (effectiveColorId && imgColorId === effectiveColorId) ||
          (vColorName && imgColorId.toLowerCase() === vColorName)
        );
      })
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));

    if (colorImages.length > 0) {
      return (
        getImgUrl(colorImages.find((img) => isImgCover(img))) ||
        getImgUrl(colorImages[0]) ||
        fallbackCover
      );
    }
  }

  return fallbackCover;
}

