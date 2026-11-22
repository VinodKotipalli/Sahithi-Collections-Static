import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Globe,
  ImagePlus,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '../../context/AuthContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import type {
  AdminProduct,
  CollectionCategory,
  Product,
  ProductColor,
  ProductImage,
  ProductVariant,
  StorefrontCategory,
} from '../../types/boutique';
import {
  makeStableColorId,
  normalizeProductColors,
  validateColorVariantMatrix,
} from '../../utils/colorVariants';
import { formatPaiseINR } from '../../utils/format';
import { BoutiqueImage } from '../BoutiqueImage';
import { ProductCard } from '../ProductCard';

const QUICK_SIZE_PRESETS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'Free Size'] as const;
const MAX_PRODUCT_IMAGES = 20;

interface EditableColor {
  id: string;
  name: string;
  hex: string;
  thumbnailUrl: string;
  position: number;
  active: boolean;
}

interface EditableImage {
  id?: string;
  localKey: string;
  url: string;
  alt: string;
  isCover: boolean;
  colorId: string | null;
}

interface EditableVariant {
  id: string;
  sku: string;
  size: string;
  colorId: string;
  colorName: string;
  colorHex: string;
  priceInr: string;
  priceOverrideInr: string;
  compareAtInr: string;
  stockQty: string;
  active: boolean;
}

interface ProductFormState {
  title: string;
  category: CollectionCategory;
  sku: string;
  description: string;
  fabricNote: string;
  includedPieces: string;
  careNote: string;
  basePriceInr: string;
  baseCompareAtInr: string;
  lowStockThreshold: string;
  featured: boolean;
  visibilityStatus: 'published' | 'draft';
  sizesInput: string;
  colors: EditableColor[];
  variants: EditableVariant[];
  images: EditableImage[];
}

interface AdminProductEditorDrawerProps {
  isOpen: boolean;
  product: AdminProduct | null;
  categories: StorefrontCategory[];
  onClose: () => void;
  onSaved: (saved: AdminProduct, notice: string) => void;
  onReloadProduct: (productId: string) => Promise<void>;
}

function paiseToInput(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  if (paise % 100 === 0) return String(paise / 100);
  return (paise / 100).toFixed(2);
}

function inputToPaise(val: string): number | null {
  const cleaned = val.trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

function createInitialFormState(
  product: AdminProduct | null,
  categories: StorefrontCategory[]
): ProductFormState {
  if (!product) {
    const defaultSku = `SC-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const defaultColorId = makeStableColorId('Blush Rose', 0);
    return {
      title: '',
      category: categories[0]?.name || 'Dresses',
      sku: defaultSku,
      description: '',
      fabricNote: '',
      includedPieces: '',
      careNote: '',
      basePriceInr: '2499',
      baseCompareAtInr: '',
      lowStockThreshold: '5',
      featured: false,
      visibilityStatus: 'published',
      sizesInput: 'S, M, L',
      colors: [
        {
          id: defaultColorId,
          name: 'Blush Rose',
          hex: '#E8B8C8',
          thumbnailUrl: '',
          position: 0,
          active: true,
        },
      ],
      variants: [
        {
          id: `new-${crypto.randomUUID()}`,
          sku: `${defaultSku}-S-1`,
          size: 'S',
          colorId: defaultColorId,
          colorName: 'Blush Rose',
          colorHex: '#E8B8C8',
          priceInr: '2499',
          priceOverrideInr: '',
          compareAtInr: '',
          stockQty: '6',
          active: true,
        },
        {
          id: `new-${crypto.randomUUID()}`,
          sku: `${defaultSku}-M-2`,
          size: 'M',
          colorId: defaultColorId,
          colorName: 'Blush Rose',
          colorHex: '#E8B8C8',
          priceInr: '2499',
          priceOverrideInr: '',
          compareAtInr: '',
          stockQty: '8',
          active: true,
        },
        {
          id: `new-${crypto.randomUUID()}`,
          sku: `${defaultSku}-L-3`,
          size: 'L',
          colorId: defaultColorId,
          colorName: 'Blush Rose',
          colorHex: '#E8B8C8',
          priceInr: '2499',
          priceOverrideInr: '',
          compareAtInr: '',
          stockQty: '5',
          active: true,
        },
      ],
      images: [],
    };
  }

  const usedColorIds = new Set<string>();
  const colorById = new Map<string, EditableColor>();
  const colorByLowerName = new Map<string, EditableColor>();
  const editableColors: EditableColor[] = [];

  const sortedRawColors = [...(product.colors || [])].sort(
    (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)
  );
  sortedRawColors.forEach((c, idx) => {
    const name = String(c.name || '').trim();
    if (!name || colorByLowerName.has(name.toLowerCase())) return;
    const id =
      typeof c.id === 'string' && c.id.trim()
        ? c.id.trim()
        : makeStableColorId(name, idx, usedColorIds);
    usedColorIds.add(id);
    const entry: EditableColor = {
      id,
      name,
      hex: typeof c.hex === 'string' && c.hex.trim() ? c.hex.trim() : '#49243E',
      thumbnailUrl: typeof c.thumbnailUrl === 'string' ? c.thumbnailUrl.trim() : '',
      position: typeof c.position === 'number' && Number.isFinite(c.position) ? c.position : idx,
      active: c.active === undefined || c.active === null ? true : Boolean(c.active),
    };
    editableColors.push(entry);
    colorById.set(id, entry);
    colorByLowerName.set(name.toLowerCase(), entry);
  });

  // Ensure any colour referenced by a variant exists in editableColors
  (product.variants || []).forEach((v, idx) => {
    const name = String(v.colorName || '').trim() || 'Signature';
    if (v.colorId && colorById.has(v.colorId)) return;
    if (colorByLowerName.has(name.toLowerCase())) return;
    const id =
      typeof v.colorId === 'string' && v.colorId.trim()
        ? v.colorId.trim()
        : makeStableColorId(name, editableColors.length + idx, usedColorIds);
    usedColorIds.add(id);
    const entry: EditableColor = {
      id,
      name,
      hex: v.colorHex || '#49243E',
      thumbnailUrl: '',
      position: editableColors.length,
      active: true,
    };
    editableColors.push(entry);
    colorById.set(id, entry);
    colorByLowerName.set(name.toLowerCase(), entry);
  });

  if (editableColors.length === 0) {
    const fallbackId = makeStableColorId('Signature', 0, usedColorIds);
    const entry: EditableColor = {
      id: fallbackId,
      name: 'Signature',
      hex: '#49243E',
      thumbnailUrl: '',
      position: 0,
      active: true,
    };
    editableColors.push(entry);
    colorById.set(fallbackId, entry);
    colorByLowerName.set('signature', entry);
  }

  const basePricePaise = product.pricePaise ?? Math.round(product.price * 100);

  const variants: EditableVariant[] =
    product.variants && product.variants.length > 0
      ? product.variants.map((v) => {
          const matchedColor =
            (v.colorId && colorById.get(v.colorId)) ||
            colorByLowerName.get(String(v.colorName || '').trim().toLowerCase()) ||
            editableColors[0];
          const explicitOverride =
            v.priceOverridePaise !== undefined && v.priceOverridePaise !== null
              ? v.priceOverridePaise
              : v.pricePaise !== basePricePaise
                ? v.pricePaise
                : null;
          return {
            id: v.id,
            sku: v.sku,
            size: v.size,
            colorId: matchedColor.id,
            colorName: matchedColor.name,
            colorHex: matchedColor.hex,
            priceInr: paiseToInput(v.pricePaise),
            priceOverrideInr: paiseToInput(explicitOverride),
            compareAtInr: paiseToInput(v.compareAtPaise),
            stockQty: String(v.stockQty),
            active: v.active === undefined || v.active === null ? true : Boolean(v.active),
          };
        })
      : [
          {
            id: `new-${crypto.randomUUID()}`,
            sku: `${product.sku}-1`,
            size: product.sizes[0] || 'Free Size',
            colorId: editableColors[0].id,
            colorName: editableColors[0].name,
            colorHex: editableColors[0].hex,
            priceInr: paiseToInput(basePricePaise),
            priceOverrideInr: '',
            compareAtInr: paiseToInput(product.compareAtPaise),
            stockQty: String(product.stockQty ?? 0),
            active: true,
          },
        ];

  const sourceImages = product.rawImages?.length ? product.rawImages : product.images;
  const images: EditableImage[] = sourceImages.map((img, idx) => {
    const rawColorId = img.colorId ? String(img.colorId).trim() : null;
    const matchedColor = rawColorId
      ? colorById.get(rawColorId) || colorByLowerName.get(rawColorId.toLowerCase()) || null
      : null;
    return {
      ...('id' in img && img.id ? { id: img.id } : {}),
      localKey: `${'id' in img && img.id ? img.id : 'img'}-${idx}`,
      url: 'url' in img ? img.url : img.src,
      alt: img.alt,
      isCover: Boolean(img.isCover ?? idx === 0),
      colorId: matchedColor ? matchedColor.id : rawColorId,
    };
  });

  return {
    title: product.name,
    category: product.category,
    sku: product.sku,
    description: product.description,
    fabricNote: product.fabricNote,
    includedPieces: product.includedPieces || '',
    careNote: product.careNote || '',
    basePriceInr: paiseToInput(basePricePaise),
    baseCompareAtInr: paiseToInput(product.compareAtPaise),
    lowStockThreshold: String(product.lowStockThreshold ?? 5),
    featured: product.featured,
    visibilityStatus: product.status === 'draft' ? 'draft' : 'published',
    sizesInput: product.sizes.join(', '),
    colors: editableColors,
    variants,
    images,
  };
}

export function AdminProductEditorDrawer({
  isOpen,
  product,
  categories,
  onClose,
  onSaved,
  onReloadProduct,
}: AdminProductEditorDrawerProps) {
  const { apiRequest } = useAuth();
  const prefersReducedMotion = usePrefersReducedMotion();
  const drawerScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openedKeyRef = useRef<string | null>(null);

  const [form, setForm] = useState<ProductFormState>(() =>
    createInitialFormState(product, categories)
  );
  const [baselineSnapshot, setBaselineSnapshot] = useState<string>(() =>
    JSON.stringify(createInitialFormState(product, categories))
  );
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [versionConflict, setVersionConflict] = useState(false);
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);

  const [newColorName, setNewColorName] = useState('');
  const [newColorHex, setNewColorHex] = useState('#B76E79');
  const [selectedColorId, setSelectedColorId] = useState<string>(
    () => createInitialFormState(product, categories).colors[0]?.id || ''
  );
  const [galleryViewMode, setGalleryViewMode] = useState<'selected' | 'all'>('selected');
  const [variantViewMode, setVariantViewMode] = useState<'selected' | 'all'>('all');
  const [previewColorId, setPreviewColorId] = useState<string>('');

  useEffect(() => {
    if (!isOpen) {
      openedKeyRef.current = null;
      return;
    }
    const nextKey = product ? `${product.id}:${product.version}` : 'new';
    if (openedKeyRef.current === nextKey) return;
    openedKeyRef.current = nextKey;

    const nextState = createInitialFormState(product, categories);
    setForm(nextState);
    setBaselineSnapshot(JSON.stringify(nextState));
    setSelectedColorId(nextState.colors[0]?.id || '');
    setPreviewColorId(nextState.colors[0]?.id || '');
    setGalleryViewMode(nextState.colors.length > 1 ? 'selected' : 'all');
    setVariantViewMode(nextState.colors.length > 1 ? 'selected' : 'all');
    setTab('edit');
    setErrorText(null);
    setFieldErrors({});
    setVersionConflict(false);
    setDiscardPromptOpen(false);
    if (drawerScrollRef.current) {
      drawerScrollRef.current.scrollTop = 0;
    }
    // Intentionally omit `categories` from deps so background category refreshes never wipe unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, product]);

  // Keep selectedColorId valid if a colour was removed
  useEffect(() => {
    if (form.colors.length === 0) return;
    if (!form.colors.some((c) => c.id === selectedColorId)) {
      setSelectedColorId(form.colors[0].id);
    }
  }, [form.colors, selectedColorId]);

  const activeColor = useMemo(
    () => form.colors.find((c) => c.id === selectedColorId) || form.colors[0] || null,
    [form.colors, selectedColorId]
  );

  const isDirty = useMemo(
    () => JSON.stringify(form) !== baselineSnapshot,
    [form, baselineSnapshot]
  );

  const clearFieldError = (key: string) => {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // Warn before closing tab/reloading browser with unsaved changes
  useEffect(() => {
    if (!isOpen || !isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isOpen, isDirty]);

  const attemptClose = () => {
    if (saving || uploading) return;
    if (isDirty) {
      setDiscardPromptOpen(true);
      return;
    }
    onClose();
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        attemptClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isDirty, saving, uploading]);

  // Helper: compute effective selling price paise for a variant (override > base)
  const getVariantEffectivePricePaise = (v: EditableVariant, basePaiseFallback: number): number => {
    const overridePaise = inputToPaise(v.priceOverrideInr);
    if (overridePaise !== null && overridePaise > 0) return overridePaise;
    const directPaise = inputToPaise(v.priceInr);
    if (directPaise !== null && directPaise > 0) return directPaise;
    return basePaiseFallback;
  };

  // Derived totals displayed unambiguously above variant table (sums only active variants of active colours)
  const derivedTotals = useMemo(() => {
    const activeColorIds = new Set(form.colors.filter((c) => c.active).map((c) => c.id));
    const basePaise = inputToPaise(form.basePriceInr) || 0;
    const activeVariants = form.variants.filter(
      (v) => v.active && (activeColorIds.size === 0 || activeColorIds.has(v.colorId))
    );
    const pool = activeVariants.length > 0 ? activeVariants : form.variants;
    const validPrices = pool
      .map((v) => getVariantEffectivePricePaise(v, basePaise))
      .filter((p) => p > 0);
    const totalStock = activeVariants.reduce((sum, v) => {
      const q = Number.parseInt(v.stockQty, 10);
      return sum + (Number.isFinite(q) && q > 0 ? q : 0);
    }, 0);
    const minPricePaise = validPrices.length > 0 ? Math.min(...validPrices) : basePaise;
    const activeColorCount = form.colors.filter((c) => c.active).length;
    return { totalStock, minPricePaise, activeColorCount };
  }, [form.variants, form.colors, form.basePriceInr]);

  // Live preview object matching storefront Product interface
  const previewProduct = useMemo<Product>(() => {
    const basePaise = inputToPaise(form.basePriceInr) || derivedTotals.minPricePaise || 100;
    const normalizedVariants: ProductVariant[] = form.variants.map((v, idx) => {
      const overridePaise = inputToPaise(v.priceOverrideInr);
      const effectivePricePaise = getVariantEffectivePricePaise(v, basePaise);
      return {
        id: v.id,
        sku: v.sku,
        size: v.size,
        colorId: v.colorId,
        colorName: v.colorName,
        colorHex: v.colorHex,
        pricePaise: effectivePricePaise,
        priceOverridePaise: overridePaise,
        compareAtPaise: inputToPaise(v.compareAtInr),
        stockQty: Math.max(0, Number.parseInt(v.stockQty, 10) || 0),
        active: v.active,
        position: idx,
      };
    });

    const previewColors: ProductColor[] = form.colors.map((c, idx) => {
      const firstTagged = form.images.find((img) => img.colorId === c.id);
      return {
        id: c.id,
        name: c.name,
        hex: c.hex,
        thumbnailUrl: c.thumbnailUrl || firstTagged?.url || null,
        position: idx,
        active: c.active,
      };
    });

    const previewImages: ProductImage[] = form.images.map((img, idx) => ({
      id: img.id || img.localKey,
      src: img.url,
      alt: img.alt || form.title || 'Preview image',
      isCover: img.isCover,
      colorId: img.colorId,
      position: idx,
    }));

    return {
      id: product?.id || 'preview',
      name: form.title.trim() || 'Untitled Boutique Design',
      category: form.category,
      pricePaise: derivedTotals.minPricePaise,
      price: Number((derivedTotals.minPricePaise / 100).toFixed(2)),
      compareAtPaise: normalizedVariants[0]?.compareAtPaise ?? inputToPaise(form.baseCompareAtInr),
      compareAtPrice: normalizedVariants[0]?.compareAtPaise
        ? Number((normalizedVariants[0].compareAtPaise / 100).toFixed(2))
        : null,
      description: form.description || 'Editorial boutique description preview.',
      fabricNote: form.fabricNote,
      stockQty: derivedTotals.totalStock,
      lowStockThreshold: Number.parseInt(form.lowStockThreshold, 10) || 5,
      inStock: derivedTotals.totalStock > 0,
      images: previewImages,
      colors: previewColors,
      sizes: Array.from(new Set(normalizedVariants.filter((v) => v.active !== false).map((v) => v.size))),
      variants: normalizedVariants,
      featured: form.featured,
      dateAdded: new Date().toISOString().slice(0, 10),
    };
  }, [form, derivedTotals, product]);

  const previewNormalizedColors = useMemo(
    () => normalizeProductColors(previewProduct, { includeInactive: false }),
    [previewProduct]
  );

  const activePreviewColor = useMemo(
    () =>
      previewNormalizedColors.find((c) => c.id === previewColorId) ||
      previewNormalizedColors[0] ||
      null,
    [previewNormalizedColors, previewColorId]
  );

  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorText(null);

    const remainingSlots = Math.max(0, MAX_PRODUCT_IMAGES - form.images.length);
    if (remainingSlots === 0) {
      setErrorText(`Maximum of ${MAX_PRODUCT_IMAGES} product photos reached. Remove a photo first.`);
      return;
    }

    const files = Array.from(fileList).slice(0, Math.min(8, remainingSlots));
    for (const f of files) {
      if (f.size > 5 * 1024 * 1024) {
        setErrorText(`"${f.name}" exceeds the 5 MB image size limit.`);
        return;
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
        setErrorText(`"${f.name}" is not a supported JPEG, PNG, or WebP image.`);
        return;
      }
    }

    const targetColor =
      galleryViewMode === 'selected' && activeColor
        ? activeColor
        : form.colors.length === 1
          ? form.colors[0]
          : activeColor;

    setUploading(true);
    try {
      const optimizeImageForCatalog = async (file: File): Promise<File> => {
        if (
          file.size <= 350 * 1024 ||
          typeof createImageBitmap !== 'function' ||
          typeof document === 'undefined'
        ) {
          return file;
        }
        try {
          const bitmap = await createImageBitmap(file);
          const maxDim = 1400;
          const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
          const width = Math.max(1, Math.round(bitmap.width * scale));
          const height = Math.max(1, Math.round(bitmap.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            bitmap.close();
            return file;
          }
          ctx.drawImage(bitmap, 0, 0, width, height);
          bitmap.close();
          const targetMime = file.type === 'image/png' ? 'image/jpeg' : file.type;
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, targetMime, 0.82)
          );
          if (!blob || blob.size >= file.size) return file;
          const ext = targetMime === 'image/webp' ? 'webp' : 'jpg';
          const baseName = file.name.replace(/\.[^.]+$/, '') || 'product-photo';
          return new File([blob], `${baseName}.${ext}`, { type: targetMime });
        } catch {
          return file;
        }
      };

      const preparedFiles = await Promise.all(files.map((f) => optimizeImageForCatalog(f)));
      const fd = new FormData();
      preparedFiles.forEach((f) => fd.append('files', f));

      const res = await apiRequest<{
        files: Array<{ id: string; url: string; filename: string; byteSize: number }>;
      }>('/api/admin/uploads', {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        setErrorText(res.error);
        return;
      }

      setForm((prev) => {
        const hasExistingCover = prev.images.some((i) => i.isCover);
        const targetColorId = targetColor ? targetColor.id : null;
        const targetColorName = targetColor ? targetColor.name : '';
        const appended: EditableImage[] = res.data.files.map((uploaded, idx) => ({
          localKey: uploaded.id,
          url: uploaded.url,
          alt: prev.title.trim()
            ? `${prev.title.trim()}${targetColorName ? ` — ${targetColorName}` : ''} view`
            : `Sahithi Collections${targetColorName ? ` ${targetColorName}` : ''} garment photo`,
          isCover: !hasExistingCover && idx === 0,
          colorId: targetColorId,
        }));

        // If the target colour doesn't have a thumbnail yet, set the first uploaded photo as its thumbnail
        const nextColors = prev.colors.map((c) => {
          if (targetColorId && c.id === targetColorId && !c.thumbnailUrl && appended[0]) {
            return { ...c, thumbnailUrl: appended[0].url };
          }
          return c;
        });

        return {
          ...prev,
          colors: nextColors,
          images: [...prev.images, ...appended].slice(0, MAX_PRODUCT_IMAGES),
        };
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void handleUploadFiles(e.dataTransfer.files);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    void handleUploadFiles(e.target.files);
  };

  const handleSetCover = (localKey: string) => {
    setForm((prev) => ({
      ...prev,
      images: prev.images.map((img) => ({
        ...img,
        isCover: img.localKey === localKey,
      })),
    }));
  };

  const handleSetColorThumbnail = (colorId: string, url: string) => {
    setForm((prev) => ({
      ...prev,
      colors: prev.colors.map((c) => (c.id === colorId ? { ...c, thumbnailUrl: url } : c)),
    }));
  };

  const handleAssignImageColor = (localKey: string, nextColorId: string | null) => {
    setForm((prev) => {
      const targetImage = prev.images.find((i) => i.localKey === localKey);
      const nextImages = prev.images.map((img) =>
        img.localKey === localKey ? { ...img, colorId: nextColorId } : img
      );
      const nextColors = prev.colors.map((c) => {
        if (targetImage && c.thumbnailUrl === targetImage.url && c.id !== nextColorId) {
          const replacement = nextImages.find((img) => img.colorId === c.id);
          return { ...c, thumbnailUrl: replacement?.url || '' };
        }
        if (nextColorId && c.id === nextColorId && !c.thumbnailUrl && targetImage) {
          return { ...c, thumbnailUrl: targetImage.url };
        }
        return c;
      });
      return { ...prev, colors: nextColors, images: nextImages };
    });
  };

  const handleMoveImage = (localKey: string, delta: -1 | 1) => {
    setForm((prev) => {
      const index = prev.images.findIndex((i) => i.localKey === localKey);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= prev.images.length) return prev;
      const next = [...prev.images];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return { ...prev, images: next };
    });
  };

  const handleRemoveImage = (localKey: string) => {
    setForm((prev) => {
      const removed = prev.images.find((i) => i.localKey === localKey);
      const remaining = prev.images.filter((i) => i.localKey !== localKey);
      if (remaining.length > 0 && !remaining.some((i) => i.isCover)) {
        remaining[0] = { ...remaining[0], isCover: true };
      }
      const nextColors = prev.colors.map((c) => {
        if (removed && c.thumbnailUrl === removed.url) {
          const nextThumb = remaining.find((i) => i.colorId === c.id)?.url || '';
          return { ...c, thumbnailUrl: nextThumb };
        }
        return c;
      });
      return { ...prev, colors: nextColors, images: remaining };
    });
  };

  const handleAddColor = () => {
    const cleanName = newColorName.trim();
    if (!cleanName) return;
    if (form.colors.some((c) => c.name.toLowerCase() === cleanName.toLowerCase())) {
      setFieldErrors((prev) => ({
        ...prev,
        colors: `Colour "${cleanName}" already exists on this product.`,
      }));
      return;
    }
    clearFieldError('colors');
    clearFieldError('images');
    clearFieldError('variants');

    const usedIds = new Set(form.colors.map((c) => c.id));
    const newId = makeStableColorId(cleanName, form.colors.length, usedIds);

    setForm((prev) => {
      const firstColor = prev.colors[0];
      // When upgrading a single-colour product to multi-colour, tag previously unassigned photos to Colour #1
      const updatedImages =
        prev.colors.length === 1 && firstColor
          ? prev.images.map((img) => (img.colorId ? img : { ...img, colorId: firstColor.id }))
          : prev.images;

      const updatedExistingColors = prev.colors.map((c, idx) => {
        if (idx === 0 && !c.thumbnailUrl) {
          const firstPhoto = updatedImages.find((img) => img.colorId === c.id);
          return firstPhoto ? { ...c, thumbnailUrl: firstPhoto.url } : c;
        }
        return c;
      });

      const parsedSizes = Array.from(
        new Set(
          prev.sizesInput
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      );
      const sizesForNewColor = parsedSizes.length > 0 ? parsedSizes : ['Free Size'];
      const cleanBaseSku = (prev.sku || 'SC').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      const colorSkuCode =
        cleanName
          .replace(/[^A-Z0-9]/gi, '')
          .slice(0, 4)
          .toUpperCase() || `C${prev.colors.length + 1}`;

      const starterVariants: EditableVariant[] = sizesForNewColor.map((size, idx) => {
        const cleanSize = size.replace(/[^A-Z0-9]/gi, '').slice(0, 5).toUpperCase() || 'SZ';
        return {
          id: `new-${crypto.randomUUID()}`,
          sku: `${cleanBaseSku}-${colorSkuCode}-${cleanSize}-${idx + 1}`,
          size,
          colorId: newId,
          colorName: cleanName,
          colorHex: newColorHex,
          priceInr: prev.basePriceInr || '2499',
          priceOverrideInr: '',
          compareAtInr: prev.baseCompareAtInr,
          stockQty: '0',
          active: true,
        };
      });

      return {
        ...prev,
        colors: [
          ...updatedExistingColors,
          {
            id: newId,
            name: cleanName,
            hex: newColorHex,
            thumbnailUrl: '',
            position: updatedExistingColors.length,
            active: true,
          },
        ],
        images: updatedImages,
        variants: [...prev.variants, ...starterVariants],
      };
    });

    setSelectedColorId(newId);
    setGalleryViewMode('selected');
    setVariantViewMode('selected');
    setNewColorName('');
  };

  const handleRenameColor = (colorId: string, nextName: string) => {
    clearFieldError('colors');
    setForm((prev) => ({
      ...prev,
      colors: prev.colors.map((c) => (c.id === colorId ? { ...c, name: nextName } : c)),
      variants: prev.variants.map((v) =>
        v.colorId === colorId ? { ...v, colorName: nextName } : v
      ),
    }));
  };

  const handleChangeColorHex = (colorId: string, nextHex: string) => {
    setForm((prev) => ({
      ...prev,
      colors: prev.colors.map((c) => (c.id === colorId ? { ...c, hex: nextHex } : c)),
      variants: prev.variants.map((v) =>
        v.colorId === colorId ? { ...v, colorHex: nextHex } : v
      ),
    }));
  };

  const handleToggleColorActive = (colorId: string) => {
    clearFieldError('colors');
    setForm((prev) => ({
      ...prev,
      colors: prev.colors.map((c) => (c.id === colorId ? { ...c, active: !c.active } : c)),
    }));
  };

  const handleMoveColor = (colorId: string, delta: -1 | 1) => {
    setForm((prev) => {
      const idx = prev.colors.findIndex((c) => c.id === colorId);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= prev.colors.length) return prev;
      const next = [...prev.colors];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return {
        ...prev,
        colors: next.map((c, position) => ({ ...c, position })),
      };
    });
  };

  const handleRemoveColor = (colorId: string) => {
    if (form.colors.length <= 1) return;
    setForm((prev) => {
      const remainingColors = prev.colors
        .filter((c) => c.id !== colorId)
        .map((c, idx) => ({ ...c, position: idx }));
      const fallbackColor = remainingColors[0];
      const remainingVariants = prev.variants.filter((v) => v.colorId !== colorId);
      const safeVariants =
        remainingVariants.length > 0
          ? remainingVariants
          : [
              {
                id: `new-${crypto.randomUUID()}`,
                sku: `${(prev.sku || 'SC').toUpperCase()}-1`,
                size: 'Free Size',
                colorId: fallbackColor.id,
                colorName: fallbackColor.name,
                colorHex: fallbackColor.hex,
                priceInr: prev.basePriceInr || '2499',
                priceOverrideInr: '',
                compareAtInr: prev.baseCompareAtInr,
                stockQty: '0',
                active: true,
              },
            ];
      const remainingImages = prev.images.map((img) =>
        img.colorId === colorId ? { ...img, colorId: null } : img
      );
      return {
        ...prev,
        colors: remainingColors,
        variants: safeVariants,
        images: remainingImages,
      };
    });
  };

  const handleSyncVariantMatrix = () => {
    const parsedSizes = Array.from(
      new Set(
        form.sizesInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    const sizes = parsedSizes.length > 0 ? parsedSizes : ['Free Size'];
    const colors =
      form.colors.length > 0
        ? form.colors
        : [
            {
              id: makeStableColorId('Signature', 0),
              name: 'Signature',
              hex: '#49243E',
              thumbnailUrl: '',
              position: 0,
              active: true,
            },
          ];

    setForm((prev) => {
      const existingById = new Map(
        prev.variants.map((v) => [`${v.colorId}::${v.size.toLowerCase()}`, v])
      );
      const existingByName = new Map(
        prev.variants.map((v) => [`${v.colorName.toLowerCase()}::${v.size.toLowerCase()}`, v])
      );
      const nextVariants: EditableVariant[] = [];
      let counter = 1;
      for (const color of colors) {
        for (const size of sizes) {
          const existing =
            existingById.get(`${color.id}::${size.toLowerCase()}`) ||
            existingByName.get(`${color.name.toLowerCase()}::${size.toLowerCase()}`);
          if (existing) {
            nextVariants.push({
              ...existing,
              colorId: color.id,
              colorName: color.name,
              colorHex: color.hex,
            });
          } else {
            const cleanBaseSku = (prev.sku || 'SC').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
            const cleanColor = color.name.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'CLR';
            const cleanSize = size.replace(/[^A-Z0-9]/gi, '').slice(0, 5).toUpperCase() || 'SZ';
            nextVariants.push({
              id: `new-${crypto.randomUUID()}`,
              sku: `${cleanBaseSku}-${cleanColor}-${cleanSize}-${counter}`,
              size,
              colorId: color.id,
              colorName: color.name,
              colorHex: color.hex,
              priceInr: prev.basePriceInr || '2499',
              priceOverrideInr: '',
              compareAtInr: prev.baseCompareAtInr,
              stockQty: '0',
              active: true,
            });
          }
          counter += 1;
        }
      }
      return { ...prev, variants: nextVariants };
    });
  };

  const handleApplyBasePriceToVariants = () => {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.map((v) => ({
        ...v,
        priceInr: prev.basePriceInr,
        priceOverrideInr: '',
        compareAtInr: prev.baseCompareAtInr,
      })),
    }));
  };

  const handleAddSingleVariantRow = (forColor?: EditableColor | null) => {
    const targetColor = forColor || activeColor || form.colors[0];
    if (!targetColor) return;
    setForm((prev) => {
      const usedSizes = new Set(
        prev.variants
          .filter((v) => v.colorId === targetColor.id)
          .map((v) => v.size.toLowerCase())
      );
      const nextSize =
        QUICK_SIZE_PRESETS.find((sz) => !usedSizes.has(sz.toLowerCase())) || 'Free Size';
      const cleanColor = targetColor.name.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'CLR';
      const cleanSize = nextSize.replace(/[^A-Z0-9]/gi, '').slice(0, 5).toUpperCase() || 'SZ';
      return {
        ...prev,
        variants: [
          ...prev.variants,
          {
            id: `new-${crypto.randomUUID()}`,
            sku: `${(prev.sku || 'SC').toUpperCase()}-${cleanColor}-${cleanSize}-${prev.variants.length + 1}`,
            size: nextSize,
            colorId: targetColor.id,
            colorName: targetColor.name,
            colorHex: targetColor.hex,
            priceInr: prev.basePriceInr || '2499',
            priceOverrideInr: '',
            compareAtInr: prev.baseCompareAtInr,
            stockQty: '0',
            active: true,
          },
        ],
      };
    });
  };

  const scrollToAlert = () => {
    setTab('edit');
    if (drawerScrollRef.current) {
      drawerScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleApplyTotalStockToVariants = (rawTotalStock: string) => {
    const parsedTotal = Number.parseInt(rawTotalStock, 10);
    if (!Number.isFinite(parsedTotal) || parsedTotal < 0) {
      setForm((prev) => ({
        ...prev,
        variants: prev.variants.map((v, idx) =>
          idx === 0 ? { ...v, stockQty: rawTotalStock } : { ...v, stockQty: '0' }
        ),
      }));
      return;
    }
    const clampedTotal = Math.min(100_000, Math.max(0, parsedTotal));
    setForm((prev) => {
      const activeColorIds = new Set(prev.colors.filter((c) => c.active).map((c) => c.id));
      const eligibleIndices = prev.variants
        .map((v, idx) => (v.active && activeColorIds.has(v.colorId) ? idx : -1))
        .filter((idx) => idx >= 0);
      const count = eligibleIndices.length;
      if (count === 0) return prev;
      const basePerVariant = Math.floor(clampedTotal / count);
      const remainder = clampedTotal % count;
      const stockMap = new Map<number, string>();
      eligibleIndices.forEach((vIdx, pos) => {
        stockMap.set(vIdx, String(basePerVariant + (pos < remainder ? 1 : 0)));
      });
      return {
        ...prev,
        variants: prev.variants.map((v, idx) =>
          stockMap.has(idx) ? { ...v, stockQty: stockMap.get(idx)! } : v
        ),
      };
    });
  };

  const handleSave = async (targetStatusOverride?: 'draft' | 'published') => {
    if (saving || uploading) return;
    const targetStatus: 'draft' | 'published' =
      targetStatusOverride ?? form.visibilityStatus ?? 'published';
    setErrorText(null);
    setFieldErrors({});
    setVersionConflict(false);

    const nextFieldErrors: Record<string, string> = {};
    const cleanTitle = form.title.trim();
    if (cleanTitle.length < 2 || cleanTitle.length > 140) {
      nextFieldErrors.title = 'Product title must be between 2 and 140 characters.';
    }

    const cleanDescription = form.description.trim();
    if (cleanDescription.length < 10 || cleanDescription.length > 2500) {
      nextFieldErrors.description = 'Product description must be between 10 and 2500 characters.';
    }

    if (!form.category || !form.category.trim()) {
      nextFieldErrors.category = 'Please select a valid boutique collection category.';
    }

    const cleanSku = form.sku.trim().toUpperCase();
    if (cleanSku && !/^[A-Z0-9][A-Z0-9_-]{1,47}$/.test(cleanSku)) {
      nextFieldErrors.sku =
        'SKU must be 2–48 uppercase alphanumeric characters, hyphens, or underscores.';
    }

    const parsedBasePrice = inputToPaise(form.basePriceInr);
    const basePricePaise = parsedBasePrice ?? derivedTotals.minPricePaise;
    if (basePricePaise < 100 || basePricePaise > 100_000_000) {
      nextFieldErrors.price = 'Selling price must be between ₹1 and ₹10,00,000.';
    }

    let baseComparePaise: number | null = null;
    if (form.baseCompareAtInr.trim() !== '') {
      const parsedCompare = inputToPaise(form.baseCompareAtInr);
      if (parsedCompare === null || parsedCompare < 100) {
        nextFieldErrors.compareAtPrice = 'Compare-at MRP must be a valid INR amount (₹1 or higher).';
      } else if (parsedCompare <= basePricePaise) {
        nextFieldErrors.compareAtPrice = 'Compare-at MRP must be greater than the selling price.';
      } else {
        baseComparePaise = parsedCompare;
      }
    }

    const payloadColors = form.colors.map((c, idx) => ({
      id: c.id,
      name: c.name.trim(),
      hex: c.hex || '#49243E',
      thumbnailUrl: c.thumbnailUrl.trim() || null,
      position: idx,
      active: c.active,
    }));

    const payloadImages = form.images.map((img) => ({
      ...(img.id ? { id: img.id } : {}),
      url: img.url,
      alt: img.alt.trim() || cleanTitle,
      isCover: img.isCover,
      colorId: img.colorId || null,
    }));

    const colorLookup = new Map(payloadColors.map((c) => [c.id, c]));

    const payloadVariants: Array<{
      id?: string;
      sku: string;
      size: string;
      colorId: string | null;
      colorName: string;
      colorHex: string;
      pricePaise: number;
      priceOverridePaise: number | null;
      compareAtPaise: number | null;
      stockQty: number;
      active: boolean;
    }> = [];

    if (form.variants.length === 0) {
      nextFieldErrors.variants = 'Add at least one size/colour variant before saving.';
    } else {
      for (let i = 0; i < form.variants.length; i += 1) {
        const v = form.variants[i];
        const linkedColor = colorLookup.get(v.colorId);
        const size = v.size.trim();
        const colorName = (linkedColor?.name ?? v.colorName).trim();
        const colorHex = linkedColor?.hex ?? v.colorHex;

        const vSku = v.sku.trim().toUpperCase();
        if (vSku && !/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(vSku)) {
          nextFieldErrors.variants = `Variant SKU "${vSku}" contains invalid characters.`;
          break;
        }

        let priceOverridePaise: number | null = null;
        if (v.priceOverrideInr.trim() !== '') {
          const parsedOverride = inputToPaise(v.priceOverrideInr);
          if (parsedOverride === null || parsedOverride < 100 || parsedOverride > 100_000_000) {
            nextFieldErrors.variants = `Price override for ${colorName} / ${size} must be at least ₹1.`;
            break;
          }
          priceOverridePaise = parsedOverride;
        }

        const effectivePricePaise =
          priceOverridePaise !== null
            ? priceOverridePaise
            : (basePricePaise >= 100 ? basePricePaise : inputToPaise(v.priceInr) || 0);

        let cPaise: number | null = null;
        if (v.compareAtInr.trim() !== '') {
          const parsedVarCompare = inputToPaise(v.compareAtInr);
          if (parsedVarCompare === null || parsedVarCompare <= effectivePricePaise) {
            nextFieldErrors.variants = `Compare-at MRP for ${colorName} / ${size} must be higher than its selling price.`;
            break;
          }
          cPaise = parsedVarCompare;
        }

        const stockNum = Number.parseInt(v.stockQty, 10);
        if (!Number.isInteger(stockNum) || stockNum < 0 || stockNum > 100_000) {
          nextFieldErrors.variants = `Stock quantity for ${colorName} / ${size} must be a whole number (0 or higher).`;
          break;
        }

        payloadVariants.push({
          ...(v.id.startsWith('new-') ? {} : { id: v.id }),
          sku: vSku,
          size,
          colorId: linkedColor ? linkedColor.id : v.colorId || null,
          colorName,
          colorHex,
          pricePaise: effectivePricePaise,
          priceOverridePaise,
          compareAtPaise: cPaise,
          stockQty: stockNum,
          active: v.active,
        });
      }
    }

    // Shared multi-colour matrix & publish completeness validation
    if (!nextFieldErrors.variants && !nextFieldErrors.colors && !nextFieldErrors.images) {
      const matrixCheck = validateColorVariantMatrix({
        status: targetStatus,
        colors: payloadColors,
        images: payloadImages,
        variants: payloadVariants,
      });
      if (!matrixCheck.ok) {
        Object.assign(nextFieldErrors, matrixCheck.fieldErrors);
        if (Object.keys(nextFieldErrors).length === 0 && matrixCheck.error) {
          nextFieldErrors.variants = matrixCheck.error;
        }
      }
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      const firstError = Object.values(nextFieldErrors)[0];
      setErrorText(firstError);
      scrollToAlert();
      return;
    }

    const payload = {
      ...(product ? { expectedVersion: product.version } : {}),
      title: cleanTitle,
      category: form.category,
      sku: cleanSku,
      description: cleanDescription,
      fabricNote: form.fabricNote.trim(),
      includedPieces: form.includedPieces.trim(),
      careNote: form.careNote.trim(),
      pricePaise: basePricePaise,
      compareAtPaise: baseComparePaise,
      lowStockThreshold: Math.max(0, Number.parseInt(form.lowStockThreshold, 10) || 0),
      featured: form.featured,
      status: targetStatus,
      colors: payloadColors,
      variants: payloadVariants,
      images: payloadImages,
    };

    setSaving(true);
    try {
      const endpoint = product
        ? `/api/admin/products/${encodeURIComponent(product.id)}`
        : '/api/admin/products';
      const method = product ? 'PATCH' : 'POST';
      const res = await apiRequest<{ product: AdminProduct }>(endpoint, {
        method,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.code === 'VERSION_CONFLICT') {
          setVersionConflict(true);
        }
        if (res.fieldErrors) {
          setFieldErrors(res.fieldErrors);
        }
        setErrorText(res.error);
        scrollToAlert();
        return;
      }

      const nextBaseline = createInitialFormState(res.data.product, categories);
      setBaselineSnapshot(JSON.stringify(nextBaseline));
      onSaved(
        res.data.product,
        product
          ? `Product updated — "${res.data.product.name}" (${targetStatus === 'published' ? 'Published' : 'Draft'}).`
          : targetStatus === 'published'
            ? `Published "${res.data.product.name}" live on the storefront.`
            : `Saved draft "${res.data.product.name}".`
      );
    } finally {
      setSaving(false);
    }
  };

  // Filtered images & variants for the active colour workspace
  const visibleImages = useMemo(() => {
    if (galleryViewMode === 'all' || !activeColor) return form.images;
    return form.images.filter(
      (img) => img.colorId === activeColor.id || (form.colors.length === 1 && !img.colorId)
    );
  }, [form.images, form.colors.length, galleryViewMode, activeColor]);

  const visibleVariants = useMemo(() => {
    return form.variants
      .map((variant, originalIndex) => ({ variant, originalIndex }))
      .filter(({ variant }) => {
        if (variantViewMode === 'all' || !activeColor) return true;
        return variant.colorId === activeColor.id;
      });
  }, [form.variants, variantViewMode, activeColor]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
          onClick={attemptClose}
          className="fixed inset-0 z-50 flex justify-end bg-[#242124]/50"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-editor-title"
            onClick={(e) => e.stopPropagation()}
            initial={prefersReducedMotion ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={prefersReducedMotion ? undefined : { x: '100%' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="flex h-full w-full max-w-4xl flex-col bg-[#FFF9F5] shadow-2xl"
          >
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#49243E]/12 bg-white px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#B76E79]">
                  {product ? `Editing ${product.status} · v${product.version}` : 'New Atelier Creation'}
                </p>
                <h2
                  id="admin-editor-title"
                  className="truncate font-serif text-2xl font-semibold text-[#49243E]"
                >
                  {product ? product.name : form.title || 'Add Boutique Product'}
                </h2>
              </div>

              <div className="flex items-center gap-2">
                <div
                  role="tablist"
                  aria-label="Editor view mode"
                  className="inline-flex rounded-xl border border-[#49243E]/12 bg-[#FFF9F5] p-1"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'edit'}
                    onClick={() => setTab('edit')}
                    className={`min-h-[36px] rounded-lg px-3 text-xs font-medium transition-colors ${
                      tab === 'edit' ? 'bg-[#49243E] text-[#FFF9F5]' : 'text-[#49243E]'
                    }`}
                  >
                    Editor
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'preview'}
                    onClick={() => setTab('preview')}
                    className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors ${
                      tab === 'preview' ? 'bg-[#49243E] text-[#FFF9F5]' : 'text-[#49243E]'
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Live Preview</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={attemptClose}
                  aria-label="Close product editor"
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[#49243E]/15 text-[#49243E] hover:bg-[#F3D5DF]/40"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Unsaved Changes Prompt Banner */}
            {discardPromptOpen && (
              <div
                role="alertdialog"
                aria-label="Unsaved changes confirmation"
                className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B76E79]/40 bg-[#F3D5DF]/45 px-5 py-3 text-xs text-[#49243E] sm:px-6"
              >
                <span className="font-medium">
                  You have unsaved changes. Discard them and close the editor?
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDiscardPromptOpen(false)}
                    className="min-h-[34px] rounded-lg border border-[#49243E]/25 bg-white px-3 font-medium text-[#49243E]"
                  >
                    Keep Editing
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="min-h-[34px] rounded-lg bg-[#49243E] px-3 font-medium text-[#FFF9F5]"
                  >
                    Discard Changes
                  </button>
                </div>
              </div>
            )}

            {/* Scrollable Content */}
            <div ref={drawerScrollRef} className="flex-1 overflow-y-auto p-5 sm:p-6">
              {errorText && (
                <div
                  role="alert"
                  className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#B76E79]/55 bg-[#F3D5DF]/35 p-4 text-sm text-[#49243E]"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                    <span>{errorText}</span>
                  </div>
                  {versionConflict && product && (
                    <button
                      type="button"
                      onClick={() => void onReloadProduct(product.id)}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[#49243E] px-3 text-xs font-medium text-[#FFF9F5]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Reload Latest Version</span>
                    </button>
                  )}
                </div>
              )}

              {tab === 'preview' ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                      <p className="text-xs font-medium uppercase tracking-wider text-[#B76E79]">
                        Storefront Card Preview
                      </p>
                      <p className="mt-1 text-xs text-[#242124]/65">
                        How this piece appears in the Boutique Showcase grid (one card per parent product).
                      </p>
                      <div className="mx-auto mt-5 max-w-[290px]">
                        <ProductCard
                          product={previewProduct}
                          isWishlisted={false}
                          onToggleWishlist={() => undefined}
                          onQuickView={() => undefined}
                        />
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                      <p className="text-xs font-medium uppercase tracking-wider text-[#B76E79]">
                        Product Page Colour Selector Preview
                      </p>
                      <p className="mt-1 text-xs text-[#242124]/65">
                        Click colour thumbnails below to verify gallery switching and garment framing.
                      </p>

                      {activePreviewColor ? (
                        <div className="mt-4">
                          <div className="mx-auto aspect-[3/4] max-w-[280px] overflow-hidden rounded-2xl bg-[#F8F1ED]">
                            {activePreviewColor.images[0]?.src || activePreviewColor.thumbnailUrl ? (
                              <BoutiqueImage
                                src={activePreviewColor.images[0]?.src || activePreviewColor.thumbnailUrl}
                                alt={`${previewProduct.name} — ${activePreviewColor.name}`}
                                loading="eager"
                                className="h-full w-full object-cover object-top"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-xs text-[#49243E]/55">
                                No photo uploaded for {activePreviewColor.name}
                              </div>
                            )}
                          </div>

                          <div className="mt-4">
                            <p className="text-xs text-[#242124]/70">
                              Selected Colour:{' '}
                              <span className="font-semibold text-[#49243E]">
                                {activePreviewColor.name}
                              </span>
                            </p>
                            <div className="mt-2.5 flex gap-2.5 overflow-x-auto pb-1">
                              {previewNormalizedColors.map((col) => {
                                const isSel = col.id === activePreviewColor.id;
                                return (
                                  <button
                                    key={col.id}
                                    type="button"
                                    onClick={() => setPreviewColorId(col.id)}
                                    aria-pressed={isSel}
                                    className={`relative h-[86px] w-[66px] shrink-0 overflow-hidden rounded-xl border-2 bg-[#F8F1ED] transition-all ${
                                      isSel
                                        ? 'border-[#242124] shadow-sm'
                                        : 'border-[#49243E]/18 opacity-80 hover:opacity-100'
                                    }`}
                                  >
                                    {col.thumbnailUrl ? (
                                      <BoutiqueImage
                                        src={col.thumbnailUrl}
                                        alt={col.name}
                                        loading="eager"
                                        className="h-full w-full object-cover object-top"
                                      />
                                    ) : (
                                      <span
                                        className="block h-full w-full"
                                        style={{ backgroundColor: col.hex }}
                                      />
                                    )}
                                    {col.isSoldOut && (
                                      <span className="absolute inset-x-0 bottom-0 bg-[#242124]/75 py-0.5 text-[9px] font-semibold uppercase text-white">
                                        Sold Out
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-6 text-sm text-[#49243E]/65">
                          Enable at least one active colour to preview the product selector.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Core Product Info */}
                  <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                    <h3 className="font-serif text-xl font-semibold text-[#49243E]">
                      Product Identity &amp; Story
                    </h3>

                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-[#49243E]">
                          Product Title
                        </label>
                        <input
                          type="text"
                          value={form.title}
                          onChange={(e) => {
                            clearFieldError('title');
                            setForm((p) => ({ ...p, title: e.target.value }));
                          }}
                          placeholder="Rosewood Organza Tiered Anarkali"
                          className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 text-sm focus:bg-white focus:outline-none ${
                            fieldErrors.title
                              ? 'border-[#9B2C3E] focus:border-[#9B2C3E]'
                              : 'border-[#49243E]/18 focus:border-[#49243E]'
                          }`}
                        />
                        {fieldErrors.title && (
                          <p className="mt-1 text-xs font-medium text-[#9B2C3E]">{fieldErrors.title}</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Collection Category
                        </label>
                        <select
                          value={form.category}
                          onChange={(e) => {
                            clearFieldError('category');
                            setForm((p) => ({
                              ...p,
                              category: e.target.value as CollectionCategory,
                            }));
                          }}
                          className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3 text-sm text-[#49243E] focus:bg-white focus:outline-none ${
                            fieldErrors.category
                              ? 'border-[#9B2C3E] focus:border-[#9B2C3E]'
                              : 'border-[#49243E]/18 focus:border-[#49243E]'
                          }`}
                        >
                          {Array.from(
                            new Set(
                              [...categories.map((c) => c.name), form.category].filter(Boolean)
                            )
                          ).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        {fieldErrors.category && (
                          <p className="mt-1 text-xs font-medium text-[#9B2C3E]">
                            {fieldErrors.category}
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Master SKU
                        </label>
                        <input
                          type="text"
                          value={form.sku}
                          onChange={(e) => {
                            clearFieldError('sku');
                            setForm((p) => ({ ...p, sku: e.target.value.toUpperCase() }));
                          }}
                          placeholder="SC-ETH-101"
                          className={`mt-1 h-11 w-full rounded-xl border bg-[#FFF9F5]/60 px-3.5 font-mono text-sm uppercase focus:bg-white focus:outline-none ${
                            fieldErrors.sku
                              ? 'border-[#9B2C3E] focus:border-[#9B2C3E]'
                              : 'border-[#49243E]/18 focus:border-[#49243E]'
                          }`}
                        />
                        {fieldErrors.sku && (
                          <p className="mt-1 text-xs font-medium text-[#9B2C3E]">{fieldErrors.sku}</p>
                        )}
                      </div>

                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-[#49243E]">
                          Editorial Description
                        </label>
                        <textarea
                          rows={3}
                          value={form.description}
                          onChange={(e) => {
                            clearFieldError('description');
                            setForm((p) => ({ ...p, description: e.target.value }));
                          }}
                          placeholder="Describe silhouette, drape, occasion, and craftsmanship..."
                          className={`mt-1 w-full rounded-xl border bg-[#FFF9F5]/60 p-3.5 text-sm focus:bg-white focus:outline-none ${
                            fieldErrors.description
                              ? 'border-[#9B2C3E] focus:border-[#9B2C3E]'
                              : 'border-[#49243E]/18 focus:border-[#49243E]'
                          }`}
                        />
                        {fieldErrors.description && (
                          <p className="mt-1 text-xs font-medium text-[#9B2C3E]">
                            {fieldErrors.description}
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Fabric &amp; Craft Note
                        </label>
                        <input
                          type="text"
                          value={form.fabricNote}
                          onChange={(e) =>
                            setForm((p) => ({ ...p, fabricNote: e.target.value }))
                          }
                          placeholder="Handloom silk-organza with mulmul lining"
                          className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Included Pieces
                        </label>
                        <input
                          type="text"
                          value={form.includedPieces}
                          onChange={(e) =>
                            setForm((p) => ({ ...p, includedPieces: e.target.value }))
                          }
                          placeholder="e.g., Kurta, wide-leg pants, and dupatta"
                          className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-[#49243E]">
                          Garment Care Instructions
                        </label>
                        <input
                          type="text"
                          value={form.careNote}
                          onChange={(e) =>
                            setForm((p) => ({ ...p, careNote: e.target.value }))
                          }
                          placeholder="e.g., Gentle hand wash separately or dry clean"
                          className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                        />
                      </div>

                      {product?.pendingFields && product.pendingFields.length > 0 && (
                        <div className="sm:col-span-2 rounded-xl border border-[#B76E79]/40 bg-[#FFF9F5] p-3.5 text-xs text-[#49243E]">
                          <p className="font-semibold">
                            Pending items before publishing
                            {product.sourceImageFilename
                              ? ` (Reference: ${product.sourceImageFilename})`
                              : ''}
                          </p>
                          <p className="mt-1 text-[#49243E]/80">
                            {product.pendingFields.join(', ')}
                          </p>
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-3">
                        <div>
                          <label className="block text-xs font-medium text-[#49243E]">
                            Storefront Visibility
                          </label>
                          <select
                            aria-label="Storefront Visibility"
                            value={form.visibilityStatus}
                            onChange={(e) =>
                              setForm((p) => ({
                                ...p,
                                visibilityStatus:
                                  e.target.value === 'draft' ? 'draft' : 'published',
                              }))
                            }
                            className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm text-[#49243E] focus:border-[#49243E] focus:bg-white focus:outline-none"
                          >
                            <option value="published">Published (Visible on Storefront)</option>
                            <option value="draft">Draft (Hidden from Storefront)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-[#49243E]">
                            Low Stock Alert
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={500}
                            value={form.lowStockThreshold}
                            onChange={(e) =>
                              setForm((p) => ({ ...p, lowStockThreshold: e.target.value }))
                            }
                            className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm tabular-nums focus:border-[#49243E] focus:bg-white focus:outline-none"
                          />
                        </div>

                        <div className="flex items-end pb-0.5">
                          <label className="flex min-h-[42px] w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-xs font-medium text-[#49243E]">
                            <input
                              type="checkbox"
                              checked={form.featured}
                              onChange={(e) =>
                                setForm((p) => ({ ...p, featured: e.target.checked }))
                              }
                              className="h-4 w-4 accent-[#49243E]"
                            />
                            <span>Featured Style</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Colour Variants & Galleries Manager */}
                  <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="flex items-center gap-2 font-serif text-xl font-semibold text-[#49243E]">
                          <Palette className="h-5 w-5 text-[#B76E79]" aria-hidden="true" />
                          <span>Colour Options &amp; Display Order</span>
                        </h3>
                        <p className="text-xs text-[#242124]/65">
                          Add every colourway of this garment (including multi-word combinations like &ldquo;Teal &amp; Pink&rdquo;). Select a colour below to manage its photos, thumbnail, and sizes.
                        </p>
                      </div>
                      <span className="text-xs font-medium text-[#49243E]/75 tabular-nums">
                        {derivedTotals.activeColorCount} active / {form.colors.length} total colours
                      </span>
                    </div>

                    {/* Add New Colour Bar */}
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <input
                        type="color"
                        value={newColorHex}
                        onChange={(e) => setNewColorHex(e.target.value)}
                        aria-label="Pick swatch colour hex"
                        className="h-10 w-11 cursor-pointer rounded-xl border border-[#49243E]/18 bg-white p-1"
                      />
                      <input
                        type="text"
                        value={newColorName}
                        onChange={(e) => setNewColorName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddColor();
                          }
                        }}
                        placeholder="Add colour name (e.g. Teal & Pink, Mustard Gold)"
                        aria-label="New colour name"
                        className="h-10 min-w-[200px] flex-1 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleAddColor}
                        className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Add Colour</span>
                      </button>
                    </div>

                    {fieldErrors.colors && (
                      <p className="mt-2.5 text-xs font-medium text-[#9B2C3E]">{fieldErrors.colors}</p>
                    )}

                    {/* Colour Selector Cards Strip */}
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {form.colors.map((col, idx) => {
                        const isSelected = activeColor?.id === col.id;
                        const photoCount = form.images.filter(
                          (img) => img.colorId === col.id || (form.colors.length === 1 && !img.colorId)
                        ).length;
                        const colVariants = form.variants.filter((v) => v.colorId === col.id);
                        const colStock = colVariants
                          .filter((v) => v.active)
                          .reduce((sum, v) => sum + Math.max(0, Number.parseInt(v.stockQty, 10) || 0), 0);
                        const thumbPreview =
                          col.thumbnailUrl ||
                          form.images.find((img) => img.colorId === col.id)?.url ||
                          (form.colors.length === 1 ? form.images[0]?.url : '') ||
                          '';

                        return (
                          <div
                            key={col.id}
                            onClick={() => setSelectedColorId(col.id)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedColorId(col.id);
                              }
                            }}
                            className={`flex cursor-pointer items-center gap-3 rounded-2xl border-2 p-2.5 text-left transition-all ${
                              isSelected
                                ? 'border-[#49243E] bg-[#FFF9F5] shadow-sm'
                                : 'border-[#49243E]/12 bg-white hover:border-[#49243E]/35'
                            } ${!col.active ? 'opacity-65' : ''}`}
                          >
                            <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-lg border border-[#49243E]/15 bg-[#F8F1ED]">
                              {thumbPreview ? (
                                <BoutiqueImage
                                  src={thumbPreview}
                                  alt={col.name}
                                  loading="eager"
                                  className="h-full w-full object-cover object-top"
                                />
                              ) : (
                                <span
                                  className="flex h-full w-full items-center justify-center text-[9px] font-medium text-white/90"
                                  style={{ backgroundColor: col.hex }}
                                >
                                  No img
                                </span>
                              )}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="h-3 w-3 shrink-0 rounded-full border border-[#242124]/20"
                                  style={{ backgroundColor: col.hex }}
                                />
                                <p className="truncate text-sm font-semibold text-[#49243E]">
                                  {col.name || `Colour #${idx + 1}`}
                                </p>
                              </div>
                              <p className="mt-0.5 text-[11px] text-[#242124]/65 tabular-nums">
                                {photoCount} {photoCount === 1 ? 'photo' : 'photos'} · {colVariants.length}{' '}
                                {colVariants.length === 1 ? 'size' : 'sizes'} · {colStock} stock
                              </p>
                              <div className="mt-1 flex items-center gap-1.5">
                                {!col.active && (
                                  <span className="rounded bg-[#242124]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#242124]/70">
                                    Inactive
                                  </span>
                                )}
                                {form.colors.length > 1 && photoCount === 0 && col.active && (
                                  <span className="rounded bg-[#9B2C3E]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#9B2C3E]">
                                    Needs photo
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Selected Colour Inline Controls */}
                    {activeColor && (
                      <div className="mt-4 flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5]/75 p-3.5">
                        <div className="flex flex-wrap items-end gap-2.5">
                          <div>
                            <label className="block text-[10px] font-semibold uppercase tracking-wider text-[#49243E]/70">
                              Selected Colour Name
                            </label>
                            <div className="mt-1 flex items-center gap-2">
                              <input
                                type="color"
                                value={activeColor.hex}
                                onChange={(e) => handleChangeColorHex(activeColor.id, e.target.value)}
                                aria-label={`Hex swatch for ${activeColor.name}`}
                                className="h-9 w-10 cursor-pointer rounded-lg border border-[#49243E]/18 bg-white p-0.5"
                              />
                              <input
                                type="text"
                                value={activeColor.name}
                                onChange={(e) => handleRenameColor(activeColor.id, e.target.value)}
                                placeholder="e.g. Teal & Pink"
                                aria-label="Edit selected colour name"
                                className="h-9 w-48 rounded-lg border border-[#49243E]/18 bg-white px-2.5 text-xs font-medium text-[#49243E] focus:border-[#49243E] focus:outline-none sm:w-56"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={form.colors.findIndex((c) => c.id === activeColor.id) === 0}
                            onClick={() => handleMoveColor(activeColor.id, -1)}
                            aria-label="Move colour earlier"
                            title="Move earlier in selector"
                            className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#49243E]/18 bg-white px-2.5 text-xs text-[#49243E] hover:bg-[#F3D5DF]/35 disabled:opacity-35"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden sm:inline">Move Left</span>
                          </button>
                          <button
                            type="button"
                            disabled={
                              form.colors.findIndex((c) => c.id === activeColor.id) ===
                              form.colors.length - 1
                            }
                            onClick={() => handleMoveColor(activeColor.id, 1)}
                            aria-label="Move colour later"
                            title="Move later in selector"
                            className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#49243E]/18 bg-white px-2.5 text-xs text-[#49243E] hover:bg-[#F3D5DF]/35 disabled:opacity-35"
                          >
                            <span className="hidden sm:inline">Move Right</span>
                            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleColorActive(activeColor.id)}
                            className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors ${
                              activeColor.active
                                ? 'border-[#49243E]/20 bg-white text-[#49243E] hover:bg-[#F3D5DF]/35'
                                : 'border-[#B76E79]/40 bg-[#F3D5DF]/40 text-[#49243E]'
                            }`}
                          >
                            {activeColor.active ? (
                              <>
                                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Active</span>
                              </>
                            ) : (
                              <>
                                <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Hidden</span>
                              </>
                            )}
                          </button>
                          {form.colors.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleRemoveColor(activeColor.id)}
                              className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#B76E79]/35 bg-white px-2.5 text-xs font-medium text-[#B76E79] hover:bg-[#F3D5DF]/35"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Remove</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Photography & Per-Colour Gallery */}
                  <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="font-serif text-xl font-semibold text-[#49243E]">
                          {galleryViewMode === 'selected' && activeColor
                            ? `Photos for "${activeColor.name}"`
                            : 'Product Photography (All Colours)'}
                        </h3>
                        <p className="text-xs text-[#242124]/65">
                          Upload JPEG, PNG, or WebP photos (max 5 MB each). Assign each photo to a colour and choose the thumbnail shown in the colour selector.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {form.colors.length > 1 && (
                          <div className="inline-flex rounded-xl border border-[#49243E]/15 bg-[#FFF9F5] p-0.5 text-[11px]">
                            <button
                              type="button"
                              onClick={() => setGalleryViewMode('selected')}
                              className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
                                galleryViewMode === 'selected'
                                  ? 'bg-[#49243E] text-[#FFF9F5]'
                                  : 'text-[#49243E]'
                              }`}
                            >
                              Selected Colour
                            </button>
                            <button
                              type="button"
                              onClick={() => setGalleryViewMode('all')}
                              className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
                                galleryViewMode === 'all'
                                  ? 'bg-[#49243E] text-[#FFF9F5]'
                                  : 'text-[#49243E]'
                              }`}
                            >
                              All ({form.images.length})
                            </button>
                          </div>
                        )}
                        <span className="text-xs font-medium text-[#49243E]/70 tabular-nums">
                          {form.images.length} / {MAX_PRODUCT_IMAGES}
                        </span>
                      </div>
                    </div>

                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      className={`mt-4 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${
                        dragOver
                          ? 'border-[#49243E] bg-[#F3D5DF]/25'
                          : fieldErrors.images
                            ? 'border-[#9B2C3E]/70 bg-[#F3D5DF]/15'
                            : 'border-[#49243E]/20 bg-[#FFF9F5]/65'
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        onChange={(e) => {
                          clearFieldError('images');
                          handleFileChange(e);
                        }}
                        className="sr-only"
                        id="admin-photo-upload-input"
                      />
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
                        {uploading ? (
                          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                        ) : (
                          <ImagePlus className="h-5 w-5" aria-hidden="true" />
                        )}
                      </div>
                      <p className="mt-2.5 text-sm font-medium text-[#49243E]">
                        {uploading
                          ? 'Verifying and storing photos...'
                          : activeColor
                            ? `Drop photos for "${activeColor.name}" here`
                            : 'Drop lookbook photos here'}
                      </p>
                      <label
                        htmlFor="admin-photo-upload-input"
                        className="mt-3 inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                      >
                        <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {activeColor ? `Upload for ${activeColor.name}` : 'Upload Photos'}
                        </span>
                      </label>
                    </div>
                    {fieldErrors.images && (
                      <p className="mt-2 text-xs font-medium text-[#9B2C3E]">{fieldErrors.images}</p>
                    )}

                    {visibleImages.length > 0 ? (
                      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {visibleImages.map((img, visibleIdx) => {
                          const globalIdx = form.images.findIndex((i) => i.localKey === img.localKey);
                          const assignedColor = form.colors.find((c) => c.id === img.colorId) || null;
                          const isColorThumb = Boolean(
                            assignedColor && assignedColor.thumbnailUrl === img.url
                          );

                          return (
                            <div
                              key={img.localKey}
                              className={`flex flex-col rounded-2xl border p-3 ${
                                img.isCover || isColorThumb
                                  ? 'border-[#49243E] bg-[#FFF9F5]'
                                  : 'border-[#49243E]/12 bg-white'
                              }`}
                            >
                              <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-[#F8F1ED]">
                                <BoutiqueImage
                                  src={img.url}
                                  alt={img.alt || form.title}
                                  loading="eager"
                                  className="h-full w-full object-cover object-top"
                                />
                                <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                                  {img.isCover && (
                                    <span className="rounded-lg bg-[#49243E] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#FFF9F5]">
                                      Cover
                                    </span>
                                  )}
                                  {isColorThumb && (
                                    <span className="rounded-lg bg-[#B76E79] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                                      Colour Thumb
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Colour Assignment Dropdown */}
                              <div className="mt-2.5">
                                <label className="sr-only">Assign photo to colour</label>
                                <select
                                  value={img.colorId || ''}
                                  onChange={(e) =>
                                    handleAssignImageColor(
                                      img.localKey,
                                      e.target.value ? e.target.value : null
                                    )
                                  }
                                  aria-label={`Assigned colour for photo ${visibleIdx + 1}`}
                                  className="h-8 w-full rounded-lg border border-[#49243E]/18 bg-white px-2 text-xs font-medium text-[#49243E] focus:border-[#49243E] focus:outline-none"
                                >
                                  <option value="">Shared / Unassigned</option>
                                  {form.colors.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      Colour: {c.name}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <input
                                type="text"
                                value={img.alt}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setForm((prev) => ({
                                    ...prev,
                                    images: prev.images.map((item) =>
                                      item.localKey === img.localKey ? { ...item, alt: val } : item
                                    ),
                                  }));
                                }}
                                placeholder="Photo alt text"
                                aria-label={`Alt text for photo ${visibleIdx + 1}`}
                                className="mt-2 h-8 w-full rounded-lg border border-[#49243E]/15 px-2.5 text-xs focus:border-[#49243E] focus:outline-none"
                              />

                              <div className="mt-2 flex flex-wrap items-center justify-between gap-1">
                                <div className="flex flex-wrap items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleSetCover(img.localKey)}
                                    disabled={img.isCover}
                                    className={`inline-flex min-h-[30px] items-center gap-1 rounded-lg px-2 text-[11px] font-medium ${
                                      img.isCover
                                        ? 'bg-[#F3D5DF]/50 text-[#49243E]'
                                        : 'border border-[#49243E]/15 text-[#49243E] hover:bg-[#F3D5DF]/35'
                                    }`}
                                  >
                                    <Star
                                      className={`h-3 w-3 ${img.isCover ? 'fill-[#49243E]' : ''}`}
                                    />
                                    <span>{img.isCover ? 'Cover' : 'Set Cover'}</span>
                                  </button>

                                  {assignedColor && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleSetColorThumbnail(assignedColor.id, img.url)
                                      }
                                      disabled={isColorThumb}
                                      className={`inline-flex min-h-[30px] items-center gap-1 rounded-lg px-2 text-[11px] font-medium ${
                                        isColorThumb
                                          ? 'bg-[#49243E] text-[#FFF9F5]'
                                          : 'border border-[#49243E]/15 text-[#49243E] hover:bg-[#F3D5DF]/35'
                                      }`}
                                    >
                                      {isColorThumb && <Check className="h-3 w-3" />}
                                      <span>{isColorThumb ? 'Thumb' : 'Set Thumb'}</span>
                                    </button>
                                  )}
                                </div>

                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={globalIdx <= 0}
                                    onClick={() => handleMoveImage(img.localKey, -1)}
                                    aria-label="Move photo earlier"
                                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#49243E]/15 text-[#49243E] disabled:opacity-35"
                                  >
                                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={globalIdx === form.images.length - 1}
                                    onClick={() => handleMoveImage(img.localKey, 1)}
                                    aria-label="Move photo later"
                                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#49243E]/15 text-[#49243E] disabled:opacity-35"
                                  >
                                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveImage(img.localKey)}
                                    aria-label="Remove photo"
                                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#B76E79]/30 text-[#B76E79] hover:bg-[#F3D5DF]/40"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      galleryViewMode === 'selected' &&
                      activeColor && (
                        <p className="mt-4 rounded-xl border border-[#49243E]/10 bg-[#FFF9F5]/60 px-3.5 py-2.5 text-xs text-[#49243E]/70">
                          No photos assigned to &ldquo;{activeColor.name}&rdquo; yet. Upload photos above or switch to &ldquo;All&rdquo; to assign existing photos.
                        </p>
                      )
                    )}
                  </div>

                  {/* Pricing & Variant Inventory */}
                  <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="font-serif text-xl font-semibold text-[#49243E]">
                          INR Pricing, Sizes &amp; Per-Colour Inventory
                        </h3>
                        <p className="text-xs text-[#242124]/65">
                          Variants inherit the base selling price unless you specify a variant-level Price Override. Stock is tracked per colour &amp; size.
                        </p>
                      </div>
                      <div className="rounded-xl bg-[#FFF9F5] px-3.5 py-2 text-right tabular-nums">
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#B76E79]">
                          Storefront Summary
                        </span>
                        <span className="text-sm font-semibold text-[#49243E]">
                          From {formatPaiseINR(derivedTotals.minPricePaise)} · {derivedTotals.totalStock} in stock
                        </span>
                      </div>
                    </div>

                    {/* Base Price & Total Stock Helpers */}
                    <div className="mt-4 grid grid-cols-1 gap-3 rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5]/65 p-4 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Base Selling Price (INR)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min={1}
                          aria-label="Selling Price (INR)"
                          value={form.basePriceInr}
                          onChange={(e) => {
                            const nextVal = e.target.value;
                            const nextNum = Number(nextVal);
                            clearFieldError('price');
                            clearFieldError('compareAtPrice');
                            clearFieldError('variants');
                            setForm((p) => {
                              const shouldClearBaseCompare =
                                p.baseCompareAtInr.trim() !== '' &&
                                Number.isFinite(nextNum) &&
                                nextNum > 0 &&
                                Number(p.baseCompareAtInr) <= nextNum;
                              return {
                                ...p,
                                basePriceInr: nextVal,
                                baseCompareAtInr: shouldClearBaseCompare ? '' : p.baseCompareAtInr,
                                variants: p.variants.map((v) => {
                                  if (v.priceOverrideInr.trim() !== '') return v;
                                  const clearVarCompare =
                                    v.compareAtInr.trim() !== '' &&
                                    Number.isFinite(nextNum) &&
                                    nextNum > 0 &&
                                    Number(v.compareAtInr) <= nextNum;
                                  return {
                                    ...v,
                                    priceInr: nextVal,
                                    compareAtInr: clearVarCompare ? '' : v.compareAtInr,
                                  };
                                }),
                              };
                            });
                          }}
                          className={`mt-1 h-10 w-full rounded-xl border bg-white px-3 text-sm tabular-nums focus:outline-none ${
                            fieldErrors.price
                              ? 'border-[#9B2C3E] focus:border-[#9B2C3E]'
                              : 'border-[#49243E]/18 focus:border-[#49243E]'
                          }`}
                        />
                        {fieldErrors.price && (
                          <p className="mt-1 text-xs font-medium text-[#9B2C3E]">{fieldErrors.price}</p>
                        )}
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Compare-at MRP (INR, optional)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          value={form.baseCompareAtInr}
                          onChange={(e) => {
                            const nextCompare = e.target.value;
                            clearFieldError('compareAtPrice');
                            setForm((p) => ({
                              ...p,
                              baseCompareAtInr: nextCompare,
                              variants: p.variants.map((v) => ({
                                ...v,
                                compareAtInr: nextCompare,
                              })),
                            }));
                          }}
                          placeholder="e.g. 3499"
                          className={`mt-1 h-10 w-full rounded-xl border bg-white px-3 text-sm tabular-nums focus:outline-none ${
                            fieldErrors.compareAtPrice
                              ? 'border-[#9B2C3E] focus:border-[#9B2C3E]'
                              : 'border-[#49243E]/18 focus:border-[#49243E]'
                          }`}
                        />
                        {fieldErrors.compareAtPrice && (
                          <p className="mt-1 text-xs font-medium text-[#9B2C3E]">
                            {fieldErrors.compareAtPrice}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Total Active Stock
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          aria-label="Total Stock Quantity"
                          value={String(derivedTotals.totalStock)}
                          onChange={(e) => {
                            clearFieldError('variants');
                            handleApplyTotalStockToVariants(e.target.value);
                          }}
                          className="mt-1 h-10 w-full rounded-xl border border-[#49243E]/18 bg-white px-3 text-sm font-semibold tabular-nums focus:border-[#49243E] focus:outline-none"
                        />
                      </div>
                      <div className="flex items-end">
                        <button
                          type="button"
                          onClick={handleApplyBasePriceToVariants}
                          className="h-10 w-full rounded-xl border border-[#49243E]/20 bg-white px-3 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35"
                        >
                          Reset Variant Overrides
                        </button>
                      </div>
                    </div>

                    {/* Size Matrix Generator */}
                    <div className="mt-4">
                      <label className="block text-xs font-medium text-[#49243E]">
                        Sizes Template (comma-separated, for Matrix Sync)
                      </label>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={form.sizesInput}
                          onChange={(e) => setForm((p) => ({ ...p, sizesInput: e.target.value }))}
                          placeholder="XS, S, M, L, XL"
                          className="h-10 min-w-[200px] flex-1 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleSyncVariantMatrix}
                          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-[#F3D5DF]/55 px-3.5 text-xs font-semibold text-[#49243E] hover:bg-[#F3D5DF]/80"
                        >
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Sync Size &times; Colour Matrix</span>
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {QUICK_SIZE_PRESETS.map((sz) => (
                          <button
                            key={sz}
                            type="button"
                            onClick={() => {
                              const current = form.sizesInput
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean);
                              if (!current.includes(sz)) {
                                setForm((p) => ({
                                  ...p,
                                  sizesInput: [...current, sz].join(', '),
                                }));
                              }
                            }}
                            className="rounded-lg border border-[#49243E]/15 bg-[#FFF9F5] px-2 py-1 text-[11px] font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                          >
                            + {sz}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Variant Filter & Add Bar */}
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-b border-[#49243E]/10 pb-3.5">
                      {form.colors.length > 1 ? (
                        <div className="inline-flex rounded-xl border border-[#49243E]/15 bg-[#FFF9F5] p-0.5 text-xs">
                          <button
                            type="button"
                            onClick={() => setVariantViewMode('selected')}
                            className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                              variantViewMode === 'selected'
                                ? 'bg-[#49243E] text-[#FFF9F5]'
                                : 'text-[#49243E]'
                            }`}
                          >
                            {activeColor ? activeColor.name : 'Selected Colour'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setVariantViewMode('all')}
                            className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                              variantViewMode === 'all'
                                ? 'bg-[#49243E] text-[#FFF9F5]'
                                : 'text-[#49243E]'
                            }`}
                          >
                            All Colours ({form.variants.length})
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs font-medium text-[#49243E]/75">
                          {form.variants.length} variant{' '}
                          {form.variants.length === 1 ? 'row' : 'rows'}
                        </span>
                      )}

                      <button
                        type="button"
                        onClick={() => handleAddSingleVariantRow(activeColor)}
                        className="inline-flex min-h-[36px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5]"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          Add Size{activeColor ? ` to ${activeColor.name}` : ' Row'}
                        </span>
                      </button>
                    </div>

                    {fieldErrors.variants && (
                      <p className="mt-3 rounded-xl border border-[#B76E79]/50 bg-[#F3D5DF]/25 px-3 py-2 text-xs font-medium text-[#9B2C3E]">
                        {fieldErrors.variants}
                      </p>
                    )}

                    {/* Variant List */}
                    <div className="mt-4 space-y-2.5">
                      {visibleVariants.map(({ variant, originalIndex }) => (
                        <div
                          key={variant.id}
                          className={`grid grid-cols-2 gap-2.5 rounded-xl border p-3 sm:grid-cols-12 sm:items-end ${
                            variant.active
                              ? 'border-[#49243E]/12 bg-[#FFF9F5]/45'
                              : 'border-[#49243E]/10 bg-[#242124]/[0.03] opacity-70'
                          }`}
                        >
                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              Colour
                            </label>
                            <select
                              value={variant.colorId}
                              onChange={(e) => {
                                const nextColor = form.colors.find((c) => c.id === e.target.value);
                                if (!nextColor) return;
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === originalIndex
                                      ? {
                                          ...v,
                                          colorId: nextColor.id,
                                          colorName: nextColor.name,
                                          colorHex: nextColor.hex,
                                        }
                                      : v
                                  ),
                                }));
                              }}
                              aria-label={`Variant colour ${originalIndex + 1}`}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs font-medium text-[#49243E]"
                            >
                              {form.colors.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="sm:col-span-1">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              Size
                            </label>
                            <input
                              type="text"
                              value={variant.size}
                              onChange={(e) => {
                                const val = e.target.value;
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === originalIndex ? { ...v, size: val } : v
                                  ),
                                }));
                              }}
                              aria-label={`Variant size ${originalIndex + 1}`}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs font-medium"
                            />
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              SKU
                            </label>
                            <input
                              type="text"
                              value={variant.sku}
                              onChange={(e) => {
                                const val = e.target.value.toUpperCase();
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === originalIndex ? { ...v, sku: val } : v
                                  ),
                                }));
                              }}
                              aria-label={`Variant SKU ${originalIndex + 1}`}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 font-mono text-[11px] uppercase"
                            />
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              Price Override (₹)
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min={1}
                              value={variant.priceOverrideInr}
                              onChange={(e) => {
                                const val = e.target.value;
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === originalIndex
                                      ? {
                                          ...v,
                                          priceOverrideInr: val,
                                          priceInr: val.trim() ? val : p.basePriceInr,
                                        }
                                      : v
                                  ),
                                }));
                              }}
                              placeholder={form.basePriceInr ? `Base ₹${form.basePriceInr}` : 'Inherit base'}
                              aria-label={`Variant price override ${originalIndex + 1}`}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs tabular-nums"
                            />
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              MRP (₹)
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              value={variant.compareAtInr}
                              onChange={(e) => {
                                const val = e.target.value;
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === originalIndex ? { ...v, compareAtInr: val } : v
                                  ),
                                }));
                              }}
                              placeholder="Optional"
                              aria-label={`Variant MRP ${originalIndex + 1}`}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs tabular-nums"
                            />
                          </div>

                          <div className="sm:col-span-1">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              Stock
                            </label>
                            <input
                              type="number"
                              min={0}
                              max={100000}
                              value={variant.stockQty}
                              onChange={(e) => {
                                const val = e.target.value;
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === originalIndex ? { ...v, stockQty: val } : v
                                  ),
                                }));
                              }}
                              aria-label={`Variant stock ${originalIndex + 1}`}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs font-semibold tabular-nums"
                            />
                          </div>

                          <div className="col-span-2 flex items-center justify-end gap-1.5 sm:col-span-2">
                            <button
                              type="button"
                              onClick={() =>
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === originalIndex ? { ...v, active: !v.active } : v
                                  ),
                                }))
                              }
                              aria-label={
                                variant.active ? 'Hide variant from storefront' : 'Activate variant'
                              }
                              title={variant.active ? 'Active' : 'Inactive'}
                              className={`inline-flex h-9 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium ${
                                variant.active
                                  ? 'border-[#49243E]/18 bg-white text-[#49243E] hover:bg-[#F3D5DF]/35'
                                  : 'border-[#B76E79]/40 bg-[#F3D5DF]/40 text-[#49243E]'
                              }`}
                            >
                              {variant.active ? (
                                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                              ) : (
                                <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              <span>{variant.active ? 'On' : 'Off'}</span>
                            </button>

                            <button
                              type="button"
                              disabled={form.variants.length <= 1}
                              onClick={() =>
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.filter((_, i) => i !== originalIndex),
                                }))
                              }
                              aria-label="Remove variant"
                              className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#B76E79]/30 text-[#B76E79] hover:bg-[#F3D5DF]/40 disabled:opacity-35"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      ))}

                      {visibleVariants.length === 0 && activeColor && (
                        <p className="rounded-xl border border-[#49243E]/10 bg-[#FFF9F5]/60 px-3.5 py-2.5 text-xs text-[#49243E]/70">
                          No size rows for &ldquo;{activeColor.name}&rdquo; yet. Click &ldquo;Add Size to {activeColor.name}&rdquo; or &ldquo;Sync Size &times; Colour Matrix&rdquo;.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#49243E]/12 bg-white px-5 py-4 sm:px-6">
              <div className="text-xs text-[#242124]/65">
                {isDirty ? (
                  <span className="font-medium text-[#B76E79]">Unsaved edits ready</span>
                ) : (
                  <span>All changes synced</span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={saving || uploading}
                  onClick={() => void handleSave('draft')}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#49243E]/25 bg-white px-4 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" aria-hidden="true" />
                  <span>{product?.status === 'published' ? 'Unpublish to Draft' : 'Save Draft'}</span>
                </button>

                <button
                  type="button"
                  disabled={saving || uploading}
                  onClick={() => void handleSave(product ? form.visibilityStatus : 'published')}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Globe className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span>
                    {product
                      ? form.visibilityStatus === 'draft'
                        ? 'Save Changes (Draft)'
                        : 'Save Changes'
                      : 'Publish to Storefront'}
                  </span>
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
