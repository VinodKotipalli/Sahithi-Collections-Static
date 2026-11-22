import { useMemo, useState } from 'react';
import { Eye, Heart } from 'lucide-react';
import { motion } from 'motion/react';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { Product } from '../types/boutique';
import { countActiveColors, normalizeProductColors } from '../utils/colorVariants';
import { formatINR } from '../utils/format';
import { BoutiqueImage } from './BoutiqueImage';

interface ProductCardProps {
  product: Product;
  isWishlisted: boolean;
  onToggleWishlist: (productId: string) => void;
  onQuickView: (product: Product) => void;
}

export function ProductCard({
  product,
  isWishlisted,
  onToggleWishlist,
  onQuickView,
}: ProductCardProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [isHovered, setIsHovered] = useState(false);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 });

  const normalizedColors = useMemo(() => normalizeProductColors(product), [product]);
  const activeColorCount = useMemo(() => countActiveColors(product), [product]);
  const primaryColor = normalizedColors.find((c) => c.inStock) || normalizedColors[0];
  const cardImages = useMemo(() => {
    if (primaryColor && primaryColor.images.length > 0) {
      return primaryColor.images;
    }
    return product.images;
  }, [primaryColor, product.images]);

  const hasSecondaryImage = cardImages.length > 1;

  const handleMouseMove = (event: React.MouseEvent<HTMLElement>) => {
    if (prefersReducedMotion) return;
    if (typeof window !== 'undefined' && !window.matchMedia('(pointer: fine)').matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    setTilt({
      rx: Number((-py * 4).toFixed(2)),
      ry: Number((px * 4).toFixed(2)),
    });
  };

  const resetHover = () => {
    setIsHovered(false);
    setTilt({ rx: 0, ry: 0 });
  };

  return (
    <motion.article
      layout={!prefersReducedMotion}
      initial={prefersReducedMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, y: 8 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseMove={handleMouseMove}
      onMouseLeave={resetHover}
      style={
        prefersReducedMotion
          ? undefined
          : {
              transform: `perspective(900px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
              transition: isHovered
                ? 'transform 150ms ease-out, box-shadow 220ms ease-out'
                : 'transform 300ms ease-out, box-shadow 220ms ease-out',
            }
      }
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-[#49243E]/10 bg-white shadow-[0_8px_24px_-16px_rgba(73,36,62,0.18)] hover:border-[#B76E79]/45 hover:shadow-[0_20px_40px_-20px_rgba(73,36,62,0.22)]"
    >
      {/* Image Frame */}
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#F9F1ED]">
        <button
          type="button"
          onClick={() => onQuickView(product)}
          aria-label={`Quick view ${product.name}`}
          className="block h-full w-full text-left focus-visible:outline-offset-[-4px]"
        >
          <BoutiqueImage
            src={cardImages[0]?.src || product.images[0]?.src || ''}
            alt={cardImages[0]?.alt || product.images[0]?.alt || product.name}
            loading="lazy"
            fallbackTitle={product.name}
            className={`h-full w-full object-cover object-top transition-all duration-700 ease-out ${
              hasSecondaryImage && isHovered
                ? 'opacity-0 scale-105'
                : 'opacity-100 group-hover:scale-[1.04]'
            }`}
          />

          {hasSecondaryImage && (
            <BoutiqueImage
              src={cardImages[1].src}
              alt={cardImages[1].alt}
              loading="lazy"
              fallbackTitle={product.name}
              className={`absolute inset-0 h-full w-full object-cover object-top transition-all duration-700 ease-out ${
                isHovered ? 'opacity-100 scale-[1.04]' : 'opacity-0 scale-100'
              }`}
            />
          )}

          {/* Subtle bottom editorial veil on hover */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[#242124]/30 via-[#242124]/8 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          />
        </button>

        {/* Wishlist Toggle Button */}
        <motion.button
          type="button"
          onClick={() => onToggleWishlist(product.id)}
          aria-label={isWishlisted ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`}
          aria-pressed={isWishlisted}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.86 }}
          className="absolute top-2.5 right-2.5 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-[#49243E]/10 bg-[#FFF9F5]/92 text-[#49243E] shadow-sm backdrop-blur-xs transition-colors duration-200 hover:bg-[#FFF9F5]"
        >
          <Heart
            className={`h-[18px] w-[18px] transition-transform duration-200 ${
              isWishlisted ? 'scale-110 fill-[#B76E79] text-[#B76E79]' : 'text-[#49243E]'
            }`}
            aria-hidden="true"
          />
        </motion.button>
      </div>

      {/* Product Body */}
      <div className="flex flex-1 flex-col justify-between p-3.5 sm:p-4">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.12em] uppercase text-[#B76E79]">
            <span className="truncate">{product.category}</span>
            {product.featured && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 text-[#49243E]/70">Featured</span>
              </>
            )}
          </div>

          <h3 className="mt-1.5 line-clamp-2 min-h-[2.75rem] font-serif text-[1.0625rem] font-semibold leading-snug text-[#49243E]">
            <button
              type="button"
              onClick={() => onQuickView(product)}
              className="text-left transition-colors hover:text-[#B76E79]"
            >
              {product.name}
            </button>
          </h3>

          {/* Colour availability & sizes */}
          <div className="mt-2.5 space-y-1">
            {activeColorCount > 1 && (
              <p className="text-[11px] font-medium text-[#49243E]/75">
                Available in {activeColorCount} colours
              </p>
            )}
            <div className="flex items-center gap-1.5" aria-label="Available colours and sizes">
              {normalizedColors.slice(0, 5).map((color) => (
                <span
                  key={color.id}
                  title={color.name}
                  className="h-3.5 w-3.5 shrink-0 rounded-full border border-[#242124]/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.35)]"
                  style={{ backgroundColor: color.hex }}
                />
              ))}
              {normalizedColors.length > 5 && (
                <span className="text-[10px] font-medium text-[#49243E]/65 tabular-nums">
                  +{normalizedColors.length - 5}
                </span>
              )}
              <span className="ml-1 truncate text-[11px] text-[#242124]/58">
                {product.sizes.join(' · ')}
              </span>
            </div>
          </div>
        </div>

        {/* Price + Quick View Action (always reachable on touch & desktop) */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#49243E]/8 pt-3">
          <div className="flex flex-col">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold tabular-nums text-[#242124]">
                {formatINR(product.price)}
              </span>
              {product.compareAtPrice && product.compareAtPrice > product.price && (
                <span className="text-xs line-through tabular-nums text-[#242124]/45">
                  {formatINR(product.compareAtPrice)}
                </span>
              )}
            </div>
            {product.stockQty !== undefined && product.stockQty === 0 ? (
              <span className="text-[11px] font-medium text-[#B76E79]">Out of stock</span>
            ) : product.stockQty !== undefined &&
              product.lowStockThreshold !== undefined &&
              product.stockQty <= product.lowStockThreshold ? (
              <span className="text-[11px] font-medium text-[#49243E]/75 tabular-nums">
                Only {product.stockQty} left
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => onQuickView(product)}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 py-1.5 text-xs font-medium text-[#49243E] transition-colors duration-200 hover:border-[#49243E] hover:bg-[#49243E] hover:text-[#FFF9F5] whitespace-nowrap shrink-0"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Quick View</span>
          </button>
        </div>
      </div>
    </motion.article>
  );
}
