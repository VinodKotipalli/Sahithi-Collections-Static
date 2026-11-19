import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  KeyRound,
  Loader2,
  LogOut,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { AdminAuditEntry, AdminOrder } from '../../types/boutique';
import { formatPaiseINR, formatTimestamp } from '../../utils/format';

interface AdminOrdersPanelProps {
  orders: AdminOrder[];
  loading: boolean;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onUpdateOrderStatus: (
    orderId: string,
    status: string,
    note?: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onCollectOrderPayment?: (
    orderId: string,
    note?: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onResolveReturnRequest: (
    orderId: string,
    decision: 'approved' | 'rejected',
    note?: string,
    requestType?: 'cancel' | 'return'
  ) => Promise<{ ok: boolean; error?: string }>;
  onRecoverOrder: (
    razorpayOrderId: string,
    razorpayPaymentId?: string
  ) => Promise<{ ok: boolean; message?: string; error?: string }>;
}

const ORDER_STATUSES = [
  'pending',
  'placed',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;

export function AdminOrdersPanel({
  orders,
  loading,
  page,
  totalPages,
  onPageChange,
  onUpdateOrderStatus,
  onCollectOrderPayment,
  onResolveReturnRequest,
  onRecoverOrder,
}: AdminOrdersPanelProps) {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [statusNotes, setStatusNotes] = useState<Record<string, string>>({});
  const [orderErrors, setOrderErrors] = useState<Record<string, string>>({});

  // Captured payment recovery form
  const [recoverOrderId, setRecoverOrderId] = useState('');
  const [recoverPaymentId, setRecoverPaymentId] = useState('');
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [recoverFeedback, setRecoverFeedback] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  const handleRecoverSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (recoverBusy) return;
    setRecoverFeedback(null);
    const ord = recoverOrderId.trim();
    const pay = recoverPaymentId.trim();
    if (!ord) {
      setRecoverFeedback({
        kind: 'err',
        text: 'Enter a Razorpay Order ID (order_...) to check or recover a captured payment.',
      });
      return;
    }
    setRecoverBusy(true);
    const res = await onRecoverOrder(ord, pay || undefined);
    setRecoverBusy(false);
    if (!res.ok) {
      setRecoverFeedback({
        kind: 'err',
        text: res.error || 'Could not recover this Razorpay payment.',
      });
      return;
    }
    setRecoverOrderId('');
    setRecoverPaymentId('');
    setRecoverFeedback({
      kind: 'ok',
      text: res.message || `Verified & synced Razorpay order ${ord}.`,
    });
  };

  return (
    <div className="space-y-6">
      {/* Razorpay Captured Payment Recovery Panel */}
      <section
        aria-label="Recover captured Razorpay payment"
        className="rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl font-semibold text-[#49243E]">
              Recover Captured Razorpay Payment
            </h2>
            <p className="mt-1 text-xs text-[#242124]/65">
              If a shopper closed the browser before checkout returned, enter the Razorpay Order ID (and optional Payment ID) to verify capture directly with Razorpay and materialize the order once.
            </p>
          </div>
        </div>

        <form onSubmit={handleRecoverSubmit} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={recoverOrderId}
            onChange={(e) => setRecoverOrderId(e.target.value)}
            placeholder="Razorpay Order ID (order_...)"
            className="min-h-[44px] flex-1 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 font-mono text-xs text-[#49243E] focus:border-[#49243E] focus:bg-white focus:outline-none"
          />
          <input
            type="text"
            value={recoverPaymentId}
            onChange={(e) => setRecoverPaymentId(e.target.value)}
            placeholder="Payment ID (pay_..., optional)"
            className="min-h-[44px] flex-1 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3.5 font-mono text-xs text-[#49243E] focus:border-[#49243E] focus:bg-white focus:outline-none"
          />
          <button
            type="submit"
            disabled={recoverBusy}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-xs font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${recoverBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{recoverBusy ? 'Verifying…' : 'Verify & Recover'}</span>
          </button>
        </form>

        {recoverFeedback && (
          <p
            role={recoverFeedback.kind === 'err' ? 'alert' : 'status'}
            className={`mt-3 text-xs font-medium ${
              recoverFeedback.kind === 'err' ? 'text-[#9B2C3E]' : 'text-[#166534]'
            }`}
          >
            {recoverFeedback.text}
          </p>
        )}
      </section>

      {loading ? (
        <div className="space-y-3 rounded-3xl border border-[#49243E]/12 bg-white p-6">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div key={idx} className="h-24 animate-pulse rounded-2xl bg-[#FFF9F5]" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <section className="flex flex-col items-center justify-center rounded-3xl border border-[#49243E]/12 bg-white px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
            <PackageCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <h3 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
            No customer orders recorded yet
          </h3>
          <p className="mt-1.5 max-w-md text-sm text-[#242124]/70">
            When shoppers place orders from the Boutique Bag, real order totals, snapshots, and variant deductions will appear here.
          </p>
        </section>
      ) : (
        <section
          aria-label="Customer orders"
          className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6"
        >
          <div className="space-y-4">
            {orders.map((order) => {
              const isCod = order.paymentMethod === 'cod';
              const payment = order.paymentStatus || (order.razorpayPaymentId ? 'paid' : 'unpaid');
              const fulfillment = order.fulfillmentStatus || order.status || 'placed';
              const isUnpaidCod = isCod && payment !== 'paid';
              const canCollectPayment =
                isUnpaidCod &&
                fulfillment !== 'cancelled' &&
                fulfillment !== 'returned' &&
                typeof onCollectOrderPayment === 'function';
              const paymentDisplay =
                payment === 'paid'
                  ? 'Paid'
                  : isCod
                    ? 'Payment due on delivery'
                    : payment;

              return (
                <div
                  key={order.id}
                  className="space-y-3 rounded-2xl border border-[#49243E]/12 bg-[#FFF9F5]/55 p-4 sm:p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#49243E]/10 pb-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-xs font-semibold text-[#B76E79]">
                          {order.orderNumber}
                          {order.customerUserId ? ' · Registered Customer' : ' · Guest Checkout'}
                        </p>
                        <span className="rounded-md border border-[#49243E]/20 bg-white px-2 py-0.5 text-[11px] font-medium text-[#49243E]">
                          {isCod ? 'Cash on Delivery' : 'Online · Razorpay'}
                        </span>
                        {order.hiddenByCustomer && (
                          <span className="rounded-md border border-[#B76E79]/40 bg-[#F3D5DF]/40 px-2 py-0.5 text-[11px] font-medium text-[#49243E]">
                            Hidden by customer
                          </span>
                        )}
                      </div>
                      <h3 className="mt-0.5 font-serif text-xl font-semibold text-[#49243E]">
                        {order.customerName}
                      </h3>
                      <p className="mt-0.5 text-xs font-semibold uppercase tracking-wider text-[#49243E] tabular-nums">
                        Payment: {paymentDisplay} · Fulfillment: {fulfillment.replace(/_/g, ' ')}
                      </p>
                      {order.cancelRequest?.status === 'pending' && (
                        <p className="mt-1 text-xs font-semibold text-[#9B2C3E]">
                          Cancellation requested · Pending review
                        </p>
                      )}
                      {order.returnRequest?.status === 'pending' && (
                        <p className="mt-1 text-xs font-semibold text-[#B76E79]">
                          Return requested · Pending review
                        </p>
                      )}
                      {order.needsAdminReview && (
                        <p className="mt-1 rounded-lg border border-[#B76E79]/40 bg-[#F3D5DF]/30 px-2.5 py-1 text-[11px] font-medium text-[#49243E]">
                          Legacy Status Review: {order.legacyCollisionNote || 'Recovered pre-update cancellation state.'}
                        </p>
                      )}
                      <p className="mt-1 text-xs tabular-nums text-[#242124]/65">
                        {order.customerEmail} · {order.customerPhone} · Placed{' '}
                        {formatTimestamp(order.createdAt)}
                        {order.paymentCollectedAt
                          ? ` · Collected ${formatTimestamp(order.paymentCollectedAt)}`
                          : ''}
                        {order.deliveryDetailsEditedAt
                          ? ` · Delivery edited ${formatTimestamp(order.deliveryDetailsEditedAt)}`
                          : ''}
                        {order.stockRestoredAt
                          ? ` · Stock restored ${formatTimestamp(order.stockRestoredAt)}`
                          : ''}
                      </p>
                      {order.razorpayOrderId && (
                        <p className="mt-1 font-mono text-[11px] text-[#242124]/65">
                          Razorpay Order: {order.razorpayOrderId}
                          {order.razorpayPaymentId ? ` · Payment: ${order.razorpayPaymentId}` : ''}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-[#242124]/75">{order.shippingAddress}</p>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <div className="text-right tabular-nums">
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#49243E]/60">
                          {isUnpaidCod ? 'Amount Due on Delivery' : 'Total'}
                        </span>
                        <span className="font-serif text-xl font-semibold text-[#49243E]">
                          {formatPaiseINR(order.totalPaise)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {canCollectPayment && (
                          <button
                            type="button"
                            disabled={collectingId === order.id || updatingId === order.id}
                            onClick={async () => {
                              if (!onCollectOrderPayment) return;
                              setCollectingId(order.id);
                              setOrderErrors((prev) => {
                                if (!prev[order.id]) return prev;
                                const next = { ...prev };
                                delete next[order.id];
                                return next;
                              });
                              try {
                                const result = await onCollectOrderPayment(
                                  order.id,
                                  statusNotes[order.id]?.trim() || undefined
                                );
                                if (!result.ok) {
                                  setOrderErrors((prev) => ({
                                    ...prev,
                                    [order.id]:
                                      result.error ||
                                      'Could not mark COD payment as collected.',
                                  }));
                                } else {
                                  setStatusNotes((prev) => {
                                    const next = { ...prev };
                                    delete next[order.id];
                                    return next;
                                  });
                                }
                              } finally {
                                setCollectingId(null);
                              }
                            }}
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#49243E] bg-white px-3.5 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#49243E] hover:text-[#FFF9F5] disabled:opacity-60"
                          >
                            {collectingId === order.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            <span>Mark Payment Collected</span>
                          </button>
                        )}
                        {updatingId === order.id && (
                          <Loader2 className="h-4 w-4 animate-spin text-[#B76E79]" aria-hidden="true" />
                        )}
                        <input
                          type="text"
                          value={statusNotes[order.id] || ''}
                          onChange={(e) =>
                            setStatusNotes((prev) => ({ ...prev, [order.id]: e.target.value }))
                          }
                          placeholder="Optional customer note"
                          className="h-11 w-44 rounded-xl border border-[#49243E]/18 bg-white px-3 text-xs text-[#242124] focus:border-[#49243E] focus:outline-none"
                        />
                        <select
                          aria-label={`Fulfillment status for ${order.orderNumber}`}
                          disabled={updatingId === order.id}
                          value={fulfillment}
                          onChange={async (e) => {
                            const nextStatus = e.target.value;
                            setUpdatingId(order.id);
                            setOrderErrors((prev) => {
                              if (!prev[order.id]) return prev;
                              const next = { ...prev };
                              delete next[order.id];
                              return next;
                            });
                            try {
                              const result = await onUpdateOrderStatus(
                                order.id,
                                nextStatus,
                                statusNotes[order.id]?.trim() || undefined
                              );
                              if (!result.ok) {
                                setOrderErrors((prev) => ({
                                  ...prev,
                                  [order.id]:
                                    result.error ||
                                    'Could not update order status. Please try again.',
                                }));
                              } else {
                                setStatusNotes((prev) => {
                                  const next = { ...prev };
                                  delete next[order.id];
                                  return next;
                                });
                              }
                            } finally {
                              setUpdatingId(null);
                            }
                          }}
                          className="h-11 rounded-xl border border-[#49243E]/20 bg-white px-3 text-xs font-medium capitalize text-[#49243E] focus:border-[#49243E] focus:outline-none disabled:opacity-60"
                        >
                          {ORDER_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s.replace(/_/g, ' ')}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {orderErrors[order.id] && (
                    <p role="alert" className="text-xs font-medium text-[#9F1239]">
                      {orderErrors[order.id]}
                    </p>
                  )}

                  <ul className="divide-y divide-[#49243E]/8">
                    {order.items.map((item) => (
                      <li key={item.id} className="flex items-center justify-between py-2 text-xs">
                        <div>
                          <span className="font-semibold text-[#49243E]">{item.productTitle}</span>
                          <span className="text-[#242124]/65">
                            {' '}
                            · {item.variantLabel} · SKU {item.sku} &times; {item.quantity}
                          </span>
                        </div>
                        <span className="font-semibold tabular-nums text-[#242124]">
                          {formatPaiseINR(item.lineTotalPaise)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {((order.discountPaise || 0) > 0 || (order.giftCardPaise || 0) > 0) && (
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-[#166534]">
                      {(order.discountPaise || 0) > 0 && (
                        <span>
                          Coupon {order.couponCode || ''}: -{formatPaiseINR(order.discountPaise || 0)}
                        </span>
                      )}
                      {(order.giftCardPaise || 0) > 0 && (
                        <span>
                          Gift Card {order.giftCardCode || ''}: -{formatPaiseINR(order.giftCardPaise || 0)}
                        </span>
                      )}
                    </div>
                  )}

                  {Array.isArray(order.statusHistory) && order.statusHistory.length > 0 && (
                    <div className="rounded-xl border border-[#49243E]/10 bg-white p-3 text-xs">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#49243E]/70">
                        Status History
                      </p>
                      <ul className="mt-1.5 space-y-1">
                        {order.statusHistory.map((h, idx) => (
                          <li key={idx} className="flex flex-wrap justify-between gap-2 text-[#242124]/80">
                            <span>
                              <strong className="capitalize text-[#49243E]">
                                {h.status.replace(/_/g, ' ')}
                              </strong>{' '}
                              ({h.actor}){h.note ? ` — ${h.note}` : ''}
                            </span>
                            <span className="tabular-nums text-[#242124]/55">
                              {formatTimestamp(h.at)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {[order.cancelRequest, order.returnRequest]
                    .filter((req): req is NonNullable<typeof req> => Boolean(req))
                    .map((req) => {
                      const noteKey = `${order.id}:${req.type}`;
                      const isBusy = resolvingKey === noteKey;
                      const heading =
                        req.status === 'pending'
                          ? `${req.type === 'cancel' ? 'Cancellation' : 'Return'} requested · Pending`
                          : `Customer ${req.type === 'cancel' ? 'Cancellation' : 'Return'} Request · ${req.status.toUpperCase()}`;

                      return (
                        <div
                          key={req.id || noteKey}
                          className="space-y-2.5 rounded-xl border border-[#B76E79]/40 bg-white p-3.5 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-semibold text-[#49243E]">{heading}</p>
                            <span className="tabular-nums text-[#242124]/60">
                              {formatTimestamp(req.updatedAt || req.requestedAt)}
                            </span>
                          </div>
                          <p className="text-[#242124]/80">Reason: {req.reason}</p>
                          {req.resolutionNote && (
                            <p className="text-[#49243E]">Owner Note: {req.resolutionNote}</p>
                          )}
                          {req.status === 'pending' && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <input
                                type="text"
                                value={resolutionNotes[noteKey] || ''}
                                onChange={(e) =>
                                  setResolutionNotes((prev) => ({
                                    ...prev,
                                    [noteKey]: e.target.value,
                                  }))
                                }
                                placeholder="Resolution note for customer"
                                className="min-h-[38px] flex-1 rounded-lg border border-[#49243E]/18 bg-[#FFF9F5]/65 px-3 text-xs"
                              />
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={async () => {
                                  setResolvingKey(noteKey);
                                  const res = await onResolveReturnRequest(
                                    order.id,
                                    'approved',
                                    resolutionNotes[noteKey]?.trim() || undefined,
                                    req.type
                                  );
                                  setResolvingKey(null);
                                  if (!res.ok) {
                                    setOrderErrors((prev) => ({
                                      ...prev,
                                      [order.id]: res.error || 'Could not approve request.',
                                    }));
                                  }
                                }}
                                className="inline-flex min-h-[38px] items-center rounded-lg bg-[#49243E] px-3.5 text-xs font-medium text-[#FFF9F5] hover:bg-[#3A1B31] disabled:opacity-60"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={async () => {
                                  setResolvingKey(noteKey);
                                  const res = await onResolveReturnRequest(
                                    order.id,
                                    'rejected',
                                    resolutionNotes[noteKey]?.trim() || undefined,
                                    req.type
                                  );
                                  setResolvingKey(null);
                                  if (!res.ok) {
                                    setOrderErrors((prev) => ({
                                      ...prev,
                                      [order.id]: res.error || 'Could not reject request.',
                                    }));
                                  }
                                }}
                                className="inline-flex min-h-[38px] items-center rounded-lg border border-[#B76E79]/40 bg-[#FFF9F5] px-3.5 text-xs font-medium text-[#9B2C3E] hover:bg-[#F3D5DF]/40 disabled:opacity-60"
                              >
                                Reject
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-[#49243E]/10 pt-4">
            <span className="text-xs tabular-nums text-[#242124]/65">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
                className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] disabled:opacity-45"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                <span>Previous</span>
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => onPageChange(page + 1)}
                className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] disabled:opacity-45"
              >
                <span>Next</span>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

interface AdminAuditPanelProps {
  logs: AdminAuditEntry[];
  loading: boolean;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function AdminAuditPanel({
  logs,
  loading,
  page,
  totalPages,
  onPageChange,
}: AdminAuditPanelProps) {
  if (loading) {
    return (
      <div className="space-y-3 rounded-3xl border border-[#49243E]/12 bg-white p-6">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="h-14 animate-pulse rounded-xl bg-[#FFF9F5]" />
        ))}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <section className="flex flex-col items-center justify-center rounded-3xl border border-[#49243E]/12 bg-white px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
          <ClipboardList className="h-5 w-5" aria-hidden="true" />
        </div>
        <h3 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
          No audit events logged yet
        </h3>
        <p className="mt-1.5 max-w-md text-sm text-[#242124]/70">
          Every product creation, price revision, stock update, publish transition, and archival will be recorded here automatically.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Immutable product audit trail"
      className="space-y-4 rounded-3xl border border-[#49243E]/12 bg-white p-5 sm:p-6"
    >
      <ul className="divide-y divide-[#49243E]/10">
        {logs.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="font-serif text-base font-semibold text-[#49243E]">
                <span className="font-sans text-[11px] font-semibold uppercase tracking-wider text-[#B76E79]">
                  {entry.action}
                </span>
                {' · '}
                <span>{entry.productTitle}</span>
              </p>
              <p className="mt-1 text-xs text-[#242124]/75">{entry.summary}</p>
            </div>
            <div className="shrink-0 text-xs tabular-nums text-[#242124]/55 sm:text-right">
              <div>{formatTimestamp(entry.createdAt)}</div>
              <div className="font-mono text-[10px]">
                Actor: {entry.actorUserId ? `${entry.actorUserId.slice(0, 8)}...` : 'Owner'}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t border-[#49243E]/10 pt-4">
        <span className="text-xs tabular-nums text-[#242124]/65">
          Page {page} of {totalPages}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] disabled:opacity-45"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span>Previous</span>
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="inline-flex min-h-[38px] items-center gap-1 rounded-xl border border-[#49243E]/18 px-3 text-xs font-medium text-[#49243E] disabled:opacity-45"
          >
            <span>Next</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}

interface AdminSecurityPanelProps {
  ownerBinding: { boundAt: number; boundVia: string } | null;
  onSignedOut: () => void;
}

export function AdminSecurityPanel({ ownerBinding, onSignedOut }: AdminSecurityPanelProps) {
  const { user, reauthenticateWithPassword, changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const handleReauth = async (e: FormEvent) => {
    e.preventDefault();
    if (reauthBusy) return;
    setFeedback(null);
    if (!currentPassword) {
      setFeedback({ kind: 'err', text: 'Please enter your current owner password.' });
      return;
    }
    setReauthBusy(true);
    try {
      const res = await reauthenticateWithPassword(currentPassword);
      if (res.ok) {
        setCurrentPassword('');
        setFeedback({
          kind: 'ok',
          text: 'Owner password verified. Sensitive actions unlocked for 10 minutes.',
        });
      } else {
        setFeedback({ kind: 'err', text: res.error });
      }
    } finally {
      setReauthBusy(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (pwdBusy) return;
    setFeedback(null);
    if (newPassword.length < 8) {
      setFeedback({ kind: 'err', text: 'New password must be at least 8 characters long.' });
      return;
    }
    setPwdBusy(true);
    try {
      const res = await changePassword(newPassword);
      if (res.ok) {
        setNewPassword('');
        setFeedback({
          kind: 'ok',
          text: 'Owner password updated and other sessions revoked.',
        });
      } else {
        setFeedback({ kind: 'err', text: res.error });
      }
    } finally {
      setPwdBusy(false);
    }
  };

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-serif text-2xl font-semibold text-[#49243E]">
              Immutable Owner Binding
            </h3>
            <p className="mt-1 text-xs text-[#242124]/65">
              Server-enforced owner identity. Public signup cannot grant admin privileges.
            </p>
          </div>
        </div>

        <dl className="mt-5 space-y-3 rounded-2xl border border-[#49243E]/10 bg-[#FFF9F5]/65 p-4 text-xs">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[#242124]/65">Verified Email</dt>
            <dd className="font-medium text-[#49243E]">{user?.email}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[#242124]/65">Immutable User ID</dt>
            <dd className="font-mono text-[#49243E]">{user?.id}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[#242124]/65">Authorization Source</dt>
            <dd className="font-mono text-[#49243E]">{ownerBinding?.boundVia || 'server_binding'}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[#242124]/65">Bound At</dt>
            <dd className="tabular-nums text-[#49243E]">
              {ownerBinding?.boundAt ? formatTimestamp(ownerBinding.boundAt) : 'Active'}
            </dd>
          </div>
        </dl>

        <button
          type="button"
          disabled={logoutBusy}
          onClick={async () => {
            if (logoutBusy) return;
            setSignOutError(null);
            setLogoutBusy(true);
            try {
              const res = await logout();
              if (!res.ok) {
                setSignOutError(res.error);
                return;
              }
              onSignedOut();
            } finally {
              setLogoutBusy(false);
            }
          }}
          className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#B76E79]/35 px-4 text-sm font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/35 disabled:opacity-60"
        >
          {logoutBusy ? (
            <Loader2 className="h-4 w-4 animate-spin text-[#B76E79]" aria-hidden="true" />
          ) : (
            <LogOut className="h-4 w-4 text-[#B76E79]" aria-hidden="true" />
          )}
          <span>{logoutBusy ? 'Signing Out...' : 'Sign Out of Admin Portal'}</span>
        </button>

        {signOutError && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-xl border border-[#B76E79]/50 bg-[#F3D5DF]/35 p-3 text-xs text-[#49243E]"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
            <span>{signOutError}</span>
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-[#49243E]/12 bg-white p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-serif text-2xl font-semibold text-[#49243E]">
              Password &amp; Reauthentication
            </h3>
            <p className="mt-1 text-xs text-[#242124]/65">
              Recent password verification is required before rotating your owner credentials.
            </p>
          </div>
        </div>

        {feedback && (
          <div
            role={feedback.kind === 'err' ? 'alert' : 'status'}
            className={`mt-4 flex items-center gap-2 rounded-xl border p-3 text-xs ${
              feedback.kind === 'ok'
                ? 'border-[#166534]/25 bg-[#F0FDF4] text-[#166534]'
                : 'border-[#B76E79]/50 bg-[#F3D5DF]/35 text-[#49243E]'
            }`}
          >
            {feedback.kind === 'ok' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}

        {!user?.recentReauthValid ? (
          <form onSubmit={handleReauth} className="mt-5 space-y-3">
            <div>
              <label className="block text-xs font-medium text-[#49243E]">
                Confirm Current Password to Unlock Password Update
              </label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current owner password"
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={reauthBusy}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
            >
              {reauthBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <span>Verify Owner Password</span>
            </button>
          </form>
        ) : (
          <form onSubmit={handleChangePassword} className="mt-5 space-y-3">
            <div>
              <label className="block text-xs font-medium text-[#49243E]">
                New Password (minimum 8 characters)
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new strong password"
                className="mt-1 h-11 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3.5 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={pwdBusy}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
            >
              {pwdBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <span>Update Owner Password</span>
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
