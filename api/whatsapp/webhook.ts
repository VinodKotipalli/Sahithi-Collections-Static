import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleWhatsAppWebhookGet,
  handleWhatsAppWebhookPost,
  type GeminiClientFactory,
} from '../../server/whatsapp-ai.ts';

export interface VercelNodeRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[]>;
}

export interface VercelNodeResponse extends ServerResponse {
  status?: (code: number) => VercelNodeResponse;
  json?: (body: unknown) => void;
  send?: (body: string) => void;
}

async function readRawAndJsonBody(
  req: VercelNodeRequest
): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      const obj = JSON.parse(req.body) as unknown;
      return {
        raw: req.body,
        parsed: obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {},
      };
    }
    if (Buffer.isBuffer(req.body)) {
      const raw = req.body.toString('utf8');
      const obj = raw.trim() ? (JSON.parse(raw) as unknown) : {};
      return {
        raw,
        parsed: obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {},
      };
    }
    if (typeof req.body === 'object') {
      const obj = req.body as Record<string, unknown>;
      return { raw: JSON.stringify(obj), parsed: obj };
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return { raw: '', parsed: {} };
  const obj = JSON.parse(raw) as unknown;
  return {
    raw,
    parsed: obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {},
  };
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

function parseQuery(req: VercelNodeRequest): Record<string, string | string[] | undefined> {
  if (req.query && Object.keys(req.query).length > 0) return req.query;
  const urlObj = new URL(req.url || '/api/whatsapp/webhook', 'http://localhost');
  const out: Record<string, string> = {};
  urlObj.searchParams.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export function createWhatsAppWebhookHandler(options?: {
  aiClientFactory?: GeminiClientFactory;
  fetchImpl?: typeof fetch;
}) {
  return async function handler(req: VercelNodeRequest, res: VercelNodeResponse) {
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      const result = handleWhatsAppWebhookGet({ query: parseQuery(req) });
      if (result.rawText !== undefined) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.statusCode = result.status;
        res.end(result.rawText);
        return;
      }
      sendJson(res, result.status, result.body);
      return;
    }

    if (method === 'POST') {
      let bodyData: { raw: string; parsed: Record<string, unknown> };
      try {
        bodyData = await readRawAndJsonBody(req);
      } catch {
        sendJson(res, 400, {
          status: 400,
          code: 'INVALID_JSON',
          error: 'Invalid JSON webhook payload.',
        });
        return;
      }

      const sigHeader = req.headers['x-hub-signature-256'];
      const signatureHeader = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

      const result = await handleWhatsAppWebhookPost({
        body: bodyData.parsed,
        rawBody: bodyData.raw,
        signatureHeader,
        aiClientFactory: options?.aiClientFactory,
        fetchImpl: options?.fetchImpl,
      });
      sendJson(res, result.status, result.body);
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, {
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
      error: 'Method not allowed. Use GET or POST /api/whatsapp/webhook.',
    });
  };
}

export default createWhatsAppWebhookHandler();
