import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleRazorpayWebhookRequest,
  type RazorpayClientFactory,
} from '../server/razorpay-checkout.ts';
import type { BoutiqueStore } from '../server/store.ts';

export interface VercelNodeRequest extends IncomingMessage {
  body?: unknown;
}

export interface VercelNodeResponse extends ServerResponse {
  status?: (code: number) => VercelNodeResponse;
  json?: (body: unknown) => void;
}

async function readRawBody(req: VercelNodeRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') {
    return JSON.stringify(req.body);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
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

export function createRazorpayWebhookHandler(options?: {
  razorpayClientFactory?: RazorpayClientFactory;
  store?: BoutiqueStore | null;
}) {
  return async function handler(req: VercelNodeRequest, res: VercelNodeResponse) {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, {
        status: 405,
        code: 'METHOD_NOT_ALLOWED',
        error: 'Method not allowed. Use POST /api/razorpay-webhook.',
      });
      return;
    }

    const rawBody = await readRawBody(req);
    const result = await handleRazorpayWebhookRequest({
      rawBody,
      signatureHeader: req.headers['x-razorpay-signature'],
      store: options?.store ?? null,
      razorpayClientFactory: options?.razorpayClientFactory,
    });
    sendJson(res, result.status, result.body);
  };
}

export default createRazorpayWebhookHandler();
