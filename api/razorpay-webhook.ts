import 'dotenv/config';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleRazorpayWebhookRequest,
  type RazorpayClientFactory,
} from '../server/razorpay-checkout.ts';
import type { BoutiqueStore } from '../server/store.ts';

export const config = {
  api: {
    bodyParser: false,
  },
};

export interface VercelNodeRequest extends IncomingMessage {
  body?: unknown;
  rawBody?: string | Buffer;
}

export interface VercelNodeResponse extends ServerResponse {
  status?: (code: number) => VercelNodeResponse;
  json?: (body: unknown) => void;
}

async function readRawBody(req: VercelNodeRequest): Promise<string> {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length > 0) {
    return Buffer.concat(chunks).toString('utf8');
  }

  if (req.body && typeof req.body === 'object') {
    return JSON.stringify(req.body);
  }
  return '';
}

function sendJson(
  res: VercelNodeResponse,
  statusCode: number,
  payload: Record<string, unknown>,
  requestId?: string
) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (requestId) {
    res.setHeader('X-Request-Id', requestId);
  }
  const finalPayload =
    requestId && statusCode !== 204 && !payload.support_reference
      ? { ...payload, support_reference: requestId }
      : payload;
  if (typeof res.status === 'function') {
    const statusRes = res.status(statusCode);
    if (statusRes && typeof statusRes.json === 'function') {
      statusRes.json(finalPayload);
      return;
    }
  }
  res.statusCode = statusCode;
  res.end(JSON.stringify(finalPayload));
}

export function createRazorpayWebhookHandler(options?: {
  razorpayClientFactory?: RazorpayClientFactory;
  store?: BoutiqueStore | null;
}) {
  return async function handler(req: VercelNodeRequest, res: VercelNodeResponse) {
    const rawReqId = req.headers['x-vercel-id'] || req.headers['x-request-id'];
    const requestId =
      (Array.isArray(rawReqId) ? rawReqId[0] : rawReqId)?.trim() || crypto.randomUUID();

    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(
        res,
        405,
        {
          status: 405,
          code: 'METHOD_NOT_ALLOWED',
          error: 'Method not allowed. Use POST /api/razorpay-webhook.',
        },
        requestId
      );
      return;
    }

    const rawBody = await readRawBody(req);
    const result = await handleRazorpayWebhookRequest({
      rawBody,
      signatureHeader: req.headers['x-razorpay-signature'],
      eventIdHeader: req.headers['x-razorpay-event-id'],
      store: options?.store ?? null,
      razorpayClientFactory: options?.razorpayClientFactory,
      requestId,
    });
    sendJson(res, result.status, result.body, requestId);
  };
}

export default createRazorpayWebhookHandler();
