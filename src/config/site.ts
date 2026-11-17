import { ContactConfig } from '../types/boutique';
import { BOUTIQUE_MEDIA } from './media';

export const SITE_CONFIG = {
  brandName: 'Sahithi Collections',
  tagline: 'Style That Celebrates You.',
  hero: {
    eyebrow: 'Curated Boutique Wardrobe',
    headline: 'Discover Your Everyday Elegance.',
    supportingText:
      'Explore beautiful styles, fresh arrivals, and statement pieces at Sahithi Collections.',
    primaryCta: 'Explore Collections',
    secondaryCta: 'View New Arrivals',
    floatingLabels: ['Fresh Styles', 'Made for Your Moments'] as const,
    mainImage: {
      src: BOUTIQUE_MEDIA.heroEditorialCouture,
      alt: 'Young woman in a blush pink and warm ivory pearl-embroidered silk organza maxi dress standing beside sunlit studio windows',
    },
    accentCutouts: [
      {
        src: BOUTIQUE_MEDIA.prodSilkPotliBag,
        alt: 'Artisanal rose-blush silk potli clutch with pearl tassels and baroque pearl hairpins',
        caption: 'Handcrafted Details',
      },
      {
        src: BOUTIQUE_MEDIA.spotlightEdit,
        alt: 'Editorial look featuring a sculpted muted rose draped cape silhouette',
        caption: 'Evening Silhouettes',
      },
    ],
  },
  spotlightEdit: {
    kicker: 'Featured Capsule',
    title: 'The Spotlight Edit',
    subtitle: 'Soft drape, rich plum undertones, and effortless poise.',
    description:
      'Thoughtfully composed silhouettes designed to move gracefully from intimate daytime gatherings to evening celebrations. Discover sculpted capes, sheer organza borders, and tactile silk finishes.',
    ctaLabel: 'Explore the Edit',
    targetCategory: 'Festive Collection' as const,
    image: {
      src: BOUTIQUE_MEDIA.spotlightEdit,
      alt: 'Editorial fashion portrait showcasing a muted rose draped silk cape gown with metallic threadwork',
    },
  },
  about: {
    kicker: 'Our Philosophy',
    heading: 'A Little Style. A Lot of Confidence.',
    paragraphs: [
      'Sahithi Collections brings together thoughtful silhouettes for girls and young women who love dressing with quiet grace and personal flair. From airy cotton-silk kurtis for sunny afternoons to celebratory ensembles and modern separates, every piece is chosen to feel effortless the moment you slip it on.',
      'We believe great style does not have to shout. Soft palettes, flattering cuts, and considered accessories help you celebrate both everyday moments and cherished occasions in your own natural rhythm.',
    ],
    pillars: [
      {
        title: 'Everyday Ease',
        detail: 'Breathable weaves and fluid tailoring built for comfortable movement.',
      },
      {
        title: 'Occasion Ready',
        detail: 'Delicate pearl, zari, and organza textures curated for memorable gatherings.',
      },
      {
        title: 'Coordinated Finishing',
        detail: 'Potli clutches, earrings, and hair accents chosen to pair seamlessly.',
      },
    ],
    image: {
      src: BOUTIQUE_MEDIA.aboutAtelier,
      alt: 'Sunlit boutique space with warm plaster walls and a rose-gold rack displaying blush, ivory, and plum silk dresses',
    },
  },
  /**
   * EDITABLE CONTACT & WHATSAPP SETTINGS
   * Replace empty strings with your live boutique details before publishing.
   */
  contact: {
    whatsappNumber: '918520899337',
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
