import { motion } from 'motion/react';
import { useStorefront } from '../context/StorefrontContext';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { BoutiqueImage } from './BoutiqueImage';
import { RevealSection } from './RevealSection';

export function AboutSection() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { settings, content } = useStorefront();
  const { about } = content;

  return (
    <section
      id="about"
      className="relative overflow-hidden bg-gradient-to-b from-[#FFF9F5] via-[#FBF1F4] to-[#FFF9F5] py-16 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-14">
          <div className="lg:col-span-6">
            <RevealSection>
              <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
                {about.kicker}
              </p>

              <h2 className="mt-3 font-serif text-3xl font-semibold leading-[1.12] tracking-tight text-[#49243E] sm:text-4xl lg:text-5xl text-balance">
                {about.heading}
              </h2>

              <div className="mt-6 space-y-4 text-base leading-relaxed text-[#242124]/80">
                {about.paragraphs.map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </div>

              <div className="mt-8 grid grid-cols-1 gap-5 border-t border-[#49243E]/12 pt-7 sm:grid-cols-3">
                {about.pillars.map((pillar) => (
                  <div key={pillar.title}>
                    <h3 className="font-serif text-lg font-semibold text-[#49243E]">
                      {pillar.title}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-[#242124]/75">
                      {pillar.detail}
                    </p>
                  </div>
                ))}
              </div>
            </RevealSection>
          </div>

          <div className="lg:col-span-6">
            <RevealSection delay={0.1}>
              <div className="relative">
                <motion.div
                  aria-hidden="true"
                  animate={prefersReducedMotion ? undefined : { rotate: [0, 1.2, 0] }}
                  transition={
                    prefersReducedMotion
                      ? undefined
                      : { duration: 9, repeat: Infinity, ease: 'easeInOut' }
                  }
                  className="pointer-events-none absolute -inset-3 rounded-[28px] border border-[#B76E79]/25"
                />

                <div className="relative overflow-hidden rounded-3xl border border-[#49243E]/10 bg-white shadow-[0_24px_54px_-24px_rgba(73,36,62,0.22)]">
                  <div className="aspect-[4/3] w-full overflow-hidden">
                    <BoutiqueImage
                      src={about.image.src}
                      alt={about.image.alt}
                      loading="lazy"
                      fallbackTitle={settings.brandName}
                      className="h-full w-full object-cover"
                    />
                  </div>
                </div>
              </div>
            </RevealSection>
          </div>
        </div>
      </div>
    </section>
  );
}
