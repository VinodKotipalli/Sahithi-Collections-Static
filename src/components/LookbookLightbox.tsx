import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { LOOKBOOK_ENTRIES } from '../config/lookbook';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { BoutiqueImage } from './BoutiqueImage';

interface LookbookLightboxProps {
  activeIndex: number | null;
  onClose: () => void;
  onChangeIndex: (newIndex: number) => void;
}

export function LookbookLightbox({
  activeIndex,
  onClose,
  onChangeIndex,
}: LookbookLightboxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const isOpen = activeIndex !== null;

  useFocusTrap(isOpen, containerRef, onClose);

  const total = LOOKBOOK_ENTRIES.length;
  const entry = activeIndex !== null ? LOOKBOOK_ENTRIES[activeIndex] : null;

  const goPrev = () => {
    if (activeIndex === null) return;
    onChangeIndex((activeIndex - 1 + total) % total);
  };

  const goNext = () => {
    if (activeIndex === null) return;
    onChangeIndex((activeIndex + 1) % total);
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrev();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <AnimatePresence>
      {isOpen && entry && activeIndex !== null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.01 : 0.22 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#242124]/85 p-4 sm:p-6"
        >
          <motion.div
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Lookbook view: ${entry.title}`}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="relative flex max-h-[92svh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-[#FFF9F5]/15 bg-[#FFF9F5] shadow-2xl"
          >
            {/* Header Bar */}
            <div className="flex items-center justify-between gap-4 border-b border-[#49243E]/10 px-4 py-3 sm:px-6">
              <div className="min-w-0">
                <p className="text-[11px] font-medium tracking-[0.18em] uppercase text-[#B76E79]">
                  {entry.category} <span aria-hidden="true">·</span>{' '}
                  <span className="tabular-nums">
                    {activeIndex + 1} / {total}
                  </span>
                </p>
                <h3 className="truncate font-serif text-xl font-semibold text-[#49243E]">
                  {entry.title}
                </h3>
              </div>

              <button
                type="button"
                onClick={onClose}
                aria-label="Close lightbox"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#49243E]/15 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Image Viewport */}
            <div className="relative flex-1 overflow-y-auto bg-[#F8F1ED] p-3 sm:p-5">
              <div className="relative mx-auto flex max-h-[62svh] items-center justify-center overflow-hidden rounded-2xl">
                <BoutiqueImage
                  src={entry.image}
                  alt={entry.alt}
                  loading="eager"
                  fallbackTitle={entry.title}
                  className="max-h-[62svh] w-auto max-w-full rounded-2xl object-contain"
                />
              </div>
            </div>

            {/* Footer Controls & Caption */}
            <div className="flex flex-col gap-3 border-t border-[#49243E]/10 bg-[#FFF9F5] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="text-sm text-[#242124]/80">{entry.caption}</p>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={goPrev}
                  aria-label="Previous lookbook photo"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E]/20 px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  aria-label="Next lookbook photo"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#49243E] px-4 py-2 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                >
                  <span>Next</span>
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
