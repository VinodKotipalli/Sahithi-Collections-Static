import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  CreditCard,
  Loader2,
  MapPin,
  Minus,
  Plus,
  RefreshCw,
  ShoppingBag,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { getValidClientIdToken } from '../services/firebaseClientApi';
import {
  checkRazorpayOrderStatus,
  createRazorpayOrder,
  ensureRazorpayCheckoutScript,
  verifyRazorpayPayment,
} from '../services/razorpayCheckout';
import type {
  BagItem,
  BagValidationResult,
  CustomerAddress,
  PlacedOrderReceipt,
} from '../types/boutique';
import { formatPaiseINR, formatTimestamp } from '../utils/format';
import { BoutiqueImage } from './BoutiqueImage';

interface BagDrawerProps {
  isOpen: boolean;
  items: BagItem[];
  onClose: () => void;
  onUpdateQty: (productId: string, variantId: string, quantity: number) => void;
  onRemoveItem: (productId: string, variantId: string) => void;
  onAcceptPriceUpdates: (
    updates: Array<{ productId: string; variantId: string | null; currentPricePaise: number }>
  ) => void;
  onClearBag: () => void;
  onOrderCompleted: () => void;
}

interface PendingConfirmationState {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  message: string;
  checking: boolean;
}

function formatSavedAddressText(addr: CustomerAddress): string {
  const parts = [
    addr.line1,
    addr.line2 || '',
    `${addr.city}, ${addr.state} ${addr.pincode}`,
    addr.landmark ? `Landmark: ${addr.landmark}` : '',
  ]
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.join(', ');
}

export function BagDrawer({
  isOpen,
  items,
  onClose,
  onUpdateQty,
  onRemoveItem,
  onAcceptPriceUpdates,
  onClearBag,
  onOrderCompleted,
}: BagDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const checkoutInFlightRef = useRef(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const { user, apiRequest } = useAuth();

  const nameId = useId();
  const emailId = useId();
  const phoneId = useId();
  const addressId = useId();
  const couponId = useId();
  const giftCardId = useId();

  const [validation, setValidation] = useState<BagValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'razorpay' | 'cod'>('razorpay');
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [paymentErrorText, setPaymentErrorText] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PlacedOrderReceipt | null>(null);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmationState | null>(null);

  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [shippingAddress, setShippingAddress] = useState('');

  // Saved addresses for signed-in shoppers
  const [savedAddresses, setSavedAddresses] = useState<CustomerAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string>('');

  // Coupon & gift card state
  const [couponInput, setCouponInput] = useState('');
  const [giftCardInput, setGiftCardInput] = useState('');
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(null);
  const [appliedGiftCardCode, setAppliedGiftCardCode] = useState<string | null>(null);
  const [discountPaise, setDiscountPaise] = useState(0);
  const [giftCardPaise, setGiftCardPaise] = useState(0);
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoFeedback, setPromoFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null
  );

  const codAttemptRef = useRef<{ signature: string; key: string } | null>(null);

  useFocusTrap(isOpen, drawerRef, onClose);

  useEffect(() => {
    if (user) {
      setCustomerName((prev) => prev || user.fullName || '');
      setCustomerEmail((prev) => prev || user.email || '');
    } else {
      setSavedAddresses([]);
      setSelectedAddressId('');
    }
  }, [user]);

  useEffect(() => {
    if (!isOpen || !user) return;
    let cancelled = false;
    void apiRequest<{ items?: CustomerAddress[] }>('/api/account/addresses').then((res) => {
      if (cancelled || !res.ok || !Array.isArray(res.data.items)) return;
      const list = res.data.items;
      setSavedAddresses(list);
      if (list.length > 0) {
        const defaultAddr = list.find((a) => a.isDefault) || list[0];
        setSelectedAddressId((prev) => prev || defaultAddr.id);
        setCustomerName((prev) => prev || defaultAddr.fullName || user.fullName || '');
        setCustomerPhone((prev) => prev || defaultAddr.phone || '');
        setShippingAddress((prev) => prev || formatSavedAddressText(defaultAddr));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, user, apiRequest]);

  const revalidateBag = async () => {
    if (items.length === 0) {
      setValidation({ items: [], subtotalPaise: 0, hasUnavailable: false, hasPriceChanges: false });
      return;
    }
    setValidating(true);
    setErrorText(null);
    const res = await apiRequest<BagValidationResult>('/api/cart/validate', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
    setValidating(false);
    if (res.ok) {
      setValidation(res.data);
    } else {
      setErrorText(res.error);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setReceipt(null);
    void revalidateBag();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, items.length]);

  const displaySubtotalPaise =
    validation?.subtotalPaise ??
    items.reduce((sum, it) => sum + it.seenPricePaise * it.quantity, 0);

  const effectiveDiscountPaise = appliedCouponCode
    ? Math.min(displaySubtotalPaise, discountPaise)
    : 0;
  const effectiveGiftCardPaise = appliedGiftCardCode
    ? Math.min(Math.max(0, displaySubtotalPaise - effectiveDiscountPaise), giftCardPaise)
    : 0;
  const netPayablePaise = Math.max(
    0,
    displaySubtotalPaise - effectiveDiscountPaise - effectiveGiftCardPaise
  );

  // Re-validate applied promos when bag subtotal changes
  useEffect(() => {
    if (!isOpen || (!appliedCouponCode && !appliedGiftCardCode) || displaySubtotalPaise <= 0) {
      return;
    }
    let cancelled = false;
    void apiRequest<{
      valid: boolean;
      discountPaise: number;
      giftCardPaise: number;
    }>('/api/coupons/validate', {
      method: 'POST',
      body: JSON.stringify({
        subtotalPaise: displaySubtotalPaise,
        couponCode: appliedCouponCode || undefined,
        giftCardCode: appliedGiftCardCode || undefined,
      }),
    }).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setDiscountPaise(res.data.discountPaise || 0);
        setGiftCardPaise(res.data.giftCardPaise || 0);
      } else {
        setAppliedCouponCode(null);
        setAppliedGiftCardCode(null);
        setDiscountPaise(0);
        setGiftCardPaise(0);
        setPromoFeedback({ kind: 'err', text: res.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, displaySubtotalPaise, appliedCouponCode, appliedGiftCardCode, apiRequest]);

  const handleApplyPromo = async (nextCoupon?: string | null, nextGiftCard?: string | null) => {
    const codeCoupon = (nextCoupon !== undefined ? (nextCoupon ?? '') : couponInput).trim().toUpperCase();
    const codeGiftCard = (nextGiftCard !== undefined ? (nextGiftCard ?? '') : giftCardInput)
      .trim()
      .toUpperCase();

    if (!codeCoupon && !codeGiftCard) {
      setAppliedCouponCode(null);
      setAppliedGiftCardCode(null);
      setDiscountPaise(0);
      setGiftCardPaise(0);
      setPromoFeedback(null);
      return;
    }

    setPromoBusy(true);
    setPromoFeedback(null);
    const res = await apiRequest<{
      valid: boolean;
      discountPaise: number;
      giftCardPaise: number;
      payablePaise: number;
    }>('/api/coupons/validate', {
      method: 'POST',
      body: JSON.stringify({
        subtotalPaise: displaySubtotalPaise,
        couponCode: codeCoupon || undefined,
        giftCardCode: codeGiftCard || undefined,
      }),
    });
    setPromoBusy(false);

    if (!res.ok) {
      setPromoFeedback({ kind: 'err', text: res.error });
      return;
    }

    setAppliedCouponCode(codeCoupon || null);
    setAppliedGiftCardCode(codeGiftCard || null);
    setDiscountPaise(res.data.discountPaise || 0);
    setGiftCardPaise(res.data.giftCardPaise || 0);
    setPromoFeedback({
      kind: 'ok',
      text: `Savings applied (${formatPaiseINR(
        (res.data.discountPaise || 0) + (res.data.giftCardPaise || 0)
      )} off).`,
    });
  };

  const handleConfirmPriceChanges = () => {
    if (!validation) return;
    const updates = validation.items
      .filter((i) => i.priceChanged && i.currentPricePaise !== null)
      .map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        currentPricePaise: i.currentPricePaise!,
      }));
    onAcceptPriceUpdates(updates);
    setValidation((prev) =>
      prev
        ? {
            ...prev,
            hasPriceChanges: false,
            items: prev.items.map((i) => ({
              ...i,
              priceChanged: false,
              previousPricePaise: i.currentPricePaise,
            })),
          }
        : null
    );
  };

  const handleSelectSavedAddress = (addrId: string) => {
    setSelectedAddressId(addrId);
    const picked = savedAddresses.find((a) => a.id === addrId);
    if (!picked) return;
    setCustomerName(picked.fullName || user?.fullName || '');
    setCustomerPhone(picked.phone || '');
    setShippingAddress(formatSavedAddressText(picked));
  };

  const handleCheckPendingOrderStatus = async () => {
    if (!pendingConfirmation || pendingConfirmation.checking) return;
    setPendingConfirmation((prev) => (prev ? { ...prev, checking: true } : prev));
    setPaymentErrorText(null);
    const statusRes = await checkRazorpayOrderStatus({
      razorpayOrderId: pendingConfirmation.razorpayOrderId,
      razorpayPaymentId: pendingConfirmation.razorpayPaymentId,
    });
    if (!statusRes.ok) {
      setPendingConfirmation((prev) => (prev ? { ...prev, checking: false } : prev));
      setPaymentErrorText(statusRes.error);
      return;
    }
    if (statusRes.confirmed && statusRes.order?.orderNumber) {
      setPendingConfirmation(null);
      setReceipt(statusRes.order);
      setCheckoutOpen(false);
      onClearBag();
      onOrderCompleted();
      return;
    }
    setPendingConfirmation((prev) =>
      prev
        ? {
            ...prev,
            checking: false,
            message:
              statusRes.message ||
              'Payment received. We’re still confirming your order—please check again in a few seconds.',
          }
        : null
    );
  };

  const handlePlaceOrder = async (e: FormEvent) => {
    e.preventDefault();
    if (checkoutInFlightRef.current || submitting || pendingConfirmation) return;
    setErrorText(null);
    setPaymentErrorText(null);

    if (items.length === 0) {
      setPaymentErrorText('Your shopping bag is empty.');
      return;
    }

    if (paymentMethod === 'razorpay' && netPayablePaise < 100) {
      setPaymentErrorText(
        'Net payable amount after promo discounts must be at least ₹1.00 (100 paise) for Razorpay Checkout.'
      );
      return;
    }

    const customerDetails = {
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim(),
      customerPhone: customerPhone.trim(),
      shippingAddress: shippingAddress.trim(),
    };

    if (
      customerDetails.customerName.length < 2 ||
      !customerDetails.customerEmail ||
      customerDetails.customerPhone.length < 7 ||
      customerDetails.shippingAddress.length < 8
    ) {
      setPaymentErrorText('Please complete your name, email, phone number, and delivery address.');
      return;
    }

    checkoutInFlightRef.current = true;
    setSubmitting(true);

    try {
      const payloadItems = items.map((item) => {
        const checked = validation?.items.find(
          (v) => v.productId === item.productId && v.variantId === item.variantId
        );
        return {
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          expectedPricePaise: checked?.currentPricePaise ?? item.seenPricePaise,
        };
      });

      if (paymentMethod === 'cod') {
        const payloadSignature = JSON.stringify({
          items: payloadItems,
          customerDetails,
          appliedCouponCode,
          appliedGiftCardCode,
        });
        if (!codAttemptRef.current || codAttemptRef.current.signature !== payloadSignature) {
          const freshId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
          codAttemptRef.current = {
            signature: payloadSignature,
            key: `cod_${freshId}`,
          };
        }

        const idToken = await getValidClientIdToken().catch(() => null);
        const codRes = await apiRequest<{ order?: PlacedOrderReceipt; duplicate?: boolean }>(
          '/api/orders',
          {
            method: 'POST',
            headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
            body: JSON.stringify({
              ...customerDetails,
              customer: customerDetails,
              paymentMethod: 'cod',
              couponCode: appliedCouponCode || undefined,
              giftCardCode: appliedGiftCardCode || undefined,
              idempotencyKey: codAttemptRef.current.key,
              items: payloadItems,
            }),
          }
        );

        checkoutInFlightRef.current = false;
        setSubmitting(false);

        if (!codRes.ok || !codRes.data?.order?.orderNumber) {
          setPaymentErrorText(
            !codRes.ok
              ? codRes.error
              : 'Could not confirm your Cash on Delivery order. Please try again.'
          );
          if (!codRes.ok && codRes.status === 409) {
            void revalidateBag();
          }
          return;
        }

        codAttemptRef.current = null;
        setReceipt(codRes.data.order);
        setCheckoutOpen(false);
        onClearBag();
        onOrderCompleted();
        return;
      }

      const [scriptLoaded, orderRes] = await Promise.all([
        ensureRazorpayCheckoutScript(10_000),
        createRazorpayOrder({
          items: payloadItems,
          customer: customerDetails,
          couponCode: appliedCouponCode || undefined,
          giftCardCode: appliedGiftCardCode || undefined,
          currency: 'INR',
          receipt: `sc_rcpt_${Date.now()}`,
        }),
      ]);

      if (!orderRes.ok) {
        setPaymentErrorText(orderRes.error);
        checkoutInFlightRef.current = false;
        setSubmitting(false);
        if (orderRes.status === 409) {
          void revalidateBag();
        }
        return;
      }

      if (!scriptLoaded || typeof window.Razorpay !== 'function') {
        setPaymentErrorText(
          'Razorpay Checkout could not load in time. Please check your connection and try again.'
        );
        checkoutInFlightRef.current = false;
        setSubmitting(false);
        return;
      }

      const { order_id, amount, currency, key_id, checkout_token } = orderRes.data;

      let settled = false;
      const rzp = new window.Razorpay({
        key: key_id,
        amount,
        currency,
        name: 'Sahithi Collections',
        description: 'Boutique Order Checkout',
        order_id,
        prefill: {
          name: customerDetails.customerName,
          email: customerDetails.customerEmail,
          contact: customerDetails.customerPhone,
        },
        theme: {
          color: '#49243E',
        },
        modal: {
          ondismiss: () => {
            if (settled) return;
            settled = true;
            checkoutInFlightRef.current = false;
            setSubmitting(false);
            setPaymentErrorText('Payment was cancelled. Your bag items are still saved.');
          },
        },
        handler: async (paymentResponse) => {
          settled = true;
          setSubmitting(true);
          setPaymentErrorText(null);
          const verifyRes = await verifyRazorpayPayment({
            razorpay_order_id: paymentResponse.razorpay_order_id,
            razorpay_payment_id: paymentResponse.razorpay_payment_id,
            razorpay_signature: paymentResponse.razorpay_signature,
            checkout_token,
            couponCode: appliedCouponCode || undefined,
            giftCardCode: appliedGiftCardCode || undefined,
            orderData: {
              ...customerDetails,
              couponCode: appliedCouponCode || undefined,
              giftCardCode: appliedGiftCardCode || undefined,
              items: payloadItems,
            },
          });

          checkoutInFlightRef.current = false;
          setSubmitting(false);

          if (!verifyRes.ok) {
            setPaymentErrorText(verifyRes.error);
            void revalidateBag();
            return;
          }

          if (verifyRes.data.pending_confirmation) {
            setPendingConfirmation({
              razorpayOrderId: verifyRes.data.order_id,
              razorpayPaymentId: verifyRes.data.payment_id,
              message:
                verifyRes.data.message ||
                'Payment received. We’re confirming your order and will update your confirmation shortly.',
              checking: false,
            });
            return;
          }

          if (!verifyRes.data.order || !verifyRes.data.order.orderNumber) {
            setPendingConfirmation({
              razorpayOrderId: verifyRes.data.order_id,
              razorpayPaymentId: verifyRes.data.payment_id,
              message:
                'Payment received. We’re confirming your order in our system. Tap Check Order Status below before retrying payment.',
              checking: false,
            });
            return;
          }

          setReceipt(verifyRes.data.order);
          setCheckoutOpen(false);
          onClearBag();
          onOrderCompleted();
        },
      });

      rzp.on('payment.failed', (failure) => {
        if (settled) return;
        settled = true;
        checkoutInFlightRef.current = false;
        setSubmitting(false);
        const failureMsg =
          failure?.error?.description ||
          failure?.error?.reason ||
          'Payment failed. Please try again with another payment method.';
        setPaymentErrorText(failureMsg);
      });

      rzp.open();
    } catch (err) {
      checkoutInFlightRef.current = false;
      setSubmitting(false);
      setPaymentErrorText(
        err instanceof Error ? err.message : 'Something went wrong while starting payment.'
      );
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex justify-end bg-[#242124]/45"
        >
          <motion.div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bag-drawer-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={prefersReducedMotion ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={prefersReducedMotion ? undefined : { x: '100%' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="flex h-full w-full max-w-md flex-col bg-[#FFF9F5] shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#49243E]/10 px-5 py-4">
              <div>
                <h2
                  id="bag-drawer-title"
                  className="font-serif text-2xl font-semibold text-[#49243E]"
                >
                  Boutique Bag
                </h2>
                <p className="text-xs text-[#242124]/65 tabular-nums">
                  {receipt
                    ? `Order ${receipt.orderNumber}`
                    : pendingConfirmation
                      ? `Confirming ${pendingConfirmation.razorpayOrderId}`
                      : `${items.reduce((s, i) => s + i.quantity, 0)} item(s) · Live INR pricing`}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close shopping bag"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[#49243E]/15 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {receipt ? (
                <div className="space-y-5 rounded-2xl border border-[#49243E]/12 bg-white p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F3D5DF]/50 text-[#49243E]">
                      <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-xs font-medium tracking-wider uppercase text-[#B76E79]">
                        {receipt.paymentMethod === 'cod'
                          ? 'Order Placed · Cash on Delivery'
                          : 'Payment & Order Confirmed'}
                      </p>
                      <h3 className="font-serif text-2xl font-semibold text-[#49243E]">
                        {receipt.orderNumber}
                      </h3>
                      <p className="mt-1 text-xs text-[#242124]/70 tabular-nums">
                        {receipt.paymentMethod === 'cod'
                          ? `Placed ${formatTimestamp(receipt.createdAt)} · ${
                              receipt.paymentStatus === 'paid'
                                ? 'Payment collected'
                                : 'Payment due on delivery'
                            }`
                          : `Placed ${formatTimestamp(receipt.createdAt)} · Paid via Razorpay${
                              receipt.razorpayPaymentId ? ` · Ref ${receipt.razorpayPaymentId}` : ''
                            }`}
                      </p>
                    </div>
                  </div>

                  <ul className="divide-y divide-[#49243E]/10 border-y border-[#49243E]/10 py-2">
                    {receipt.items.map((line, idx) => (
                      <li
                        key={`${line.sku}-${idx}`}
                        className="flex items-center justify-between py-2.5 text-sm"
                      >
                        <div className="min-w-0 pr-3">
                          <p className="truncate font-medium text-[#49243E]">
                            {line.productTitle}
                          </p>
                          <p className="text-xs text-[#242124]/65">
                            {line.variantLabel} &times; {line.quantity}
                          </p>
                        </div>
                        <span className="shrink-0 font-semibold tabular-nums text-[#242124]">
                          {formatPaiseINR(line.lineTotalPaise)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <div className="space-y-1.5 text-sm">
                    <div className="flex items-center justify-between text-xs text-[#242124]/70">
                      <span>Subtotal</span>
                      <span className="tabular-nums">{formatPaiseINR(receipt.subtotalPaise)}</span>
                    </div>
                    {(receipt.discountPaise || 0) > 0 && (
                      <div className="flex items-center justify-between text-xs text-[#166534]">
                        <span>Coupon {receipt.couponCode ? `(${receipt.couponCode})` : ''}</span>
                        <span className="tabular-nums">
                          -{formatPaiseINR(receipt.discountPaise || 0)}
                        </span>
                      </div>
                    )}
                    {(receipt.giftCardPaise || 0) > 0 && (
                      <div className="flex items-center justify-between text-xs text-[#166534]">
                        <span>
                          Gift Card {receipt.giftCardCode ? `(${receipt.giftCardCode})` : ''}
                        </span>
                        <span className="tabular-nums">
                          -{formatPaiseINR(receipt.giftCardPaise || 0)}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between border-t border-[#49243E]/10 pt-2 text-base font-semibold text-[#49243E]">
                      <span>
                        {receipt.paymentMethod === 'cod' && receipt.paymentStatus !== 'paid'
                          ? 'Amount Due on Delivery'
                          : 'Order Total'}
                      </span>
                      <span className="tabular-nums">{formatPaiseINR(receipt.totalPaise)}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={onClose}
                    className="min-h-[44px] w-full rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                  >
                    Continue Browsing
                  </button>
                </div>
              ) : pendingConfirmation ? (
                <div className="space-y-4 rounded-2xl border border-[#B76E79]/45 bg-white p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F3D5DF]/45 text-[#49243E]">
                      <RefreshCw
                        className={`h-5 w-5 ${pendingConfirmation.checking ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-[#B76E79]">
                        Confirmation In Progress
                      </p>
                      <h3 className="mt-0.5 font-serif text-xl font-semibold text-[#49243E]">
                        Payment received. We&rsquo;re confirming your order
                      </h3>
                    </div>
                  </div>

                  <p className="text-xs leading-relaxed text-[#242124]/75">
                    {pendingConfirmation.message} Do not pay again for this bag while your confirmation finishes syncing.
                  </p>

                  <dl className="space-y-1.5 rounded-xl border border-[#49243E]/12 bg-[#FFF9F5] p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[#242124]/65">Razorpay Order Ref</dt>
                      <dd className="font-mono font-semibold text-[#49243E]">
                        {pendingConfirmation.razorpayOrderId}
                      </dd>
                    </div>
                    {pendingConfirmation.razorpayPaymentId && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[#242124]/65">Payment Ref</dt>
                        <dd className="font-mono font-semibold text-[#49243E]">
                          {pendingConfirmation.razorpayPaymentId}
                        </dd>
                      </div>
                    )}
                  </dl>

                  {paymentErrorText && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 rounded-xl border border-[#B76E79]/55 bg-[#F3D5DF]/40 p-3 text-xs text-[#49243E]"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                      <span>{paymentErrorText}</span>
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={pendingConfirmation.checking}
                    onClick={() => void handleCheckPendingOrderStatus()}
                    className="inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
                  >
                    {pendingConfirmation.checking ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    )}
                    <span>
                      {pendingConfirmation.checking ? 'Checking Status…' : 'Check Order Status'}
                    </span>
                  </button>
                </div>
              ) : items.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#F3D5DF]/45 text-[#49243E]">
                    <ShoppingBag className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 font-serif text-2xl font-semibold text-[#49243E]">
                    Your shopping bag is empty
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#242124]/70">
                    Select any piece in the showcase to choose your size and shade, then add it to your bag.
                  </p>
                  <a
                    href="#new-arrivals"
                    onClick={onClose}
                    className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#49243E] px-6 py-2.5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31]"
                  >
                    Browse Collections
                  </a>
                </div>
              ) : (
                <div className="space-y-4">
                  {errorText && (
                    <div
                      role="alert"
                      className="flex items-start gap-2.5 rounded-xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-3.5 text-xs text-[#49243E]"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                      <span>{errorText}</span>
                    </div>
                  )}

                  {validation?.hasPriceChanges && (
                    <div
                      role="status"
                      className="rounded-xl border border-[#B76E79]/40 bg-white p-3.5 text-xs text-[#49243E]"
                    >
                      <p className="font-semibold">Boutique prices updated</p>
                      <p className="mt-1 text-[#242124]/75">
                        One or more items in your bag have updated live pricing. Review the new totals below before placing your order.
                      </p>
                      <button
                        type="button"
                        onClick={handleConfirmPriceChanges}
                        className="mt-2.5 inline-flex min-h-[40px] items-center rounded-lg bg-[#49243E] px-3 text-xs font-medium text-[#FFF9F5]"
                      >
                        Acknowledge Updated Prices
                      </button>
                    </div>
                  )}

                  <ul className="space-y-3">
                    {items.map((item) => {
                      const vItem = validation?.items.find(
                        (v) => v.productId === item.productId && v.variantId === item.variantId
                      );
                      const unitPaise = vItem?.currentPricePaise ?? item.seenPricePaise;
                      const unavailable = vItem ? !vItem.available : false;
                      const maxQty = vItem ? Math.max(1, vItem.availableQty) : 50;

                      return (
                        <li
                          key={`${item.productId}::${item.variantId}`}
                          className={`flex gap-3.5 rounded-2xl border p-3 ${
                            unavailable
                              ? 'border-[#B76E79]/45 bg-[#F3D5DF]/20'
                              : 'border-[#49243E]/10 bg-white'
                          }`}
                        >
                          <div className="h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-[#F8F1ED]">
                            <BoutiqueImage
                              src={vItem?.imageUrl || item.fallbackImage}
                              alt={vItem?.title || item.fallbackTitle}
                              loading="eager"
                              fallbackTitle={item.fallbackTitle}
                              className="h-full w-full object-cover object-top"
                            />
                          </div>

                          <div className="flex min-w-0 flex-1 flex-col justify-between">
                            <div>
                              <h3 className="line-clamp-2 font-serif text-base font-semibold leading-snug text-[#49243E]">
                                {vItem?.title || item.fallbackTitle}
                              </h3>
                              <p className="mt-0.5 text-xs text-[#242124]/65">
                                {vItem?.variantLabel || item.fallbackVariant}
                              </p>

                              {!unavailable && (
                                <div className="mt-1 flex items-baseline gap-2">
                                  <span className="text-sm font-semibold tabular-nums text-[#242124]">
                                    {formatPaiseINR(unitPaise)}
                                  </span>
                                  {vItem?.priceChanged && vItem.previousPricePaise !== null && (
                                    <span className="text-xs line-through tabular-nums text-[#242124]/50">
                                      {formatPaiseINR(vItem.previousPricePaise)}
                                    </span>
                                  )}
                                </div>
                              )}

                              {vItem?.statusReason && (
                                <p className="mt-1 text-xs font-medium text-[#B76E79]">
                                  {vItem.statusReason}
                                </p>
                              )}
                            </div>

                            <div className="mt-2.5 flex items-center justify-between gap-2">
                              {!unavailable ? (
                                <div className="inline-flex items-center rounded-lg border border-[#49243E]/18 bg-[#FFF9F5]">
                                  <button
                                    type="button"
                                    aria-label="Decrease quantity"
                                    onClick={() =>
                                      onUpdateQty(item.productId, item.variantId, item.quantity - 1)
                                    }
                                    className="flex h-10 w-10 items-center justify-center text-[#49243E] hover:bg-[#F3D5DF]/40"
                                  >
                                    <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                                  </button>
                                  <span className="min-w-[28px] text-center text-xs font-semibold tabular-nums text-[#49243E]">
                                    {item.quantity}
                                  </span>
                                  <button
                                    type="button"
                                    aria-label="Increase quantity"
                                    disabled={item.quantity >= maxQty}
                                    onClick={() =>
                                      onUpdateQty(item.productId, item.variantId, item.quantity + 1)
                                    }
                                    className="flex h-10 w-10 items-center justify-center text-[#49243E] hover:bg-[#F3D5DF]/40 disabled:opacity-40"
                                  >
                                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                  </button>
                                </div>
                              ) : (
                                <span className="text-xs font-medium text-[#B76E79]">
                                  Unavailable
                                </span>
                              )}

                              <button
                                type="button"
                                onClick={() => onRemoveItem(item.productId, item.variantId)}
                                aria-label={`Remove ${item.fallbackTitle} from bag`}
                                className="inline-flex min-h-[40px] items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-[#242124]/65 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Remove</span>
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {checkoutOpen && !validation?.hasUnavailable && (
                    <form
                      onSubmit={handlePlaceOrder}
                      className="space-y-3.5 rounded-2xl border border-[#49243E]/12 bg-white p-4"
                    >
                      <h3 className="font-serif text-xl font-semibold text-[#49243E]">
                        Delivery &amp; Order Details
                      </h3>

                      {user && savedAddresses.length > 0 && (
                        <div className="space-y-1.5 rounded-xl border border-[#49243E]/12 bg-[#FFF9F5]/80 p-3">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#49243E]">
                            <MapPin className="h-3.5 w-3.5 text-[#B76E79]" aria-hidden="true" />
                            <span>Saved Delivery Addresses</span>
                          </div>
                          <select
                            aria-label="Choose a saved delivery address"
                            value={selectedAddressId}
                            onChange={(e) => handleSelectSavedAddress(e.target.value)}
                            className="min-h-[42px] w-full rounded-lg border border-[#49243E]/18 bg-white px-3 text-xs font-medium text-[#49243E] focus:border-[#49243E] focus:outline-none"
                          >
                            {savedAddresses.map((addr) => (
                              <option key={addr.id} value={addr.id}>
                                {addr.label} · {addr.fullName} — {addr.line1}, {addr.city} ({addr.pincode})
                                {addr.isDefault ? ' [Default]' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div>
                        <label htmlFor={nameId} className="block text-xs font-medium text-[#49243E]">
                          Full Name
                        </label>
                        <input
                          id={nameId}
                          type="text"
                          required
                          value={customerName}
                          onChange={(e) => setCustomerName(e.target.value)}
                          placeholder="Ananya Reddy"
                          className="mt-1 min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label htmlFor={emailId} className="block text-xs font-medium text-[#49243E]">
                            Email Address
                          </label>
                          <input
                            id={emailId}
                            type="email"
                            required
                            value={customerEmail}
                            onChange={(e) => setCustomerEmail(e.target.value)}
                            placeholder="name@example.com"
                            className="mt-1 min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                          />
                        </div>
                        <div>
                          <label htmlFor={phoneId} className="block text-xs font-medium text-[#49243E]">
                            Contact Phone
                          </label>
                          <input
                            id={phoneId}
                            type="tel"
                            required
                            value={customerPhone}
                            onChange={(e) => setCustomerPhone(e.target.value)}
                            placeholder="+91 98765 43210"
                            className="mt-1 min-h-[44px] w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 px-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor={addressId} className="block text-xs font-medium text-[#49243E]">
                          Delivery Address
                        </label>
                        <textarea
                          id={addressId}
                          required
                          rows={2}
                          value={shippingAddress}
                          onChange={(e) => setShippingAddress(e.target.value)}
                          placeholder="House/Flat, Street, City, State, PIN Code"
                          className="mt-1 w-full rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/60 p-3 text-sm focus:border-[#49243E] focus:bg-white focus:outline-none"
                        />
                      </div>

                      {/* Coupon & Gift Card Section */}
                      <div className="space-y-2.5 rounded-xl border border-[#49243E]/12 bg-[#FFF9F5]/70 p-3">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#49243E]">
                          <Tag className="h-3.5 w-3.5 text-[#B76E79]" aria-hidden="true" />
                          <span>Coupon or Gift Card</span>
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div>
                            <label htmlFor={couponId} className="sr-only">
                              Coupon code
                            </label>
                            <input
                              id={couponId}
                              type="text"
                              value={couponInput}
                              onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                              placeholder="COUPON CODE"
                              className="min-h-[40px] w-full rounded-lg border border-[#49243E]/18 bg-white px-3 font-mono text-xs uppercase text-[#49243E] focus:border-[#49243E] focus:outline-none"
                            />
                          </div>
                          <div>
                            <label htmlFor={giftCardId} className="sr-only">
                              Gift card code
                            </label>
                            <input
                              id={giftCardId}
                              type="text"
                              value={giftCardInput}
                              onChange={(e) => setGiftCardInput(e.target.value.toUpperCase())}
                              placeholder="GIFT CARD CODE"
                              className="min-h-[40px] w-full rounded-lg border border-[#49243E]/18 bg-white px-3 font-mono text-xs uppercase text-[#49243E] focus:border-[#49243E] focus:outline-none"
                            />
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={promoBusy}
                            onClick={() => void handleApplyPromo()}
                            className="inline-flex min-h-[38px] items-center justify-center rounded-lg border border-[#49243E]/25 bg-white px-3 text-xs font-semibold text-[#49243E] hover:bg-[#F3D5DF]/40 disabled:opacity-60"
                          >
                            {promoBusy ? 'Validating…' : 'Apply Codes'}
                          </button>
                          {(appliedCouponCode || appliedGiftCardCode) && (
                            <button
                              type="button"
                              onClick={() => {
                                setCouponInput('');
                                setGiftCardInput('');
                                setAppliedCouponCode(null);
                                setAppliedGiftCardCode(null);
                                setDiscountPaise(0);
                                setGiftCardPaise(0);
                                setPromoFeedback(null);
                              }}
                              className="inline-flex min-h-[38px] items-center px-2 text-xs font-medium text-[#B76E79] hover:text-[#49243E]"
                            >
                              Clear Codes
                            </button>
                          )}
                        </div>

                        {promoFeedback && (
                          <p
                            role={promoFeedback.kind === 'err' ? 'alert' : 'status'}
                            className={`text-xs ${
                              promoFeedback.kind === 'err' ? 'text-[#9B2C3E]' : 'text-[#166534]'
                            }`}
                          >
                            {promoFeedback.text}
                          </p>
                        )}
                      </div>

                      {/* Payment Method Selection */}
                      <fieldset className="space-y-2 rounded-xl border border-[#49243E]/12 bg-[#FFF9F5]/70 p-3">
                        <legend className="px-1 text-xs font-semibold text-[#49243E]">
                          Payment Method
                        </legend>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <label
                            className={`flex min-h-[48px] cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-xs transition-colors ${
                              paymentMethod === 'razorpay'
                                ? 'border-[#49243E] bg-white text-[#49243E]'
                                : 'border-[#49243E]/15 bg-white/60 text-[#242124]/80 hover:border-[#49243E]/35'
                            }`}
                          >
                            <input
                              type="radio"
                              name="checkout-payment-method"
                              value="razorpay"
                              checked={paymentMethod === 'razorpay'}
                              onChange={() => {
                                setPaymentMethod('razorpay');
                                setPaymentErrorText(null);
                              }}
                              className="h-4 w-4 accent-[#49243E]"
                            />
                            <CreditCard className="h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                            <div className="min-w-0">
                              <span className="block font-semibold text-[#49243E]">Pay Online</span>
                              <span className="block text-[11px] text-[#242124]/65">
                                UPI, Cards &amp; NetBanking
                              </span>
                            </div>
                          </label>

                          <label
                            className={`flex min-h-[48px] cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-xs transition-colors ${
                              paymentMethod === 'cod'
                                ? 'border-[#49243E] bg-white text-[#49243E]'
                                : 'border-[#49243E]/15 bg-white/60 text-[#242124]/80 hover:border-[#49243E]/35'
                            }`}
                          >
                            <input
                              type="radio"
                              name="checkout-payment-method"
                              value="cod"
                              checked={paymentMethod === 'cod'}
                              onChange={() => {
                                setPaymentMethod('cod');
                                setPaymentErrorText(null);
                              }}
                              className="h-4 w-4 accent-[#49243E]"
                            />
                            <Banknote className="h-4 w-4 shrink-0 text-[#B76E79]" aria-hidden="true" />
                            <div className="min-w-0">
                              <span className="block font-semibold text-[#49243E]">
                                Cash on Delivery
                              </span>
                              <span className="block text-[11px] text-[#242124]/65">
                                Pay when delivered
                              </span>
                            </div>
                          </label>
                        </div>

                        {paymentMethod === 'cod' && (
                          <div className="rounded-lg border border-[#49243E]/12 bg-white px-3 py-2 text-xs text-[#49243E]">
                            <p className="font-semibold tabular-nums">
                              Pay {formatPaiseINR(netPayablePaise)} on delivery
                            </p>
                            <p className="mt-0.5 text-[11px] text-[#242124]/65">
                              Complimentary delivery · ₹0 COD fee. Our team confirms dispatch promptly.
                            </p>
                          </div>
                        )}
                      </fieldset>

                      {paymentErrorText && (
                        <div
                          role="alert"
                          className="flex items-start gap-2 rounded-xl border border-[#B76E79]/55 bg-[#F3D5DF]/45 p-3 text-xs text-[#49243E]"
                        >
                          <AlertTriangle
                            className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]"
                            aria-hidden="true"
                          />
                          <span>{paymentErrorText}</span>
                        </div>
                      )}
                      <button
                        type="submit"
                        disabled={submitting || validating}
                        className="inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:opacity-60"
                      >
                        {submitting ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : paymentMethod === 'cod' ? (
                          <Banknote className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <CreditCard className="h-4 w-4" aria-hidden="true" />
                        )}
                        <span>
                          {submitting
                            ? paymentMethod === 'cod'
                              ? 'Placing Order…'
                              : 'Processing Payment…'
                            : paymentMethod === 'cod'
                              ? 'Place Order'
                              : `Pay with Razorpay (${formatPaiseINR(netPayablePaise)})`}
                        </span>
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            {!receipt && !pendingConfirmation && items.length > 0 && (
              <div className="space-y-3 border-t border-[#49243E]/10 bg-[#FFF9F5] px-5 py-4">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#242124]/70">
                      Verified Server Subtotal
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void revalidateBag()}
                        aria-label="Refresh live prices and stock"
                        className="rounded-lg p-1.5 text-[#49243E]/70 hover:bg-[#F3D5DF]/40 hover:text-[#49243E]"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${validating ? 'animate-spin' : ''}`} />
                      </button>
                      <span className="text-sm font-semibold tabular-nums text-[#49243E]">
                        {formatPaiseINR(displaySubtotalPaise)}
                      </span>
                    </div>
                  </div>
                  {effectiveDiscountPaise > 0 && (
                    <div className="flex items-center justify-between text-xs text-[#166534]">
                      <span>Coupon Discount ({appliedCouponCode})</span>
                      <span className="tabular-nums">-{formatPaiseINR(effectiveDiscountPaise)}</span>
                    </div>
                  )}
                  {effectiveGiftCardPaise > 0 && (
                    <div className="flex items-center justify-between text-xs text-[#166534]">
                      <span>Gift Card ({appliedGiftCardCode})</span>
                      <span className="tabular-nums">
                        -{formatPaiseINR(effectiveGiftCardPaise)}
                      </span>
                    </div>
                  )}
                  {(effectiveDiscountPaise > 0 || effectiveGiftCardPaise > 0) && (
                    <div className="flex items-center justify-between border-t border-[#49243E]/10 pt-1.5 text-base font-semibold text-[#49243E]">
                      <span>Net Payable</span>
                      <span className="tabular-nums">{formatPaiseINR(netPayablePaise)}</span>
                    </div>
                  )}
                </div>

                {!checkoutOpen && (
                  <button
                    type="button"
                    disabled={validating || Boolean(validation?.hasUnavailable)}
                    onClick={() => setCheckoutOpen(true)}
                    className="min-h-[46px] w-full rounded-xl bg-[#49243E] px-5 text-sm font-medium text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {validation?.hasUnavailable
                      ? 'Remove unavailable items to continue'
                      : 'Proceed to Checkout'}
                  </button>
                )}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
