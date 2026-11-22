import { useCallback, useEffect, useState } from 'react';
import type { BagItem } from '../types/boutique';

const STORAGE_KEY = 'sahithi_shopping_bag_v1';

function readStoredBag(): BagItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BagItem =>
        Boolean(
          item &&
            typeof item === 'object' &&
            typeof item.productId === 'string' &&
            typeof item.variantId === 'string' &&
            typeof item.quantity === 'number' &&
            item.quantity > 0
        )
    );
  } catch {
    return [];
  }
}

export function useShoppingBag() {
  const [bagItems, setBagItems] = useState<BagItem[]>(() => readStoredBag());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bagItems));
    } catch {
      // Ignore storage quota errors
    }
  }, [bagItems]);

  const addItem = useCallback((incoming: Omit<BagItem, 'quantity'> & { quantity?: number }) => {
    const qtyToAdd = Math.max(1, incoming.quantity ?? 1);
    setBagItems((prev) => {
      const idx = prev.findIndex(
        (p) => p.productId === incoming.productId && p.variantId === incoming.variantId
      );
      if (idx === -1) {
        return [...prev, { ...incoming, quantity: qtyToAdd }];
      }
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        quantity: Math.min(50, next[idx].quantity + qtyToAdd),
        seenPricePaise: incoming.seenPricePaise,
        fallbackTitle: incoming.fallbackTitle || next[idx].fallbackTitle,
        fallbackVariant: incoming.fallbackVariant || next[idx].fallbackVariant,
        fallbackColorName: incoming.fallbackColorName || next[idx].fallbackColorName,
        fallbackSize: incoming.fallbackSize || next[idx].fallbackSize,
        fallbackSku: incoming.fallbackSku || next[idx].fallbackSku,
        fallbackImage: incoming.fallbackImage || next[idx].fallbackImage,
      };
      return next;
    });
  }, []);

  const updateItemQty = useCallback((productId: string, variantId: string, quantity: number) => {
    if (quantity <= 0) {
      setBagItems((prev) =>
        prev.filter((i) => !(i.productId === productId && i.variantId === variantId))
      );
      return;
    }
    setBagItems((prev) =>
      prev.map((i) =>
        i.productId === productId && i.variantId === variantId
          ? { ...i, quantity: Math.min(50, quantity) }
          : i
      )
    );
  }, []);

  const removeItem = useCallback((productId: string, variantId: string) => {
    setBagItems((prev) =>
      prev.filter((i) => !(i.productId === productId && i.variantId === variantId))
    );
  }, []);

  const acceptPriceUpdates = useCallback(
    (updates: Array<{ productId: string; variantId: string | null; currentPricePaise: number }>) => {
      setBagItems((prev) =>
        prev.map((item) => {
          const match = updates.find(
            (u) => u.productId === item.productId && u.variantId === item.variantId
          );
          return match ? { ...item, seenPricePaise: match.currentPricePaise } : item;
        })
      );
    },
    []
  );

  const clearBag = useCallback(() => {
    setBagItems([]);
  }, []);

  const bagCount = bagItems.reduce((sum, i) => sum + i.quantity, 0);

  return {
    bagItems,
    bagCount,
    addItem,
    updateItemQty,
    removeItem,
    acceptPriceUpdates,
    clearBag,
  };
}
