# Sahithi Collections

Boutique storefront and full-stack email authentication web application for **Sahithi Collections** (*“Style That Celebrates You.”*), built with React, Vite, Tailwind CSS, Express, and native Node.js SQLite (`node:sqlite`).

## Vercel static deployment (sahithidesigns.online)

Vercel serves the Vite `dist` directory; it does **not** start `server.ts`.
Use the checked-in `vercel.json`: it installs with `npm ci`, runs
`npm run build:static`, and rewrites page routes to `index.html`. API and
asset paths are excluded from the page rewrite.

The static build selects the existing Firebase Auth / Firestore browser adapter
before any API request is sent. Login, session refresh, owner/admin operations,
logout, and storefront reads use this same transport. It does not send passwords
to missing same-origin Express endpoints. The regular `npm run build` retains
the Express transport for full-stack deployments.

Firebase remains responsible for authentication and Firestore rules remain
responsible for data authorization. Keep Email/Password enabled, the actual
website domain authorized in Firebase Authentication, and the project's
`firestore.rules` deployed to the configured Firestore database. No service-account
key, admin password, or SMTP secret belongs in the frontend. This change does not
create accounts, verify emails, or grant admin privileges.

### Apply this fix

1. Commit the fixed source to the GitHub branch connected to the existing Vercel
   project. Keep the Vercel project root at this repository root.
2. In Vercel, use the repository settings: build command `npm run build:static`,
   output directory `dist`, install command `npm ci`. Remove conflicting project
   overrides if any. Deploy the new commit (redeploying an old commit won't apply
   the fix).
3. Open `/login` and `/admin/login` directly, then refresh each page. Check login
   with your existing verified account and sign out. In browser Network tools,
   static auth should call Firebase rather than `/api/auth/login` on this domain.
4. Verify an admin change persists after refresh. If Firebase returns a provider
   or permission error, inspect that error and the deployed Firebase configuration;
   do not disable verification or relax Firestore rules to work around it.

Validation commands: `npm test`, `npm run lint`, `npm run build:static`.
The transport tests cover single dispatch, provider error preservation, uploads,
static session/admin/storefront/logout routing, and unchanged server fetch options.
A successful build and mocked tests do not establish a successful live owner login;
that requires deployment and the owner's normal sign-in.

---

## Key Features

- **Public Fashion Storefront**: Collections showcase, category filters, search, sorting, Lookbook gallery + lightbox, quick-view product details, Three.js hero ribbon visual, and persistent browser-local wishlist (`localStorage`).
- **Email Authentication (`/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password`)**:
  - Registration with Full Name, Email, Password, and Confirm Password (`bcryptjs` cost 12 hashing).
  - Mandatory single-use, expiring (24h) email ownership verification before login.
  - Expiring (30m), single-use password recovery flow that revokes prior active sessions.
- **Protected Account Dashboard (`/account`)**:
  - Manage profile display name and view verified email status.
  - Enforces recent password reauthentication (within 10 minutes) before updating passwords or updating your verified email address.
  - Never auto-merges separate accounts when matching email addresses are entered.
- **Session & Request Security**:
  - `HttpOnly`, `SameSite=Lax` (and `Secure` over HTTPS) session cookies backed by SHA-256 hashed server session records.
  - Per-session `X-CSRF-Token` validation + same-origin check + `helmet` + `express-rate-limit`.

---

## Setup & Environment Variables

Copy `.env.example` to `.env` (never commit `.env`):

```bash
cp .env.example .env
```

| Variable | Purpose | Where to Obtain |
| --- | --- | --- |
| `APP_URL` | Public origin URL used in verification and reset links | Set automatically by Cloud Run / AI Studio, or `http://localhost:3000` locally |
| `AUTH_DB_PATH` | Path to persistent SQLite auth database (default `./data/sahithi_auth.db`) | Local persistent disk path |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outgoing transactional email for verification & password resets (server-only) | Resend, Postmark, Amazon SES, SendGrid, or Google Workspace SMTP credentials |

### Legacy Phone-Only Accounts

- Existing database records created prior to removing mobile authentication (rows with `phone_e164` and `email IS NULL` or `email_verified = 0`) are **preserved intact** and are never deleted, auto-verified, or merged.
- Use `listLegacyPhoneOnlyAccounts(db)` in `server/db.ts` to audit any phone-only accounts that require an administrator-assisted or verified-email migration flow.
- Boutique WhatsApp enquiry settings in `src/config/site.ts` remain strictly for customer product enquiries and are not used for authentication.

---

## Local Development, Testing, and Production

```bash
# Install dependencies
npm install

# Run full-stack development server (Express API + Vite middleware on port 3000)
npm run dev

# Run automated authentication security & flow tests
node --test tests/auth.test.ts

# Typecheck and build frontend bundle
npm run lint
npm run build

# Start production server
NODE_ENV=production npm start
```
