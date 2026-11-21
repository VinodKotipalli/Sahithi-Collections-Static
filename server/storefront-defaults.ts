export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  subtitle: string;
  image_url: string;
  alt_text: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface SiteSettingsData {
  brandName: string;
  tagline: string;
  logoUrl: string;
  contact: {
    whatsappNumber: string;
    instagramHandle: string;
    email: string;
    storeAddress: string;
    hoursNote: string;
  };
  socialLinks: {
    instagramUrl: string;
    facebookUrl: string;
    pinterestUrl: string;
    youtubeUrl: string;
  };
  catalogControl?: {
    suppressLegacySeed?: boolean;
    activeCatalogBatch?: string | null;
    activeBackupId?: string | null;
  };
}

export interface LookbookContentItem {
  id: string;
  title: string;
  caption: string;
  category: string;
  image: string;
  alt: string;
  layout: 'tall' | 'wide' | 'square';
}

export interface StorefrontContentData {
  hero: {
    eyebrow: string;
    headline: string;
    supportingText: string;
    primaryCta: string;
    secondaryCta: string;
    floatingLabels: [string, string];
    mainImage: {
      src: string;
      alt: string;
    };
    accentCutouts: Array<{
      src: string;
      alt: string;
      caption: string;
    }>;
  };
  collectionsHeader: {
    kicker: string;
    heading: string;
    subtitle: string;
  };
  showcaseHeader: {
    kicker: string;
    heading: string;
    subtitle: string;
  };
  spotlightEdit: {
    kicker: string;
    title: string;
    subtitle: string;
    description: string;
    ctaLabel: string;
    targetCategory: string;
    image: {
      src: string;
      alt: string;
    };
  };
  lookbookHeader: {
    kicker: string;
    heading: string;
    subtitle: string;
  };
  lookbookEntries: LookbookContentItem[];
  about: {
    kicker: string;
    heading: string;
    paragraphs: string[];
    pillars: Array<{
      title: string;
      detail: string;
    }>;
    image: {
      src: string;
      alt: string;
    };
  };
}

export type ContactMessageStatus = 'unread' | 'read' | 'replied' | 'archived';

export interface ContactMessageRow {
  id: string;
  sender_name: string;
  sender_email: string;
  sender_phone: string;
  subject: string;
  message: string;
  status: ContactMessageStatus;
  admin_note: string;
  created_at: number;
  updated_at: number;
}

export interface SeedCategoryDef {
  id: string;
  name: string;
  slug: string;
  subtitle: string;
  imageUrl: string;
  altText: string;
  position: number;
}

export const INITIAL_SEED_CATEGORIES: SeedCategoryDef[] = [
  {
    id: 'festive-collection',
    name: 'Festive Collection',
    slug: 'festive-collection',
    subtitle: 'Zari-bordered gowns, shimmer tissue sets & celebratory shararas',
    imageUrl: '/boutique-media/sc_wa0026_royal_blue.jpg',
    altText: 'Young woman wearing a royal blue checkered flared gown with antique gold zari border',
    position: 0,
  },
  {
    id: 'dresses',
    name: 'Dresses',
    slug: 'dresses',
    subtitle: 'Floral puff-sleeve organzas, gingham midis & sunlit tiered silhouettes',
    imageUrl: '/boutique-media/sc_wa0004_pink_floral.jpg',
    altText: 'Young woman wearing a rose-pink sheer floral organza puff-sleeve flared dress',
    position: 1,
  },
  {
    id: 'kurta-sets',
    name: 'Kurta Sets',
    slug: 'kurta-sets',
    subtitle: 'Schiffli embroidered kurtas, woven checks & graceful dupatta sets',
    imageUrl: '/boutique-media/sc_wa0027_purple_kurta.jpg',
    altText: 'Young woman wearing a lavender-purple schiffli cutwork kurta set with sequined dupatta',
    position: 2,
  },
  {
    id: 'ethnic-wear',
    name: 'Ethnic Wear',
    slug: 'ethnic-wear',
    subtitle: 'Flowing Bandhani anarkalis, pleated ethnic dresses & heritage drapes',
    imageUrl: '/boutique-media/sc_wa0019_teal_bandhani.jpg',
    altText: 'Young woman wearing a deep peacock-teal Bandhani flared georgette Anarkali gown',
    position: 3,
  },
  {
    id: 'co-ord-sets',
    name: 'Co-ord Sets',
    slug: 'co-ord-sets',
    subtitle: 'Brocade-trimmed peplum sets, pleated tunics & watercolor floral kaftans',
    imageUrl: '/boutique-media/sc_wa0028_mustard_flared.jpg',
    altText: 'Young woman wearing a mustard flared peplum top and wide-leg pants with brocade border',
    position: 4,
  },
  {
    id: 'lehengas',
    name: 'Lehengas',
    slug: 'lehengas',
    subtitle: 'Heritage Kalamkari illustrated borders & handcrafted festive skirts',
    imageUrl: '/boutique-media/sc_wa0033_coral_lehenga.jpg',
    altText: 'Young woman wearing a coral-pink silk lehenga with illustrated heritage Kalamkari border',
    position: 5,
  },
  {
    id: 'kurtis',
    name: 'Kurtis',
    slug: 'kurtis',
    subtitle: 'Breathable handloom cottons & minimalist motif sets for everyday ease',
    imageUrl: '/boutique-media/sc_wa0023_grey_motif.jpg',
    altText: 'Young woman wearing a charcoal-grey geometric motif handloom cotton kurta set',
    position: 6,
  },
];

export const DEFAULT_SITE_SETTINGS: SiteSettingsData = {
  brandName: 'Sahithi Collections',
  tagline: 'Style That Celebrates You.',
  logoUrl: '',
  contact: {
    whatsappNumber: '918520899337',
    instagramHandle: '',
    email: 'saivinodkotipalli2003@gmail.com',
    storeAddress: '',
    hoursNote: 'Mon – Sat · 10:30 AM – 8:00 PM IST',
  },
  socialLinks: {
    instagramUrl: '',
    facebookUrl: '',
    pinterestUrl: '',
    youtubeUrl: '',
  },
};

export const DEFAULT_STOREFRONT_CONTENT: StorefrontContentData = {
  hero: {
    eyebrow: 'New Boutique Collection',
    headline: 'Discover Your Everyday Elegance.',
    supportingText:
      'Explore sunlit floral organzas, handloom kurta sets, and festive zari-bordered silhouettes curated exclusively at Sahithi Collections.',
    primaryCta: 'Explore Collections',
    secondaryCta: 'Shop All 32 Styles',
    floatingLabels: ['32 Fresh Arrivals', 'Made for Your Moments'],
    mainImage: {
      src: '/boutique-media/sc_wa0026_royal_blue.jpg',
      alt: 'Young woman wearing a royal blue checkered flared gown with wide antique gold zari border in a sunlit courtyard',
    },
    accentCutouts: [
      {
        src: '/boutique-media/sc_wa0004_pink_floral.jpg',
        alt: 'Young woman wearing a rose-pink floral organza puff-sleeve flared dress',
        caption: 'Floral Organzas',
      },
      {
        src: '/boutique-media/sc_wa0020_pink_sharara.jpg',
        alt: 'Young woman wearing a festive lotus-pink sharara set with orange-gold zari borders',
        caption: 'Festive Shararas',
      },
    ],
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
      'Browse all 32 curated outfits with live INR pricing and sizing. Tap any piece for fabric notes, zoom view, and instant bag or boutique enquiry.',
  },
  spotlightEdit: {
    kicker: 'Featured Capsule',
    title: 'The Festive Spotlight',
    subtitle: 'Illustrated heritage borders, luminous organza, and effortless poise.',
    description:
      'From our coral-pink Kalamkari lehenga and lotus-pink zari-bordered sharara to shimmering tissue kurta sets, discover statement pieces designed to celebrate every joyous occasion in comfort and grace.',
    ctaLabel: 'Explore Festive Styles',
    targetCategory: 'Festive Collection',
    image: {
      src: '/boutique-media/sc_wa0033_coral_lehenga.jpg',
      alt: 'Young woman wearing a coral-pink festive silk lehenga with illustrated Kalamkari border and matching dupatta',
    },
  },
  lookbookHeader: {
    kicker: 'Editorial Journal',
    heading: 'The Style Lookbook',
    subtitle: 'Tap any frame to view full-resolution styling notes in our editorial lightbox.',
  },
  lookbookEntries: [
    {
      id: 'lb-01',
      title: 'Royal Zari Grace',
      caption: 'Pleated royal-blue silk-check gown framed with a wide antique gold temple border.',
      category: 'Festive Collection',
      image: '/boutique-media/sc_wa0026_royal_blue.jpg',
      alt: 'Young woman in a royal blue flared gown with gold zari border under sandstone arches',
      layout: 'tall',
    },
    {
      id: 'lb-02',
      title: 'Kalamkari Heritage',
      caption: 'Vibrant coral-pink festive lehenga finished with an ornate illustrated dancing-figure border.',
      category: 'Lehengas',
      image: '/boutique-media/sc_wa0033_coral_lehenga.jpg',
      alt: 'Young woman in a coral-pink Kalamkari illustrated lehenga and dupatta',
      layout: 'tall',
    },
    {
      id: 'lb-03',
      title: 'Dreamy Watercolor Organza',
      caption: 'Sky-blue floral sheer organza maxi dress with romantic puff sleeves and ruffled hem.',
      category: 'Dresses',
      image: '/boutique-media/sc_wa0032_blue_floral.jpg',
      alt: 'Young woman wearing a sky-blue watercolor floral puff-sleeve organza maxi dress',
      layout: 'square',
    },
    {
      id: 'lb-04',
      title: 'Iridescent Mauve Shimmer',
      caption: 'Tissue shimmer kurta and flared palazzo set detailed with delicate pearl-tassel trims.',
      category: 'Festive Collection',
      image: '/boutique-media/sc_wa0012_mauve_shimmer.jpg',
      alt: 'Young woman wearing an iridescent mauve tissue shimmer kurta and palazzo set',
      layout: 'wide',
    },
    {
      id: 'lb-05',
      title: 'Sunlit Bandhani Flare',
      caption: 'Deep peacock-teal Bandhani print georgette Anarkali crafted for effortless twirls.',
      category: 'Ethnic Wear',
      image: '/boutique-media/sc_wa0019_teal_bandhani.jpg',
      alt: 'Young woman in a deep teal Bandhani floor-length Anarkali gown',
      layout: 'square',
    },
    {
      id: 'lb-06',
      title: 'Brocade Mustard Ease',
      caption: 'Flared ochre-mustard peplum top and wide-leg sharara accented with antique woven borders.',
      category: 'Co-ord Sets',
      image: '/boutique-media/sc_wa0028_mustard_flared.jpg',
      alt: 'Young woman wearing a mustard flared peplum top and wide-leg pants with brocade border',
      layout: 'square',
    },
  ],
  about: {
    kicker: 'Our Philosophy',
    heading: 'A Little Style. A Lot of Confidence.',
    paragraphs: [
      'Sahithi Collections brings together thoughtful silhouettes for girls and young women who love dressing with quiet grace and personal flair. From airy cotton gingham dresses and schiffli kurta sets for sunny afternoons to celebratory anarkalis and lehengas, every piece is chosen to feel effortless the moment you slip it on.',
      'We believe great style does not have to shout. Soft palettes, flattering cuts, and considered textile details help you celebrate both everyday moments and cherished occasions in your own natural rhythm.',
    ],
    pillars: [
      {
        title: 'Everyday Ease',
        detail: 'Breathable cottons, handloom weaves, and fluid tailoring built for all-day movement.',
      },
      {
        title: 'Occasion Ready',
        detail: 'Zari borders, Kalamkari artistry, and sheer organza textures curated for memorable gatherings.',
      },
      {
        title: 'Signature Silhouettes',
        detail: 'Puff-sleeve midis, flared anarkalis, and wide-leg sets crafted to flatter naturally.',
      },
    ],
    image: {
      src: '/boutique-media/sc_wa0003_ivory_mauve.jpg',
      alt: 'Young woman wearing a warm ivory flared ethnic dress paired with a flowing mauve organza dupatta',
    },
  },
};

function pickTrimmedString(val: unknown, fallback: string, maxLen = 5000): string {
  return typeof val === 'string' ? val.trim().slice(0, maxLen) : fallback;
}

function pickRequiredMediaUrl(val: unknown, fallback: string): string {
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim();
  }
  return fallback;
}

export function mergeSiteSettings(partial?: Partial<SiteSettingsData> | null): SiteSettingsData {
  if (!partial || typeof partial !== 'object') {
    return structuredClone(DEFAULT_SITE_SETTINGS);
  }
  return {
    brandName:
      typeof partial.brandName === 'string'
        ? partial.brandName.trim()
        : DEFAULT_SITE_SETTINGS.brandName,
    tagline:
      typeof partial.tagline === 'string'
        ? partial.tagline.trim()
        : DEFAULT_SITE_SETTINGS.tagline,
    logoUrl: typeof partial.logoUrl === 'string' ? partial.logoUrl.trim() : '',
    contact: {
      whatsappNumber:
        typeof partial.contact?.whatsappNumber === 'string'
          ? partial.contact.whatsappNumber.trim()
          : DEFAULT_SITE_SETTINGS.contact.whatsappNumber,
      instagramHandle:
        typeof partial.contact?.instagramHandle === 'string'
          ? partial.contact.instagramHandle.trim()
          : DEFAULT_SITE_SETTINGS.contact.instagramHandle,
      email:
        typeof partial.contact?.email === 'string'
          ? partial.contact.email.trim()
          : DEFAULT_SITE_SETTINGS.contact.email,
      storeAddress:
        typeof partial.contact?.storeAddress === 'string'
          ? partial.contact.storeAddress.trim()
          : DEFAULT_SITE_SETTINGS.contact.storeAddress,
      hoursNote:
        typeof partial.contact?.hoursNote === 'string'
          ? partial.contact.hoursNote.trim()
          : DEFAULT_SITE_SETTINGS.contact.hoursNote,
    },
    socialLinks: {
      instagramUrl:
        typeof partial.socialLinks?.instagramUrl === 'string'
          ? partial.socialLinks.instagramUrl.trim()
          : '',
      facebookUrl:
        typeof partial.socialLinks?.facebookUrl === 'string'
          ? partial.socialLinks.facebookUrl.trim()
          : '',
      pinterestUrl:
        typeof partial.socialLinks?.pinterestUrl === 'string'
          ? partial.socialLinks.pinterestUrl.trim()
          : '',
      youtubeUrl:
        typeof partial.socialLinks?.youtubeUrl === 'string'
          ? partial.socialLinks.youtubeUrl.trim()
          : '',
    },
    ...(partial.catalogControl && typeof partial.catalogControl === 'object'
      ? {
          catalogControl: {
            suppressLegacySeed: Boolean(partial.catalogControl.suppressLegacySeed),
            activeCatalogBatch:
              typeof partial.catalogControl.activeCatalogBatch === 'string'
                ? partial.catalogControl.activeCatalogBatch.trim().slice(0, 80)
                : null,
            activeBackupId:
              typeof partial.catalogControl.activeBackupId === 'string'
                ? partial.catalogControl.activeBackupId.trim().slice(0, 80)
                : null,
          },
        }
      : {}),
  };
}

export function mergeStorefrontContent(
  partial?: Partial<StorefrontContentData> | null
): StorefrontContentData {
  const def = structuredClone(DEFAULT_STOREFRONT_CONTENT);
  if (!partial || typeof partial !== 'object') {
    return def;
  }

  return {
    hero: {
      eyebrow: pickTrimmedString(partial.hero?.eyebrow, def.hero.eyebrow, 160),
      headline: pickTrimmedString(partial.hero?.headline, def.hero.headline, 240),
      supportingText: pickTrimmedString(
        partial.hero?.supportingText,
        def.hero.supportingText,
        600
      ),
      primaryCta: pickTrimmedString(partial.hero?.primaryCta, def.hero.primaryCta, 80),
      secondaryCta: pickTrimmedString(partial.hero?.secondaryCta, def.hero.secondaryCta, 80),
      floatingLabels: [
        pickTrimmedString(partial.hero?.floatingLabels?.[0], def.hero.floatingLabels[0], 80),
        pickTrimmedString(partial.hero?.floatingLabels?.[1], def.hero.floatingLabels[1], 80),
      ],
      mainImage: {
        src: pickRequiredMediaUrl(partial.hero?.mainImage?.src, def.hero.mainImage.src),
        alt: pickTrimmedString(partial.hero?.mainImage?.alt, def.hero.mainImage.alt, 240),
      },
      accentCutouts: Array.isArray(partial.hero?.accentCutouts)
        ? partial.hero.accentCutouts.map((c, idx) => ({
            src: pickRequiredMediaUrl(
              c?.src,
              def.hero.accentCutouts[idx]?.src || def.hero.accentCutouts[0].src
            ),
            alt: pickTrimmedString(
              c?.alt,
              def.hero.accentCutouts[idx]?.alt || def.hero.accentCutouts[0].alt,
              240
            ),
            caption: pickTrimmedString(
              c?.caption,
              def.hero.accentCutouts[idx]?.caption || def.hero.accentCutouts[0].caption,
              120
            ),
          }))
        : def.hero.accentCutouts,
    },
    collectionsHeader: {
      kicker: pickTrimmedString(partial.collectionsHeader?.kicker, def.collectionsHeader.kicker, 120),
      heading: pickTrimmedString(
        partial.collectionsHeader?.heading,
        def.collectionsHeader.heading,
        160
      ),
      subtitle: pickTrimmedString(
        partial.collectionsHeader?.subtitle,
        def.collectionsHeader.subtitle,
        400
      ),
    },
    showcaseHeader: {
      kicker: pickTrimmedString(partial.showcaseHeader?.kicker, def.showcaseHeader.kicker, 120),
      heading: pickTrimmedString(partial.showcaseHeader?.heading, def.showcaseHeader.heading, 160),
      subtitle: pickTrimmedString(
        partial.showcaseHeader?.subtitle,
        def.showcaseHeader.subtitle,
        400
      ),
    },
    spotlightEdit: {
      kicker: pickTrimmedString(partial.spotlightEdit?.kicker, def.spotlightEdit.kicker, 120),
      title: pickTrimmedString(partial.spotlightEdit?.title, def.spotlightEdit.title, 160),
      subtitle: pickTrimmedString(partial.spotlightEdit?.subtitle, def.spotlightEdit.subtitle, 240),
      description: pickTrimmedString(
        partial.spotlightEdit?.description,
        def.spotlightEdit.description,
        1000
      ),
      ctaLabel: pickTrimmedString(partial.spotlightEdit?.ctaLabel, def.spotlightEdit.ctaLabel, 80),
      targetCategory: pickTrimmedString(
        partial.spotlightEdit?.targetCategory,
        def.spotlightEdit.targetCategory,
        80
      ),
      image: {
        src: pickRequiredMediaUrl(
          partial.spotlightEdit?.image?.src,
          def.spotlightEdit.image.src
        ),
        alt: pickTrimmedString(
          partial.spotlightEdit?.image?.alt,
          def.spotlightEdit.image.alt,
          240
        ),
      },
    },
    lookbookHeader: {
      kicker: pickTrimmedString(partial.lookbookHeader?.kicker, def.lookbookHeader.kicker, 120),
      heading: pickTrimmedString(partial.lookbookHeader?.heading, def.lookbookHeader.heading, 160),
      subtitle: pickTrimmedString(
        partial.lookbookHeader?.subtitle,
        def.lookbookHeader.subtitle,
        400
      ),
    },
    lookbookEntries: Array.isArray(partial.lookbookEntries)
      ? partial.lookbookEntries.map((item, idx) => ({
          id:
            typeof item?.id === 'string' && item.id.trim()
              ? item.id.trim().slice(0, 64)
              : `lb-${idx + 1}`,
          title: pickTrimmedString(
            item?.title,
            def.lookbookEntries[idx]?.title || 'Editorial Frame',
            120
          ),
          caption: pickTrimmedString(
            item?.caption,
            def.lookbookEntries[idx]?.caption || '',
            400
          ),
          category: pickTrimmedString(
            item?.category,
            def.lookbookEntries[idx]?.category || 'Dresses',
            80
          ),
          image: pickRequiredMediaUrl(
            item?.image,
            def.lookbookEntries[idx]?.image || def.lookbookEntries[0].image
          ),
          alt: pickTrimmedString(
            item?.alt,
            typeof item?.title === 'string' && item.title.trim()
              ? item.title.trim()
              : 'Boutique lookbook photograph',
            240
          ),
          layout:
            item?.layout === 'tall' || item?.layout === 'wide' || item?.layout === 'square'
              ? item.layout
              : def.lookbookEntries[idx]?.layout || 'square',
        }))
      : def.lookbookEntries,
    about: {
      kicker: pickTrimmedString(partial.about?.kicker, def.about.kicker, 120),
      heading: pickTrimmedString(partial.about?.heading, def.about.heading, 180),
      paragraphs: Array.isArray(partial.about?.paragraphs)
        ? partial.about.paragraphs.map((p) => (typeof p === 'string' ? p.trim().slice(0, 2000) : ''))
        : def.about.paragraphs,
      pillars: Array.isArray(partial.about?.pillars)
        ? partial.about.pillars.map((p, idx) => ({
            title: pickTrimmedString(
              p?.title,
              def.about.pillars[idx]?.title || '',
              100
            ),
            detail: pickTrimmedString(
              p?.detail,
              def.about.pillars[idx]?.detail || '',
              320
            ),
          }))
        : def.about.pillars,
      image: {
        src: pickRequiredMediaUrl(partial.about?.image?.src, def.about.image.src),
        alt: pickTrimmedString(partial.about?.image?.alt, def.about.image.alt, 240),
      },
    },
  };
}

export function extractReferencedMediaFilenames(
  settings: SiteSettingsData,
  content: StorefrontContentData
): Set<string> {
  const filenames = new Set<string>();
  const candidates = [
    settings.logoUrl,
    content.hero.mainImage.src,
    ...content.hero.accentCutouts.map((c) => c.src),
    content.spotlightEdit.image.src,
    content.about.image.src,
    ...content.lookbookEntries.map((e) => e.image),
  ];
  for (const url of candidates) {
    const clean = typeof url === 'string' ? url.trim() : '';
    if (clean.startsWith('/api/media/')) {
      filenames.add(clean.slice('/api/media/'.length));
    }
  }
  return filenames;
}

export interface LoyaltyConfigData {
  rewardsEnabled: boolean;
  pointsPerHundredInr: number;
  rupeeValuePerPointPaise: number;
  plusEnabled: boolean;
  plusTierName: string;
  plusQualificationSpendPaise: number;
  plusBenefits: string[];
  giftCardsEnabled: boolean;
}

export const DEFAULT_LOYALTY_CONFIG: LoyaltyConfigData = {
  rewardsEnabled: true,
  pointsPerHundredInr: 1,
  rupeeValuePerPointPaise: 100,
  plusEnabled: true,
  plusTierName: 'Sahithi Plus',
  plusQualificationSpendPaise: 1_500_000, // ₹15,000 cumulative paid orders
  plusBenefits: [
    'Priority dispatch on festive & silk drops',
    'Early access to seasonal private lookbooks',
    'Complimentary gift-wrap & alteration guidance',
  ],
  giftCardsEnabled: true,
};

export function mergeLoyaltyConfig(
  partial?: Partial<LoyaltyConfigData> | null
): LoyaltyConfigData {
  if (!partial || typeof partial !== 'object') {
    return structuredClone(DEFAULT_LOYALTY_CONFIG);
  }
  return {
    rewardsEnabled:
      typeof partial.rewardsEnabled === 'boolean'
        ? partial.rewardsEnabled
        : DEFAULT_LOYALTY_CONFIG.rewardsEnabled,
    pointsPerHundredInr:
      typeof partial.pointsPerHundredInr === 'number' &&
      Number.isFinite(partial.pointsPerHundredInr) &&
      partial.pointsPerHundredInr >= 0
        ? Math.min(20, Math.round(partial.pointsPerHundredInr))
        : DEFAULT_LOYALTY_CONFIG.pointsPerHundredInr,
    rupeeValuePerPointPaise:
      typeof partial.rupeeValuePerPointPaise === 'number' &&
      Number.isFinite(partial.rupeeValuePerPointPaise) &&
      partial.rupeeValuePerPointPaise >= 0
        ? Math.min(5000, Math.round(partial.rupeeValuePerPointPaise))
        : DEFAULT_LOYALTY_CONFIG.rupeeValuePerPointPaise,
    plusEnabled:
      typeof partial.plusEnabled === 'boolean'
        ? partial.plusEnabled
        : DEFAULT_LOYALTY_CONFIG.plusEnabled,
    plusTierName:
      typeof partial.plusTierName === 'string' && partial.plusTierName.trim()
        ? partial.plusTierName.trim().slice(0, 60)
        : DEFAULT_LOYALTY_CONFIG.plusTierName,
    plusQualificationSpendPaise:
      typeof partial.plusQualificationSpendPaise === 'number' &&
      Number.isFinite(partial.plusQualificationSpendPaise) &&
      partial.plusQualificationSpendPaise >= 100
        ? Math.round(partial.plusQualificationSpendPaise)
        : DEFAULT_LOYALTY_CONFIG.plusQualificationSpendPaise,
    plusBenefits: Array.isArray(partial.plusBenefits)
      ? partial.plusBenefits
          .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
          .map((b) => b.trim().slice(0, 140))
          .slice(0, 6)
      : DEFAULT_LOYALTY_CONFIG.plusBenefits,
    giftCardsEnabled:
      typeof partial.giftCardsEnabled === 'boolean'
        ? partial.giftCardsEnabled
        : DEFAULT_LOYALTY_CONFIG.giftCardsEnabled,
  };
}
