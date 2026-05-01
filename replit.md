# WaBot — WhatsApp Bot SaaS Platform

## Overview
WaBot is a full SaaS platform for deploying and managing WhatsApp bots. Users sign up, verify email, deploy bots via QR code scan, and manage everything from a single dark-themed dashboard.

## Architecture

### Frontend (`frontend/`)
- **Stack**: React 18 + Vite 5, no UI library (custom CSS design system)
- **Port**: 5000 (dev server; proxies `/api` → backend:3000)
- **Design**: Flat dark theme — deep black background, solid purple (#a855f7) accents, no gradients. Inter font.
- **Routes**: `/` Landing, `/login`, `/signup`, `/verify`, `/dashboard`
- **Key files**:
  - `src/styles/globals.css` — complete flat design system (tokens, buttons, cards, modals, tables, toggles)
  - `src/context/AuthContext.jsx` — JWT auth state stored as `wabot_token` / `wabot_user`
  - `src/api/client.js` — `apiFetch()` wrapper with error class
  - `src/pages/Landing.jsx` — marketing page (hero, features, pricing, terminal mockup)
  - `src/pages/Login.jsx` / `Signup.jsx` — auth forms
  - `src/pages/Dashboard.jsx` — full app: Overview, My Bots, Logs, API Keys, Billing, Settings
  - `src/App.jsx` — lazy-loaded routes with auth guards

### Backend (`backend/`)
- **Stack**: Express.js (ESM), Node 20, port 3000
- **Key files**:
  - `src/config/env.js` — env vars (lenient in dev — warns but doesn't crash on missing secrets)
  - `src/routes/auth.js` — signup, login, verify, /me, PATCH /me, POST /password, GET/POST/DELETE /apikeys
  - `src/routes/bots.js` — dashboard, deploy, PATCH (webhook/auto-reply), GET QR, DELETE, simulate-message
  - `src/routes/billing.js` — Stripe checkout + webhook
  - `src/lib/supabase.js` — Supabase client (graceful placeholder when unconfigured)
  - `src/lib/stripe.js` — Stripe lazy-init (only errors when actually called)
  - `src/lib/brevo.js` — email sender (dev-mode logs URL to console when unconfigured)
  - `src/middleware/auth.js` — JWT Bearer requireAuth
  - `src/utils/jwt.js` — sign/verify access tokens (7d expiry, HS256)

## Dashboard Features
| Tab | Features |
|-----|----------|
| Overview | Stats grid (total bots, active, messages, slots), recent bots, activity feed |
| My Bots | Bot grid cards, deploy modal (name + description), configure modal (Info, Webhook, Auto-reply, QR Code tabs), delete |
| Logs | Full activity feed with per-bot filtering |
| API Keys | Generate `wbk_...` keys, copy, delete, up to 10 keys per account |
| Billing | Plan badge, upgrade to Pro, feature comparison table |
| Settings | Update name, change password |

## Bot Features (per bot)
- **Name + description** — editable
- **Webhook URL** — POST JSON events to your server on each message
- **Auto-reply** — toggle on/off, set message text
- **QR Code** — regenerate and scan to link WhatsApp number
- **Message count** — tracked per bot
- **Status** — awaiting_qr_scan / active / connected / disconnected

## Plan Tiers
| Feature | Free | Pro |
|---------|------|-----|
| Max bots | 2 | 100 |
| Dashboard, QR, Webhooks, Auto-reply, API Keys, Logs | ✓ | ✓ |
| Priority support | — | ✓ |
| Stripe billing | — | ✓ |

## Environment Variables
### Backend — see `backend/.env.example`
**Always required:**
- `JWT_SECRET` — long random string (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — from Supabase project settings

**Optional (dev), required in production:**
- `BREVO_API_KEY` + `BREVO_SENDER_EMAIL` — email verification (console-logged in dev if missing)
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_ID_GROWTH` — billing

**Auto-configured:**
- `PORT=3000`, `NODE_ENV`, `APP_BASE_URL`, `API_BASE_URL`, `ALLOWED_ORIGINS`

### Frontend — see `frontend/.env.example`
- `VITE_API_BASE_URL` — leave empty to use Vite proxy

## Development
```bash
# Terminal 1 — backend
cd backend && npm run dev   # port 3000

# Terminal 2 — frontend
cd frontend && npm run dev  # port 5000, /api proxied to :3000
```

## Production (Deployment)
- **Build**: `cd frontend && npm install && npm run build && cd ../backend && npm install`
- **Run**: `node backend/src/index.js`
- **Mode**: `NODE_ENV=production` → Express serves frontend static files from `frontend/dist` on port 5000
- **Target**: Autoscale

## Database (Supabase)
Run `backend/supabase/reset_schema.sql` in the Supabase SQL editor. Tables:
- `users` — accounts, verification, plan_tier, settings (JSONB for API keys)
- `subscriptions` — Stripe subscriptions
- `bots` — deployed bots (bot_name, status, qr_payload, description, webhook_url, auto_reply_message, auto_reply_enabled, messages_count, phone_number)
- `bot_activity` — audit log of events
