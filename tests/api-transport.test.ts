import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiTransport } from '../src/services/apiTransportCore.ts';

const missingServer: typeof fetch = async () => {
  assert.fail('Static builds must not contact missing same-origin API routes');
};

test('static login sends credentials once to the Firebase adapter, without an API probe', async () => {
  const calls: unknown[] = [];
  const transport = createApiTransport('firebase', async (...args) => {
    calls.push(args);
    return { ok: true, data: { user: { id: 'verified-user' } } };
  }, missingServer);
  const body = JSON.stringify({ email: 'test@example.com', password: 'test-only' });
  const response = await transport('/api/auth/login', { method: 'POST', body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: { id: 'verified-user' } });
  assert.deepEqual(calls, [['/api/auth/login', 'POST', body]]);
});

test('static session, capabilities, admin, storefront and logout use the same provider', async () => {
  const calls: unknown[] = [];
  const transport = createApiTransport('firebase', async (...args) => {
    calls.push(args);
    return { ok: true, data: { message: 'ok' } };
  }, missingServer);
  const paths = ['/api/auth/session', '/api/auth/capabilities?refresh=1', '/api/admin/session', '/api/storefront', '/api/products'];
  for (const path of paths) assert.equal((await transport(path)).status, 200);
  await transport('/api/auth/logout', { method: 'POST' });
  assert.deepEqual(calls, [...paths.map(path => [path, 'GET', undefined]), ['/api/auth/logout', 'POST', undefined]]);
});

test('provider failures retain status, code, message and extra error details', async () => {
  for (const failure of [
    { ok: false as const, status: 401, code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' },
    { ok: false as const, status: 403, code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email.' },
    { ok: false as const, status: 404, code: 'PRODUCT_NOT_FOUND', error: 'Product not found.' },
    { ok: false as const, status: 429, code: 'RATE_LIMITED', error: 'Wait before retrying.', retryAfterSeconds: 60 },
  ]) {
    let calls = 0;
    const transport = createApiTransport('firebase', async () => { calls++; return failure; }, missingServer);
    const response = await transport('/api/auth/login', { method: 'POST' });
    assert.equal(response.status, failure.status);
    assert.deepEqual(await response.json(), failure);
    assert.equal(calls, 1);
  }
});

test('multipart admin uploads are passed through intact', async () => {
  const body = new FormData();
  body.set('file', new Blob(['image-data']), 'test.png');
  const transport = createApiTransport('firebase', async (_path, _method, received) => {
    assert.equal(received, body);
    return { ok: true, data: { uploaded: true } };
  }, missingServer);
  assert.equal((await transport('/api/admin/uploads', { method: 'POST', body })).status, 200);
});

test('server deployments preserve fetch, CSRF headers and cookie options', async () => {
  const options = { method: 'POST', credentials: 'include' as const, headers: { 'X-CSRF-Token': 'test-token' }, body: '{}' };
  const expected = new Response('{"code":"CSRF_INVALID"}', { status: 403 });
  const transport = createApiTransport('server', async () => assert.fail('Unexpected provider switch'), async (path, received) => {
    assert.equal(path, '/api/auth/login');
    assert.equal(received, options);
    return expected;
  });
  assert.equal(await transport('/api/auth/login', options), expected);
});

test('static transport rejects unrelated URLs before calling the adapter', async () => {
  const transport = createApiTransport('firebase', async () => assert.fail('Unexpected adapter call'), missingServer);
  await assert.rejects(() => transport('https://example.com/api/auth/login'), /relative/);
});
