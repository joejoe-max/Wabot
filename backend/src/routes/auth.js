import { Router }  from "express";
import crypto       from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { signAccessToken }       from "../utils/jwt.js";
import { sendVerificationEmail } from "../lib/brevo.js";
import { env }       from "../config/env.js";
import {
  isStrongPassword, isValidEmail,
  normalizeEmail, sanitizeName
} from "../utils/validators.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimiter.js";

function generateVerificationToken() {
  /* 64 hex chars (32 bytes) */
  return crypto.randomBytes(32).toString("hex");
}

function sendResendThrottle(res) {
  return res.status(429).json({ error: "Too many resend requests. Please try again in a few minutes." });
}

const router = Router();

const PLAN_KEY_LIMITS = { free: 1, paid: 10 };

function isEmailTakenError(error) {
  const msg = error?.message?.toLowerCase() ?? "";
  return (
    error?.status === 409 ||
    error?.status === 422 ||
    error?.code === "23505" ||
    msg.includes("already registered") ||
    msg.includes("already exists") ||
    msg.includes("user already") ||
    msg.includes("duplicate key") ||
    msg.includes("users_email_key") ||
    msg.includes("email")
  );
}

/* ── POST /api/auth/signup ───────────────────────────────────── */
router.post("/signup", authLimiter, async (req, res) => {
  try {
    const { email, password, fullName } = req.body ?? {};
    const normalizedEmail = normalizeEmail(String(email ?? ""));

    if (!isValidEmail(normalizedEmail))
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (!isStrongPassword(String(password ?? "")))
      return res.status(400).json({ error: "Password must be 8+ chars with an uppercase letter and a number." });
    if (!String(fullName ?? "").trim())
      return res.status(400).json({ error: "Full name is required." });

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existingUserError) {
      console.error({ existingUserError }, "Signup email precheck failed");
      return res.status(500).json({ error: "Could not create account. Please try again." });
    }

    if (existingUser) {
      return res.status(409).json({ error: "Email already taken." });
    }

    /* Create user in Supabase Auth — password is stored and managed by Supabase.
       email_confirm: true skips Supabase's own email; we send our own via Brevo. */
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email:         normalizedEmail,
      password:      String(password),
      email_confirm: true,
    });

    if (authError) {
      if (isEmailTakenError(authError)) {
        return res.status(409).json({ error: "Email already taken." });
      }
      console.error({ authError }, "Auth createUser failed");
      return res.status(500).json({ error: authError.message || "Could not create account. Please try again." });
    }

    const authUser = authData.user;
    const verificationToken = crypto.randomBytes(32).toString("hex");

    /* Insert matching public profile row (id matches auth.users id) */
    const { error: dbError } = await supabase
      .from("users")
      .insert({
        id:                 authUser.id,
        email:              normalizedEmail,
        full_name:          sanitizeName(String(fullName)),
        email_verified:     false,
        plan_tier:          "free",
        verification_token: verificationToken,
      });

    if (dbError) {
      /* Roll back the Supabase Auth user to keep data consistent */
      await supabase.auth.admin.deleteUser(authUser.id).catch(() => {});
      if (isEmailTakenError(dbError)) {
        return res.status(409).json({ error: "Email already taken." });
      }
      console.error({ dbError }, "Profile insert failed");
      return res.status(500).json({ error: "Could not create account. Please try again." });
    }

    /* Send verification email via Brevo */
    const verifyUrl = `${env.appBaseUrl}/verify?token=${verificationToken}`;
    if (env.hasBrevo) {
      sendVerificationEmail(normalizedEmail, verifyUrl).catch((err) =>
        console.error({ err }, "Verification email failed")
      );
    } else {
      console.log(`[dev] Verify URL for ${normalizedEmail}: ${verifyUrl}`);
    }

    const responseMessage = env.hasBrevo
      ? "Account created! Check your email to verify before logging in."
      : "Account created! Email verification may not be available on this server right now. You can retry verification later or use the verification flow when configured.";
    return res.status(201).json({ message: responseMessage });
  } catch (err) {
    console.error({ err }, "Signup failed");
    return res.status(500).json({
      error: err?.message || "Could not create account. Please try again.",
    });
  }
});

/* ── POST /api/auth/resend-verification ─────────────────────── */
router.post("/resend-verification", authLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(String(req.body?.email ?? ""));
    if (!isValidEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });

    const { data: user } = await supabase
      .from("users")
      .select("id, email, email_verified")
      .eq("email", email)
      .maybeSingle();

    if (!user) return res.status(404).json({ error: "Email not found." });
    if (user.email_verified) return res.json({ message: "Email is already verified. You can log in." });

    const verificationToken = generateVerificationToken();

    const { error: updateErr } = await supabase
      .from("users")
      .update({ verification_token: verificationToken })
      .eq("id", user.id);

    if (updateErr) {
      console.error({ updateErr }, "[auth/resend-verification] could not update token");
      return res.status(500).json({ error: "Could not resend verification email. Please try again." });
    }

    if (!env.hasBrevo) {
      return res.status(503).json({
        error: "Email provider is not configured on this server. Please try again later."
      });
    }

    const verifyUrl = `${env.appBaseUrl}/verify?token=${verificationToken}`;
    await sendVerificationEmail(email, verifyUrl);

    return res.json({ message: "Verification email resent. Please check your inbox." });
  } catch (err) {
    console.error({ err }, "[auth/resend-verification] error");
    const msg = err?.message?.toLowerCase?.() ?? "";
    if (msg.includes("429")) return sendResendThrottle(res);
    return res.status(500).json({ error: "Could not resend verification email. Please try again." });
  }
});

/* ── GET /api/auth/verify?token=... ─────────────────────────── */
router.get("/verify", async (req, res) => {
  try {
    const token = String(req.query.token ?? "");
    if (token.length !== 64) return res.status(400).json({ error: "Invalid verification token." });

    const { data: user } = await supabase
      .from("users").select("id, email_verified").eq("verification_token", token).maybeSingle();

    if (!user) return res.status(400).json({ error: "Invalid or expired verification link." });
    if (user.email_verified) return res.json({ message: "Already verified. You can log in." });

    const { error } = await supabase
      .from("users")
      .update({ email_verified: true, verification_token: null })
      .eq("id", user.id);

    if (error) return res.status(500).json({ error: "Verification failed. Please try again." });
    return res.json({ message: "Email verified. You can now log in." });
  } catch {
    return res.status(500).json({ error: "Verification failed." });
  }
});

/* ── POST /api/auth/login ────────────────────────────────────── */
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    const normalizedEmail = normalizeEmail(String(email ?? ""));

    if (!isValidEmail(normalizedEmail) || typeof password !== "string")
      return res.status(400).json({ error: "Invalid credentials." });

    /* Verify credentials via Supabase Auth */
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email:    normalizedEmail,
      password: String(password),
    });

    if (authError || !authData?.user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    /* Fetch public profile */
    const { data: user } = await supabase
      .from("users")
      .select("id, email, full_name, email_verified, plan_tier")
      .eq("id", authData.user.id)
      .maybeSingle();

    if (!user) return res.status(401).json({ error: "Invalid email or password." });

    /* Unverified users can log in; gating is handled in the frontend.
       We still return emailVerified=false. */
    const token = signAccessToken({ sub: user.id, email: user.email, plan: user.plan_tier });
    return res.json({
      token,
      user: {
        id:            user.id,
        email:         user.email,
        fullName:      user.full_name,
        emailVerified: user.email_verified,
        planTier:      user.plan_tier,
      },
    });
  } catch (err) {
    console.error({ err }, "Login failed");
    return res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

/* ── GET /api/auth/me ────────────────────────────────────────── */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from("users")
      .select("id, email, full_name, email_verified, plan_tier, created_at, messages_this_month, billing_period_start")
      .eq("id", req.user.sub)
      .single();

    if (!user) return res.status(404).json({ error: "User not found." });
    return res.json({
      id:                  user.id,
      email:               user.email,
      fullName:            user.full_name,
      emailVerified:       user.email_verified,
      planTier:            user.plan_tier,
      createdAt:           user.created_at,
      messagesThisMonth:   user.messages_this_month,
      billingPeriodStart:  user.billing_period_start,
      isSuperAdmin:        user.email?.toLowerCase() === env.superadminEmail?.toLowerCase() && Boolean(env.superadminEmail),
    });
  } catch {
    return res.status(500).json({ error: "Could not fetch user." });
  }
});

/* ── PATCH /api/auth/me ──────────────────────────────────────── */
router.patch("/me", requireAuth, async (req, res) => {
  try {
    const { fullName } = req.body ?? {};
    if (!String(fullName ?? "").trim())
      return res.status(400).json({ error: "Name cannot be empty." });

    const { data: user, error } = await supabase
      .from("users")
      .update({ full_name: sanitizeName(String(fullName)) })
      .eq("id", req.user.sub)
      .select("id, email, full_name, email_verified, plan_tier")
      .single();

    if (error) return res.status(500).json({ error: "Could not update profile." });
    return res.json({
      id: user.id, email: user.email, fullName: user.full_name,
      emailVerified: user.email_verified, planTier: user.plan_tier,
    });
  } catch {
    return res.status(500).json({ error: "Could not update profile." });
  }
});

/* ── POST /api/auth/password ─────────────────────────────────── */
router.post("/password", requireAuth, authLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!isStrongPassword(String(newPassword ?? "")))
      return res.status(400).json({ error: "New password must be 8+ chars with uppercase and number." });

    /* Verify current password via Supabase Auth */
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email:    req.user.email,
      password: String(currentPassword ?? ""),
    });

    if (verifyError) return res.status(401).json({ error: "Current password is incorrect." });

    /* Update the password in Supabase Auth */
    const { error } = await supabase.auth.admin.updateUserById(req.user.sub, {
      password: String(newPassword),
    });

    if (error) return res.status(500).json({ error: "Could not update password." });
    return res.json({ message: "Password updated successfully." });
  } catch {
    return res.status(500).json({ error: "Could not update password." });
  }
});

/* ── GET /api/auth/apikeys ───────────────────────────────────── */
router.get("/apikeys", requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from("users").select("plan_tier").eq("id", req.user.sub).single();

    const { data: keys } = await supabase
      .from("api_keys")
      .select("id, name, key_prefix, last_used, created_at")
      .eq("user_id", req.user.sub)
      .order("created_at", { ascending: false });

    const plan    = user?.plan_tier ?? "free";
    const maxKeys = PLAN_KEY_LIMITS[plan] ?? 1;

    return res.json({
      keys:    keys ?? [],
      maxKeys,
      plan,
      rateLimits: {
        callsPerMinute:   plan === "paid" ? 300 : 30,
        messagesPerMonth: plan === "paid" ? 100_000 : 1_000,
      },
    });
  } catch {
    return res.status(500).json({ error: "Could not fetch API keys." });
  }
});

/* ── POST /api/auth/apikeys ──────────────────────────────────── */
router.post("/apikeys", requireAuth, async (req, res) => {
  try {
    const name = sanitizeName(String(req.body?.name ?? "").trim() || "My Key", 60);

    const [{ data: user }, { count }] = await Promise.all([
      supabase.from("users").select("plan_tier").eq("id", req.user.sub).single(),
      supabase.from("api_keys").select("*", { count: "exact", head: true }).eq("user_id", req.user.sub),
    ]);

    const plan    = user?.plan_tier ?? "free";
    const maxKeys = PLAN_KEY_LIMITS[plan] ?? 1;

    if ((count ?? 0) >= maxKeys) {
      return res.status(400).json({
        error: `${plan === "paid" ? "Pro" : "Free"} plan allows up to ${maxKeys} API key${maxKeys === 1 ? "" : "s"}.${plan !== "paid" ? " Upgrade to Pro for up to 10 keys." : ""}`,
      });
    }

    const rawKey    = `wbk_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash   = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 12);

    const { data: entry, error } = await supabase
      .from("api_keys")
      .insert({ user_id: req.user.sub, name, key_hash: keyHash, key_prefix: keyPrefix })
      .select("id, name, key_prefix, created_at")
      .single();

    if (error) return res.status(500).json({ error: "Could not create API key." });

    return res.status(201).json({
      key:   rawKey,
      entry: { id: entry.id, name: entry.name, key_prefix: entry.key_prefix, created_at: entry.created_at },
    });
  } catch {
    return res.status(500).json({ error: "Could not create API key." });
  }
});

/* ── POST /api/auth/apikeys/:keyId/rotate ─────────────────────── */
router.post("/apikeys/:keyId/rotate", requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from("api_keys")
      .select("id, name, user_id")
      .eq("id", req.params.keyId)
      .eq("user_id", req.user.sub)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: "API key not found." });

    const rawKey    = `wbk_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash   = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 12);

    const { data: updated, error } = await supabase
      .from("api_keys")
      .update({ key_hash: keyHash, key_prefix: keyPrefix, last_used: null })
      .eq("id", req.params.keyId)
      .eq("user_id", req.user.sub)
      .select("id, name, key_prefix, created_at")
      .single();

    if (error) return res.status(500).json({ error: "Could not rotate API key." });

    return res.json({ key: rawKey, entry: updated });
  } catch {
    return res.status(500).json({ error: "Could not rotate API key." });
  }
});

/* ── DELETE /api/auth/apikeys/:keyId ─────────────────────────── */
router.delete("/apikeys/:keyId", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("api_keys")
      .delete()
      .eq("id", req.params.keyId)
      .eq("user_id", req.user.sub);

    if (error) return res.status(500).json({ error: "Could not delete API key." });
    return res.status(204).send();
  } catch {
    return res.status(500).json({ error: "Could not delete API key." });
  }
});

export default router;
