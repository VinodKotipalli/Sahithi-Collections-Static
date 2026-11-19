import 'dotenv/config';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handlePlaceCodOrderRequest,
  verifyBearerFirebaseTokenFromHeader,
  type IdTokenVerifierFn,
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

export function createOrdersHandler(options?: {
  verifyIdToken?: IdTokenVerifierFn;
  store?: BoutiqueStore | null;
  requireDurablePersistence?: boolean;
}) {
  return async function handler(req: VercelNodeRequest, res: VercelNodeResponse) {
    const rawReqId = req.headers['x-vercel-id'] || req.headers['x-request-id'];
    const requestId =
      (Array.isArray(rawReqId) ? rawReqId[0] : rawReqId)?.trim() || crypto.randomUUID();

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.setHeader('Allow', 'POST, OPTIONS');
      sendJson(res, 204, {}, requestId);
      return;
    }
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      sendJson(
        res,
        405,
        {
          status: 405,
          code: 'METHOD_NOT_ALLOWED',
          error: 'Method not allowed. Use POST /api/orders.',
        },
        requestId
      );
      return;
    }

    const authResult = await verifyBearerFirebaseTokenFromHeader(
      req.headers.authorization,
      options?.verifyIdToken
    );
    if (!authResult.ok) {
      sendJson(
        res,
        authResult.status,
        {
          status: authResult.status,
          code: authResult.code,
          error: authResult.error,
        },
        requestId
      );
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(
        res,
        400,
        {
          status: 400,
          code: 'INVALID_JSON',
          error: 'Invalid JSON request payload.',
        },
        requestId
      );
      return;
    }

    const result = await handlePlaceCodOrderRequest({
      body,
      store: options?.store ?? null,
      customerUserId: authResult.uid,
      customerIdToken: authResult.rawToken,
      requireDurablePersistence: options?.requireDurablePersistence ?? true,
      requestId,
    });
    sendJson(res, result.status, result.body, requestId);
  };
}

export default createOrdersHandler();
