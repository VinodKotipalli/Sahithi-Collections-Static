import { ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { useStorefront } from '../context/StorefrontContext';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { CollectionCategory } from '../types/boutique';
import { BoutiqueImage } from './BoutiqueImage';
import { RevealSection } from './RevealSection';

interface SpotlightEditSectionProps {
  onExploreEdit: (category: CollectionCategory) => void;
}

export function SpotlightEditSection({ onExploreEdit }: SpotlightEditSectionProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { content } = useStorefront();
  const { spotlightEdit } = content;

  return (
    <section className="relative overflow-hidden bg-[#49243E] py-16 text-[#FFF9F5] sm:py-24">
      {/* Subtle decorative radial glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-0 h-[420px] w-[420px] rounded-full bg-[#B76E79]/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 -left-16 h-[320px] w-[320px] rounded-full bg-[#F3D5DF]/12 blur-3xl"
      />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-14">
          {/* Oversized Editorial Portrait */}
          <div className="lg:col-span-6">
            <RevealSection>
              <div className="relative mx-auto max-w-[460px] lg:max-w-none">
                {/* Decorative layered rose-gold frame */}
                <motion.div
                  aria-hidden="true"
                  animate={prefersReducedMotion ? undefined : { y: [0, -6, 0] }}
                  transition={
                    prefersReducedMotion
                      ? undefined
                      : { duration: 7, repeat: Infinity, ease: 'easeInOut' }
                  }
                  className="pointer-events-none absolute -top-4 -left-4 right-4 bottom-4 rounded-3xl border border-[#F3D5DF]/30"
                />

                <div className="relative overflow-hidden rounded-3xl border border-[#F3D5DF]/20 bg-[#36192D] shadow-2xl">
                  <div className="aspect-[3/4] w-full overflow-hidden">
                    <BoutiqueImage
                      src={spotlightEdit.image.src}
                      alt={spotlightEdit.image.alt}
                      loading="lazy"
                      fallbackTitle={spotlightEdit.title}
                      className="h-full w-full object-cover object-top"
                    />
                  </div>
                </div>
              </div>
            </RevealSection>
          </div>

          {/* Editorial Copy */}
          <div className="lg:col-span-6">
            <RevealSection delay={0.1}>
              <p className="text-xs font-medium tracking-[0.22em] uppercase text-[#F3D5DF]">
                {spotlightEdit.kicker}
              </p>

              <h2 className="mt-3 font-serif text-4xl font-semibold leading-[1.08] tracking-[0.01em] text-[#FFF9F5] sm:text-5xl lg:text-6xl text-balance">
                {spotlightEdit.title}
              </h2>

              <p className="mt-4 font-serif text-xl italic tracking-[0.01em] text-[#F3D5DF] sm:text-2xl">
                {spotlightEdit.subtitle}
              </p>

              <p className="mt-5 max-w-xl text-base leading-relaxed tracking-[0.01em] text-[#FFF9F5]/85">
                {spotlightEdit.description}
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => onExploreEdit(spotlightEdit.targetCategory)}
                  className="inline-flex min-h-[48px] items-center gap-2.5 rounded-xl bg-[#F3D5DF] px-7 py-3 text-sm font-semibold text-[#49243E] shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#FFF9F5] active:translate-y-0 whitespace-nowrap shrink-0"
                >
                  <span>{spotlightEdit.ctaLabel}</span>
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </RevealSection>
          </div>
        </div>
      </div>
    </section>
  );
}
