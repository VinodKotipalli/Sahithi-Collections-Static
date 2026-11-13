import { LookbookEntry } from '../types/boutique';
import { BOUTIQUE_MEDIA } from './media';

export const LOOKBOOK_ENTRIES: LookbookEntry[] = [
  {
    id: 'lb-01',
    title: 'Sunlit Organza',
    caption: 'Sheer blush tiers with pearl bodice embroidery for morning celebrations.',
    category: 'Dresses',
    image: BOUTIQUE_MEDIA.heroEditorialCouture,
    alt: 'Model wearing blush ivory pearl-embroidered silk organza maxi dress beside sunlit window',
    layout: 'tall',
  },
  {
    id: 'lb-02',
    title: 'The Evening Cape',
    caption: 'Sculptural rose silk drape with hand-worked metallic motif.',
    category: 'Festive Collection',
    image: BOUTIQUE_MEDIA.spotlightEdit,
    alt: 'Editorial portrait in muted rose draped silk cape gown',
    layout: 'tall',
  },
  {
    id: 'lb-03',
    title: 'Quiet Tailoring',
    caption: 'Warm ivory satin suiting styled with minimalist gold layers.',
    category: 'Western Wear',
    image: BOUTIQUE_MEDIA.colWesternWear,
    alt: 'Tailored warm ivory satin blazer and high-waisted trousers in minimalist studio',
    layout: 'square',
  },
  {
    id: 'lb-04',
    title: 'Artisanal Accents',
    caption: 'Hand-beaded pearl potli and rose-gold kundan drops on travertine.',
    category: 'Accessories',
    image: BOUTIQUE_MEDIA.colAccessories,
    alt: 'Pearl-beaded potli bag, kundan earrings, and silk scarf arranged on travertine stone',
    layout: 'wide',
  },
  {
    id: 'lb-05',
    title: 'Regal Mulberry',
    caption: 'Deep plum Anarkali paired with a rose-tinted organza dupatta.',
    category: 'Ethnic Wear',
    image: BOUTIQUE_MEDIA.colEthnicWear,
    alt: 'Deep plum and muted rose silk Anarkali suit with gold zari border',
    layout: 'square',
  },
  {
    id: 'lb-06',
    title: 'Scalloped Tissue',
    caption: 'Featherlight tissue organza saree edged in delicate pearls.',
    category: 'Festive Collection',
    image: BOUTIQUE_MEDIA.prodPearlOrganzaSaree,
    alt: 'Translucent blush-ivory tissue organza saree with pearl scalloped border',
    layout: 'square',
  },
];
