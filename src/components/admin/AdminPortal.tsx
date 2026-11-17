import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  FolderKanban,
  LayoutDashboard,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Menu,
  Package,
  Palette,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Tag,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth, type AuthUser } from '../../context/AuthContext';
import { useStorefront } from '../../context/StorefrontContext';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { handleClientlessApiRequest } from '../../services/firebaseClientApi';
import type {
  AdminAuditEntry,
  AdminOrder,
  AdminOverviewResponse,
  AdminProduct,
  CollectionCategory,
  StorefrontCategory,
} from '../../types/boutique';
import { AdminCategoriesManager } from './AdminCategoriesManager';
import { AdminContentManager } from './AdminContentManager';
import { AdminCouponsAndActivity } from './AdminCouponsAndActivity';
import { AdminMessagesPanel } from './AdminMessagesPanel';
import { AdminAuditPanel, AdminOrdersPanel, AdminSecurityPanel } from './AdminOrdersAndAudit';
import { AdminOverviewSection, type OverviewTargetTab } from './AdminOverviewSection';
import { AdminProductEditorDrawer } from './AdminProductEditorDrawer';
import { AdminProductTable } from './AdminProductTable';
import { AdminSettingsPanel } from './AdminSettingsPanel';

type AdminTab = OverviewTargetTab;
type GateState = 'checking' | 'unauthenticated' | 'forbidden' | 'error' | 'authorized';

interface AdminPortalProps {
  adminSubPath?: string;
  queryToken?: string;
  queryMode?: string;
  onNavigate: (target: string, options?: { replace?: boolean }) => void;
  onCatalogMutated: () => void;
  onStorefrontMutated?: () => void;
}

const TAB_TITLES: Record<AdminTab, { title: string; subtitle: string }> = {
  overview: {
    title: 'Atelier Overview',
    subtitle: 'Catalog health, recent customer orders, enquiries, and stock alerts',
  },
  catalog: {
    title: 'Products & Inventory',
    subtitle: 'Manage garment variants, INR pricing, photos, and publication status',
  },
  categories: {
    title: 'Collections & Categories',
    subtitle: 'Organize storefront sections and showcase category cards',
  },
  orders: {
    title: 'Customer Orders',
    subtitle: 'Track placed orders, resolve cancel/return requests, recover captured payments, and update fulfillment',
  },
  coupons: {
    title: 'Promotions, Loyalty & Activity',
    subtitle: 'Manage coupons, gift cards, Sahithi Rewards & Plus, and live customer activity',
  },
  content: {
    title: 'Storefront Content',
    subtitle: 'Edit hero editorial, section headings, spotlight banner, lookbook, and brand story',
  },
  messages: {
    title: 'Customer Enquiries',
    subtitle: 'Review boutique contact submissions, track follow-ups, and record studio notes',
  },
  settings: {
    title: 'Boutique Settings',
    subtitle: 'Brand identity, header logo, contact channels, and social profile URLs',
  },
  account: {
    title: 'Owner Account & Audit',
    subtitle: 'Owner credential security, session controls, and immutable catalog history',
  },
};

export class AdminErrorBoundary extends Component<
  { children: ReactNode; onReturnHome: () => void },
  { hasError: boolean; message: string }
> {
  state = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error?.message || 'An unexpected error occurred while rendering the dashboard.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[admin-dashboard] Render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[#FFF9F5] px-4 py-12">
          <div className="w-full max-w-md rounded-3xl border border-[#B76E79]/40 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/50 text-[#49243E]">
              <AlertTriangle className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="mt-5 font-serif text-3xl font-semibold text-[#49243E]">
              Studio View Interrupted
            </h1>
            <p className="mt-2.5 text-sm leading-relaxed text-[#242124]/75">
              {this.state.message}
            </p>
            <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
              <button
                type="button"
                onClick={() => this.props.onReturnHome()}
                className="min-h-[44px] flex-1 rounded-xl border border-[#49243E]/20 bg-white px-4 text-sm font-medium text-[#49243E] hover:bg-[#FFF9F5]"
              >
                Go to Storefront
              </button>
              <button
                type="button"
                onClick={() => this.setState({ hasError: false, message: '' })}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-4 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>Retry Dashboard</span>
              </button>
            </div>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

export function AdminPortal({
  adminSubPath = '',
  queryToken = '',
  queryMode = '',
  onNavigate,
  onCatalogMutated,
  onStorefrontMutated,
}: AdminPortalProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { settings } = useStorefront();
  const {
    user: authUser,
    isLoadingSession,
    capabilities,
    apiRequest,
    loginAdminWithEmail,
    activateAdminAccount,
    confirmAdminActivation,
    resendAdminVerification,
    requestAdminPasswordReset,
    confirmAdminPasswordReset,
    resendVerificationEmail,
    logout,
    refreshCapabilities,
  } = useAuth();

  const isFirebaseManaged = capabilities.authMode === 'firebase_managed';

  const [gate, setGate] = useState<GateState>('checking');
  const [ownerUser, setOwnerUser] = useState<AuthUser | null>(null);
  const [ownerBinding, setOwnerBinding] = useState<{ boundAt: number; boundVia: string } | null>(
    null
  );
  const [gateError, setGateError] = useState<string | null>(null);
  const [pendingResendEmail, setPendingResendEmail] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendCooldownSec, setResendCooldownSec] = useState(0);
  const [resendStatus, setResendStatus] = useState<string | null>(null);

  // Login & Managed Activation / Recovery state
  const [portalMode, setPortalMode] = useState<'signin' | 'activate' | 'forgot'>('signin');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [activateConfirmPassword, setActivateConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showActivateConfirm, setShowActivateConfirm] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [activateAwaitingVerify, setActivateAwaitingVerify] = useState(false);
  const [verifyCodeInput, setVerifyCodeInput] = useState('');
  const [verifyCodeBusy, setVerifyCodeBusy] = useState(false);
  const [resetCodeInput, setResetCodeInput] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [showResetHelp, setShowResetHelp] = useState(false);
  const [checkingProvider, setCheckingProvider] = useState(false);
  const [providerCheckNote, setProviderCheckNote] = useState<string | null>(null);
  const handledActionTokenRef = useRef<string>('');

  useEffect(() => {
    if (resendCooldownSec <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldownSec]);

  // Navigation & feedback state
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [dirtySections, setDirtySections] = useState<Record<string, boolean>>({});
  const [pendingNavAction, setPendingNavAction] = useState<
    | { type: 'tab'; tab: AdminTab }
    | { type: 'route'; target: string }
    | { type: 'logout' }
    | null
  >(null);

  // Overview, Categories & Catalog state
  const [overviewData, setOverviewData] = useState<AdminOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [categories, setCategories] = useState<StorefrontCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);

  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft' | 'archived'>('all');
  const [categoryFilter, setCategoryFilter] = useState<'All' | CollectionCategory>('All');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'newest' | 'price_asc' | 'price_desc' | 'stock_asc'>('updated');
  const [busyProductId, setBusyProductId] = useState<string | null>(null);

  // Editor & confirmation modals
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<AdminProduct | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<AdminProduct | null>(null);

  // Orders & Audit state
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersTotalPages, setOrdersTotalPages] = useState(1);

  const [auditLogs, setAuditLogs] = useState<AdminAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [activityRefreshTick, setActivityRefreshTick] = useState(0);

  const setCategoriesDirty = useCallback((dirty: boolean) => {
    setDirtySections((prev) =>
      Boolean(prev.categories) === dirty ? prev : { ...prev, categories: dirty }
    );
  }, []);
  const setContentDirty = useCallback((dirty: boolean) => {
    setDirtySections((prev) =>
      Boolean(prev.content) === dirty ? prev : { ...prev, content: dirty }
    );
  }, []);
  const setMessagesDirty = useCallback((dirty: boolean) => {
    setDirtySections((prev) =>
      Boolean(prev.messages) === dirty ? prev : { ...prev, messages: dirty }
    );
  }, []);
  const setSettingsDirty = useCallback((dirty: boolean) => {
    setDirtySections((prev) =>
      Boolean(prev.settings) === dirty ? prev : { ...prev, settings: dirty }
    );
  }, []);

  const hasUnsavedChanges = gate === 'authorized' && Object.values(dirtySections).some(Boolean);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
  }, []);

  const handleUnreadMessagesChange = useCallback((unreadCount: number) => {
    setOverviewData((prev) =>
      prev
        ? {
            ...prev,
            metrics: {
              ...prev.metrics,
              unreadMessages: unreadCount,
            },
          }
        : prev
    );
  }, []);

  const clearPrivateAdminState = useCallback(() => {
    setDirtySections({});
    setPendingNavAction(null);
    setOwnerUser(null);
    setOwnerBinding(null);
    setOverviewData(null);
    setCategories([]);
    setProducts([]);
    setOrders([]);
    setAuditLogs([]);
    setEditingProduct(null);
    setDeleteCandidate(null);
    setEditorOpen(false);
    setMobileNavOpen(false);
    setToast(null);
    setActiveTab('overview');
  }, []);

  const adminSubPathRef = useRef(adminSubPath);
  adminSubPathRef.current = adminSubPath;

  const checkAdminSession = useCallback(async () => {
    const currentSubPath = adminSubPathRef.current;
    setGate('checking');
    setGateError(null);
    const res = await apiRequest<{
      authenticated: boolean;
      isOwner: boolean;
      user: AuthUser;
      ownerBinding: { boundAt: number; boundVia: string };
    }>('/api/admin/session');

    if (res.ok) {
      if (res.data?.isOwner === true && res.data?.user?.isOwner === true) {
        setOwnerUser(res.data.user);
        setOwnerBinding(res.data.ownerBinding);
        setGate('authorized');
        return;
      }

      clearPrivateAdminState();
      setGateError(
        'The server did not confirm owner authorization for this session. Please retry or sign in again.'
      );
      setGate('error');
      return;
    }

    clearPrivateAdminState();

    if (res.status === 403) {
      setGateError(res.error);
      if (currentSubPath !== '/login') {
        setGate('forbidden');
        return;
      }
      setGate('unauthenticated');
      return;
    }

    if (res.status !== 401) {
      setGateError(
        res.error || 'Unable to verify owner authorization right now. Please try again.'
      );
      if (currentSubPath === '/login') {
        setGate('unauthenticated');
        return;
      }
      setGate('error');
      return;
    }

    setGate('unauthenticated');
  }, [apiRequest, clearPrivateAdminState]);

  useEffect(() => {
    if (isLoadingSession) return;
    void checkAdminSession();
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void checkAdminSession();
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [isLoadingSession, checkAdminSession]);

  // If global AuthContext session clears externally (e.g. 401 on an API call or sign-out), drop admin access
  const prevAuthUserRef = useRef<AuthUser | null>(authUser);
  useEffect(() => {
    const hadAuthUser = prevAuthUserRef.current !== null;
    prevAuthUserRef.current = authUser;
    if (hadAuthUser && !authUser && !isLoadingSession && gate === 'authorized') {
      clearPrivateAdminState();
      setGate('unauthenticated');
    }
  }, [authUser, isLoadingSession, gate, clearPrivateAdminState]);

  // Synchronize URL between /admin/login and /admin/dashboard once auth and role checks finish
  useEffect(() => {
    if (isLoadingSession || gate === 'checking') return;
    if (gate === 'unauthenticated' && adminSubPath !== '/login') {
      onNavigate('/admin/login', { replace: true });
    } else if (gate === 'authorized' && adminSubPath !== '/dashboard') {
      onNavigate('/admin/dashboard', { replace: true });
    }
  }, [isLoadingSession, gate, adminSubPath, onNavigate]);

  // Handle Firebase email action callbacks (?mode=verifyEmail|resetPassword&oobCode=...) at /admin/login
  useEffect(() => {
    if (!queryToken) return;
    const actionKey = `${queryMode}:${queryToken}`;
    if (handledActionTokenRef.current === actionKey) return;
    handledActionTokenRef.current = actionKey;

    if (queryMode === 'resetPassword') {
      setPortalMode('forgot');
      setResetCodeInput(queryToken);
      setGateError(null);
      setResendStatus('Enter your new owner password below to complete the reset.');
      return;
    }

    if (queryMode === 'verifyEmail' || !queryMode) {
      setPortalMode('signin');
      setVerifyCodeBusy(true);
      setGateError(null);
      void confirmAdminActivation(queryToken).then((res) => {
        setVerifyCodeBusy(false);
        if (res.ok) {
          setLoginEmail(res.data.email);
          setActivateAwaitingVerify(false);
          setResendStatus(res.data.message);
        } else {
          setGateError(res.error);
        }
      });
    }
  }, [queryToken, queryMode, confirmAdminActivation]);

  const loadOverview = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setOverviewLoading(true);
      }
      const res = await apiRequest<AdminOverviewResponse>('/api/admin/overview');
      if (!options?.silent) {
        setOverviewLoading(false);
      }
      if (res.ok) {
        setOverviewData(res.data);
      } else if (!options?.silent) {
        showToast('err', res.error);
      }
    },
    [apiRequest, showToast]
  );

  const loadCategories = useCallback(async () => {
    setCategoriesLoading(true);
    const res = await apiRequest<{ items: StorefrontCategory[] }>('/api/admin/categories');
    setCategoriesLoading(false);
    if (res.ok) {
      setCategories(res.data.items);
    } else {
      showToast('err', res.error);
    }
  }, [apiRequest, showToast]);

  const loadProducts = useCallback(async () => {
    setCatalogLoading(true);
    const params = new URLSearchParams({
      page: String(catalogPage),
      pageSize: '10',
      status: statusFilter,
      category: categoryFilter,
      stock: stockFilter,
      sort: sortBy,
    });
    if (searchQuery.trim()) {
      params.set('q', searchQuery.trim());
    }
    const res = await apiRequest<{
      items: AdminProduct[];
      total: number;
      page: number;
      totalPages: number;
    }>(`/api/admin/products?${params.toString()}`);
    setCatalogLoading(false);

    if (res.ok) {
      const items = Array.isArray(res.data.items) ? res.data.items : [];
      const total = typeof res.data.total === 'number' ? res.data.total : items.length;
      const totalPages =
        typeof res.data.totalPages === 'number'
          ? res.data.totalPages
          : Math.max(1, Math.ceil(total / 10));
      setProducts(items);
      setCatalogTotal(total);
      setCatalogTotalPages(totalPages);
    } else {
      showToast('err', res.error);
    }
  }, [apiRequest, catalogPage, statusFilter, categoryFilter, stockFilter, sortBy, searchQuery, showToast]);

  const loadOrders = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setOrdersLoading(true);
      }
      const res = await apiRequest<{
        items: AdminOrder[];
        page: number;
        totalPages: number;
      }>(`/api/admin/orders?page=${ordersPage}&pageSize=12`);
      if (!options?.silent) {
        setOrdersLoading(false);
      }
      if (res.ok) {
        setOrders(res.data.items);
        setOrdersTotalPages(res.data.totalPages);
      } else if (!options?.silent) {
        showToast('err', res.error);
      }
    },
    [apiRequest, ordersPage, showToast]
  );

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    const res = await apiRequest<{
      items: AdminAuditEntry[];
      page: number;
      totalPages: number;
    }>(`/api/admin/audit?page=${auditPage}&pageSize=20`);
    setAuditLoading(false);
    if (res.ok) {
      setAuditLogs(res.data.items);
      setAuditTotalPages(res.data.totalPages);
    } else {
      showToast('err', res.error);
    }
  }, [apiRequest, auditPage, showToast]);

  useEffect(() => {
    if (gate !== 'authorized') return;
    void Promise.all([loadOverview(), loadCategories()]);
  }, [gate, loadOverview, loadCategories]);

  useEffect(() => {
    if (gate !== 'authorized') return;
    void loadProducts();
  }, [gate, loadProducts]);

  useEffect(() => {
    if (gate !== 'authorized') return;
    if (activeTab === 'orders') void loadOrders();
    if (activeTab === 'account') void loadAudit();
    if (activeTab === 'overview') void loadOverview();
    if (activeTab === 'coupons') setActivityRefreshTick((t) => t + 1);
  }, [gate, activeTab, loadOrders, loadAudit, loadOverview]);

  // Periodically refresh live customer/order/activity views while owner dashboard is open
  useEffect(() => {
    if (gate !== 'authorized') return;
    if (activeTab !== 'overview' && activeTab !== 'orders' && activeTab !== 'coupons') return;

    const timer = window.setInterval(() => {
      if (activeTab === 'overview') {
        void loadOverview({ silent: true });
      } else if (activeTab === 'orders') {
        void loadOrders({ silent: true });
      } else if (activeTab === 'coupons') {
        setActivityRefreshTick((t) => t + 1);
      }
    }, 12000);

    return () => window.clearInterval(timer);
  }, [gate, activeTab, loadOverview, loadOrders]);

  const refreshCatalogAndMetrics = useCallback(async () => {
    await Promise.all([loadOverview(), loadProducts()]);
    onCatalogMutated();
  }, [loadOverview, loadProducts, onCatalogMutated]);

  const handleCategoriesMutated = useCallback(async () => {
    await Promise.all([loadCategories(), loadOverview(), loadProducts()]);
    onCatalogMutated();
    onStorefrontMutated?.();
  }, [loadCategories, loadOverview, loadProducts, onCatalogMutated, onStorefrontMutated]);

  const handleStorefrontDocumentMutated = useCallback(async () => {
    await loadOverview();
    onStorefrontMutated?.();
  }, [loadOverview, onStorefrontMutated]);

  const handleAdminLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (loginBusy) return;
    const cleanEmail = loginEmail.trim().toLowerCase();
    setGateError(null);
    setResendStatus(null);
    setPendingResendEmail(null);
    setLoginBusy(true);
    try {
      const res = await loginAdminWithEmail(cleanEmail, loginPassword);
      if (!res.ok) {
        setGateError(res.error);
        if (res.code === 'EMAIL_NOT_VERIFIED' && cleanEmail) {
          setPendingResendEmail(cleanEmail);
        }
        return;
      }
      if (res.data.user?.isOwner !== true) {
        setGateError('Owner authorization was not confirmed by the server.');
        setGate('error');
        return;
      }
      setLoginPassword('');
      setOwnerUser(res.data.user);
      setOwnerBinding(res.data.ownerBinding);
      setGate('authorized');
      if (adminSubPath !== '/dashboard') {
        onNavigate('/admin/dashboard', { replace: true });
      }
    } finally {
      setLoginBusy(false);
    }
  };

  const handleResendOwnerVerification = async () => {
    if (!pendingResendEmail || resendBusy || resendCooldownSec > 0) return;
    setResendBusy(true);
    setResendStatus(null);
    setGateError(null);
    try {
      const res = isFirebaseManaged
        ? await resendAdminVerification(pendingResendEmail, loginPassword || undefined)
        : await resendVerificationEmail(pendingResendEmail);
      if (!res.ok) {
        setGateError(res.error);
        if (res.code === 'RESEND_COOLDOWN' && res.retryAfterSeconds) {
          setResendCooldownSec(res.retryAfterSeconds);
        }
        return;
      }
      setResendStatus(res.data.message);
      if ('alreadyVerified' in res.data && res.data.alreadyVerified) {
        setActivateAwaitingVerify(false);
        setPendingResendEmail(null);
        setPortalMode('signin');
      } else if ('cooldownSeconds' in res.data && res.data.cooldownSeconds) {
        setResendCooldownSec(res.data.cooldownSeconds);
      }
    } finally {
      setResendBusy(false);
    }
  };

  const handleActivateOwner = async (e: FormEvent) => {
    e.preventDefault();
    if (loginBusy) return;
    const cleanEmail = loginEmail.trim().toLowerCase();
    setGateError(null);
    setResendStatus(null);

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setGateError('Please enter a valid owner email address.');
      return;
    }
    if (loginPassword.length < capabilities.passwordMinLength) {
      setGateError(`Owner password must be at least ${capabilities.passwordMinLength} characters long.`);
      return;
    }
    if (loginPassword !== activateConfirmPassword) {
      setGateError('Password and confirmation password do not match.');
      return;
    }

    setLoginBusy(true);
    try {
      const res = await activateAdminAccount(cleanEmail, loginPassword, activateConfirmPassword);
      if (!res.ok) {
        setGateError(res.error);
        if (res.retryAfterSeconds) {
          setResendCooldownSec(res.retryAfterSeconds);
        }
        return;
      }
      setPendingResendEmail(cleanEmail);
      setActivateAwaitingVerify(true);
      setActivateConfirmPassword('');
      setLoginPassword('');
      if (res.data.cooldownSeconds) {
        setResendCooldownSec(res.data.cooldownSeconds);
      }
      setResendStatus(res.data.message);
    } finally {
      setLoginBusy(false);
    }
  };

  const handleConfirmVerifyCode = async (e: FormEvent) => {
    e.preventDefault();
    if (verifyCodeBusy || !verifyCodeInput.trim()) return;
    setVerifyCodeBusy(true);
    setGateError(null);
    setResendStatus(null);
    try {
      const res = await confirmAdminActivation(verifyCodeInput.trim());
      if (!res.ok) {
        setGateError(res.error);
        return;
      }
      setVerifyCodeInput('');
      setActivateAwaitingVerify(false);
      setPortalMode('signin');
      setLoginEmail(res.data.email);
      setResendStatus(res.data.message);
    } finally {
      setVerifyCodeBusy(false);
    }
  };

  const handleAdminForgotSend = async (e: FormEvent) => {
    e.preventDefault();
    if (resetBusy) return;
    const cleanEmail = loginEmail.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setGateError('Please enter your owner email address.');
      return;
    }
    setResetBusy(true);
    setGateError(null);
    setResendStatus(null);
    try {
      const res = await requestAdminPasswordReset(cleanEmail);
      if (!res.ok) {
        setGateError(res.error);
        return;
      }
      setResendStatus(res.data.message);
    } finally {
      setResetBusy(false);
    }
  };

  const handleAdminForgotConfirm = async (e: FormEvent) => {
    e.preventDefault();
    if (resetBusy) return;
    setGateError(null);
    setResendStatus(null);

    if (!resetCodeInput.trim()) {
      setGateError('Please paste the reset code or link from your email.');
      return;
    }
    if (resetNewPassword.length < capabilities.passwordMinLength) {
      setGateError(`New password must be at least ${capabilities.passwordMinLength} characters long.`);
      return;
    }
    if (resetNewPassword !== resetConfirmPassword) {
      setGateError('New password and confirmation password do not match.');
      return;
    }

    setResetBusy(true);
    try {
      const res = await confirmAdminPasswordReset(resetCodeInput.trim(), resetNewPassword);
      if (!res.ok) {
        setGateError(res.error);
        return;
      }
      setResetCodeInput('');
      setResetNewPassword('');
      setResetConfirmPassword('');
      setPortalMode('signin');
      setResendStatus(res.data.message);
    } finally {
      setResetBusy(false);
    }
  };

  const handleDuplicate = async (product: AdminProduct) => {
    setBusyProductId(product.id);
    const endpoint = `/api/admin/products/${encodeURIComponent(product.id)}/duplicate`;
    try {
      let res = await apiRequest<{ product: AdminProduct }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (
        !res.ok &&
        (res.status === 404 || res.status === 405 || res.code === 'API_ROUTE_NOT_FOUND')
      ) {
        res = await handleClientlessApiRequest<{ product: AdminProduct }>(endpoint, 'POST', {});
      }
      if (!res.ok) {
        showToast('err', res.error);
        return;
      }
      showToast('ok', `Duplicated "${product.name}" as a new draft.`);
      await refreshCatalogAndMetrics();
    } finally {
      setBusyProductId(null);
    }
  };

  const handleTogglePublish = async (product: AdminProduct) => {
    setBusyProductId(product.id);
    const nextStatus = product.status === 'published' ? 'draft' : 'published';
    const actionSegment = product.status === 'published' ? 'unpublish' : 'publish';
    const endpoint = `/api/admin/products/${encodeURIComponent(product.id)}/${actionSegment}`;
    const payload = { expectedVersion: product.version };
    try {
      let res = await apiRequest<{ product: AdminProduct }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (
        !res.ok &&
        (res.status === 404 || res.status === 405 || res.code === 'API_ROUTE_NOT_FOUND')
      ) {
        res = await handleClientlessApiRequest<{ product: AdminProduct }>(
          endpoint,
          'POST',
          payload
        );
      }
      if (!res.ok) {
        showToast('err', res.error);
        return;
      }
      const updatedProduct = res.data.product;
      if (updatedProduct) {
        setProducts((prev) => {
          if (statusFilter !== 'all' && statusFilter !== updatedProduct.status) {
            return prev.filter((p) => p.id !== product.id);
          }
          return prev.map((p) => (p.id === product.id ? updatedProduct : p));
        });
      }
      showToast(
        'ok',
        nextStatus === 'draft'
          ? `Unpublished "${product.name}" to draft.`
          : `Published "${product.name}" live on the storefront.`
      );
      await refreshCatalogAndMetrics();
    } finally {
      setBusyProductId(null);
    }
  };

  const handleArchiveToggle = async (product: AdminProduct) => {
    setBusyProductId(product.id);
    const nextStatus = product.status === 'archived' ? 'draft' : 'archived';
    const actionSegment = product.status === 'archived' ? 'restore' : 'archive';
    const endpoint = `/api/admin/products/${encodeURIComponent(product.id)}/${actionSegment}`;
    const payload = { expectedVersion: product.version };
    try {
      let res = await apiRequest<{ product: AdminProduct }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (
        !res.ok &&
        (res.status === 404 || res.status === 405 || res.code === 'API_ROUTE_NOT_FOUND')
      ) {
        res = await handleClientlessApiRequest<{ product: AdminProduct }>(
          endpoint,
          'POST',
          payload
        );
      }
      if (!res.ok) {
        showToast('err', res.error);
        return;
      }
      const updatedProduct = res.data.product;
      if (updatedProduct) {
        setProducts((prev) => {
          if (statusFilter !== 'all' && statusFilter !== updatedProduct.status) {
            return prev.filter((p) => p.id !== product.id);
          }
          return prev.map((p) => (p.id === product.id ? updatedProduct : p));
        });
      }
      showToast(
        'ok',
        nextStatus === 'draft'
          ? `Restored "${product.name}" to draft.`
          : `Archived "${product.name}" from the storefront.`
      );
      await refreshCatalogAndMetrics();
    } finally {
      setBusyProductId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteCandidate) return;
    const target = deleteCandidate;
    setDeleteCandidate(null);
    setBusyProductId(target.id);
    try {
      const res = await apiRequest<{
        message?: string;
        deleted?: boolean;
        archivedInsteadOfDeleted?: boolean;
      }>(`/api/admin/products/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        showToast('err', res.error);
        return;
      }
      if (!res.data.archivedInsteadOfDeleted || statusFilter !== 'archived') {
        setProducts((prev) => prev.filter((p) => p.id !== target.id));
      }
      const outcomeMsg =
        res.data.message ||
        (res.data.archivedInsteadOfDeleted
          ? `Archived "${target.name}" to preserve order history.`
          : `Deleted "${target.name}" from the catalog.`);
      showToast('ok', outcomeMsg);
      await refreshCatalogAndMetrics();
    } finally {
      setBusyProductId(null);
    }
  };

  const handleReloadEditingProduct = async (productId: string) => {
    const res = await apiRequest<{ product: AdminProduct }>(
      `/api/admin/products/${encodeURIComponent(productId)}`
    );
    if (res.ok) {
      setEditingProduct(res.data.product);
      showToast('ok', 'Reloaded latest product state.');
    } else {
      showToast('err', res.error);
    }
  };

  const handleUpdateOrderStatus = async (
    orderId: string,
    status: string,
    note?: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await apiRequest<{ id: string; status: string }>(
      `/api/admin/orders/${encodeURIComponent(orderId)}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify(note ? { status, note } : { status }),
      }
    );
    if (!res.ok) {
      showToast('err', res.error);
      return { ok: false, error: res.error };
    }
    showToast('ok', `Order marked as ${status}.`);
    await Promise.all([loadOrders({ silent: true }), loadOverview({ silent: true })]);
    return { ok: true };
  };

  const handleCollectOrderPayment = async (
    orderId: string,
    note?: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await apiRequest<{ id: string; paymentStatus: string; order: AdminOrder }>(
      `/api/admin/orders/${encodeURIComponent(orderId)}/collect-payment`,
      {
        method: 'POST',
        body: JSON.stringify(note ? { note } : {}),
      }
    );
    if (!res.ok) {
      showToast('err', res.error);
      return { ok: false, error: res.error };
    }
    showToast('ok', 'Payment marked as collected.');
    await Promise.all([loadOrders({ silent: true }), loadOverview({ silent: true })]);
    setActivityRefreshTick((t) => t + 1);
    return { ok: true };
  };

  const handleResolveReturnRequest = async (
    orderId: string,
    decision: 'approved' | 'rejected',
    note?: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await apiRequest<{ order: AdminOrder }>(
      `/api/admin/orders/${encodeURIComponent(orderId)}/resolve-request`,
      {
        method: 'POST',
        body: JSON.stringify(note ? { decision, note } : { decision }),
      }
    );
    if (!res.ok) {
      showToast('err', res.error);
      return { ok: false, error: res.error };
    }
    showToast(
      'ok',
      decision === 'approved'
        ? 'Customer request approved and recorded.'
        : 'Customer request rejected with note.'
    );
    await Promise.all([loadOrders({ silent: true }), loadOverview({ silent: true })]);
    setActivityRefreshTick((t) => t + 1);
    return { ok: true };
  };

  const handleRecoverOrder = async (
    razorpayOrderId: string,
    razorpayPaymentId?: string
  ): Promise<{ ok: boolean; message?: string; error?: string }> => {
    const res = await apiRequest<{
      confirmed?: boolean;
      pending_confirmation?: boolean;
      message?: string;
      order?: AdminOrder;
    }>('/api/admin/orders/recover', {
      method: 'POST',
      body: JSON.stringify(
        razorpayPaymentId
          ? { razorpayOrderId, razorpayPaymentId }
          : { razorpayOrderId }
      ),
    });
    if (!res.ok) {
      showToast('err', res.error);
      return { ok: false, error: res.error };
    }
    const msg =
      res.data.message ||
      (res.data.order?.orderNumber
        ? `Recovered and verified order ${res.data.order.orderNumber}.`
        : `Checked Razorpay payment for ${razorpayOrderId}.`);
    showToast('ok', msg);
    await Promise.all([loadOrders({ silent: true }), loadOverview({ silent: true })]);
    setActivityRefreshTick((t) => t + 1);
    return { ok: true, message: msg };
  };

  const handleLogout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      const res = await logout();
      if (!res.ok) {
        showToast('err', res.error);
        return;
      }
      clearPrivateAdminState();
      setGate('unauthenticated');
      onNavigate('/admin/login', { replace: true });
    } finally {
      setLogoutBusy(false);
    }
  };

  const executeNavAction = (
    action:
      | { type: 'tab'; tab: AdminTab }
      | { type: 'route'; target: string }
      | { type: 'logout' }
  ) => {
    if (action.type === 'tab') {
      setActiveTab(action.tab);
      setMobileNavOpen(false);
    } else if (action.type === 'route') {
      setMobileNavOpen(false);
      onNavigate(action.target);
    } else {
      setMobileNavOpen(false);
      void handleLogout();
    }
  };

  const requestGuardedAction = (
    action:
      | { type: 'tab'; tab: AdminTab }
      | { type: 'route'; target: string }
      | { type: 'logout' }
  ) => {
    if (action.type === 'tab' && action.tab === activeTab) {
      setMobileNavOpen(false);
      return;
    }
    if (hasUnsavedChanges) {
      setMobileNavOpen(false);
      setPendingNavAction(action);
      return;
    }
    executeNavAction(action);
  };

  if (isLoadingSession || gate === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FFF9F5] p-6">
        <div className="flex items-center gap-3 rounded-2xl border border-[#49243E]/12 bg-white px-6 py-4 text-sm font-medium text-[#49243E] shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin text-[#B76E79]" aria-hidden="true" />
          <span>Verifying atelier owner authorization...</span>
        </div>
      </div>
    );
  }

  if (gate === 'unauthenticated') {
    const switchPortalMode = (nextMode: 'signin' | 'activate' | 'forgot') => {
      setPortalMode(nextMode);
      setGateError(null);
      setResendStatus(null);
      setActivateAwaitingVerify(false);
      setLoginPassword('');
      setActivateConfirmPassword('');
    };

    return (
      <main className="flex min-h-screen items-center justify-center bg-[#FFF9F5] px-4 py-12">
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-md rounded-3xl border border-[#49243E]/12 bg-white p-7 shadow-[0_24px_60px_-28px_rgba(73,36,62,0.22)] sm:p-9"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-serif text-xl font-semibold text-[#49243E]">
              {settings.brandName || 'Sahithi Collections'}
            </span>
            <span className="inline-flex items-center gap-1 rounded-lg bg-[#F3D5DF]/45 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#49243E]">
              <Lock className="h-3 w-3" aria-hidden="true" />
              <span>Owner Portal</span>
            </span>
          </div>

          <h1 className="mt-6 font-serif text-3xl font-semibold text-[#49243E]">
            {portalMode === 'activate'
              ? 'Activate Owner Account'
              : portalMode === 'forgot'
                ? 'Reset Owner Password'
                : 'Private Studio Sign-In'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#242124]/70">
            {portalMode === 'activate'
              ? 'First-time setup for the single authorized store owner email. Public visitor accounts cannot activate studio access.'
              : portalMode === 'forgot'
                ? 'Receive a Firebase password recovery email for your authorized owner account.'
                : 'Authorized exclusively for the single boutique owner account configured on the server.'}
          </p>

          {isFirebaseManaged && portalMode !== 'forgot' && (
            <div
              role="tablist"
              aria-label="Owner access mode"
              className="mt-5 grid grid-cols-2 gap-1.5 rounded-xl border border-[#49243E]/12 bg-[#FFF9F5] p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={portalMode === 'signin'}
                onClick={() => switchPortalMode('signin')}
                className={`min-h-[40px] rounded-lg px-3 text-xs font-semibold transition-colors ${
                  portalMode === 'signin'
                    ? 'bg-[#49243E] text-[#FFF9F5] shadow-xs'
                    : 'text-[#49243E]/75 hover:text-[#49243E]'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={portalMode === 'activate'}
                onClick={() => switchPortalMode('activate')}
                className={`min-h-[40px] rounded-lg px-3 text-xs font-semibold transition-colors ${
                  portalMode === 'activate'
                    ? 'bg-[#49243E] text-[#FFF9F5] shadow-xs'
                    : 'text-[#49243E]/75 hover:text-[#49243E]'
                }`}
              >
                Activate Owner
              </button>
            </div>
          )}

          {isFirebaseManaged && capabilities.emailPasswordEnabled === false && (
            <div
              role="note"
              className="mt-5 space-y-2 rounded-xl border border-[#B76E79]/45 bg-[#FFF9F5] p-3.5 text-xs leading-relaxed text-[#49243E]"
            >
              <p className="font-semibold">Firebase Email/Password Sign-In Is Disabled</p>
              <p className="text-[#242124]/80">
                Firebase project{' '}
                {capabilities.firebaseProjectId ? (
                  <code className="rounded bg-[#F3D5DF]/45 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#49243E]">
                    {capabilities.firebaseProjectId}
                  </code>
                ) : (
                  'connected to this app'
                )}{' '}
                currently reports Email/Password sign-in turned off
                {capabilities.providerStatusReason
                  ? ` (${capabilities.providerStatusReason})`
                  : ''}
                . Enable{' '}
                <span className="font-medium text-[#49243E]">
                  Authentication → Sign-in method → Email/Password
                </span>{' '}
                and click <span className="font-medium text-[#49243E]">Save</span> before signing in,
                activating owner access, or resetting the owner password.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <button
                  type="button"
                  disabled={checkingProvider}
                  onClick={async () => {
                    if (checkingProvider) return;
                    setCheckingProvider(true);
                    setProviderCheckNote(null);
                    const updated = await refreshCapabilities();
                    setCheckingProvider(false);
                    const proj =
                      updated?.firebaseProjectId ||
                      capabilities.firebaseProjectId ||
                      'configured Firebase project';
                    if (!updated) {
                      setProviderCheckNote('Unable to check Firebase status right now.');
                    } else if (updated.emailPasswordEnabled) {
                      setResendStatus(`Email/Password authentication is active on project ${proj}.`);
                      setGateError(null);
                    } else {
                      setProviderCheckNote(
                        `Checked just now: project ${proj} still returns ${updated.providerStatusReason || 'PASSWORD_LOGIN_DISABLED'}. Confirm you edited project "${proj}" and clicked Save.`
                      );
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#49243E]/25 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30 disabled:opacity-60"
                >
                  {checkingProvider ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>{checkingProvider ? 'Checking Firebase...' : 'Re-check Firebase Status'}</span>
                </button>
                {capabilities.firebaseProjectId && (
                  <a
                    href={`https://console.firebase.google.com/project/${encodeURIComponent(capabilities.firebaseProjectId)}/authentication/providers`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79]"
                  >
                    <span>Open Firebase Sign-in Providers</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>
              {providerCheckNote && (
                <p className="text-[11px] font-medium text-[#9B2C3E]">{providerCheckNote}</p>
              )}
            </div>
          )}

          {gateError && (
            <div
              role="alert"
              className="mt-5 space-y-2.5 rounded-xl border border-[#B76E79]/50 bg-[#F3D5DF]/35 p-3.5 text-xs leading-relaxed text-[#49243E]"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                <span>{gateError}</span>
              </div>
              {pendingResendEmail && (capabilities.emailDeliveryConfigured || isFirebaseManaged) && (
                <button
                  type="button"
                  disabled={resendBusy || resendCooldownSec > 0}
                  onClick={() => void handleResendOwnerVerification()}
                  className="ml-6 inline-flex min-h-[36px] items-center gap-1.5 font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79] disabled:cursor-not-allowed disabled:opacity-55 disabled:no-underline"
                >
                  {resendBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  <span>
                    {resendBusy
                      ? 'Sending verification link...'
                      : resendCooldownSec > 0
                        ? `Resend available in ${resendCooldownSec}s`
                        : 'Resend verification email'}
                  </span>
                </button>
              )}
            </div>
          )}

          {resendStatus && (
            <div
              role="status"
              className="mt-4 flex items-start gap-2.5 rounded-xl border border-[#49243E]/20 bg-[#FFF9F5] p-3.5 text-xs leading-relaxed text-[#49243E]"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#49243E]" aria-hidden="true" />
              <span>{resendStatus}</span>
            </div>
          )}

          {portalMode === 'signin' && (
            <form onSubmit={handleAdminLogin} className="mt-6 space-y-4">
              <div>
                <label htmlFor="admin-email" className="block text-xs font-medium text-[#49243E]">
                  Owner Email
                </label>
                <input
                  id="admin-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="Enter your owner email"
                  className="mt-1.5 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="admin-password" className="block text-xs font-medium text-[#49243E]">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (isFirebaseManaged) {
                        switchPortalMode('forgot');
                      } else {
                        setShowResetHelp((prev) => !prev);
                      }
                    }}
                    className="text-xs font-medium text-[#B76E79] transition-colors hover:text-[#49243E]"
                  >
                    {!isFirebaseManaged && showResetHelp ? 'Hide reset guide' : 'Forgot password?'}
                  </button>
                </div>
                <div className="relative mt-1.5">
                  <input
                    id="admin-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter owner password"
                    className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 pl-3.5 pr-11 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute top-1/2 right-1.5 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {!isFirebaseManaged && showResetHelp && (
                <div className="rounded-xl border border-[#49243E]/12 bg-[#FFF9F5] p-3.5 text-xs leading-relaxed text-[#242124]/80">
                  <p className="font-semibold text-[#49243E]">Reset Owner Password (No Email Needed)</p>
                  <p className="mt-1">
                    Run{' '}
                    <code className="rounded bg-[#F3D5DF]/50 px-1.5 py-0.5 font-mono text-[11px] text-[#49243E]">
                      npm run admin:setup
                    </code>{' '}
                    on the server, or set{' '}
                    <code className="rounded bg-[#F3D5DF]/50 px-1.5 py-0.5 font-mono text-[11px] text-[#49243E]">
                      ADMIN_OWNER_PASSWORD
                    </code>{' '}
                    with{' '}
                    <code className="rounded bg-[#F3D5DF]/50 px-1.5 py-0.5 font-mono text-[11px] text-[#49243E]">
                      ADMIN_OWNER_PASSWORD_RESET=true
                    </code>{' '}
                    in server secrets and restart.
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={loginBusy || verifyCodeBusy}
                className="inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
              >
                {(loginBusy || verifyCodeBusy) && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                <span>
                  {verifyCodeBusy
                    ? 'Confirming verification...'
                    : loginBusy
                      ? 'Logging in...'
                      : 'Login'}
                </span>
              </button>
            </form>
          )}

          {isFirebaseManaged && portalMode === 'activate' && !activateAwaitingVerify && (
            <form onSubmit={handleActivateOwner} className="mt-6 space-y-4">
              <div>
                <label htmlFor="admin-act-email" className="block text-xs font-medium text-[#49243E]">
                  Authorized Owner Email
                </label>
                <input
                  id="admin-act-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="Enter authorized owner email"
                  className="mt-1.5 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="admin-act-password"
                  className="block text-xs font-medium text-[#49243E]"
                >
                  Create Owner Password
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="admin-act-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder={`At least ${capabilities.passwordMinLength} characters`}
                    className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 pl-3.5 pr-11 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute top-1/2 right-1.5 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="admin-act-confirm"
                  className="block text-xs font-medium text-[#49243E]"
                >
                  Confirm Owner Password
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="admin-act-confirm"
                    type={showActivateConfirm ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    value={activateConfirmPassword}
                    onChange={(e) => setActivateConfirmPassword(e.target.value)}
                    placeholder="Re-enter owner password"
                    className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 pl-3.5 pr-11 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowActivateConfirm((p) => !p)}
                    aria-label={
                      showActivateConfirm ? 'Hide confirmation password' : 'Show confirmation password'
                    }
                    className="absolute top-1/2 right-1.5 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40"
                  >
                    {showActivateConfirm ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loginBusy}
                className="inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
              >
                {loginBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                <span>{loginBusy ? 'Sending verification email...' : 'Create & Verify Owner'}</span>
              </button>
            </form>
          )}

          {isFirebaseManaged && portalMode === 'activate' && activateAwaitingVerify && (
            <div className="mt-5 space-y-4">
              <div className="rounded-xl border border-[#49243E]/12 bg-[#FFF9F5] p-4 text-xs leading-relaxed text-[#242124]/80">
                <p className="font-semibold text-[#49243E]">Verify your inbox before signing in</p>
                <p className="mt-1">
                  Open the Firebase verification email sent to{' '}
                  <span className="font-medium text-[#49243E]">{pendingResendEmail}</span> and click
                  the verification link, then sign in below.
                </p>
              </div>

              <form onSubmit={handleConfirmVerifyCode} className="space-y-3">
                <div>
                  <label
                    htmlFor="admin-verify-code"
                    className="block text-xs font-medium text-[#49243E]"
                  >
                    Optional: Paste Verification Link or Code
                  </label>
                  <input
                    id="admin-verify-code"
                    type="text"
                    value={verifyCodeInput}
                    onChange={(e) => setVerifyCodeInput(e.target.value)}
                    placeholder="Paste verification URL or oobCode"
                    className="mt-1.5 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={verifyCodeBusy || !verifyCodeInput.trim()}
                  className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/25 bg-white px-4 text-xs font-semibold text-[#49243E] hover:bg-[#FFF9F5] disabled:opacity-50"
                >
                  {verifyCodeBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  <span>Confirm Verification Code</span>
                </button>
              </form>

              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  disabled={resendBusy || resendCooldownSec > 0}
                  onClick={() => void handleResendOwnerVerification()}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#49243E]/20 bg-white px-4 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {resendBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  <span>
                    {resendBusy
                      ? 'Sending...'
                      : resendCooldownSec > 0
                        ? `Resend in ${resendCooldownSec}s`
                        : 'Resend Email'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPortalMode('signin');
                    setActivateAwaitingVerify(false);
                    setGateError(null);
                  }}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
                >
                  Proceed to Sign In
                </button>
              </div>
            </div>
          )}

          {isFirebaseManaged && portalMode === 'forgot' && (
            <div className="mt-6 space-y-5">
              <form onSubmit={handleAdminForgotSend} className="space-y-3.5">
                <div>
                  <label
                    htmlFor="admin-forgot-email"
                    className="block text-xs font-medium text-[#49243E]"
                  >
                    Owner Email
                  </label>
                  <input
                    id="admin-forgot-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="Enter your owner email"
                    className="mt-1.5 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={resetBusy}
                  className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
                >
                  {resetBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <span>{resetBusy ? 'Sending Reset Email...' : 'Send Password Reset Email'}</span>
                </button>
              </form>

              <div className="border-t border-[#49243E]/10 pt-4">
                <form onSubmit={handleAdminForgotConfirm} className="space-y-3">
                  <p className="text-xs font-semibold text-[#49243E]">
                    Already have a Firebase reset link or code?
                  </p>
                  <div>
                    <label
                      htmlFor="admin-reset-code"
                      className="block text-xs font-medium text-[#49243E]"
                    >
                      Reset Link or Code
                    </label>
                    <input
                      id="admin-reset-code"
                      type="text"
                      value={resetCodeInput}
                      onChange={(e) => setResetCodeInput(e.target.value)}
                      placeholder="Paste reset URL or oobCode"
                      className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="admin-reset-new-pw"
                      className="block text-xs font-medium text-[#49243E]"
                    >
                      New Password
                    </label>
                    <div className="relative mt-1">
                      <input
                        id="admin-reset-new-pw"
                        type={showResetPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={resetNewPassword}
                        onChange={(e) => setResetNewPassword(e.target.value)}
                        placeholder={`At least ${capabilities.passwordMinLength} characters`}
                        className="h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 pl-3.5 pr-11 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowResetPassword((p) => !p)}
                        aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                        className="absolute top-1/2 right-1.5 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#49243E]/70 hover:bg-[#F3D5DF]/40"
                      >
                        {showResetPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="admin-reset-confirm-pw"
                      className="block text-xs font-medium text-[#49243E]"
                    >
                      Confirm New Password
                    </label>
                    <input
                      id="admin-reset-confirm-pw"
                      type={showResetPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={resetConfirmPassword}
                      onChange={(e) => setResetConfirmPassword(e.target.value)}
                      placeholder="Re-enter new password"
                      className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={resetBusy}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/25 bg-white px-4 text-xs font-semibold text-[#49243E] hover:bg-[#FFF9F5] disabled:opacity-60"
                  >
                    {resetBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                    <span>Update Owner Password</span>
                  </button>
                </form>
              </div>

              <button
                type="button"
                onClick={() => switchPortalMode('signin')}
                className="inline-flex min-h-[40px] w-full items-center justify-center text-xs font-semibold text-[#49243E] underline decoration-[#B76E79] underline-offset-4 hover:text-[#B76E79]"
              >
                Back to Owner Sign-In
              </button>
            </div>
          )}

          <div className="mt-6 border-t border-[#49243E]/10 pt-5 text-center">
            <button
              type="button"
              onClick={() => onNavigate('/')}
              className="inline-flex min-h-[44px] items-center gap-1.5 px-3 text-xs font-medium text-[#49243E] hover:text-[#B76E79]"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Return to Storefront</span>
            </button>
          </div>
        </motion.div>
      </main>
    );
  }

  if (gate === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#FFF9F5] px-4 py-12">
        <div className="w-full max-w-md rounded-3xl border border-[#B76E79]/35 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/50 text-[#49243E]">
            <AlertTriangle className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="mt-5 font-serif text-3xl font-semibold text-[#49243E]">
            Unable to Verify Studio Access
          </h1>
          <p className="mt-2.5 text-sm leading-relaxed text-[#242124]/75">
            {gateError || 'We could not confirm your owner session with the server. Please retry.'}
          </p>

          <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
            <button
              type="button"
              onClick={() => onNavigate('/')}
              className="min-h-[44px] flex-1 rounded-xl border border-[#49243E]/20 bg-white px-4 text-sm font-medium text-[#49243E] hover:bg-[#FFF9F5]"
            >
              Go to Storefront
            </button>
            <button
              type="button"
              onClick={() => void checkAdminSession()}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-4 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (gate === 'forbidden') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#FFF9F5] px-4 py-12">
        <div className="w-full max-w-md rounded-3xl border border-[#B76E79]/35 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/50 text-[#49243E]">
            <ShieldAlert className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="mt-5 font-serif text-3xl font-semibold text-[#49243E]">
            Owner Authorization Required
          </h1>
          <p className="mt-2.5 text-sm leading-relaxed text-[#242124]/75">
            {gateError ||
              'Your current signed-in session is a customer account without store owner permissions.'}
          </p>

          <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
            <button
              type="button"
              onClick={() => onNavigate('/')}
              className="min-h-[44px] flex-1 rounded-xl border border-[#49243E]/20 bg-white px-4 text-sm font-medium text-[#49243E] hover:bg-[#FFF9F5]"
            >
              Go to Storefront
            </button>
            <button
              type="button"
              onClick={() => void checkAdminSession()}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl border border-[#49243E]/20 bg-white px-4 text-sm font-medium text-[#49243E] hover:bg-[#FFF9F5]"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span>Retry</span>
            </button>
            <button
              type="button"
              disabled={logoutBusy}
              onClick={async () => {
                if (logoutBusy) return;
                setLogoutBusy(true);
                setGateError(null);
                try {
                  const res = await logout();
                  if (!res.ok) {
                    setGateError(res.error);
                    return;
                  }
                  clearPrivateAdminState();
                  setGate('unauthenticated');
                  onNavigate('/admin/login', { replace: true });
                } finally {
                  setLogoutBusy(false);
                }
              }}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#49243E] px-4 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
            >
              {logoutBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LogOut className="h-4 w-4" aria-hidden="true" />
              )}
              <span>{logoutBusy ? 'Signing Out...' : 'Switch Account'}</span>
            </button>
          </div>
        </div>
      </main>
    );
  }

  const unreadCount = overviewData?.metrics.unreadMessages ?? 0;
  const pendingOrdersCount = overviewData?.metrics.pendingOrders ?? 0;

  const navItems: Array<{
    id: AdminTab;
    label: string;
    icon: typeof LayoutDashboard;
    count?: number;
  }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'catalog', label: 'Products', icon: Package },
    { id: 'categories', label: 'Categories', icon: FolderKanban },
    {
      id: 'orders',
      label: 'Orders',
      icon: ShoppingBag,
      count: pendingOrdersCount > 0 ? pendingOrdersCount : undefined,
    },
    {
      id: 'coupons',
      label: 'Coupons & Loyalty',
      icon: Tag,
      count:
        (overviewData?.metrics.openReturnRequests ?? 0) > 0
          ? overviewData?.metrics.openReturnRequests
          : undefined,
    },
    { id: 'content', label: 'Content', icon: Palette },
    {
      id: 'messages',
      label: 'Messages',
      icon: Mail,
      count: unreadCount > 0 ? unreadCount : undefined,
    },
    { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
    { id: 'account', label: 'Account & Audit', icon: ShieldCheck },
  ];

  const SidebarContent = (
    <div className="flex h-full flex-col justify-between overflow-y-auto p-5">
      <div>
        <div className="border-b border-[#49243E]/10 pb-4">
          <p className="text-[10px] font-semibold tracking-[0.2em] uppercase text-[#B76E79]">
            Atelier Owner Suite
          </p>
          <p className="mt-1 truncate font-serif text-2xl font-semibold text-[#49243E]">
            {settings.brandName || 'Sahithi Collections'}
          </p>
        </div>

        <nav aria-label="Admin sections" className="mt-5 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            const isTabDirty = Boolean(dirtySections[item.id]);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => requestGuardedAction({ type: 'tab', tab: item.id })}
                className={`flex min-h-[44px] w-full items-center justify-between gap-2.5 rounded-xl px-3.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[#49243E] text-[#FFF9F5]'
                    : 'text-[#49243E]/85 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                  {isTabDirty && (
                    <span
                      title="Unsaved changes"
                      aria-label="Unsaved changes"
                      className={`h-2 w-2 rounded-full ${
                        active ? 'bg-[#F3D5DF]' : 'bg-[#B76E79]'
                      }`}
                    />
                  )}
                </span>
                {item.count !== undefined && (
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                      active
                        ? 'bg-[#FFF9F5]/20 text-[#FFF9F5]'
                        : 'bg-[#F3D5DF]/65 text-[#49243E]'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="mt-6 space-y-3 border-t border-[#49243E]/10 pt-4">
        <div className="rounded-2xl bg-[#FFF9F5] p-3 text-xs">
          <p className="truncate font-semibold text-[#49243E]">
            {ownerUser?.fullName || 'Store Owner'}
          </p>
          <p className="truncate text-[11px] text-[#242124]/60">{ownerUser?.email}</p>
        </div>

        <button
          type="button"
          onClick={() => requestGuardedAction({ type: 'route', target: '/' })}
          className="flex min-h-[42px] w-full items-center justify-center gap-2 rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5]"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          <span>View Live Storefront</span>
        </button>

        <button
          type="button"
          disabled={logoutBusy}
          onClick={() => requestGuardedAction({ type: 'logout' })}
          className="flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl text-xs font-medium text-[#B76E79] hover:bg-[#F3D5DF]/35 hover:text-[#49243E] disabled:opacity-60"
        >
          {logoutBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{logoutBusy ? 'Signing Out...' : 'Logout'}</span>
        </button>
      </div>
    </div>
  );

  const headerMeta = TAB_TITLES[activeTab];

  return (
    <div className="flex min-h-screen overflow-x-clip bg-[#FFF9F5] text-[#242124]">
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-[#49243E]/12 bg-white lg:block">
        <div className="sticky top-0 h-screen">{SidebarContent}</div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-50 flex bg-[#242124]/45 lg:hidden"
          >
            <motion.aside
              initial={prefersReducedMotion ? false : { x: '-100%' }}
              animate={{ x: 0 }}
              exit={prefersReducedMotion ? undefined : { x: '-100%' }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="flex h-full w-72 flex-col bg-white shadow-2xl"
            >
              <div className="flex justify-end px-4 pt-3">
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Close admin menu"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-[#49243E]"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
              <div className="min-h-0 flex-1">{SidebarContent}</div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-[#49243E]/10 bg-[#FFF9F5]/95 backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open admin navigation"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#49243E]/15 bg-white text-[#49243E] lg:hidden"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate font-serif text-xl font-semibold text-[#49243E] sm:text-2xl">
                  {headerMeta.title}
                </h1>
                <p className="hidden truncate text-xs text-[#242124]/60 md:block">
                  {headerMeta.subtitle}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => requestGuardedAction({ type: 'route', target: '/' })}
                className="hidden min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E]/18 bg-white px-3.5 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30 sm:inline-flex"
              >
                <ExternalLink className="h-3.5 w-3.5 text-[#B76E79]" aria-hidden="true" />
                <span>Storefront</span>
              </button>

              {(activeTab === 'overview' || activeTab === 'catalog') && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingProduct(null);
                    setEditorOpen(true);
                  }}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#49243E] px-3.5 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] sm:px-4 sm:text-sm"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Add Product</span>
                </button>
              )}

              <button
                type="button"
                disabled={logoutBusy}
                onClick={() => requestGuardedAction({ type: 'logout' })}
                aria-label="Logout"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 disabled:opacity-60 sm:px-3.5"
              >
                {logoutBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#B76E79]" aria-hidden="true" />
                ) : (
                  <LogOut className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">{logoutBusy ? 'Signing Out...' : 'Logout'}</span>
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6 lg:px-8">
          {toast && (
            <div
              role={toast.kind === 'err' ? 'alert' : 'status'}
              className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm ${
                toast.kind === 'ok'
                  ? 'border-[#166534]/25 bg-white text-[#166534]'
                  : 'border-[#B76E79]/50 bg-[#F3D5DF]/35 text-[#49243E]'
              }`}
            >
              <div className="flex items-center gap-2">
                {toast.kind === 'ok' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                )}
                <span>{toast.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setToast(null)}
                aria-label="Dismiss message"
                className="rounded-lg p-1 text-current opacity-70 hover:opacity-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {activeTab === 'overview' && (
            <AdminOverviewSection
              overview={overviewData}
              loading={overviewLoading}
              onNavigateTab={(tab) => requestGuardedAction({ type: 'tab', tab })}
              onQuickFilterCatalog={(filter) => {
                setCatalogPage(1);
                setStatusFilter(filter.status || 'all');
                setStockFilter(filter.stock || 'all');
                requestGuardedAction({ type: 'tab', tab: 'catalog' });
              }}
              onCreateProduct={() => {
                setEditingProduct(null);
                setEditorOpen(true);
              }}
              onEditProduct={(product) => {
                setEditingProduct(product);
                setEditorOpen(true);
              }}
            />
          )}

          {activeTab === 'catalog' && (
            <AdminProductTable
              products={products}
              categories={categories}
              loading={catalogLoading}
              total={catalogTotal}
              page={catalogPage}
              totalPages={catalogTotalPages}
              searchQuery={searchQuery}
              statusFilter={statusFilter}
              categoryFilter={categoryFilter}
              stockFilter={stockFilter}
              sortBy={sortBy}
              busyProductId={busyProductId}
              onSearchChange={(q) => {
                setCatalogPage(1);
                setSearchQuery(q);
              }}
              onStatusChange={(s) => {
                setCatalogPage(1);
                setStatusFilter(s);
              }}
              onCategoryChange={(c) => {
                setCatalogPage(1);
                setCategoryFilter(c);
              }}
              onStockChange={(s) => {
                setCatalogPage(1);
                setStockFilter(s);
              }}
              onSortChange={(sort) => {
                setCatalogPage(1);
                setSortBy(sort);
              }}
              onPageChange={setCatalogPage}
              onCreateNew={() => {
                setEditingProduct(null);
                setEditorOpen(true);
              }}
              onEdit={(product) => {
                setEditingProduct(product);
                setEditorOpen(true);
              }}
              onDuplicate={(p) => void handleDuplicate(p)}
              onTogglePublish={(p) => void handleTogglePublish(p)}
              onArchiveToggle={(p) => void handleArchiveToggle(p)}
              onRequestDelete={setDeleteCandidate}
            />
          )}

          {activeTab === 'categories' && (
            <AdminCategoriesManager
              categories={categories}
              loading={categoriesLoading}
              onNotify={showToast}
              onMutated={handleCategoriesMutated}
              onDirtyChange={setCategoriesDirty}
            />
          )}

          {activeTab === 'orders' && (
            <AdminOrdersPanel
              orders={orders}
              loading={ordersLoading}
              page={ordersPage}
              totalPages={ordersTotalPages}
              onPageChange={setOrdersPage}
              onUpdateOrderStatus={handleUpdateOrderStatus}
              onCollectOrderPayment={handleCollectOrderPayment}
              onResolveReturnRequest={handleResolveReturnRequest}
              onRecoverOrder={handleRecoverOrder}
            />
          )}

          {activeTab === 'coupons' && (
            <AdminCouponsAndActivity
              refreshSignal={activityRefreshTick}
              onNotify={showToast}
              onNavigateOrders={() => requestGuardedAction({ type: 'tab', tab: 'orders' })}
            />
          )}

          {activeTab === 'content' && (
            <AdminContentManager
              categories={categories}
              onNotify={showToast}
              onMutated={handleStorefrontDocumentMutated}
              onDirtyChange={setContentDirty}
            />
          )}

          {activeTab === 'messages' && (
            <AdminMessagesPanel
              onNotify={showToast}
              onUnreadCountChanged={handleUnreadMessagesChange}
              onDirtyChange={setMessagesDirty}
            />
          )}

          {activeTab === 'settings' && (
            <AdminSettingsPanel
              onNotify={showToast}
              onMutated={handleStorefrontDocumentMutated}
              onDirtyChange={setSettingsDirty}
            />
          )}

          {activeTab === 'account' && (
            <div className="space-y-6">
              <AdminSecurityPanel
                ownerBinding={ownerBinding}
                onSignedOut={() => {
                  clearPrivateAdminState();
                  setGate('unauthenticated');
                  onNavigate('/admin/login', { replace: true });
                }}
              />
              <AdminAuditPanel
                logs={auditLogs}
                loading={auditLoading}
                page={auditPage}
                totalPages={auditTotalPages}
                onPageChange={setAuditPage}
              />
            </div>
          )}
        </main>
      </div>

      {/* Product Editor Slide-over */}
      <AdminProductEditorDrawer
        isOpen={editorOpen}
        product={editingProduct}
        categories={categories}
        onClose={() => setEditorOpen(false)}
        onSaved={(saved, notice) => {
          setEditorOpen(false);
          setEditingProduct(saved);
          showToast('ok', notice);
          void refreshCatalogAndMetrics();
        }}
        onReloadProduct={handleReloadEditingProduct}
      />

      {/* Destructive Delete/Archive Confirmation Modal */}
      {deleteCandidate && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#242124]/55 p-4"
        >
          <div className="w-full max-w-md rounded-3xl border border-[#49243E]/15 bg-[#FFF9F5] p-6 shadow-2xl">
            <h2 id="delete-confirm-title" className="font-serif text-2xl font-semibold text-[#49243E]">
              Delete &ldquo;{deleteCandidate.name}&rdquo;?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#242124]/75">
              {deleteCandidate.orderCount > 0
                ? `"${deleteCandidate.name}" appears in ${deleteCandidate.orderCount} historical order item(s). Confirming Delete will archive it from the active catalog and storefront so order history remains intact.`
                : `Permanently delete "${deleteCandidate.name}" (${deleteCandidate.sku}) from the catalog? This will remove it from the admin list and public storefront.`}
            </p>
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setDeleteCandidate(null)}
                className="min-h-[42px] rounded-xl border border-[#49243E]/20 bg-white px-4 text-sm font-medium text-[#49243E]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                className="min-h-[42px] rounded-xl bg-[#9B2C3E] px-4 text-sm font-medium text-[#FFF9F5] hover:bg-[#7D2231]"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved Changes Navigation Confirmation Modal */}
      {pendingNavAction && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="unsaved-nav-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#242124]/55 p-4"
        >
          <div className="w-full max-w-md rounded-3xl border border-[#49243E]/15 bg-[#FFF9F5] p-6 shadow-2xl">
            <h2 id="unsaved-nav-title" className="font-serif text-2xl font-semibold text-[#49243E]">
              Unsaved Dashboard Changes
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#242124]/75">
              You have unsaved edits in this section. Leaving now will discard your unsubmitted changes.
            </p>
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setPendingNavAction(null)}
                className="min-h-[42px] rounded-xl border border-[#49243E]/20 bg-white px-4 text-sm font-medium text-[#49243E]"
              >
                Keep Editing
              </button>
              <button
                type="button"
                onClick={() => {
                  const action = pendingNavAction;
                  setPendingNavAction(null);
                  setDirtySections({});
                  executeNavAction(action);
                }}
                className="min-h-[42px] rounded-xl bg-[#49243E] px-4 text-sm font-medium text-[#FFF9F5] hover:bg-[#3A1B31]"
              >
                Discard &amp; Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
