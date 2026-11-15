import { Component, lazy, ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownRight } from 'lucide-react';
import { motion, useScroll, useTransform } from 'motion/react';
import { useStorefront } from '../context/StorefrontContext';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { BoutiqueImage } from './BoutiqueImage';
import { HeroRibbonFallback } from './HeroRibbonFallback';

const LazyHeroRibbon3D = lazy(() => import('./HeroRibbon3D'));

function isWebGLSupported(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

class WebGLErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [canRender3D, setCanRender3D] = useState(false);

  useEffect(() => {
    if (!prefersReducedMotion && isWebGLSupported()) {
      setCanRender3D(true);
    } else {
      setCanRender3D(false);
    }
  }, [prefersReducedMotion]);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end start'],
  });

  const imageParallaxY = useTransform(scrollYProgress, [0, 1], [0, 42]);

  const { settings, content } = useStorefront();
  const { hero } = content;

  return (
    <section
      id="home"
      ref={sectionRef}
      className="relative overflow-hidden bg-gradient-to-b from-[#FFF9F5] via-[#FFF6F2] to-[#FFF9F5] pt-20 pb-14 sm:pt-24 sm:pb-20 lg:min-h-[calc(100svh-1rem)] lg:flex lg:items-center lg:pt-24 lg:pb-16"
    >
      {/* Soft ambient blush halo */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-28 right-[-8%] h-[460px] w-[460px] rounded-full bg-[#F3D5DF]/45 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-[-6%] h-[360px] w-[360px] rounded-full bg-[#F3D5DF]/25 blur-3xl"
      />

      <div className="relative mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-12">
          {/* Editorial Copy Column */}
          <div className="lg:col-span-6 relative z-10">
            <motion.p
              initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]"
            >
              {hero.eyebrow} <span aria-hidden="true">·</span> {settings.tagline}
            </motion.p>

            <motion.h1
              initial={prefersReducedMotion ? false : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.58, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="mt-4 font-serif text-[clamp(2.5rem,5.2vw,4.35rem)] font-semibold leading-[1.06] tracking-tight text-[#49243E] text-balance"
            >
              {hero.headline}
            </motion.h1>

            <motion.p
              initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="mt-5 max-w-xl text-base leading-relaxed text-[#242124]/80 sm:text-lg"
            >
              {hero.supportingText}
            </motion.p>

            <motion.div
              initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.52, delay: 0.24, ease: [0.16, 1, 0.3, 1] }}
              className="mt-8 flex flex-wrap items-center gap-3.5 sm:gap-4"
            >
              <a
                href="#collections"
                className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-6 py-3 text-sm font-medium text-[#FFF9F5] shadow-[0_12px_28px_-10px_rgba(73,36,62,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#3A1B31] active:translate-y-0 whitespace-nowrap shrink-0"
              >
                <span>{hero.primaryCta}</span>
                <ArrowDownRight className="h-4 w-4" aria-hidden="true" />
              </a>

              <a
                href="#new-arrivals"
                className="inline-flex min-h-[46px] items-center justify-center rounded-xl border border-[#49243E]/25 bg-[#FFF9F5]/80 px-6 py-3 text-sm font-medium text-[#49243E] transition-all duration-200 hover:border-[#49243E]/50 hover:bg-[#F3D5DF]/35 whitespace-nowrap shrink-0"
              >
                {hero.secondaryCta}
              </a>
            </motion.div>

            {/* Editorial Floating Style Notes */}
            <motion.div
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.55, delay: 0.32 }}
              className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[#49243E]/10 pt-5 text-xs tracking-wide text-[#49243E]/75"
            >
              <span>{hero.floatingLabels[0]}</span>
              <span aria-hidden="true" className="text-[#B76E79]">
                ·
              </span>
              <span>{hero.floatingLabels[1]}</span>
              <span aria-hidden="true" className="text-[#B76E79]">
                ·
              </span>
              <span>Ethnic &amp; Contemporary Silhouettes</span>
            </motion.div>
          </div>

          {/* Editorial Photography + Decorative 3D Ribbon Column */}
          <div className="lg:col-span-6 relative">
            <div className="relative mx-auto max-w-[460px] lg:max-w-[520px]">
              {/* Isolated Decorative 3D Scene positioned behind & framing the editorial arch */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -top-10 -right-10 -bottom-6 -left-10 z-0 opacity-90 sm:-top-12 sm:-right-14"
              >
                {canRender3D ? (
                  <WebGLErrorBoundary fallback={<HeroRibbonFallback className="h-full w-full" />}>
                    <Suspense fallback={<HeroRibbonFallback className="h-full w-full" />}>
                      <LazyHeroRibbon3D />
                    </Suspense>
                  </WebGLErrorBoundary>
                ) : (
                  <HeroRibbonFallback className="h-full w-full" />
                )}
              </div>

              {/* Primary Hero Editorial Image */}
              <motion.div
                style={prefersReducedMotion ? undefined : { y: imageParallaxY }}
                className="relative z-10 overflow-hidden rounded-t-[160px] rounded-b-[28px] border border-[#49243E]/10 bg-[#F3D5DF]/20 shadow-[0_28px_60px_-24px_rgba(73,36,62,0.28)]"
              >
                <div className="aspect-[3/4] w-full overflow-hidden">
                  <BoutiqueImage
                    src={hero.mainImage.src}
                    alt={hero.mainImage.alt}
                    loading="eager"
                    fetchPriority="high"
                    fallbackTitle={settings.brandName}
                    className="h-full w-full object-cover object-top"
                  />
                </div>
              </motion.div>

              {/* Layered Product Cutout Card */}
              {hero.accentCutouts[0] && (
                <motion.div
                  animate={prefersReducedMotion ? undefined : { y: [0, -7, 0] }}
                  transition={
                    prefersReducedMotion
                      ? undefined
                      : { duration: 6, repeat: Infinity, ease: 'easeInOut' }
                  }
                  className="relative z-20 -mt-14 ml-4 w-44 overflow-hidden rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5] p-2 shadow-[0_18px_40px_-14px_rgba(73,36,62,0.24)] sm:absolute sm:-bottom-6 sm:-left-8 sm:mt-0 sm:w-48"
                >
                  <div className="aspect-[4/3] overflow-hidden rounded-xl bg-[#F3D5DF]/25">
                    <BoutiqueImage
                      src={hero.accentCutouts[0].src}
                      alt={hero.accentCutouts[0].alt}
                      loading="eager"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <p className="mt-2 px-1 pb-0.5 text-[11px] font-medium tracking-wide text-[#49243E]">
                    {hero.accentCutouts[0].caption}
                  </p>
                </motion.div>
              )}

              {/* Secondary Layered Editorial Note Card (desktop/tablet) */}
              <motion.div
                animate={prefersReducedMotion ? undefined : { y: [0, 6, 0] }}
                transition={
                  prefersReducedMotion
                    ? undefined
                    : { duration: 7, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }
                }
                className="hidden sm:flex absolute top-10 -right-5 z-20 flex-col rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5]/95 px-4 py-3 shadow-[0_16px_32px_-12px_rgba(73,36,62,0.2)]"
              >
                <span className="font-serif text-base font-semibold text-[#49243E]">
                  {hero.floatingLabels[0]}
                </span>
                <span className="mt-0.5 text-[11px] text-[#242124]/70">
                  {hero.floatingLabels[1]}
                </span>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
