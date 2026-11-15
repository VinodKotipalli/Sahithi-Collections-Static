import { fetchApi } from '../services/apiTransport';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { COLLECTIONS } from '../config/collections';
import { LOOKBOOK_ENTRIES } from '../config/lookbook';
import { SITE_CONFIG } from '../config/site';
import { handleClientlessApiRequest } from '../services/firebaseClientApi';
import type { SiteSettings, StorefrontCategory, StorefrontContent } from '../types/boutique';

export const FALLBACK_CATEGORIES: StorefrontCategory[] = COLLECTIONS.map((c, idx) => ({
  id: c.id,
  name: c.category,
  slug: c.id,
  subtitle: c.subtitle,
  imageUrl: c.image,
  altText: c.alt,
  position: idx,
}));

export const FALLBACK_SITE_SETTINGS: SiteSettings = {
  brandName: SITE_CONFIG.brandName,
  tagline: SITE_CONFIG.tagline,
  logoUrl: '',
  contact: {
    whatsappNumber: SITE_CONFIG.contact.whatsappNumber,
    instagramHandle: SITE_CONFIG.contact.instagramHandle,
    email: SITE_CONFIG.contact.email,
    storeAddress: SITE_CONFIG.contact.storeAddress,
    hoursNote: 'Mon – Sat · 10:30 AM – 8:00 PM IST',
  },
  socialLinks: {
    instagramUrl: '',
    facebookUrl: '',
    pinterestUrl: '',
    youtubeUrl: '',
  },
};

export const FALLBACK_STOREFRONT_CONTENT: StorefrontContent = {
  hero: {
    eyebrow: SITE_CONFIG.hero.eyebrow,
    headline: SITE_CONFIG.hero.headline,
    supportingText: SITE_CONFIG.hero.supportingText,
    primaryCta: SITE_CONFIG.hero.primaryCta,
    secondaryCta: SITE_CONFIG.hero.secondaryCta,
    floatingLabels: [SITE_CONFIG.hero.floatingLabels[0], SITE_CONFIG.hero.floatingLabels[1]],
    mainImage: { ...SITE_CONFIG.hero.mainImage },
    accentCutouts: SITE_CONFIG.hero.accentCutouts.map((c) => ({ ...c })),
  },
  collectionsHeader: {
    kicker: 'Curated Worlds',
    heading: 'Shop by Collection',
    subtitle:
      'Select a silhouette story to filter the showcase and discover pieces tailored for your occasion.',
  },
  showcaseHeader: {
    kicker: 'New Arrivals & Signature Pieces',
    heading: 'The Boutique Showcase',
    subtitle:
      'Browse curated styles with live pricing and availability in INR. Tap any piece for color options, sizing, and bag or boutique enquiry.',
  },
  spotlightEdit: {
    kicker: SITE_CONFIG.spotlightEdit.kicker,
    title: SITE_CONFIG.spotlightEdit.title,
    subtitle: SITE_CONFIG.spotlightEdit.subtitle,
    description: SITE_CONFIG.spotlightEdit.description,
    ctaLabel: SITE_CONFIG.spotlightEdit.ctaLabel,
    targetCategory: SITE_CONFIG.spotlightEdit.targetCategory,
    image: { ...SITE_CONFIG.spotlightEdit.image },
  },
  lookbookHeader: {
    kicker: 'Editorial Journal',
    heading: 'The Style Lookbook',
    subtitle: 'Tap any frame to view full-resolution styling notes in our editorial lightbox.',
  },
  lookbookEntries: LOOKBOOK_ENTRIES.map((e) => ({ ...e })),
  about: {
    kicker: SITE_CONFIG.about.kicker,
    heading: SITE_CONFIG.about.heading,
    paragraphs: [...SITE_CONFIG.about.paragraphs],
    pillars: SITE_CONFIG.about.pillars.map((p) => ({ ...p })),
    image: { ...SITE_CONFIG.about.image },
  },
};

interface StorefrontContextValue {
  settings: SiteSettings;
  content: StorefrontContent;
  categories: StorefrontCategory[];
  isLoadingStorefront: boolean;
  refreshStorefront: () => Promise<void>;
}

const StorefrontContext = createContext<StorefrontContextValue | null>(null);

export function StorefrontProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SiteSettings>(FALLBACK_SITE_SETTINGS);
  const [content, setContent] = useState<StorefrontContent>(FALLBACK_STOREFRONT_CONTENT);
  const [categories, setCategories] = useState<StorefrontCategory[]>(FALLBACK_CATEGORIES);
  const [isLoadingStorefront, setIsLoadingStorefront] = useState(true);

  const refreshStorefront = useCallback(async () => {
    try {
      const res = await fetchApi('/api/storefront', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'X-Sahithi-Client': 'web-spa' },
      });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && contentType.includes('application/json')) {
        const data = (await res.json()) as {
          settings?: SiteSettings;
          content?: StorefrontContent;
          categories?: StorefrontCategory[];
        };
        if (data.settings) setSettings(data.settings);
        if (data.content) setContent(data.content);
        if (Array.isArray(data.categories)) {
          setCategories(data.categories);
        }
        return;
      }
      const fallback = await handleClientlessApiRequest<{
        settings?: SiteSettings;
        content?: StorefrontContent;
        categories?: StorefrontCategory[];
      }>('/api/storefront', 'GET');
      if (fallback.ok) {
        if (fallback.data.settings) setSettings(fallback.data.settings);
        if (fallback.data.content) setContent(fallback.data.content);
        if (Array.isArray(fallback.data.categories)) {
          setCategories(fallback.data.categories);
        }
      }
    } catch {
      // Preserve fallback or current storefront state on transient network failure
    } finally {
      setIsLoadingStorefront(false);
    }
  }, []);

  useEffect(() => {
    void refreshStorefront();
  }, [refreshStorefront]);

  return (
    <StorefrontContext.Provider
      value={{
        settings,
        content,
        categories,
        isLoadingStorefront,
        refreshStorefront,
      }}
    >
      {children}
    </StorefrontContext.Provider>
  );
}

export function useStorefront(): StorefrontContextValue {
  const ctx = useContext(StorefrontContext);
  if (!ctx) {
    throw new Error('useStorefront must be used inside <StorefrontProvider>.');
  }
  return ctx;
}
