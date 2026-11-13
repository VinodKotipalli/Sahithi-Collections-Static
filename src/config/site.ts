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
    whatsappNumber: '',
    instagramHandle: '',
    email: '',
    storeAddress: '',
    hoursNote: 'Configure boutique hours in src/config/site.ts',
  } satisfies ContactConfig,
};

export function isWhatsAppConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  const digits = contact.whatsappNumber.replace(/\D/g, '');
  return digits.length >= 10;
}

export function isInstagramConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  return contact.instagramHandle.trim().length > 0;
}

export function isEmailConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim());
}

export function isAddressConfigured(contact: ContactConfig = SITE_CONFIG.contact): boolean {
  return contact.storeAddress.trim().length > 0;
}

export function buildWhatsAppEnquiryMessage(params: {
  productName: string;
  selectedSize: string;
  selectedColor: string;
}): string {
  return `Hello ${SITE_CONFIG.brandName}, I would like to enquire about "${params.productName}" (Size: ${params.selectedSize}, Color: ${params.selectedColor}). Could you please share availability and styling details?`;
}

export function buildWhatsAppEnquiryUrl(params: {
  productName: string;
  selectedSize: string;
  selectedColor: string;
}): string | null {
  if (!isWhatsAppConfigured()) return null;
  const digits = SITE_CONFIG.contact.whatsappNumber.replace(/\D/g, '');
  const text = encodeURIComponent(buildWhatsAppEnquiryMessage(params));
  return `https://wa.me/${digits}?text=${text}`;
}
