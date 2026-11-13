import { Expand } from 'lucide-react';
import { LOOKBOOK_ENTRIES } from '../config/lookbook';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { LookbookEntry } from '../types/boutique';
import { BoutiqueImage } from './BoutiqueImage';
import { RevealSection } from './RevealSection';

interface LookbookSectionProps {
  onOpenLightbox: (index: number) => void;
}

function getLayoutClasses(layout: LookbookEntry['layout']): string {
  switch (layout) {
    case 'tall':
      return 'md:row-span-2 aspect-[3/4] md:aspect-auto md:h-full';
    case 'wide':
      return 'md:col-span-2 aspect-[4/3] md:aspect-[16/9]';
    case 'square':
    default:
      return 'aspect-[3/4] sm:aspect-[4/4]';
  }
}

export function LookbookSection({ onOpenLightbox }: LookbookSectionProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <section id="lookbook" className="py-16 sm:py-24 bg-[#FFF9F5]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <RevealSection>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-[#49243E]/10 pb-6">
            <div>
              <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
                Editorial Journal
              </p>
              <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
                The Style Lookbook
              </h2>
            </div>
            <p className="max-w-md text-sm leading-relaxed text-[#242124]/75">
              Tap any frame to view full-resolution styling notes in our editorial lightbox.
            </p>
          </div>
        </RevealSection>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 md:auto-rows-[240px] lg:auto-rows-[275px] sm:gap-5">
          {LOOKBOOK_ENTRIES.map((entry, idx) => (
            <RevealSection
              key={entry.id}
              delay={idx * 0.04}
              className={
                entry.layout === 'tall'
                  ? 'md:row-span-2'
                  : entry.layout === 'wide'
                    ? 'md:col-span-2'
                    : ''
              }
            >
              <button
                type="button"
                onClick={() => onOpenLightbox(idx)}
                aria-label={`Open lookbook frame: ${entry.title}`}
                className={`group relative block w-full overflow-hidden rounded-2xl border border-[#49243E]/10 bg-[#F3D5DF]/20 text-left ${getLayoutClasses(
                  entry.layout
                )}`}
              >
                <BoutiqueImage
                  src={entry.image}
                  alt={entry.alt}
                  loading="lazy"
                  fallbackTitle={entry.title}
                  className={`h-full w-full object-cover object-top transition-transform duration-500 ease-out ${
                    prefersReducedMotion ? '' : 'group-hover:scale-105'
                  }`}
                />

                {/* Contrast scrim for legible styling caption */}
                <div
                  aria-hidden="true"
                  className="absolute inset-0 bg-gradient-to-t from-[#242124]/80 via-[#242124]/20 to-transparent opacity-90 transition-opacity duration-300 md:opacity-75 md:group-hover:opacity-95"
                />

                {/* Touch-friendly expand hint */}
                <span
                  aria-hidden="true"
                  className="absolute top-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#FFF9F5]/90 text-[#49243E] shadow-sm transition-transform duration-200 md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100"
                >
                  <Expand className="h-4 w-4" />
                </span>

                <div className="absolute inset-x-0 bottom-0 p-4 text-[#FFF9F5] sm:p-5">
                  <span className="text-[11px] font-medium tracking-[0.16em] uppercase text-[#F3D5DF]">
                    {entry.category}
                  </span>
                  <h3 className="mt-1 font-serif text-xl font-semibold tracking-tight">
                    {entry.title}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-[#FFF9F5]/85 transition-all duration-300 md:translate-y-1 md:opacity-90 md:group-hover:translate-y-0 md:group-hover:opacity-100">
                    {entry.caption}
                  </p>
                </div>
              </button>
            </RevealSection>
          ))}
        </div>
      </div>
    </section>
  );
}
