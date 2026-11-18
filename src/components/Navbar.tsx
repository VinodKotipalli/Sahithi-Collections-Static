import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  AlertCircle,
  ChevronDown,
  Heart,
  LayoutDashboard,
  Loader2,
  Menu,
  Search,
  ShoppingBag,
  User,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ACCOUNT_LOGOUT_ITEM,
  ACCOUNT_MENU_ITEMS,
} from '../config/accountMenu';
import { useAuth } from '../context/AuthContext';
import { useStorefront } from '../context/StorefrontContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';

interface NavbarProps {
  wishlistCount: number;
  bagCount: number;
  onOpenWishlist: () => void;
  onOpenBag: () => void;
  onOpenSearch: () => void;
  onNavigateAuth: (
    target: string,
    options?: { replace?: boolean }
  ) => void;
  onNavigateSection?: (href: string) => void;
}

const NAV_LINKS = [
  { label: 'Home', href: '#home' },
  { label: 'Collections', href: '#collections' },
  { label: 'New Arrivals', href: '#new-arrivals' },
  { label: 'Lookbook', href: '#lookbook' },
  { label: 'About', href: '#about' },
  { label: 'Contact', href: '#contact' },
] as const;

export function Navbar({
  wishlistCount,
  bagCount,
  onOpenWishlist,
  onOpenBag,
  onOpenSearch,
  onNavigateAuth,
  onNavigateSection,
}: NavbarProps) {
  const { user, apiRequest, logout } = useAuth();
  const { settings } = useStorefront();
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [activeHash, setActiveHash] = useState('#home');
  const mobileDrawerRef = useRef<HTMLDivElement>(null);
  const mobileAccountSectionRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const desktopDropdownRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useFocusTrap(mobileMenuOpen, mobileDrawerRef, () => {
    if (!signingOut) {
      setSignOutError(null);
      setMobileMenuOpen(false);
    }
  });

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 36);
    };
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!user) {
      setUnreadNotifications(0);
      return;
    }
    let cancelled = false;
    const loadUnread = () => {
      void apiRequest<{ unreadCount?: number }>('/api/account/notifications').then((res) => {
        if (!cancelled && res.ok) {
          setUnreadNotifications(Math.max(0, Number(res.data.unreadCount || 0)));
        }
      });
    };
    loadUnread();
    const handleUpdated = () => loadUnread();
    window.addEventListener('sahithi:notifications-updated', handleUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('sahithi:notifications-updated', handleUpdated);
    };
  }, [user, apiRequest]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (signingOut) return;
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setSignOutError(null);
        setAccountMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (signingOut) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setSignOutError(null);
        setAccountMenuOpen(false);
        accountTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [accountMenuOpen, signingOut]);

  const handleDesktopMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const container = desktopDropdownRef.current;
    if (!container) return;
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
    );
    if (items.length === 0) return;
    const currentIndex = items.findIndex((el) => el === document.activeElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIdx = currentIndex === -1 ? 0 : (currentIndex + 1) % items.length;
      items[nextIdx]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prevIdx =
        currentIndex === -1 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      items[prevIdx]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const handleNavClick = (href: string) => {
    setActiveHash(href);
    setMobileMenuOpen(false);
    if (onNavigateSection) {
      onNavigateSection(href);
    }
  };

  const displayFirstName = user?.fullName
    ? user.fullName.trim().split(/\s+/)[0]
    : user?.email
      ? user.email.split('@')[0]
      : 'Account';

  const handleSignOut = async () => {
    if (signingOut) return;
    const redirectTarget = user?.isOwner ? '/admin/login' : '/login';
    setSignOutError(null);
    setSigningOut(true);
    try {
      const res = await logout();
      if (!res.ok) {
        setSignOutError(res.error);
        return;
      }
      setAccountMenuOpen(false);
      setMobileMenuOpen(false);
      onNavigateAuth(redirectTarget, { replace: true });
    } finally {
      setSigningOut(false);
    }
  };

  const openMobileDrawerToAccount = () => {
    setMobileMenuOpen(true);
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        mobileAccountSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
    });
  };

  const LogoutIcon = ACCOUNT_LOGOUT_ITEM.icon;

  return (
    <>
      <header
        className={`fixed top-0 left-0 right-0 z-40 transition-colors duration-300 ${
          isScrolled
            ? 'bg-[#FFF9F5]/97 border-b border-[#49243E]/10 shadow-[0_6px_24px_-12px_rgba(73,36,62,0.12)]'
            : 'bg-transparent border-b border-transparent'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:h-20 lg:px-8">
          <a
            href="#home"
            onClick={(e) => {
              if (onNavigateSection) {
                e.preventDefault();
              }
              handleNavClick('#home');
            }}
            className="flex items-center gap-2.5 font-serif text-xl font-semibold tracking-tight text-[#49243E] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E] rounded-lg sm:text-2xl"
          >
            {settings.logoUrl && (
              <img
                src={settings.logoUrl}
                alt=""
                className="h-8 w-8 rounded-full border border-[#49243E]/15 object-cover"
              />
            )}
            <span>{settings.brandName}</span>
          </a>

          <nav aria-label="Primary navigation" className="hidden lg:flex items-center gap-7">
            {NAV_LINKS.map((item) => {
              const isActive = activeHash === item.href;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={(e) => {
                    if (onNavigateSection) {
                      e.preventDefault();
                    }
                    handleNavClick(item.href);
                  }}
                  className="group relative py-1.5 text-sm font-medium text-[#242124]/85 transition-colors duration-200 hover:text-[#49243E] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E] rounded"
                >
                  {item.label}
                  <span
                    aria-hidden="true"
                    className={`absolute bottom-0 left-0 h-[1.5px] w-full origin-left bg-[#B76E79] transition-transform duration-200 ease-out ${
                      isActive ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                    }`}
                  />
                </a>
              );
            })}
          </nav>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenSearch}
              aria-label="Search products"
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
            >
              <Search className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={onOpenWishlist}
              aria-label={`Open wishlist (${wishlistCount} saved items)`}
              className="relative flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
            >
              <Heart
                className={`h-[18px] w-[18px] transition-colors ${
                  wishlistCount > 0 ? 'fill-[#B76E79] text-[#B76E79]' : ''
                }`}
                aria-hidden="true"
              />
              {wishlistCount > 0 && (
                <span className="text-xs font-semibold tabular-nums text-[#49243E]">
                  {wishlistCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={onOpenBag}
              aria-label={`Open shopping bag (${bagCount} items)`}
              className="relative flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
            >
              <ShoppingBag className="h-[18px] w-[18px]" aria-hidden="true" />
              {bagCount > 0 && (
                <span className="text-xs font-semibold tabular-nums text-[#49243E]">
                  {bagCount}
                </span>
              )}
            </button>

            {user ? (
              <div ref={accountMenuRef} className="relative hidden sm:block">
                <button
                  ref={accountTriggerRef}
                  type="button"
                  aria-expanded={accountMenuOpen}
                  aria-haspopup="menu"
                  aria-controls="desktop-your-account-menu"
                  onClick={() => {
                    if (signingOut) return;
                    setSignOutError(null);
                    setAccountMenuOpen((prev) => {
                      const next = !prev;
                      if (next) {
                        window.requestAnimationFrame(() => {
                          const firstItem =
                            desktopDropdownRef.current?.querySelector<HTMLButtonElement>(
                              'button[role="menuitem"]'
                            );
                          firstItem?.focus();
                        });
                      }
                      return next;
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSignOutError(null);
                      setAccountMenuOpen(true);
                      window.requestAnimationFrame(() => {
                        const firstItem =
                          desktopDropdownRef.current?.querySelector<HTMLButtonElement>(
                            'button[role="menuitem"]'
                          );
                        firstItem?.focus();
                      });
                    }
                  }}
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-[#49243E]/18 bg-[#FFF9F5]/90 px-3.5 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/45 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                >
                  <User className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                  <span className="max-w-[120px] truncate">{displayFirstName}</span>
                  {unreadNotifications > 0 && (
                    <span
                      aria-label={`${unreadNotifications} unread notifications`}
                      className="text-xs font-semibold tabular-nums text-[#B76E79]"
                    >
                      ({unreadNotifications})
                    </span>
                  )}
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-[#49243E]/70 transition-transform duration-150 ${
                      accountMenuOpen ? 'rotate-180' : ''
                    }`}
                    aria-hidden="true"
                  />
                </button>

                {accountMenuOpen && (
                  <div
                    id="desktop-your-account-menu"
                    ref={desktopDropdownRef}
                    role="menu"
                    aria-label="Your Account"
                    onKeyDown={handleDesktopMenuKeyDown}
                    className="absolute right-0 mt-2 w-72 rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5] p-2 shadow-[0_20px_48px_-16px_rgba(73,36,62,0.28)]"
                  >
                    <div className="border-b border-[#49243E]/10 px-3 py-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#B76E79]">
                        Your Account
                      </p>
                      <p className="mt-0.5 truncate font-serif text-base font-semibold text-[#49243E]">
                        {user.fullName || 'Boutique Member'}
                      </p>
                      <p className="truncate text-[11px] text-[#242124]/60">{user.email}</p>
                    </div>

                    {user.isOwner && (
                      <div className="border-b border-[#49243E]/10 py-1.5">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setAccountMenuOpen(false);
                            onNavigateAuth('/admin/dashboard');
                          }}
                          className="flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                        >
                          <LayoutDashboard
                            className="h-4 w-4 shrink-0 text-[#B76E79]"
                            aria-hidden="true"
                          />
                          <span>Admin Dashboard</span>
                        </button>
                      </div>
                    )}

                    <div className="max-h-[60vh] overflow-y-auto py-1">
                      {ACCOUNT_MENU_ITEMS.map((item) => {
                        const Icon = item.icon;
                        const countText =
                          item.id === 'notifications' && unreadNotifications > 0
                            ? String(unreadNotifications)
                            : item.id === 'wishlist' && wishlistCount > 0
                              ? String(wishlistCount)
                              : null;

                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAccountMenuOpen(false);
                              onNavigateAuth(item.href);
                            }}
                            className="flex min-h-[40px] w-full items-center justify-between gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <Icon
                                className="h-4 w-4 shrink-0 text-[#B76E79]"
                                aria-hidden="true"
                              />
                              <span className="truncate">{item.label}</span>
                            </span>
                            {countText && (
                              <span className="shrink-0 text-xs font-semibold tabular-nums text-[#B76E79]">
                                {countText}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <div className="border-t border-[#49243E]/10 pt-1.5">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={signingOut}
                        onClick={() => void handleSignOut()}
                        className="flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-[#9B2C3E] transition-colors hover:bg-[#F3D5DF]/40 hover:text-[#49243E] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                      >
                        {signingOut ? (
                          <Loader2
                            className="h-4 w-4 shrink-0 animate-spin text-[#B76E79]"
                            aria-hidden="true"
                          />
                        ) : (
                          <LogoutIcon
                            className="h-4 w-4 shrink-0 text-[#B76E79]"
                            aria-hidden="true"
                          />
                        )}
                        <span>{signingOut ? 'Signing Out...' : ACCOUNT_LOGOUT_ITEM.label}</span>
                      </button>
                    </div>

                    {signOutError && (
                      <div
                        role="alert"
                        className="mt-1.5 flex items-start gap-2 rounded-xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 px-2.5 py-2 text-xs text-[#49243E]"
                      >
                        <AlertCircle
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]"
                          aria-hidden="true"
                        />
                        <span>{signOutError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="hidden sm:flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onNavigateAuth('/login')}
                  className="inline-flex h-10 items-center justify-center rounded-full border border-[#49243E]/20 bg-[#FFF9F5]/90 px-4 text-xs font-semibold tracking-wide text-[#49243E] transition-colors hover:bg-[#F3D5DF]/45 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => onNavigateAuth('/signup')}
                  className="inline-flex h-10 items-center justify-center rounded-full bg-[#49243E] px-4 text-xs font-semibold tracking-wide text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                >
                  Sign Up
                </button>
              </div>
            )}

            {/* Mobile quick Account trigger so Account is always easy to find on small screens */}
            <button
              type="button"
              onClick={openMobileDrawerToAccount}
              aria-label={user ? 'Open Your Account menu' : 'Sign In or Sign Up'}
              className="relative flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-full border border-[#49243E]/15 bg-[#FFF9F5]/85 px-2.5 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/45 sm:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
            >
              <User className="h-[18px] w-[18px] text-[#49243E]" aria-hidden="true" />
              {user && unreadNotifications > 0 && (
                <span className="text-[11px] font-semibold tabular-nums text-[#B76E79]">
                  {unreadNotifications}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 lg:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.22 }}
            className="fixed inset-0 z-50 bg-[#242124]/40 lg:hidden"
            onClick={() => {
              if (!signingOut) {
                setSignOutError(null);
                setMobileMenuOpen(false);
              }
            }}
          >
            <motion.div
              ref={mobileDrawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Mobile boutique and account navigation"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              initial={prefersReducedMotion ? { x: 0 } : { x: '100%' }}
              animate={{ x: 0 }}
              exit={prefersReducedMotion ? { x: 0 } : { x: '100%' }}
              transition={{ duration: prefersReducedMotion ? 0.01 : 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="ml-auto flex h-full w-full max-w-xs flex-col overflow-y-auto bg-[#FFF9F5] p-5 shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-[#49243E]/10 pb-4">
                <span className="font-serif text-xl font-semibold text-[#49243E]">
                  {settings.brandName}
                </span>
                <button
                  type="button"
                  disabled={signingOut}
                  onClick={() => {
                    setSignOutError(null);
                    setMobileMenuOpen(false);
                  }}
                  aria-label="Close navigation menu"
                  className="flex h-11 w-11 items-center justify-center rounded-full text-[#49243E] hover:bg-[#F3D5DF]/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              {/* Your Account Section inside scrollable mobile drawer */}
              <div
                ref={mobileAccountSectionRef}
                className="mt-4 rounded-2xl border border-[#49243E]/12 bg-white p-3.5 shadow-[0_10px_30px_-18px_rgba(73,36,62,0.18)]"
              >
                {user ? (
                  <div className="space-y-1">
                    <div className="border-b border-[#49243E]/10 px-2 pb-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#B76E79]">
                        Your Account
                      </p>
                      <p className="mt-0.5 truncate font-serif text-lg font-semibold text-[#49243E]">
                        {user.fullName || 'Boutique Member'}
                      </p>
                      <p className="truncate text-xs text-[#242124]/60">{user.email}</p>
                    </div>

                    {user.isOwner && (
                      <button
                        type="button"
                        onClick={() => {
                          setMobileMenuOpen(false);
                          onNavigateAuth('/admin/dashboard');
                        }}
                        className="mt-1 flex min-h-[44px] w-full items-center gap-3 rounded-xl border border-[#49243E]/20 bg-[#F3D5DF]/30 px-3 text-left text-sm font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                      >
                        <LayoutDashboard
                          className="h-4 w-4 shrink-0 text-[#49243E]"
                          aria-hidden="true"
                        />
                        <span>Admin Dashboard</span>
                      </button>
                    )}

                    <div className="pt-1 space-y-0.5">
                      {ACCOUNT_MENU_ITEMS.map((item) => {
                        const Icon = item.icon;
                        const countText =
                          item.id === 'notifications' && unreadNotifications > 0
                            ? String(unreadNotifications)
                            : item.id === 'wishlist' && wishlistCount > 0
                              ? String(wishlistCount)
                              : null;

                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setMobileMenuOpen(false);
                              onNavigateAuth(item.href);
                            }}
                            className="flex min-h-[44px] w-full items-center justify-between gap-2.5 rounded-xl px-3 text-left text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <Icon
                                className="h-4 w-4 shrink-0 text-[#B76E79]"
                                aria-hidden="true"
                              />
                              <span className="truncate">{item.label}</span>
                            </span>
                            {countText && (
                              <span className="shrink-0 text-xs font-semibold tabular-nums text-[#B76E79]">
                                {countText}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <div className="border-t border-[#49243E]/10 pt-1.5">
                      <button
                        type="button"
                        disabled={signingOut}
                        onClick={() => void handleSignOut()}
                        className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-[#9B2C3E] transition-colors hover:bg-[#F3D5DF]/35 hover:text-[#49243E] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                      >
                        {signingOut ? (
                          <Loader2
                            className="h-4 w-4 shrink-0 animate-spin text-[#B76E79]"
                            aria-hidden="true"
                          />
                        ) : (
                          <LogoutIcon
                            className="h-4 w-4 shrink-0 text-[#B76E79]"
                            aria-hidden="true"
                          />
                        )}
                        <span>{signingOut ? 'Signing Out...' : ACCOUNT_LOGOUT_ITEM.label}</span>
                      </button>
                    </div>

                    {signOutError && (
                      <div
                        role="alert"
                        className="mt-1.5 flex items-start gap-2 rounded-xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 px-3 py-2 text-xs text-[#49243E]"
                      >
                        <AlertCircle
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]"
                          aria-hidden="true"
                        />
                        <span>{signOutError}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#B76E79]">
                        Your Account
                      </p>
                      <p className="mt-1 text-xs text-[#242124]/70">
                        Sign in to manage orders, addresses, rewards, and cloud wishlist.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setMobileMenuOpen(false);
                          onNavigateAuth('/login');
                        }}
                        className="flex min-h-[44px] items-center justify-center rounded-xl border border-[#49243E]/25 bg-[#FFF9F5] px-3 text-sm font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                      >
                        Sign In
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMobileMenuOpen(false);
                          onNavigateAuth('/signup');
                        }}
                        className="flex min-h-[44px] items-center justify-center rounded-xl bg-[#49243E] px-3 text-sm font-semibold text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                      >
                        Sign Up
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <nav aria-label="Mobile boutique links" className="mt-5 flex flex-col gap-1">
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#49243E]/60">
                  Boutique Collections
                </p>
                {NAV_LINKS.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={(e) => {
                      if (onNavigateSection) {
                        e.preventDefault();
                      }
                      handleNavClick(item.href);
                    }}
                    className="flex min-h-[44px] items-center justify-between rounded-xl px-3 text-base font-medium text-[#242124] transition-colors hover:bg-[#F3D5DF]/35 hover:text-[#49243E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                  >
                    <span>{item.label}</span>
                    <span aria-hidden="true" className="text-xs text-[#B76E79]">
                      &rarr;
                    </span>
                  </a>
                ))}
              </nav>

              <div className="mt-6 border-t border-[#49243E]/10 pt-5 space-y-3">
                <p className="font-serif text-base italic text-[#49243E]">
                  “{settings.tagline}”
                </p>

                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onOpenWishlist();
                  }}
                  className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-4 py-2.5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
                >
                  <Heart className="h-4 w-4" aria-hidden="true" />
                  <span>View Wishlist ({wishlistCount})</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
