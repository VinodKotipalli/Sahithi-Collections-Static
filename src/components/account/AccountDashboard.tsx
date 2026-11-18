import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  Bell,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  Heart,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Mail,
  MapPin,
  Menu,
  Package,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import {
  ACCOUNT_LOGOUT_ITEM,
  ACCOUNT_MENU_ITEMS,
  type AccountSectionId,
} from '../../config/accountMenu';
import { useAuth } from '../../context/AuthContext';
import { SITE_CONFIG } from '../../config/site';
import type {
  BagItem,
  BoutiqueCoupon,
  BoutiqueGiftCard,
  CustomerAddress,
  CustomerNotification,
  CustomerRewardsSummary,
  PlacedOrderReceipt,
  Product,
  SavedPaymentMethodsSummary,
} from '../../types/boutique';
import { formatINR, formatPaiseINR, formatTimestamp } from '../../utils/format';
import { BoutiqueImage } from '../BoutiqueImage';

export type { AccountSectionId };

interface AccountDashboardProps {
  activeSection?: AccountSectionId;
  onSelectSection?: (section: AccountSectionId) => void;
  wishlistCount: number;
  wishlistProducts: Product[];
  onRemoveWishlistItem: (productId: string) => void;
  onAddToBag: (item: BagItem) => void;
  onOpenBag: () => void;
  onOpenWishlist: () => void;
  onNavigate: (target: string, options?: { replace?: boolean }) => void;
}

const EMPTY_ADDRESS_FORM = {
  id: '',
  fullName: '',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  pincode: '',
  landmark: '',
  label: 'Home' as 'Home' | 'Work' | 'Other',
  isDefault: false,
};

export function AccountDashboard({
  activeSection: controlledSection,
  onSelectSection,
  wishlistCount,
  wishlistProducts,
  onRemoveWishlistItem,
  onAddToBag,
  onOpenBag,
  onOpenWishlist,
  onNavigate,
}: AccountDashboardProps) {
  const {
    user,
    capabilities,
    apiRequest,
    updateProfileName,
    reauthenticateWithPassword,
    changePassword,
    requestLinkEmail,
    logout,
  } = useAuth();

  const nameId = useId();
  const reauthPassId = useId();
  const linkEmailId = useId();
  const newPassId = useId();
  const confirmNewPassId = useId();
  const giftLookupId = useId();

  const [internalSection, setInternalSection] = useState<AccountSectionId>(controlledSection || 'profile');
  const activeSection = controlledSection ?? internalSection;
  const selectSection = useCallback(
    (next: AccountSectionId) => {
      if (onSelectSection) {
        onSelectSection(next);
      } else {
        setInternalSection(next);
      }
      setMobileMenuOpen(false);
    },
    [onSelectSection]
  );

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Profile name & security
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameFeedback, setNameFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [reauthPassword, setReauthPassword] = useState('');
  const [showReauthPassword, setShowReauthPassword] = useState(false);
  const [reauthSubmitting, setReauthSubmitting] = useState(false);
  const [reauthFeedback, setReauthFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [newEmail, setNewEmail] = useState('');
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [passSubmitting, setPassSubmitting] = useState(false);
  const [passFeedback, setPassFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Orders
  const [orders, setOrders] = useState<PlacedOrderReceipt[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [requestOrderId, setRequestOrderId] = useState<string | null>(null);
  const [requestType, setRequestType] = useState<'cancel' | 'return'>('return');
  const [requestReason, setRequestReason] = useState('');
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestFeedback, setRequestFeedback] = useState<{ orderId: string; type: 'ok' | 'err'; text: string } | null>(null);

  // Coupons
  const [coupons, setCoupons] = useState<BoutiqueCoupon[]>([]);
  const [couponsLoading, setCouponsLoading] = useState(false);
  const [couponsError, setCouponsError] = useState<string | null>(null);
  const [copiedCoupon, setCopiedCoupon] = useState<string | null>(null);

  // Rewards & Plus
  const [rewards, setRewards] = useState<CustomerRewardsSummary | null>(null);
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [rewardsError, setRewardsError] = useState<string | null>(null);

  // Payment Methods
  const [paymentSummary, setPaymentSummary] = useState<SavedPaymentMethodsSummary | null>(null);
  const [paymentLoading, setPaymentLoading] = useState(false);

  // Addresses
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [addressesError, setAddressesError] = useState<string | null>(null);
  const [addressFormOpen, setAddressFormOpen] = useState(false);
  const [addressForm, setAddressForm] = useState(EMPTY_ADDRESS_FORM);
  const [addressSaving, setAddressSaving] = useState(false);

  // Wishlist action notice
  const [movedProductId, setMovedProductId] = useState<string | null>(null);

  // Gift Cards
  const [giftCardCode, setGiftCardCode] = useState('');
  const [giftCardBusy, setGiftCardBusy] = useState(false);
  const [giftCardError, setGiftCardError] = useState<string | null>(null);
  const [giftCardResult, setGiftCardResult] = useState<BoutiqueGiftCard | null>(null);

  // Notifications
  const [notifications, setNotifications] = useState<CustomerNotification[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);

  // Logout
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.fullName !== undefined) {
      setFullName(user.fullName);
    }
  }, [user?.fullName]);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    const res = await apiRequest<{ items?: PlacedOrderReceipt[] }>('/api/account/orders');
    setOrdersLoading(false);
    if (!res.ok) {
      setOrdersError(res.error);
      return;
    }
    setOrders(Array.isArray(res.data.items) ? res.data.items : []);
  }, [apiRequest]);

  const loadCoupons = useCallback(async () => {
    setCouponsLoading(true);
    setCouponsError(null);
    const res = await apiRequest<{ items?: BoutiqueCoupon[] }>('/api/account/coupons');
    setCouponsLoading(false);
    if (!res.ok) {
      setCouponsError(res.error);
      return;
    }
    setCoupons(Array.isArray(res.data.items) ? res.data.items : []);
  }, [apiRequest]);

  const loadRewards = useCallback(async () => {
    setRewardsLoading(true);
    setRewardsError(null);
    const res = await apiRequest<CustomerRewardsSummary>('/api/account/rewards');
    setRewardsLoading(false);
    if (!res.ok) {
      setRewardsError(res.error);
      return;
    }
    setRewards(res.data);
  }, [apiRequest]);

  const loadPaymentMethods = useCallback(async () => {
    setPaymentLoading(true);
    const res = await apiRequest<SavedPaymentMethodsSummary>('/api/account/payment-methods');
    setPaymentLoading(false);
    if (res.ok) {
      setPaymentSummary(res.data);
    }
  }, [apiRequest]);

  const loadAddresses = useCallback(async () => {
    setAddressesLoading(true);
    setAddressesError(null);
    const res = await apiRequest<{ items?: CustomerAddress[] }>('/api/account/addresses');
    setAddressesLoading(false);
    if (!res.ok) {
      setAddressesError(res.error);
      return;
    }
    setAddresses(Array.isArray(res.data.items) ? res.data.items : []);
  }, [apiRequest]);

  const loadNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    setNotificationsError(null);
    const res = await apiRequest<{ items?: CustomerNotification[]; unreadCount?: number }>(
      '/api/account/notifications'
    );
    setNotificationsLoading(false);
    if (!res.ok) {
      setNotificationsError(res.error);
      return;
    }
    const items = Array.isArray(res.data.items) ? res.data.items : [];
    setNotifications(items);
    setUnreadNotifications(
      typeof res.data.unreadCount === 'number'
        ? res.data.unreadCount
        : items.filter((n) => !n.read).length
    );
    window.dispatchEvent(new Event('sahithi:notifications-updated'));
  }, [apiRequest]);

  useEffect(() => {
    if (!user) return;
    void loadNotifications();
  }, [user, loadNotifications]);

  useEffect(() => {
    if (!user) return;
    if (activeSection === 'orders') void loadOrders();
    if (activeSection === 'coupons') void loadCoupons();
    if (activeSection === 'rewards' || activeSection === 'plus') void loadRewards();
    if (activeSection === 'payments') void loadPaymentMethods();
    if (activeSection === 'addresses') void loadAddresses();
    if (activeSection === 'notifications') void loadNotifications();
  }, [
    user,
    activeSection,
    loadOrders,
    loadCoupons,
    loadRewards,
    loadPaymentMethods,
    loadAddresses,
    loadNotifications,
  ]);

  if (!user) {
    return null;
  }

  const reauthActive = user.recentReauthValid;

  const handleSaveName = async (e: FormEvent) => {
    e.preventDefault();
    setNameFeedback(null);
    const clean = fullName.trim();
    if (clean.length < 2) {
      setNameFeedback({ type: 'err', text: 'Full name must be at least 2 characters.' });
      return;
    }
    setNameSaving(true);
    const res = await updateProfileName(clean);
    setNameSaving(false);
    if (!res.ok) {
      setNameFeedback({ type: 'err', text: res.error });
      return;
    }
    setNameFeedback({ type: 'ok', text: 'Profile name updated.' });
  };

  const handleReauthPassword = async (e: FormEvent) => {
    e.preventDefault();
    setReauthFeedback(null);
    if (!reauthPassword) {
      setReauthFeedback({ type: 'err', text: 'Enter your current password.' });
      return;
    }
    setReauthSubmitting(true);
    const res = await reauthenticateWithPassword(reauthPassword);
    setReauthSubmitting(false);
    if (!res.ok) {
      setReauthFeedback({ type: 'err', text: res.error });
      return;
    }
    setReauthPassword('');
    setReauthFeedback({ type: 'ok', text: 'Identity verified for the next 10 minutes.' });
  };

  const handleLinkEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setEmailFeedback(null);
    const clean = newEmail.trim().toLowerCase();
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setEmailFeedback({ type: 'err', text: 'Please enter a valid email address.' });
      return;
    }
    setEmailSubmitting(true);
    const res = await requestLinkEmail(clean);
    setEmailSubmitting(false);
    if (!res.ok) {
      setEmailFeedback({ type: 'err', text: res.error });
      return;
    }
    setNewEmail('');
    setEmailFeedback({ type: 'ok', text: res.data.message });
  };

  const handleChangePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPassFeedback(null);
    if (newPassword.length < capabilities.passwordMinLength) {
      setPassFeedback({
        type: 'err',
        text: `Password must be at least ${capabilities.passwordMinLength} characters.`,
      });
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPassFeedback({ type: 'err', text: 'Passwords do not match.' });
      return;
    }
    setPassSubmitting(true);
    const res = await changePassword(newPassword);
    setPassSubmitting(false);
    if (!res.ok) {
      setPassFeedback({ type: 'err', text: res.error });
      return;
    }
    setNewPassword('');
    setConfirmNewPassword('');
    setPassFeedback({ type: 'ok', text: res.data.message });
  };

  const handleSubmitOrderRequest = async (e: FormEvent, orderId: string) => {
    e.preventDefault();
    if (requestBusy) return;
    setRequestFeedback(null);
    if (requestReason.trim().length < 5) {
      setRequestFeedback({
        orderId,
        type: 'err',
        text: 'Please describe your reason (at least 5 characters).',
      });
      return;
    }
    setRequestBusy(true);
    const res = await apiRequest<{ order: PlacedOrderReceipt }>(
      `/api/account/orders/${encodeURIComponent(orderId)}/request`,
      {
        method: 'POST',
        body: JSON.stringify({
          type: requestType,
          reason: requestReason.trim(),
        }),
      }
    );
    setRequestBusy(false);
    if (!res.ok) {
      setRequestFeedback({ orderId, type: 'err', text: res.error });
      return;
    }
    setOrders((prev) => prev.map((o) => (o.id === orderId ? res.data.order : o)));
    setRequestOrderId(null);
    setRequestReason('');
    setRequestFeedback({
      orderId,
      type: 'ok',
      text: `${requestType === 'cancel' ? 'Cancellation' : 'Return'} request submitted to the boutique.`,
    });
  };

  const handleSaveAddress = async (e: FormEvent) => {
    e.preventDefault();
    if (addressSaving) return;
    setAddressesError(null);
    setAddressSaving(true);
    const isEditing = Boolean(addressForm.id);
    const endpoint = isEditing
      ? `/api/account/addresses/${encodeURIComponent(addressForm.id)}`
      : '/api/account/addresses';
    const res = await apiRequest<{ address: CustomerAddress }>(endpoint, {
      method: isEditing ? 'PATCH' : 'POST',
      body: JSON.stringify(addressForm),
    });
    setAddressSaving(false);
    if (!res.ok) {
      setAddressesError(res.error);
      return;
    }
    setAddressFormOpen(false);
    setAddressForm(EMPTY_ADDRESS_FORM);
    await loadAddresses();
  };

  const handleDeleteAddress = async (addrId: string) => {
    setAddressesError(null);
    const res = await apiRequest<{ ok: boolean }>(
      `/api/account/addresses/${encodeURIComponent(addrId)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) {
      setAddressesError(res.error);
      return;
    }
    await loadAddresses();
  };

  const handleSetDefaultAddress = async (addr: CustomerAddress) => {
    setAddressesError(null);
    const res = await apiRequest<{ address: CustomerAddress }>(
      `/api/account/addresses/${encodeURIComponent(addr.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ ...addr, isDefault: true }),
      }
    );
    if (!res.ok) {
      setAddressesError(res.error);
      return;
    }
    await loadAddresses();
  };

  const handleGiftCardLookup = async (e: FormEvent) => {
    e.preventDefault();
    if (giftCardBusy) return;
    const clean = giftCardCode.trim().toUpperCase();
    setGiftCardError(null);
    setGiftCardResult(null);
    if (!clean) {
      setGiftCardError('Enter a Sahithi Gift Card code.');
      return;
    }
    setGiftCardBusy(true);
    const res = await apiRequest<{ giftCard: BoutiqueGiftCard }>('/api/gift-cards/check', {
      method: 'POST',
      body: JSON.stringify({ code: clean }),
    });
    setGiftCardBusy(false);
    if (!res.ok) {
      setGiftCardError(res.error);
      return;
    }
    setGiftCardResult(res.data.giftCard);
  };

  const handleMarkNotificationRead = async (notifId: string) => {
    const res = await apiRequest<{ ok: boolean }>(
      `/api/account/notifications/${encodeURIComponent(notifId)}/read`,
      { method: 'PATCH', body: JSON.stringify({}) }
    );
    if (!res.ok) return;
    setNotifications((prev) =>
      prev.map((n) => (n.id === notifId ? { ...n, read: true, readAt: Date.now() } : n))
    );
    setUnreadNotifications((prev) => Math.max(0, prev - 1));
    window.dispatchEvent(new Event('sahithi:notifications-updated'));
  };

  const handleMarkAllRead = async () => {
    const res = await apiRequest<{ ok: boolean }>('/api/account/notifications/read-all', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!res.ok) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true, readAt: Date.now() })));
    setUnreadNotifications(0);
    window.dispatchEvent(new Event('sahithi:notifications-updated'));
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    const redirectTarget = user.isOwner ? '/admin/login' : '/login';
    setLogoutError(null);
    setLoggingOut(true);
    try {
      const res = await logout();
      if (!res.ok) {
        setLogoutError(res.error);
        return;
      }
      setOrders([]);
      setCoupons([]);
      setRewards(null);
      setAddresses([]);
      setNotifications([]);
      setUnreadNotifications(0);
      setPaymentSummary(null);
      setGiftCardResult(null);
      window.dispatchEvent(new Event('sahithi:notifications-updated'));
      onNavigate(redirectTarget, { replace: true });
    } finally {
      setLoggingOut(false);
    }
  };

  const handleSidebarKeyDown = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (idx + 1) % ACCOUNT_MENU_ITEMS.length;
      navButtonRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (idx - 1 + ACCOUNT_MENU_ITEMS.length) % ACCOUNT_MENU_ITEMS.length;
      navButtonRefs.current[prev]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      navButtonRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      navButtonRefs.current[ACCOUNT_MENU_ITEMS.length - 1]?.focus();
    }
  };

  const activeMeta =
    ACCOUNT_MENU_ITEMS.find((m) => m.id === activeSection) || ACCOUNT_MENU_ITEMS[0];
  const LogoutIcon = ACCOUNT_LOGOUT_ITEM.icon;

  const SidebarList = (
    <div className="flex h-full flex-col justify-between p-4 sm:p-5">
      <div>
        <div className="border-b border-[#49243E]/10 pb-4">
          <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#B76E79]">
            Your Account
          </p>
          <p className="mt-1 truncate font-serif text-xl font-semibold text-[#49243E]">
            {user.fullName || 'Boutique Member'}
          </p>
          <p className="truncate text-xs text-[#242124]/65">{user.email}</p>
        </div>

        <nav aria-label="Your Account menu" className="mt-4 space-y-1">
          {ACCOUNT_MENU_ITEMS.map((item, idx) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            const countText =
              item.id === 'notifications' && unreadNotifications > 0
                ? String(unreadNotifications)
                : item.id === 'wishlist' && wishlistCount > 0
                  ? String(wishlistCount)
                  : null;

            return (
              <button
                key={item.id}
                ref={(el) => {
                  navButtonRefs.current[idx] = el;
                }}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onKeyDown={(e) => handleSidebarKeyDown(e, idx)}
                onClick={() => selectSection(item.id)}
                className={`flex min-h-[44px] w-full items-center justify-between gap-2.5 rounded-xl px-3.5 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E] ${
                  isActive
                    ? 'bg-[#49243E] text-[#FFF9F5]'
                    : 'text-[#49243E]/85 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]'
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${isActive ? 'text-[#F3D5DF]' : 'text-[#B76E79]'}`}
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {countText && (
                  <span
                    className={`shrink-0 text-xs font-semibold tabular-nums ${
                      isActive ? 'text-[#F3D5DF]' : 'text-[#B76E79]'
                    }`}
                  >
                    {countText}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="mt-6 space-y-2 border-t border-[#49243E]/10 pt-4">
        <button
          type="button"
          onClick={() => {
            setMobileMenuOpen(false);
            onOpenBag();
          }}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5] px-3 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
        >
          <ShoppingBag className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
          <span>Open Boutique Bag</span>
        </button>
        <button
          type="button"
          disabled={loggingOut}
          onClick={() => void handleLogout()}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#B76E79]/35 bg-white px-3 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/35 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
        >
          {loggingOut ? (
            <Loader2 className="h-4 w-4 animate-spin text-[#B76E79]" aria-hidden="true" />
          ) : (
            <LogoutIcon className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
          )}
          <span>{loggingOut ? 'Logging out…' : ACCOUNT_LOGOUT_ITEM.label}</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#FFF9F5] text-[#242124]">
      <header className="sticky top-0 z-30 border-b border-[#49243E]/10 bg-[#FFF9F5]/95">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:h-20 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open Your Account menu"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#49243E]/15 bg-white text-[#49243E] lg:hidden"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('/')}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium text-[#49243E] transition-colors hover:text-[#B76E79]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Back to Collections</span>
              <span className="sm:hidden">Boutique</span>
            </button>
            <span aria-hidden="true" className="hidden h-4 w-px bg-[#49243E]/15 sm:inline-block" />
            <span className="truncate font-serif text-xl font-semibold tracking-tight text-[#49243E]">
              {SITE_CONFIG.brandName}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {user.isOwner && (
              <button
                type="button"
                onClick={() => onNavigate('/admin')}
                className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-[#49243E]/25 bg-[#F3D5DF]/40 px-3.5 text-xs font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/65"
              >
                <LayoutDashboard className="h-4 w-4 text-[#49243E]" aria-hidden="true" />
                <span className="hidden sm:inline">Admin Dashboard</span>
              </button>
            )}

            <button
              type="button"
              onClick={onOpenWishlist}
              aria-label={`Open wishlist (${wishlistCount} saved items)`}
              className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-[#49243E]/15 bg-white px-3 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30"
            >
              <Heart
                className={`h-4 w-4 ${wishlistCount > 0 ? 'fill-[#B76E79] text-[#B76E79]' : ''}`}
                aria-hidden="true"
              />
              <span className="tabular-nums">Wishlist ({wishlistCount})</span>
            </button>

            <button
              type="button"
              disabled={loggingOut}
              onClick={() => void handleLogout()}
              className="hidden min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl bg-[#49243E] px-3.5 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60 sm:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
            >
              {loggingOut ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LogoutIcon className="h-4 w-4" aria-hidden="true" />
              )}
              <span>{loggingOut ? 'Logging out…' : ACCOUNT_LOGOUT_ITEM.label}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile slide-over account drawer */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 flex bg-[#242124]/45 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Your Account navigation"
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-72 flex-col overflow-y-auto bg-white shadow-2xl"
          >
            <div className="flex justify-end px-4 pt-3">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close Your Account menu"
                className="flex h-10 w-10 items-center justify-center rounded-full text-[#49243E]"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1">{SidebarList}</div>
          </aside>
        </div>
      )}

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:gap-8 lg:px-8 lg:py-10">
        {/* Persistent Desktop Sidebar */}
        <aside className="hidden w-72 shrink-0 self-start rounded-3xl border border-[#49243E]/12 bg-white lg:sticky lg:top-24 lg:block">
          {SidebarList}
        </aside>

        {/* Active Section Canvas */}
        <main className="min-w-0 flex-1 space-y-6">
          {logoutError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 px-4 py-3 text-sm text-[#49243E]"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
              <span>{logoutError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#49243E]/12 pb-5">
            <div>
              <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
                Your Account
              </p>
              <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-4xl">
                {activeMeta.label}
              </h1>
              <p className="mt-1 text-sm text-[#242124]/70">{activeMeta.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#49243E]/18 bg-white px-4 text-xs font-medium text-[#49243E] lg:hidden"
            >
              <Menu className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
              <span>Switch Menu</span>
            </button>
          </div>

          {/* 1. MY PROFILE */}
          {activeSection === 'profile' && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="space-y-6 lg:col-span-5">
                <section className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                      <User className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 className="font-serif text-xl font-semibold text-[#49243E]">
                        Profile Details
                      </h2>
                      <p className="text-xs text-[#242124]/65">Your display name across the boutique</p>
                    </div>
                  </div>

                  <form onSubmit={handleSaveName} className="mt-5 space-y-4">
                    {nameFeedback && (
                      <div
                        role={nameFeedback.type === 'err' ? 'alert' : 'status'}
                        className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${
                          nameFeedback.type === 'err'
                            ? 'border-[#B76E79]/40 bg-[#F3D5DF]/30 text-[#49243E]'
                            : 'border-[#49243E]/18 bg-[#FFF9F5] text-[#49243E]'
                        }`}
                      >
                        {nameFeedback.type === 'err' ? (
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]" />
                        ) : (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#49243E]" />
                        )}
                        <span>{nameFeedback.text}</span>
                      </div>
                    )}

                    <div>
                      <label htmlFor={nameId} className="block text-sm font-medium text-[#49243E]">
                        Full Name
                      </label>
                      <input
                        id={nameId}
                        type="text"
                        required
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        className="mt-1.5 min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] focus:border-[#49243E] focus:bg-white focus:outline-none sm:text-sm"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={nameSaving}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
                    >
                      {nameSaving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                      <span>Save Name</span>
                    </button>
                  </form>
                </section>

                <section className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                      <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 className="font-serif text-xl font-semibold text-[#49243E]">
                        Verify Identity First
                      </h2>
                      <p className="text-xs text-[#242124]/65">
                        {reauthActive
                          ? 'Reauthentication active (valid for up to 10 minutes)'
                          : 'Required before updating your email address or password'}
                      </p>
                    </div>
                  </div>

                  {reauthFeedback && (
                    <div
                      role={reauthFeedback.type === 'err' ? 'alert' : 'status'}
                      className={`mt-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${
                        reauthFeedback.type === 'err'
                          ? 'border-[#B76E79]/40 bg-[#F3D5DF]/30 text-[#49243E]'
                          : 'border-[#49243E]/18 bg-[#FFF9F5] text-[#49243E]'
                      }`}
                    >
                      {reauthFeedback.type === 'err' ? (
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]" />
                      ) : (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#49243E]" />
                      )}
                      <span>{reauthFeedback.text}</span>
                    </div>
                  )}

                  {reauthActive ? (
                    <div className="mt-4 rounded-xl border border-[#49243E]/15 bg-[#FFF9F5] px-4 py-3 text-xs leading-relaxed text-[#49243E]">
                      Your identity is freshly verified. You can update your password or verified email on the right.
                    </div>
                  ) : (
                    <form onSubmit={handleReauthPassword} className="mt-5 space-y-3">
                      <label htmlFor={reauthPassId} className="block text-sm font-medium text-[#49243E]">
                        Reauthenticate with Current Password
                      </label>
                      <div className="relative">
                        <input
                          id={reauthPassId}
                          type={showReauthPassword ? 'text' : 'password'}
                          autoComplete="current-password"
                          value={reauthPassword}
                          onChange={(e) => setReauthPassword(e.target.value)}
                          placeholder="Enter current password"
                          className="min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 pr-11 text-base text-[#242124] focus:border-[#49243E] focus:bg-white focus:outline-none sm:text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setShowReauthPassword((p) => !p)}
                          aria-label={showReauthPassword ? 'Hide password' : 'Show password'}
                          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#49243E]/70"
                        >
                          {showReauthPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <button
                        type="submit"
                        disabled={reauthSubmitting}
                        className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-4 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
                      >
                        {reauthSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                        <span>Verify Password</span>
                      </button>
                    </form>
                  )}
                </section>
              </div>

              <div className="space-y-6 lg:col-span-7">
                <section className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                      <Mail className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 className="font-serif text-xl font-semibold text-[#49243E]">Email Address</h2>
                      <p className="text-xs text-[#242124]/65">
                        {user.email && user.emailVerified
                          ? `Current verified email: ${user.email}`
                          : 'Email verification required'}
                      </p>
                    </div>
                  </div>

                  {capabilities.authMode === 'firebase_managed' ? (
                    <p className="mt-4 rounded-xl border border-[#49243E]/15 bg-[#FFF9F5] px-3.5 py-3 text-xs leading-relaxed text-[#242124]/80">
                      Your primary email is locked to your verified Firebase account. Register and verify a new account if you need a different login email.
                    </p>
                  ) : (
                    <>
                      {emailFeedback && (
                        <div
                          role={emailFeedback.type === 'err' ? 'alert' : 'status'}
                          className={`mt-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${
                            emailFeedback.type === 'err'
                              ? 'border-[#B76E79]/40 bg-[#F3D5DF]/30 text-[#49243E]'
                              : 'border-[#49243E]/18 bg-[#FFF9F5] text-[#49243E]'
                          }`}
                        >
                          {emailFeedback.type === 'err' ? (
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]" />
                          ) : (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#49243E]" />
                          )}
                          <span>{emailFeedback.text}</span>
                        </div>
                      )}
                      <form onSubmit={handleLinkEmailSubmit} className="mt-4 space-y-3">
                        <label htmlFor={linkEmailId} className="block text-sm font-medium text-[#49243E]">
                          Update Verified Email Address
                        </label>
                        <input
                          id={linkEmailId}
                          type="email"
                          autoComplete="email"
                          disabled={!reauthActive}
                          value={newEmail}
                          onChange={(e) => setNewEmail(e.target.value)}
                          placeholder="name@example.com"
                          className="min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] disabled:opacity-55 sm:text-sm"
                        />
                        <button
                          type="submit"
                          disabled={!reauthActive || emailSubmitting || !capabilities.emailDeliveryConfigured}
                          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-55"
                        >
                          {emailSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                          <span>Send Verification Link</span>
                        </button>
                      </form>
                    </>
                  )}
                </section>

                <section className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                      <KeyRound className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 className="font-serif text-xl font-semibold text-[#49243E]">
                        Change Account Password
                      </h2>
                      <p className="text-xs text-[#242124]/65">
                        Update your password (revokes other active sessions)
                      </p>
                    </div>
                  </div>

                  {passFeedback && (
                    <div
                      role={passFeedback.type === 'err' ? 'alert' : 'status'}
                      className={`mt-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${
                        passFeedback.type === 'err'
                          ? 'border-[#B76E79]/40 bg-[#F3D5DF]/30 text-[#49243E]'
                          : 'border-[#49243E]/18 bg-[#FFF9F5] text-[#49243E]'
                      }`}
                    >
                      {passFeedback.type === 'err' ? (
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]" />
                      ) : (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#49243E]" />
                      )}
                      <span>{passFeedback.text}</span>
                    </div>
                  )}

                  <form onSubmit={handleChangePasswordSubmit} className="mt-4 space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor={newPassId} className="block text-sm font-medium text-[#49243E]">
                          New Password
                        </label>
                        <div className="relative mt-1.5">
                          <input
                            id={newPassId}
                            type={showNewPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            disabled={!reauthActive}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder={`At least ${capabilities.passwordMinLength} chars`}
                            className="min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 pr-11 text-base text-[#242124] disabled:opacity-55 sm:text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPassword((p) => !p)}
                            aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#49243E]/70"
                          >
                            {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label htmlFor={confirmNewPassId} className="block text-sm font-medium text-[#49243E]">
                          Confirm Password
                        </label>
                        <input
                          id={confirmNewPassId}
                          type={showNewPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          disabled={!reauthActive}
                          value={confirmNewPassword}
                          onChange={(e) => setConfirmNewPassword(e.target.value)}
                          placeholder="Re-enter password"
                          className="mt-1.5 min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] disabled:opacity-55 sm:text-sm"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={!reauthActive || passSubmitting}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-55"
                    >
                      {passSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                      <span>Update Password</span>
                    </button>
                  </form>
                </section>
              </div>
            </div>
          )}

          {/* 2. ORDERS */}
          {activeSection === 'orders' && (
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-[#242124]/65 tabular-nums">
                  {orders.length} order{orders.length === 1 ? '' : 's'} linked to your account
                </p>
                <button
                  type="button"
                  onClick={() => void loadOrders()}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-[#49243E]/18 bg-white px-3.5 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/35"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${ordersLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span>Refresh Orders</span>
                </button>
              </div>

              {ordersError && (
                <div role="alert" className="rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-4 text-xs text-[#49243E]">
                  {ordersError}
                </div>
              )}

              {ordersLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className="h-32 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
                  ))}
                </div>
              ) : orders.length === 0 ? (
                <div className="rounded-3xl border border-[#49243E]/12 bg-white p-8 text-center">
                  <Package className="mx-auto h-7 w-7 text-[#B76E79]" aria-hidden="true" />
                  <h2 className="mt-3 font-serif text-2xl font-semibold text-[#49243E]">
                    No orders placed under this account yet
                  </h2>
                  <p className="mt-1.5 text-sm text-[#242124]/70">
                    Orders placed while signed in appear here once confirmed online or placed with Cash on Delivery.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate('/')}
                    className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#49243E] px-6 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
                  >
                    Explore Collections
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {orders.map((order) => {
                    const isCod = order.paymentMethod === 'cod';
                    const fulfillment = order.fulfillmentStatus || order.status || 'placed';
                    const payment =
                      order.paymentStatus || (order.razorpayPaymentId ? 'paid' : isCod ? 'unpaid' : 'pending');
                    const isUnpaidCod = isCod && payment !== 'paid';
                    const canRequestCancel = ['placed', 'pending', 'confirmed', 'packed'].includes(fulfillment);
                    const canRequestReturn = fulfillment === 'delivered';
                    const hasOpenRequest = order.returnRequest?.status === 'pending';

                    return (
                      <article
                        key={order.id}
                        className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#49243E]/10 pb-3.5">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-mono text-xs font-semibold text-[#B76E79]">
                                {order.orderNumber}
                              </p>
                              <span className="rounded-md border border-[#49243E]/18 bg-[#FFF9F5] px-2 py-0.5 text-[11px] font-medium text-[#49243E]">
                                {isCod ? 'Cash on Delivery' : 'Online · Razorpay'}
                              </span>
                            </div>
                            <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-[#49243E]">
                              Payment:{' '}
                              {payment === 'paid'
                                ? 'Paid'
                                : isCod
                                  ? 'Payment due on delivery'
                                  : payment}{' '}
                              · Fulfillment: {fulfillment.replace(/_/g, ' ')}
                            </p>
                            <p className="mt-1 text-xs text-[#242124]/65 tabular-nums">
                              Placed {formatTimestamp(order.createdAt)}
                              {order.razorpayPaymentId ? ` · Razorpay ${order.razorpayPaymentId}` : ''}
                              {order.paymentCollectedAt
                                ? ` · Collected ${formatTimestamp(order.paymentCollectedAt)}`
                                : ''}
                            </p>
                          </div>
                          <div className="text-right tabular-nums">
                            <span className="block text-[11px] uppercase tracking-wider text-[#242124]/60">
                              {isUnpaidCod ? 'Amount Due on Delivery' : 'Total Paid'}
                            </span>
                            <span className="font-serif text-2xl font-semibold text-[#49243E]">
                              {formatPaiseINR(order.totalPaise)}
                            </span>
                          </div>
                        </div>

                        <ul className="divide-y divide-[#49243E]/10">
                          {order.items.map((item, idx) => (
                            <li
                              key={`${item.sku}-${idx}`}
                              className="flex items-center justify-between gap-3 py-2 text-xs"
                            >
                              <div className="min-w-0">
                                <span className="font-semibold text-[#49243E]">
                                  {item.productTitle}
                                </span>
                                <span className="text-[#242124]/65">
                                  {' '}
                                  · {item.variantLabel} &times; {item.quantity}
                                </span>
                              </div>
                              <span className="shrink-0 font-semibold tabular-nums text-[#242124]">
                                {formatPaiseINR(item.lineTotalPaise)}
                              </span>
                            </li>
                          ))}
                        </ul>

                        {((order.discountPaise || 0) > 0 || (order.giftCardPaise || 0) > 0) && (
                          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#166534] tabular-nums">
                            {(order.discountPaise || 0) > 0 && (
                              <span>
                                Coupon {order.couponCode || ''}: -{formatPaiseINR(order.discountPaise || 0)}
                              </span>
                            )}
                            {(order.giftCardPaise || 0) > 0 && (
                              <span>
                                Gift Card {order.giftCardCode || ''}: -{formatPaiseINR(order.giftCardPaise || 0)}
                              </span>
                            )}
                          </div>
                        )}

                        {order.shippingAddress && (
                          <p className="text-xs text-[#242124]/70">
                            Delivery Address: {order.shippingAddress}
                          </p>
                        )}

                        {Array.isArray(order.statusHistory) && order.statusHistory.length > 0 && (
                          <div className="rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5]/75 p-3.5">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#49243E]/70">
                              Order Timeline
                            </p>
                            <ul className="mt-2 space-y-1.5 text-xs">
                              {order.statusHistory.map((h, i) => (
                                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2">
                                  <span className="text-[#49243E]">
                                    <strong className="capitalize">{h.status.replace(/_/g, ' ')}</strong>
                                    {h.note ? ` — ${h.note}` : ''}
                                  </span>
                                  <span className="text-[11px] text-[#242124]/55 tabular-nums">
                                    {formatTimestamp(h.at)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {order.returnRequest && (
                          <div className="rounded-2xl border border-[#B76E79]/35 bg-[#FFF9F5] p-3.5 text-xs">
                            <p className="font-semibold text-[#49243E]">
                              {order.returnRequest.type === 'cancel' ? 'Cancellation' : 'Return'} Request ·{' '}
                              <span className="uppercase">{order.returnRequest.status}</span>
                            </p>
                            <p className="mt-1 text-[#242124]/75">Reason: {order.returnRequest.reason}</p>
                            {order.returnRequest.resolutionNote && (
                              <p className="mt-1 text-[#49243E]">
                                Atelier Note: {order.returnRequest.resolutionNote}
                              </p>
                            )}
                          </div>
                        )}

                        {requestFeedback?.orderId === order.id && (
                          <p
                            role={requestFeedback.type === 'err' ? 'alert' : 'status'}
                            className={`text-xs font-medium ${
                              requestFeedback.type === 'err' ? 'text-[#9B2C3E]' : 'text-[#166534]'
                            }`}
                          >
                            {requestFeedback.text}
                          </p>
                        )}

                        {!hasOpenRequest && (canRequestCancel || canRequestReturn) && (
                          <div>
                            {requestOrderId === order.id ? (
                              <form
                                onSubmit={(e) => void handleSubmitOrderRequest(e, order.id)}
                                className="space-y-3 rounded-2xl border border-[#49243E]/15 bg-[#FFF9F5] p-4"
                              >
                                <p className="text-xs font-semibold text-[#49243E]">
                                  Submit {requestType === 'cancel' ? 'Cancellation' : 'Return'} Request
                                </p>
                                <textarea
                                  rows={2}
                                  required
                                  value={requestReason}
                                  onChange={(e) => setRequestReason(e.target.value)}
                                  placeholder="Share details so our boutique team can review quickly…"
                                  className="w-full rounded-xl border border-[#49243E]/18 bg-white p-3 text-xs focus:border-[#49243E] focus:outline-none"
                                />
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="submit"
                                    disabled={requestBusy}
                                    className="inline-flex min-h-[40px] items-center rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
                                  >
                                    {requestBusy ? 'Submitting…' : 'Submit Request'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setRequestOrderId(null);
                                      setRequestReason('');
                                    }}
                                    className="inline-flex min-h-[40px] items-center rounded-xl border border-[#49243E]/20 bg-white px-4 text-xs font-medium text-[#49243E]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                {canRequestCancel && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setRequestType('cancel');
                                      setRequestOrderId(order.id);
                                      setRequestReason('');
                                    }}
                                    className="inline-flex min-h-[40px] items-center rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-4 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                                  >
                                    Request Cancellation
                                  </button>
                                )}
                                {canRequestReturn && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setRequestType('return');
                                      setRequestOrderId(order.id);
                                      setRequestReason('');
                                    }}
                                    className="inline-flex min-h-[40px] items-center rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-4 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                                  >
                                    Request Return
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* 3. COUPONS */}
          {activeSection === 'coupons' && (
            <section className="space-y-4">
              {couponsError && (
                <div role="alert" className="rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-4 text-xs text-[#49243E]">
                  {couponsError}
                </div>
              )}
              {couponsLoading ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="h-32 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
                  <div className="h-32 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
                </div>
              ) : coupons.length === 0 ? (
                <div className="rounded-3xl border border-[#49243E]/12 bg-white p-8 text-center">
                  <Tag className="mx-auto h-7 w-7 text-[#B76E79]" aria-hidden="true" />
                  <h2 className="mt-3 font-serif text-2xl font-semibold text-[#49243E]">
                    No active coupons right now
                  </h2>
                  <p className="mt-1.5 text-sm text-[#242124]/70">
                    When the Sahithi atelier releases seasonal or member promotions, valid coupon codes appear here.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {coupons.map((c) => {
                    const valueLabel =
                      c.discountType === 'percent'
                        ? `${c.discountValue}% OFF`
                        : `${formatPaiseINR(c.discountValue)} OFF`;
                    const isCopied = copiedCoupon === c.code;
                    return (
                      <div
                        key={c.id}
                        className="flex flex-col justify-between gap-4 rounded-3xl border border-[#49243E]/12 bg-white p-5"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm font-bold tracking-wider text-[#49243E]">
                              {c.code}
                            </span>
                            <span className="text-xs font-semibold uppercase tracking-wider text-[#B76E79] tabular-nums">
                              {valueLabel}
                            </span>
                          </div>
                          <h3 className="mt-1.5 font-serif text-lg font-semibold text-[#49243E]">
                            {c.title}
                          </h3>
                          {c.description && (
                            <p className="mt-1 text-xs text-[#242124]/75">{c.description}</p>
                          )}
                          <p className="mt-2 text-[11px] text-[#242124]/60 tabular-nums">
                            {c.minSpendPaise > 0
                              ? `Min bag ${formatPaiseINR(c.minSpendPaise)}`
                              : 'No minimum spend'}
                            {c.expiresAt ? ` · Valid until ${formatTimestamp(c.expiresAt)}` : ''}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                if (navigator.clipboard?.writeText) {
                                  await navigator.clipboard.writeText(c.code);
                                } else {
                                  const el = document.createElement('textarea');
                                  el.value = c.code;
                                  el.setAttribute('readonly', '');
                                  el.style.position = 'absolute';
                                  el.style.left = '-9999px';
                                  document.body.appendChild(el);
                                  el.select();
                                  document.execCommand('copy');
                                  document.body.removeChild(el);
                                }
                                setCopiedCoupon(c.code);
                                window.setTimeout(() => setCopiedCoupon(null), 2000);
                              } catch {
                                setCopiedCoupon(c.code);
                              }
                            }}
                            className="inline-flex min-h-[42px] flex-1 items-center justify-center gap-2 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] px-4 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                          >
                            {isCopied ? (
                              <Check className="h-3.5 w-3.5 text-[#166534]" aria-hidden="true" />
                            ) : (
                              <Copy className="h-3.5 w-3.5 text-[#B76E79]" aria-hidden="true" />
                            )}
                            <span>{isCopied ? 'Code Copied' : 'Copy Code'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={onOpenBag}
                            className="inline-flex min-h-[42px] items-center justify-center rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                          >
                            Apply in Bag
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* 4. SAHITHI REWARDS */}
          {activeSection === 'rewards' && (
            <section className="space-y-4">
              {rewardsError && (
                <div role="alert" className="rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-4 text-xs text-[#49243E]">
                  {rewardsError}
                </div>
              )}
              {rewardsLoading || !rewards ? (
                <div className="h-44 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="rounded-3xl border border-[#49243E]/12 bg-white p-5">
                      <p className="text-xs font-medium uppercase tracking-wider text-[#B76E79]">
                        Available Points
                      </p>
                      <p className="mt-2 font-serif text-3xl font-semibold tabular-nums text-[#49243E]">
                        {rewards.pointsBalance.toLocaleString('en-IN')}
                      </p>
                      <p className="mt-1 text-xs text-[#242124]/65 tabular-nums">
                        Est. value {formatPaiseINR(rewards.pointsBalance * (rewards.config.rupeeValuePerPointPaise || 100))}
                      </p>
                    </div>
                    <div className="rounded-3xl border border-[#49243E]/12 bg-white p-5">
                      <p className="text-xs font-medium uppercase tracking-wider text-[#B76E79]">
                        Qualifying Spend
                      </p>
                      <p className="mt-2 font-serif text-3xl font-semibold tabular-nums text-[#49243E]">
                        {formatPaiseINR(rewards.lifetimeSpendPaise)}
                      </p>
                      <p className="mt-1 text-xs text-[#242124]/65 tabular-nums">
                        From paid non-cancelled orders
                      </p>
                    </div>
                    <div className="rounded-3xl border border-[#49243E]/12 bg-white p-5">
                      <p className="text-xs font-medium uppercase tracking-wider text-[#B76E79]">
                        Earn Rate
                      </p>
                      <p className="mt-2 font-serif text-3xl font-semibold tabular-nums text-[#49243E]">
                        {rewards.config.rewardsEnabled ? `${rewards.config.pointsPerHundredInr} pts` : 'Paused'}
                      </p>
                      <p className="mt-1 text-xs text-[#242124]/65">Per ₹100 spent</p>
                    </div>
                  </div>

                  {rewards.lifetimeSpendPaise === 0 && (
                    <div className="rounded-3xl border border-[#49243E]/12 bg-white p-6 text-sm text-[#242124]/75">
                      You have no qualifying paid orders yet. Paid Razorpay orders and Cash on Delivery orders once payment is collected automatically earn Sahithi Rewards points under your active loyalty tier.
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 5. SAHITHI PLUS */}
          {activeSection === 'plus' && (
            <section className="space-y-4">
              {rewardsLoading || !rewards ? (
                <div className="h-44 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
              ) : (
                <div className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#49243E]/10 pb-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-[#B76E79]">
                        {rewards.config.plusTierName}
                      </p>
                      <h2 className="mt-1 font-serif text-2xl font-semibold text-[#49243E]">
                        {rewards.plusStatusLabel}
                      </h2>
                    </div>
                    <span className="text-xs font-semibold text-[#49243E] tabular-nums">
                      {formatPaiseINR(rewards.plusProgressPaise)} /{' '}
                      {formatPaiseINR(rewards.config.plusQualificationSpendPaise)}
                    </span>
                  </div>

                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#F3D5DF]/45">
                    <div
                      className="h-full bg-[#49243E] transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round(
                            (rewards.plusProgressPaise /
                              Math.max(100, rewards.config.plusQualificationSpendPaise)) *
                              100
                          )
                        )}%`,
                      }}
                    />
                  </div>

                  <div className="pt-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[#49243E]/75">
                      Program Benefits
                    </h3>
                    {rewards.config.plusBenefits.length === 0 ? (
                      <p className="mt-2 text-xs text-[#242124]/65">
                        No tier benefits configured yet.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2 text-sm text-[#242124]/85">
                        {rewards.config.plusBenefits.map((benefit, idx) => (
                          <li key={idx} className="flex items-start gap-2">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                            <span>{benefit}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 6. SAVED CARDS & WALLET */}
          {activeSection === 'payments' && (
            <section className="space-y-4">
              <div className="rounded-3xl border border-[#49243E]/12 bg-white p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#49243E]/10 pb-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                      <CreditCard className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 className="font-serif text-xl font-semibold text-[#49243E]">
                        Checkout Methods &amp; Saved Cards
                      </h2>
                      <p className="text-xs text-[#242124]/65">
                        PCI-compliant payments via Razorpay Checkout &amp; Cash on Delivery
                      </p>
                    </div>
                  </div>
                  <span className="rounded-lg border border-[#49243E]/18 bg-[#FFF9F5] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#49243E]">
                    {paymentSummary?.enabled ? 'Vault Enabled' : 'Razorpay Standard'}
                  </span>
                </div>

                {paymentLoading ? (
                  <div className="h-28 animate-pulse rounded-2xl bg-[#FFF9F5]" />
                ) : (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5]/80 p-4">
                        <div className="flex items-center gap-2 text-sm font-semibold text-[#49243E]">
                          <CreditCard className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                          <span>Online Checkout (Razorpay)</span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-[#242124]/75">
                          UPI (GPay, PhonePe, BHIM), Credit &amp; Debit Cards, NetBanking, and supported Wallets open directly inside encrypted Razorpay Checkout at payment time.
                        </p>
                      </div>
                      <div className="rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5]/80 p-4">
                        <div className="flex items-center gap-2 text-sm font-semibold text-[#49243E]">
                          <Banknote className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                          <span>Cash on Delivery (COD)</span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-[#242124]/75">
                          Available directly inside your Boutique Bag with complimentary delivery and ₹0 COD fee. Pay when your order arrives.
                        </p>
                      </div>
                    </div>

                    {paymentSummary?.enabled && paymentSummary.methods.length > 0 ? (
                      <div className="space-y-2.5">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#49243E]/75">
                          Tokenized Saved Methods
                        </h3>
                        <ul className="space-y-2">
                          {paymentSummary.methods.map((method) => (
                            <li
                              key={method.id}
                              className="flex items-center justify-between rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5] px-4 py-3 text-xs"
                            >
                              <div>
                                <p className="font-semibold text-[#49243E]">
                                  {method.label}
                                  {method.last4 ? ` · •••• ${method.last4}` : ''}
                                </p>
                                <p className="text-[#242124]/65">
                                  {[method.network, method.expiry ? `Exp ${method.expiry}` : '']
                                    .filter(Boolean)
                                    .join(' · ') || method.methodType.toUpperCase()}
                                </p>
                              </div>
                              <span className="font-medium text-[#166534]">Tokenized via Razorpay</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5] p-4 space-y-1.5">
                        <p className="text-xs font-semibold uppercase tracking-wider text-[#B76E79]">
                          {paymentSummary?.enabled
                            ? 'No Saved Cards on File Yet'
                            : 'Saved Card Tokenization · Pending Merchant Activation'}
                        </p>
                        <p className="text-sm leading-relaxed text-[#242124]/80">
                          {paymentSummary?.reason ||
                            'Sahithi Collections processes all cards inside PCI-compliant Razorpay Checkout without collecting raw card details on this site. Tokenized saved-card vaulting will activate here once Razorpay Customer Vault is enabled on the merchant account.'}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {/* 7. SAVED ADDRESSES */}
          {activeSection === 'addresses' && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-[#242124]/65 tabular-nums">
                  {addresses.length} saved address{addresses.length === 1 ? '' : 'es'}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setAddressForm({
                      ...EMPTY_ADDRESS_FORM,
                      fullName: user.fullName || '',
                    });
                    setAddressFormOpen(true);
                  }}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Add Address</span>
                </button>
              </div>

              {addressesError && (
                <div role="alert" className="rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-4 text-xs text-[#49243E]">
                  {addressesError}
                </div>
              )}

              {addressFormOpen && (
                <form
                  onSubmit={handleSaveAddress}
                  className="space-y-3 rounded-3xl border border-[#49243E]/15 bg-white p-5 sm:p-6"
                >
                  <h2 className="font-serif text-xl font-semibold text-[#49243E]">
                    {addressForm.id ? 'Edit Delivery Address' : 'Add Delivery Address'}
                  </h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <input
                      type="text"
                      required
                      value={addressForm.fullName}
                      onChange={(e) => setAddressForm((p) => ({ ...p, fullName: e.target.value }))}
                      placeholder="Recipient Full Name"
                      className="min-h-[44px] rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                    />
                    <input
                      type="tel"
                      required
                      value={addressForm.phone}
                      onChange={(e) => setAddressForm((p) => ({ ...p, phone: e.target.value }))}
                      placeholder="Phone (+91...)"
                      className="min-h-[44px] rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                    />
                  </div>
                  <input
                    type="text"
                    required
                    value={addressForm.line1}
                    onChange={(e) => setAddressForm((p) => ({ ...p, line1: e.target.value }))}
                    placeholder="House / Flat No., Building, Street"
                    className="min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                  />
                  <input
                    type="text"
                    value={addressForm.line2}
                    onChange={(e) => setAddressForm((p) => ({ ...p, line2: e.target.value }))}
                    placeholder="Area / Colony (Optional)"
                    className="min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                  />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <input
                      type="text"
                      required
                      value={addressForm.city}
                      onChange={(e) => setAddressForm((p) => ({ ...p, city: e.target.value }))}
                      placeholder="City"
                      className="min-h-[44px] rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                    />
                    <input
                      type="text"
                      required
                      value={addressForm.state}
                      onChange={(e) => setAddressForm((p) => ({ ...p, state: e.target.value }))}
                      placeholder="State"
                      className="min-h-[44px] rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                    />
                    <input
                      type="text"
                      required
                      value={addressForm.pincode}
                      onChange={(e) => setAddressForm((p) => ({ ...p, pincode: e.target.value }))}
                      placeholder="PIN Code"
                      className="min-h-[44px] rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <input
                      type="text"
                      value={addressForm.landmark}
                      onChange={(e) => setAddressForm((p) => ({ ...p, landmark: e.target.value }))}
                      placeholder="Landmark (Optional)"
                      className="min-h-[44px] rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm"
                    />
                    <select
                      aria-label="Address label"
                      value={addressForm.label}
                      onChange={(e) =>
                        setAddressForm((p) => ({
                          ...p,
                          label: e.target.value as 'Home' | 'Work' | 'Other',
                        }))
                      }
                      className="min-h-[44px] rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-sm text-[#49243E]"
                    >
                      <option value="Home">Home</option>
                      <option value="Work">Work</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <label className="flex min-h-[40px] items-center gap-2 text-xs font-medium text-[#49243E]">
                    <input
                      type="checkbox"
                      checked={addressForm.isDefault}
                      onChange={(e) => setAddressForm((p) => ({ ...p, isDefault: e.target.checked }))}
                    />
                    <span>Set as default delivery address</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="submit"
                      disabled={addressSaving}
                      className="inline-flex min-h-[44px] items-center rounded-xl bg-[#49243E] px-5 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
                    >
                      {addressSaving ? 'Saving…' : 'Save Address'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddressFormOpen(false);
                        setAddressForm(EMPTY_ADDRESS_FORM);
                      }}
                      className="inline-flex min-h-[44px] items-center rounded-xl border border-[#49243E]/20 bg-white px-4 text-xs font-medium text-[#49243E]"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {addressesLoading ? (
                <div className="h-32 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
              ) : addresses.length === 0 ? (
                <div className="rounded-3xl border border-[#49243E]/12 bg-white p-8 text-center">
                  <MapPin className="mx-auto h-7 w-7 text-[#B76E79]" aria-hidden="true" />
                  <h2 className="mt-3 font-serif text-2xl font-semibold text-[#49243E]">
                    No saved addresses yet
                  </h2>
                  <p className="mt-1.5 text-sm text-[#242124]/70">
                    Add your delivery address to pre-fill Boutique Bag checkout automatically.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {addresses.map((addr) => (
                    <div
                      key={addr.id}
                      className="flex flex-col justify-between gap-3 rounded-3xl border border-[#49243E]/12 bg-white p-5"
                    >
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-[#B76E79]">
                          {addr.label}
                          {addr.isDefault ? ' · Default' : ''}
                        </p>
                        <h3 className="mt-1 font-serif text-lg font-semibold text-[#49243E]">
                          {addr.fullName}
                        </h3>
                        <p className="mt-1 text-xs leading-relaxed text-[#242124]/75">
                          {addr.line1}
                          {addr.line2 ? `, ${addr.line2}` : ''}, {addr.city}, {addr.state} -{' '}
                          {addr.pincode}
                          {addr.landmark ? ` (${addr.landmark})` : ''}
                        </p>
                        <p className="mt-1 text-xs font-medium text-[#49243E] tabular-nums">
                          {addr.phone}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 border-t border-[#49243E]/10 pt-3">
                        {!addr.isDefault && (
                          <button
                            type="button"
                            onClick={() => void handleSetDefaultAddress(addr)}
                            className="inline-flex min-h-[38px] items-center rounded-lg border border-[#49243E]/20 px-3 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5]"
                          >
                            Set Default
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setAddressForm({
                              id: addr.id,
                              fullName: addr.fullName,
                              phone: addr.phone,
                              line1: addr.line1,
                              line2: addr.line2 || '',
                              city: addr.city,
                              state: addr.state,
                              pincode: addr.pincode,
                              landmark: addr.landmark || '',
                              label: addr.label,
                              isDefault: addr.isDefault,
                            });
                            setAddressFormOpen(true);
                          }}
                          className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[#49243E]/20 px-3 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5]"
                        >
                          <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteAddress(addr.id)}
                          className="inline-flex min-h-[38px] items-center gap-1 rounded-lg px-3 text-xs font-medium text-[#9B2C3E] hover:bg-[#F3D5DF]/40"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 8. WISHLIST */}
          {activeSection === 'wishlist' && (
            <section className="space-y-4">
              {wishlistProducts.length === 0 ? (
                <div className="rounded-3xl border border-[#49243E]/12 bg-white p-8 text-center">
                  <Heart className="mx-auto h-7 w-7 text-[#B76E79]" aria-hidden="true" />
                  <h2 className="mt-3 font-serif text-2xl font-semibold text-[#49243E]">
                    Your cloud wishlist is empty
                  </h2>
                  <p className="mt-1.5 text-sm text-[#242124]/70">
                    Pieces you heart are synced to your account so you can access them on any device.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate('/')}
                    className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#49243E] px-6 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
                  >
                    Browse Collections
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {wishlistProducts.map((product) => {
                    const defaultVariant = product.variants?.[0];
                    const pricePaise =
                      defaultVariant?.pricePaise ?? product.pricePaise ?? Math.round(product.price * 100);
                    return (
                      <div
                        key={product.id}
                        className="flex gap-4 rounded-3xl border border-[#49243E]/12 bg-white p-4"
                      >
                        <div className="h-28 w-24 shrink-0 overflow-hidden rounded-2xl bg-[#F8F1ED]">
                          <BoutiqueImage
                            src={product.images[0]?.src || ''}
                            alt={product.images[0]?.alt || product.name}
                            className="h-full w-full object-cover object-top"
                          />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-between">
                          <div>
                            <p className="text-[11px] font-medium uppercase tracking-wider text-[#B76E79]">
                              {product.category}
                            </p>
                            <h3 className="mt-0.5 line-clamp-2 font-serif text-base font-semibold text-[#49243E]">
                              {product.name}
                            </h3>
                            <p className="mt-1 text-sm font-semibold tabular-nums text-[#242124]">
                              {formatINR(product.price)}
                            </p>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={!product.inStock}
                              onClick={() => {
                                onAddToBag({
                                  productId: product.id,
                                  variantId: defaultVariant?.id || product.id,
                                  quantity: 1,
                                  seenPricePaise: pricePaise,
                                  fallbackTitle: product.name,
                                  fallbackVariant: defaultVariant
                                    ? `${defaultVariant.size} · ${defaultVariant.colorName}`
                                    : `${product.sizes[0] || 'Standard'} · ${product.colors[0]?.name || 'Signature'}`,
                                  fallbackImage: product.images[0]?.src || '',
                                });
                                setMovedProductId(product.id);
                                window.setTimeout(() => setMovedProductId(null), 2500);
                              }}
                              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[#49243E] px-3 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-50"
                            >
                              <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>{movedProductId === product.id ? 'Added to Bag' : 'Move to Bag'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onRemoveWishlistItem(product.id)}
                              className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Remove</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* 9. GIFT CARDS */}
          {activeSection === 'gift-cards' && (
            <section className="rounded-3xl border border-[#49243E]/12 bg-white p-6 space-y-5">
              <div>
                <h2 className="font-serif text-xl font-semibold text-[#49243E]">
                  Check Sahithi Gift Card Balance
                </h2>
                <p className="mt-1 text-xs text-[#242124]/65">
                  Enter an official Sahithi Gift Card code to view its live remaining balance and validity.
                </p>
              </div>

              <form onSubmit={handleGiftCardLookup} className="flex flex-col gap-3 sm:flex-row">
                <label htmlFor={giftLookupId} className="sr-only">
                  Gift card code
                </label>
                <input
                  id={giftLookupId}
                  type="text"
                  value={giftCardCode}
                  onChange={(e) => setGiftCardCode(e.target.value.toUpperCase())}
                  placeholder="Enter Gift Card Code (e.g. SAHITHI-GIFT-500)"
                  className="min-h-[44px] flex-1 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 font-mono text-sm uppercase text-[#49243E]"
                />
                <button
                  type="submit"
                  disabled={giftCardBusy}
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
                >
                  {giftCardBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <span>Check Balance</span>
                </button>
              </form>

              {giftCardError && (
                <div role="alert" className="rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-4 text-xs text-[#49243E]">
                  {giftCardError}
                </div>
              )}

              {giftCardResult && (
                <div className="rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5] p-4 space-y-2 text-xs">
                  <p className="font-mono text-sm font-bold text-[#49243E]">{giftCardResult.code}</p>
                  <p className="font-serif text-2xl font-semibold tabular-nums text-[#49243E]">
                    Available Balance: {formatPaiseINR(giftCardResult.balancePaise)}
                  </p>
                  <p className="text-[#242124]/70 tabular-nums">
                    Original Value: {formatPaiseINR(giftCardResult.initialBalancePaise)}
                    {giftCardResult.expiresAt
                      ? ` · Expires ${formatTimestamp(giftCardResult.expiresAt)}`
                      : ' · No expiry'}
                  </p>
                  {giftCardResult.note && <p className="text-[#49243E]">{giftCardResult.note}</p>}
                </div>
              )}
            </section>
          )}

          {/* 10. NOTIFICATIONS */}
          {activeSection === 'notifications' && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-[#242124]/65 tabular-nums">
                  {unreadNotifications} unread notification{unreadNotifications === 1 ? '' : 's'}
                </p>
                {unreadNotifications > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleMarkAllRead()}
                    className="inline-flex min-h-[40px] items-center rounded-xl border border-[#49243E]/20 bg-white px-4 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/35"
                  >
                    Mark All Read
                  </button>
                )}
              </div>

              {notificationsError && (
                <div role="alert" className="rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-4 text-xs text-[#49243E]">
                  {notificationsError}
                </div>
              )}

              {notificationsLoading ? (
                <div className="h-32 animate-pulse rounded-3xl border border-[#49243E]/12 bg-white" />
              ) : notifications.length === 0 ? (
                <div className="rounded-3xl border border-[#49243E]/12 bg-white p-8 text-center">
                  <Bell className="mx-auto h-7 w-7 text-[#B76E79]" aria-hidden="true" />
                  <h2 className="mt-3 font-serif text-2xl font-semibold text-[#49243E]">
                    No notifications yet
                  </h2>
                  <p className="mt-1.5 text-sm text-[#242124]/70">
                    Order confirmations, shipping milestones, and request updates appear here.
                  </p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {notifications.map((notif) => (
                    <li
                      key={notif.id}
                      className={`flex flex-wrap items-start justify-between gap-3 rounded-3xl border p-5 ${
                        notif.read
                          ? 'border-[#49243E]/10 bg-white'
                          : 'border-[#B76E79]/45 bg-[#FFF9F5]'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase tracking-wider text-[#B76E79]">
                          {notif.read ? 'Read' : 'New Update'} ·{' '}
                          <span className="tabular-nums text-[#242124]/55">
                            {formatTimestamp(notif.createdAt)}
                          </span>
                        </p>
                        <h3 className="mt-1 font-serif text-lg font-semibold text-[#49243E]">
                          {notif.title}
                        </h3>
                        <p className="mt-1 text-xs leading-relaxed text-[#242124]/80">
                          {notif.message}
                        </p>
                      </div>
                      {!notif.read && (
                        <button
                          type="button"
                          onClick={() => void handleMarkNotificationRead(notif.id)}
                          className="inline-flex min-h-[38px] shrink-0 items-center rounded-xl border border-[#49243E]/20 bg-white px-3.5 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                        >
                          Mark Read
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
