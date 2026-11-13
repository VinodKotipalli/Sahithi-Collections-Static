import { CollectionItem } from '../types/boutique';
import { BOUTIQUE_MEDIA } from './media';

export const COLLECTIONS: CollectionItem[] = [
  {
    id: 'ethnic-wear',
    category: 'Ethnic Wear',
    subtitle: 'Hand-embroidered kurtis, graceful anarkalis & sheer organza drapes',
    image: BOUTIQUE_MEDIA.colEthnicWear,
    alt: 'Young woman in a deep plum and muted rose silk Anarkali suit with delicate gold zari border',
  },
  {
    id: 'western-wear',
    category: 'Western Wear',
    subtitle: 'Tailored blazers, fluid co-ord sets & refined everyday separates',
    image: BOUTIQUE_MEDIA.colWesternWear,
    alt: 'Young woman wearing a tailored warm ivory satin blazer and pleated trousers',
  },
  {
    id: 'dresses',
    category: 'Dresses',
    subtitle: 'Tiered chiffon midis, floral wraps & sunlit occasion silhouettes',
    image: BOUTIQUE_MEDIA.colDresses,
    alt: 'Young woman twirling in a flowing blush pink tiered chiffon midi dress',
  },
  {
    id: 'festive-collection',
    category: 'Festive Collection',
    subtitle: 'Velvet shararas, pearl-bordered sarees & evening statement capes',
    image: BOUTIQUE_MEDIA.colFestiveWear,
    alt: 'Young woman wearing a rich mulberry plum velvet sharara set with scalloped dupatta',
  },
  {
    id: 'accessories',
    category: 'Accessories',
    subtitle: 'Pearl-tasseled potlis, kundan drops, silk scarves & hair accents',
    image: BOUTIQUE_MEDIA.colAccessories,
    alt: 'Pearl-embroidered blush potli clutch, rose-gold earrings, and silk scarf on travertine',
  },
];
