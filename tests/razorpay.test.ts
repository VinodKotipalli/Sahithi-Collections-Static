import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthApp } from '../server/app.ts';

test('Razorpay Standard Checkout endpoints: create-order validation/auth and verify-payment HMAC-SHA256 verification', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahithi-razorpay-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;

  const { app } = createAuthApp({
    dbPath,
    disableRateLimit: true,
    seedCatalog: true,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Missing credentials -> 401
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const noAuthRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 69900, currency: 'INR', receipt: 'rcpt_1' }),
    });
    assert.equal(noAuthRes.status, 401);

    // 2. Configure test credentials and validate amount >= 100 paise
    process.env.RAZORPAY_KEY_ID = 'rzp_test_U17MiWPrvpas0b';
    process.env.RAZORPAY_KEY_SECRET = 'Oroq81QnfslWBN9z3bsXYOf5';

    const lowAmountRes = await fetch(`${baseUrl}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 50, currency: 'INR', receipt: 'rcpt_low' }),
    });
    assert.equal(lowAmountRes.status, 400);
    const lowAmountBody = (await lowAmountRes.json()) as { code?: string };
    assert.equal(lowAmountBody.code, 'INVALID_AMOUNT');

    // 3. Verify payment: missing fields -> 400
    const missingFieldsRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ razorpay_order_id: 'order_test123' }),
    });
    assert.equal(missingFieldsRes.status, 400);
    const missingFieldsBody = (await missingFieldsRes.json()) as {
      success?: boolean;
      code?: string;
    };
    assert.equal(missingFieldsBody.success, false);
    assert.equal(missingFieldsBody.code, 'MISSING_FIELDS');

    // 4. Verify payment: invalid signature -> 400 and does NOT record order
    const invalidSigRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: 'order_test123',
        razorpay_payment_id: 'pay_test456',
        razorpay_signature: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
    });
    assert.equal(invalidSigRes.status, 400);
    const invalidSigBody = (await invalidSigRes.json()) as {
      success?: boolean;
      verified?: boolean;
      code?: string;
    };
    assert.equal(invalidSigBody.success, false);
    assert.equal(invalidSigBody.verified, false);
    assert.equal(invalidSigBody.code, 'INVALID_SIGNATURE');

    // 5. Verify payment: valid HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET) -> 200 success
    const orderId = 'order_test_valid_999';
    const paymentId = 'pay_test_valid_888';
    const validSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const validSigRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: validSignature,
      }),
    });
    assert.equal(validSigRes.status, 200);
    const validSigBody = (await validSigRes.json()) as {
      success?: boolean;
      verified?: boolean;
      order_id?: string;
      payment_id?: string;
    };
    assert.equal(validSigBody.success, true);
    assert.equal(validSigBody.verified, true);
    assert.equal(validSigBody.order_id, orderId);
    assert.equal(validSigBody.payment_id, paymentId);
  } finally {
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
