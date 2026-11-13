import { useRef } from 'react';
import { Eye, Heart, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { Product } from '../types/boutique';
import { formatINR } from '../utils/format';
import { BoutiqueImage } from './BoutiqueImage';

interface WishlistDrawerProps {
  isOpen: boolean;
  items: Product[];
  onClose: () => void;
  onRemoveItem: (id: string) => void;
  onClearAll: () => void;
  onQuickView: (product: Product) => void;
}

export function WishlistDrawer({
  isOpen,
  items,
  onClose,
  onRemoveItem,
  onClearAll,
  onQuickView,
}: WishlistDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useFocusTrap(isOpen, drawerRef, onClose);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex justify-end bg-[#242124]/45"
        >
          <motion.div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wishlist-drawer-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={prefersReducedMotion ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={prefersReducedMotion ? undefined : { x: '100%' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="flex h-full w-full max-w-md flex-col bg-[#FFF9F5] shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#49243E]/10 px-5 py-4">
              <div>
                <h2
                  id="wishlist-drawer-title"
                  className="font-serif text-2xl font-semibold text-[#49243E]"
                >
                  Saved Wishlist
                </h2>
                <p className="text-xs text-[#242124]/65 tabular-nums">
                  {items.length} {items.length === 1 ? 'piece saved' : 'pieces saved'}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close wishlist"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[#49243E]/15 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {items.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center px-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
                    <Heart className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
                    Your wishlist is empty
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#242124]/70">
                    Tap the heart icon on any dress, ethnic ensemble, or accessory to save your favorite styles here.
                  </p>
                  <a
                    href="#new-arrivals"
                    onClick={onClose}
                    className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#49243E] px-6 py-2.5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                  >
                    Browse New Arrivals
                  </a>
                </div>
              ) : (
                <ul className="space-y-4">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="flex gap-3.5 rounded-2xl border border-[#49243E]/10 bg-white p-3"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onQuickView(item);
                        }}
                        className="h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-[#F8F1ED]"
                      >
                        <BoutiqueImage
                          src={item.images[0]?.src || ''}
                          alt={item.images[0]?.alt || item.name}
                          loading="eager"
                          className="h-full w-full object-cover object-top"
                        />
                      </button>

                      <div className="flex min-w-0 flex-1 flex-col justify-between">
                        <div>
                          <p className="text-[11px] font-medium tracking-wider uppercase text-[#B76E79]">
                            {item.category}
                          </p>
                          <h3 className="mt-0.5 line-clamp-2 font-serif text-base font-semibold leading-snug text-[#49243E]">
                            {item.name}
                          </h3>
                          <p className="mt-1 text-sm font-semibold tabular-nums text-[#242124]">
                            {formatINR(item.price)}
                          </p>
                        </div>

                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onQuickView(item);
                            }}
                            className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[#49243E]/18 px-2.5 py-1 text-xs font-medium text-[#49243E] hover:bg-[#49243E] hover:text-[#FFF9F5] transition-colors"
                          >
                            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Quick View</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => onRemoveItem(item.id)}
                            aria-label={`Remove ${item.name} from wishlist`}
                            className="inline-flex min-h-[38px] items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[#242124]/65 hover:bg-[#F3D5DF]/40 hover:text-[#49243E] transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Remove</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Footer */}
            {items.length > 0 && (
              <div className="border-t border-[#49243E]/10 bg-[#FFF9F5] px-5 py-4 flex items-center justify-between gap-3">
                <span className="text-xs text-[#242124]/70">
                  Saved locally in your browser
                </span>
                <button
                  type="button"
                  onClick={onClearAll}
                  className="min-h-[40px] rounded-xl border border-[#49243E]/20 px-4 py-2 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
                >
                  Clear All
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
