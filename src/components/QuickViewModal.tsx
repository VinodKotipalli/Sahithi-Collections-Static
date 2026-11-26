import {
  type MouseEvent,
  type TouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Heart,
  ShoppingBag,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import type { BagItem, Product } from '../types/boutique';
import {
  formatVariantDisplayLabel,
  getVariantThumbnailUrl,
  isFreeSizeLabel,
  normalizeProductColors,
  resolveInitialColorSelection,
  resolveSizeAfterColorSwitch,
  type NormalizedColorOption,
} from '../utils/colorVariants';
import { formatPaiseINR } from '../utils/format';
import { BoutiqueImage } from './BoutiqueImage';

const DEFAULT_ZOOM_SCALE = 2.5;
const HIGH_ZOOM_SCALE = 3.5;

interface QuickViewModalProps {
  product: Product | null;
  initialColorParam?: string;
  initialVariantParam?: string;
  onSelectColorUrl?: (colorSlug: string) => void;
  isWishlisted: boolean;
  onToggleWishlist: (id: string) => void;
  onAddToBag?: (item: Omit<BagItem, 'quantity'> & { quantity?: number }) => void;
  onBuyNow?: (item: Omit<BagItem, 'quantity'> & { quantity?: number }) => void;
  relatedProducts?: Product[];
  onSelectProduct?: (product: Product) => void;
  onClose: () => void;
}

export function QuickViewModal({
  product,
  initialColorParam,
  initialVariantParam,
  onSelectColorUrl,
  isWishlisted,
  onToggleWishlist,
  onAddToBag,
  onBuyNow,
  relatedProducts = [],
  onSelectProduct,
  onClose,
}: QuickViewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const imageFrameRef = useRef<HTMLDivElement>(null);
  const colorStripRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const isOpen = product !== null;

  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [selectedColorId, setSelectedColorId] = useState('');
  const [selectedSize, setSelectedSize] = useState('');
  const [sizePromptMessage, setSizePromptMessage] = useState<string | null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [addedFeedback, setAddedFeedback] = useState(false);

  // Horizontal scroll button visibility for colour thumbnail strip
  const [canScrollColorsLeft, setCanScrollColorsLeft] = useState(false);
  const [canScrollColorsRight, setCanScrollColorsRight] = useState(false);

  // Interactive magnified detail zoom state
  const [isHoveringImage, setIsHoveringImage] = useState(false);
  const [isZoomLocked, setIsZoomLocked] = useState(false);
  const [zoomScale, setZoomScale] = useState(DEFAULT_ZOOM_SCALE);
  const [zoomPointer, setZoomPointer] = useState({ fx: 0.5, fy: 0.35 });

  useFocusTrap(isOpen, modalRef, onClose);

  const colorOptions = useMemo<NormalizedColorOption[]>(
    () => (product ? normalizeProductColors(product) : []),
    [product]
  );

  // Initialize selection whenever product opens or changes
  useEffect(() => {
    if (!product) return;
    const resolved = resolveInitialColorSelection(product, {
      colorParam: initialColorParam,
      variantParam: initialVariantParam,
    });

    setActiveImageIndex(0);
    setAddedFeedback(false);
    setIsHoveringImage(false);
    setIsZoomLocked(false);
    setZoomScale(DEFAULT_ZOOM_SCALE);
    setZoomPointer({ fx: 0.5, fy: 0.35 });
    setSelectedColorId(resolved.colorOption?.id || '');
    setSelectedSize(resolved.selectedSize || '');
    setSizePromptMessage(null);

    if (resolved.linkedVariantUnavailable) {
      setDeepLinkNotice(
        'The linked colour or variant is no longer available. Showing an available option instead.'
      );
    } else if (resolved.linkedVariantSoldOut) {
      setDeepLinkNotice(
        'The linked colour or size is currently sold out. Select another available colour or size to order.'
      );
    } else {
      setDeepLinkNotice(null);
    }
    // Re-run only when switching to a different product id or deep-link query params
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, initialColorParam, initialVariantParam]);

  const selectedColorOption = useMemo<NormalizedColorOption | null>(() => {
    if (colorOptions.length === 0) return null;
    return colorOptions.find((c) => c.id === selectedColorId) || colorOptions[0] || null;
  }, [colorOptions, selectedColorId]);

  const galleryImages = useMemo(() => {
    if (selectedColorOption && selectedColorOption.images.length > 0) {
      return selectedColorOption.images;
    }
    return product?.images || [];
  }, [selectedColorOption, product]);

  // Clamp activeImageIndex safely whenever colour gallery changes
  const safeImageIndex =
    galleryImages.length > 0 ? Math.min(activeImageIndex, galleryImages.length - 1) : 0;

  useEffect(() => {
    if (!product || galleryImages.length <= 1) return;
    const handleArrows = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        setActiveImageIndex((prev) => (prev - 1 + galleryImages.length) % galleryImages.length);
      } else if (event.key === 'ArrowRight') {
        setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
      }
    };
    window.addEventListener('keydown', handleArrows);
    return () => window.removeEventListener('keydown', handleArrows);
  }, [product, galleryImages.length]);

  const updateColorScrollHints = useCallback(() => {
    const strip = colorStripRef.current;
    if (!strip) {
      setCanScrollColorsLeft(false);
      setCanScrollColorsRight(false);
      return;
    }
    setCanScrollColorsLeft(strip.scrollLeft > 4);
    setCanScrollColorsRight(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateColorScrollHints();
    const strip = colorStripRef.current;
    if (!strip) return;
    const onResize = () => updateColorScrollHints();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [colorOptions.length, product?.id, updateColorScrollHints]);

  const scrollColorStrip = (direction: 'left' | 'right') => {
    const strip = colorStripRef.current;
    if (!strip) return;
    const delta = Math.max(180, Math.round(strip.clientWidth * 0.75));
    strip.scrollBy({
      left: direction === 'left' ? -delta : delta,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  };

  const handleSelectColor = (option: NormalizedColorOption) => {
    if (option.id === selectedColorOption?.id) return;
    setSelectedColorId(option.id);
    setActiveImageIndex(0);
    setIsHoveringImage(false);
    setIsZoomLocked(false);
    setZoomScale(DEFAULT_ZOOM_SCALE);
    setAddedFeedback(false);
    setDeepLinkNotice(null);

    const sizeResolution = resolveSizeAfterColorSwitch(option, selectedSize);
    setSelectedSize(sizeResolution.nextSize);
    if (!option.inStock) {
      setSizePromptMessage(`"${option.name}" is currently sold out.`);
    } else if (sizeResolution.sizeCleared) {
      setSizePromptMessage(`Please select an available size for ${option.name}.`);
    } else {
      setSizePromptMessage(null);
    }

    if (onSelectColorUrl && option.slug) {
      onSelectColorUrl(option.slug);
    }
  };

  // Variants strictly belonging to the selected colour
  const colorVariants = selectedColorOption?.activeVariants || [];
  const hasRealSizeChoice = useMemo(() => {
    if (colorVariants.length === 0) return false;
    if (colorVariants.length === 1 && isFreeSizeLabel(colorVariants[0].size)) return false;
    return true;
  }, [colorVariants]);

  const activeVariant = useMemo(() => {
    if (!selectedColorOption) return null;
    if (colorVariants.length === 0) return null;
    if (!selectedSize) {
      if (colorVariants.length === 1 && isFreeSizeLabel(colorVariants[0].size)) {
        return colorVariants[0];
      }
      return null;
    }
    return (
      colorVariants.find((v) => v.size.toLowerCase() === selectedSize.toLowerCase()) || null
    );
  }, [selectedColorOption, colorVariants, selectedSize]);

  // Price & compare-at price for current colour / selected variant
  const displayPricePaise = useMemo(() => {
    if (activeVariant) return activeVariant.pricePaise;
    if (selectedColorOption && selectedColorOption.minPricePaise > 0) {
      return selectedColorOption.minPricePaise;
    }
    return product?.pricePaise ?? Math.round((product?.price || 0) * 100);
  }, [activeVariant, selectedColorOption, product]);

  const displayComparePaise = useMemo(() => {
    if (activeVariant) return activeVariant.compareAtPaise ?? null;
    const minVar = selectedColorOption?.activeVariants.find(
      (v) => v.pricePaise === displayPricePaise
    );
    if (minVar) return minVar.compareAtPaise ?? null;
    return (
      product?.compareAtPaise ??
      (product?.compareAtPrice ? Math.round(product.compareAtPrice * 100) : null)
    );
  }, [activeVariant, selectedColorOption, displayPricePaise, product]);

  const colorInStock = selectedColorOption ? selectedColorOption.inStock : (product?.stockQty ?? 0) > 0;
  const availableStock = activeVariant
    ? activeVariant.stockQty
    : selectedColorOption
      ? selectedColorOption.totalStock
      : product?.stockQty ?? 0;

  const isPurchasable = Boolean(
    product &&
      selectedColorOption &&
      selectedColorOption.inStock &&
      activeVariant &&
      activeVariant.stockQty > 0
  );

  const selectedColorName = selectedColorOption?.name || product?.colors[0]?.name || 'Default';
  const selectedSizeLabel = activeVariant?.size || selectedSize || '';

  const buildBagPayload = () => {
    if (!product || !activeVariant) return null;
    const thumb = getVariantThumbnailUrl(product, activeVariant) || galleryImages[0]?.src || '';
    return {
      productId: product.id,
      variantId: activeVariant.id,
      seenPricePaise: activeVariant.pricePaise,
      fallbackTitle: product.name,
      fallbackVariant: formatVariantDisplayLabel(activeVariant.colorName, activeVariant.size),
      fallbackColorName: activeVariant.colorName,
      fallbackSize: activeVariant.size,
      fallbackSku: activeVariant.sku,
      fallbackImage: thumb,
      quantity: 1,
    };
  };

  const handleAddToBagClick = () => {
    if (!product || !onAddToBag) return;
    if (!colorInStock) {
      setSizePromptMessage(`"${selectedColorName}" is currently sold out.`);
      return;
    }
    if (!activeVariant) {
      setSizePromptMessage(`Please select an available size for ${selectedColorName}.`);
      return;
    }
    if (activeVariant.stockQty <= 0) {
      setSizePromptMessage(`Size ${activeVariant.size} in ${selectedColorName} is out of stock.`);
      return;
    }
    const payload = buildBagPayload();
    if (!payload) return;
    setSizePromptMessage(null);
    onAddToBag(payload);
    setAddedFeedback(true);
    window.setTimeout(() => setAddedFeedback(false), 1800);
  };

  const handleBuyNowClick = () => {
    if (!product) return;
    if (!colorInStock) {
      setSizePromptMessage(`"${selectedColorName}" is currently sold out.`);
      return;
    }
    if (!activeVariant) {
      setSizePromptMessage(`Please select an available size for ${selectedColorName}.`);
      return;
    }
    if (activeVariant.stockQty <= 0) {
      setSizePromptMessage(`Size ${activeVariant.size} in ${selectedColorName} is out of stock.`);
      return;
    }
    const payload = buildBagPayload();
    if (!payload) return;
    setSizePromptMessage(null);
    if (onBuyNow) {
      onBuyNow(payload);
    } else if (onAddToBag) {
      onAddToBag(payload);
    }
  };

  const updateZoomFromClientPoint = (clientX: number, clientY: number) => {
    const frame = imageFrameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    setZoomPointer({ fx, fy });
  };

  const handleImageMouseEnter = (event: MouseEvent<HTMLDivElement>) => {
    setIsHoveringImage(true);
    updateZoomFromClientPoint(event.clientX, event.clientY);
  };

  const handleImageMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!isHoveringImage) setIsHoveringImage(true);
    updateZoomFromClientPoint(event.clientX, event.clientY);
  };

  const handleImageMouseLeave = () => {
    setIsHoveringImage(false);
  };

  const handleImageClick = (event: MouseEvent<HTMLDivElement>) => {
    updateZoomFromClientPoint(event.clientX, event.clientY);
    if (isHoveringImage || isZoomLocked) {
      setZoomScale((prev) =>
        prev === DEFAULT_ZOOM_SCALE ? HIGH_ZOOM_SCALE : DEFAULT_ZOOM_SCALE
      );
    } else {
      setIsZoomLocked(true);
    }
  };

  const handleImageTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    if (!isZoomLocked || event.touches.length === 0) return;
    const touch = event.touches[0];
    updateZoomFromClientPoint(touch.clientX, touch.clientY);
  };

  const isZoomVisible = isHoveringImage || isZoomLocked;
  const halfViewport = 0.5 / zoomScale;
  const clampedCx = Math.min(1 - halfViewport, Math.max(halfViewport, zoomPointer.fx));
  const clampedCy = Math.min(1 - halfViewport, Math.max(halfViewport, zoomPointer.fy));
  const lensPercent = 100 / zoomScale;
  const lensTranslateX = (clampedCx - halfViewport) * zoomScale * 100;
  const lensTranslateY = (clampedCy - halfViewport) * zoomScale * 100;
  const detailTranslateX = (0.5 - clampedCx * zoomScale) * 100;
  const detailTranslateY = (0.5 - clampedCy * zoomScale) * 100;

  const activeImage = galleryImages[safeImageIndex];
  const activeImageSrc = activeImage?.src || product?.images[0]?.src || '';
  const activeImageAlt =
    activeImage?.alt || `${product?.name || ''} — ${selectedColorName}`;

  const primaryActionLabel = !colorInStock
    ? 'Sold Out'
    : !activeVariant && hasRealSizeChoice
      ? 'Select Size'
      : activeVariant && activeVariant.stockQty <= 0
        ? 'Out of Stock'
        : addedFeedback
          ? 'Added to Cart'
          : 'Add to Cart';

  return (
    <AnimatePresence>
      {product && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-end justify-center bg-[#242124]/60 sm:items-center sm:p-6"
        >
          <motion.div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-view-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="relative flex max-h-[94svh] w-full max-w-5xl flex-col overflow-hidden rounded-t-3xl border border-[#49243E]/12 bg-[#FFF9F5] shadow-2xl sm:max-h-[92svh] sm:rounded-3xl"
          >
            {/* Top Bar */}
            <div className="flex shrink-0 items-center justify-between border-b border-[#49243E]/10 px-4 py-3 sm:px-6">
              <p className="text-xs font-medium tracking-[0.18em] uppercase text-[#B76E79]">
                {product.category}
              </p>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close product view"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[#49243E]/15 bg-white text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#49243E]"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Scrollable Body (extra bottom padding on mobile so sticky purchase bar never overlaps content) */}
            <div className="flex-1 overflow-y-auto px-4 pt-4 pb-28 sm:p-6 md:pb-8 lg:p-8">
              {deepLinkNotice && (
                <div
                  role="status"
                  className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#B76E79]/35 bg-[#F3D5DF]/35 px-3.5 py-2.5 text-xs text-[#49243E]"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#9B2C3E]" aria-hidden="true" />
                  <span>{deepLinkNotice}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-6 md:grid-cols-12 md:gap-8">
                {/* Gallery & Image-Based Colour Selector Column */}
                <div className="md:col-span-6">
                  <div
                    ref={imageFrameRef}
                    onMouseEnter={handleImageMouseEnter}
                    onMouseMove={handleImageMouseMove}
                    onMouseLeave={handleImageMouseLeave}
                    onClick={handleImageClick}
                    onTouchStart={(event) => {
                      if (!isZoomLocked || event.touches.length === 0) return;
                      const touch = event.touches[0];
                      updateZoomFromClientPoint(touch.clientX, touch.clientY);
                    }}
                    onTouchMove={handleImageTouchMove}
                    className={`relative aspect-[3/4] select-none overflow-hidden rounded-2xl border border-[#49243E]/10 bg-[#F8F1ED] ${
                      isZoomLocked ? 'touch-none' : ''
                    } ${
                      zoomScale === HIGH_ZOOM_SCALE && isZoomVisible
                        ? 'cursor-zoom-out'
                        : 'cursor-zoom-in'
                    }`}
                  >
                    <BoutiqueImage
                      key={`${selectedColorOption?.id || 'default'}-${activeImageSrc}`}
                      src={activeImageSrc}
                      alt={activeImageAlt}
                      loading="eager"
                      fallbackTitle={product.name}
                      className="h-full w-full object-cover object-top"
                    />

                    {/* Desktop Viewfinder Magnifying Lens Indicator */}
                    <div
                      aria-hidden="true"
                      style={{
                        width: `${lensPercent}%`,
                        height: `${lensPercent}%`,
                        transform: `translate3d(${lensTranslateX}%, ${lensTranslateY}%, 0)`,
                      }}
                      className={`pointer-events-none absolute left-0 top-0 hidden rounded-lg border border-[#FFF9F5]/90 bg-[#FFF9F5]/20 shadow-[0_0_0_1px_rgba(73,36,62,0.34),0_10px_28px_rgba(36,33,36,0.16)] backdrop-blur-[0.5px] will-change-transform md:block ${
                        prefersReducedMotion
                          ? ''
                          : 'transition-opacity duration-200 ease-in-out'
                      } ${isZoomVisible ? 'opacity-100' : 'opacity-0'}`}
                    >
                      <span className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-[#49243E]/45" />
                      <span className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-[#49243E]/45" />
                    </div>

                    {/* Mobile / Compact In-Frame Magnified Detail View */}
                    <div
                      aria-hidden={!isZoomVisible}
                      className={`pointer-events-none absolute inset-0 overflow-hidden bg-[#F8F1ED] md:hidden ${
                        prefersReducedMotion
                          ? ''
                          : 'transition-opacity duration-200 ease-in-out'
                      } ${isZoomVisible ? 'opacity-100' : 'opacity-0'}`}
                    >
                      <div
                        style={{
                          transformOrigin: '0 0',
                          transform: `translate3d(${detailTranslateX}%, ${detailTranslateY}%, 0) scale(${zoomScale})`,
                        }}
                        className="h-full w-full will-change-transform"
                      >
                        <BoutiqueImage
                          src={activeImageSrc}
                          alt={`${product.name} magnified detail`}
                          loading="eager"
                          fallbackTitle={product.name}
                          className="h-full w-full object-cover object-top"
                        />
                      </div>
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#242124]/65 via-[#242124]/15 to-transparent px-3.5 pb-3 pt-8 text-xs text-[#FFF9F5]">
                        <span>Drag to inspect detail</span>
                        <span className="mx-1.5 opacity-60" aria-hidden="true">
                          ·
                        </span>
                        <span className="tabular-nums">{zoomScale.toFixed(1)}×</span>
                      </div>
                    </div>

                    {/* Interactive Zoom Toggle Button */}
                    <button
                      type="button"
                      onMouseEnter={(e) => {
                        e.stopPropagation();
                        setIsHoveringImage(false);
                      }}
                      onMouseMove={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsZoomLocked((prev) => {
                          if (prev) {
                            setZoomScale(DEFAULT_ZOOM_SCALE);
                            return false;
                          }
                          return true;
                        });
                      }}
                      aria-pressed={isZoomLocked}
                      aria-label={
                        isZoomLocked
                          ? 'Exit magnified detail view'
                          : 'Inspect magnified garment detail'
                      }
                      className="absolute bottom-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-[#49243E]/15 bg-[#FFF9F5]/92 text-[#49243E] shadow-sm transition-colors hover:bg-[#FFF9F5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#49243E]"
                    >
                      {isZoomLocked ? (
                        <ZoomOut className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ZoomIn className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>

                    {galleryImages.length > 1 && (
                      <div className="pointer-events-none absolute inset-x-3 top-1/2 z-10 flex -translate-y-1/2 justify-between">
                        <button
                          type="button"
                          onMouseEnter={(e) => {
                            e.stopPropagation();
                            setIsHoveringImage(false);
                          }}
                          onMouseMove={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveImageIndex(
                              (prev) => (prev - 1 + galleryImages.length) % galleryImages.length
                            );
                          }}
                          aria-label="Previous product image"
                          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-[#FFF9F5]/90 text-[#49243E] shadow-sm transition-colors hover:bg-[#FFF9F5]"
                        >
                          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onMouseEnter={(e) => {
                            e.stopPropagation();
                            setIsHoveringImage(false);
                          }}
                          onMouseMove={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
                          }}
                          aria-label="Next product image"
                          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-[#FFF9F5]/90 text-[#49243E] shadow-sm transition-colors hover:bg-[#FFF9F5]"
                        >
                          <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Subtle Editorial Zoom Caption */}
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[#49243E]/65">
                    <span className="hidden md:inline">
                      Hover photo to magnify detail · Click for{' '}
                      <span className="tabular-nums">
                        {zoomScale === DEFAULT_ZOOM_SCALE ? '3.5×' : '2.5×'}
                      </span>
                    </span>
                    <span className="md:hidden">
                      {isZoomLocked
                        ? 'Drag across photo to pan · Tap zoom icon to exit'
                        : 'Tap photo or zoom icon to inspect fabric detail'}
                    </span>
                    {isZoomLocked && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsZoomLocked(false);
                          setZoomScale(DEFAULT_ZOOM_SCALE);
                        }}
                        className="shrink-0 font-medium text-[#49243E] underline underline-offset-2 transition-colors hover:text-[#B76E79]"
                      >
                        Reset
                      </button>
                    )}
                  </div>

                  {/* Per-Colour Gallery Angle Strip (only shown when current colour has >1 photo) */}
                  {galleryImages.length > 1 && (
                    <div
                      className="mt-2.5 flex items-center gap-2 overflow-x-auto pb-1"
                      aria-label={`Photos for ${selectedColorName}`}
                    >
                      {galleryImages.map((img, idx) => (
                        <button
                          key={`${selectedColorOption?.id || 'c'}-${img.src}-${idx}`}
                          type="button"
                          onClick={() => setActiveImageIndex(idx)}
                          aria-label={`View photo ${idx + 1} of ${galleryImages.length} for ${selectedColorName}`}
                          aria-pressed={safeImageIndex === idx}
                          className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-lg border-2 transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#49243E] ${
                            safeImageIndex === idx
                              ? 'border-[#49243E]'
                              : 'border-[#49243E]/12 opacity-70 hover:opacity-100'
                          }`}
                        >
                          <BoutiqueImage
                            src={img.src}
                            alt={img.alt}
                            loading="eager"
                            className="h-full w-full object-cover object-top"
                          />
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Selected Colour Label + Image-Based Colour Variant Thumbnail Selector */}
                  {colorOptions.length > 0 && (
                    <div className="mt-4 border-t border-[#49243E]/10 pt-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm text-[#242124]">
                          <span className="font-semibold text-[#49243E]">Selected Colour:</span>{' '}
                          <span className="font-medium text-[#242124]">{selectedColorName}</span>
                          {!colorInStock && (
                            <span className="ml-2 text-xs font-medium text-[#9B2C3E]">
                              (Sold Out)
                            </span>
                          )}
                        </p>

                        {colorOptions.length > 1 && (canScrollColorsLeft || canScrollColorsRight) && (
                          <div className="hidden items-center gap-1 md:flex">
                            <button
                              type="button"
                              onClick={() => scrollColorStrip('left')}
                              disabled={!canScrollColorsLeft}
                              aria-label="Scroll colour thumbnails left"
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#49243E]/18 bg-white text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => scrollColorStrip('right')}
                              disabled={!canScrollColorsRight}
                              aria-label="Scroll colour thumbnails right"
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#49243E]/18 bg-white text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <ChevronRight className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Horizontal Row of Rounded Rectangular Product-Image Colour Thumbnails */}
                      <div
                        ref={colorStripRef}
                        onScroll={updateColorScrollHints}
                        role="radiogroup"
                        aria-label="Available colours"
                        className="mt-2.5 flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-1.5"
                      >
                        {colorOptions.map((option) => {
                          const isSelected = selectedColorOption?.id === option.id;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="radio"
                              aria-checked={isSelected}
                              aria-label={`${option.name}${option.inStock ? '' : ' — Sold Out'}`}
                              onClick={() => handleSelectColor(option)}
                              className={`group relative flex w-[74px] shrink-0 snap-start flex-col overflow-hidden rounded-xl bg-white text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#49243E] sm:w-[82px] ${
                                isSelected
                                  ? 'border-2 border-[#49243E] ring-1 ring-[#49243E]/25 shadow-sm'
                                  : 'border border-[#49243E]/18 hover:border-[#49243E]/50'
                              }`}
                            >
                              <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#F8F1ED]">
                                <BoutiqueImage
                                  src={option.thumbnailUrl || product.images[0]?.src || ''}
                                  alt={`${product.name} in ${option.name}`}
                                  loading="eager"
                                  fallbackTitle={option.name}
                                  className={`h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03] ${
                                    option.inStock ? '' : 'opacity-65 grayscale-[25%]'
                                  }`}
                                />
                                {!option.inStock && (
                                  <span className="absolute inset-x-0 bottom-0 bg-[#242124]/78 px-1 py-0.5 text-center text-[10px] font-medium text-[#FFF9F5]">
                                    Sold Out
                                  </span>
                                )}
                              </div>
                              <span
                                className={`block truncate px-1.5 py-1 text-center text-[11px] leading-tight ${
                                  isSelected
                                    ? 'bg-[#49243E] font-semibold text-[#FFF9F5]'
                                    : 'font-medium text-[#49243E]/85'
                                }`}
                                title={option.name}
                              >
                                {option.name}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Details Column (hosts desktop Magnified Detail View overlay on hover) */}
                <div className="relative flex flex-col justify-between md:col-span-6">
                  {/* Desktop Magnified Detail View Panel */}
                  <div
                    aria-hidden={!isZoomVisible}
                    className={`pointer-events-none absolute inset-0 z-20 hidden flex-col bg-[#FFF9F5] md:flex ${
                      prefersReducedMotion
                        ? ''
                        : 'transition-all duration-200 ease-in-out'
                    } ${
                      isZoomVisible
                        ? 'scale-100 opacity-100'
                        : 'scale-[0.985] opacity-0'
                    }`}
                  >
                    <div className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl border border-[#49243E]/18 bg-[#F8F1ED] shadow-2xl">
                      <div
                        style={{
                          transformOrigin: '0 0',
                          transform: `translate3d(${detailTranslateX}%, ${detailTranslateY}%, 0) scale(${zoomScale})`,
                        }}
                        className="h-full w-full will-change-transform"
                      >
                        <BoutiqueImage
                          src={activeImageSrc}
                          alt={`${product.name} magnified fabric detail`}
                          loading="eager"
                          fallbackTitle={product.name}
                          className="h-full w-full object-cover object-top"
                        />
                      </div>

                      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-[#242124]/75 via-[#242124]/25 to-transparent px-4 pb-3.5 pt-10 text-xs text-[#FFF9F5]">
                        <span className="truncate font-medium">
                          {product.fabricNote || `${selectedColorName} — Magnified Detail`}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-[#F3D5DF]">
                          {zoomScale.toFixed(1)}× Detail
                        </span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h2
                      id="quick-view-title"
                      className="font-serif text-2xl font-semibold leading-tight text-[#49243E] sm:text-3xl"
                    >
                      {product.name}
                    </h2>

                    <div className="mt-2.5 flex flex-wrap items-baseline gap-3">
                      <span className="text-2xl font-semibold tabular-nums text-[#242124]">
                        {formatPaiseINR(displayPricePaise)}
                      </span>
                      {displayComparePaise && displayComparePaise > displayPricePaise && (
                        <span className="text-sm line-through tabular-nums text-[#242124]/45">
                          {formatPaiseINR(displayComparePaise)}
                        </span>
                      )}
                      <span
                        className={`text-xs font-medium tabular-nums ${
                          !colorInStock || availableStock <= 0
                            ? 'text-[#9B2C3E]'
                            : 'text-[#49243E]/75'
                        }`}
                      >
                        {!colorInStock
                          ? `Sold out in ${selectedColorName}`
                          : activeVariant
                            ? availableStock <= 0
                              ? `Size ${activeVariant.size} out of stock`
                              : availableStock <= 5
                                ? `Only ${availableStock} left`
                                : `${availableStock} in stock`
                            : `${availableStock} available across sizes`}
                      </span>
                    </div>

                    {activeVariant?.sku && (
                      <p className="mt-1 text-[11px] font-medium tracking-wide text-[#49243E]/55 tabular-nums">
                        SKU: {activeVariant.sku}
                      </p>
                    )}

                    <p className="mt-4 text-sm leading-relaxed text-[#242124]/80">
                      {product.description}
                    </p>

                    {product.fabricNote && (
                      <p className="mt-2.5 text-xs text-[#49243E]/75">
                        <span className="font-medium">Fabric &amp; Craft:</span> {product.fabricNote}
                      </p>
                    )}
                    {product.includedPieces && (
                      <p className="mt-1.5 text-xs text-[#49243E]/75">
                        <span className="font-medium">Included Pieces:</span>{' '}
                        {product.includedPieces}
                      </p>
                    )}
                    {product.careNote && (
                      <p className="mt-1.5 text-xs text-[#49243E]/75">
                        <span className="font-medium">Care:</span> {product.careNote}
                      </p>
                    )}

                    {/* Size Selector (strictly scoped to selected colour's variants) */}
                    {colorVariants.length > 0 && (
                      <div className="mt-6">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold tracking-wide uppercase text-[#49243E]">
                            {hasRealSizeChoice ? 'Size' : 'Fit'}
                          </span>
                          <span className="font-medium text-[#242124]/80">
                            {selectedSizeLabel || 'Select a size'}
                          </span>
                        </div>
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {colorVariants.map((variant) => {
                            const isSelected =
                              selectedSize.toLowerCase() === variant.size.toLowerCase();
                            const variantEmpty = variant.stockQty <= 0;
                            return (
                              <button
                                key={variant.id}
                                type="button"
                                disabled={variantEmpty}
                                onClick={() => {
                                  setSelectedSize(variant.size);
                                  setSizePromptMessage(null);
                                }}
                                aria-pressed={isSelected}
                                className={`min-h-[42px] min-w-[48px] rounded-xl border px-3.5 py-2 text-xs font-semibold transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#49243E] ${
                                  isSelected && !variantEmpty
                                    ? 'border-[#49243E] bg-[#49243E] text-[#FFF9F5]'
                                    : variantEmpty
                                      ? 'cursor-not-allowed border-[#49243E]/12 bg-[#F8F1ED]/70 text-[#242124]/38 line-through'
                                      : 'border-[#49243E]/18 bg-white text-[#49243E] hover:border-[#49243E]/55'
                                }`}
                              >
                                {variant.size}
                              </button>
                            );
                          })}
                        </div>
                        {sizePromptMessage && (
                          <p
                            role="status"
                            className="mt-2 text-xs font-medium text-[#9B2C3E]"
                          >
                            {sizePromptMessage}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Desktop Inline Purchase Actions */}
                  <div className="mt-7 space-y-3 border-t border-[#49243E]/10 pt-5">
                    <div className="hidden flex-col gap-2.5 sm:flex sm:flex-row">
                      {onAddToBag && (
                        <button
                          type="button"
                          disabled={!isPurchasable}
                          onClick={handleAddToBagClick}
                          className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl border border-[#49243E] bg-white px-5 py-3 text-sm font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 disabled:cursor-not-allowed disabled:border-[#49243E]/15 disabled:bg-[#F8F1ED] disabled:text-[#49243E]/45"
                        >
                          {addedFeedback ? (
                            <Check className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                          )}
                          <span>{primaryActionLabel}</span>
                        </button>
                      )}

                      {(onBuyNow || onAddToBag) && (
                        <button
                          type="button"
                          disabled={!isPurchasable}
                          onClick={handleBuyNowClick}
                          className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-semibold text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:bg-[#49243E]/25 disabled:text-[#49243E]/60"
                        >
                          <span>{!colorInStock ? 'Sold Out' : 'Buy Now'}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onToggleWishlist(product.id)}
                        aria-pressed={isWishlisted}
                        aria-label={isWishlisted ? 'Remove from saved pieces' : 'Save piece'}
                        className={`flex min-h-[46px] items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
                          isWishlisted
                            ? 'border-[#B76E79] bg-[#F3D5DF]/45 text-[#49243E]'
                            : 'border-[#49243E]/20 bg-white text-[#49243E] hover:bg-[#F3D5DF]/30'
                        }`}
                      >
                        <Heart
                          className={`h-4 w-4 ${isWishlisted ? 'fill-[#B76E79] text-[#B76E79]' : ''}`}
                          aria-hidden="true"
                        />
                        <span>{isWishlisted ? 'Saved' : 'Save'}</span>
                      </button>
                    </div>

                    {/* Mobile Wishlist button */}
                    <div className="flex flex-col gap-2 sm:hidden">
                      <button
                        type="button"
                        onClick={() => onToggleWishlist(product.id)}
                        aria-pressed={isWishlisted}
                        className={`flex min-h-[42px] items-center justify-center gap-2 rounded-xl border px-4 py-2 text-xs font-medium transition-colors ${
                          isWishlisted
                            ? 'border-[#B76E79] bg-[#F3D5DF]/45 text-[#49243E]'
                            : 'border-[#49243E]/20 bg-white text-[#49243E]'
                        }`}
                      >
                        <Heart
                          className={`h-4 w-4 ${isWishlisted ? 'fill-[#B76E79] text-[#B76E79]' : ''}`}
                          aria-hidden="true"
                        />
                        <span>{isWishlisted ? 'Saved to Wishlist' : 'Save to Wishlist'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Related Products Section */}
              {relatedProducts.length > 0 && (
                <div className="mt-8 border-t border-[#49243E]/10 pt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="font-serif text-lg font-semibold text-[#49243E]">
                      Related Products in {product.category}
                    </h3>
                    <span className="text-xs text-[#242124]/60">
                      Pair or explore similar silhouettes
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {relatedProducts.slice(0, 4).map((rel) => {
                      const relPricePaise = rel.pricePaise ?? Math.round(rel.price * 100);
                      return (
                        <button
                          key={rel.id}
                          type="button"
                          onClick={() => onSelectProduct?.(rel)}
                          className="group flex flex-col overflow-hidden rounded-2xl border border-[#49243E]/10 bg-white text-left transition-all hover:border-[#49243E]/30 hover:shadow-md"
                        >
                          <div className="aspect-[3/4] w-full overflow-hidden bg-[#F8F1ED]">
                            <BoutiqueImage
                              src={rel.images[0]?.src || ''}
                              alt={rel.images[0]?.alt || rel.name}
                              fallbackTitle={rel.name}
                              className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-105"
                            />
                          </div>
                          <div className="p-2.5">
                            <p className="truncate font-serif text-sm font-semibold text-[#49243E]">
                              {rel.name}
                            </p>
                            <p className="mt-0.5 text-xs font-semibold tabular-nums text-[#242124]">
                              {formatPaiseINR(relPricePaise)}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Mobile Sticky Bottom Purchase Bar (Add to Cart + Buy Now) */}
            <div className="sticky bottom-0 z-20 flex shrink-0 items-center gap-2.5 border-t border-[#49243E]/12 bg-[#FFF9F5]/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-sm sm:hidden">
              {onAddToBag && (
                <button
                  type="button"
                  disabled={!isPurchasable}
                  onClick={handleAddToBagClick}
                  className="flex min-h-[46px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#49243E] bg-white px-3.5 py-2.5 text-sm font-semibold text-[#49243E] transition-colors active:bg-[#F3D5DF]/40 disabled:cursor-not-allowed disabled:border-[#49243E]/15 disabled:bg-[#F8F1ED] disabled:text-[#49243E]/45"
                >
                  {addedFeedback ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span>{primaryActionLabel}</span>
                </button>
              )}
              {(onBuyNow || onAddToBag) && (
                <button
                  type="button"
                  disabled={!isPurchasable}
                  onClick={handleBuyNowClick}
                  className="flex min-h-[46px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#49243E] px-3.5 py-2.5 text-sm font-semibold text-[#FFF9F5] transition-colors active:bg-[#3A1B31] disabled:cursor-not-allowed disabled:bg-[#49243E]/25 disabled:text-[#49243E]/60"
                >
                  <span>{!colorInStock ? 'Sold Out' : 'Buy Now'}</span>
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
