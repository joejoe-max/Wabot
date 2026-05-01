import { Router } from "express";
import QRCode from "qrcode";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

const botRouter = Router();
botRouter.use(requireAuth);

const FREE_BOT_LIMIT = 2;
const PRO_BOT_LIMIT  = 100;

/* ── GET /api/bots/dashboard ─────────────────────────────────── */
botRouter.get("/dashboard", async (req, res) => {
  const userId = req.user.sub;

  const [
    { data: user,     error: uErr },
    { data: bots,     error: bErr },
    { data: activity, error: aErr }
  ] = await Promise.all([
    supabase.from("users").select("id,email,full_name,email_verified,plan_tier,created_at").eq("id", userId).single(),
    supabase.from("bots").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("bot_activity").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50)
  ]);

  if (uErr) return res.status(500).json({ error: "Could not fetch dashboard data." });

  const totalMessages = (bots ?? []).reduce((sum, b) => sum + (b.messages_count || 0), 0);

  return res.json({
    user,
    bots:     bots     ?? [],
    activity: activity ?? [],
    stats: {
      totalBots:      (bots ?? []).length,
      activeBots:     (bots ?? []).filter((b) => b.status === "active" || b.status === "connected").length,
      totalMessages,
      planLimit:      user?.plan_tier === "paid" ? PRO_BOT_LIMIT : FREE_BOT_LIMIT
    }
  });
});

/* ── POST /api/bots/deploy ───────────────────────────────────── */
botRouter.post("/deploy", async (req, res) => {
  const userId  = req.user.sub;
  const botName = String(req.body?.botName ?? "").trim();
  const desc    = String(req.body?.description ?? "").trim().slice(0, 200);

  if (botName.length < 2 || botName.length > 64)
    return res.status(400).json({ error: "Bot name must be 2–64 characters." });
  if (!/^[\w\s\-]+$/.test(botName))
    return res.status(400).json({ error: "Bot name may only contain letters, numbers, spaces, hyphens, and underscores." });

  const { data: user, error: uErr } = await supabase
    .from("users").select("id,email_verified,plan_tier").eq("id", userId).single();

  if (uErr || !user) return res.status(500).json({ error: "Could not fetch user." });
  if (!user.email_verified)
    return res.status(403).json({ error: "Please verify your email address before deploying bots." });

  const { count, error: cntErr } = await supabase
    .from("bots").select("*", { count: "exact", head: true }).eq("user_id", userId);

  if (cntErr) return res.status(500).json({ error: "Could not check bot count." });

  const maxBots = user.plan_tier === "paid" ? PRO_BOT_LIMIT : FREE_BOT_LIMIT;
  if ((count ?? 0) >= maxBots) {
    return res.status(403).json({
      error: `You've reached the ${user.plan_tier === "paid" ? "Pro" : "Free"} plan limit of ${maxBots} bot${maxBots === 1 ? "" : "s"}.${
        user.plan_tier !== "paid" ? " Upgrade to Pro to deploy up to 100 bots." : ""
      }`
    });
  }

  const qrPayload     = `wabot:${userId}:${Date.now()}:${botName}`;
  const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
    width: 400, margin: 2, color: { dark: "#000000", light: "#ffffff" }
  });

  const insertData = {
    user_id:    userId,
    bot_name:   botName,
    status:     "awaiting_qr_scan",
    qr_payload: qrPayload
  };
  if (desc) insertData.description = desc;

  const { data: bot, error: botErr } = await supabase
    .from("bots").insert(insertData).select("*").single();

  if (botErr) return res.status(500).json({ error: "Could not create bot. Please try again." });

  await supabase.from("bot_activity").insert({
    user_id:    userId,
    bot_id:     bot.id,
    event_type: "deploy_started",
    details:    `Bot "${botName}" deployed — awaiting QR scan`
  }).catch(() => {});

  return res.status(201).json({ bot, qrCodeDataUrl });
});

/* ── PATCH /api/bots/:id ─────────────────────────────────────── */
botRouter.patch("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot, error: fetchErr } = await supabase
    .from("bots").select("id,user_id,bot_name").eq("id", id).maybeSingle();

  if (fetchErr || !bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  const allowed = ["bot_name", "description", "webhook_url", "auto_reply_message", "auto_reply_enabled"];
  const updates = {};
  for (const key of allowed) {
    if (req.body && key in req.body) {
      updates[key] = req.body[key] === "" ? null : req.body[key];
    }
  }

  if (updates.bot_name !== undefined) {
    const name = String(updates.bot_name).trim();
    if (name.length < 2 || name.length > 64)
      return res.status(400).json({ error: "Bot name must be 2–64 characters." });
    if (!/^[\w\s\-]+$/.test(name))
      return res.status(400).json({ error: "Bot name may only contain letters, numbers, spaces, hyphens, and underscores." });
    updates.bot_name = name;
  }

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "No valid fields to update." });

  updates.updated_at = new Date().toISOString();

  const { data: updated, error: upErr } = await supabase
    .from("bots").update(updates).eq("id", id).select("*").single();

  if (upErr) {
    if (upErr.code === "42703") {
      return res.status(422).json({ error: "Some fields are not yet in the database schema. Run the latest migration." });
    }
    return res.status(500).json({ error: "Could not update bot." });
  }

  await supabase.from("bot_activity").insert({
    user_id:    userId,
    bot_id:     id,
    event_type: "bot_updated",
    details:    `Bot settings updated`
  }).catch(() => {});

  return res.json({ bot: updated });
});

/* ── GET /api/bots/:id/qr ────────────────────────────────────── */
botRouter.get("/:id/qr", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot, error } = await supabase
    .from("bots").select("id,bot_name,qr_payload,user_id").eq("id", id).maybeSingle();

  if (error || !bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });
  if (!bot.qr_payload) return res.status(404).json({ error: "No QR payload for this bot." });

  const qrCodeDataUrl = await QRCode.toDataURL(bot.qr_payload, {
    width: 400, margin: 2, color: { dark: "#000000", light: "#ffffff" }
  });

  return res.json({ qrCodeDataUrl });
});

/* ── DELETE /api/bots/:id ────────────────────────────────────── */
botRouter.delete("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot, error: fetchErr } = await supabase
    .from("bots").select("id,bot_name,user_id").eq("id", id).maybeSingle();

  if (fetchErr || !bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  const { error: delErr } = await supabase.from("bots").delete().eq("id", id);
  if (delErr) return res.status(500).json({ error: "Could not delete bot." });

  await supabase.from("bot_activity").insert({
    user_id:    userId,
    bot_id:     null,
    event_type: "bot_deleted",
    details:    `Bot "${bot.bot_name}" was deleted`
  }).catch(() => {});

  return res.status(204).send();
});

/* ── POST /api/bots/:id/simulate-message ────────────────────── */
botRouter.post("/:id/simulate-message", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id,user_id,bot_name,messages_count").eq("id", id).maybeSingle();

  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  const newCount = (bot.messages_count || 0) + 1;
  await supabase.from("bots").update({ messages_count: newCount }).eq("id", id).catch(() => {});
  await supabase.from("bot_activity").insert({
    user_id:    userId,
    bot_id:     id,
    event_type: "message_received",
    details:    `Message received on bot "${bot.bot_name}"`
  }).catch(() => {});

  return res.json({ ok: true, messagesCount: newCount });
});

export default botRouter;
