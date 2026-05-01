import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { signAccessToken } from "../utils/jwt.js";
import { sendVerificationEmail } from "../lib/brevo.js";
import { env } from "../config/env.js";
import { isStrongPassword, isValidEmail, normalizeEmail, sanitizeName } from "../utils/validators.js";
import { requireAuth } from "../middleware/auth.js";

const authRouter = Router();

/* ── POST /api/auth/signup ───────────────────────────────────── */
authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, fullName } = req.body ?? {};
    const normalizedEmail = normalizeEmail(String(email ?? ""));

    if (!isValidEmail(normalizedEmail))
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (!isStrongPassword(String(password ?? "")))
      return res.status(400).json({ error: "Password must be 8+ chars with uppercase letters and a number." });

    const { data: existing } = await supabase
      .from("users").select("id").eq("email", normalizedEmail).maybeSingle();
    if (existing) return res.status(409).json({ error: "An account with this email already exists." });

    const [passwordHash, verificationToken] = await Promise.all([
      bcrypt.hash(String(password), 12),
      Promise.resolve(crypto.randomBytes(32).toString("hex"))
    ]);

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email:              normalizedEmail,
        password_hash:      passwordHash,
        full_name:          sanitizeName(String(fullName ?? "")),
        email_verified:     false,
        plan_tier:          "free",
        verification_token: verificationToken
      })
      .select("id,email").single();

    if (error) return res.status(500).json({ error: "Could not create account. Please try again." });

    const verifyUrl = `${env.appBaseUrl}/verify?token=${verificationToken}`;
    if (env.hasBrevo) {
      try { await sendVerificationEmail(user.email, verifyUrl); } catch {}
    } else {
      console.log(`[dev] Verification URL for ${user.email}: ${verifyUrl}`);
    }

    return res.status(201).json({ message: "Account created. Check your email to verify before logging in." });
  } catch {
    return res.status(500).json({ error: "Could not create account. Please try again." });
  }
});

/* ── GET /api/auth/verify?token=... ─────────────────────────── */
authRouter.get("/verify", async (req, res) => {
  try {
    const token = String(req.query.token ?? "");
    if (token.length < 20) return res.status(400).json({ error: "Missing or invalid verification token." });

    const { data: user, error: lookupErr } = await supabase
      .from("users").select("id,email_verified").eq("verification_token", token).maybeSingle();

    if (lookupErr || !user) return res.status(400).json({ error: "Invalid or expired verification link." });
    if (user.email_verified) return res.json({ message: "Already verified." });

    const { error } = await supabase
      .from("users")
      .update({ email_verified: true, verification_token: null, updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (error) return res.status(500).json({ error: "Could not verify account. Please try again." });
    return res.json({ message: "Email verified successfully. You can now log in." });
  } catch {
    return res.status(500).json({ error: "Could not verify account." });
  }
});

/* ── POST /api/auth/login ────────────────────────────────────── */
authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    const normalizedEmail = normalizeEmail(String(email ?? ""));

    if (!isValidEmail(normalizedEmail) || typeof password !== "string")
      return res.status(400).json({ error: "Invalid credentials." });

    const { data: user, error } = await supabase
      .from("users")
      .select("id,email,password_hash,full_name,email_verified,plan_tier")
      .eq("email", normalizedEmail).maybeSingle();

    if (error || !user) return res.status(401).json({ error: "Invalid email or password." });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password." });

    const token = signAccessToken({ sub: user.id, email: user.email, plan: user.plan_tier });
    return res.json({
      token,
      user: {
        id:            user.id,
        email:         user.email,
        fullName:      user.full_name,
        emailVerified: user.email_verified,
        planTier:      user.plan_tier
      }
    });
  } catch {
    return res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

/* ── GET /api/auth/me ────────────────────────────────────────── */
authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("id,email,full_name,email_verified,plan_tier,created_at")
      .eq("id", req.user.sub).single();

    if (error || !user) return res.status(404).json({ error: "User not found." });
    return res.json({
      id:            user.id,
      email:         user.email,
      fullName:      user.full_name,
      emailVerified: user.email_verified,
      planTier:      user.plan_tier,
      createdAt:     user.created_at
    });
  } catch {
    return res.status(500).json({ error: "Could not fetch user." });
  }
});

/* ── PATCH /api/auth/me ──────────────────────────────────────── */
authRouter.patch("/me", requireAuth, async (req, res) => {
  try {
    const { fullName } = req.body ?? {};
    if (!fullName || String(fullName).trim().length < 1)
      return res.status(400).json({ error: "Name cannot be empty." });

    const { data: user, error } = await supabase
      .from("users")
      .update({ full_name: sanitizeName(String(fullName)), updated_at: new Date().toISOString() })
      .eq("id", req.user.sub)
      .select("id,email,full_name,email_verified,plan_tier").single();

    if (error) return res.status(500).json({ error: "Could not update profile." });
    return res.json({
      id: user.id, email: user.email, fullName: user.full_name,
      emailVerified: user.email_verified, planTier: user.plan_tier
    });
  } catch {
    return res.status(500).json({ error: "Could not update profile." });
  }
});

/* ── POST /api/auth/password ─────────────────────────────────── */
authRouter.post("/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};

    if (!isStrongPassword(String(newPassword ?? "")))
      return res.status(400).json({ error: "New password must be 8+ chars with uppercase letters and a number." });

    const { data: user } = await supabase
      .from("users").select("password_hash").eq("id", req.user.sub).single();

    const valid = await bcrypt.compare(String(currentPassword ?? ""), user.password_hash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect." });

    const newHash = await bcrypt.hash(String(newPassword), 12);
    const { error } = await supabase
      .from("users")
      .update({ password_hash: newHash, updated_at: new Date().toISOString() })
      .eq("id", req.user.sub);

    if (error) return res.status(500).json({ error: "Could not update password." });
    return res.json({ message: "Password updated successfully." });
  } catch {
    return res.status(500).json({ error: "Could not update password." });
  }
});

/* ── GET /api/auth/apikeys ───────────────────────────────────── */
authRouter.get("/apikeys", requireAuth, async (req, res) => {
  const { data: user } = await supabase
    .from("users").select("settings").eq("id", req.user.sub).single();
  const keys = (user?.settings?.apiKeys ?? []).map(({ id, name, prefix, createdAt }) => ({ id, name, prefix, createdAt }));
  return res.json({ keys });
});

/* ── POST /api/auth/apikeys ──────────────────────────────────── */
authRouter.post("/apikeys", requireAuth, async (req, res) => {
  const name = String(req.body?.name ?? "").trim() || "My API Key";
  const rawKey = `wbk_${crypto.randomBytes(24).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const prefix = rawKey.slice(0, 12);
  const newEntry = { id: crypto.randomUUID(), name, prefix, keyHash, createdAt: new Date().toISOString() };

  const { data: user } = await supabase
    .from("users").select("settings").eq("id", req.user.sub).single();

  const existing = user?.settings?.apiKeys ?? [];
  if (existing.length >= 10)
    return res.status(400).json({ error: "Maximum of 10 API keys per account." });

  const { error } = await supabase
    .from("users")
    .update({ settings: { ...(user?.settings ?? {}), apiKeys: [...existing, newEntry] } })
    .eq("id", req.user.sub);

  if (error) {
    if (error.code === "42703")
      return res.status(422).json({ error: "The settings column is not in the database schema. Run the latest migration." });
    return res.status(500).json({ error: "Could not create API key." });
  }

  return res.status(201).json({ key: rawKey, entry: { id: newEntry.id, name, prefix, createdAt: newEntry.createdAt } });
});

/* ── DELETE /api/auth/apikeys/:keyId ─────────────────────────── */
authRouter.delete("/apikeys/:keyId", requireAuth, async (req, res) => {
  const { data: user } = await supabase
    .from("users").select("settings").eq("id", req.user.sub).single();

  const existing = user?.settings?.apiKeys ?? [];
  const filtered = existing.filter((k) => k.id !== req.params.keyId);
  if (filtered.length === existing.length)
    return res.status(404).json({ error: "API key not found." });

  await supabase.from("users")
    .update({ settings: { ...(user?.settings ?? {}), apiKeys: filtered } })
    .eq("id", req.user.sub);

  return res.status(204).send();
});

export default authRouter;
