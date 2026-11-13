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

export function BoutiqueImage({
  src,
  alt,
  className = '',
  loading = 'lazy',
  fetchPriority = 'auto',
  fallbackTitle,
}: BoutiqueImageProps) {
  const [hasError, setHasError] = useState(false);

  if (hasError || !src) {
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
      src={src}
      alt={alt}
      loading={loading}
      decoding={loading === 'eager' ? 'sync' : 'async'}
      fetchPriority={fetchPriority}
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={className}
    />
  );
}
