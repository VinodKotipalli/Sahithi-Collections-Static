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
   * EDITABLE CONTACT & WHATSAPP SETTINGS
   * Replace empty strings with your live boutique details before publishing.
   */
  contact: {
    whatsappNumber: '919701628779',
    instagramHandle: '',
    email: 'saivinodkotipalli2003@gmail.com',
    storeAddress: '',
    hoursNote: 'Mon – Sat · 10:30 AM – 8:00 PM IST',
  } satisfies ContactConfig,
};

export const DEFAULT_WHATSAPP_DIGITS = '918520899337';
export const DEFAULT_BOUTIQUE_EMAIL = 'saivinodkotipalli2003@gmail.com';

export function normalizeWhatsAppDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `91${digits}`;
  }
  return digits;
}

export function resolveWhatsAppDigits(contact: ContactConfig = SITE_CONFIG.contact): string {
  const normalized = normalizeWhatsAppDigits(contact.whatsappNumber || '');
  return normalized.length >= 10 ? normalized : DEFAULT_WHATSAPP_DIGITS;
}

export function formatWhatsAppDisplay(raw?: string): string {
  const digits = normalizeWhatsAppDigits(raw || '') || DEFAULT_WHATSAPP_DIGITS;
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

export function resolveBoutiqueEmail(contact: ContactConfig = SITE_CONFIG.contact): string {
  const candidate = (contact.email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : DEFAULT_BOUTIQUE_EMAIL;
}

export function isWhatsAppConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  return resolveWhatsAppDigits(contact).length >= 10;
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

export function buildWhatsAppEnquiryMessage(params: {
  productName: string;
  selectedSize: string;
  selectedColor: string;
  brandName?: string;
}): string {
  const brand = params.brandName?.trim() || SITE_CONFIG.brandName;
  return `Hello ${brand}, I would like to enquire about "${params.productName}" (Size: ${params.selectedSize}, Color: ${params.selectedColor}). Could you please share availability and styling details?`;
}

export function buildWhatsAppEnquiryUrl(params: {
  productName: string;
  selectedSize: string;
  selectedColor: string;
  brandName?: string;
  contact?: ContactConfig;
}): string {
  const contact = params.contact || SITE_CONFIG.contact;
  const digits = resolveWhatsAppDigits(contact);
  const text = encodeURIComponent(buildWhatsAppEnquiryMessage(params));
  return `https://wa.me/${digits}?text=${text}`;
}

export function buildWhatsAppChatUrl(
  message: string,
  contact: ContactConfig = SITE_CONFIG.contact
): string {
  const digits = resolveWhatsAppDigits(contact);
  const cleanMsg = message.trim();
  return cleanMsg
    ? `https://wa.me/${digits}?text=${encodeURIComponent(cleanMsg)}`
    : `https://wa.me/${digits}`;
}
