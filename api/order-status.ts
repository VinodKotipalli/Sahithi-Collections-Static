import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleOrderStatusRequest,
  verifyBearerFirebaseTokenFromHeader,
  type IdTokenVerifierFn,
  type RazorpayClientFactory,
} from '../server/razorpay-checkout.ts';
import type { BoutiqueStore } from '../server/store.ts';

export interface VercelNodeRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[]>;
}

export interface VercelNodeResponse extends ServerResponse {
  status?: (code: number) => VercelNodeResponse;
  json?: (body: unknown) => void;
}

async function readJsonBody(req: VercelNodeRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as Record<string, unknown>;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sendJson(res: VercelNodeResponse, statusCode: number, payload: Record<string, unknown>) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (typeof res.status === 'function') {
    const statusRes = res.status(statusCode);
    if (statusRes && typeof statusRes.json === 'function') {
      statusRes.json(payload);
      return;
    }
  }
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

export function createOrderStatusHandler(options?: {
  razorpayClientFactory?: RazorpayClientFactory;
  verifyIdToken?: IdTokenVerifierFn;
  store?: BoutiqueStore | null;
}) {
  return async function handler(req: VercelNodeRequest, res: VercelNodeResponse) {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      sendJson(res, 405, { status: 405, code: 'METHOD_NOT_ALLOWED', error: 'Use GET or POST.' });
      return;
    }

    const authResult = await verifyBearerFirebaseTokenFromHeader(
      req.headers.authorization,
      options?.verifyIdToken
    );
    if (!authResult.ok) {
      sendJson(res, authResult.status, {
        status: authResult.status,
        code: authResult.code,
        error: authResult.error,
      });
      return;
    }

    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const body = method === 'POST' ? await readJsonBody(req) : {};
    const razorpayOrderId =
      parsedUrl.searchParams.get('razorpay_order_id') ||
      parsedUrl.searchParams.get('order_id') ||
      (typeof body.razorpay_order_id === 'string' ? body.razorpay_order_id : '') ||
      (typeof body.order_id === 'string' ? body.order_id : '');
    const razorpayPaymentId =
      parsedUrl.searchParams.get('razorpay_payment_id') ||
      parsedUrl.searchParams.get('payment_id') ||
      (typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id : '') ||
      (typeof body.payment_id === 'string' ? body.payment_id : '');

    const result = await handleOrderStatusRequest({
      razorpayOrderId,
      razorpayPaymentId: razorpayPaymentId || undefined,
      store: options?.store ?? null,
      customerUserId: authResult.uid,
      customerIdToken: authResult.rawToken,
      razorpayClientFactory: options?.razorpayClientFactory,
    });
    sendJson(res, result.status, result.body);
  };
}

export default createOrderStatusHandler();
