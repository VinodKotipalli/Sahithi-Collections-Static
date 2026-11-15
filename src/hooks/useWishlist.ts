import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'sahithi_collections_wishlist_v1';

function readStoredWishlist(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

export function useWishlist() {
  const [wishlistIds, setWishlistIds] = useState<string[]>(() => readStoredWishlist());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wishlistIds));
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }, [wishlistIds]);

  const toggleWishlist = useCallback((productId: string) => {
    setWishlistIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [productId, ...prev]
    );
  }, []);

  const removeFromWishlist = useCallback((productId: string) => {
    setWishlistIds((prev) => prev.filter((id) => id !== productId));
  }, []);

  const clearWishlist = useCallback(() => {
    setWishlistIds([]);
  }, []);

  const isWishlisted = useCallback(
    (productId: string) => wishlistIds.includes(productId),
    [wishlistIds]
  );

  return {
    wishlistIds,
    wishlistCount: wishlistIds.length,
    toggleWishlist,
    removeFromWishlist,
    clearWishlist,
    isWishlisted,
  };
}
