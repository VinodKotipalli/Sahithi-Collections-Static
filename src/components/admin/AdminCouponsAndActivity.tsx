import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Gift, Loader2, Plus, RefreshCw, ShieldCheck, Tag, Trash2, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type {
  BoutiqueCoupon,
  BoutiqueGiftCard,
  LoyaltyConfig,
  StoreActivityEvent,
} from '../../types/boutique';
import { formatPaiseINR, formatTimestamp } from '../../utils/format';

interface AdminCouponsAndActivityProps {
  refreshSignal?: number;
  onNotify: (kind: 'ok' | 'err', text: string) => void;
  onNavigateOrders?: () => void;
}

export function AdminCouponsAndActivity({
  refreshSignal = 0,
  onNotify,
  onNavigateOrders,
}: AdminCouponsAndActivityProps) {
  const { apiRequest } = useAuth();

  const [coupons, setCoupons] = useState<BoutiqueCoupon[]>([]);
  const [giftCards, setGiftCards] = useState<BoutiqueGiftCard[]>([]);
  const [loyalty, setLoyalty] = useState<LoyaltyConfig | null>(null);
  const [events, setEvents] = useState<StoreActivityEvent[]>([]);
  const [customers, setCustomers] = useState<
    Array<{ id: string; fullName: string; email: string; emailVerified: boolean; createdAt: number }>
  >([]);
  const [loading, setLoading] = useState(true);

  // Coupon creation state
  const [cpnCode, setCpnCode] = useState('');
  const [cpnTitle, setCpnTitle] = useState('');
  const [cpnDesc, setCpnDesc] = useState('');
  const [cpnType, setCpnType] = useState<'percent' | 'flat_paise'>('percent');
  const [cpnValue, setCpnValue] = useState('10');
  const [cpnMinInr, setCpnMinInr] = useState('0');
  const [cpnSaving, setCpnSaving] = useState(false);

  // Gift card creation state
  const [gcCode, setGcCode] = useState('');
  const [gcBalanceInr, setGcBalanceInr] = useState('1000');
  const [gcRecipient, setGcRecipient] = useState('');
  const [gcNote, setGcNote] = useState('');
  const [gcSaving, setGcSaving] = useState(false);

  // Loyalty form state
  const [loyaltySaving, setLoyaltySaving] = useState(false);
  const [benefitsInput, setBenefitsInput] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [cpnRes, gcRes, loyRes, actRes] = await Promise.all([
      apiRequest<{ items: BoutiqueCoupon[] }>('/api/admin/coupons'),
      apiRequest<{ items: BoutiqueGiftCard[] }>('/api/admin/gift-cards'),
      apiRequest<{ config: LoyaltyConfig }>('/api/admin/loyalty'),
      apiRequest<{
        events: StoreActivityEvent[];
        users: Array<{
          id: string;
          fullName: string;
          email: string;
          emailVerified: boolean;
          createdAt: number;
        }>;
      }>('/api/admin/activity'),
    ]);
    setLoading(false);

    if (cpnRes.ok) setCoupons(cpnRes.data.items || []);
    if (gcRes.ok) setGiftCards(gcRes.data.items || []);
    if (loyRes.ok && loyRes.data.config) {
      setLoyalty(loyRes.data.config);
      setBenefitsInput((loyRes.data.config.plusBenefits || []).join('\n'));
    }
    if (actRes.ok) {
      setEvents(actRes.data.events || []);
      setCustomers(actRes.data.users || []);
    }
  }, [apiRequest]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, refreshSignal]);

  const handleCreateCoupon = async (e: FormEvent) => {
    e.preventDefault();
    if (cpnSaving) return;
    setCpnSaving(true);
    const rawNum = Math.round(Number(cpnValue) || 0);
    const discountValue = cpnType === 'flat_paise' ? rawNum * 100 : rawNum;
    const minSpendPaise = Math.max(0, Math.round((Number(cpnMinInr) || 0) * 100));
    const res = await apiRequest<{ coupon: BoutiqueCoupon }>('/api/admin/coupons', {
      method: 'POST',
      body: JSON.stringify({
        code: cpnCode.trim().toUpperCase(),
        title: cpnTitle.trim(),
        description: cpnDesc.trim(),
        discountType: cpnType,
        discountValue,
        minSpendPaise,
        active: true,
      }),
    });
    setCpnSaving(false);
    if (!res.ok) {
      onNotify('err', res.error);
      return;
    }
    setCpnCode('');
    setCpnTitle('');
    setCpnDesc('');
    onNotify('ok', `Coupon ${res.data.coupon.code} saved.`);
    await loadAll();
  };

  const handleToggleCoupon = async (c: BoutiqueCoupon) => {
    const res = await apiRequest<{ coupon: BoutiqueCoupon }>(
      `/api/admin/coupons/${encodeURIComponent(c.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...c, active: !c.active }),
      }
    );
    if (!res.ok) {
      onNotify('err', res.error);
      return;
    }
    onNotify('ok', `Coupon ${c.code} ${!c.active ? 'activated' : 'paused'}.`);
    await loadAll();
  };

  const handleDeleteCoupon = async (c: BoutiqueCoupon) => {
    const res = await apiRequest<{ ok: boolean }>(
      `/api/admin/coupons/${encodeURIComponent(c.id)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) {
      onNotify('err', res.error);
      return;
    }
    onNotify('ok', `Deleted coupon ${c.code}.`);
    await loadAll();
  };

  const handleCreateGiftCard = async (e: FormEvent) => {
    e.preventDefault();
    if (gcSaving) return;
    setGcSaving(true);
    const balancePaise = Math.max(100, Math.round((Number(gcBalanceInr) || 0) * 100));
    const res = await apiRequest<{ giftCard: BoutiqueGiftCard }>('/api/admin/gift-cards', {
      method: 'POST',
      body: JSON.stringify({
        code: gcCode.trim().toUpperCase(),
        initialBalancePaise: balancePaise,
        balancePaise,
        recipientEmail: gcRecipient.trim().toLowerCase(),
        note: gcNote.trim(),
        active: true,
      }),
    });
    setGcSaving(false);
    if (!res.ok) {
      onNotify('err', res.error);
      return;
    }
    setGcCode('');
    setGcRecipient('');
    setGcNote('');
    onNotify('ok', `Gift card ${res.data.giftCard.code} issued.`);
    await loadAll();
  };

  const handleToggleGiftCard = async (gc: BoutiqueGiftCard) => {
    const res = await apiRequest<{ giftCard: BoutiqueGiftCard }>(
      `/api/admin/gift-cards/${encodeURIComponent(gc.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...gc, active: !gc.active }),
      }
    );
    if (!res.ok) {
      onNotify('err', res.error);
      return;
    }
    onNotify('ok', `Gift card ${gc.code} ${!gc.active ? 'activated' : 'deactivated'}.`);
    await loadAll();
  };

  const handleSaveLoyalty = async (e: FormEvent) => {
    e.preventDefault();
    if (!loyalty || loyaltySaving) return;
    setLoyaltySaving(true);
    const parsedBenefits = benefitsInput
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await apiRequest<{ config: LoyaltyConfig }>('/api/admin/loyalty', {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          ...loyalty,
          plusBenefits: parsedBenefits,
        },
      }),
    });
    setLoyaltySaving(false);
    if (!res.ok) {
      onNotify('err', res.error);
      return;
    }
    setLoyalty(res.data.config);
    onNotify('ok', 'Sahithi Rewards & Plus configuration saved.');
  };

  if (loading && coupons.length === 0 && events.length === 0) {
    return (
      <div className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-6">
        <div className="h-32 animate-pulse rounded-2xl bg-[#FFF9F5]" />
        <div className="h-32 animate-pulse rounded-2xl bg-[#FFF9F5]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Coupons + Gift Cards */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Tag className="h-5 w-5 text-[#B76E79]" aria-hidden="true" />
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">Boutique Coupons</h2>
          </div>

          <form onSubmit={handleCreateCoupon} className="space-y-2.5 rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5]/75 p-4">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <input
                type="text"
                required
                value={cpnCode}
                onChange={(e) => setCpnCode(e.target.value.toUpperCase())}
                placeholder="Code (e.g. FESTIVE10)"
                className="min-h-[42px] rounded-xl border border-[#49243E]/18 bg-white px-3 font-mono text-xs uppercase"
              />
              <input
                type="text"
                required
                value={cpnTitle}
                onChange={(e) => setCpnTitle(e.target.value)}
                placeholder="Offer Title"
                className="min-h-[42px] rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs"
              />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <select
                aria-label="Coupon discount type"
                value={cpnType}
                onChange={(e) => setCpnType(e.target.value as 'percent' | 'flat_paise')}
                className="min-h-[42px] rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs text-[#49243E]"
              >
                <option value="percent">% Off</option>
                <option value="flat_paise">Flat ₹ Off</option>
              </select>
              <input
                type="number"
                required
                min={1}
                value={cpnValue}
                onChange={(e) => setCpnValue(e.target.value)}
                placeholder={cpnType === 'percent' ? 'Percent (e.g. 10)' : 'Flat INR (e.g. 200)'}
                className="min-h-[42px] rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs"
              />
              <input
                type="number"
                min={0}
                value={cpnMinInr}
                onChange={(e) => setCpnMinInr(e.target.value)}
                placeholder="Min Bag ₹"
                className="min-h-[42px] rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs"
              />
            </div>
            <input
              type="text"
              value={cpnDesc}
              onChange={(e) => setCpnDesc(e.target.value)}
              placeholder="Short customer-facing note (optional)"
              className="min-h-[40px] w-full rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs"
            />
            <button
              type="submit"
              disabled={cpnSaving}
              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{cpnSaving ? 'Saving…' : 'Create Coupon'}</span>
            </button>
          </form>

          {coupons.length === 0 ? (
            <p className="py-4 text-center text-xs text-[#242124]/65">No coupons created yet.</p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {coupons.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
                  <div>
                    <p className="font-semibold text-[#49243E]">
                      <span className="font-mono">{c.code}</span> · {c.title}
                    </p>
                    <p className="text-[#242124]/65 tabular-nums">
                      {c.discountType === 'percent'
                        ? `${c.discountValue}% off`
                        : `${formatPaiseINR(c.discountValue)} off`}{' '}
                      · Used {c.usedCount} time(s) · {c.active ? 'Active' : 'Paused'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleToggleCoupon(c)}
                      className="min-h-[36px] rounded-lg border border-[#49243E]/20 px-2.5 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5]"
                    >
                      {c.active ? 'Pause' : 'Activate'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteCoupon(c)}
                      aria-label={`Delete coupon ${c.code}`}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-[#9B2C3E] hover:bg-[#F3D5DF]/40"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Gift className="h-5 w-5 text-[#B76E79]" aria-hidden="true" />
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">Sahithi Gift Cards</h2>
          </div>

          <form onSubmit={handleCreateGiftCard} className="space-y-2.5 rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5]/75 p-4">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <input
                type="text"
                required
                value={gcCode}
                onChange={(e) => setGcCode(e.target.value.toUpperCase())}
                placeholder="Gift Code (e.g. SAHITHI-GIFT-500)"
                className="min-h-[42px] rounded-xl border border-[#49243E]/18 bg-white px-3 font-mono text-xs uppercase"
              />
              <input
                type="number"
                required
                min={1}
                value={gcBalanceInr}
                onChange={(e) => setGcBalanceInr(e.target.value)}
                placeholder="Value in INR (e.g. 1000)"
                className="min-h-[42px] rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs"
              />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <input
                type="email"
                value={gcRecipient}
                onChange={(e) => setGcRecipient(e.target.value)}
                placeholder="Recipient Email (optional)"
                className="min-h-[40px] rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs"
              />
              <input
                type="text"
                value={gcNote}
                onChange={(e) => setGcNote(e.target.value)}
                placeholder="Note (optional)"
                className="min-h-[40px] rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs"
              />
            </div>
            <button
              type="submit"
              disabled={gcSaving}
              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-[#49243E] px-4 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{gcSaving ? 'Issuing…' : 'Issue Gift Card'}</span>
            </button>
          </form>

          {giftCards.length === 0 ? (
            <p className="py-4 text-center text-xs text-[#242124]/65">No gift cards issued yet.</p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {giftCards.map((gc) => (
                <li key={gc.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
                  <div>
                    <p className="font-mono font-semibold text-[#49243E]">{gc.code}</p>
                    <p className="text-[#242124]/65 tabular-nums">
                      Balance {formatPaiseINR(gc.balancePaise)} / {formatPaiseINR(gc.initialBalancePaise)}{' '}
                      · {gc.active ? 'Active' : 'Inactive'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleToggleGiftCard(gc)}
                    className="min-h-[36px] rounded-lg border border-[#49243E]/20 px-2.5 text-xs font-medium text-[#49243E] hover:bg-[#FFF9F5]"
                  >
                    {gc.active ? 'Deactivate' : 'Activate'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Loyalty & Plus Config */}
      {loyalty && (
        <section className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-[#B76E79]" aria-hidden="true" />
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">
              Sahithi Rewards &amp; Plus Tier Configuration
            </h2>
          </div>

          <form onSubmit={handleSaveLoyalty} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="block font-medium text-[#49243E]">Points per ₹100 Paid</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={loyalty.pointsPerHundredInr}
                  onChange={(e) =>
                    setLoyalty((p) =>
                      p ? { ...p, pointsPerHundredInr: Number(e.target.value) || 0 } : p
                    )
                  }
                  className="mt-1 min-h-[42px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3"
                />
              </div>
              <div>
                <label className="block font-medium text-[#49243E]">Point Value (INR)</label>
                <input
                  type="number"
                  min={0}
                  max={50}
                  step="0.5"
                  value={loyalty.rupeeValuePerPointPaise / 100}
                  onChange={(e) =>
                    setLoyalty((p) =>
                      p
                        ? { ...p, rupeeValuePerPointPaise: Math.round((Number(e.target.value) || 0) * 100) }
                        : p
                    )
                  }
                  className="mt-1 min-h-[42px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3"
                />
              </div>
              <div>
                <label className="block font-medium text-[#49243E]">Plus Qualification Spend (₹)</label>
                <input
                  type="number"
                  min={100}
                  value={Math.round(loyalty.plusQualificationSpendPaise / 100)}
                  onChange={(e) =>
                    setLoyalty((p) =>
                      p
                        ? {
                            ...p,
                            plusQualificationSpendPaise: Math.max(
                              100,
                              Math.round((Number(e.target.value) || 100) * 100)
                            ),
                          }
                        : p
                    )
                  }
                  className="mt-1 min-h-[42px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block font-medium text-[#49243E]">Plus Tier Name</label>
                <input
                  type="text"
                  value={loyalty.plusTierName}
                  onChange={(e) =>
                    setLoyalty((p) => (p ? { ...p, plusTierName: e.target.value } : p))
                  }
                  className="mt-1 min-h-[42px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3"
                />
              </div>
              <div className="flex flex-wrap items-end gap-4 pb-2">
                <label className="flex items-center gap-2 font-medium text-[#49243E]">
                  <input
                    type="checkbox"
                    checked={loyalty.rewardsEnabled}
                    onChange={(e) =>
                      setLoyalty((p) => (p ? { ...p, rewardsEnabled: e.target.checked } : p))
                    }
                  />
                  <span>Rewards Active</span>
                </label>
                <label className="flex items-center gap-2 font-medium text-[#49243E]">
                  <input
                    type="checkbox"
                    checked={loyalty.plusEnabled}
                    onChange={(e) =>
                      setLoyalty((p) => (p ? { ...p, plusEnabled: e.target.checked } : p))
                    }
                  />
                  <span>Plus Program Active</span>
                </label>
              </div>
            </div>

            <div>
              <label className="block font-medium text-[#49243E]">
                Plus Member Benefits (one per line)
              </label>
              <textarea
                rows={3}
                value={benefitsInput}
                onChange={(e) => setBenefitsInput(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 p-3 text-xs"
              />
            </div>

            <button
              type="submit"
              disabled={loyaltySaving}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-5 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
            >
              {loyaltySaving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              <span>Save Loyalty Settings</span>
            </button>
          </form>
        </section>
      )}

      {/* Store Activity Feed + Registered Customers */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6 lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between gap-2 border-b border-[#49243E]/10 pb-3">
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">
              Live Customer Activity &amp; Requests
            </h2>
            <div className="flex items-center gap-2">
              {onNavigateOrders && (
                <button
                  type="button"
                  onClick={onNavigateOrders}
                  className="text-xs font-medium text-[#B76E79] hover:text-[#49243E]"
                >
                  Manage Orders &rarr;
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadAll()}
                aria-label="Refresh activity feed"
                className="rounded-lg p-1.5 text-[#49243E] hover:bg-[#F3D5DF]/40"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              </button>
            </div>
          </div>

          {events.length === 0 ? (
            <p className="py-8 text-center text-xs text-[#242124]/65">
              Customer registrations, orders, return requests, and coupon redemptions appear here.
            </p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {events.map((ev) => (
                <li key={ev.id} className="flex items-start justify-between gap-3 py-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-semibold text-[#49243E]">
                      <span className="uppercase tracking-wider text-[#B76E79]">
                        {ev.type.replace(/_/g, ' ')}
                      </span>{' '}
                      · {ev.title}
                    </p>
                    <p className="mt-0.5 text-[#242124]/75">{ev.detail}</p>
                    <p className="mt-0.5 text-[11px] text-[#242124]/55">
                      {ev.actorLabel}
                      {ev.status ? ` · ${ev.status}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 tabular-nums text-[11px] text-[#242124]/55">
                    {formatTimestamp(ev.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6 lg:col-span-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-[#49243E]/10 pb-3">
            <Users className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">
              Registered Accounts ({customers.length})
            </h2>
          </div>
          {customers.length === 0 ? (
            <p className="py-8 text-center text-xs text-[#242124]/65">No customer accounts yet.</p>
          ) : (
            <ul className="divide-y divide-[#49243E]/10">
              {customers.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[#49243E]">{c.fullName}</p>
                    <p className="truncate text-[#242124]/65">{c.email}</p>
                  </div>
                  <span className="shrink-0 tabular-nums text-[11px] text-[#242124]/55">
                    {c.emailVerified ? 'Verified' : 'Unverified'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
