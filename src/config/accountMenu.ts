import {
  Award,
  Bell,
  CreditCard,
  Crown,
  Gift,
  Heart,
  LogOut,
  MapPin,
  Package,
  Tag,
  User,
  type LucideIcon,
} from 'lucide-react';

export type AccountSectionId =
  | 'profile'
  | 'orders'
  | 'coupons'
  | 'rewards'
  | 'plus'
  | 'payments'
  | 'addresses'
  | 'wishlist'
  | 'gift-cards'
  | 'notifications';

export interface AccountMenuItem {
  id: AccountSectionId;
  label: string;
  subtitle: string;
  href: string;
  icon: LucideIcon;
}

export const ACCOUNT_MENU_ITEMS: ReadonlyArray<AccountMenuItem> = [
  {
    id: 'profile',
    label: 'My Profile',
    subtitle: 'Name, email & security',
    href: '/account?section=profile',
    icon: User,
  },
  {
    id: 'orders',
    label: 'Orders',
    subtitle: 'Track & manage requests',
    href: '/account?section=orders',
    icon: Package,
  },
  {
    id: 'coupons',
    label: 'Coupons',
    subtitle: 'Active atelier offers',
    href: '/account?section=coupons',
    icon: Tag,
  },
  {
    id: 'rewards',
    label: 'Sahithi Rewards',
    subtitle: 'Earned points balance',
    href: '/account?section=rewards',
    icon: Award,
  },
  {
    id: 'plus',
    label: 'Sahithi Plus',
    subtitle: 'Membership progress',
    href: '/account?section=plus',
    icon: Crown,
  },
  {
    id: 'payments',
    label: 'Saved Cards & Wallet',
    subtitle: 'Razorpay checkout options',
    href: '/account?section=payments',
    icon: CreditCard,
  },
  {
    id: 'addresses',
    label: 'Saved Addresses',
    subtitle: 'Delivery locations',
    href: '/account?section=addresses',
    icon: MapPin,
  },
  {
    id: 'wishlist',
    label: 'Wishlist',
    subtitle: 'Cloud-synced favorites',
    href: '/account?section=wishlist',
    icon: Heart,
  },
  {
    id: 'gift-cards',
    label: 'Gift Cards',
    subtitle: 'Check card balance',
    href: '/account?section=gift-cards',
    icon: Gift,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    subtitle: 'Order & studio alerts',
    href: '/account?section=notifications',
    icon: Bell,
  },
];

export const ACCOUNT_LOGOUT_ITEM = {
  id: 'logout' as const,
  label: 'Logout',
  subtitle: 'Sign out of this device',
  icon: LogOut,
};

const VALID_ACCOUNT_SECTIONS = new Set<string>(ACCOUNT_MENU_ITEMS.map((item) => item.id));

export function isValidAccountSection(value: string | null | undefined): value is AccountSectionId {
  if (!value) return false;
  return VALID_ACCOUNT_SECTIONS.has(value.trim().toLowerCase());
}

export function parseAccountSection(value: string | null | undefined): AccountSectionId {
  const normalized = (value || '').trim().toLowerCase();
  if (VALID_ACCOUNT_SECTIONS.has(normalized)) {
    return normalized as AccountSectionId;
  }
  return 'profile';
}

export function buildAccountSectionPath(section: AccountSectionId): string {
  return `/account?section=${encodeURIComponent(section)}`;
}
