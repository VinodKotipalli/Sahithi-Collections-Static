# Sahithi Collections — Boutique Fashion Showcase & Authentication

**Tagline:** *Style That Celebrates You.*

A modern, responsive static fashion showcase website for **Sahithi Collections**, featuring curated editorial photography, a lazy-loaded decorative 3D rose-gold silk ribbon hero scene, coordinated Motion animations, category filtering, live search, sorting, product quick views, a localStorage wishlist, a lookbook lightbox, configurable WhatsApp enquiries, and **Supabase Auth** integration (Email/Password, Mobile SMS OTP, Google, and Apple sign-in).

> **Demo Catalog Notice:** All 12 initial product listings, descriptions, and INR prices in `src/config/products.ts` are **editable demo content** provided as a starting catalog for the boutique.

---

## Tech Stack

- **Framework:** React 19 + TypeScript + Vite
- **Styling:** Tailwind CSS v4 (`@tailwindcss/vite`)
- **Animations:** Motion for React (`motion/react`) with full `prefers-reduced-motion` support
- **3D Scene:** React Three Fiber + Three.js (isolated, lazy-loaded hero sculpture with WebGL & reduced-motion fallback)
- **Authentication:** `@supabase/supabase-js` (PKCE static-host auth) + `libphonenumber-js` (country-aware E.164 validation)
- **Icons:** Lucide React

---

## Getting Started

### Run locally
```bash
npm install
npm run dev
```
The local development server starts on port `3000`.

### Type-check and build for production
```bash
npm run lint
npm run build
```
The production static bundle is output to the `dist/` directory.

---

## Authentication Setup (Supabase Auth)

Without credentials, the authentication routes (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/callback`) render a **clearly labeled Preview State** where form switching and password visibility work, while live send/verify/sign-in/registration actions remain safely disabled.

### 1. Environment Variables
Copy `.env.example` to `.env` (never commit secrets) and populate:

```env
VITE_SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
VITE_SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"

VITE_AUTH_ENABLE_SMS_OTP="true"
VITE_AUTH_ENABLE_GOOGLE="true"
VITE_AUTH_ENABLE_APPLE="true"

VITE_AUTH_OTP_LENGTH="6"
VITE_AUTH_OTP_RESEND_SECONDS="60"
VITE_AUTH_OTP_EXPIRY_MINUTES="5"
VITE_AUTH_ALLOW_PHONE_SIGNUP="true"
VITE_AUTH_PASSWORD_MIN_LENGTH="8"
VITE_TURNSTILE_SITE_KEY=""
VITE_AUTH_ENABLE_WISHLIST_SYNC="false"
```

### 2. Email Authentication & Password Recovery
In **Supabase Dashboard → Authentication → Providers → Email**:
- Enable **Email** provider and **Confirm email** (recommended).
- Set password minimum length to match `VITE_AUTH_PASSWORD_MIN_LENGTH` (default `8`).
- Under **Authentication → URL Configuration**:
  - **Site URL:** `https://your-domain.com`
  - **Additional Redirect URLs:**
    - `https://your-domain.com/auth/callback`
    - `https://your-domain.com/reset-password`
    - `http://localhost:3000/auth/callback`
    - `http://localhost:3000/reset-password`

### 3. Mobile Number Authentication (SMS OTP)
In **Supabase Dashboard → Authentication → Providers → Phone**:
- Enable **Phone** provider and connect a supported SMS provider (e.g., **Twilio**, **MessageBird**, **Vonage**, or **Textlocal** — keep all SMS API keys/auth tokens inside Supabase Dashboard, never in frontend code).
- **OTP Settings:** Ensure Supabase OTP length (`6`), OTP expiry (`300s` = `5` minutes), and SMS resend interval (`60s`) match `VITE_AUTH_OTP_LENGTH`, `VITE_AUTH_OTP_EXPIRY_MINUTES`, and `VITE_AUTH_OTP_RESEND_SECONDS`.
- **New User Policy:** Match Supabase's phone signup setting with `VITE_AUTH_ALLOW_PHONE_SIGNUP`.
- **Country Support & Sender Registration:** The country selector defaults to **India (+91)** and supports US (+1), UK (+44), UAE (+971), Singapore (+65), Australia (+61), and Canada (+1) with `libphonenumber-js` E.164 validation.
  - **India DLT Compliance:** Sending transactional OTP SMS to Indian (+91) mobile numbers requires registering your Entity ID, Sender ID (Header), and approved OTP message template on a DLT portal (e.g., Jio/Airtel/Vilpower) and configuring the DLT Template ID in your SMS gateway (Twilio/MSG91).
- **SMS Costs & Testing:** SMS OTP messages incur per-segment carrier charges from your SMS gateway. For automated or QA testing without carrier charges, configure **Test Phone Numbers & OTPs** inside **Supabase Dashboard → Authentication → Providers → Phone → Test Phone Numbers**.
- **Abuse & Rate Protection:** Enable Supabase **Attack Protection** rate limits (SMS OTP rate limits, max verification attempts) and optionally set `VITE_TURNSTILE_SITE_KEY` with Cloudflare Turnstile enabled in Supabase.

### 4. Google & Apple Sign-In
- **Google:** Create an OAuth 2.0 Web Client in Google Cloud Console with Authorized Redirect URI `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`, enter Client ID & Secret in Supabase Dashboard → Providers → Google, and set `VITE_AUTH_ENABLE_GOOGLE="true"`.
- **Apple:** Create an Apple Services ID and Sign in with Apple key in Apple Developer Portal with callback `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`, configure in Supabase Dashboard → Providers → Apple, and set `VITE_AUTH_ENABLE_APPLE="true"`.

### 5. Optional Wishlist Cloud Sync
By default, wishlist items are stored in `localStorage` so guests and signed-in customers can save styles immediately. To sync saved items across devices for signed-in users, create a `wishlist_items` table (`user_id uuid`, `product_id text`) with Row Level Security (`auth.uid() = user_id`) and set `VITE_AUTH_ENABLE_WISHLIST_SYNC="true"`.

---

## Customizing Boutique Content

- **WhatsApp, Instagram, Email & Store Address:** Edit `SITE_CONFIG.contact` in `src/config/site.ts`.
- **Product Images & Prices:** Add images to `src/assets/images/`, register them in `src/config/media.ts`, and edit items in `src/config/products.ts`.
- **Collections & Lookbook:** Edit `src/config/collections.ts` and `src/config/lookbook.ts`.

---

## Deploying the Static Build & Direct Route Support

1. Run `npm run build` to output `dist/`.
2. Upload `dist/` to your static host:
   - **Netlify / Cloudflare Pages:** `public/_redirects` is included (`/* /index.html 200`) so `/login`, `/signup`, `/forgot-password`, `/reset-password`, and `/auth/callback` work when opened directly or refreshed.
   - **Vercel:** `vercel.json` is included with SPA rewrites to `/index.html`.
   - **Nginx / Custom Static Server:** Configure `try_files $uri $uri/ /index.html;`.
