import { Product } from '../types/boutique';
import { BOUTIQUE_MEDIA } from './media';

/**
 * DEMO CATALOG DATA
 * Replace image imports, titles, descriptions, and INR prices below
 * to customize the Sahithi Collections storefront.
 */
export const PRODUCTS: Product[] = [
  {
    id: 'sc-001',
    name: 'Noor Pearl-Embroidered Organza Gown',
    category: 'Dresses',
    price: 4850,
    description:
      'Airy blush-ivory silk organza tiered gown finished with delicate hand-placed pearl botanical motifs along the bodice and sheer full sleeves.',
    fabricNote: 'Silk organza with soft mulmul lining',
    images: [
      {
        src: BOUTIQUE_MEDIA.heroEditorialCouture,
        alt: 'Noor Pearl-Embroidered Organza Gown in blush ivory',
      },
      {
        src: BOUTIQUE_MEDIA.colDresses,
        alt: 'Flowing tiered organza skirt silhouette in movement',
      },
    ],
    colors: [
      { name: 'Blush Ivory', hex: '#F4DFDF' },
      { name: 'Warm Cream', hex: '#F6EDE4' },
      { name: 'Dusty Rose', hex: '#C98A95' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-10',
  },
  {
    id: 'sc-002',
    name: 'Zoya Zari Plum Anarkali Ensemble',
    category: 'Ethnic Wear',
    price: 5490,
    description:
      'Floor-sweeping mulberry plum silk blend Anarkali contrasted with a muted rose border, woven zari hem, and gossamer organza dupatta.',
    fabricNote: 'Chanderi silk blend with organza dupatta',
    images: [
      {
        src: BOUTIQUE_MEDIA.colEthnicWear,
        alt: 'Zoya Zari Plum Anarkali Ensemble with rose organza dupatta',
      },
      {
        src: BOUTIQUE_MEDIA.spotlightEdit,
        alt: 'Close look at rich plum and rose tonal embroidery',
      },
    ],
    colors: [
      { name: 'Deep Plum', hex: '#49243E' },
      { name: 'Muted Rose', hex: '#B76E79' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-08',
  },
  {
    id: 'sc-003',
    name: 'Ivory Atelier Satin Blazer & Trouser Set',
    category: 'Western Wear',
    price: 4290,
    description:
      'Clean-lined single-breasted satin blazer paired with high-waisted pleated trousers for effortless daytime tailoring or evening dinners.',
    fabricNote: 'Matte crepe-back satin, lined',
    images: [
      {
        src: BOUTIQUE_MEDIA.colWesternWear,
        alt: 'Ivory Atelier Satin Blazer and Pleated Trouser Set',
      },
      {
        src: BOUTIQUE_MEDIA.prodCoOrdSet,
        alt: 'Alternative tailored co-ord silhouette',
      },
    ],
    colors: [
      { name: 'Warm Ivory', hex: '#F4ECE2' },
      { name: 'Mauve Plum', hex: '#7A4E61' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    featured: true,
    dateAdded: '2026-11-06',
  },
  {
    id: 'sc-004',
    name: 'Aanya Flutter-Sleeve Tiered Midi Dress',
    category: 'Dresses',
    price: 3250,
    description:
      'Romantic blush-pink georgette midi dress featuring soft flutter sleeves, a self-tie waist sash, and three cascading skirt tiers.',
    fabricNote: 'Lightweight crinkle chiffon, cotton-voile lining',
    images: [
      {
        src: BOUTIQUE_MEDIA.colDresses,
        alt: 'Aanya Flutter-Sleeve Tiered Midi Dress in soft blush',
      },
      {
        src: BOUTIQUE_MEDIA.prodFloralWrapDress,
        alt: 'Soft afternoon drape styling inspiration',
      },
    ],
    colors: [
      { name: 'Blush Pink', hex: '#F3D5DF' },
      { name: 'Rosewood', hex: '#B76E79' },
      { name: 'Ivory', hex: '#FAF3EB' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-05',
  },
  {
    id: 'sc-005',
    name: 'Meher Velvet Scalloped Sharara Set',
    category: 'Festive Collection',
    price: 6890,
    description:
      'Lustrous mulberry plum micro-velvet short kurta and flared sharara detailed with antique-gold resham work and a scalloped organza dupatta.',
    fabricNote: 'Silk-viscose velvet with embroidered organza',
    images: [
      {
        src: BOUTIQUE_MEDIA.colFestiveWear,
        alt: 'Meher Velvet Scalloped Sharara Set in mulberry plum',
      },
      {
        src: BOUTIQUE_MEDIA.colEthnicWear,
        alt: 'Festive silhouette with sheer embroidered dupatta',
      },
    ],
    colors: [
      { name: 'Mulberry Plum', hex: '#49243E' },
      { name: 'Wine Rose', hex: '#7C3E57' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-03',
  },
  {
    id: 'sc-006',
    name: 'Ira Pearl-Border Tissue Organza Saree',
    category: 'Festive Collection',
    price: 5950,
    description:
      'Translucent blush-ivory tissue organza saree edged with hand-sewn pearl scallops and delicate floral threadwork, paired with an embroidered blouse.',
    fabricNote: 'Handloom tissue organza with unstitched silk blouse',
    images: [
      {
        src: BOUTIQUE_MEDIA.prodPearlOrganzaSaree,
        alt: 'Ira Pearl-Border Tissue Organza Saree with embroidered blouse',
      },
      {
        src: BOUTIQUE_MEDIA.heroEditorialCouture,
        alt: 'Luminous sheer ivory-blush organza texture detail',
      },
    ],
    colors: [
      { name: 'Champagne Blush', hex: '#EEDAD4' },
      { name: 'Warm Ivory', hex: '#F6EEE6' },
    ],
    sizes: ['Free Size'],
    featured: true,
    dateAdded: '2026-11-01',
  },
  {
    id: 'sc-007',
    name: 'Kavya Chikankari Cotton-Silk Kurta Set',
    category: 'Ethnic Wear',
    price: 2890,
    description:
      'Breathable ivory cotton-silk straight kurta adorned with tonal shadow-work botanical embroidery and wide-leg embroidered palazzos.',
    fabricNote: 'Cotton-silk blend, breathable weave',
    images: [
      {
        src: BOUTIQUE_MEDIA.prodPastelKurti,
        alt: 'Kavya Chikankari Cotton-Silk Kurta Set in warm ivory',
      },
      {
        src: BOUTIQUE_MEDIA.prodPearlOrganzaSaree,
        alt: 'Subtle ivory tonal craftsmanship detail',
      },
    ],
    colors: [
      { name: 'Alabaster Ivory', hex: '#F5EFE6' },
      { name: 'Soft Blush', hex: '#F3D5DF' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: false,
    dateAdded: '2026-10-28',
  },
  {
    id: 'sc-008',
    name: 'Sia Rose-Floral Satin Wrap Dress',
    category: 'Dresses',
    price: 3490,
    description:
      'Fluid dusty-rose satin wrap midi printed with painterly ivory blooms, kimono-style sleeves, and a gently ruffled asymmetrical hem.',
    fabricNote: 'Fluid viscose satin',
    images: [
      {
        src: BOUTIQUE_MEDIA.prodFloralWrapDress,
        alt: 'Sia Rose-Floral Satin Wrap Dress with waist tie',
      },
      {
        src: BOUTIQUE_MEDIA.colDresses,
        alt: 'Alternative romantic midi dress movement',
      },
    ],
    colors: [
      { name: 'Dusty Rose', hex: '#B76E79' },
      { name: 'Blush', hex: '#F3D5DF' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    featured: false,
    dateAdded: '2026-10-25',
  },
  {
    id: 'sc-009',
    name: 'Tara Mauve Linen-Silk Co-ord Set',
    category: 'Western Wear',
    price: 3890,
    description:
      'Structured cropped jacket with patch pockets paired with belted wide-leg pleated trousers in a rich mauve-plum linen-silk weave.',
    fabricNote: 'Linen-silk blend with breathable finish',
    images: [
      {
        src: BOUTIQUE_MEDIA.prodCoOrdSet,
        alt: 'Tara Mauve Linen-Silk Cropped Jacket and Trouser Co-ord Set',
      },
      {
        src: BOUTIQUE_MEDIA.colWesternWear,
        alt: 'Tailored trouser silhouette in studio daylight',
      },
    ],
    colors: [
      { name: 'Mauve Plum', hex: '#7A4E61' },
      { name: 'Warm Ivory', hex: '#F4ECE2' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: false,
    dateAdded: '2026-10-22',
  },
  {
    id: 'sc-010',
    name: 'Rhea Draped Rose Silk Cape Gown',
    category: 'Festive Collection',
    price: 7250,
    description:
      'The centerpiece of The Spotlight Edit — a sculptural muted-rose draped gown featuring architectural cape sleeves and fine metallic threadwork.',
    fabricNote: 'Pure crepe silk with metallic zardozi accents',
    images: [
      {
        src: BOUTIQUE_MEDIA.spotlightEdit,
        alt: 'Rhea Draped Rose Silk Cape Gown from The Spotlight Edit',
      },
      {
        src: BOUTIQUE_MEDIA.colFestiveWear,
        alt: 'Evening festive collection inspiration',
      },
    ],
    colors: [
      { name: 'Muted Rose', hex: '#B76E79' },
      { name: 'Deep Plum', hex: '#49243E' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    featured: true,
    dateAdded: '2026-11-09',
  },
  {
    id: 'sc-011',
    name: 'Miraya Pearl-Tassel Silk Potli & Hairpin Duo',
    category: 'Accessories',
    price: 1850,
    description:
      'Hand-embroidered blush raw silk potli clutch finished with freshwater-style pearl drawstring tassels and a pair of rose-gold baroque pearl hairpins.',
    fabricNote: 'Raw silk exterior, satin lining, alloy pins',
    images: [
      {
        src: BOUTIQUE_MEDIA.prodSilkPotliBag,
        alt: 'Miraya Pearl-Tassel Silk Potli and Baroque Pearl Hairpin Duo',
      },
      {
        src: BOUTIQUE_MEDIA.colAccessories,
        alt: 'Coordinated pearl clutch and accessory styling',
      },
    ],
    colors: [
      { name: 'Rose Blush', hex: '#D99FA9' },
      { name: 'Champagne Ivory', hex: '#EFE4D8' },
    ],
    sizes: ['One Size'],
    featured: false,
    dateAdded: '2026-10-18',
  },
  {
    id: 'sc-012',
    name: 'Naina Kundan Drop & Silk Stole Set',
    category: 'Accessories',
    price: 2290,
    description:
      'Curated finishing set pairing rose-gold kundan pearl drop earrings with a lustrous dusty-rose pure silk stole and pearl-beaded evening pouch.',
    fabricNote: 'Pure mulberry silk stole, rose-gold plated earrings',
    images: [
      {
        src: BOUTIQUE_MEDIA.colAccessories,
        alt: 'Naina Kundan Drop Earrings, Dusty Rose Silk Stole, and Pearl Potli',
      },
      {
        src: BOUTIQUE_MEDIA.prodSilkPotliBag,
        alt: 'Complementary rose-gold pearl detail view',
      },
    ],
    colors: [
      { name: 'Dusty Rose', hex: '#B76E79' },
      { name: 'Pearl Ivory', hex: '#F7F0E9' },
    ],
    sizes: ['One Size'],
    featured: false,
    dateAdded: '2026-10-15',
  },
];
