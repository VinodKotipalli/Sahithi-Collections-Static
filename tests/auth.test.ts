import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { createAuthApp } from '../server/app.ts';
import { listLegacyPhoneOnlyAccounts } from '../server/db.ts';
import type { EmailMessage, EmailSender } from '../server/providers.ts';

class CookieJar {
  private store = new Map<string, string>();

  updateFromResponse(res: Response) {
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [];

    for (const cookieStr of setCookies) {
      const [pair] = cookieStr.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (!val) {
        this.store.delete(name);
      } else {
        this.store.set(name, val);
      }
    }
  }

  getHeader(): string {
    return Array.from(this.store.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

function extractTokenFromEmail(htmlOrText: string): string {
  const match = htmlOrText.match(/[?&]token=([^"&\s<]+)/);
  assert.ok(match, 'Expected token query param in email payload');
  return decodeURIComponent(match[1]);
}

let server: http.Server;
let baseUrl = '';
let sentEmails: EmailMessage[] = [];
let appDb: NonNullable<ReturnType<typeof createAuthApp>['db']>;

before(async () => {
  const emailSpy: EmailSender = {
    isConfigured: () => true,
    sendEmail: async (msg) => {
      sentEmails.push(msg);
    },
  };

  // Start without any Twilio environment variables configured
  const created = createAuthApp({
    dbPath: ':memory:',
    emailSender: emailSpy,
    disableRateLimit: true,
    appBaseUrl: 'http://127.0.0.1:3000',
  });
  assert.ok(created.db, 'Expected SQLite db instance in test');
  appDb = created.db;

  server = http.createServer(created.app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function bootstrapSession(jar: CookieJar) {
  const res = await fetch(`${baseUrl}/api/auth/session`, {
    headers: jar.getHeader() ? { Cookie: jar.getHeader() } : undefined,
  });
  jar.updateFromResponse(res);
  return (await res.json()) as { csrfToken: string; authenticated: boolean; user: unknown };
}

async function apiPost(
  jar: CookieJar,
  path: string,
  body: unknown,
  csrfToken: string,
  extraHeaders: Record<string, string> = {}
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    ...extraHeaders,
  };
  const cookieHeader = jar.getHeader();
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  jar.updateFromResponse(res);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, json };
}

test('No mobile/SMS auth endpoints remain and capabilities report email-only configuration without Twilio env vars', async () => {
  const capRes = await fetch(`${baseUrl}/api/auth/capabilities`);
  assert.equal(capRes.status, 200);
  const caps = (await capRes.json()) as Record<string, unknown>;
  assert.equal(caps.emailDeliveryConfigured, true);
  assert.equal('smsDeliveryConfigured' in caps, false);

  const jar = new CookieJar();
  const { csrfToken } = await bootstrapSession(jar);

  const removedEndpoints = [
    '/api/auth/otp/send',
    '/api/auth/otp/verify',
    '/api/account/reauthenticate/otp',
    '/api/account/link-phone/send',
    '/api/account/link-phone/verify',
  ];

  for (const endpoint of removedEndpoints) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: jar.getHeader(),
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404, `Expected ${endpoint} to be removed (404)`);
  }
});

test('Protected profile rejects unauthenticated access and CSRF middleware blocks missing/cross-origin requests', async () => {
  const unauthRes = await fetch(`${baseUrl}/api/account/profile`);
  assert.equal(unauthRes.status, 401);

  const jar = new CookieJar();
  const { csrfToken } = await bootstrapSession(jar);

  const noCsrfRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jar.getHeader() },
    body: JSON.stringify({ email: 'a@b.com', password: 'Password123!' }),
  });
  assert.equal(noCsrfRes.status, 403);

  const badOrigin = await apiPost(
    jar,
    '/api/auth/login',
    { email: 'a@b.com', password: 'Password123!' },
    csrfToken,
    { Origin: 'https://evil.example' }
  );
  assert.equal(badOrigin.res.status, 403);
});

test('Email signup hashes password, requires verification before login, verifies once, logs in with HttpOnly cookie, and logs out', async () => {
  sentEmails = [];
  const jar = new CookieJar();
  let { csrfToken } = await bootstrapSession(jar);

  const email = 'ananya@example.com';
  const password = 'VelvetRose!2025';

  const signup = await apiPost(
    jar,
    '/api/auth/register',
    { fullName: 'Ananya Reddy', email, password },
    csrfToken
  );
  assert.equal(signup.res.status, 200);
  assert.equal(sentEmails.length, 1);

  // Password stored as bcrypt hash, never plaintext
  const dbUser = appDb
    .prepare(`SELECT password_hash, email_verified FROM users WHERE email = ?`)
    .get(email) as { password_hash: string; email_verified: number };
  assert.ok(dbUser.password_hash.startsWith('$2'));
  assert.notEqual(dbUser.password_hash, password);
  assert.equal(dbUser.email_verified, 0);

  // Cannot log in before email verification
  const preVerifyLogin = await apiPost(jar, '/api/auth/login', { email, password }, csrfToken);
  assert.equal(preVerifyLogin.res.status, 401);

  // Verify single-use email token
  const verifyToken = extractTokenFromEmail(sentEmails[0].text);
  const verifyRes = await apiPost(jar, '/api/auth/verify-email', { token: verifyToken }, csrfToken);
  assert.equal(verifyRes.res.status, 200);
  assert.equal(typeof verifyRes.json.csrfToken, 'string');
  csrfToken = verifyRes.json.csrfToken as string;

  // Verify HttpOnly session cookie was issued
  const setCookieList = verifyRes.res.headers.getSetCookie();
  assert.ok(setCookieList.some((c) => c.startsWith('sc_session=') && c.includes('HttpOnly')));

  // Reusing verification token fails
  const reuseRes = await apiPost(jar, '/api/auth/verify-email', { token: verifyToken }, csrfToken);
  assert.equal(reuseRes.res.status, 400);

  // Protected route succeeds when authenticated
  const profileRes = await fetch(`${baseUrl}/api/account/profile`, {
    headers: { Cookie: jar.getHeader() },
  });
  assert.equal(profileRes.status, 200);

  // Logout revokes session and blocks subsequent profile access
  const logoutRes = await apiPost(jar, '/api/auth/logout', {}, csrfToken);
  assert.equal(logoutRes.res.status, 200);
  const postLogoutProfile = await fetch(`${baseUrl}/api/account/profile`, {
    headers: jar.getHeader() ? { Cookie: jar.getHeader() } : undefined,
  });
  assert.equal(postLogoutProfile.status, 401);

  // Generic failure on wrong password matches non-existent user message
  const freshBoot = await bootstrapSession(jar);
  const badPass = await apiPost(
    jar,
    '/api/auth/login',
    { email, password: 'WrongPassword123' },
    freshBoot.csrfToken
  );
  const unknownUser = await apiPost(
    jar,
    '/api/auth/login',
    { email: 'nobody@example.com', password: 'WrongPassword123' },
    freshBoot.csrfToken
  );
  assert.equal(badPass.res.status, 401);
  assert.equal(unknownUser.res.status, 401);
  assert.equal(badPass.json.error, unknownUser.json.error);

  // Valid login works
  const goodLogin = await apiPost(jar, '/api/auth/login', { email, password }, freshBoot.csrfToken);
  assert.equal(goodLogin.res.status, 200);
});

test('Password reset is single-use, expiring, neutral, and revokes old sessions; email update requires password reauth and prevents account merging', async () => {
  sentEmails = [];

  // Create a second verified email account
  const jar2 = new CookieJar();
  const boot2 = await bootstrapSession(jar2);
  await apiPost(
    jar2,
    '/api/auth/register',
    { fullName: 'Kavya Rao', email: 'kavya@example.com', password: 'RoseOrganza!2025' },
    boot2.csrfToken
  );
  const kavyaVerifyToken = extractTokenFromEmail(sentEmails[0].text);
  const kavyaVerified = await apiPost(
    jar2,
    '/api/auth/verify-email',
    { token: kavyaVerifyToken },
    boot2.csrfToken
  );
  assert.equal(kavyaVerified.res.status, 200);
  const kavyaCsrf = kavyaVerified.json.csrfToken as string;

  // Stale reauth blocks updating email
  appDb.prepare(`UPDATE sessions SET last_reauth_at = ?`).run(Date.now() - 20 * 60 * 1000);
  const staleUpdate = await apiPost(
    jar2,
    '/api/account/link-email',
    { email: 'kavya.new@example.com' },
    kavyaCsrf
  );
  assert.equal(staleUpdate.res.status, 403);
  assert.equal(staleUpdate.json.code, 'REAUTH_REQUIRED');

  // Reauthenticate with current password
  const reauthOk = await apiPost(
    jar2,
    '/api/account/reauthenticate',
    { password: 'RoseOrganza!2025' },
    kavyaCsrf
  );
  assert.equal(reauthOk.res.status, 200);

  // Attempt to update to an email owned by ananya@example.com -> rejected (409, never merge!)
  const mergeBlocked = await apiPost(
    jar2,
    '/api/account/link-email',
    { email: 'ananya@example.com' },
    kavyaCsrf
  );
  assert.equal(mergeBlocked.res.status, 409);

  // Update to fresh unowned email -> verification link -> completes cleanly
  const linkFresh = await apiPost(
    jar2,
    '/api/account/link-email',
    { email: 'kavya.new@example.com' },
    kavyaCsrf
  );
  assert.equal(linkFresh.res.status, 200);
  const linkToken = extractTokenFromEmail(sentEmails[1].text);
  const linkConfirm = await apiPost(
    jar2,
    '/api/auth/verify-email',
    { token: linkToken },
    kavyaCsrf
  );
  assert.equal(linkConfirm.res.status, 200);

  // Password reset on ananya@example.com
  const resetJar = new CookieJar();
  const resetBoot = await bootstrapSession(resetJar);
  const forgotRes = await apiPost(
    resetJar,
    '/api/auth/forgot-password',
    { email: 'ananya@example.com' },
    resetBoot.csrfToken
  );
  assert.equal(forgotRes.res.status, 200);

  const unknownForgot = await apiPost(
    resetJar,
    '/api/auth/forgot-password',
    { email: 'nonexistent@example.com' },
    resetBoot.csrfToken
  );
  assert.equal(unknownForgot.res.status, 200);
  assert.equal(forgotRes.json.message, unknownForgot.json.message);

  const resetToken = extractTokenFromEmail(sentEmails[2].text);
  const doReset = await apiPost(
    resetJar,
    '/api/auth/reset-password',
    { token: resetToken, password: 'NewBoutiquePassword!99' },
    resetBoot.csrfToken
  );
  assert.equal(doReset.res.status, 200);

  const postResetCsrf = doReset.json.csrfToken as string;
  assert.equal(typeof postResetCsrf, 'string');

  // Reusing reset token fails
  const resetReuse = await apiPost(
    resetJar,
    '/api/auth/reset-password',
    { token: resetToken, password: 'AnotherPassword!99' },
    postResetCsrf
  );
  assert.equal(resetReuse.res.status, 400);

  // New password works for login
  const postResetBoot = await bootstrapSession(resetJar);
  const newPassLogin = await apiPost(
    resetJar,
    '/api/auth/login',
    { email: 'ananya@example.com', password: 'NewBoutiquePassword!99' },
    postResetBoot.csrfToken
  );
  assert.equal(newPassLogin.res.status, 200);
});

test('Legacy phone-only accounts are preserved intact (not deleted or auto-verified) and identified for migration', () => {
  const now = Date.now();
  appDb
    .prepare(
      `INSERT INTO users (id, full_name, email, email_verified, password_hash, phone_e164, phone_verified, created_at, updated_at)
       VALUES (?, ?, NULL, 0, NULL, ?, 1, ?, ?)`
    )
    .run('legacy-phone-user-1', 'Legacy Guest', '+919876543210', now, now);

  const legacyAccounts = listLegacyPhoneOnlyAccounts(appDb);
  assert.equal(legacyAccounts.length, 1);
  assert.equal(legacyAccounts[0].id, 'legacy-phone-user-1');
  assert.equal(legacyAccounts[0].full_name, 'Legacy Guest');

  const rawRow = appDb
    .prepare(`SELECT email, email_verified, phone_e164 FROM users WHERE id = ?`)
    .get('legacy-phone-user-1') as {
    email: string | null;
    email_verified: number;
    phone_e164: string | null;
  };
  assert.equal(rawRow.email, null);
  assert.equal(rawRow.email_verified, 0);
  assert.equal(rawRow.phone_e164, '+919876543210');
});

test('Reverse proxy X-Forwarded-Host + HTTPS Origin passes CSRF, issues SameSite=None; Secure cookies, supports signed guest CSRF without cookies, and returns JSON 400 on malformed JSON', async () => {
  const proxyApp = createAuthApp({
    dbPath: ':memory:',
    emailSender: {
      isConfigured: () => true,
      sendEmail: async () => {},
    },
    disableRateLimit: true,
    appBaseUrl: 'https://ais-dev-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app',
  });

  const proxyServer = http.createServer(proxyApp.app);
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = proxyServer.address();
  assert.ok(addr && typeof addr === 'object');
  const proxyUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const proxyHost = 'ais-dev-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app';
    const proxyOrigin = `https://${proxyHost}`;

    // 1. Bootstrap session simulating Nginx (X-Forwarded-Host set, X-Forwarded-Proto=http, HTTPS Origin)
    const sessionRes = await fetch(`${proxyUrl}/api/auth/session`, {
      headers: {
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'http',
        Origin: proxyOrigin,
      },
    });
    assert.equal(sessionRes.status, 200);
    const sessionCookies = sessionRes.headers.getSetCookie();
    assert.ok(
      sessionCookies.some((c) => c.includes('sc_csrf=') && c.includes('Secure') && c.includes('SameSite=None')),
      `Expected Secure SameSite=None cookie over HTTPS Origin, got: ${sessionCookies.join('; ')}`
    );
    const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };

    // 2. Register WITHOUT forwarding Cookie header (simulating cross-site iframe cookie block),
    //    but WITH signed X-CSRF-Token + X-Forwarded-Host + HTTPS Origin
    const regRes = await fetch(`${proxyUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'http',
        Origin: proxyOrigin,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        fullName: 'Meera Iyer',
        email: 'meera@example.com',
        password: 'SilkDupatta!2025',
        confirmPassword: 'SilkDupatta!2025',
      }),
    });
    assert.equal(regRes.status, 200);
    const regJson = (await regRes.json()) as { requestId?: string; message?: string };
    assert.ok(regJson.requestId);

    // 3. Mismatched confirmPassword / invalid input returns structured 400 JSON
    const badConfirmRes = await fetch(`${proxyUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': proxyHost,
        Origin: proxyOrigin,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        fullName: 'Meera Iyer',
        email: 'meera2@example.com',
        password: 'SilkDupatta!2025',
        confirmPassword: 'DifferentPassword!1',
      }),
    });
    assert.equal(badConfirmRes.status, 400);
    const badConfirmJson = (await badConfirmRes.json()) as { code?: string; requestId?: string };
    assert.equal(badConfirmJson.code, 'VALIDATION_ERROR');
    assert.ok(badConfirmJson.requestId);

    // 4. Malformed JSON payload returns structured 400 JSON (never HTML)
    const malformedRes = await fetch(`${proxyUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': proxyHost,
        Origin: proxyOrigin,
        'X-CSRF-Token': csrfToken,
      },
      body: '{"broken": ',
    });
    assert.equal(malformedRes.status, 400);
    const malformedJson = (await malformedRes.json()) as { code?: string; requestId?: string };
    assert.equal(malformedJson.code, 'INVALID_JSON');
    assert.ok(malformedJson.requestId);
  } finally {
    await new Promise<void>((resolve, reject) =>
      proxyServer.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('Email delivery failure retains pending unverified user, allows safe retry and resend cooldown, activates on verify, and preserves verified account on repeat signup', async () => {
  let shouldFailSend = true;
  const delivered: EmailMessage[] = [];
  const flakyApp = createAuthApp({
    dbPath: ':memory:',
    emailSender: {
      isConfigured: () => true,
      sendEmail: async (msg) => {
        if (shouldFailSend) {
          const err = new Error('Simulated SMTP transient failure');
          Object.assign(err, { code: 'ECONNECTION' });
          throw err;
        }
        delivered.push(msg);
      },
    },
    disableRateLimit: true,
    appBaseUrl: 'http://127.0.0.1:3000',
  });

  const flakyServer = http.createServer(flakyApp.app);
  await new Promise<void>((resolve) => flakyServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = flakyServer.address();
  assert.ok(addr && typeof addr === 'object');
  const flakyUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const bootRes = await fetch(`${flakyUrl}/api/auth/session`);
    const cookieStr = bootRes.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const { csrfToken } = (await bootRes.json()) as { csrfToken: string };

    // 1. Initial signup fails SMTP delivery -> returns 500 JSON EMAIL_DELIVERY_FAILED with requestId
    const failReg = await fetch(`${flakyUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieStr,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        fullName: 'Diya Sharma',
        email: 'diya@example.com',
        password: 'RoseGold!2025',
        confirmPassword: 'RoseGold!2025',
      }),
    });
    assert.equal(failReg.status, 500);
    const failJson = (await failReg.json()) as { code?: string; requestId?: string };
    assert.equal(failJson.code, 'EMAIL_DELIVERY_FAILED');
    assert.ok(failJson.requestId);

    // Pending account exists (`email_verified = 0`), unsent token removed
    assert.ok(flakyApp.db);
    const pendingRow = flakyApp.db
      .prepare(`SELECT id, email_verified, password_hash FROM users WHERE email = ?`)
      .get('diya@example.com') as { id: string; email_verified: number; password_hash: string };
    assert.equal(pendingRow.email_verified, 0);
    const unsentTokens = flakyApp.db
      .prepare(`SELECT COUNT(*) AS cnt FROM email_tokens WHERE user_id = ?`)
      .get(pendingRow.id) as { cnt: number };
    assert.equal(unsentTokens.cnt, 0);

    // 2. Restore SMTP and retry via /api/auth/resend-verification -> succeeds
    shouldFailSend = false;
    const resendOk = await fetch(`${flakyUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieStr,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ email: 'diya@example.com' }),
    });
    assert.equal(resendOk.status, 200);
    assert.equal(delivered.length, 1);

    // Immediate second resend hits 60s cooldown (429)
    const resendTooSoon = await fetch(`${flakyUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieStr,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ email: 'diya@example.com' }),
    });
    assert.equal(resendTooSoon.status, 429);

    // 3. Verify token activates user and allows login
    const token = extractTokenFromEmail(delivered[0].text);
    const verifyRes = await fetch(`${flakyUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieStr,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(verifyRes.status, 200);

    // 4. Repeat signup with verified email does NOT overwrite password or duplicate user
    const originalHash = (
      flakyApp.db
        .prepare(`SELECT password_hash FROM users WHERE email = ?`)
        .get('diya@example.com') as { password_hash: string }
    ).password_hash;

    const repeatReg = await fetch(`${flakyUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieStr,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        fullName: 'Attacker Name',
        email: 'diya@example.com',
        password: 'HijackPassword!99',
        confirmPassword: 'HijackPassword!99',
      }),
    });
    assert.equal(repeatReg.status, 200);
    const afterHash = (
      flakyApp.db
        .prepare(`SELECT password_hash FROM users WHERE email = ?`)
        .get('diya@example.com') as { password_hash: string }
    ).password_hash;
    assert.equal(afterHash, originalHash);
    assert.equal(delivered.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      flakyServer.close((err) => (err ? reject(err) : resolve()))
    );
  }
});

test('resolveSmtpConfig parses SMTP_SECURE variants and port fallback accurately', async () => {
  const { resolveSmtpConfig } = await import('../server/providers.ts');
  const prev = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_FROM: process.env.SMTP_FROM,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
  };

  try {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'hello@example.com';

    process.env.SMTP_PORT = '587';
    process.env.SMTP_SECURE = 'true';
    assert.equal(resolveSmtpConfig().secure, true);

    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'false';
    assert.equal(resolveSmtpConfig().secure, false);

    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = '';
    assert.equal(resolveSmtpConfig().secure, true);

    process.env.SMTP_PORT = 'invalid';
    process.env.SMTP_SECURE = '';
    const fallbackCfg = resolveSmtpConfig();
    assert.equal(fallbackCfg.port, 587);
    assert.equal(fallbackCfg.secure, false);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Rate limiter runs cleanly with X-Forwarded-For proxy headers without ERR_ERL_PERMISSIVE_TRUST_PROXY', async () => {
  const rateLimitedApp = createAuthApp({
    dbPath: ':memory:',
    emailSender: {
      isConfigured: () => true,
      sendEmail: async () => {},
    },
    disableRateLimit: false,
    appBaseUrl: 'https://ais-dev-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app',
  });

  const srv = http.createServer(rateLimitedApp.app);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  assert.ok(addr && typeof addr === 'object');
  const url = `http://127.0.0.1:${addr.port}`;

  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '));
  };

  try {
    const proxyHost = 'ais-dev-he6gvzowfyhzbcmqd65c7h-837140640323.asia-east1.run.app';
    const sessionRes = await fetch(`${url}/api/auth/session`, {
      headers: {
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-For': '203.0.113.10, 10.0.0.1',
        Origin: `https://${proxyHost}`,
      },
    });
    assert.equal(sessionRes.status, 200);
    const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };

    const regRes = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-For': '203.0.113.10, 10.0.0.1',
        Origin: `https://${proxyHost}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        fullName: 'Aarav Patel',
        email: 'aarav@example.com',
        password: 'VelvetSilk!2025',
        confirmPassword: 'VelvetSilk!2025',
      }),
    });
    assert.equal(regRes.status, 200);
    assert.ok(
      !errors.some((line) => line.includes('ERR_ERL_PERMISSIVE_TRUST_PROXY') || line.includes('ValidationError')),
      `Unexpected rate-limit validation error: ${errors.join('\n')}`
    );
  } finally {
    console.error = originalConsoleError;
    await new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  }
});

test('All auth endpoints respond with JSON and unmatched /api routes or wrong HTTP methods return 404 API_ROUTE_NOT_FOUND JSON instead of HTML', async () => {
  const sessionRes = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(sessionRes.status, 200);
  assert.match(sessionRes.headers.get('content-type') || '', /application\/json/i);
  const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };
  const cookies = sessionRes.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  // 1. Invalid credentials on POST /api/auth/login -> 401 INVALID_CREDENTIALS JSON (never 404)
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'WrongPassword!123' }),
  });
  assert.equal(badLogin.status, 401);
  assert.match(badLogin.headers.get('content-type') || '', /application\/json/i);
  const badLoginJson = (await badLogin.json()) as { code?: string };
  assert.equal(badLoginJson.code, 'INVALID_CREDENTIALS');

  // 2. Wrong HTTP method (GET /api/auth/login, GET /api/admin/login) -> 404 API_ROUTE_NOT_FOUND JSON (never HTML fallback)
  for (const wrongPath of ['/api/auth/login', '/api/admin/login', '/api/auth/nonexistent']) {
    const res = await fetch(`${baseUrl}${wrongPath}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 404, `Expected 404 for GET ${wrongPath}`);
    assert.match(res.headers.get('content-type') || '', /application\/json/i);
    const body = (await res.json()) as { code?: string; requestId?: string };
    assert.equal(body.code, 'API_ROUTE_NOT_FOUND');
    assert.ok(body.requestId);
  }

  // 3. Unmatched POST /api/auth/unknown -> 404 API_ROUTE_NOT_FOUND JSON
  const unknownPost = await fetch(`${baseUrl}/api/auth/unknown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({}),
  });
  assert.equal(unknownPost.status, 404);
  assert.match(unknownPost.headers.get('content-type') || '', /application\/json/i);
  const unknownPostJson = (await unknownPost.json()) as { code?: string; requestId?: string };
  assert.equal(unknownPostJson.code, 'API_ROUTE_NOT_FOUND');
  assert.ok(unknownPostJson.requestId);
});
