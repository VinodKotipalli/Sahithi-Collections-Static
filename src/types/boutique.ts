export type CollectionCategory =
  | 'Ethnic Wear'
  | 'Western Wear'
  | 'Dresses'
  | 'Festive Collection'
  | 'Accessories';

export interface ProductColor {
  name: string;
  hex: string;
}

export interface ProductImage {
  src: string;
  alt: string;
}

export interface Product {
  id: string;
  name: string;
  category: CollectionCategory;
  /** Price in Indian Rupees (INR). Demo price — edit in src/config/products.ts */
  price: number;
  description: string;
  fabricNote: string;
  images: ProductImage[];
  colors: ProductColor[];
  sizes: string[];
  featured: boolean;
  /** ISO date string (YYYY-MM-DD) used for sorting by newest */
  dateAdded: string;
}

export interface CollectionItem {
  id: string;
  category: CollectionCategory;
  subtitle: string;
  image: string;
  alt: string;
}

export interface LookbookEntry {
  id: string;
  title: string;
  caption: string;
  category: CollectionCategory;
  image: string;
  alt: string;
  layout: 'tall' | 'wide' | 'square';
}

export interface ContactConfig {
  /**
   * Enter digits only with country code, e.g. '919876543210'.
   * Leave empty ('') while unconfigured so product enquiry shows a setup notice.
   */
  whatsappNumber: string;
  /** Enter your Instagram handle without '@', e.g. 'sahithicollections'. Leave empty ('') until configured. */
  instagramHandle: string;
  /** Enter your boutique contact email, e.g. 'hello@sahithicollections.com'. Leave empty ('') until configured. */
  email: string;
  /** Enter your boutique street address. Leave empty ('') until configured. */
  storeAddress: string;
  /** Optional store hours note shown once address or contact details are configured. */
  hoursNote: string;
}
