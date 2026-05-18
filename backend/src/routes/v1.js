/**
 * /api/v1 — Public Developer API
 *
 * Auth: Bearer JWT token  OR  Bearer wbk_* API key
 * Rate limits: Free 30 calls/min · Pro 300 calls/min (per user)
 * Monthly message limits: Free 1 000 · Pro 100 000
 *
 * Endpoints
 *  GET    /me
 *  GET    /bots
 *  GET    /bots/:id
 *  GET    /bots/:id/stats
 *  GET    /bots/:id/config
 *  PATCH  /bots/:id/config
 *  GET    /bots/:id/triggers
 *  POST   /bots/:id/triggers
 *  PATCH  /bots/:id/triggers/:tid
 *  DELETE /bots/:id/triggers/:tid
 *  POST   /messages/send
 *  POST   /messages/broadcast          (Pro only)
 *  GET    /conversations
 *  GET    /activity
 *  GET    /templates
 *  POST   /templates
 *  PATCH  /templates/:id
 *  DELETE /templates/:id
 *  POST   /webhooks/test
 */

import { Router }        from "express";
import crypto            from "node:crypto";
import { supabase }      from "../lib/supabase.js";
import { requireAuth }   from "../middleware/auth.js";
import { v1PlanLimiter } from "../middleware/rateLimiter.js";
import { botManager }    from "../services/whatsapp/BotManager.js";

const router = Router();
router.use(requireAuth);
router.use(v1PlanLimiter);

/* ── Constants ───────────────────────────────────────────────── */
const PLAN_LIMITS = {
  free: { bots: 1,  messages_per_month: 1_000,   api_keys: 1,  broadcast: false, templates: 10  },
  paid: { bots: 50, messages_per_month: 100_000,  api_keys: 10, broadcast: true,  templates: 200 }
};

const BOT_CONFIG_TEXT_FIELDS  = ["auto_reply_message", "webhook_url", "webhook_secret"];
const BOT_CONFIG_BOOL_FIELDS  = ["auto_reply_enabled"];
const BOT_CONFIG_JSON_FIELDS  = ["sales_agent_config", "commands_config"];

const MATCH_TYPES = ["exact", "contains", "starts_with", "ends_with", "regex"];

/* ── Helpers ─────────────────────────────────────────────────── */
async function getOwnedBot(userId, botId) {
  const { data } = await supabase
    .from("bots").select("*").eq("id", botId).eq("user_id", userId).maybeSingle();
  return data;
}

async function getUserPlan(userId) {
  const { data } = await supabase.from("users").select("plan_tier, messages_this_month").eq("id", userId).single();
  return data ?? { plan_tier: "free", messages_this_month: 0 };
}

/** Apply {{variable}} substitution to a template string */
function applyVars(template, vars = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function normalizePhone(value) {
  return String(value ?? "").replace(/[^\d+]/g, "").trim();
}

function buildOtpMessage({ appName, code, expiresInMinutes, intro, outro }) {
  const parts = [
    intro || `Your ${appName || "verification"} code is ready.`,
    `OTP: ${code}`
  ];

  if (expiresInMinutes) {
    parts.push(`Expires in ${expiresInMinutes} minute${Number(expiresInMinutes) === 1 ? "" : "s"}.`);
  }
  if (outro) parts.push(outro);
  return parts.join("\n");
}

function buildFormSubmissionMessage({ formName, fields, heading, footer }) {
  const rows = Object.entries(fields ?? {})
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(([key, value]) => `- ${key}: ${String(value).trim()}`);

  return [
    heading || `New submission: ${formName || "Form"}`,
    ...rows,
    footer || ""
  ].filter(Boolean).join("\n");
}

function buildMessageFromPreset(body = {}) {
  const preset = String(body.preset ?? "custom").trim().toLowerCase();

  if (preset === "otp") {
    const code = String(body.code ?? "").trim();
    if (!/^\d{4,10}$/.test(code)) {
      throw new Error("`code` must be 4-10 digits.");
    }
    return buildOtpMessage({
      appName: body?.app_name,
      code,
      expiresInMinutes: body?.expires_in_minutes,
      intro: body?.intro,
      outro: body?.outro
    });
  }

  if (preset === "form") {
    if (!body?.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
      throw new Error("`fields` must be an object.");
    }
    return buildFormSubmissionMessage({
      formName: body?.form_name,
      fields: body.fields,
      heading: body?.heading,
      footer: body?.footer
    });
  }

  if (preset === "welcome") {
    const name = String(body?.name ?? "").trim();
    return String(body?.message ?? "").trim() || (name
      ? `Welcome ${name}! We received your message and will reply shortly.`
      : "Welcome! We received your message and will reply shortly.");
  }

  return String(body?.message ?? "").trim();
}

/** Enforce monthly message limit — returns error string or null */
async function checkMonthlyLimit(userId) {
  const u = await getUserPlan(userId);
  const limit = PLAN_LIMITS[u.plan_tier]?.messages_per_month ?? 1_000;
  if ((u.messages_this_month ?? 0) >= limit) {
    return {
      error:   `Monthly message limit reached (${limit.toLocaleString()} messages). Resets on the 1st of next month.`,
      code:    "MONTHLY_LIMIT_REACHED",
      used:    u.messages_this_month,
      limit,
      upgrade: u.plan_tier !== "paid" ? "Upgrade to Pro for 100,000 messages/month." : null
    };
  }
  return null;
}

async function sendBotMessageViaApi(req, res, messageOverride) {
  const userId   = req.user.sub;
  const bot_id   = String(req.body?.bot_id   ?? "").trim();
  const to       = normalizePhone(req.body?.to);
  const template = req.body?.template;
  const vars     = req.body?.vars ?? {};
  let   message;

  try {
    message = messageOverride ?? buildMessageFromPreset(req.body ?? {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!bot_id) return res.status(400).json({ error: "`bot_id` is required." });
  if (!to)     return res.status(400).json({ error: "`to` (phone number) is required." });

  if (template) {
    const { data: tpl } = await supabase
      .from("message_templates")
      .select("content, use_count")
      .eq("user_id", userId)
      .eq("name", template)
      .maybeSingle();
    if (!tpl) return res.status(404).json({ error: `Template "${template}" not found.` });
    message = applyVars(tpl.content, vars);
    supabase.from("message_templates").update({ use_count: (tpl.use_count ?? 0) + 1 })
      .eq("user_id", userId).eq("name", template).catch(() => {});
  }

  if (!message)              return res.status(400).json({ error: "`message` or `template` is required." });
  if (message.length > 4096) return res.status(400).json({ error: "Message too long (max 4096 chars)." });

  const userPlan  = await getUserPlan(userId);
  const planKey   = userPlan.plan_tier ?? "free";
  const planLimit = PLAN_LIMITS[planKey]?.messages_per_month ?? 1_000;
  if ((userPlan.messages_this_month ?? 0) >= planLimit) {
    return res.status(429).json({
      error:   `Monthly message limit reached (${planLimit.toLocaleString()} messages). Resets on the 1st of next month.`,
      code:    "MONTHLY_LIMIT_REACHED",
      used:    userPlan.messages_this_month,
      limit:   planLimit,
      upgrade: planKey !== "paid" ? "Upgrade to Pro for 100,000 messages/month." : null
    });
  }

  const bot = await getOwnedBot(userId, bot_id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  const inst = botManager.instances.get(bot_id);
  if (!inst || inst.status !== "connected") {
    return res.status(409).json({ error: "Bot is not connected. Check bot status and try again." });
  }

  try {
    await inst.sendMessage(to, message);

    const newCount = (userPlan.messages_this_month ?? 0) + 1;
    await supabase.rpc("increment_user_messages", { uid: userId }).catch(() =>
      supabase.from("users").update({ messages_this_month: newCount }).eq("id", userId)
    );

    await supabase.from("bot_activity").insert({
      user_id: userId, bot_id,
      event_type: "api_message_sent",
      details:    `API: sent to ${to}`,
      metadata:   { to, preview: message.slice(0, 80), template: template ?? null }
    }).catch(() => {});

    return res.json({
      ok: true, message: "Message sent.", bot_id, to, timestamp: Date.now(),
      usage: { used: newCount, limit: planLimit }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/* ════════════════════════════════════════════════════════════════
   USER
════════════════════════════════════════════════════════════════ */

/* ── GET /api/v1/me ──────────────────────────────────────────── */
router.get("/me", async (req, res) => {
  const { data: user } = await supabase
    .from("users")
    .select("id, email, full_name, plan_tier, messages_this_month, created_at")
    .eq("id", req.user.sub).single();
  if (!user) return res.status(404).json({ error: "User not found." });

  const limits = PLAN_LIMITS[user.plan_tier] ?? PLAN_LIMITS.free;
  return res.json({
    user: {
      id:                user.id,
      email:             user.email,
      fullName:          user.full_name,
      planTier:          user.plan_tier,
      messagesThisMonth: user.messages_this_month ?? 0,
      createdAt:         user.created_at,
      limits,
      rateLimits: { callsPerMinute: user.plan_tier === "paid" ? 300 : 30 }
    }
  });
});

/* ════════════════════════════════════════════════════════════════
   BOTS
════════════════════════════════════════════════════════════════ */

/* ── GET /api/v1/bots ────────────────────────────────────────── */
router.get("/bots", async (req, res) => {
  const { data, error } = await supabase
    .from("bots")
    .select("id, bot_name, description, status, bot_type, messages_count, messages_this_month, created_at, last_activity")
    .eq("user_id", req.user.sub)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Could not fetch bots." });
  return res.json({
    bots: (data ?? []).map((b) => ({ ...b, status: botManager.getStatus(b.id) || b.status }))
  });
});

/* ── GET /api/v1/bots/:id ────────────────────────────────────── */
router.get("/bots/:id", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  const { keyword_triggers, sales_agent_config, commands_config, ai_config, ...safe } = bot;
  return res.json({ bot: { ...safe, status: botManager.getStatus(bot.id) || bot.status } });
});

/* ── GET /api/v1/bots/:id/stats ──────────────────────────────── */
router.get("/bots/:id/stats", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });

  const { data: activity } = await supabase
    .from("bot_activity")
    .select("event_type, created_at")
    .eq("bot_id", bot.id)
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1000);

  /* Group events by day (last 30 days) */
  const byDay = {};
  for (const ev of activity ?? []) {
    const day = ev.created_at.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }

  const eventCounts = {};
  for (const ev of activity ?? []) {
    eventCounts[ev.event_type] = (eventCounts[ev.event_type] ?? 0) + 1;
  }

  return res.json({
    stats: {
      botId:             bot.id,
      status:            botManager.getStatus(bot.id) || bot.status,
      totalMessages:     bot.messages_count ?? 0,
      messagesThisMonth: bot.messages_this_month ?? 0,
      triggerCount:      (bot.keyword_triggers ?? []).length,
      activityLast30d:   byDay,
      eventBreakdown:    eventCounts,
      createdAt:         bot.created_at,
      lastActivity:      bot.last_activity,
    }
  });
});

/* ════════════════════════════════════════════════════════════════
   BOT CONFIGURATION
════════════════════════════════════════════════════════════════ */

/* ── GET /api/v1/bots/:id/config ─────────────────────────────── */
router.get("/bots/:id/config", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });

  const aiCfg = bot.ai_config ?? {};

  return res.json({
    config: {
      botId:              bot.id,
      botName:            bot.bot_name,
      description:        bot.description,
      botType:            bot.bot_type,
      autoReplyEnabled:   bot.auto_reply_enabled,
      autoReplyMessage:   bot.auto_reply_message,
      webhookUrl:         bot.webhook_url,
      webhookSecret:      bot.webhook_secret ? "••••••••" : null,
      websiteUrl:         bot.website_url,
      commandsEnabled:    bot.commands_config,
      salesAgentEnabled:  (bot.sales_agent_config ?? {}).enabled ?? false,
      aiEnabled:          aiCfg.enabled ?? false,
      aiProvider:         aiCfg.provider ?? null,
      aiModel:            aiCfg.model    ?? null,
      aiHasKey:           Boolean(aiCfg.encrypted_key),
    }
  });
});

/* ── PATCH /api/v1/bots/:id/config ───────────────────────────── */
router.patch("/bots/:id/config", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });

  const patch = {};

  for (const f of BOT_CONFIG_TEXT_FIELDS) {
    if (req.body[f] !== undefined) {
      const v = String(req.body[f] ?? "").trim();
      if (v.length > 2000) return res.status(400).json({ error: `${f} is too long (max 2000 chars).` });
      patch[f] = v;
    }
  }
  for (const f of BOT_CONFIG_BOOL_FIELDS) {
    if (req.body[f] !== undefined) patch[f] = Boolean(req.body[f]);
  }
  for (const f of BOT_CONFIG_JSON_FIELDS) {
    if (req.body[f] !== undefined) {
      if (typeof req.body[f] !== "object") return res.status(400).json({ error: `${f} must be an object.` });
      patch[f] = req.body[f];
    }
  }

  /* ── ai_config (Pro only) ─────────────────────────────────── */
  if (req.body.ai_config !== undefined) {
    const { plan_tier } = await getUserPlan(req.user.sub);
    if (plan_tier !== "paid")
      return res.status(403).json({
        error:   "AI configuration is a Pro plan feature.",
        code:    "PRO_REQUIRED",
        upgrade: "Upgrade to Pro to enable AI responses for your bots."
      });

    if (typeof req.body.ai_config !== "object" || Array.isArray(req.body.ai_config))
      return res.status(400).json({ error: "ai_config must be an object." });

    const incoming = req.body.ai_config;
    const existing = bot.ai_config ?? {};

    const { encryptApiKey } = await import("../services/ai/AiService.js");
    const { env: cfg } = await import("../config/env.js");

    const built = {
      enabled:       incoming.enabled  !== undefined ? Boolean(incoming.enabled) : (existing.enabled ?? false),
      provider:      incoming.provider ?? existing.provider ?? "openai",
      model:         incoming.model    ?? existing.model    ?? null,
      system_prompt: incoming.system_prompt !== undefined ? String(incoming.system_prompt ?? "").trim() : (existing.system_prompt ?? ""),
      encrypted_key: existing.encrypted_key ?? null,
      is_sensitive:  existing.is_sensitive  ?? false,
    };

    /* Encrypt a new API key if provided */
    if (incoming.api_key && String(incoming.api_key).trim()) {
      const secret = cfg.jwtSecret;
      if (!secret) return res.status(503).json({ error: "Server encryption key not configured." });
      built.encrypted_key = encryptApiKey(String(incoming.api_key).trim(), secret);
      built.is_sensitive  = incoming.is_sensitive !== undefined ? Boolean(incoming.is_sensitive) : false;
    }

    patch.ai_config = built;
  }

  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: "No valid config fields provided." });

  const { error } = await supabase.from("bots").update(patch).eq("id", bot.id).eq("user_id", req.user.sub);
  if (error) return res.status(500).json({ error: "Could not update config." });

  /* Push live config update to running bot instance */
  botManager.updateConfig(bot.id, patch);

  return res.json({ ok: true, updated: Object.keys(patch), message: "Bot config updated." });
});

/* ════════════════════════════════════════════════════════════════
   AUTO-REPLY TRIGGERS
   Each trigger: { id, keyword, response, matchType, caseSensitive, enabled }
   matchType: "exact" | "contains" | "starts_with" | "ends_with" | "regex"
════════════════════════════════════════════════════════════════ */

/* ── GET /api/v1/bots/:id/triggers ───────────────────────────── */
router.get("/bots/:id/triggers", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  const triggers = Array.isArray(bot.keyword_triggers) ? bot.keyword_triggers : [];
  return res.json({ triggers, count: triggers.length });
});

/* ── POST /api/v1/bots/:id/triggers ──────────────────────────── */
router.post("/bots/:id/triggers", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });

  const keyword       = String(req.body?.keyword       ?? "").trim();
  const response      = String(req.body?.response      ?? "").trim();
  const matchType     = String(req.body?.matchType     ?? req.body?.match_type ?? "contains").toLowerCase();
  const caseSensitive = Boolean(req.body?.caseSensitive ?? req.body?.case_sensitive ?? false);
  const enabled       = req.body?.enabled !== false; /* default: true */

  if (!keyword)  return res.status(400).json({ error: "`keyword` is required." });
  if (!response) return res.status(400).json({ error: "`response` is required." });
  if (!MATCH_TYPES.includes(matchType))
    return res.status(400).json({ error: `\`matchType\` must be one of: ${MATCH_TYPES.join(", ")}.` });
  if (keyword.length > 200)  return res.status(400).json({ error: "Keyword too long (max 200)." });
  if (response.length > 4096) return res.status(400).json({ error: "Response too long (max 4096)." });

  /* Validate regex if matchType is "regex" */
  if (matchType === "regex") {
    try { new RegExp(keyword); }
    catch { return res.status(400).json({ error: "Invalid regex pattern." }); }
  }

  const triggers = Array.isArray(bot.keyword_triggers) ? [...bot.keyword_triggers] : [];

  /* Free plan: max 5 triggers per bot. Pro: 100 */
  const { plan_tier } = await getUserPlan(req.user.sub);
  const maxTriggers   = plan_tier === "paid" ? 100 : 5;
  if (triggers.length >= maxTriggers)
    return res.status(400).json({
      error: `${plan_tier === "paid" ? "Pro" : "Free"} plan allows up to ${maxTriggers} triggers per bot.`,
      upgrade: plan_tier !== "paid" ? "Upgrade to Pro for up to 100 triggers per bot." : null
    });

  const newTrigger = { id: crypto.randomUUID(), keyword, response, matchType, caseSensitive, enabled };
  triggers.push(newTrigger);

  const { error } = await supabase
    .from("bots").update({ keyword_triggers: triggers }).eq("id", bot.id).eq("user_id", req.user.sub);
  if (error) return res.status(500).json({ error: "Could not save trigger." });

  botManager.updateConfig(bot.id, { keyword_triggers: triggers });

  return res.status(201).json({
    trigger: newTrigger,
    message: `Trigger created. Bot will now reply when a message ${matchType.replace("_", " ")} "${keyword}".`
  });
});

/* ── PATCH /api/v1/bots/:id/triggers/:tid ────────────────────── */
router.patch("/bots/:id/triggers/:tid", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });

  const triggers = Array.isArray(bot.keyword_triggers) ? [...bot.keyword_triggers] : [];
  const idx      = triggers.findIndex((t) => t.id === req.params.tid);
  if (idx === -1) return res.status(404).json({ error: "Trigger not found." });

  const t = { ...triggers[idx] };
  if (req.body.keyword  !== undefined) t.keyword       = String(req.body.keyword).trim();
  if (req.body.response !== undefined) t.response      = String(req.body.response).trim();
  if (req.body.matchType  !== undefined) t.matchType   = String(req.body.matchType).toLowerCase();
  if (req.body.match_type !== undefined) t.matchType   = String(req.body.match_type).toLowerCase();
  if (req.body.caseSensitive !== undefined) t.caseSensitive = Boolean(req.body.caseSensitive);
  if (req.body.enabled  !== undefined) t.enabled       = Boolean(req.body.enabled);

  if (!t.keyword)  return res.status(400).json({ error: "`keyword` cannot be empty." });
  if (!t.response) return res.status(400).json({ error: "`response` cannot be empty." });
  if (!MATCH_TYPES.includes(t.matchType))
    return res.status(400).json({ error: `\`matchType\` must be one of: ${MATCH_TYPES.join(", ")}.` });
  if (t.matchType === "regex") {
    try { new RegExp(t.keyword); } catch { return res.status(400).json({ error: "Invalid regex pattern." }); }
  }

  triggers[idx] = t;
  const { error } = await supabase
    .from("bots").update({ keyword_triggers: triggers }).eq("id", bot.id).eq("user_id", req.user.sub);
  if (error) return res.status(500).json({ error: "Could not update trigger." });
  botManager.updateConfig(bot.id, { keyword_triggers: triggers });

  return res.json({ trigger: t, message: "Trigger updated." });
});

/* ── DELETE /api/v1/bots/:id/triggers/:tid ───────────────────── */
router.delete("/bots/:id/triggers/:tid", async (req, res) => {
  const bot = await getOwnedBot(req.user.sub, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });

  const triggers = Array.isArray(bot.keyword_triggers) ? [...bot.keyword_triggers] : [];
  const filtered = triggers.filter((t) => t.id !== req.params.tid);

  if (filtered.length === triggers.length)
    return res.status(404).json({ error: "Trigger not found." });

  const { error } = await supabase
    .from("bots").update({ keyword_triggers: filtered }).eq("id", bot.id).eq("user_id", req.user.sub);
  if (error) return res.status(500).json({ error: "Could not delete trigger." });
  botManager.updateConfig(bot.id, { keyword_triggers: filtered });

  return res.status(204).send();
});

/* ════════════════════════════════════════════════════════════════
   MESSAGES
════════════════════════════════════════════════════════════════ */

/* ── POST /api/v1/messages/send ──────────────────────────────── */
router.post("/messages/send", async (req, res) => {
  return sendBotMessageViaApi(req, res);
});

/* ── POST /api/v1/messages/otp ───────────────────────────────── */
router.post("/messages/otp", async (req, res) => {
  const code = String(req.body?.code ?? "").trim();
  if (!/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ error: "`code` must be 4-10 digits." });
  }

  const message = buildOtpMessage({
    appName: req.body?.app_name,
    code,
    expiresInMinutes: req.body?.expires_in_minutes,
    intro: req.body?.intro,
    outro: req.body?.outro
  });
  return sendBotMessageViaApi(req, res, message);
});

/* ── POST /api/v1/messages/form-submission ──────────────────── */
router.post("/messages/form-submission", async (req, res) => {
  if (!req.body?.fields || typeof req.body.fields !== "object" || Array.isArray(req.body.fields)) {
    return res.status(400).json({ error: "`fields` must be an object." });
  }

  const message = buildFormSubmissionMessage({
    formName: req.body?.form_name,
    fields: req.body.fields,
    heading: req.body?.heading,
    footer: req.body?.footer
  });
  return sendBotMessageViaApi(req, res, message);
});

/* ── POST /api/v1/messages/welcome ──────────────────────────── */
router.post("/messages/welcome", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const fallback = name
    ? `Welcome ${name}! We received your message and will reply shortly.`
    : "Welcome! We received your message and will reply shortly.";

  const message = String(req.body?.message ?? "").trim() || fallback;
  return sendBotMessageViaApi(req, res, message);
});

/* ── POST /api/v1/messages/broadcast (Pro only) ──────────────── */
router.post("/messages/broadcast", async (req, res) => {
  const userId = req.user.sub;
  const u      = await getUserPlan(userId);
  if (u.plan_tier !== "paid")
    return res.status(403).json({ error: "Broadcast is a Pro plan feature. Upgrade at wabot.app/billing.", code: "PRO_REQUIRED" });

  const bot_id     = String(req.body?.bot_id ?? "").trim();
  const recipients = req.body?.recipients;
  const template   = req.body?.template;
  const vars       = req.body?.vars ?? {};
  let   message    = String(req.body?.message ?? "").trim();
  const delayMs    = Math.min(Math.max(Number(req.body?.delay_ms ?? 1500), 500), 5000);

  if (!bot_id)                   return res.status(400).json({ error: "`bot_id` is required." });
  if (!Array.isArray(recipients)) return res.status(400).json({ error: "`recipients` must be an array." });
  if (recipients.length === 0)   return res.status(400).json({ error: "`recipients` cannot be empty." });
  if (recipients.length > 50)    return res.status(400).json({ error: "Max 50 recipients per broadcast." });

  /* Resolve template */
  if (template) {
    const { data: tpl } = await supabase
      .from("message_templates").select("content, use_count")
      .eq("user_id", userId).eq("name", template).maybeSingle();
    if (!tpl) return res.status(404).json({ error: `Template "${template}" not found.` });
    message = applyVars(tpl.content, vars);
    supabase.from("message_templates").update({ use_count: (tpl.use_count ?? 0) + 1 })
      .eq("user_id", userId).eq("name", template).catch(() => {});
  }

  if (!message)              return res.status(400).json({ error: "`message` or `template` is required." });
  if (message.length > 4096) return res.status(400).json({ error: "Message too long (max 4096)." });

  /* Monthly limit — check if we have room for all recipients */
  const monthLimit   = PLAN_LIMITS.paid.messages_per_month;
  const used         = u.messages_this_month ?? 0;
  const available    = monthLimit - used;
  if (available <= 0)
    return res.status(429).json({ error: "Monthly message limit reached.", code: "MONTHLY_LIMIT_REACHED" });

  const sendCount = Math.min(recipients.length, available);

  const bot = await getOwnedBot(userId, bot_id);
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  const inst = botManager.instances.get(bot_id);
  if (!inst || inst.status !== "connected")
    return res.status(409).json({ error: "Bot is not connected." });

  /* Send with delay to avoid WhatsApp spam detection */
  const results = [];
  for (let i = 0; i < sendCount; i++) {
    const to = String(recipients[i]).trim();
    try {
      if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
      await inst.sendMessage(to, applyVars(message, { ...vars, to }));
      results.push({ to, ok: true });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }

  /* Increment user monthly counter by number of successful sends */
  const succeeded = results.filter((r) => r.ok).length;
  if (succeeded > 0) {
    const newCount = used + succeeded;
    await supabase.rpc("increment_user_messages_by", { uid: userId, amount: succeeded }).catch(() =>
      supabase.from("users").update({ messages_this_month: newCount }).eq("id", userId)
    );
  }

  await supabase.from("bot_activity").insert({
    user_id: userId, bot_id,
    event_type: "broadcast_sent",
    details: `Broadcast to ${succeeded}/${sendCount} recipients`,
    metadata: { total: sendCount, results }
  }).catch(() => {});

  return res.json({
    ok: true, sent: succeeded, failed: sendCount - succeeded, results,
    usage: { used: used + succeeded, limit: monthLimit }
  });
});

/* ── GET /api/v1/conversations ───────────────────────────────── */
router.get("/conversations", async (req, res) => {
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const bot_id = req.query.bot_id;
  const offset = Math.max(0, Number(req.query.offset) || 0);

  let q = supabase
    .from("bot_activity")
    .select("id, bot_id, event_type, details, metadata, created_at")
    .eq("user_id", req.user.sub)
    .in("event_type", ["message_received", "api_message_sent", "broadcast_sent"])
    .order("created_at", { ascending: false })
    .limit(limit)
    .offset(offset);
  if (bot_id) q = q.eq("bot_id", bot_id);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "Could not fetch conversations." });
  const rows = data ?? [];

  // Fetch persisted read markers (optional) to mark unread state
  try {
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (ids.length > 0) {
      const { data: reads } = await supabase
        .from("conversation_reads")
        .select("bot_activity_id")
        .eq("user_id", req.user.sub)
        .in("bot_activity_id", ids);

      const readSet = new Set((reads ?? []).map((r) => r.bot_activity_id));
      for (const r of rows) {
        r.unread = !readSet.has(r.id);
      }
    } else {
      for (const r of rows) r.unread = true;
    }
  } catch (e) {
    // If read tracking fails, default to showing items as unread
    for (const r of rows) r.unread = true;
  }

  return res.json({ conversations: rows, count: rows.length, offset });
});


/* ── POST /api/v1/conversations/mark-read ───────────────────── */
router.post("/conversations/mark-read", async (req, res) => {
  const userId = req.user.sub;
  const ids = Array.isArray(req.body?.activity_ids) ? req.body.activity_ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "activity_ids array is required." });

  const toInsert = ids.map((aid) => ({ user_id: userId, bot_activity_id: aid }));
  try {
    // Upsert to avoid duplicates
    await supabase.from("conversation_reads").insert(toInsert).select().catch(() => {});
    return res.json({ ok: true, marked: ids.length });
  } catch (err) {
    return res.status(500).json({ error: "Could not mark as read." });
  }
});

/* ── GET /api/v1/activity ────────────────────────────────────── */
router.get("/activity", async (req, res) => {
  const limit  = Math.min(Number(req.query.limit) || 100, 500);
  const bot_id = req.query.bot_id;
  const type   = req.query.type;

  let q = supabase
    .from("bot_activity")
    .select("id, bot_id, event_type, details, metadata, created_at")
    .eq("user_id", req.user.sub)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (bot_id) q = q.eq("bot_id", bot_id);
  if (type)   q = q.eq("event_type", type);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "Could not fetch activity." });
  return res.json({ activity: data ?? [], count: (data ?? []).length });
});

/* ════════════════════════════════════════════════════════════════
   MESSAGE TEMPLATES
   Named, reusable message content with {{variable}} substitution
════════════════════════════════════════════════════════════════ */

/* ── GET /api/v1/templates ───────────────────────────────────── */
router.get("/templates", async (req, res) => {
  const { data, error } = await supabase
    .from("message_templates")
    .select("id, name, content, use_count, created_at, updated_at")
    .eq("user_id", req.user.sub)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Could not fetch templates." });
  return res.json({ templates: data ?? [], count: (data ?? []).length });
});

/* ── POST /api/v1/templates ──────────────────────────────────── */
router.post("/templates", async (req, res) => {
  const userId  = req.user.sub;
  const name    = String(req.body?.name    ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const content = String(req.body?.content ?? "").trim();

  if (!name)    return res.status(400).json({ error: "`name` is required." });
  if (!content) return res.status(400).json({ error: "`content` is required." });
  if (!/^[\w_-]+$/.test(name))
    return res.status(400).json({ error: "Template name may only contain letters, numbers, _ and -." });
  if (name.length > 80)     return res.status(400).json({ error: "Template name too long (max 80)." });
  if (content.length > 4096) return res.status(400).json({ error: "Template content too long (max 4096)." });

  /* Plan limits */
  const { plan_tier } = await getUserPlan(userId);
  const maxTemplates  = PLAN_LIMITS[plan_tier]?.templates ?? 10;
  const { count }     = await supabase
    .from("message_templates").select("*", { count: "exact", head: true }).eq("user_id", userId);
  if ((count ?? 0) >= maxTemplates)
    return res.status(400).json({
      error: `${plan_tier === "paid" ? "Pro" : "Free"} plan allows up to ${maxTemplates} templates.`,
      upgrade: plan_tier !== "paid" ? "Upgrade to Pro for 200 templates." : null
    });

  /* Extract variable names from {{...}} placeholders */
  const variables = [...new Set([...content.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];

  const { data, error } = await supabase
    .from("message_templates")
    .insert({ user_id: userId, name, content, variables })
    .select("id, name, content, variables, use_count, created_at")
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: `Template "${name}" already exists.` });
    return res.status(500).json({ error: "Could not create template." });
  }

  return res.status(201).json({ template: data, variables, message: `Template "${name}" created.` });
});

/* ── PATCH /api/v1/templates/:id ─────────────────────────────── */
router.patch("/templates/:id", async (req, res) => {
  const userId  = req.user.sub;
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ error: "`content` is required." });
  if (content.length > 4096) return res.status(400).json({ error: "Template content too long (max 4096)." });

  const variables = [...new Set([...content.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];

  const { data, error } = await supabase
    .from("message_templates")
    .update({ content, variables, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", userId)
    .select("id, name, content, variables, use_count, updated_at")
    .single();

  if (!data || error) return res.status(404).json({ error: "Template not found." });
  return res.json({ template: data, message: "Template updated." });
});

/* ── DELETE /api/v1/templates/:id ────────────────────────────── */
router.delete("/templates/:id", async (req, res) => {
  const { error } = await supabase
    .from("message_templates")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.sub);
  if (error) return res.status(500).json({ error: "Could not delete template." });
  return res.status(204).send();
});

/* ════════════════════════════════════════════════════════════════
   WEBHOOKS
════════════════════════════════════════════════════════════════ */

/* ── SSRF guard ────────────────────────────────────────────────
   Block requests to private/internal network ranges so the webhook
   test endpoint cannot be used as an SSRF proxy.               */
function isPrivateUrl(rawUrl) {
  try {
    const { hostname, protocol } = new URL(rawUrl);
    /* Only allow HTTP(S) — block file://, ftp://, etc. */
    if (protocol !== "http:" && protocol !== "https:") return true;
    const h = hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(h)) return true;
    if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
    /* RFC-1918 private ranges */
    if (/^10\./.test(h))                           return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h))     return true;
    if (/^192\.168\./.test(h))                     return true;
    /* Link-local (AWS IMDS: 169.254.169.254) */
    if (/^169\.254\./.test(h))                     return true;
    /* IPv6 private / loopback */
    if (/^(::1|fc|fd)/i.test(h))                  return true;
    return false;
  } catch { return true; }
}

/* ── POST /api/v1/webhooks/test ──────────────────────────────── */
router.post("/webhooks/test", async (req, res) => {
  const url    = String(req.body?.url    ?? "").trim();
  const secret = req.body?.secret;
  if (!url) return res.status(400).json({ error: "`url` is required." });
  try { new URL(url); } catch { return res.status(400).json({ error: "Invalid URL." }); }

  /* Block SSRF — prevent probing internal services */
  if (isPrivateUrl(url))
    return res.status(400).json({ error: "Webhook URL must point to a public internet address." });

  const payload = JSON.stringify({
    event:     "webhook_test",
    botId:     "test-bot-id",
    from:      "+2348012345678",
    body:      "Hello from WaBot webhook test! 👋",
    type:      "text",
    timestamp: Date.now()
  });
  const headers = {
    "Content-Type":  "application/json",
    "User-Agent":    "WaBot-Webhook/2.0",
    "X-WaBot-Event": "webhook_test"
  };
  if (secret) {
    const { createHmac } = await import("node:crypto");
    headers["X-WaBot-Signature"] = "sha256=" + createHmac("sha256", String(secret)).update(payload).digest("hex");
  }
  try {
    const r = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(8_000) });
    return res.json({ ok: true, status: r.status, message: `Delivered — HTTP ${r.status}` });
  } catch (err) {
    return res.status(400).json({ ok: false, error: `Delivery failed: ${err.message}` });
  }
});

export default router;
