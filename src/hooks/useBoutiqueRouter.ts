import { useCallback, useEffect, useState } from 'react';

export type BoutiqueRoute =
  | '/'
  | '/login'
  | '/signup'
  | '/forgot-password'
  | '/reset-password'
  | '/verify-email'
  | '/account'
  | '/admin';

const KNOWN_ROUTES: ReadonlySet<string> = new Set<BoutiqueRoute>([
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/account',
  '/admin',
]);

export function sanitizeNextPath(raw: string | null | undefined, fallback = '/account'): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes(':') || trimmed.includes('\\')) {
    return fallback;
  }
  return trimmed;
}

interface ParsedLocation {
  route: BoutiqueRoute;
  adminSubPath: string;
  token: string;
  queryMode: string;
  nextPath: string;
}

function readLocation(): ParsedLocation {
  if (typeof window === 'undefined') {
    return { route: '/', adminSubPath: '', token: '', queryMode: '', nextPath: '/account' };
  }
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');
  const route: BoutiqueRoute = isAdmin
    ? '/admin'
    : KNOWN_ROUTES.has(pathname)
      ? (pathname as BoutiqueRoute)
      : '/';
  const adminSubPath = isAdmin ? pathname.slice('/admin'.length) || '' : '';
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || params.get('oobCode') || '';
  const queryMode = params.get('mode') || '';
  const nextPath = sanitizeNextPath(params.get('next'), '');
  return { route, adminSubPath, token, queryMode, nextPath };
}

export function useBoutiqueRouter() {
  const [locationState, setLocationState] = useState<ParsedLocation>(() => readLocation());

  useEffect(() => {
    const handlePopState = () => {
      setLocationState(readLocation());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback(
    (
      target: string,
      options: { replace?: boolean; preserveScroll?: boolean } = {}
    ) => {
      if (typeof window === 'undefined') return;
      if (options.replace) {
        window.history.replaceState(null, '', target);
      } else {
        window.history.pushState(null, '', target);
      }
      setLocationState(readLocation());

      const hashIndex = target.indexOf('#');
      if (hashIndex !== -1) {
        const id = target.slice(hashIndex + 1);
        window.requestAnimationFrame(() => {
          const el = document.getElementById(id);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth' });
          }
        });
      } else if (!options.preserveScroll) {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    []
  );

  const navigateToSection = useCallback(
    (hashHref: string) => {
      const id = hashHref.replace(/^#/, '');
      const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
      if (currentPath !== '/') {
        navigate(`/#${id}`, { preserveScroll: true });
        return;
      }
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
      window.history.replaceState(null, '', `#${id}`);
    },
    [navigate]
  );

  return {
    route: locationState.route,
    adminSubPath: locationState.adminSubPath,
    queryToken: locationState.token,
    queryMode: locationState.queryMode,
    nextPath: locationState.nextPath,
    navigate,
    navigateToSection,
  };
}
