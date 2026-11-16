import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Eye,
  Globe,
  ImagePlus,
  Loader2,
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
  ProductVariant,
  StorefrontCategory,
} from '../../types/boutique';
import { formatPaiseINR } from '../../utils/format';
import { BoutiqueImage } from '../BoutiqueImage';
import { ProductCard } from '../ProductCard';

const QUICK_SIZE_PRESETS = ['XS', 'S', 'M', 'L', 'XL', 'Free Size'] as const;

interface EditableImage {
  localKey: string;
  url: string;
  alt: string;
  isCover: boolean;
}

interface EditableVariant {
  id: string;
  sku: string;
  size: string;
  colorName: string;
  colorHex: string;
  priceInr: string;
  compareAtInr: string;
  stockQty: string;
}

interface ProductFormState {
  title: string;
  category: CollectionCategory;
  sku: string;
  description: string;
  fabricNote: string;
  basePriceInr: string;
  baseCompareAtInr: string;
  lowStockThreshold: string;
  featured: boolean;
  visibilityStatus: 'published' | 'draft';
  sizesInput: string;
  colors: ProductColor[];
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
    return {
      title: '',
      category: categories[0]?.name || 'Dresses',
      sku: defaultSku,
      description: '',
      fabricNote: '',
      basePriceInr: '2499',
      baseCompareAtInr: '',
      lowStockThreshold: '5',
      featured: false,
      visibilityStatus: 'published',
      sizesInput: 'S, M, L',
      colors: [{ name: 'Blush Rose', hex: '#E8B8C8' }],
      variants: [
        {
          id: `new-${crypto.randomUUID()}`,
          sku: `${defaultSku}-S-1`,
          size: 'S',
          colorName: 'Blush Rose',
          colorHex: '#E8B8C8',
          priceInr: '2499',
          compareAtInr: '',
          stockQty: '6',
        },
        {
          id: `new-${crypto.randomUUID()}`,
          sku: `${defaultSku}-M-2`,
          size: 'M',
          colorName: 'Blush Rose',
          colorHex: '#E8B8C8',
          priceInr: '2499',
          compareAtInr: '',
          stockQty: '8',
        },
        {
          id: `new-${crypto.randomUUID()}`,
          sku: `${defaultSku}-L-3`,
          size: 'L',
          colorName: 'Blush Rose',
          colorHex: '#E8B8C8',
          priceInr: '2499',
          compareAtInr: '',
          stockQty: '5',
        },
      ],
      images: [],
    };
  }

  const variants: EditableVariant[] =
    product.variants && product.variants.length > 0
      ? product.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          size: v.size,
          colorName: v.colorName,
          colorHex: v.colorHex,
          priceInr: paiseToInput(v.pricePaise),
          compareAtInr: paiseToInput(v.compareAtPaise),
          stockQty: String(v.stockQty),
        }))
      : [
          {
            id: `new-${crypto.randomUUID()}`,
            sku: `${product.sku}-1`,
            size: product.sizes[0] || 'Free Size',
            colorName: product.colors[0]?.name || 'Signature',
            colorHex: product.colors[0]?.hex || '#49243E',
            priceInr: paiseToInput(product.pricePaise ?? Math.round(product.price * 100)),
            compareAtInr: paiseToInput(product.compareAtPaise),
            stockQty: String(product.stockQty ?? 0),
          },
        ];

  return {
    title: product.name,
    category: product.category,
    sku: product.sku,
    description: product.description,
    fabricNote: product.fabricNote,
    basePriceInr: paiseToInput(product.pricePaise ?? Math.round(product.price * 100)),
    baseCompareAtInr: paiseToInput(product.compareAtPaise),
    lowStockThreshold: String(product.lowStockThreshold ?? 5),
    featured: product.featured,
    visibilityStatus: product.status === 'draft' ? 'draft' : 'published',
    sizesInput: product.sizes.join(', '),
    colors:
      product.colors.length > 0
        ? product.colors
        : [{ name: 'Signature', hex: '#49243E' }],
    variants,
    images: (product.rawImages?.length ? product.rawImages : product.images).map((img, idx) => ({
      localKey: `${'id' in img ? img.id : 'img'}-${idx}`,
      url: 'url' in img ? img.url : img.src,
      alt: img.alt,
      isCover: Boolean(img.isCover ?? idx === 0),
    })),
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

  // Derived totals displayed unambiguously above variant table
  const derivedTotals = useMemo(() => {
    const validPrices = form.variants
      .map((v) => inputToPaise(v.priceInr))
      .filter((p): p is number => p !== null && p > 0);
    const totalStock = form.variants.reduce((sum, v) => {
      const q = Number.parseInt(v.stockQty, 10);
      return sum + (Number.isFinite(q) && q > 0 ? q : 0);
    }, 0);
    const minPricePaise =
      validPrices.length > 0
        ? Math.min(...validPrices)
        : inputToPaise(form.basePriceInr) || 0;
    return { totalStock, minPricePaise };
  }, [form.variants, form.basePriceInr]);

  // Live preview object matching storefront Product interface
  const previewProduct = useMemo<Product>(() => {
    const normalizedVariants: ProductVariant[] = form.variants.map((v, idx) => ({
      id: v.id,
      sku: v.sku,
      size: v.size,
      colorName: v.colorName,
      colorHex: v.colorHex,
      pricePaise: inputToPaise(v.priceInr) || derivedTotals.minPricePaise || 100,
      compareAtPaise: inputToPaise(v.compareAtInr),
      stockQty: Math.max(0, Number.parseInt(v.stockQty, 10) || 0),
      position: idx,
    }));
    const sortedImages = [...form.images].sort((a, b) => (a.isCover === b.isCover ? 0 : a.isCover ? -1 : 1));
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
      images: sortedImages.map((img) => ({
        src: img.url,
        alt: img.alt || form.title || 'Preview image',
        isCover: img.isCover,
      })),
      colors: Array.from(
        new Map(
          normalizedVariants.map((v) => [v.colorName, { name: v.colorName, hex: v.colorHex }])
        ).values()
      ),
      sizes: Array.from(new Set(normalizedVariants.map((v) => v.size))),
      variants: normalizedVariants,
      featured: form.featured,
      dateAdded: new Date().toISOString().slice(0, 10),
    };
  }, [form, derivedTotals, product]);

  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorText(null);

    const files = Array.from(fileList).slice(0, 6);
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

    setUploading(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));

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
        const appended: EditableImage[] = res.data.files.map((uploaded, idx) => ({
          localKey: uploaded.id,
          url: uploaded.url,
          alt: prev.title.trim() ? `${prev.title.trim()} view` : 'Sahithi Collections garment photo',
          isCover: !hasExistingCover && idx === 0,
        }));
        return {
          ...prev,
          images: [...prev.images, ...appended].slice(0, 12),
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

  const handleMoveImage = (index: number, delta: -1 | 1) => {
    setForm((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.images.length) return prev;
      const next = [...prev.images];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return { ...prev, images: next };
    });
  };

  const handleRemoveImage = (localKey: string) => {
    setForm((prev) => {
      const remaining = prev.images.filter((i) => i.localKey !== localKey);
      if (remaining.length > 0 && !remaining.some((i) => i.isCover)) {
        remaining[0] = { ...remaining[0], isCover: true };
      }
      return { ...prev, images: remaining };
    });
  };

  const handleAddColor = () => {
    const cleanName = newColorName.trim();
    if (!cleanName) return;
    if (form.colors.some((c) => c.name.toLowerCase() === cleanName.toLowerCase())) {
      setNewColorName('');
      return;
    }
    setForm((prev) => ({
      ...prev,
      colors: [...prev.colors, { name: cleanName, hex: newColorHex }],
    }));
    setNewColorName('');
  };

  const handleRemoveColor = (name: string) => {
    if (form.colors.length <= 1) return;
    setForm((prev) => ({
      ...prev,
      colors: prev.colors.filter((c) => c.name !== name),
    }));
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
    const colors = form.colors.length > 0 ? form.colors : [{ name: 'Signature', hex: '#49243E' }];

    setForm((prev) => {
      const existingMap = new Map(
        prev.variants.map((v) => [`${v.size.toLowerCase()}::${v.colorName.toLowerCase()}`, v])
      );
      const nextVariants: EditableVariant[] = [];
      let counter = 1;
      for (const size of sizes) {
        for (const color of colors) {
          const key = `${size.toLowerCase()}::${color.name.toLowerCase()}`;
          const existing = existingMap.get(key);
          if (existing) {
            nextVariants.push({ ...existing, colorHex: color.hex });
          } else {
            const cleanBaseSku = (prev.sku || 'SC').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
            const cleanSize = size.replace(/[^A-Z0-9]/gi, '').slice(0, 5).toUpperCase() || 'SZ';
            nextVariants.push({
              id: `new-${crypto.randomUUID()}`,
              sku: `${cleanBaseSku}-${cleanSize}-${counter}`,
              size,
              colorName: color.name,
              colorHex: color.hex,
              priceInr: prev.basePriceInr || '2499',
              compareAtInr: prev.baseCompareAtInr,
              stockQty: '5',
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
        compareAtInr: prev.baseCompareAtInr,
      })),
    }));
  };

  const handleAddSingleVariantRow = () => {
    setForm((prev) => ({
      ...prev,
      variants: [
        ...prev.variants,
        {
          id: `new-${crypto.randomUUID()}`,
          sku: `${(prev.sku || 'SC').toUpperCase()}-V${prev.variants.length + 1}`,
          size: 'Free Size',
          colorName: prev.colors[0]?.name || 'Signature',
          colorHex: prev.colors[0]?.hex || '#49243E',
          priceInr: prev.basePriceInr || '2499',
          compareAtInr: prev.baseCompareAtInr,
          stockQty: '5',
        },
      ],
    }));
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
        variants: prev.variants.map((v, idx) => (idx === 0 ? { ...v, stockQty: rawTotalStock } : { ...v, stockQty: '0' })),
      }));
      return;
    }
    const clampedTotal = Math.min(100_000, Math.max(0, parsedTotal));
    setForm((prev) => {
      const count = prev.variants.length;
      if (count === 0) return prev;
      const basePerVariant = Math.floor(clampedTotal / count);
      const remainder = clampedTotal % count;
      return {
        ...prev,
        variants: prev.variants.map((v, idx) => ({
          ...v,
          stockQty: String(basePerVariant + (idx < remainder ? 1 : 0)),
        })),
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

    if (targetStatus === 'published' && form.images.length === 0) {
      nextFieldErrors.images = 'Upload at least one product photo before publishing.';
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

    const payloadVariants: Array<{
      id?: string;
      sku: string;
      size: string;
      colorName: string;
      colorHex: string;
      pricePaise: number;
      compareAtPaise: number | null;
      stockQty: number;
    }> = [];

    if (form.variants.length === 0) {
      nextFieldErrors.variants = 'Add at least one size/color variant before saving.';
    } else {
      const seenCombos = new Set<string>();
      const seenSkus = new Set<string>();
      for (let i = 0; i < form.variants.length; i += 1) {
        const v = form.variants[i];
        const size = v.size.trim();
        const colorName = v.colorName.trim();
        if (!size || !colorName) {
          nextFieldErrors.variants = 'Every variant row must specify both a size and a color name.';
          break;
        }
        const comboKey = `${size.toLowerCase()}::${colorName.toLowerCase()}`;
        if (seenCombos.has(comboKey)) {
          nextFieldErrors.variants = `Duplicate variant for size "${size}" and color "${colorName}".`;
          break;
        }
        seenCombos.add(comboKey);

        const vSku = v.sku.trim().toUpperCase();
        if (vSku && !/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(vSku)) {
          nextFieldErrors.variants = `Variant SKU "${vSku}" contains invalid characters.`;
          break;
        }
        if (vSku && seenSkus.has(vSku)) {
          nextFieldErrors.variants = `Duplicate variant SKU "${vSku}" within this product.`;
          break;
        }
        if (vSku) seenSkus.add(vSku);

        const pPaise = inputToPaise(v.priceInr);
        if (pPaise === null || pPaise < 100 || pPaise > 100_000_000) {
          nextFieldErrors.variants = `Enter a valid INR price (at least ₹1) for variant ${size} / ${colorName}.`;
          break;
        }

        let cPaise: number | null = null;
        if (v.compareAtInr.trim() !== '') {
          const parsedVarCompare = inputToPaise(v.compareAtInr);
          if (parsedVarCompare === null || parsedVarCompare <= pPaise) {
            nextFieldErrors.variants = `Compare-at MRP for ${size} / ${colorName} must be higher than its selling price.`;
            break;
          }
          cPaise = parsedVarCompare;
        }

        const stockNum = Number.parseInt(v.stockQty, 10);
        if (!Number.isInteger(stockNum) || stockNum < 0 || stockNum > 100_000) {
          nextFieldErrors.variants = `Stock quantity for ${size} / ${colorName} must be an integer between 0 and 100,000.`;
          break;
        }

        payloadVariants.push({
          ...(v.id.startsWith('new-') ? {} : { id: v.id }),
          sku: vSku,
          size,
          colorName,
          colorHex: v.colorHex,
          pricePaise: pPaise,
          compareAtPaise: cPaise,
          stockQty: stockNum,
        });
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
      pricePaise: basePricePaise,
      compareAtPaise: baseComparePaise,
      lowStockThreshold: Math.max(0, Number.parseInt(form.lowStockThreshold, 10) || 0),
      featured: form.featured,
      status: targetStatus,
      variants: payloadVariants,
      images: form.images.map((img) => ({
        url: img.url,
        alt: img.alt.trim() || cleanTitle,
        isCover: img.isCover,
      })),
    };

    setSaving(true);
    try {
      const endpoint = product ? `/api/admin/products/${product.id}` : '/api/admin/products';
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
                  <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                    <p className="text-xs font-medium uppercase tracking-wider text-[#B76E79]">
                      Storefront Card Preview
                    </p>
                    <p className="mt-1 text-xs text-[#242124]/65">
                      Exactly how this piece appears in the public Boutique Showcase once published.
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

                  {/* Photography & Gallery */}
                  <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="font-serif text-xl font-semibold text-[#49243E]">
                          Product Photography
                        </h3>
                        <p className="text-xs text-[#242124]/65">
                          Upload JPEG, PNG, or WebP photos (max 5 MB each). Choose your cover image and drag or reorder shots.
                        </p>
                      </div>
                      <span className="text-xs font-medium text-[#49243E]/70 tabular-nums">
                        {form.images.length} / 12 photos
                      </span>
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
                          {uploading ? 'Verifying and storing photos...' : 'Drop lookbook photos here'}
                        </p>
                        <label
                          htmlFor="admin-photo-upload-input"
                          className="mt-3 inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                        >
                          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Upload Photos</span>
                        </label>
                      </div>
                      {fieldErrors.images && (
                        <p className="mt-2 text-xs font-medium text-[#9B2C3E]">{fieldErrors.images}</p>
                      )}

                    {form.images.length > 0 && (
                      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {form.images.map((img, idx) => (
                          <div
                            key={img.localKey}
                            className={`flex flex-col rounded-2xl border p-3 ${
                              img.isCover
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
                              {img.isCover && (
                                <span className="absolute top-2 left-2 rounded-lg bg-[#49243E] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#FFF9F5]">
                                  Cover
                                </span>
                              )}
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
                              aria-label={`Alt text for photo ${idx + 1}`}
                              className="mt-2.5 h-9 w-full rounded-lg border border-[#49243E]/15 px-2.5 text-xs focus:border-[#49243E] focus:outline-none"
                            />

                            <div className="mt-2 flex items-center justify-between gap-1">
                              <button
                                type="button"
                                onClick={() => handleSetCover(img.localKey)}
                                disabled={img.isCover}
                                className={`inline-flex min-h-[34px] items-center gap-1 rounded-lg px-2 text-[11px] font-medium ${
                                  img.isCover
                                    ? 'bg-[#F3D5DF]/50 text-[#49243E]'
                                    : 'border border-[#49243E]/15 text-[#49243E] hover:bg-[#F3D5DF]/35'
                                }`}
                              >
                                <Star className={`h-3 w-3 ${img.isCover ? 'fill-[#49243E]' : ''}`} />
                                <span>{img.isCover ? 'Primary' : 'Set Cover'}</span>
                              </button>

                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleMoveImage(idx, -1)}
                                  aria-label="Move photo earlier"
                                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#49243E]/15 text-[#49243E] disabled:opacity-35"
                                >
                                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === form.images.length - 1}
                                  onClick={() => handleMoveImage(idx, 1)}
                                  aria-label="Move photo later"
                                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#49243E]/15 text-[#49243E] disabled:opacity-35"
                                >
                                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveImage(img.localKey)}
                                  aria-label="Remove photo"
                                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#B76E79]/30 text-[#B76E79] hover:bg-[#F3D5DF]/40"
                                >
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Pricing & Variant Inventory */}
                  <div className="rounded-2xl border border-[#49243E]/12 bg-white p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="font-serif text-xl font-semibold text-[#49243E]">
                          INR Pricing, Sizes, Colors &amp; Stock
                        </h3>
                        <p className="text-xs text-[#242124]/65">
                          Starting storefront price &amp; total stock are computed directly from your size/color variants below.
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
                          Selling Price (INR)
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
                          Total Stock Quantity
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
                          Apply Price to All Variants
                        </button>
                      </div>
                    </div>

                    {/* Variant Generator Inputs */}
                    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Sizes (comma-separated)
                        </label>
                        <input
                          type="text"
                          value={form.sizesInput}
                          onChange={(e) => setForm((p) => ({ ...p, sizesInput: e.target.value }))}
                          placeholder="XS, S, M, L, XL"
                          className="mt-1 h-10 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                        />
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

                      <div>
                        <label className="block text-xs font-medium text-[#49243E]">
                          Color Palette
                        </label>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            type="color"
                            value={newColorHex}
                            onChange={(e) => setNewColorHex(e.target.value)}
                            aria-label="Pick swatch color"
                            className="h-10 w-11 cursor-pointer rounded-xl border border-[#49243E]/18 bg-white p-1"
                          />
                          <input
                            type="text"
                            value={newColorName}
                            onChange={(e) => setNewColorName(e.target.value)}
                            placeholder="Color name (e.g. Emerald)"
                            className="h-10 flex-1 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleAddColor}
                            className="inline-flex h-10 items-center gap-1 rounded-xl border border-[#49243E]/20 px-3 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Add</span>
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {form.colors.map((c) => (
                            <span
                              key={c.name}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[#49243E]/15 bg-[#FFF9F5] px-2.5 py-1 text-xs text-[#49243E]"
                            >
                              <span
                                className="h-3 w-3 rounded-full border border-[#242124]/20"
                                style={{ backgroundColor: c.hex }}
                              />
                              <span>{c.name}</span>
                              {form.colors.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveColor(c.name)}
                                  aria-label={`Remove color ${c.name}`}
                                  className="text-[#242124]/50 hover:text-[#49243E]"
                                >
                                  <X className="h-3 w-3" aria-hidden="true" />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-b border-[#49243E]/10 pb-4">
                      <button
                        type="button"
                        onClick={handleSyncVariantMatrix}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[#F3D5DF]/50 px-3.5 text-xs font-semibold text-[#49243E] hover:bg-[#F3D5DF]/75"
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Sync Size &times; Color Matrix</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleAddSingleVariantRow}
                        className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5]"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Add Variant Row</span>
                      </button>
                    </div>

                    {fieldErrors.variants && (
                      <p className="mt-3 rounded-xl border border-[#B76E79]/50 bg-[#F3D5DF]/25 px-3 py-2 text-xs font-medium text-[#9B2C3E]">
                        {fieldErrors.variants}
                      </p>
                    )}

                    {/* Variant List */}
                    <div className="mt-4 space-y-2.5">
                      {form.variants.map((variant, idx) => (
                        <div
                          key={variant.id}
                          className="grid grid-cols-2 gap-2.5 rounded-xl border border-[#49243E]/12 bg-[#FFF9F5]/45 p-3 sm:grid-cols-12 sm:items-end"
                        >
                          <div className="sm:col-span-2">
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
                                    i === idx ? { ...v, size: val } : v
                                  ),
                                }));
                              }}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs font-medium"
                            />
                          </div>

                          <div className="sm:col-span-3">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              Color
                            </label>
                            <div className="mt-1 flex items-center gap-1.5">
                              <input
                                type="color"
                                value={variant.colorHex}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setForm((p) => ({
                                    ...p,
                                    variants: p.variants.map((v, i) =>
                                      i === idx ? { ...v, colorHex: val } : v
                                    ),
                                  }));
                                }}
                                aria-label={`Variant color hex ${idx + 1}`}
                                className="h-9 w-9 shrink-0 rounded-lg border border-[#49243E]/15 bg-white p-0.5"
                              />
                              <input
                                type="text"
                                value={variant.colorName}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setForm((p) => ({
                                    ...p,
                                    variants: p.variants.map((v, i) =>
                                      i === idx ? { ...v, colorName: val } : v
                                    ),
                                  }));
                                }}
                                className="h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs"
                              />
                            </div>
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              Price (₹)
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min={1}
                              value={variant.priceInr}
                              onChange={(e) => {
                                const val = e.target.value;
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.map((v, i) =>
                                    i === idx ? { ...v, priceInr: val } : v
                                  ),
                                }));
                              }}
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
                                    i === idx ? { ...v, compareAtInr: val } : v
                                  ),
                                }));
                              }}
                              placeholder="Optional"
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs tabular-nums"
                            />
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-semibold uppercase text-[#49243E]/65">
                              Stock Qty
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
                                    i === idx ? { ...v, stockQty: val } : v
                                  ),
                                }));
                              }}
                              className="mt-1 h-9 w-full rounded-lg border border-[#49243E]/15 bg-white px-2 text-xs font-semibold tabular-nums"
                            />
                          </div>

                          <div className="flex justify-end sm:col-span-1">
                            <button
                              type="button"
                              disabled={form.variants.length <= 1}
                              onClick={() =>
                                setForm((p) => ({
                                  ...p,
                                  variants: p.variants.filter((_, i) => i !== idx),
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
