import { useCallback, useEffect, useState } from 'react';
import { isWishlistSyncConfigured } from '../config/auth';
import { getSupabaseClient } from '../lib/supabase';

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

export function useWishlist(userId?: string | null) {
  const [wishlistIds, setWishlistIds] = useState<string[]>(() => readStoredWishlist());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wishlistIds));
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }, [wishlistIds]);

  // Optional Supabase wishlist synchronization ONLY when explicitly enabled and signed in
  useEffect(() => {
    if (!userId || !isWishlistSyncConfigured()) return;
    const supabase = getSupabaseClient();
    if (!supabase) return;

    let active = true;
    supabase
      .from('wishlist_items')
      .select('product_id')
      .eq('user_id', userId)
      .then(({ data, error }) => {
        if (!active || error || !Array.isArray(data)) return;
        const remoteIds = data
          .map((row) => row.product_id)
          .filter((id): id is string => typeof id === 'string');
        if (remoteIds.length > 0) {
          setWishlistIds((prev) => Array.from(new Set([...remoteIds, ...prev])));
        }
      });

    return () => {
      active = false;
    };
  }, [userId]);

  const toggleWishlist = useCallback(
    (productId: string) => {
      setWishlistIds((prev) => {
        const exists = prev.includes(productId);
        const next = exists ? prev.filter((id) => id !== productId) : [productId, ...prev];

        if (userId && isWishlistSyncConfigured()) {
          const supabase = getSupabaseClient();
          if (supabase) {
            if (exists) {
              void supabase
                .from('wishlist_items')
                .delete()
                .eq('user_id', userId)
                .eq('product_id', productId);
            } else {
              void supabase
                .from('wishlist_items')
                .upsert({ user_id: userId, product_id: productId });
            }
          }
        }

        return next;
      });
    },
    [userId]
  );

  const removeFromWishlist = useCallback(
    (productId: string) => {
      setWishlistIds((prev) => prev.filter((id) => id !== productId));
      if (userId && isWishlistSyncConfigured()) {
        const supabase = getSupabaseClient();
        if (supabase) {
          void supabase
            .from('wishlist_items')
            .delete()
            .eq('user_id', userId)
            .eq('product_id', productId);
        }
      }
    },
    [userId]
  );

  const clearWishlist = useCallback(() => {
    setWishlistIds([]);
    if (userId && isWishlistSyncConfigured()) {
      const supabase = getSupabaseClient();
      if (supabase) {
        void supabase.from('wishlist_items').delete().eq('user_id', userId);
      }
    }
  }, [userId]);

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
