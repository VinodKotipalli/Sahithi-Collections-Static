import { useCallback, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { AboutSection } from './components/AboutSection';
import { AuthPage } from './components/auth/AuthPage';
import { CollectionsSection } from './components/CollectionsSection';
import { ContactAndFooter } from './components/ContactAndFooter';
import { HeroSection } from './components/HeroSection';
import { LookbookLightbox } from './components/LookbookLightbox';
import { LookbookSection } from './components/LookbookSection';
import { Navbar } from './components/Navbar';
import { ProductShowcase, SortOption } from './components/ProductShowcase';
import { QuickViewModal } from './components/QuickViewModal';
import { ScrollProgressAndTop } from './components/ScrollProgressAndTop';
import { SpotlightEditSection } from './components/SpotlightEditSection';
import { WishlistDrawer } from './components/WishlistDrawer';
import { PRODUCTS } from './config/products';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppRoute, useBoutiqueRouter } from './hooks/useBoutiqueRouter';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import { useWishlist } from './hooks/useWishlist';
import { CollectionCategory, Product } from './types/boutique';

function StorefrontAndAuthShell({
  route,
  returnTo,
  navigate,
  navigateToStoreSection,
}: {
  route: AppRoute;
  returnTo: string;
  navigate: (target: AppRoute, nextPath?: string) => void;
  navigateToStoreSection: (sectionHash?: string) => void;
}) {
  const { user } = useAuth();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [selectedCategory, setSelectedCategory] = useState<'All' | CollectionCategory>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('newest');

  const [quickViewProduct, setQuickViewProduct] = useState<Product | null>(null);
  const [wishlistOpen, setWishlistOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const {
    wishlistIds,
    wishlistCount,
    toggleWishlist,
    removeFromWishlist,
    clearWishlist,
    isWishlisted,
  } = useWishlist(user?.id);

  const wishlistProducts = useMemo(() => {
    const productMap = new Map(PRODUCTS.map((p) => [p.id, p]));
    return wishlistIds.map((id) => productMap.get(id)).filter((p): p is Product => Boolean(p));
  }, [wishlistIds]);

  const filteredProducts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const matches = PRODUCTS.filter((product) => {
      const categoryMatch =
        selectedCategory === 'All' || product.category === selectedCategory;
      if (!categoryMatch) return false;
      if (!query) return true;

      return (
        product.name.toLowerCase().includes(query) ||
        product.category.toLowerCase().includes(query) ||
        product.description.toLowerCase().includes(query) ||
        product.fabricNote.toLowerCase().includes(query) ||
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
  }, [selectedCategory, searchQuery, sortBy]);

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

  if (route !== '/') {
    return (
      <AuthPage
        route={route}
        returnTo={returnTo}
        onNavigateRoute={(next) => navigate(next, returnTo)}
        onReturnToStore={(path) => {
          if (path && path.startsWith('/#')) {
            navigateToStoreSection(path.slice(1));
          } else {
            navigateToStoreSection();
          }
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF9F5] text-[#242124]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-[#49243E] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#FFF9F5]"
      >
        Skip to main content
      </a>

      <Navbar
        wishlistCount={wishlistCount}
        onOpenWishlist={() => setWishlistOpen(true)}
        onOpenSearch={handleOpenSearch}
        onOpenLogin={() => navigate('/login', window.location.hash ? `/${window.location.hash}` : '/')}
      />

      <main id="main-content">
        <HeroSection />

        <CollectionsSection onSelectCollection={handleSelectCollection} />

        <ProductShowcase
          products={filteredProducts}
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
          onQuickView={setQuickViewProduct}
        />

        <SpotlightEditSection onExploreEdit={handleSelectCollection} />

        <LookbookSection onOpenLightbox={setLightboxIndex} />

        <AboutSection />
      </main>

      <ContactAndFooter
        onOpenLogin={() => navigate('/login', window.location.hash ? `/${window.location.hash}` : '/')}
      />

      <ScrollProgressAndTop />

      <QuickViewModal
        product={quickViewProduct}
        isWishlisted={quickViewProduct ? isWishlisted(quickViewProduct.id) : false}
        onToggleWishlist={toggleWishlist}
        onClose={() => setQuickViewProduct(null)}
      />

      <WishlistDrawer
        isOpen={wishlistOpen}
        items={wishlistProducts}
        onClose={() => setWishlistOpen(false)}
        onRemoveItem={removeFromWishlist}
        onClearAll={clearWishlist}
        onQuickView={setQuickViewProduct}
      />

      <LookbookLightbox
        activeIndex={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onChangeIndex={setLightboxIndex}
      />
    </div>
  );
}

export default function App() {
  const { route, returnTo, navigate, navigateToStoreSection } = useBoutiqueRouter();

  const handleRecoveryDetected = useCallback(() => {
    navigate('/reset-password');
  }, [navigate]);

  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider onRecoveryDetected={handleRecoveryDetected}>
        <StorefrontAndAuthShell
          route={route}
          returnTo={returnTo}
          navigate={navigate}
          navigateToStoreSection={navigateToStoreSection}
        />
      </AuthProvider>
    </MotionConfig>
  );
}
