import { fetchApi } from './services/apiTransport';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MotionConfig } from 'motion/react';
import { AboutSection } from './components/AboutSection';
import { AccountDashboard } from './components/account/AccountDashboard';
import { AdminErrorBoundary, AdminPortal } from './components/admin/AdminPortal';
import { AuthPage } from './components/auth/AuthPage';
import { BagDrawer } from './components/BagDrawer';
import { CollectionsSection } from './components/CollectionsSection';
import { ContactAndFooter } from './components/ContactAndFooter';
import { HeroSection } from './components/HeroSection';
import { LookbookLightbox } from './components/LookbookLightbox';
import { LookbookSection } from './components/LookbookSection';
import { Navbar } from './components/Navbar';
import { ProductShowcase, type SortOption } from './components/ProductShowcase';
import { QuickViewModal } from './components/QuickViewModal';
import { ScrollProgressAndTop } from './components/ScrollProgressAndTop';
import { SpotlightEditSection } from './components/SpotlightEditSection';
import { WishlistDrawer } from './components/WishlistDrawer';
import { PRODUCTS } from './config/products';
import { AuthProvider, useAuth, type AuthUser } from './context/AuthContext';
import { StorefrontProvider, useStorefront } from './context/StorefrontContext';
import {
  buildAccountSectionPath,
  ACCOUNT_MENU_ITEMS,
} from './config/accountMenu';
import { useBoutiqueRouter, sanitizeNextPath } from './hooks/useBoutiqueRouter';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import { useShoppingBag } from './hooks/useShoppingBag';
import { useWishlist } from './hooks/useWishlist';
import { handleClientlessApiRequest } from './services/firebaseClientApi';
import type { CollectionCategory, Product } from './types/boutique';

function normalizeStaticProducts(items: Product[]): Product[] {
  return items.map((item) => {
    const slug =
      item.slug ||
      item.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const pricePaise = item.pricePaise ?? Math.round(item.price * 100);
    const compareAtPaise =
      item.compareAtPaise ??
      (item.compareAtPrice ? Math.round(item.compareAtPrice * 100) : null);

    let pos = 0;
    const variants =
      item.variants && item.variants.length > 0
        ? item.variants
        : item.sizes.flatMap((size) =>
            item.colors.map((color) => {
              pos += 1;
              const colorCode = color.name
                .replace(/[^a-zA-Z0-9]/g, '')
                .slice(0, 3)
                .toUpperCase();
              const sizeCode = size.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
              return {
                id: `${item.id}-v-${pos}`,
                sku: `SC-${item.id.toUpperCase()}-${sizeCode}-${colorCode}-${pos}`,
                size,
                colorName: color.name,
                colorHex: color.hex,
                pricePaise,
                compareAtPaise,
                stockQty: 6,
                position: pos - 1,
              };
            })
          );
    const stockQty =
      item.stockQty ?? variants.reduce((sum, v) => sum + v.stockQty, 0);

    return {
      ...item,
      slug,
      pricePaise,
      compareAtPaise,
      stockQty,
      inStock: stockQty > 0,
      variants,
    };
  });
}

const DEFAULT_NORMALIZED_PRODUCTS = normalizeStaticProducts(PRODUCTS);

function BoutiqueShell() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { user, isLoadingSession, refreshSession, apiRequest } = useAuth();
  const { settings, refreshStorefront } = useStorefront();
  const {
    route,
    adminSubPath,
    queryToken,
    queryMode,
    nextPath,
    productSlug,
    colorParam,
    variantParam,
    accountSection,
    navigate,
    updateQueryParams,
    navigateToSection,
  } = useBoutiqueRouter();

  const [products, setProducts] = useState<Product[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  const [selectedCategory, setSelectedCategory] = useState<'All' | CollectionCategory>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('newest');

  const [quickViewProduct, setQuickViewProduct] = useState<Product | null>(null);
  const [wishlistOpen, setWishlistOpen] = useState(false);
  const [bagOpen, setBagOpen] = useState(false);
  const [bagInitialStep, setBagInitialStep] = useState<'bag' | 'checkout'>('bag');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const [unavailableProductSlug, setUnavailableProductSlug] = useState<string | null>(null);

  const fetchPublicCatalog = useCallback(async () => {
    try {
      const res = await fetchApi('/api/products', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'X-Sahithi-Client': 'web-spa' },
      });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && contentType.includes('application/json')) {
        const data = (await res.json()) as { items?: Product[] };
        if (Array.isArray(data.items)) {
          setProducts(data.items);
          setQuickViewProduct((current) =>
            current ? data.items!.find((p) => p.id === current.id) || null : null
          );
          return;
        }
      }
      const fallback = await handleClientlessApiRequest<{ items?: Product[] }>(
        '/api/products',
        'GET'
      );
      if (fallback.ok && Array.isArray(fallback.data.items)) {
        setProducts(fallback.data.items);
        setQuickViewProduct((current) =>
          current ? fallback.data.items!.find((p) => p.id === current.id) || null : null
        );
        return;
      }
      setProducts((current) => (current.length > 0 ? current : DEFAULT_NORMALIZED_PRODUCTS));
    } catch {
      setProducts((current) => (current.length > 0 ? current : DEFAULT_NORMALIZED_PRODUCTS));
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  useEffect(() => {
    void fetchPublicCatalog();
  }, [fetchPublicCatalog]);

  useEffect(() => {
    if (!productSlug) {
      setUnavailableProductSlug(null);
      return;
    }
    if (loadingCatalog) return;
    const normalizedSlug = productSlug.toLowerCase();
    const matched = products.find(
      (p) =>
        p.id.toLowerCase() === normalizedSlug ||
        (p.slug || '').toLowerCase() === normalizedSlug
    );
    if (matched) {
      setUnavailableProductSlug(null);
      setQuickViewProduct(matched);
    } else {
      setQuickViewProduct(null);
      setUnavailableProductSlug(productSlug);
    }
  }, [productSlug, products, loadingCatalog]);

  // Mark private routes (/admin, /account) noindex client-side in addition to server headers
  useEffect(() => {
    const isPrivate = route === '/admin' || route === '/account';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (isPrivate) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'robots';
        document.head.appendChild(meta);
      }
      meta.content = 'noindex, nofollow';
    } else if (meta) {
      meta.remove();
    }

    const brand = settings.brandName || 'Sahithi Collections';
    const cleanTagline = (settings.tagline || 'Style That Celebrates You').replace(/\.+$/, '');
    if (route === '/admin') {
      document.title =
        adminSubPath === '/login'
          ? `Owner Sign-In — ${brand}`
          : `Atelier Studio — ${brand}`;
    } else if (route === '/account') {
      const sectionLabel =
        ACCOUNT_MENU_ITEMS.find((item) => item.id === accountSection)?.label || 'Your Account';
      document.title = `${sectionLabel} — Your Account — ${brand}`;
    } else {
      document.title = `${brand} — ${cleanTagline}`;
    }
  }, [route, adminSubPath, accountSection, settings.brandName, settings.tagline]);

  const {
    wishlistIds,
    wishlistCount,
    toggleWishlist,
    removeFromWishlist,
    clearWishlist,
    isWishlisted,
  } = useWishlist({ user, isLoadingSession, apiRequest });

  const {
    bagItems,
    bagCount,
    addItem: addToBag,
    updateItemQty,
    removeItem: removeBagItem,
    acceptPriceUpdates,
    clearBag,
  } = useShoppingBag();

  const wishlistProducts = useMemo(() => {
    const productMap = new Map(products.map((p) => [p.id, p]));
    return wishlistIds.map((id) => productMap.get(id)).filter((p): p is Product => Boolean(p));
  }, [wishlistIds, products]);

  const filteredProducts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const matches = products.filter((product) => {
      const categoryMatch =
        selectedCategory === 'All' || product.category === selectedCategory;
      if (!categoryMatch) return false;
      if (!query) return true;

      return (
        product.name.toLowerCase().includes(query) ||
        product.category.toLowerCase().includes(query) ||
        product.description.toLowerCase().includes(query) ||
        product.fabricNote.toLowerCase().includes(query) ||
        (product.includedPieces || '').toLowerCase().includes(query) ||
        (product.careNote || '').toLowerCase().includes(query) ||
        product.colors.some((c) => c.name.toLowerCase().includes(query))
      );
    });

    return [...matches].sort((a, b) => {
      switch (sortBy) {
        case 'price-asc':
          return a.price - b.price;
        case 'price-desc':
          return b.price - a.price;
        case 'featured':
          if (a.featured !== b.featured) return a.featured ? -1 : 1;
          return b.dateAdded.localeCompare(a.dateAdded);
        case 'newest':
        default:
          return b.dateAdded.localeCompare(a.dateAdded);
      }
    });
  }, [products, selectedCategory, searchQuery, sortBy]);

  // Revalidate session whenever entering /account and redirect if unauthenticated
  useEffect(() => {
    if (route === '/account') {
      void refreshSession();
    }
  }, [route, refreshSession]);

  useEffect(() => {
    if (!isLoadingSession && route === '/account' && !user) {
      const intendedPath =
        typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}`
          : '/account';
      const safeIntended = sanitizeNextPath(intendedPath, '/account');
      navigate(`/login?next=${encodeURIComponent(safeIntended)}`, { replace: true });
    }
  }, [isLoadingSession, route, user, navigate]);

  // Route Firebase email action redirects (?mode=resetPassword|verifyEmail&oobCode=...) directly
  useEffect(() => {
    if (!queryToken || !queryMode) return;
    if (route === '/login' || route === '/') {
      if (queryMode === 'resetPassword') {
        navigate(`/reset-password?token=${encodeURIComponent(queryToken)}`, { replace: true });
        return;
      }
      if (queryMode === 'verifyEmail') {
        navigate(`/verify-email?token=${encodeURIComponent(queryToken)}`, { replace: true });
      }
    }
  }, [route, queryMode, queryToken, navigate]);

  // Redirect already-signed-in users away from /login or /signup
  useEffect(() => {
    if (
      !isLoadingSession &&
      user &&
      (route === '/login' || route === '/signup') &&
      queryMode !== 'resetPassword' &&
      queryMode !== 'verifyEmail'
    ) {
      navigate(nextPath || (user.isOwner ? '/admin/dashboard' : '/account'), { replace: true });
    }
  }, [isLoadingSession, user, route, nextPath, queryMode, navigate]);

  const scrollToShowcase = () => {
    const section = document.getElementById('new-arrivals');
    if (section) {
      section.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    }
  };

  const handleSelectCollection = (category: CollectionCategory) => {
    setSelectedCategory(category);
    scrollToShowcase();
  };

  const handleOpenSearch = () => {
    scrollToShowcase();
    window.setTimeout(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    }, 320);
  };

  const handleClearFilters = () => {
    setSelectedCategory('All');
    setSearchQuery('');
    setSortBy('newest');
  };

  const isAuthRoute =
    route === '/login' ||
    route === '/signup' ||
    route === '/forgot-password' ||
    route === '/reset-password' ||
    route === '/verify-email';

  const handleAuthenticatedRedirect = (loggedInUser?: AuthUser) => {
    const activeUser = loggedInUser || user;
    navigate(nextPath || (activeUser?.isOwner ? '/admin/dashboard' : '/account'), { replace: true });
  };

  if (route === '/admin') {
    return (
      <AdminErrorBoundary onReturnHome={() => navigate('/', { replace: true })}>
        <AdminPortal
          adminSubPath={adminSubPath}
          queryToken={queryToken}
          queryMode={queryMode}
          onNavigate={(target, navOptions) => {
            navigate(target, navOptions);
            if (target === '/') {
              void fetchPublicCatalog();
              void refreshStorefront();
            }
          }}
          onCatalogMutated={() => void fetchPublicCatalog()}
          onStorefrontMutated={() => void refreshStorefront()}
        />
      </AdminErrorBoundary>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF9F5] text-[#242124]">
      {route === '/account' ? (
        isLoadingSession ? (
          <div className="flex min-h-screen items-center justify-center bg-[#FFF9F5]">
            <div className="flex items-center gap-3 text-sm font-medium text-[#49243E]">
              <Loader2 className="h-5 w-5 animate-spin text-[#B76E79]" aria-hidden="true" />
              <span>Loading your atelier profile...</span>
            </div>
          </div>
        ) : user ? (
          <AccountDashboard
            activeSection={accountSection}
            onSelectSection={(section) => navigate(buildAccountSectionPath(section))}
            wishlistCount={loadingCatalog ? wishlistCount : wishlistProducts.length}
            wishlistProducts={wishlistProducts}
            onRemoveWishlistItem={removeFromWishlist}
            onAddToBag={addToBag}
            onOpenBag={() => {
              setBagInitialStep('bag');
              setBagOpen(true);
            }}
            onOpenWishlist={() => setWishlistOpen(true)}
            onNavigate={navigate}
          />
        ) : null
      ) : isAuthRoute ? (
        <AuthPage
          initialRoute={route}
          queryToken={queryToken}
          queryMode={queryMode}
          onNavigate={navigate}
          onAuthenticated={handleAuthenticatedRedirect}
        />
      ) : (
        <>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-[#49243E] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#FFF9F5]"
          >
            Skip to main content
          </a>

          <Navbar
            wishlistCount={loadingCatalog ? wishlistCount : wishlistProducts.length}
            bagCount={bagCount}
            onOpenWishlist={() => setWishlistOpen(true)}
            onOpenBag={() => {
              setBagInitialStep('bag');
              setBagOpen(true);
            }}
            onOpenSearch={handleOpenSearch}
            onNavigateAuth={(target, options) => navigate(target, options)}
            onNavigateSection={navigateToSection}
          />

          <main id="main-content">
            {unavailableProductSlug && (
              <div
                role="status"
                className="border-b border-[#B76E79]/30 bg-[#F3D5DF]/40 px-4 py-6 text-center"
              >
                <div className="mx-auto max-w-xl">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#9B2C3E]">
                    Product Unavailable
                  </p>
                  <h2 className="mt-1 font-serif text-2xl font-semibold text-[#49243E]">
                    This piece is no longer available in our active collection
                  </h2>
                  <p className="mt-1.5 text-sm text-[#242124]/75">
                    The item you requested (&ldquo;{unavailableProductSlug}&rdquo;) has been removed or archived. Explore our current curated designs below.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setUnavailableProductSlug(null);
                      navigate('/', { replace: true });
                      scrollToShowcase();
                    }}
                    className="mt-4 inline-flex min-h-[40px] items-center justify-center rounded-xl bg-[#49243E] px-5 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
                  >
                    Browse Active Collection
                  </button>
                </div>
              </div>
            )}

            <HeroSection />

            <CollectionsSection onSelectCollection={handleSelectCollection} />

            <ProductShowcase
              products={filteredProducts}
              isLoading={loadingCatalog}
              selectedCategory={selectedCategory}
              onSelectCategory={setSelectedCategory}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sortBy={sortBy}
              onSortChange={setSortBy}
              onClearFilters={handleClearFilters}
              searchInputRef={searchInputRef}
              isWishlisted={isWishlisted}
              onToggleWishlist={toggleWishlist}
              onQuickView={(product) => {
                setQuickViewProduct(product);
                if (typeof window !== 'undefined') {
                  const slugOrId = product.slug || product.id;
                  window.history.replaceState(null, '', `/products/${encodeURIComponent(slugOrId)}`);
                }
              }}
            />

            <SpotlightEditSection onExploreEdit={handleSelectCollection} />

            <LookbookSection onOpenLightbox={setLightboxIndex} />

            <AboutSection />
          </main>

          <ContactAndFooter
            onNavigateAuth={() => navigate(user ? '/account?section=profile' : '/login')}
            accountLabel={user ? 'Your Account' : 'Sign In / Sign Up'}
          />

          <ScrollProgressAndTop />

          <LookbookLightbox
            activeIndex={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onChangeIndex={setLightboxIndex}
          />
        </>
      )}

      <QuickViewModal
        product={quickViewProduct}
        initialColorParam={colorParam}
        initialVariantParam={variantParam}
        onSelectColorUrl={(colorSlug) => {
          updateQueryParams({ color: colorSlug, variant: null });
        }}
        isWishlisted={quickViewProduct ? isWishlisted(quickViewProduct.id) : false}
        onToggleWishlist={toggleWishlist}
        onAddToBag={addToBag}
        onBuyNow={(item) => {
          addToBag(item);
          setQuickViewProduct(null);
          if (typeof window !== 'undefined' && window.location.pathname.startsWith('/products/')) {
            window.history.replaceState(null, '', '/');
          }
          setBagInitialStep('checkout');
          setBagOpen(true);
        }}
        relatedProducts={
          quickViewProduct
            ? products.filter(
                (p) => p.id !== quickViewProduct.id && p.category === quickViewProduct.category
              )
            : []
        }
        onSelectProduct={(product) => {
          setQuickViewProduct(product);
          if (typeof window !== 'undefined') {
            const slugOrId = product.slug || product.id;
            window.history.replaceState(null, '', `/products/${encodeURIComponent(slugOrId)}`);
          }
        }}
        onClose={() => {
          setQuickViewProduct(null);
          if (typeof window !== 'undefined' && window.location.pathname.startsWith('/products/')) {
            window.history.replaceState(null, '', '/');
          }
        }}
      />

      <WishlistDrawer
        isOpen={wishlistOpen}
        items={wishlistProducts}
        onClose={() => setWishlistOpen(false)}
        onRemoveItem={removeFromWishlist}
        onClearAll={clearWishlist}
        onQuickView={(product) => {
          setQuickViewProduct(product);
          if (typeof window !== 'undefined') {
            const slugOrId = product.slug || product.id;
            window.history.replaceState(null, '', `/products/${encodeURIComponent(slugOrId)}`);
          }
        }}
      />

      <BagDrawer
        isOpen={bagOpen}
        initialStep={bagInitialStep}
        items={bagItems}
        onClose={() => {
          setBagOpen(false);
          setBagInitialStep('bag');
        }}
        onUpdateQty={updateItemQty}
        onRemoveItem={removeBagItem}
        onAcceptPriceUpdates={acceptPriceUpdates}
        onClearBag={clearBag}
        onOrderCompleted={() => void fetchPublicCatalog()}
      />
    </div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <StorefrontProvider>
          <BoutiqueShell />
        </StorefrontProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
