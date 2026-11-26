import { ContactConfig } from '../types/boutique';
import { BOUTIQUE_MEDIA } from './media';

export const SITE_CONFIG = {
  brandName: 'Sahithi Collections',
  tagline: 'Style That Celebrates You.',
  hero: {
    eyebrow: 'New Boutique Collection',
    headline: 'Discover Your Everyday Elegance.',
    supportingText:
      'Explore sunlit floral organzas, handloom kurta sets, and festive zari-bordered silhouettes curated exclusively at Sahithi Collections.',
    primaryCta: 'Explore Collections',
    secondaryCta: 'Shop All 32 Styles',
    floatingLabels: ['32 Fresh Arrivals', 'Made for Your Moments'] as const,
    mainImage: {
      src: BOUTIQUE_MEDIA.wa0026RoyalBlue,
      alt: 'Young woman wearing a royal blue checkered flared gown with wide antique gold zari border in a sunlit courtyard',
    },
    accentCutouts: [
      {
        src: BOUTIQUE_MEDIA.wa0004PinkFloral,
        alt: 'Young woman wearing a rose-pink floral organza puff-sleeve flared dress',
        caption: 'Floral Organzas',
      },
      {
        src: BOUTIQUE_MEDIA.wa0020PinkSharara,
        alt: 'Young woman wearing a festive lotus-pink sharara set with orange-gold zari borders',
        caption: 'Festive Shararas',
      },
    ],
  },
  spotlightEdit: {
    kicker: 'Featured Capsule',
    title: 'The Festive Spotlight',
    subtitle: 'Illustrated heritage borders, luminous organza, and effortless poise.',
    description:
      'From our coral-pink Kalamkari lehenga and lotus-pink zari-bordered sharara to shimmering tissue kurta sets, discover statement pieces designed to celebrate every joyous occasion in comfort and grace.',
    ctaLabel: 'Explore Festive Styles',
    targetCategory: 'Festive Collection' as const,
    image: {
      src: BOUTIQUE_MEDIA.wa0033CoralLehenga,
      alt: 'Young woman wearing a coral-pink festive silk lehenga with illustrated Kalamkari border and matching dupatta',
    },
  },
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
      src: BOUTIQUE_MEDIA.wa0003IvoryMauve,
      alt: 'Young woman wearing a warm ivory flared ethnic dress paired with a flowing mauve organza dupatta',
    },
  },
  /**
   * EDITABLE CONTACT SETTINGS
   * Replace empty strings with your live boutique details before publishing.
   */
  contact: {
    whatsappNumber: '',
    instagramHandle: '',
    email: 'saivinodkotipalli2003@gmail.com',
    storeAddress: '',
    hoursNote: 'Mon – Sat · 10:30 AM – 8:00 PM IST',
  } satisfies ContactConfig,
};

export const DEFAULT_BOUTIQUE_EMAIL = 'saivinodkotipalli2003@gmail.com';

export function resolveBoutiqueEmail(contact: ContactConfig = SITE_CONFIG.contact): string {
  const candidate = (contact.email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : DEFAULT_BOUTIQUE_EMAIL;
}

export function isInstagramConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  return contact.instagramHandle.trim().length > 0;
}

export function isEmailConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolveBoutiqueEmail(contact));
}

export function isAddressConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  return contact.storeAddress.trim().length > 0;
}
