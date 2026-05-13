# Implementation Plan

[Overview]
Fix the onboarding/auth flow (verification email + login gating), harden signup/billing error handling, and improve docs/dashboard UX with responsive dark-mode styling.

This project already has Supabase-backed auth + a separate `verification_token` email flow (`backend/src/routes/auth.js`). Right now, login is blocked for unverified accounts (403), while the signup UI does not provide a “resend verification email” path and the signup email sending is best-effort (account creation can still fail, but the user gets a generic error). Billing updates exist via Paystack webhooks (`backend/src/routes/billing.js`), but the app needs stronger “billing guard” behavior so plan expiry/downgrade is clearly reflected in access and UX.

Scope is:
- Backend: fix verification mechanics, add explicit “resend verification email” endpoint, adjust login behavior to allow unverified users to log in (with gating UI/feature restrictions), and harden billing guards.
- Frontend: add a resend verification CTA and an unverified-login experience on the dashboard, update billing expiration/guard messaging, and improve docs styling (dark mode + responsive) without gradients.
- Codebase-wide: ensure error responses are consistent and actionable, and remove/avoid confusing UI states.

[Types]
Add/standardize API response shapes for verification resend and add a small “billing state” contract used by the frontend to decide what to show/enable.

Detailed type definitions (TypeScript-like contracts; runtime is JS):
- `POST /api/auth/resend-verification`
  - Request body:
    - `email` (string, required): user’s email.
  - Response success (200):
    - `message` (string): human-friendly status.
  - Response errors:
    - 400: invalid email
    - 404: email not found
    - 429: resend throttled (rate-limit)
    - 503: email provider not configured (optional if Brevo disabled)
- Frontend derived user state:
  - `user.emailVerified` boolean (already present)
  - `user.planTier` string `"free" | "paid"` (already present)
  - `billing.subscription.status` string (from `/api/billing/status`, already `active | past_due | canceled | ...`)

[Files]
Modify backend auth + add verification resend + tighten billing guard checks; update frontend Dashboard/UX; enhance docs page to use existing dark design system.

Detailed breakdown:
- New files:
  - `backend/src/routes/verification.js`: optional split if auth.js grows (otherwise implement inside `backend/src/routes/auth.js`)
  - `frontend/src/components/auth/ResendVerificationModal.jsx`: modal + resend action UI
  - `frontend/src/hooks/useVerificationResend.js`: client hook wrapping resend endpoint
- Existing files to modify:
  - `backend/src/routes/auth.js`
    - Add `POST /api/auth/resend-verification`
    - Adjust `POST /api/auth/login` behavior to allow login for unverified users (see “Changes”)
    - Ensure signup failure paths return consistent error codes/messages
    - Make email sending failure either (a) non-fatal with clear user guidance, or (b) fatal only for controlled cases (config missing), depending on agreed UX
  - `backend/src/routes/billing.js`
    - Add/ensure a billing “access gating” helper that determines whether Pro features are currently usable (active vs past_due vs canceled)
    - Ensure webhook paths update both `subscriptions.status` and `users.plan_tier` correctly for “expires”
  - `backend/src/middleware/auth.js` (if needed)
    - Optionally attach `emailVerified` and `plan` as already done; keep stable
  - `frontend/src/pages/Dashboard.jsx`
    - Add unverified verification modal trigger if `user.emailVerified === false`
    - Ensure dashboard routes remain accessible when unverified
  - `frontend/src/pages/dashboard/Overview.jsx`
    - Replace only-warning with an actionable CTA (or delegate to modal component)
  - `frontend/src/pages/dashboard/Billing.jsx`
    - Add clearer UI when billing is not active/past_due/canceled
    - If backend exposes subscription status, show it and disable Pro-only actions
  - `frontend/src/pages/Docs.jsx`
    - Remove gradient usage currently present in the hero/card area (it uses `background: linear-gradient(...)`)
    - Keep dark theme via CSS vars from `frontend/src/styles/globals.css`
    - Improve responsiveness (no fixed max widths that overflow, ensure code blocks wrap/scroll)
- Deleted files:
  - None (unless splitting `auth.js` requires removal; default is no deletions)

[Functions]
Add/modify functions for verification resend, login gating behavior, and billing access checks, and wrap them with consistent error handling.

Proposed function signatures and behavior:

1) `router.post("/resend-verification", authLimiter?, async (req, res) => {})` in `backend/src/routes/auth.js`
- Parameters: `req.body.email`
- Behavior:
  - Validate email format (use existing `normalizeEmail` + `isValidEmail`)
  - Look up user row by `users.email` and ensure it exists
  - Generate a new `verification_token` (64 hex chars)
  - Update `users.verification_token` in Supabase
  - If Brevo configured, call `sendVerificationEmail(email, verifyUrl)` and return success
  - If not configured, return 503 with a clear message (frontend can show instructions)
- Return:
  - 200 `{ message }`
- Error handling:
  - 400: invalid email
  - 404: user not found
  - 429: resend throttled (optional using `authLimiter` or a new limiter)
  - 503: email provider not configured
  - 500: generic “could not resend” with internal logging

2) Modify `router.post("/login", authLimiter, async (req, res) => {})`
- New behavior:
  - Authenticate user via Supabase (existing)
  - Load profile row
  - **Do NOT block** unverified users from receiving a token (change 403 → allow)
  - Still return `emailVerified: false` in the response payload
- Error handling remains consistent:
  - 401 invalid credentials
  - 500 server errors

3) Frontend: `ResendVerificationModal` component
- Props:
  - `open` (boolean)
  - `email` (string)
  - `onClose` (function)
  - `onResent` (function, optional)
- Behavior:
  - Call resend endpoint, show loading and errors
  - On success: show confirmation and close or stay open

4) Frontend: `useVerificationResend` hook
- Signature: `useVerificationResend()`
- Returns:
  - `resend(email): Promise<void>`
  - `loading`, `error`

5) Backend: billing access check helper (in `billing.js` or a shared util)
- Signature: `function canUsePro({ subscriptionStatus, planTier })`
- Behavior:
  - Pro features are usable only when `planTier === "paid"` AND subscription status is `active` (and optionally exclude `canceled`/`past_due` based on desired UX)
  - Return boolean and a reason code for frontend

[Changes]
Implement the following step-by-step changes across backend + frontend, then verify with API and UI checks.

Step-by-step implementation plan:
1. Backend: adjust login gating for unverified accounts
   - In `backend/src/routes/auth.js` inside `POST /auth/login`:
     - Remove the `403` return for `!user.email_verified`
     - Keep returning `emailVerified` and include `planTier`
   - Ensure `user.plan_tier` and `user.email_verified` are always fetched and included in the token payload.

2. Backend: add resend verification endpoint
   - In `backend/src/routes/auth.js`:
     - Add `POST /api/auth/resend-verification`
     - Validate input, find user row, generate new token, store it
     - Call `sendVerificationEmail` (Brevo) with URL `${env.appBaseUrl}/verify?token=...`
   - Add rate limiting by reusing `authLimiter` or adding a dedicated limiter if needed (no new infra assumption).

3. Backend: make signup email failures non-confusing (fix “account doesn’t create” vs “email doesn’t send”)
   - In `POST /api/auth/signup`:
     - Keep account creation rollback behavior for profile insert errors (already present)
     - Improve error mapping for known Supabase admin createUser errors (conflicts)
     - For email sending:
       - Keep as non-fatal but return a response that tells user to retry resend in case of email provider failure (frontend will handle)
       - If Brevo is not configured, don’t throw; just log and return a message indicating dev mode and/or instructions.
   - This ensures users never see “error creating account” when the only failure is email sending.

4. Backend: tighten billing “guarded access” behavior
   - In `backend/src/routes/billing.js`:
     - Ensure webhook handling consistently updates `users.plan_tier` for all relevant events:
       - `charge.success`: set paid
       - `invoice.payment_failed`: set free
       - `subscription.disable`: set free
       - `subscription.not_renew`: decide whether to downgrade immediately or at period end; current code downgrades never on not_renew (it keeps Pro until period end). Confirm desired behavior; use `current_period_end` if you want “until period end” gating.
   - Add helper `canUsePro()` to unify usage checks (later consumed by frontend or by Pro-only endpoints if you choose to expand server-side gating).

5. Frontend: create resend verification UX
   - Add `ResendVerificationModal` component.
   - In `frontend/src/pages/Dashboard.jsx`:
     - If `user.email_verified === false`, show the modal automatically (or show a persistent CTA on Overview)
     - Make sure dashboard still loads (since backend login no longer blocks).
   - In `frontend/src/pages/dashboard/Overview.jsx`:
     - Replace the passive warning with:
       - message + “Resend verification email” button (opens modal)
       - optional link to `/verify` if user has token already

6. Frontend: ensure Billing UI reflects actual subscription state
   - In `frontend/src/pages/dashboard/Billing.jsx`:
     - Use `sub.status` to disable Pro-only actions when subscription is not active (e.g., `past_due` or `canceled`).
     - Show “access until” if `sub.currentPeriodEnd` exists.
   - Add a clear “what to do” banner:
     - past_due: “Update payment on Paystack”
     - canceled: “Re-subscribe to regain Pro”

7. Frontend: fix docs page styling (dark-mode + responsive)
   - In `frontend/src/pages/Docs.jsx`:
     - Remove gradient backgrounds (currently present).
     - Replace with solid dark cards using CSS vars (`--card`, `--card2`, `--border`, etc).
     - Ensure hero section layout works on mobile (sticky header doesn’t overlap content).
   - Use existing `CodeBlock` style and ensure pre/code uses overflow-x auto (already mostly done).

8. Frontend/back-end consistency checks
   - Verify API errors are properly surfaced using `apiFetch`’s `ApiError(message,status)`.
   - Ensure resend verification errors (503/429/404) display correct messages in modal.
   - Verify no blank screens by running the dev server and manually testing routes.

[Tests]
Add unit/integration checks for auth verification resend and verify Pro gating behavior; run end-to-end smoke checks on the frontend.

- Unit tests to be written:
  - Backend: a test for `POST /api/auth/resend-verification`:
    - invalid email → 400
    - existing unverified user → 200 and token updated (mock Brevo or set `env.hasBrevo=false`)
- Integration tests needed:
  - Backend: login flow:
    - unverified user can log in and gets `emailVerified=false`
    - verified user logs in with `emailVerified=true`
  - Billing:
    - webhook event handling changes `users.plan_tier` as expected
- Test data requirements:
  - Use a Supabase test schema or seed a user row with:
    - `email_verified=false`
    - `verification_token` present
    - `plan_tier` free/paid scenarios
- Edge cases:
  - Resend called rapidly (rate limit)
  - Existing verification token already present (should rotate)
  - Brevo misconfigured (return 503 with actionable frontend message)
  - Signup with existing email (409)
- Performance considerations:
  - Resend endpoint does minimal DB updates + email send
  - Webhook processing should remain fast; avoid unnecessary extra queries
