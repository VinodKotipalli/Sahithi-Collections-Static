import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Heart,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mail,
  ShieldCheck,
  User,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { SITE_CONFIG } from '../../config/site';

interface AccountDashboardProps {
  wishlistCount: number;
  onOpenWishlist: () => void;
  onNavigate: (target: string, options?: { replace?: boolean }) => void;
}

export function AccountDashboard({
  wishlistCount,
  onOpenWishlist,
  onNavigate,
}: AccountDashboardProps) {
  const {
    user,
    capabilities,
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

  // Profile name
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameFeedback, setNameFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  // Reauthentication
  const [reauthPassword, setReauthPassword] = useState('');
  const [showReauthPassword, setShowReauthPassword] = useState(false);
  const [reauthSubmitting, setReauthSubmitting] = useState(false);
  const [reauthFeedback, setReauthFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  // Update verified email
  const [newEmail, setNewEmail] = useState('');
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  // Password update
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [passSubmitting, setPassSubmitting] = useState(false);
  const [passFeedback, setPassFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  // Logout
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.fullName !== undefined) {
      setFullName(user.fullName);
    }
  }, [user?.fullName]);

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
      setReauthPassword('');
      setNewEmail('');
      setNewPassword('');
      setConfirmNewPassword('');
      setNameFeedback(null);
      setReauthFeedback(null);
      setEmailFeedback(null);
      setPassFeedback(null);
      onNavigate(redirectTarget, { replace: true });
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FFF9F5] text-[#242124]">
      <header className="sticky top-0 z-30 border-b border-[#49243E]/10 bg-[#FFF9F5]/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:h-20 lg:px-8">
          <div className="flex items-center gap-4 min-w-0">
            <button
              type="button"
              onClick={() => onNavigate('/')}
              className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-[#49243E] transition-colors hover:text-[#B76E79] whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Back to Collections</span>
              <span className="sm:hidden">Boutique</span>
            </button>
            <span aria-hidden="true" className="h-4 w-px bg-[#49243E]/15 hidden sm:inline-block" />
            <span className="font-serif text-xl font-semibold tracking-tight text-[#49243E] truncate">
              {SITE_CONFIG.brandName}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {user.isOwner && (
              <button
                type="button"
                onClick={() => onNavigate('/admin')}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E]/25 bg-[#F3D5DF]/40 px-3.5 text-xs font-semibold text-[#49243E] transition-colors hover:bg-[#F3D5DF]/65 whitespace-nowrap"
              >
                <LayoutDashboard className="h-4 w-4 text-[#49243E]" aria-hidden="true" />
                <span>Admin Dashboard</span>
              </button>
            )}

            <button
              type="button"
              onClick={onOpenWishlist}
              aria-label={`Open wishlist (${wishlistCount} saved items)`}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E]/15 bg-white px-3 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/30 whitespace-nowrap"
            >
              <Heart
                className={`h-4 w-4 ${wishlistCount > 0 ? 'fill-[#B76E79] text-[#B76E79]' : ''}`}
                aria-hidden="true"
              />
              <span>Wishlist ({wishlistCount})</span>
            </button>

            <button
              type="button"
              disabled={loggingOut}
              onClick={() => void handleLogout()}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#49243E] px-3.5 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60 whitespace-nowrap"
            >
              {loggingOut ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LogOut className="h-4 w-4" aria-hidden="true" />
              )}
              <span>{loggingOut ? 'Signing Out...' : 'Sign Out'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        {logoutError && (
          <div
            role="alert"
            className="mb-6 flex items-start gap-2.5 rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 px-4 py-3 text-sm text-[#49243E]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
            <span>{logoutError}</span>
          </div>
        )}
        <div className="border-b border-[#49243E]/12 pb-8">
          <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#B76E79]">
            Atelier Account
          </p>
          <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight text-[#49243E] sm:text-5xl">
            Welcome, {user.fullName || 'Boutique Member'}
          </h1>
          <p className="mt-3 text-sm text-[#242124]/75">
            {user.email && user.emailVerified ? `Email: ${user.email} (Verified)` : 'Email: Verification required'}
            {' · '}
            {user.hasPassword ? 'Password: Set' : 'Password: Not set'}
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left Column: Profile & Password Reauthentication */}
          <div className="space-y-6 lg:col-span-5">
            <section className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                  <User className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="font-serif text-xl font-semibold text-[#49243E]">Profile Details</h2>
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
                    className="mt-1.5 min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
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

            {/* Reauthentication Panel */}
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
                  Your identity is freshly verified. You can update your verified email address or
                  password on the right.
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
                      className="min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 pr-11 text-base text-[#242124] focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
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

          {/* Right Column: Email Management & Password */}
          <div className="space-y-6 lg:col-span-7">
            {/* Update Verified Email */}
            <section className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                    <Mail className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div>
                    <h2 className="font-serif text-xl font-semibold text-[#49243E]">
                      Email Address
                    </h2>
                    <p className="text-xs text-[#242124]/65">
                      {user.email && user.emailVerified
                        ? `Current verified email: ${user.email}`
                        : 'Email verification required'}
                    </p>
                  </div>
                </div>
              </div>

              {capabilities.authMode === 'firebase_managed' ? (
                <div className="mt-4 space-y-3">
                  {capabilities.emailPasswordEnabled === false && (
                    <p className="rounded-xl border border-[#B76E79]/35 bg-[#FFF9F5] px-3.5 py-2.5 text-xs text-[#49243E]">
                      Firebase Email/Password authentication is currently disabled in Firebase
                      Console for this project.
                    </p>
                  )}
                  <p className="rounded-xl border border-[#49243E]/15 bg-[#FFF9F5] px-3.5 py-3 text-xs leading-relaxed text-[#242124]/80">
                    Your primary email is locked to your verified Firebase account. Register and
                    verify a new account if you need a different login email.
                  </p>
                </div>
              ) : (
                <>
                  {!capabilities.emailDeliveryConfigured && (
                    <p className="mt-4 rounded-xl border border-[#B76E79]/35 bg-[#FFF9F5] px-3.5 py-2.5 text-xs text-[#49243E]">
                      SMTP email delivery is not configured in{' '}
                      <code className="font-mono">.env</code> yet, so email verification links
                      cannot be dispatched until configured.
                    </p>
                  )}

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
                    <div>
                      <label
                        htmlFor={linkEmailId}
                        className="block text-sm font-medium text-[#49243E]"
                      >
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
                        className="mt-1.5 min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 text-base text-[#242124] disabled:cursor-not-allowed disabled:opacity-55 focus:border-[#49243E] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#49243E]/15 sm:text-sm"
                      />
                    </div>
                    <p className="text-xs text-[#242124]/60">
                      We&apos;ll send a single-use verification link before updating your account
                      email. Emails already belonging to another account cannot be merged.
                    </p>
                    <button
                      type="submit"
                      disabled={
                        !reauthActive || emailSubmitting || !capabilities.emailDeliveryConfigured
                      }
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      {emailSubmitting && (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      )}
                      <span>Send Verification Link</span>
                    </button>
                  </form>
                </>
              )}
            </section>

            {/* Password Management */}
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
                    <label
                      htmlFor={confirmNewPassId}
                      className="block text-sm font-medium text-[#49243E]"
                    >
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
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {passSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <span>Update Password</span>
                </button>
              </form>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
