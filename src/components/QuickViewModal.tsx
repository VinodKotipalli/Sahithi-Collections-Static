import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Heart,
  MessageCircle,
  ShoppingBag,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  buildWhatsAppEnquiryUrl,
  formatWhatsAppDisplay,
  resolveWhatsAppDigits,
} from '../config/site';
import { useStorefront } from '../context/StorefrontContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import type { BagItem, Product } from '../types/boutique';
import { formatPaiseINR } from '../utils/format';
import { BoutiqueImage } from './BoutiqueImage';

interface QuickViewModalProps {
  product: Product | null;
  isWishlisted: boolean;
  onToggleWishlist: (id: string) => void;
  onAddToBag?: (item: Omit<BagItem, 'quantity'> & { quantity?: number }) => void;
  onBuyNow?: (item: Omit<BagItem, 'quantity'> & { quantity?: number }) => void;
  onAskStylist?: (product: Product, selectedSize: string, selectedColor: string) => void;
  relatedProducts?: Product[];
  onSelectProduct?: (product: Product) => void;
  onClose: () => void;
}

export function QuickViewModal({
  product,
  isWishlisted,
  onToggleWishlist,
  onAddToBag,
  onBuyNow,
  onAskStylist,
  relatedProducts = [],
  onSelectProduct,
  onClose,
}: QuickViewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const { settings } = useStorefront();
  const isOpen = product !== null;

  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [selectedColor, setSelectedColor] = useState('');
  const [selectedSize, setSelectedSize] = useState('');
  const [addedFeedback, setAddedFeedback] = useState(false);

  useFocusTrap(isOpen, modalRef, onClose);

  useEffect(() => {
    if (!product) return;
    setActiveImageIndex(0);
    setAddedFeedback(false);
    const firstInStock = product.variants?.find((v) => v.stockQty > 0) || product.variants?.[0];
    setSelectedColor(firstInStock?.colorName || product.colors[0]?.name || 'Default');
    setSelectedSize(firstInStock?.size || product.sizes[0] || 'Free Size');
  }, [product]);

  useEffect(() => {
    if (!product || product.images.length <= 1) return;
    const handleArrows = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        setActiveImageIndex((prev) => (prev - 1 + product.images.length) % product.images.length);
      } else if (event.key === 'ArrowRight') {
        setActiveImageIndex((prev) => (prev + 1) % product.images.length);
      }
    };
    window.addEventListener('keydown', handleArrows);
    return () => window.removeEventListener('keydown', handleArrows);
  }, [product]);

  const activeVariant = useMemo(() => {
    if (!product?.variants || product.variants.length === 0) return null;
    return (
      product.variants.find(
        (v) => v.colorName === selectedColor && v.size === selectedSize
      ) ||
      product.variants.find((v) => v.colorName === selectedColor) ||
      product.variants.find((v) => v.size === selectedSize) ||
      product.variants[0]
    );
  }, [product, selectedColor, selectedSize]);

  const displayPricePaise =
    activeVariant?.pricePaise ?? product?.pricePaise ?? Math.round((product?.price || 0) * 100);
  const displayComparePaise =
    activeVariant?.compareAtPaise ??
    product?.compareAtPaise ??
    (product?.compareAtPrice ? Math.round(product.compareAtPrice * 100) : null);
  const availableStock = activeVariant?.stockQty ?? product?.stockQty ?? 1;

  const whatsappDigits = resolveWhatsAppDigits(settings.contact);
  const whatsappDisplay = formatWhatsAppDisplay(whatsappDigits);
  const enquiryUrl = product
    ? buildWhatsAppEnquiryUrl({
        productName: product.name,
        selectedSize,
        selectedColor,
        brandName: settings.brandName,
        contact: settings.contact,
      })
    : '';

  const buildBagPayload = () => {
    if (!product) return null;
    return {
      productId: product.id,
      variantId: activeVariant?.id || `${product.id}-v-1`,
      seenPricePaise: displayPricePaise,
      fallbackTitle: product.name,
      fallbackVariant: `${selectedSize} · ${selectedColor}`,
      fallbackImage: product.images[0]?.src || '',
      quantity: 1,
    };
  };

  const handleAddToBagClick = () => {
    if (!product || !onAddToBag || availableStock <= 0) return;
    const payload = buildBagPayload();
    if (!payload) return;
    onAddToBag(payload);
    setAddedFeedback(true);
    window.setTimeout(() => setAddedFeedback(false), 1800);
  };

  const handleBuyNowClick = () => {
    if (!product || availableStock <= 0) return;
    const payload = buildBagPayload();
    if (!payload) return;
    if (onBuyNow) {
      onBuyNow(payload);
    } else if (onAddToBag) {
      onAddToBag(payload);
    }
  };

  return (
    <AnimatePresence>
      {product && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#242124]/60 p-3 sm:p-6"
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
            className="relative flex max-h-[92svh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-[#49243E]/12 bg-[#FFF9F5] shadow-2xl"
          >
            {/* Sticky Top Bar inside Modal for Mobile Convenience */}
            <div className="flex items-center justify-between border-b border-[#49243E]/10 px-4 py-3 sm:px-6">
              <p className="text-xs font-medium tracking-[0.18em] uppercase text-[#B76E79]">
                {product.category}
              </p>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close product quick view"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[#49243E]/15 bg-white text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="overflow-y-auto p-4 sm:p-6 lg:p-8">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-12 md:gap-8">
                {/* Gallery Column */}
                <div className="md:col-span-6">
                  <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-[#49243E]/10 bg-[#F8F1ED]">
                    <BoutiqueImage
                      src={product.images[activeImageIndex]?.src || ''}
                      alt={product.images[activeImageIndex]?.alt || product.name}
                      loading="eager"
                      fallbackTitle={product.name}
                      className="h-full w-full object-cover object-top"
                    />

                    {product.images.length > 1 && (
                      <div className="pointer-events-none absolute inset-x-3 top-1/2 flex -translate-y-1/2 justify-between">
                        <button
                          type="button"
                          onClick={() =>
                            setActiveImageIndex(
                              (prev) => (prev - 1 + product.images.length) % product.images.length
                            )
                          }
                          aria-label="Previous product image"
                          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-[#FFF9F5]/90 text-[#49243E] shadow-sm transition-colors hover:bg-[#FFF9F5]"
                        >
                          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setActiveImageIndex((prev) => (prev + 1) % product.images.length)
                          }
                          aria-label="Next product image"
                          className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-[#FFF9F5]/90 text-[#49243E] shadow-sm transition-colors hover:bg-[#FFF9F5]"
                        >
                          <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>

                  {product.images.length > 1 && (
                    <div className="mt-3 flex items-center gap-2.5">
                      {product.images.map((img, idx) => (
                        <button
                          key={img.src + idx}
                          type="button"
                          onClick={() => setActiveImageIndex(idx)}
                          aria-label={`View image ${idx + 1} of ${product.images.length}`}
                          aria-pressed={activeImageIndex === idx}
                          className={`relative h-16 w-14 overflow-hidden rounded-xl border-2 transition-all ${
                            activeImageIndex === idx
                              ? 'border-[#49243E]'
                              : 'border-transparent opacity-65 hover:opacity-100'
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
                </div>

                {/* Details Column */}
                <div className="flex flex-col justify-between md:col-span-6">
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
                          availableStock <= 0 ? 'text-[#B76E79]' : 'text-[#49243E]/75'
                        }`}
                      >
                        {availableStock <= 0
                          ? 'Out of stock'
                          : availableStock <= 5
                            ? `Only ${availableStock} left`
                            : `${availableStock} in stock`}
                      </span>
                    </div>

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

                    {/* Color Selector */}
                    <div className="mt-6">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold tracking-wide uppercase text-[#49243E]">
                          Color
                        </span>
                        <span className="font-medium text-[#242124]/80">{selectedColor}</span>
                      </div>
                      <div className="mt-2.5 flex flex-wrap gap-2.5">
                        {product.colors.map((color) => {
                          const isSelected = selectedColor === color.name;
                          return (
                            <button
                              key={color.name}
                              type="button"
                              onClick={() => setSelectedColor(color.name)}
                              aria-label={`Select color ${color.name}`}
                              aria-pressed={isSelected}
                              className={`flex min-h-[42px] items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
                                isSelected
                                  ? 'border-[#49243E] bg-[#F3D5DF]/40 text-[#49243E]'
                                  : 'border-[#49243E]/15 bg-white text-[#242124]/80 hover:border-[#B76E79]'
                              }`}
                            >
                              <span
                                className="h-4 w-4 rounded-full border border-[#242124]/20"
                                style={{ backgroundColor: color.hex }}
                                aria-hidden="true"
                              />
                              <span>{color.name}</span>
                              {isSelected && (
                                <Check className="h-3.5 w-3.5 text-[#49243E]" aria-hidden="true" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Size Selector */}
                    <div className="mt-6">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold tracking-wide uppercase text-[#49243E]">
                          Size
                        </span>
                        <span className="font-medium text-[#242124]/80">{selectedSize}</span>
                      </div>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {product.sizes.map((size) => {
                          const isSelected = selectedSize === size;
                          const matchingVariant = product.variants?.find(
                            (v) => v.size === size && v.colorName === selectedColor
                          );
                          const variantEmpty = matchingVariant ? matchingVariant.stockQty <= 0 : false;
                          return (
                            <button
                              key={size}
                              type="button"
                              onClick={() => setSelectedSize(size)}
                              aria-pressed={isSelected}
                              className={`min-h-[42px] min-w-[48px] rounded-xl border px-3.5 py-2 text-xs font-semibold transition-all ${
                                isSelected
                                  ? 'border-[#49243E] bg-[#49243E] text-[#FFF9F5]'
                                  : variantEmpty
                                    ? 'border-[#49243E]/12 bg-white/60 text-[#242124]/45'
                                    : 'border-[#49243E]/18 bg-white text-[#49243E] hover:border-[#49243E]/45'
                              }`}
                            >
                              {size}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Actions: Add to Bag, Buy Now, Wishlist & WhatsApp Enquiry */}
                  <div className="mt-7 space-y-3 border-t border-[#49243E]/10 pt-5">
                    <div className="flex flex-col gap-2.5 sm:flex-row">
                      {onAddToBag && (
                        <button
                          type="button"
                          disabled={availableStock <= 0}
                          onClick={handleAddToBagClick}
                          className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:bg-[#49243E]/25 disabled:text-[#49243E]/60"
                        >
                          {addedFeedback ? (
                            <Check className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                          )}
                          <span>
                            {availableStock <= 0
                              ? 'Out of Stock'
                              : addedFeedback
                                ? 'Added to Bag'
                                : 'Add to Bag'}
                          </span>
                        </button>
                      )}

                      {(onBuyNow || onAddToBag) && availableStock > 0 && (
                        <button
                          type="button"
                          onClick={handleBuyNowClick}
                          className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl border border-[#49243E] bg-[#F3D5DF]/40 px-5 py-3 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/70"
                        >
                          <span>Buy Now</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onToggleWishlist(product.id)}
                        aria-pressed={isWishlisted}
                        className={`flex min-h-[46px] items-center justify-center gap-2 rounded-xl border px-5 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
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

                    <div className="flex flex-col gap-2 sm:flex-row">
                      {onAskStylist && (
                        <button
                          type="button"
                          onClick={() => onAskStylist(product, selectedSize, selectedColor)}
                          className="flex min-h-[42px] flex-1 items-center justify-center gap-2 rounded-xl border border-[#49243E]/25 bg-white px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35"
                        >
                          <MessageCircle className="h-4 w-4" aria-hidden="true" />
                          <span>Ask AI Stylist</span>
                        </button>
                      )}
                      {enquiryUrl && (
                        <a
                          href={enquiryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-h-[42px] flex-1 items-center justify-center gap-2 rounded-xl border border-[#49243E]/20 bg-white px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/25 tabular-nums"
                        >
                          <MessageCircle className="h-4 w-4" aria-hidden="true" />
                          <span>WhatsApp ({whatsappDisplay})</span>
                        </a>
                      )}
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

