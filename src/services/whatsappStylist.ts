export interface WhatsAppStylistTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface WhatsAppStylistProductContext {
  id: string;
  name: string;
  category?: string;
  pricePaise?: number;
  selectedSize?: string;
  selectedColor?: string;
}

export interface RecommendedStylistProductDTO {
  id: string;
  slug: string;
  title: string;
  category: string;
  pricePaise: number;
  inStock: boolean;
}

export interface WhatsAppStylistSuccess {
  ok: true;
  reply: string;
  recommendedProducts: RecommendedStylistProductDTO[];
  whatsappPrefill: string;
  whatsappUrl: string;
  whatsappDigits: string;
  whatsappDisplay: string;
  boutiqueEmail: string;
}

export interface WhatsAppStylistError {
  ok: false;
  status: number;
  error: string;
}

export async function askWhatsAppStylist(params: {
  message: string;
  history: WhatsAppStylistTurn[];
  productContext?: WhatsAppStylistProductContext | null;
}): Promise<WhatsAppStylistSuccess | WhatsAppStylistError> {
  try {
    const res = await fetch('/api/whatsapp/stylist', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        message: params.message,
        history: params.history,
        productContext: params.productContext || undefined,
      }),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok !== true) {
      return {
        ok: false,
        status: res.status || 500,
        error:
          typeof data.error === 'string' && data.error
            ? data.error
            : `Unable to reach the automated stylist right now (HTTP ${res.status}).`,
      };
    }

    return {
      ok: true,
      reply: String(data.reply || ''),
      recommendedProducts: Array.isArray(data.recommendedProducts)
        ? (data.recommendedProducts as RecommendedStylistProductDTO[])
        : [],
      whatsappPrefill: String(data.whatsappPrefill || ''),
      whatsappUrl: String(data.whatsappUrl || ''),
      whatsappDigits: String(data.whatsappDigits || '918520899337'),
      whatsappDisplay: String(data.whatsappDisplay || '+91 85208 99337'),
      boutiqueEmail: String(data.boutiqueEmail || 'saivinodkotipalli2003@gmail.com'),
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error:
        err instanceof Error
          ? err.message
          : 'Network error while connecting to the automated WhatsApp stylist.',
    };
  }
}
