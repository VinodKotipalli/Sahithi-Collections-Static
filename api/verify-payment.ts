import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleVerifyPaymentRequest,
  type RazorpayClientFactory,
} from '../server/razorpay-checkout.ts';

export interface VercelNodeRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[]>;
}

export interface VercelNodeResponse extends ServerResponse {
  status?: (code: number) => VercelNodeResponse;
  json?: (body: unknown) => void;
}

async function readJsonBody(req: VercelNodeRequest): Promise<Record<string, unknown>> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        const parsed = JSON.parse(req.body) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        throw new SyntaxError('Invalid JSON request body.');
      }
    }
    if (Buffer.isBuffer(req.body)) {
      const text = req.body.toString('utf8').trim();
      if (!text) return {};
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    }
    if (typeof req.body === 'object') {
      return req.body as Record<string, unknown>;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
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

export function createVerifyPaymentHandler(options?: {
  razorpayClientFactory?: RazorpayClientFactory;
}) {
  return async function handler(req: VercelNodeRequest, res: VercelNodeResponse) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.setHeader('Allow', 'POST, OPTIONS');
      sendJson(res, 204, {});
      return;
    }
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      sendJson(res, 405, {
        status: 405,
        success: false,
        verified: false,
        code: 'METHOD_NOT_ALLOWED',
        error: 'Method not allowed. Use POST /api/verify-payment.',
      });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, {
        status: 400,
        success: false,
        verified: false,
        code: 'INVALID_JSON',
        error: 'Invalid JSON request payload.',
      });
      return;
    }

    const result = await handleVerifyPaymentRequest({
      body,
      razorpayClientFactory: options?.razorpayClientFactory,
    });
    sendJson(res, result.status, result.body);
  };
}

export default createVerifyPaymentHandler();
