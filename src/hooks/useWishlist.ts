import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult, AuthUser } from '../context/AuthContext';

const STORAGE_KEY = 'sahithi_collections_wishlist_v1';
const OWNER_STORAGE_KEY = 'sahithi_collections_wishlist_owner_v1';

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

function readStoredWishlistOwner(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(OWNER_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function clearWishlistStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(OWNER_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

interface UseWishlistOptions {
  user?: AuthUser | null;
  isLoadingSession?: boolean;
  apiRequest?: <T>(path: string, options?: RequestInit) => Promise<ApiResult<T>>;
}

export function useWishlist(options: UseWishlistOptions = {}) {
  const { user = null, isLoadingSession = false, apiRequest } = options;
  const [wishlistIds, setWishlistIds] = useState<string[]>(() => readStoredWishlist());
  const prevUserIdRef = useRef<string | null>(null);
  const syncedUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoadingSession) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wishlistIds));
      window.localStorage.setItem(OWNER_STORAGE_KEY, user?.id ? user.id : 'guest');
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }, [wishlistIds, user?.id, isLoadingSession]);

  const persistCloudWishlist = useCallback(
    (nextIds: string[]) => {
      if (!user || !apiRequest) return;
      void apiRequest<{ productIds: string[] }>('/api/account/wishlist', {
        method: 'PUT',
        body: JSON.stringify({ productIds: nextIds }),
      });
    },
    [user, apiRequest]
  );

  // Sync cloud wishlist on sign-in and clear private state on logout/account switch
  useEffect(() => {
    if (isLoadingSession) return;
    const currentUserId = user?.id ?? null;
    const prevUserId = prevUserIdRef.current;

    if (prevUserId && !currentUserId) {
      prevUserIdRef.current = null;
      syncedUserIdRef.current = null;
      setWishlistIds([]);
      clearWishlistStorage();
      return;
    }

    if (prevUserId && currentUserId && prevUserId !== currentUserId) {
      syncedUserIdRef.current = null;
      setWishlistIds([]);
      clearWishlistStorage();
    }

    prevUserIdRef.current = currentUserId;
    if (!currentUserId || !apiRequest) return;
    if (syncedUserIdRef.current === currentUserId) return;
    syncedUserIdRef.current = currentUserId;

    let cancelled = false;
    const storedOwner = readStoredWishlistOwner();
    const shouldMergeGuestItems = storedOwner === '' || storedOwner === 'guest';
    const guestLocalIds = shouldMergeGuestItems ? readStoredWishlist() : [];

    void apiRequest<{ productIds?: string[] }>('/api/account/wishlist').then((res) => {
      if (cancelled || !res.ok) return;
      const remoteIds = Array.isArray(res.data.productIds)
        ? res.data.productIds.filter((id): id is string => typeof id === 'string')
        : [];
      const merged = shouldMergeGuestItems
        ? Array.from(new Set([...guestLocalIds, ...remoteIds]))
        : remoteIds;
      setWishlistIds(merged);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        window.localStorage.setItem(OWNER_STORAGE_KEY, currentUserId);
      } catch {
        // Ignore storage error
      }
      if (
        shouldMergeGuestItems &&
        guestLocalIds.some((id) => !remoteIds.includes(id))
      ) {
        void apiRequest<{ productIds: string[] }>('/api/account/wishlist', {
          method: 'PUT',
          body: JSON.stringify({ productIds: merged }),
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [user, isLoadingSession, apiRequest]);

  const toggleWishlist = useCallback(
    (productId: string) => {
      setWishlistIds((prev) => {
        const next = prev.includes(productId)
          ? prev.filter((id) => id !== productId)
          : [productId, ...prev];
        persistCloudWishlist(next);
        return next;
      });
    },
    [persistCloudWishlist]
  );

  const removeFromWishlist = useCallback(
    (productId: string) => {
      setWishlistIds((prev) => {
        const next = prev.filter((id) => id !== productId);
        persistCloudWishlist(next);
        return next;
      });
    },
    [persistCloudWishlist]
  );

  const clearWishlist = useCallback(() => {
    setWishlistIds([]);
    persistCloudWishlist([]);
  }, [persistCloudWishlist]);

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
