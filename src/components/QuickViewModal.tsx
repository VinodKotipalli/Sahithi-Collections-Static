import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Heart, MessageCircle, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  buildWhatsAppEnquiryMessage,
  buildWhatsAppEnquiryUrl,
  isWhatsAppConfigured,
} from '../config/site';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { Product } from '../types/boutique';
import { formatINR } from '../utils/format';
import { BoutiqueImage } from './BoutiqueImage';

interface QuickViewModalProps {
  product: Product | null;
  isWishlisted: boolean;
  onToggleWishlist: (id: string) => void;
  onClose: () => void;
}

export function QuickViewModal({
  product,
  isWishlisted,
  onToggleWishlist,
  onClose,
}: QuickViewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const isOpen = product !== null;

  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [selectedColor, setSelectedColor] = useState('');
  const [selectedSize, setSelectedSize] = useState('');

  useFocusTrap(isOpen, modalRef, onClose);

  useEffect(() => {
    if (!product) return;
    setActiveImageIndex(0);
    setSelectedColor(product.colors[0]?.name || 'Default');
    setSelectedSize(product.sizes[0] || 'Free Size');
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

  const whatsAppReady = isWhatsAppConfigured();
  const enquiryUrl = product
    ? buildWhatsAppEnquiryUrl({
        productName: product.name,
        selectedSize,
        selectedColor,
      })
    : null;
  const enquiryPreview = product
    ? buildWhatsAppEnquiryMessage({
        productName: product.name,
        selectedSize,
        selectedColor,
      })
    : '';

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
                      <div className="absolute inset-x-3 top-1/2 flex -translate-y-1/2 justify-between pointer-events-none">
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
                <div className="md:col-span-6 flex flex-col justify-between">
                  <div>
                    <h2
                      id="quick-view-title"
                      className="font-serif text-2xl font-semibold leading-tight text-[#49243E] sm:text-3xl"
                    >
                      {product.name}
                    </h2>

                    <div className="mt-2.5 flex items-baseline gap-3">
                      <span className="text-2xl font-semibold tabular-nums text-[#242124]">
                        {formatINR(product.price)}
                      </span>
                      <span className="text-xs text-[#242124]/60">
                        Demo showcase price
                      </span>
                    </div>

                    <p className="mt-4 text-sm leading-relaxed text-[#242124]/80">
                      {product.description}
                    </p>

                    <p className="mt-2.5 text-xs text-[#49243E]/75">
                      <span className="font-medium">Fabric &amp; Craft:</span> {product.fabricNote}
                    </p>

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
                              {isSelected && <Check className="h-3.5 w-3.5 text-[#49243E]" aria-hidden="true" />}
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
                          return (
                            <button
                              key={size}
                              type="button"
                              onClick={() => setSelectedSize(size)}
                              aria-pressed={isSelected}
                              className={`min-h-[42px] min-w-[48px] rounded-xl border px-3.5 py-2 text-xs font-semibold transition-all ${
                                isSelected
                                  ? 'border-[#49243E] bg-[#49243E] text-[#FFF9F5]'
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

                  {/* Actions & WhatsApp Enquiry */}
                  <div className="mt-7 space-y-3 border-t border-[#49243E]/10 pt-5">
                    <div className="flex flex-col gap-2.5 sm:flex-row">
                      {whatsAppReady && enquiryUrl ? (
                        <a
                          href={enquiryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 py-3 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                        >
                          <MessageCircle className="h-4 w-4" aria-hidden="true" />
                          <span>Enquire About This Product</span>
                        </a>
                      ) : (
                        <button
                          type="button"
                          disabled
                          aria-disabled="true"
                          className="flex min-h-[46px] flex-1 cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-[#49243E]/15 bg-[#49243E]/10 px-5 py-3 text-sm font-medium text-[#49243E]/55"
                        >
                          <MessageCircle className="h-4 w-4" aria-hidden="true" />
                          <span>Enquire About This Product</span>
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

                    {!whatsAppReady ? (
                      <div className="rounded-xl border border-[#B76E79]/30 bg-[#F3D5DF]/25 p-3 text-xs leading-relaxed text-[#49243E]">
                        <p className="font-semibold">
                          WhatsApp enquiry setup required
                        </p>
                        <p className="mt-1 text-[#242124]/80">
                          Add a real WhatsApp number in{' '}
                          <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px]">
                            src/config/site.ts
                          </code>{' '}
                          to activate one-tap product enquiries. Prepared draft: “{enquiryPreview}”
                        </p>
                      </div>
                    ) : (
                      <p className="text-[11px] leading-relaxed text-[#242124]/65">
                        Opens WhatsApp with your selected color ({selectedColor}) and size ({selectedSize}).
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
