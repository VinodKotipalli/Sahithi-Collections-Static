import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Loader2,
  Mail,
  MessageCircle,
  Send,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  buildWhatsAppChatUrl,
  formatWhatsAppDisplay,
  resolveBoutiqueEmail,
  resolveWhatsAppDigits,
} from '../config/site';
import { useStorefront } from '../context/StorefrontContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import {
  askWhatsAppStylist,
  type RecommendedStylistProductDTO,
  type WhatsAppStylistProductContext,
  type WhatsAppStylistTurn,
} from '../services/whatsappStylist';
import type { Product } from '../types/boutique';
import { formatPaiseINR } from '../utils/format';
import { BoutiqueImage } from './BoutiqueImage';

interface ChatMessageEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  recommendedProducts?: RecommendedStylistProductDTO[];
  whatsappUrl?: string;
}

interface WhatsAppStylistDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  products: Product[];
  productContext?: WhatsAppStylistProductContext | null;
  onSelectProduct: (product: Product) => void;
}

const STARTER_PROMPTS = [
  'Suggest a festive outfit under ₹2,000',
  'Everyday cotton kurti for sunny outings',
  'Pair accessories with a pastel organza saree',
  'Help me pick the right size & fit',
];

export function WhatsAppStylistDrawer({
  isOpen,
  onClose,
  products,
  productContext = null,
  onSelectProduct,
}: WhatsAppStylistDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const prefersReducedMotion = usePrefersReducedMotion();
  const { settings } = useStorefront();

  const whatsappDigits = resolveWhatsAppDigits(settings.contact);
  const whatsappDisplay = formatWhatsAppDisplay(whatsappDigits);
  const boutiqueEmail = resolveBoutiqueEmail(settings.contact);
  const productMap = new Map(products.map((p) => [p.id, p]));

  const [messages, setMessages] = useState<ChatMessageEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useFocusTrap(isOpen, drawerRef, onClose);

  useEffect(() => {
    if (!isOpen) return;
    setErrorText(null);
    if (messages.length === 0) {
      const greeting = productContext
        ? `Hello! I am your automated ${settings.brandName || 'Sahithi Collections'} WhatsApp stylist. Ask me about sizing, fabric pairing, or accessories for "${productContext.name}", or send your question straight to WhatsApp ${whatsappDisplay}.`
        : `Hello! Welcome to ${settings.brandName || 'Sahithi Collections'}. Tell me your occasion, preferred palette, or budget in INR and I will curate pieces instantly — or continue directly on WhatsApp (${whatsappDisplay}).`;
      setMessages([
        {
          id: 'welcome-stylist',
          role: 'assistant',
          text: greeting,
          whatsappUrl: buildWhatsAppChatUrl(
            productContext
              ? `Hello Sahithi Collections, I would like styling advice for "${productContext.name}".`
              : 'Hello Sahithi Collections, I would like personal styling recommendations.',
            settings.contact
          ),
        },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, productContext?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  }, [messages.length, sending, prefersReducedMotion]);

  const submitPrompt = async (rawText: string) => {
    const cleanText = rawText.trim();
    if (cleanText.length < 2 || sending) return;

    const userMsg: ChatMessageEntry = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: cleanText,
    };

    const historyPayload: WhatsAppStylistTurn[] = messages
      .filter((m) => m.id !== 'welcome-stylist')
      .map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, userMsg]);
    setDraft('');
    setErrorText(null);
    setSending(true);

    const result = await askWhatsAppStylist({
      message: cleanText,
      history: historyPayload,
      productContext,
    });

    setSending(false);

    if (!result.ok) {
      setErrorText(result.error);
      return;
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: result.reply,
        recommendedProducts: result.recommendedProducts,
        whatsappUrl: result.whatsappUrl,
      },
    ]);
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitPrompt(draft);
  };

  const latestWhatsAppHref =
    [...messages].reverse().find((m) => m.whatsappUrl)?.whatsappUrl ||
    buildWhatsAppChatUrl(
      'Hello Sahithi Collections, I would like WhatsApp styling help.',
      settings.contact
    );

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
            aria-labelledby="whatsapp-stylist-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={prefersReducedMotion ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={prefersReducedMotion ? undefined : { x: '100%' }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="flex h-full w-full max-w-md flex-col bg-[#FFF9F5] shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-start justify-between border-b border-[#49243E]/10 px-5 py-4">
              <div>
                <h2
                  id="whatsapp-stylist-title"
                  className="font-serif text-2xl font-semibold text-[#49243E]"
                >
                  WhatsApp AI Stylist
                </h2>
                <p className="mt-0.5 text-xs text-[#242124]/70 tabular-nums">
                  {whatsappDisplay} · {boutiqueEmail}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close WhatsApp AI Stylist"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#49243E]/15 text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#49243E]"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Active product context banner */}
            {productContext && (
              <div className="border-b border-[#49243E]/10 bg-white px-5 py-2.5 text-xs text-[#49243E]">
                Styling focus: <span className="font-semibold">{productContext.name}</span>
                {productContext.selectedSize ? ` · Size ${productContext.selectedSize}` : ''}
                {productContext.selectedColor ? ` · ${productContext.selectedColor}` : ''}
              </div>
            )}

            {/* Conversation body */}
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {messages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-line ${
                        isUser
                          ? 'bg-[#49243E] text-[#FFF9F5]'
                          : 'border border-[#49243E]/12 bg-white text-[#242124]'
                      }`}
                    >
                      {msg.text}
                    </div>

                    {!isUser &&
                      msg.recommendedProducts &&
                      msg.recommendedProducts.length > 0 && (
                        <div className="mt-2.5 w-full space-y-2">
                          {msg.recommendedProducts.map((rec) => {
                            const fullProduct = productMap.get(rec.id);
                            const imgSrc = fullProduct?.images[0]?.src || '';
                            return (
                              <button
                                key={rec.id}
                                type="button"
                                onClick={() => {
                                  if (fullProduct) {
                                    onClose();
                                    onSelectProduct(fullProduct);
                                  }
                                }}
                                className="flex w-full items-center gap-3 rounded-xl border border-[#49243E]/12 bg-white p-2.5 text-left transition-colors hover:border-[#49243E]/35"
                              >
                                {imgSrc && (
                                  <div className="h-14 w-12 shrink-0 overflow-hidden rounded-lg bg-[#F8F1ED]">
                                    <BoutiqueImage
                                      src={imgSrc}
                                      alt={rec.title}
                                      fallbackTitle={rec.title}
                                      className="h-full w-full object-cover object-top"
                                    />
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-serif text-sm font-semibold text-[#49243E]">
                                    {rec.title}
                                  </p>
                                  <p className="mt-0.5 text-xs text-[#242124]/65 tabular-nums">
                                    {rec.category} · {formatPaiseINR(rec.pricePaise)}
                                  </p>
                                </div>
                                <ArrowUpRight
                                  className="h-4 w-4 shrink-0 text-[#49243E]/65"
                                  aria-hidden="true"
                                />
                              </button>
                            );
                          })}
                        </div>
                      )}

                    {!isUser && msg.whatsappUrl && (
                      <a
                        href={msg.whatsappUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[#49243E]/20 bg-white px-3.5 py-1.5 text-xs font-medium text-[#49243E] transition-colors hover:bg-[#F3D5DF]/40"
                      >
                        <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Send to WhatsApp ({whatsappDisplay})</span>
                      </a>
                    )}
                  </div>
                );
              })}

              {sending && (
                <div className="flex items-center gap-2 rounded-2xl border border-[#49243E]/12 bg-white px-4 py-3 text-xs font-medium text-[#49243E]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#B76E79]" aria-hidden="true" />
                  <span>Curating styling recommendations…</span>
                </div>
              )}

              {errorText && (
                <div
                  role="alert"
                  className="space-y-2.5 rounded-2xl border border-[#B76E79]/45 bg-[#F3D5DF]/35 p-3.5 text-xs text-[#49243E]"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#B76E79]"
                      aria-hidden="true"
                    />
                    <span>{errorText}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={latestWhatsAppHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[#49243E] px-3 text-xs font-medium text-[#FFF9F5]"
                    >
                      <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Message {whatsappDisplay}</span>
                    </a>
                    <a
                      href={`mailto:${boutiqueEmail}`}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[#49243E]/25 bg-white px-3 text-xs font-medium text-[#49243E]"
                    >
                      <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Email Us</span>
                    </a>
                  </div>
                </div>
              )}

              {/* Starter prompts when only welcome message exists */}
              {messages.length <= 1 && !sending && (
                <div className="space-y-2 pt-1">
                  <p className="text-xs font-medium text-[#242124]/65">Quick styling prompts</p>
                  <div className="grid grid-cols-1 gap-2">
                    {STARTER_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => void submitPrompt(prompt)}
                        className="min-h-[40px] rounded-xl border border-[#49243E]/15 bg-white px-3.5 py-2 text-left text-xs font-medium text-[#49243E] transition-colors hover:border-[#49243E]/40 hover:bg-[#F3D5DF]/25"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Composer & Direct Channels Footer */}
            <div className="border-t border-[#49243E]/10 bg-white px-5 py-3.5 space-y-2.5">
              <form onSubmit={handleFormSubmit} className="flex items-center gap-2">
                <label htmlFor={inputId} className="sr-only">
                  Ask our WhatsApp AI Stylist
                </label>
                <input
                  id={inputId}
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={sending}
                  maxLength={1500}
                  placeholder="Ask about outfits, sizes, or pairings…"
                  className="min-h-[44px] flex-1 rounded-xl border border-[#49243E]/18 bg-[#FFF9F5]/70 px-3.5 text-sm text-[#242124] placeholder:text-[#242124]/45 focus:border-[#49243E] focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={sending || draft.trim().length < 2}
                  aria-label="Send styling question"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#49243E] text-[#FFF9F5] transition-colors hover:bg-[#3A1B31] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </form>

              <div className="flex items-center justify-between gap-2 text-[11px] text-[#242124]/65">
                <a
                  href={latestWhatsAppHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[#49243E] underline-offset-2 hover:underline tabular-nums"
                >
                  Open WhatsApp {whatsappDisplay}
                </a>
                <a
                  href={`mailto:${boutiqueEmail}`}
                  className="truncate font-medium text-[#49243E] underline-offset-2 hover:underline"
                >
                  {boutiqueEmail}
                </a>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
