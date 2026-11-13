import { useCallback, useEffect, useState } from 'react';
import { sanitizeInternalRedirectPath } from '../config/auth';

export type AppRoute =
  | '/'
  | '/login'
  | '/signup'
  | '/forgot-password'
  | '/reset-password'
  | '/auth/callback';

const KNOWN_ROUTES: ReadonlySet<string> = new Set([
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
]);

function resolveCurrentRoute(): AppRoute {
  if (typeof window === 'undefined') return '/';

  const rawHash = window.location.hash;
  if (rawHash.startsWith('#/')) {
    const hashPath = rawHash.slice(1).split('?')[0];
    if (KNOWN_ROUTES.has(hashPath)) {
      return hashPath as AppRoute;
    }
  }

  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (KNOWN_ROUTES.has(pathname)) {
    return pathname as AppRoute;
  }

  return '/';
}

export function useBoutiqueRouter() {
  const [route, setRoute] = useState<AppRoute>(() => resolveCurrentRoute());
  const [returnTo, setReturnTo] = useState<string>(() => {
    if (typeof window === 'undefined') return '/';
    const params = new URLSearchParams(window.location.search);
    return sanitizeInternalRedirectPath(params.get('next'));
  });

  useEffect(() => {
    const handlePopState = () => {
      setRoute(resolveCurrentRoute());
      const params = new URLSearchParams(window.location.search);
      setReturnTo(sanitizeInternalRedirectPath(params.get('next')));
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('hashchange', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handlePopState);
    };
  }, []);

  const navigate = useCallback((targetRoute: AppRoute, nextPath?: string) => {
    if (typeof window === 'undefined') return;
    const safeNext = nextPath ? sanitizeInternalRedirectPath(nextPath) : null;
    const url = safeNext && safeNext !== '/' ? `${targetRoute}?next=${encodeURIComponent(safeNext)}` : targetRoute;
    window.history.pushState({}, '', url);
    setRoute(targetRoute);
    if (safeNext) {
      setReturnTo(safeNext);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const navigateToStoreSection = useCallback((sectionHash?: string) => {
    if (typeof window === 'undefined') return;
    const targetUrl = sectionHash ? `/${sectionHash}` : '/';
    window.history.pushState({}, '', targetUrl);
    setRoute('/');
    if (sectionHash) {
      window.setTimeout(() => {
        const el = document.querySelector(sectionHash);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      }, 60);
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, []);

  return {
    route,
    returnTo,
    navigate,
    navigateToStoreSection,
  };
}
