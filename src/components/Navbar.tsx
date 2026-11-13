import { useEffect, useRef, useState } from 'react';
import { Heart, LogOut, Menu, Search, User, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { SITE_CONFIG } from '../config/site';
import { useAuth } from '../context/AuthContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { maskPhoneNumber } from '../utils/phone';

interface NavbarProps {
  wishlistCount: number;
  onOpenWishlist: () => void;
  onOpenSearch: () => void;
  onOpenLogin: () => void;
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
  onOpenWishlist,
  onOpenSearch,
  onOpenLogin,
}: NavbarProps) {
  const { user, signOut } = useAuth();
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [activeHash, setActiveHash] = useState('#home');
  const mobileDrawerRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useFocusTrap(mobileMenuOpen, mobileDrawerRef, () => setMobileMenuOpen(false));

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 36);
    };
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleOutside = (event: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [accountMenuOpen]);

  const handleNavClick = (href: string) => {
    setActiveHash(href);
    setMobileMenuOpen(false);
  };

  const displayName =
    (typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()) ||
    (user?.email ? user.email.split('@')[0] : '') ||
    (user?.phone ? maskPhoneNumber(user.phone) : 'Member');

  const maskedIdentifier = user?.phone
    ? maskPhoneNumber(user.phone)
    : user?.email || '';

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
            onClick={() => handleNavClick('#home')}
            className="font-serif text-xl font-semibold tracking-tight text-[#49243E] whitespace-nowrap shrink-0 sm:text-2xl"
          >
            {SITE_CONFIG.brandName}
          </a>

          <nav aria-label="Primary navigation" className="hidden lg:flex items-center gap-7">
            {NAV_LINKS.map((item) => {
              const isActive = activeHash === item.href;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => handleNavClick(item.href)}
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

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
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

            {/* Account / Login Action */}
            {user ? (
              <div ref={accountMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAccountMenuOpen((prev) => !prev)}
                  aria-expanded={accountMenuOpen}
                  aria-haspopup="menu"
                  aria-label="Account menu"
                  className="flex h-11 items-center gap-2 rounded-full border border-[#49243E]/15 bg-[#FFF9F5]/90 px-3 text-xs font-medium text-[#49243E] transition-colors hover:border-[#B76E79] hover:bg-[#F3D5DF]/35 whitespace-nowrap"
                >
                  <User className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                  <span className="hidden sm:inline max-w-[110px] truncate">{displayName}</span>
                </button>

                <AnimatePresence>
                  {accountMenuOpen && (
                    <motion.div
                      role="menu"
                      initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={prefersReducedMotion ? undefined : { opacity: 0, y: 4 }}
                      transition={{ duration: 0.16 }}
                      className="absolute right-0 mt-2 w-60 rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5] p-3 shadow-xl"
                    >
                      <div className="border-b border-[#49243E]/10 px-2 pb-2.5">
                        <p className="truncate font-serif text-base font-semibold text-[#49243E]">
                          {displayName}
                        </p>
                        {maskedIdentifier && (
                          <p className="mt-0.5 truncate text-xs text-[#242124]/65 tabular-nums">
                            {maskedIdentifier}
                          </p>
                        )}
                      </div>

                      <div className="mt-2 space-y-1">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setAccountMenuOpen(false);
                            onOpenWishlist();
                          }}
                          className="flex min-h-[40px] w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs font-medium text-[#242124] hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
                        >
                          <Heart className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                          <span>Saved Wishlist ({wishlistCount})</span>
                        </button>

                        <button
                          type="button"
                          role="menuitem"
                          onClick={async () => {
                            setAccountMenuOpen(false);
                            await signOut();
                          }}
                          className="flex min-h-[40px] w-full items-center gap-2 rounded-xl px-2.5 text-left text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/40"
                        >
                          <LogOut className="h-4 w-4" aria-hidden="true" />
                          <span>Sign Out</span>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <button
                type="button"
                onClick={onOpenLogin}
                aria-label="Login to Sahithi Collections"
                className="flex h-11 items-center gap-1.5 rounded-full border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] transition-colors duration-200 hover:bg-[#49243E] hover:text-[#FFF9F5] sm:px-4 whitespace-nowrap shrink-0"
              >
                <User className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Login</span>
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
            onClick={() => setMobileMenuOpen(false)}
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
              className="ml-auto flex h-full w-full max-w-xs flex-col justify-between bg-[#FFF9F5] p-6 shadow-2xl overflow-y-auto"
            >
              <div>
                <div className="flex items-center justify-between border-b border-[#49243E]/10 pb-4">
                  <span className="font-serif text-xl font-semibold text-[#49243E]">
                    {SITE_CONFIG.brandName}
                  </span>
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(false)}
                    aria-label="Close navigation menu"
                    className="flex h-11 w-11 items-center justify-center rounded-full text-[#49243E] hover:bg-[#F3D5DF]/40"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>

                <nav aria-label="Mobile links" className="mt-6 flex flex-col gap-1">
                  {NAV_LINKS.map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      onClick={() => handleNavClick(item.href)}
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
                {user ? (
                  <div className="rounded-xl border border-[#49243E]/12 bg-white p-3">
                    <p className="font-serif text-base font-semibold text-[#49243E]">
                      {displayName}
                    </p>
                    {maskedIdentifier && (
                      <p className="text-xs text-[#242124]/65 tabular-nums">{maskedIdentifier}</p>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        setMobileMenuOpen(false);
                        await signOut();
                      }}
                      className="mt-2.5 flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg border border-[#49243E]/20 text-xs font-medium text-[#49243E] hover:bg-[#F3D5DF]/35"
                    >
                      <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onOpenLogin();
                    }}
                    className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/25 bg-white px-4 py-2.5 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35"
                  >
                    <User className="h-4 w-4" aria-hidden="true" />
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
