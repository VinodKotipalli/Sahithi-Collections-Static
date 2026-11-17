import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  Heart,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Search,
  ShoppingBag,
  User,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
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
    target: '/login' | '/signup' | '/account' | '/admin' | '/admin/dashboard' | '/admin/login',
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
  const accountMenuRef = useRef<HTMLDivElement>(null);
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
        setSignOutError(null);
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [accountMenuOpen, signingOut]);

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
      : 'Profile';

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

  return (
    <>
      <header
        className={`fixed top-0 left-0 right-0 z-40 transition-colors duration-300 ${
          isScrolled
            ? 'bg-[#FFF9F5]/97 border-b border-[#49243E]/10 shadow-[0_6px_24px_-12px_rgba(73,36,62,0.12)]'
            : 'bg-transparent border-b border-transparent'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:h-20 lg:px-8">
          <a
            href="#home"
            onClick={(e) => {
              if (onNavigateSection) {
                e.preventDefault();
              }
              handleNavClick('#home');
            }}
            className="flex items-center gap-2.5 font-serif text-xl font-semibold tracking-tight text-[#49243E] whitespace-nowrap shrink-0 sm:text-2xl"
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
                  className="group relative py-1.5 text-sm font-medium text-[#242124]/85 transition-colors duration-200 hover:text-[#49243E] whitespace-nowrap shrink-0"
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
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 active:scale-95"
            >
              <Search className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={onOpenWishlist}
              aria-label={`Open wishlist (${wishlistCount} saved items)`}
              className="relative flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 active:scale-95"
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
              className="relative flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 active:scale-95"
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
                  type="button"
                  aria-expanded={accountMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => {
                    if (signingOut) return;
                    setSignOutError(null);
                    setAccountMenuOpen((prev) => !prev);
                  }}
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-[#49243E]/18 bg-[#FFF9F5]/85 px-3.5 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/45 whitespace-nowrap shrink-0"
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
                  <ChevronDown className="h-3.5 w-3.5 text-[#49243E]/70" aria-hidden="true" />
                </button>

                {accountMenuOpen && (
                  <div
                    role="menu"
                    aria-label="Account menu"
                    className="absolute right-0 mt-2 w-56 rounded-2xl border border-[#49243E]/12 bg-white p-1.5 shadow-[0_18px_40px_-18px_rgba(73,36,62,0.28)]"
                  >
                    <div className="border-b border-[#49243E]/10 px-3 py-2">
                      <p className="truncate text-xs font-semibold text-[#49243E]">
                        {user.fullName || 'Boutique Member'}
                      </p>
                      <p className="truncate text-[11px] text-[#242124]/60">
                        {user.email}
                      </p>
                    </div>
                    {user.isOwner && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setAccountMenuOpen(false);
                          onNavigateAuth('/admin/dashboard');
                        }}
                        className="mt-1 flex min-h-[40px] w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/45"
                      >
                        <LayoutDashboard className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                        <span>Admin Dashboard</span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        onNavigateAuth('/account');
                      }}
                      className="mt-1 flex min-h-[40px] w-full items-center justify-between gap-2 rounded-xl px-3 text-left text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35"
                    >
                      <span className="flex items-center gap-2">
                        <User className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                        <span>Your Account</span>
                      </span>
                      {unreadNotifications > 0 && (
                        <span className="text-xs font-semibold tabular-nums text-[#B76E79]">
                          {unreadNotifications} new
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        onOpenWishlist();
                      }}
                      className="flex min-h-[40px] w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35"
                    >
                      <Heart className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                      <span>Saved Wishlist ({wishlistCount})</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={signingOut}
                      onClick={() => void handleSignOut()}
                      className="flex min-h-[40px] w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-[#B76E79] transition-colors hover:bg-[#F3D5DF]/35 hover:text-[#49243E] disabled:opacity-60"
                    >
                      {signingOut ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <LogOut className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span>{signingOut ? 'Signing Out...' : 'Sign Out'}</span>
                    </button>
                    {signOutError && (
                      <div
                        role="alert"
                        className="mt-1.5 flex items-start gap-2 rounded-xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 px-2.5 py-2 text-xs text-[#49243E]"
                      >
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]" aria-hidden="true" />
                        <span>{signOutError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onNavigateAuth('/login')}
                className="hidden sm:inline-flex h-10 items-center justify-center rounded-full border border-[#49243E]/20 bg-[#FFF9F5]/85 px-4 text-xs font-semibold tracking-wide text-[#49243E] transition-colors hover:bg-[#49243E] hover:text-[#FFF9F5] whitespace-nowrap shrink-0"
              >
                Login / Sign Up
              </button>
            )}

            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#49243E] transition-colors duration-200 hover:bg-[#F3D5DF]/45 lg:hidden"
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
              aria-label="Mobile navigation"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              initial={prefersReducedMotion ? { x: 0 } : { x: '100%' }}
              animate={{ x: 0 }}
              exit={prefersReducedMotion ? { x: 0 } : { x: '100%' }}
              transition={{ duration: prefersReducedMotion ? 0.01 : 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="ml-auto flex h-full w-full max-w-xs flex-col justify-between bg-[#FFF9F5] p-6 shadow-2xl"
            >
              <div>
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
                    className="flex h-11 w-11 items-center justify-center rounded-full text-[#49243E] hover:bg-[#F3D5DF]/40 disabled:opacity-50"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>

                <nav aria-label="Mobile links" className="mt-6 flex flex-col gap-1">
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
                      className="flex min-h-[44px] items-center justify-between rounded-xl px-3 text-base font-medium text-[#242124] transition-colors hover:bg-[#F3D5DF]/35 hover:text-[#49243E]"
                    >
                      <span>{item.label}</span>
                      <span aria-hidden="true" className="text-xs text-[#B76E79]">
                        &rarr;
                      </span>
                    </a>
                  ))}
                </nav>
              </div>

              <div className="border-t border-[#49243E]/10 pt-5 space-y-2.5">
                <p className="font-serif text-base italic text-[#49243E]">
                  “{settings.tagline}”
                </p>

                {user ? (
                  <>
                    {user.isOwner && (
                      <button
                        type="button"
                        onClick={() => {
                          setMobileMenuOpen(false);
                          onNavigateAuth('/admin/dashboard');
                        }}
                        className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/25 bg-[#F3D5DF]/35 px-4 py-2.5 text-sm font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/55"
                      >
                        <LayoutDashboard className="h-4 w-4 text-[#49243E]" aria-hidden="true" />
                        <span>Admin Dashboard</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        onNavigateAuth('/account');
                      }}
                      className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/20 bg-white px-4 py-2.5 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30"
                    >
                      <User className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                      <span className="truncate">
                        {user.fullName || 'Your Account'}
                        {unreadNotifications > 0 ? ` (${unreadNotifications})` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={signingOut}
                      onClick={() => void handleSignOut()}
                      className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#B76E79]/35 px-4 py-2.5 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30 disabled:opacity-60"
                    >
                      {signingOut ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[#B76E79]" aria-hidden="true" />
                      ) : (
                        <LogOut className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                      )}
                      <span>{signingOut ? 'Signing Out...' : 'Sign Out'}</span>
                    </button>
                    {signOutError && (
                      <div
                        role="alert"
                        className="flex items-start gap-2 rounded-xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 px-3 py-2 text-xs text-[#49243E]"
                      >
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B76E79]" aria-hidden="true" />
                        <span>{signOutError}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onNavigateAuth('/login');
                    }}
                    className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/25 bg-white px-4 py-2.5 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30"
                  >
                    <User className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                    <span>Login / Sign Up</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onOpenWishlist();
                  }}
                  className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-4 py-2.5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
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
