# Sahithi Collections

Boutique storefront and full-stack email authentication web application for **Sahithi Collections** (*“Style That Celebrates You.”*), built with React, Vite, Tailwind CSS, Express, and native Node.js SQLite (`node:sqlite`).

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
