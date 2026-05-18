/**
 * /api/bots — Bot management routes
 * All routes require authentication via JWT or API key.
 */

import { Router }        from "express";
import { supabase }      from "../lib/supabase.js";
import { requireAuth }   from "../middleware/auth.js";
import { deployLimiter } from "../middleware/rateLimiter.js";
import { botManager }    from "../services/whatsapp/BotManager.js";
import { dashboardRealtime } from "../services/realtime/DashboardRealtime.js";
import { AI_PROVIDERS, encryptApiKey } from "../services/ai/AiService.js";
import { env }           from "../config/env.js";

const router = Router();
router.use(requireAuth);

/* Free plan updated to 1 000 messages/month */
const PLAN_LIMITS = {
  free: { maxBots: 1,  maxMsgMonth: 1_000    },
  paid: { maxBots: 50, maxMsgMonth: 100_000  }
};

/* Allowed PATCH fields (strict whitelist) */
const TEXT_FIELDS = [
  "bot_name", "description",
  "webhook_url", "webhook_secret",
  "auto_reply_message",
  "website_url", "catalog_unavail_msg"
];
const BOOL_FIELDS = ["auto_reply_enabled"];
const JSON_FIELDS = ["keyword_triggers", "sales_agent_config", "commands_config", "group_management_config"];
const ALLOWED_AI_PROVIDERS = new Set(AI_PROVIDERS.map((provider) => provider.id));

/* ── Sanitise a bot name ─────────────────────────────────────── */
function validateBotName(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 64)
    return { error: "Bot name must be 2–64 characters." };
  if (!/^[\w\s\-]+$/.test(name))
    return { error: "Bot name may only contain letters, numbers, spaces, hyphens, and underscores." };
  return { name };
}

function normalizeSalesAgentConfig(input = {}) {
  const products = Array.isArray(input.products)
    ? input.products
        .map((item) => ({
          name: String(item?.name ?? "").trim().slice(0, 120),
          price: String(item?.price ?? "").trim().slice(0, 40),
          description: String(item?.description ?? "").trim().slice(0, 400),
        }))
        .filter((item) => item.name)
    : [];

  return {
    enabled: Boolean(input.enabled),
    welcome_enabled: Boolean(input.welcome_enabled),
    greeting: String(input.greeting ?? "").trim().slice(0, 1200),
    group_welcome: String(input.group_welcome ?? "").trim().slice(0, 1200),
    show_catalog_on_keyword: input.show_catalog_on_keyword !== false,
    products,
  };
}

function buildDirectMessagePayload(body = {}) {
  const preset = String(body.preset ?? "custom").trim().toLowerCase();
  if (preset === "otp") {
    const code = String(body.code ?? "").trim();
    if (!/^\d{4,10}$/.test(code)) {
      throw new Error("OTP code must be 4-10 digits.");
    }

    const appName = String(body.app_name ?? "verification").trim();
    const intro = String(body.intro ?? `Your ${appName} code is ready.`).trim();
    const expires = body.expires_in_minutes ? `\nExpires in ${Number(body.expires_in_minutes)} minute(s).` : "";
    const outro = String(body.outro ?? "").trim();
    return [intro, `OTP: ${code}${expires}`, outro].filter(Boolean).join("\n");
  }

  if (preset === "form") {
    const fields = body.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error("Form fields must be an object.");
    }

    const heading = String(body.heading ?? `New submission: ${String(body.form_name ?? "Form").trim() || "Form"}`).trim();
    const entries = Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
      .map(([key, value]) => `- ${key}: ${String(value).trim()}`);

    if (entries.length === 0) throw new Error("Form preset requires at least one non-empty field.");
    const footer = String(body.footer ?? "").trim();
    return [heading, ...entries, footer].filter(Boolean).join("\n");
  }

  if (preset === "welcome") {
    const name = String(body.name ?? "").trim();
    return String(body.message ?? "").trim() || (name
      ? `Welcome ${name}! We received your message and will reply shortly.`
      : "Welcome! We received your message and will reply shortly.");
  }

  return String(body.message ?? "").trim();
}

/* ── GET /api/bots/dashboard ─────────────────────────────────── */
router.get("/dashboard", async (req, res) => {
  const userId = req.user.sub;

  const [
    { data: user, error: uErr },
    { data: bots              },
    { data: activity          }
  ] = await Promise.all([
    supabase.from("users")
      .select("id, email, full_name, email_verified, plan_tier, created_at, messages_this_month, billing_period_start")
      .eq("id", userId).single(),
    supabase.from("bots")
      .select("id, bot_name, description, status, bot_type, messages_count, messages_this_month, auto_reply_enabled, webhook_url, keyword_triggers, sales_agent_config, commands_config, ai_config, group_management_config, website_url, catalog_unavail_msg, created_at, last_activity")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabase.from("bot_activity")
      .select("id, bot_id, event_type, details, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  if (uErr) return res.status(500).json({ error: "Could not load dashboard." });

  const plan    = user.plan_tier ?? "free";
  const limits  = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const botList = bots ?? [];

  /* Overlay live status + sanitise sensitive AI key from response */
  const botsWithLiveStatus = botList.map((b) => {
    const liveStatus = botManager.getStatus(b.id);
    const ai = b.ai_config ?? {};
    /* Never return encrypted key to frontend — replace with masked indicator */
    const safeAi = ai.encrypted_key
      ? { ...ai, encrypted_key: undefined, has_key: true }
      : ai;
    return {
      ...b,
      status:    liveStatus && liveStatus !== "unknown" ? liveStatus : b.status,
      ai_config: safeAi
    };
  });

  return res.json({
    user,
    bots:     botsWithLiveStatus,
    activity: activity ?? [],
    stats: {
      totalBots:     botList.length,
      activeBots:    botList.filter((b) => b.status === "connected").length,
      totalMessages: botList.reduce((s, b) => s + (b.messages_count || 0), 0),
      messagesMonth: user.messages_this_month ?? 0,
      planLimit:     limits.maxBots,
      msgLimit:      limits.maxMsgMonth
    }
  });
});

/* ── GET /api/bots/dashboard/events (SSE) ───────────────────── */
router.get("/dashboard/events", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "ready", at: new Date().toISOString() })}\n\n`);

  const pingInterval = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(pingInterval);
    }
  }, 20_000);

  dashboardRealtime.addClient(req.user.sub, res);

  req.on("close", () => {
    clearInterval(pingInterval);
    dashboardRealtime.removeClient(req.user.sub, res);
  });
});

/* ── POST /api/bots/deploy ───────────────────────────────────── */
router.post("/deploy", deployLimiter, async (req, res) => {
  const userId  = req.user.sub;
  const { error: nameErr, name: botName } = validateBotName(req.body?.botName);
  if (nameErr) return res.status(400).json({ error: nameErr });

  const desc    = String(req.body?.description ?? "").trim().slice(0, 200);
  const botType = ["dm", "group", "all"].includes(req.body?.botType) ? req.body.botType : "dm";

  const { data: user } = await supabase
    .from("users").select("email_verified, plan_tier").eq("id", userId).single();

  if (!user) return res.status(500).json({ error: "Could not fetch user." });
  if (!user.email_verified)
    return res.status(403).json({ error: "Please verify your email before deploying bots." });

  const plan   = user.plan_tier ?? "free";
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  const { count } = await supabase
    .from("bots").select("*", { count: "exact", head: true }).eq("user_id", userId);

  if ((count ?? 0) >= limits.maxBots) {
    return res.status(403).json({
      error: `You've reached the ${plan === "paid" ? "Pro" : "Free"} plan limit of ${limits.maxBots} bot${limits.maxBots === 1 ? "" : "s"}.${plan !== "paid" ? " Upgrade to Pro to deploy up to 50 bots." : ""}`
    });
  }

  const { data: bot, error: botErr } = await supabase
    .from("bots")
    .insert({ user_id: userId, bot_name: botName, description: desc || null, status: "connecting", bot_type: botType })
    .select("id, bot_name, description, status, bot_type, created_at")
    .single();

  if (botErr) {
    if (botErr.message?.includes("Bot limit reached"))
      return res.status(403).json({ error: botErr.message });
    return res.status(500).json({ error: "Could not create bot. Please try again." });
  }

  botManager.deploy(bot.id, userId, { plan_tier: plan, bot_type: botType }).catch(() => {});

  await supabase.from("bot_activity").insert({
    user_id: userId, bot_id: bot.id, event_type: "deploy_started",
    details: `Bot "${botName}" (${botType}) deployed — waiting for QR scan`
  }).catch(() => {});

  return res.status(201).json({ bot });
});

/* ── GET /api/bots/:id/events (SSE) ─────────────────────────── */
router.get("/:id/events", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, user_id").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId)
    return res.status(404).json({ error: "Bot not found." });

  res.set({
    "Content-Type":      "text/event-stream; charset=utf-8",
    "Cache-Control":     "no-cache, no-store, no-transform",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  res.flushHeaders();
  /* Send an initial comment so the browser confirms the stream opened */
  res.write(": stream-open\n\n");
  if (typeof res.flush === "function") res.flush();

  const pingInterval = setInterval(() => {
    try {
      res.write(": ping\n\n");
      if (typeof res.flush === "function") res.flush();
    } catch { clearInterval(pingInterval); }
  }, 15_000);

  botManager.addSseClient(id, res);

  req.on("close", () => {
    clearInterval(pingInterval);
    botManager.removeSseClient(id, res);
  });
});

/* ── GET /api/bots/:id/qr ────────────────────────────────────── */
router.get("/:id/qr", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const { data: bot } = await supabase
    .from("bots").select("id, user_id, status").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });
  const qrCode = botManager.getQR(id);
  if (!qrCode) return res.status(404).json({ error: "No QR code available yet. Wait a moment and try again." });
  return res.json({ qrCodeDataUrl: qrCode });
});

/* ── POST /api/bots/:id/reconnect ───────────────────────────── */
router.post("/:id/reconnect", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, user_id, status").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  const RECONNECTABLE = ["disconnected", "failed", "error", "qr_timeout"];
  if (!RECONNECTABLE.includes(bot.status)) {
    return res.status(409).json({ error: `Bot cannot be reconnected from status "${bot.status}". It is already ${bot.status}.` });
  }

  try {
    await botManager.reconnect(id, userId);
    return res.json({ ok: true, message: "Reconnect initiated. A new QR code will appear shortly." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/bots/:id/send ─────────────────────────────────── */
router.post("/:id/send", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const to      = String(req.body?.to ?? "").trim();
  let message;

  try {
    message = buildDirectMessagePayload(req.body ?? {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!to)                         return res.status(400).json({ error: "`to` (phone number) is required." });
  if (!message)                    return res.status(400).json({ error: "`message` is required." });
  if (message.length > 4096)       return res.status(400).json({ error: "Message too long (max 4 096 chars)." });
  if (!/^\+?\d{7,15}$/.test(to.replace(/[\s\-()]/g, "")))
    return res.status(400).json({ error: "Invalid phone number format." });

  const { data: bot } = await supabase
    .from("bots").select("id, user_id, status").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  try {
  await botManager.sendMessage(id, to, message, { persist: false });
    // Do not persist manual dashboard sends to Supabase (user requested direct send without DB insert)
    return res.json({ ok: true, message: "Message sent." });
  } catch (err) {
    // If message sending fails, do not insert a DB record. Return error to client.
    return res.status(409).json({ error: err.message });
  }
});

/* ── PATCH /api/bots/:id ─────────────────────────────────────── */
router.patch("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, user_id, plan_tier:users!inner(plan_tier)").eq("id", id).maybeSingle();
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  const planTier = bot.plan_tier?.plan_tier ?? "free";
  const updates  = {};

  /* Text fields */
  for (const key of TEXT_FIELDS) {
    if (req.body && key in req.body) {
      updates[key] = req.body[key] === "" ? null : String(req.body[key]).slice(0, 2048);
    }
  }

  /* Boolean fields */
  for (const key of BOOL_FIELDS) {
    if (req.body && key in req.body) updates[key] = Boolean(req.body[key]);
  }

  /* JSON fields */
  for (const key of JSON_FIELDS) {
    if (req.body && key in req.body) {
      if (!req.body[key] || typeof req.body[key] !== "object")
        return res.status(400).json({ error: `Field ${key} must be an object or array.` });
      updates[key] = key === "sales_agent_config"
        ? normalizeSalesAgentConfig(req.body[key])
        : req.body[key];
    }
  }

  /* Bot type */
  if (req.body && "bot_type" in req.body) {
    if (!["dm", "group", "all"].includes(req.body.bot_type))
      return res.status(400).json({ error: "bot_type must be dm, group, or all." });
    updates.bot_type = req.body.bot_type;
  }

  /* AI config — encrypt key, enforce Pro plan */
  if (req.body && "ai_config" in req.body) {
    if (planTier !== "paid")
      return res.status(403).json({ error: "AI integration is a Pro plan feature." });

    const aiRaw = req.body.ai_config ?? {};
    const ai    = { ...aiRaw };

    const provider = String(ai.provider ?? "openai").trim().toLowerCase();
    if (!ALLOWED_AI_PROVIDERS.has(provider)) {
      return res.status(400).json({
        error: "Supported AI providers are OpenAI and Gemini only."
      });
    }
    ai.provider = provider;

    /* If new raw API key provided, encrypt it */
    if (ai.api_key && !ai.api_key.startsWith("***")) {
      if (!env.hasJwt)
        return res.status(500).json({ error: "Server not configured for key encryption (JWT_SECRET missing)." });
      ai.encrypted_key = encryptApiKey(String(ai.api_key), env.jwtSecret);
    }
    /* Never store raw key */
    delete ai.api_key;

    updates.ai_config = ai;
  }

  /* Bot name validation */
  if (updates.bot_name !== undefined) {
    const { error: nameErr, name } = validateBotName(updates.bot_name);
    if (nameErr) return res.status(400).json({ error: nameErr });
    updates.bot_name = name;
  }

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "No valid fields provided." });

  const { data: updated, error } = await supabase
    .from("bots").update(updates).eq("id", id)
    .select("id, bot_name, description, status, bot_type, auto_reply_enabled, auto_reply_message, webhook_url, webhook_secret, keyword_triggers, sales_agent_config, commands_config, ai_config, group_management_config, website_url, catalog_unavail_msg, messages_count, messages_this_month, created_at")
    .single();

  if (error) return res.status(500).json({ error: "Could not update bot." });

  /* Push live config updates to running bot instance */
  botManager.updateConfig(id, {
    bot_type:                updated.bot_type,
    auto_reply_enabled:      updated.auto_reply_enabled,
    auto_reply_message:      updated.auto_reply_message,
    webhook_url:             updated.webhook_url,
    webhook_secret:          updated.webhook_secret,
    keyword_triggers:        updated.keyword_triggers        ?? [],
    sales_agent_config:      updated.sales_agent_config      ?? {},
    commands_config:         updated.commands_config         ?? {},
    ai_config:               updated.ai_config               ?? {},
    group_management_config: updated.group_management_config ?? {},
    website_url:             updated.website_url,
    catalog_unavail_msg:     updated.catalog_unavail_msg
  });

  /* Sanitise encrypted key before returning to client */
  const safeAi = updated.ai_config?.encrypted_key
    ? { ...updated.ai_config, encrypted_key: undefined, has_key: true }
    : updated.ai_config;

  await supabase.from("bot_activity").insert({
    user_id: userId, bot_id: id, event_type: "bot_updated",
    details: "Bot configuration updated"
  }).catch(() => {});

  return res.json({ bot: { ...updated, ai_config: safeAi } });
});

/* ── GET /api/bots/:id/groups ────────────────────────────────── */
router.get("/:id/groups", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const { data: bot } = await supabase
    .from("bots").select("id, user_id, bot_type").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  const groups = await botManager.getAdminGroups(id);
  return res.json({
    count:  groups.length,
    groups: groups.map((g) => ({
      id:           g.id,
      subject:      g.subject,
      participants: g.participants?.length ?? 0
    }))
  });
});

/* ── DELETE /api/bots/:id ────────────────────────────────────── */
router.delete("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, bot_name, user_id").eq("id", id).maybeSingle();
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  await botManager.remove(id);
  const { error } = await supabase.from("bots").delete().eq("id", id);
  if (error) return res.status(500).json({ error: "Could not delete bot." });

  await supabase.from("bot_activity").insert({
    user_id: userId, bot_id: null, event_type: "bot_deleted",
    details: `Bot "${bot.bot_name}" was deleted`
  }).catch(() => {});

  return res.status(204).send();
});

export default router;
