import crypto from 'node:crypto';
import { GoogleGenAI, Type, type GenerateContentResponse } from '@google/genai';
import { fetchPublishedCatalogFromFirestore } from './razorpay-checkout.ts';
import type { BoutiqueStore } from './store.ts';

export const DEFAULT_WHATSAPP_DIGITS = '918520899337';
export const DEFAULT_BOUTIQUE_EMAIL = 'saivinodkotipalli2003@gmail.com';
const GEMINI_STYLIST_MODEL = 'gemini-4-hydrogen';

export interface StylistChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface StylistProductContext {
  id: string;
  name: string;
  category?: string;
  pricePaise?: number;
  selectedSize?: string;
  selectedColor?: string;
}

export interface StylistCatalogSummary {
  id: string;
  slug: string;
  title: string;
  category: string;
  priceInr: number;
  pricePaise: number;
  inStock: boolean;
  sizes: string[];
  colors: string[];
  fabricNote: string;
}

export interface RecommendedStylistProduct {
  id: string;
  slug: string;
  title: string;
  category: string;
  pricePaise: number;
  inStock: boolean;
}

export interface GeminiClientLike {
  models: {
    generateContent: (params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }) => Promise<{ text?: string | undefined }>;
  };
}

export type GeminiClientFactory = (apiKey: string) => GeminiClientLike;

export interface WhatsAppHandlerResponse {
  status: number;
  body: Record<string, unknown>;
  rawText?: string;
}

function defaultGeminiClientFactory(apiKey: string): GeminiClientLike {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  }) as unknown as GeminiClientLike;
}

export function normalizeServerWhatsAppDigits(raw?: string | null): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return DEFAULT_WHATSAPP_DIGITS;
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `91${digits}`;
  }
  return digits.length >= 10 ? digits : DEFAULT_WHATSAPP_DIGITS;
}

export function formatServerWhatsAppDisplay(digits: string): string {
  const clean = normalizeServerWhatsAppDigits(digits);
  if (clean.length === 12 && clean.startsWith('91')) {
    return `+91 ${clean.slice(2, 7)} ${clean.slice(7)}`;
  }
  return `+${clean}`;
}

async function resolveBoutiqueContact(store?: BoutiqueStore | null): Promise<{
  brandName: string;
  whatsappDigits: string;
  whatsappDisplay: string;
  email: string;
}> {
  let rawNumber = process.env.WHATSAPP_PHONE_NUMBER || DEFAULT_WHATSAPP_DIGITS;
  let rawEmail = process.env.BOUTIQUE_EMAIL || DEFAULT_BOUTIQUE_EMAIL;
  let brandName = 'Sahithi Collections';

  if (store) {
    try {
      const settings = await store.getSiteSettings();
      if (settings.brandName?.trim()) brandName = settings.brandName.trim();
      if (settings.contact.whatsappNumber?.trim()) {
        rawNumber = settings.contact.whatsappNumber.trim();
      }
      if (settings.contact.email?.trim()) {
        rawEmail = settings.contact.email.trim();
      }
    } catch {
      // Fall back cleanly to configured defaults
    }
  }

  const whatsappDigits = normalizeServerWhatsAppDigits(rawNumber);
  return {
    brandName,
    whatsappDigits,
    whatsappDisplay: formatServerWhatsAppDisplay(whatsappDigits),
    email: rawEmail.trim() || DEFAULT_BOUTIQUE_EMAIL,
  };
}

async function loadLiveCatalogSummaries(
  store?: BoutiqueStore | null
): Promise<StylistCatalogSummary[]> {
  if (store) {
    try {
      const rows = await store.listPublicProducts({});
      return rows.map((entry) => {
        const pricePaise = entry.product.price_paise;
        const sizes = Array.from(new Set(entry.variants.map((v) => v.size).filter(Boolean)));
        const colors = Array.from(
          new Set(entry.variants.map((v) => v.color_name).filter(Boolean))
        );
        return {
          id: entry.product.id,
          slug: entry.product.slug,
          title: entry.product.title,
          category: entry.product.category,
          priceInr: Math.round(pricePaise / 100),
          pricePaise,
          inStock: entry.product.stock_qty > 0,
          sizes,
          colors,
          fabricNote: entry.product.fabric_note || '',
        };
      });
    } catch {
      // Fallback to Firestore/seed below
    }
  }

  const catalogMap = await fetchPublishedCatalogFromFirestore();
  return Array.from(catalogMap.values()).map((prod) => {
    const sizes = Array.from(new Set(prod.variants.map((v) => v.size).filter(Boolean)));
    const colors = Array.from(new Set(prod.variants.map((v) => v.color_name).filter(Boolean)));
    return {
      id: prod.id,
      slug: prod.slug,
      title: prod.title,
      category: prod.category || 'Boutique Collection',
      priceInr: Math.round(prod.price_paise / 100),
      pricePaise: prod.price_paise,
      inStock: prod.stock_qty > 0,
      sizes,
      colors,
      fabricNote: prod.fabric_note || '',
    };
  });
}

function buildCatalogPromptBlock(items: StylistCatalogSummary[]): string {
  return items
    .slice(0, 40)
    .map((p) => {
      const stockLabel = p.inStock ? 'In Stock' : 'Out of Stock';
      const sizes = p.sizes.length > 0 ? p.sizes.join('/') : 'Free Size';
      const colors = p.colors.length > 0 ? p.colors.slice(0, 4).join(', ') : 'Signature';
      const fabric = p.fabricNote ? ` | Fabric: ${p.fabricNote}` : '';
      return `- [${p.id}] ${p.title} (${p.category}) — ₹${p.priceInr.toLocaleString('en-IN')} | ${stockLabel} | Sizes: ${sizes} | Shades: ${colors}${fabric}`;
    })
    .join('\n');
}

function extractGeminiErrorDetails(err: unknown): { status: number; message: string } {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const rawStatus =
    typeof errObj.status === 'number'
      ? errObj.status
      : typeof errObj.statusCode === 'number'
        ? errObj.statusCode
        : 502;
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof errObj.message === 'string'
        ? errObj.message
        : 'AI styling service is temporarily unavailable.';

  if (
    rawStatus === 400 ||
    rawStatus === 401 ||
    rawStatus === 403 ||
    /API_KEY_INVALID|PERMISSION_DENIED|API key not valid/i.test(rawMessage)
  ) {
    return {
      status: 503,
      message:
        'Automated AI Stylist could not authenticate with Gemini. Please check GEMINI_API_KEY in Settings > Secrets or your deployment environment.',
    };
  }

  if (rawStatus === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(rawMessage)) {
    return {
      status: 429,
      message:
        'AI Stylist is experiencing high demand right now. Please try again in a moment or message us directly on WhatsApp.',
    };
  }

  return {
    status: rawStatus >= 400 && rawStatus < 600 ? rawStatus : 502,
    message: rawMessage,
  };
}

async function generateAutomatedStylingResponse(params: {
  userMessage: string;
  history: StylistChatTurn[];
  productContext?: StylistProductContext | null;
  store?: BoutiqueStore | null;
  aiClientFactory?: GeminiClientFactory;
}): Promise<{
  reply: string;
  recommendedProducts: RecommendedStylistProduct[];
  whatsappPrefill: string;
  whatsappUrl: string;
  whatsappDigits: string;
  whatsappDisplay: string;
  boutiqueEmail: string;
}> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw Object.assign(
      new Error(
        'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets or Vercel Environment Variables to enable automated AI styling.'
      ),
      { status: 503 }
    );
  }

  const [contact, catalog] = await Promise.all([
    resolveBoutiqueContact(params.store),
    loadLiveCatalogSummaries(params.store),
  ]);

  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const catalogBlock = buildCatalogPromptBlock(catalog);

  const productContextBlock = params.productContext
    ? `\nACTIVE PIECE CUSTOMER IS VIEWING:\n- ID: ${params.productContext.id}\n- Name: ${params.productContext.name}${
        params.productContext.category ? `\n- Category: ${params.productContext.category}` : ''
      }${
        params.productContext.pricePaise
          ? `\n- Price: ₹${Math.round(params.productContext.pricePaise / 100).toLocaleString('en-IN')}`
          : ''
      }${params.productContext.selectedSize ? `\n- Selected Size: ${params.productContext.selectedSize}` : ''}${
        params.productContext.selectedColor
          ? `\n- Selected Color: ${params.productContext.selectedColor}`
          : ''
      }\n`
    : '';

  const systemInstruction = [
    `You are the automated AI Fashion & WhatsApp Stylist for ${contact.brandName} (sahithidesigns.online).`,
    `Official boutique WhatsApp concierge number: ${contact.whatsappDisplay} (wa.me/${contact.whatsappDigits}).`,
    `Official boutique email: ${contact.email}.`,
    'Your role: give warm, practical, specific Indian & fusion boutique styling advice, sizing guidance, occasion outfit ideas, and fabric care tips.',
    'Rules:',
    '1. Recommend ONLY pieces that exist in the LIVE CATALOG below, quoting exact product names and exact INR prices.',
    '2. Keep replies crisp, scannable, and WhatsApp-ready (around 60–140 words; short paragraphs or clean bullets without markdown code blocks).',
    '3. Whenever a customer asks about custom tailoring, bulk bridal gifting, order follow-ups, or bespoke alterations, invite them to message WhatsApp ' +
      contact.whatsappDisplay +
      ' or email ' +
      contact.email +
      '.',
    '4. Return 1 to 3 matching product IDs in recommendedProductIds (only IDs present in LIVE CATALOG).',
    '5. Provide a concise 1-sentence whatsappPrefill message written in first-person from the customer so one tap opens WhatsApp with full context.',
    '',
    'LIVE CATALOG:',
    catalogBlock,
    productContextBlock,
  ].join('\n');

  const recentHistory = params.history
    .slice(-8)
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.text.trim().slice(0, 1200) }],
    }));

  const contents = [
    ...recentHistory,
    {
      role: 'user',
      parts: [{ text: params.userMessage.trim().slice(0, 1500) }],
    },
  ];

  const ai = (params.aiClientFactory || defaultGeminiClientFactory)(apiKey);
  const response = (await ai.models.generateContent({
    model: GEMINI_STYLIST_MODEL,
    contents,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          reply: {
            type: Type.STRING,
            description: 'Warm, concise WhatsApp styling reply tailored to the customer query.',
          },
          recommendedProductIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Up to 3 matching product IDs from the live catalog.',
          },
          whatsappPrefill: {
            type: Type.STRING,
            description:
              'Concise first-person WhatsApp summary message ready to send to the boutique.',
          },
        },
        required: ['reply', 'recommendedProductIds', 'whatsappPrefill'],
      },
    },
  })) as GenerateContentResponse;

  const rawText = (response.text ?? '').trim();
  let parsed: {
    reply?: unknown;
    recommendedProductIds?: unknown;
    whatsappPrefill?: unknown;
  } = {};

  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      parsed = { reply: rawText };
    }
  }

  const replyText =
    typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : rawText || 'Thank you for reaching out to Sahithi Collections! Share your occasion or size preference and I will curate pieces for you.';

  const recommendedIds = Array.isArray(parsed.recommendedProductIds)
    ? parsed.recommendedProductIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
    : [];

  const recommendedProducts: RecommendedStylistProduct[] = [];
  const seen = new Set<string>();
  for (const id of recommendedIds) {
    if (seen.has(id)) continue;
    const matched = catalogById.get(id);
    if (!matched) continue;
    seen.add(id);
    recommendedProducts.push({
      id: matched.id,
      slug: matched.slug,
      title: matched.title,
      category: matched.category,
      pricePaise: matched.pricePaise,
      inStock: matched.inStock,
    });
    if (recommendedProducts.length >= 3) break;
  }

  const prefill =
    typeof parsed.whatsappPrefill === 'string' && parsed.whatsappPrefill.trim()
      ? parsed.whatsappPrefill.trim()
      : `Hello ${contact.brandName}, I would like WhatsApp styling help regarding: "${params.userMessage.trim().slice(0, 140)}"`;

  const whatsappUrl = `https://wa.me/${contact.whatsappDigits}?text=${encodeURIComponent(prefill)}`;

  return {
    reply: replyText,
    recommendedProducts,
    whatsappPrefill: prefill,
    whatsappUrl,
    whatsappDigits: contact.whatsappDigits,
    whatsappDisplay: contact.whatsappDisplay,
    boutiqueEmail: contact.email,
  };
}

export async function handleWhatsAppStylistRequest(params: {
  body: Record<string, unknown>;
  store?: BoutiqueStore | null;
  aiClientFactory?: GeminiClientFactory;
}): Promise<WhatsAppHandlerResponse> {
  const rawMessage = typeof params.body.message === 'string' ? params.body.message.trim() : '';
  if (rawMessage.length < 2 || rawMessage.length > 1500) {
    return {
      status: 400,
      body: {
        status: 400,
        code: 'VALIDATION_ERROR',
        error: 'Please enter a styling question between 2 and 1,500 characters.',
      },
    };
  }

  const rawHistory = Array.isArray(params.body.history) ? params.body.history : [];
  const history: StylistChatTurn[] = rawHistory
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    .map((entry) => ({
      role: entry.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      text: typeof entry.text === 'string' ? entry.text : '',
    }))
    .filter((entry) => entry.text.trim().length > 0);

  const rawProduct =
    params.body.productContext && typeof params.body.productContext === 'object'
      ? (params.body.productContext as Record<string, unknown>)
      : null;

  const productContext: StylistProductContext | null =
    rawProduct && typeof rawProduct.id === 'string' && typeof rawProduct.name === 'string'
      ? {
          id: rawProduct.id.trim(),
          name: rawProduct.name.trim(),
          category:
            typeof rawProduct.category === 'string' ? rawProduct.category.trim() : undefined,
          pricePaise:
            typeof rawProduct.pricePaise === 'number' && Number.isFinite(rawProduct.pricePaise)
              ? Math.round(rawProduct.pricePaise)
              : undefined,
          selectedSize:
            typeof rawProduct.selectedSize === 'string'
              ? rawProduct.selectedSize.trim()
              : undefined,
          selectedColor:
            typeof rawProduct.selectedColor === 'string'
              ? rawProduct.selectedColor.trim()
              : undefined,
        }
      : null;

  try {
    const generated = await generateAutomatedStylingResponse({
      userMessage: rawMessage,
      history,
      productContext,
      store: params.store,
      aiClientFactory: params.aiClientFactory,
    });
    return {
      status: 200,
      body: {
        ok: true,
        ...generated,
      },
    };
  } catch (err: unknown) {
    const { status, message } = extractGeminiErrorDetails(err);
    return {
      status,
      body: {
        status,
        code: status === 429 ? 'AI_RATE_LIMITED' : 'AI_STYLIST_ERROR',
        error: message,
      },
    };
  }
}

export function handleWhatsAppWebhookGet(params: {
  query: Record<string, string | string[] | undefined>;
}): WhatsAppHandlerResponse {
  const pick = (val: string | string[] | undefined): string =>
    Array.isArray(val) ? (val[0] || '') : val || '';

  const mode = pick(params.query['hub.mode']);
  const verifyToken = pick(params.query['hub.verify_token']);
  const challenge = pick(params.query['hub.challenge']);
  const configuredToken = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();

  if (mode === 'subscribe' && configuredToken && verifyToken === configuredToken && challenge) {
    return {
      status: 200,
      body: { ok: true, challenge },
      rawText: challenge,
    };
  }

  return {
    status: 403,
    body: {
      status: 403,
      code: 'WEBHOOK_VERIFICATION_FAILED',
      error: 'Invalid WhatsApp webhook verification token or mode.',
    },
  };
}

function verifyWhatsAppHubSignature(rawBody: string, signatureHeader?: string): boolean {
  const appSecret = (process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!appSecret) return true;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader.trim(), 'utf8');
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

interface IncomingWhatsAppMessage {
  from: string;
  text: string;
  messageId?: string;
}

function extractIncomingWhatsAppMessages(body: Record<string, unknown>): IncomingWhatsAppMessage[] {
  const extracted: IncomingWhatsAppMessage[] = [];

  // Meta WhatsApp Business Cloud API format
  if (Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      if (!entry || typeof entry !== 'object') continue;
      const changes = (entry as Record<string, unknown>).changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (!change || typeof change !== 'object') continue;
        const val = (change as Record<string, unknown>).value;
        if (!val || typeof val !== 'object') continue;
        const messages = (val as Record<string, unknown>).messages;
        if (!Array.isArray(messages)) continue;
        for (const msg of messages) {
          if (!msg || typeof msg !== 'object') continue;
          const m = msg as Record<string, unknown>;
          const from = typeof m.from === 'string' ? m.from.trim() : '';
          const messageId = typeof m.id === 'string' ? m.id : undefined;
          let text = '';
          if (m.text && typeof m.text === 'object') {
            const t = (m.text as Record<string, unknown>).body;
            if (typeof t === 'string') text = t.trim();
          } else if (m.interactive && typeof m.interactive === 'object') {
            const inter = m.interactive as Record<string, unknown>;
            const btn = inter.button_reply as Record<string, unknown> | undefined;
            const list = inter.list_reply as Record<string, unknown> | undefined;
            const candidate = btn?.title || list?.title;
            if (typeof candidate === 'string') text = candidate.trim();
          }
          if (from && text) {
            extracted.push({ from, text, messageId });
          }
        }
      }
    }
  }

  // Simplified webhook JSON payload ({ from, message })
  if (
    extracted.length === 0 &&
    typeof body.from === 'string' &&
    body.from.trim() &&
    typeof body.message === 'string' &&
    body.message.trim()
  ) {
    extracted.push({
      from: body.from.trim(),
      text: body.message.trim(),
    });
  }

  return extracted;
}

export async function handleWhatsAppWebhookPost(params: {
  body: Record<string, unknown>;
  rawBody?: string;
  signatureHeader?: string;
  store?: BoutiqueStore | null;
  aiClientFactory?: GeminiClientFactory;
  fetchImpl?: typeof fetch;
}): Promise<WhatsAppHandlerResponse> {
  const rawText = params.rawBody ?? JSON.stringify(params.body);
  if (!verifyWhatsAppHubSignature(rawText, params.signatureHeader)) {
    return {
      status: 401,
      body: {
        status: 401,
        code: 'INVALID_SIGNATURE',
        error: 'Invalid X-Hub-Signature-256 webhook signature.',
      },
    };
  }

  const incoming = extractIncomingWhatsAppMessages(params.body);
  if (incoming.length === 0) {
    return {
      status: 200,
      body: { ok: true, processed: 0, replies: [] },
    };
  }

  const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const graphFetch = params.fetchImpl || globalThis.fetch;

  const replies: Array<{
    to: string;
    reply: string;
    recommendedProductIds: string[];
    dispatched: boolean;
    dispatchError?: string;
  }> = [];

  for (const msg of incoming.slice(0, 5)) {
    try {
      const aiResult = await generateAutomatedStylingResponse({
        userMessage: msg.text,
        history: [],
        store: params.store,
        aiClientFactory: params.aiClientFactory,
      });

      const formattedReply =
        aiResult.recommendedProducts.length > 0
          ? `${aiResult.reply}\n\nFeatured pieces:\n${aiResult.recommendedProducts
              .map(
                (p) =>
                  `• ${p.title} — ₹${Math.round(p.pricePaise / 100).toLocaleString('en-IN')} (https://sahithidesigns.online/products/${encodeURIComponent(p.slug)})`
              )
              .join('\n')}\n\nConcierge Email: ${aiResult.boutiqueEmail}`
          : `${aiResult.reply}\n\nBoutique Email: ${aiResult.boutiqueEmail}`;

      let dispatched = false;
      let dispatchError: string | undefined;

      if (accessToken && phoneNumberId) {
        const graphRes = await graphFetch(
          `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: msg.from,
              ...(msg.messageId ? { context: { message_id: msg.messageId } } : {}),
              type: 'text',
              text: { preview_url: false, body: formattedReply.slice(0, 4096) },
            }),
          }
        );
        dispatched = graphRes.ok;
        if (!graphRes.ok) {
          dispatchError = `WhatsApp Cloud API returned HTTP ${graphRes.status}.`;
        }
      }

      replies.push({
        to: msg.from,
        reply: formattedReply,
        recommendedProductIds: aiResult.recommendedProducts.map((p) => p.id),
        dispatched,
        ...(dispatchError ? { dispatchError } : {}),
      });
    } catch (err: unknown) {
      const { status, message } = extractGeminiErrorDetails(err);
      return {
        status,
        body: {
          status,
          code: 'AI_WEBHOOK_ERROR',
          error: message,
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      processed: replies.length,
      replies,
    },
  };
}
