import type { Product } from '../types/boutique.ts';
import { BOUTIQUE_MEDIA } from './media.ts';

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
    price: 1990,
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
  {
    id: 'sc-101',
    name: 'Floral Cotton Kurti',
    category: 'Kurtis',
    price: 699,
    description: 'Lightweight breathable cotton daily kurti with delicate floral block print and comfortable straight fit.',
    fabricNote: '100% Cambric Cotton',
    images: [
      { src: BOUTIQUE_MEDIA.prodPastelKurti, alt: 'Floral Cotton Kurti in fresh pastel' },
      { src: BOUTIQUE_MEDIA.colEthnicWear, alt: 'Cotton block print closeup' },
    ],
    colors: [
      { name: 'Soft Peach', hex: '#FADADD' },
      { name: 'Alabaster Ivory', hex: '#F5EFE6' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-12',
  },
  {
    id: 'sc-102',
    name: 'Embroidered Rayon Kurti',
    category: 'Kurtis',
    price: 899,
    description: 'Soft fluid rayon kurti featuring exquisite yoke thread embroidery and three-quarter sleeves.',
    fabricNote: 'Premium Rayon Silk',
    images: [
      { src: BOUTIQUE_MEDIA.colEthnicWear, alt: 'Embroidered Rayon Kurti' },
      { src: BOUTIQUE_MEDIA.spotlightEdit, alt: 'Embroidery detail view' },
    ],
    colors: [
      { name: 'Deep Plum', hex: '#49243E' },
      { name: 'Muted Rose', hex: '#B76E79' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-12',
  },
  {
    id: 'sc-103',
    name: 'Straight-Cut Printed Kurti',
    category: 'Kurtis',
    price: 749,
    description: 'Elegant straight-cut daily wear kurti with geometric print and side slits for effortless styling.',
    fabricNote: 'Pure Cotton Slub',
    images: [
      { src: BOUTIQUE_MEDIA.prodPastelKurti, alt: 'Straight-Cut Printed Kurti' },
    ],
    colors: [
      { name: 'Warm Ivory', hex: '#F6EEE6' },
      { name: 'Dusty Blue', hex: '#A4B0BE' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: false,
    dateAdded: '2026-11-11',
  },
  {
    id: 'sc-104',
    name: 'Anarkali Kurti',
    category: 'Kurtis',
    price: 1199,
    description: 'Graceful flared Anarkali kurti with intricate border detailing and flowing silhouette.',
    fabricNote: 'Cotton Chanderi',
    images: [
      { src: BOUTIQUE_MEDIA.colEthnicWear, alt: 'Anarkali Kurti flared silhouette' },
    ],
    colors: [
      { name: 'Mulberry Wine', hex: '#7C3E57' },
      { name: 'Blush Pink', hex: '#F3D5DF' },
    ],
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    featured: true,
    dateAdded: '2026-11-11',
  },
  {
    id: 'sc-105',
    name: 'Cotton Kurta and Pant Set',
    category: 'Kurta Sets',
    price: 1299,
    description: 'Coordinated daily kurta paired with matching elasticated trousers for all-day comfort and poise.',
    fabricNote: 'Breathable Cotton Weave',
    images: [
      { src: BOUTIQUE_MEDIA.prodCoOrdSet, alt: 'Cotton Kurta and Pant Set' },
    ],
    colors: [
      { name: 'Alabaster', hex: '#F5EFE6' },
      { name: 'Mauve', hex: '#7A4E61' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-10',
  },
  {
    id: 'sc-106',
    name: 'Floral Kurta and Dupatta Set',
    category: 'Kurta Sets',
    price: 1599,
    description: 'Charming floral printed kurta set complete with a lightweight matching soft dupatta.',
    fabricNote: 'Cotton Voile with Organza Dupatta',
    images: [
      { src: BOUTIQUE_MEDIA.prodFloralWrapDress, alt: 'Floral Kurta and Dupatta Set' },
    ],
    colors: [
      { name: 'Rose Blush', hex: '#D99FA9' },
      { name: 'Ivory', hex: '#FAF3EB' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-10',
  },
  {
    id: 'sc-107',
    name: 'Embroidered Three-Piece Kurta Set',
    category: 'Kurta Sets',
    price: 1999,
    description: 'Luxurious three-piece ensemble featuring an embroidered kurta, coordinating pants, and elegant sheer dupatta.',
    fabricNote: 'Chanderi Silk Blend',
    images: [
      { src: BOUTIQUE_MEDIA.spotlightEdit, alt: 'Embroidered Three-Piece Kurta Set' },
    ],
    colors: [
      { name: 'Deep Plum', hex: '#49243E' },
      { name: 'Champagne', hex: '#EEDAD4' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-09',
  },
  {
    id: 'sc-108',
    name: 'Printed Cotton Saree',
    category: 'Sarees',
    price: 1099,
    description: 'Easy-drape everyday cotton saree adorned with contemporary botanical block prints and unstitched blouse piece.',
    fabricNote: 'Pure Cotton Handloom',
    images: [
      { src: BOUTIQUE_MEDIA.prodPearlOrganzaSaree, alt: 'Printed Cotton Saree' },
    ],
    colors: [
      { name: 'Indigo Blue', hex: '#2C3E50' },
      { name: 'Warm Ivory', hex: '#F6EEE6' },
    ],
    sizes: ['Free Size'],
    featured: false,
    dateAdded: '2026-11-08',
  },
  {
    id: 'sc-109',
    name: 'Soft Silk-Blend Saree',
    category: 'Sarees',
    price: 1799,
    description: 'Luminous soft silk-blend saree with subtle zari border and graceful drape for family gatherings.',
    fabricNote: 'Silk Blend with Zari Weave',
    images: [
      { src: BOUTIQUE_MEDIA.heroEditorialCouture, alt: 'Soft Silk-Blend Saree' },
    ],
    colors: [
      { name: 'Muted Rose', hex: '#B76E79' },
      { name: 'Gold Tissue', hex: '#E2C9A0' },
    ],
    sizes: ['Free Size'],
    featured: true,
    dateAdded: '2026-11-08',
  },
  {
    id: 'sc-110',
    name: 'Floral Georgette Saree',
    category: 'Sarees',
    price: 1499,
    description: 'Lightweight airy georgette saree printed with romantic watercolor florals and finished with a delicate trim.',
    fabricNote: 'Crinkle Georgette',
    images: [
      { src: BOUTIQUE_MEDIA.colDresses, alt: 'Floral Georgette Saree' },
    ],
    colors: [
      { name: 'Blush Pink', hex: '#F3D5DF' },
      { name: 'Lavender', hex: '#D7BDE2' },
    ],
    sizes: ['Free Size'],
    featured: false,
    dateAdded: '2026-11-07',
  },
  {
    id: 'sc-111',
    name: 'Festive Woven-Border Saree',
    category: 'Sarees',
    price: 1899,
    description: 'Celebratory saree highlighted by a rich traditional woven zari border and pallu.',
    fabricNote: 'Tissue Silk Blend',
    images: [
      { src: BOUTIQUE_MEDIA.colFestiveWear, alt: 'Festive Woven-Border Saree' },
    ],
    colors: [
      { name: 'Mulberry Plum', hex: '#49243E' },
      { name: 'Antique Gold', hex: '#C5A059' },
    ],
    sizes: ['Free Size'],
    featured: true,
    dateAdded: '2026-11-07',
  },
  {
    id: 'sc-112',
    name: 'Printed Cotton Co-ord Set',
    category: 'Co-ord Sets',
    price: 1399,
    description: 'Modern matching shirt and relaxed trousers in a vibrant artisanal print for effortless chic.',
    fabricNote: 'Breathable Cotton Poplin',
    images: [
      { src: BOUTIQUE_MEDIA.prodCoOrdSet, alt: 'Printed Cotton Co-ord Set' },
    ],
    colors: [
      { name: 'Sage Green', hex: '#A3B18B' },
      { name: 'Warm Ivory', hex: '#F4ECE2' },
    ],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    featured: true,
    dateAdded: '2026-11-06',
  },
  {
    id: 'sc-113',
    name: 'Solid Two-Piece Co-ord Set',
    category: 'Co-ord Sets',
    price: 1599,
    description: 'Tailored solid-hue top and wide-leg trouser set designed for minimalist sophistication.',
    fabricNote: 'Linen-Cotton Blend',
    images: [
      { src: BOUTIQUE_MEDIA.colWesternWear, alt: 'Solid Two-Piece Co-ord Set' },
    ],
    colors: [
      { name: 'Mauve Plum', hex: '#7A4E61' },
      { name: 'Alabaster', hex: '#F5EFE6' },
    ],
    sizes: ['XS', 'S', 'M', 'L'],
    featured: false,
    dateAdded: '2026-11-06',
  },
  {
    id: 'sc-114',
    name: 'Embroidered Chiffon Dupatta',
    category: 'Dupattas',
    price: 499,
    description: 'Lightweight sheer chiffon dupatta finished with delicate thread embroidery along the borders.',
    fabricNote: 'Fine Chiffon',
    images: [
      { src: BOUTIQUE_MEDIA.colAccessories, alt: 'Embroidered Chiffon Dupatta' },
    ],
    colors: [
      { name: 'Ivory', hex: '#FAF3EB' },
      { name: 'Blush', hex: '#F3D5DF' },
    ],
    sizes: ['One Size'],
    featured: false,
    dateAdded: '2026-11-05',
  },
  {
    id: 'sc-115',
    name: 'Woven-Border Dupatta',
    category: 'Dupattas',
    price: 599,
    description: 'Elegant ethnic drape featuring a traditional woven zari border to elevate any basic kurti or suit.',
    fabricNote: 'Banarasi Cotton-Silk',
    images: [
      { src: BOUTIQUE_MEDIA.prodSilkPotliBag, alt: 'Woven-Border Dupatta' },
    ],
    colors: [
      { name: 'Gold Tissue', hex: '#E2C9A0' },
      { name: 'Deep Plum', hex: '#49243E' },
    ],
    sizes: ['One Size'],
    featured: true,
    dateAdded: '2026-11-05',
  },
];
