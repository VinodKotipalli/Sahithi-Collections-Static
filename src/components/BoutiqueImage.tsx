import { useState } from 'react';
import { Sparkles } from 'lucide-react';

interface BoutiqueImageProps {
  src: string;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
  fallbackTitle?: string;
}

const FALLBACK_MEDIA_URLS = [
  '/boutique-media/sc_wa0026_royal_blue.jpg',
  '/boutique-media/sc_wa0004_pink_floral.jpg',
  '/boutique-media/sc_wa0033_coral_lehenga.jpg',
  '/boutique-media/sc_wa0019_teal_bandhani.jpg',
  '/boutique-media/sc_wa0027_purple_kurta.jpg',
  '/boutique-media/sc_wa0028_mustard_flared.jpg',
  '/boutique-media/sc_wa0032_blue_floral.jpg',
];

export function BoutiqueImage({
  src,
  alt,
  className = '',
  loading = 'lazy',
  fetchPriority = 'auto',
  fallbackTitle,
}: BoutiqueImageProps) {
  const [currentSrcIndex, setCurrentSrcIndex] = useState(0);
  const [hasExhaustedFallbacks, setHasExhaustedFallbacks] = useState(false);

  const activeSrc = !src
    ? FALLBACK_MEDIA_URLS[0]
    : currentSrcIndex === 0
      ? src
      : FALLBACK_MEDIA_URLS[(currentSrcIndex - 1) % FALLBACK_MEDIA_URLS.length];

  const handleImageError = () => {
    if (currentSrcIndex < FALLBACK_MEDIA_URLS.length) {
      setCurrentSrcIndex((prev) => prev + 1);
    } else {
      setHasExhaustedFallbacks(true);
    }
  };

  if (hasExhaustedFallbacks) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#F3D5DF]/55 via-[#FFF9F5] to-[#E9D7DE] p-6 text-center text-[#49243E] ${className}`}
      >
        <Sparkles className="mb-2 h-6 w-6 text-[#B76E79]" aria-hidden="true" />
        <span className="font-serif text-base font-medium tracking-wide">
          {fallbackTitle || 'Sahithi Collections'}
        </span>
      </div>
    );
  }

  return (
    <img
      key={activeSrc}
      src={activeSrc}
      alt={alt}
      loading={loading}
      decoding={loading === 'eager' ? 'sync' : 'async'}
      fetchPriority={fetchPriority}
      referrerPolicy="no-referrer"
      onError={handleImageError}
      className={className}
    />
  );
}
