import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWhatsAppStylistHandler } from '../api/whatsapp/stylist.ts';
import { createWhatsAppWebhookHandler } from '../api/whatsapp/webhook.ts';
import { createAuthApp } from '../server/app.ts';
import { DEFAULT_SITE_SETTINGS } from '../server/storefront-defaults.ts';
import type { GeminiClientFactory } from '../server/whatsapp-ai.ts';
import {
  buildWhatsAppChatUrl,
  formatWhatsAppDisplay,
  normalizeWhatsAppDigits,
  resolveBoutiqueEmail,
  resolveWhatsAppDigits,
} from '../src/config/site.ts';

function tempDbPath(prefix: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, 'test.db') };
}

test('Site configuration normalizes 8520899337 to +91 85208 99337 and resolves saivinodkotipalli2003@gmail.com', () => {
  assert.equal(DEFAULT_SITE_SETTINGS.contact.whatsappNumber, '918520899337');
  assert.equal(DEFAULT_SITE_SETTINGS.contact.email, 'saivinodkotipalli2003@gmail.com');

  assert.equal(normalizeWhatsAppDigits('8520899337'), '918520899337');
  assert.equal(normalizeWhatsAppDigits('+91 85208 99337'), '918520899337');
  assert.equal(formatWhatsAppDisplay('8520899337'), '+91 85208 99337');

  assert.equal(
    resolveWhatsAppDigits({
      whatsappNumber: '',
      instagramHandle: '',
      email: '',
      storeAddress: '',
      hoursNote: '',
    }),
    '918520899337'
  );
  assert.equal(
    resolveBoutiqueEmail({
      whatsappNumber: '',
      instagramHandle: '',
      email: '',
      storeAddress: '',
      hoursNote: '',
    }),
    'saivinodkotipalli2003@gmail.com'
  );

  const chatUrl = buildWhatsAppChatUrl('Need kurti styling help');
  assert.match(chatUrl, /^https:\/\/wa\.me\/918520899337\?text=/);
});

test('Express WhatsApp AI Stylist & Webhook endpoints use gemini-4-hydrogen, ground on live catalog, and propagate missing key errors', async () => {
  const { dir, dbPath } = tempDbPath('sahithi-wa-express-');
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const prevAccessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const prevPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const prevAppSecret = process.env.WHATSAPP_APP_SECRET;

  const observedModels: string[] = [];
  const dispatchedPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];

  const mockAiFactory: GeminiClientFactory = () => ({
    models: {
      async generateContent(params) {
        observedModels.push(params.model);
        return {
          text: JSON.stringify({
            reply:
              'For a sunny daytime look under ₹1,000, I recommend our Floral Cotton Kurti (₹699) paired with breathable ivory palazzos. Reach our concierge at +91 85208 99337 or saivinodkotipalli2003@gmail.com for custom sizing.',
            recommendedProductIds: ['sc-101', 'nonexistent-fake-id'],
            whatsappPrefill:
              'Hi Sahithi Collections, I would love styling help for Floral Cotton Kurti (Size M).',
          }),
        };
      },
    },
  });

  const mockGraphFetch: typeof fetch = async (input, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    dispatchedPayloads.push({
      url: String(input),
      body: JSON.parse(bodyText) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.test.123' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { app, db } = createAuthApp({
    dbPath,
    disableRateLimit: true,
    aiClientFactory: mockAiFactory,
    whatsappFetchImpl: mockGraphFetch,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Missing GEMINI_API_KEY propagates 503 explicitly
    delete process.env.GEMINI_API_KEY;
    const missingKeyRes = await fetch(`${baseUrl}/api/whatsapp/stylist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Suggest a festive kurti' }),
    });
    assert.equal(missingKeyRes.status, 503);
    const missingBody = (await missingKeyRes.json()) as { error?: string };
    assert.match(missingBody.error || '', /GEMINI_API_KEY/);

    // 2. Configured GEMINI_API_KEY returns catalog-grounded reply & wa.me/918520899337 link
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const stylistRes = await fetch(`${baseUrl}/api/whatsapp/stylist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Suggest a cotton kurti under 1000 INR',
        history: [{ role: 'user', text: 'Hi' }],
      }),
    });
    assert.equal(stylistRes.status, 200);
    const stylistBody = (await stylistRes.json()) as {
      ok: boolean;
      reply: string;
      recommendedProducts: Array<{ id: string; title: string }>;
      whatsappUrl: string;
      whatsappDisplay: string;
      boutiqueEmail: string;
    };
    assert.equal(stylistBody.ok, true);
    assert.deepEqual(observedModels, ['gemini-4-hydrogen']);
    assert.equal(stylistBody.whatsappDisplay, '+91 85208 99337');
    assert.equal(stylistBody.boutiqueEmail, 'saivinodkotipalli2003@gmail.com');
    assert.match(stylistBody.whatsappUrl, /^https:\/\/wa\.me\/918520899337\?text=/);
    // Only real catalog IDs survive filtering
    assert.equal(stylistBody.recommendedProducts.length, 1);
    assert.equal(stylistBody.recommendedProducts[0]?.id, 'sc-101');

    // 3. Meta WhatsApp Webhook GET verification
    process.env.WHATSAPP_VERIFY_TOKEN = 'sahithi_wa_verify_2026';
    const badVerifyRes = await fetch(
      `${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`
    );
    assert.equal(badVerifyRes.status, 403);

    const goodVerifyRes = await fetch(
      `${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=sahithi_wa_verify_2026&hub.challenge=987654`
    );
    assert.equal(goodVerifyRes.status, 200);
    assert.equal(await goodVerifyRes.text(), '987654');

    // 4. Meta WhatsApp Webhook POST validates signature and dispatches automated reply
    process.env.WHATSAPP_APP_SECRET = 'meta_app_secret_test';
    process.env.WHATSAPP_ACCESS_TOKEN = 'meta_access_token_test';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '1029384756';

    const webhookPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.inbound.1',
                    from: '919988776655',
                    text: { body: 'Need a cotton kurti for summer' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const rawWebhookJson = JSON.stringify(webhookPayload);
    const validSig =
      'sha256=' +
      crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(rawWebhookJson).digest('hex');

    const badSigRes = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=invalid',
      },
      body: rawWebhookJson,
    });
    assert.equal(badSigRes.status, 401);

    const webhookRes = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': validSig,
      },
      body: rawWebhookJson,
    });
    assert.equal(webhookRes.status, 200);
    const webhookBody = (await webhookRes.json()) as {
      ok: boolean;
      processed: number;
      replies: Array<{ to: string; dispatched: boolean; recommendedProductIds: string[] }>;
    };
    assert.equal(webhookBody.ok, true);
    assert.equal(webhookBody.processed, 1);
    assert.equal(webhookBody.replies[0]?.dispatched, true);
    assert.equal(webhookBody.replies[0]?.to, '919988776655');
    assert.deepEqual(webhookBody.replies[0]?.recommendedProductIds, ['sc-101']);
    assert.equal(dispatchedPayloads.length, 1);
    assert.match(dispatchedPayloads[0]?.url || '', /1029384756\/messages$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });

    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevVerifyToken === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = prevVerifyToken;
    if (prevAccessToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = prevAccessToken;
    if (prevPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = prevPhoneId;
    if (prevAppSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = prevAppSecret;
  }
});

test('Vercel serverless WhatsApp AI handlers (/api/whatsapp/stylist.ts & /api/whatsapp/webhook.ts) handle styling & webhook requests', async () => {
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const prevAppSecret = process.env.WHATSAPP_APP_SECRET;
  const prevAccessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  process.env.GEMINI_API_KEY = 'vercel-test-gemini-key';
  process.env.WHATSAPP_VERIFY_TOKEN = 'vercel_verify_token';
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_ACCESS_TOKEN;

  const mockAiFactory: GeminiClientFactory = () => ({
    models: {
      async generateContent() {
        return {
          text: JSON.stringify({
            reply:
              'Pair our Floral Cotton Kurti (₹699) with silver jhumkas for effortless daytime style.',
            recommendedProductIds: ['sc-101'],
            whatsappPrefill: 'Hello Sahithi Collections, please help me style Floral Cotton Kurti.',
          }),
        };
      },
    },
  });

  const stylistHandler = createWhatsAppStylistHandler({ aiClientFactory: mockAiFactory });
  const webhookHandler = createWhatsAppWebhookHandler({ aiClientFactory: mockAiFactory });

  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/whatsapp/stylist')) {
      void stylistHandler(req, res);
      return;
    }
    if (req.url?.startsWith('/api/whatsapp/webhook')) {
      void webhookHandler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const { port } = srv.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const stylistRes = await fetch(`${baseUrl}/api/whatsapp/stylist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Style Floral Cotton Kurti for college' }),
    });
    assert.equal(stylistRes.status, 200);
    const stylistBody = (await stylistRes.json()) as {
      ok: boolean;
      whatsappUrl: string;
      boutiqueEmail: string;
    };
    assert.equal(stylistBody.ok, true);
    assert.match(stylistBody.whatsappUrl, /^https:\/\/wa\.me\/918520899337\?text=/);
    assert.equal(stylistBody.boutiqueEmail, 'saivinodkotipalli2003@gmail.com');

    const verifyRes = await fetch(
      `${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vercel_verify_token&hub.challenge=challenge_ok`
    );
    assert.equal(verifyRes.status, 200);
    assert.equal(await verifyRes.text(), 'challenge_ok');

    const inboundRes = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '918520899337', message: 'Suggest casual kurti' }),
    });
    assert.equal(inboundRes.status, 200);
    const inboundBody = (await inboundRes.json()) as { ok: boolean; processed: number };
    assert.equal(inboundBody.ok, true);
    assert.equal(inboundBody.processed, 1);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevVerifyToken === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = prevVerifyToken;
    if (prevAppSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = prevAppSecret;
    if (prevAccessToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = prevAccessToken;
  }
});
