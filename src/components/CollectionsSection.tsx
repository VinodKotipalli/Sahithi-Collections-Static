import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useStorefront } from '../context/StorefrontContext';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { CollectionCategory } from '../types/boutique';
import { BoutiqueImage } from './BoutiqueImage';
import { RevealSection } from './RevealSection';

interface CollectionsSectionProps {
  onSelectCollection: (category: CollectionCategory) => void;
}

export function CollectionsSection({ onSelectCollection }: CollectionsSectionProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { categories, content } = useStorefront();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { collectionsHeader } = content;

  const gridColsClass =
    categories.length <= 2
      ? 'sm:grid-cols-2 lg:grid-cols-2'
      : categories.length === 3
        ? 'sm:grid-cols-2 lg:grid-cols-3'
        : categories.length === 4
          ? 'sm:grid-cols-2 lg:grid-cols-4'
          : categories.length === 5
            ? 'sm:grid-cols-2 lg:grid-cols-5'
            : 'sm:grid-cols-2 lg:grid-cols-4';

  return (
    <section id="collections" className="py-16 sm:py-24 bg-[#FFF9F5]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <RevealSection>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-[#49243E]/10 pb-6">
            <div>
              <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
                {collectionsHeader.kicker}
              </p>
              <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
                {collectionsHeader.heading}
              </h2>
            </div>
            <p className="max-w-md text-sm leading-relaxed text-[#242124]/75">
              {collectionsHeader.subtitle}
            </p>
          </div>
        </RevealSection>

        <div className={`mt-10 grid grid-cols-1 gap-5 ${gridColsClass}`}>
          {categories.map((col, index) => {
            const isHovered = hoveredId === col.id;
            return (
              <RevealSection key={col.id} delay={index * 0.05}>
                <button
                  type="button"
                  onClick={() => onSelectCollection(col.name)}
                  onMouseEnter={() => setHoveredId(col.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={`group relative flex w-full flex-col overflow-hidden rounded-2xl border border-[#49243E]/10 bg-white text-left transition-all duration-300 ${
                    prefersReducedMotion
                      ? 'hover:border-[#B76E79]/50'
                      : 'hover:-translate-y-1.5 hover:border-[#B76E79]/50 hover:shadow-[0_20px_40px_-18px_rgba(73,36,62,0.22)]'
                  }`}
                >
                  <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#F3D5DF]/25">
                    <BoutiqueImage
                      src={col.imageUrl}
                      alt={col.altText || col.name}
                      loading="lazy"
                      fallbackTitle={col.name}
                      className={`h-full w-full object-cover object-top transition-transform duration-500 ease-out ${
                        !prefersReducedMotion && isHovered ? 'scale-105' : 'scale-100'
                      }`}
                    />
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 bg-gradient-to-t from-[#242124]/75 via-[#242124]/15 to-transparent"
                    />
                    <div className="absolute inset-x-0 bottom-0 p-4 text-[#FFF9F5]">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-serif text-xl font-semibold tracking-tight">
                          {col.name}
                        </h3>
                        <ArrowUpRight
                          className={`h-4 w-4 shrink-0 text-[#F3D5DF] transition-transform duration-200 ${
                            isHovered && !prefersReducedMotion ? 'translate-x-0.5 -translate-y-0.5' : ''
                          }`}
                          aria-hidden="true"
                        />
                      </div>
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 block h-[1.5px] bg-[#F3D5DF] transition-all duration-300 ${
                          isHovered ? 'w-12 opacity-100' : 'w-5 opacity-60'
                        }`}
                      />
                      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-[#FFF9F5]/85">
                        {col.subtitle}
                      </p>
                    </div>
                  </div>
                </button>
              </RevealSection>
            );
          })}
        </div>
      </div>
    </section>
  );
}
