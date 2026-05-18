/**
 * BotManager — singleton managing all WhatsApp bot instances.
 */

import { BotInstance }  from "./BotInstance.js";
import { supabase }     from "../../lib/supabase.js";
import { logger }       from "../../utils/logger.js";

class BotManager {
  constructor() {
    /** @type {Map<string, BotInstance>} */
    this.instances  = new Map();
    /** @type {Map<string, Set<import("express").Response>>} */
    this.sseClients = new Map();
  }

  /* ── Boot ─────────────────────────────────────────────────── */

  async initialize() {
    const { data: sessions } = await supabase
      .from("bot_sessions")
      .select("bot_id");

    const botIds = [...new Set((sessions ?? []).map((row) => row.bot_id).filter(Boolean))];
    if (botIds.length === 0) return;

    const { data: bots } = await supabase
      .from("bots")
      .select(`id, user_id, status,
        plan_tier:users!inner(plan_tier),
        auto_reply_enabled, auto_reply_message,
        webhook_url, webhook_secret,
        messages_this_month, bot_type,
        keyword_triggers, sales_agent_config,
        commands_config, ai_config,
        group_management_config,
        website_url, catalog_unavail_msg`)
      .in("id", botIds);

    if (!bots?.length) return;
    logger.info(`BotManager: reconnecting ${bots.length} bot(s)`);

    for (const bot of bots) {
      const planTier = bot.plan_tier?.plan_tier ?? bot.plan_tier ?? "free";
      await this._create(bot.id, bot.user_id, {
        plan_tier:           planTier,
        bot_type:            bot.bot_type ?? "dm",
        auto_reply_enabled:  bot.auto_reply_enabled,
        auto_reply_message:  bot.auto_reply_message,
        webhook_url:         bot.webhook_url,
        webhook_secret:      bot.webhook_secret,
        messages_this_month: bot.messages_this_month ?? 0,
        keyword_triggers:    bot.keyword_triggers   ?? [],
        sales_agent_config:  bot.sales_agent_config ?? {},
        commands_config:         bot.commands_config         ?? {},
        ai_config:               bot.ai_config               ?? {},
        group_management_config: bot.group_management_config ?? {},
        website_url:             bot.website_url,
        catalog_unavail_msg:     bot.catalog_unavail_msg
      });
    }
  }

  /* ── Instance lifecycle ───────────────────────────────────── */

  async _create(botId, userId, config) {
    if (this.instances.has(botId)) await this.instances.get(botId).stop();

    const instance = new BotInstance(botId, userId, config);

    instance.onQR((qrUrl)  => this._broadcast(botId, { type: "qr",     qrUrl  }));
    instance.onStatus((s)  => this._broadcast(botId, { type: "status", status: s }));

    this.instances.set(botId, instance);
    await instance.start();
    return instance;
  }

  async deploy(botId, userId, config = {}) { return this._create(botId, userId, config); }

  /**
   * Reconnect a bot that is disconnected / failed / timed-out.
   * Fetches the latest config from DB and starts a fresh instance.
   */
  async reconnect(botId, userId) {
    const { data: bot } = await supabase
      .from("bots")
      .select(`id, user_id,
        plan_tier:users!inner(plan_tier),
        auto_reply_enabled, auto_reply_message,
        webhook_url, webhook_secret,
        messages_this_month, bot_type,
        keyword_triggers, sales_agent_config,
        commands_config, ai_config,
        group_management_config,
        website_url, catalog_unavail_msg`)
      .eq("id", botId)
      .maybeSingle();

    if (!bot || bot.user_id !== userId) throw new Error("Bot not found.");

    const planTier = bot.plan_tier?.plan_tier ?? bot.plan_tier ?? "free";
    await this._create(botId, userId, {
      plan_tier:               planTier,
      bot_type:                bot.bot_type            ?? "dm",
      auto_reply_enabled:      bot.auto_reply_enabled,
      auto_reply_message:      bot.auto_reply_message,
      webhook_url:             bot.webhook_url,
      webhook_secret:          bot.webhook_secret,
      messages_this_month:     bot.messages_this_month ?? 0,
      keyword_triggers:        bot.keyword_triggers    ?? [],
      sales_agent_config:      bot.sales_agent_config  ?? {},
      commands_config:         bot.commands_config     ?? {},
      ai_config:               bot.ai_config           ?? {},
      group_management_config: bot.group_management_config ?? {},
      website_url:             bot.website_url,
      catalog_unavail_msg:     bot.catalog_unavail_msg
    });
  }

  async remove(botId) {
    const inst = this.instances.get(botId);
    if (inst) { await inst.stop(); this.instances.delete(botId); }
    this._closeSseClients(botId);
  }

  updateConfig(botId, patch) { this.instances.get(botId)?.updateConfig(patch); }
  getQR(botId)     { return this.instances.get(botId)?.qrCode  ?? null;      }
  getStatus(botId) { return this.instances.get(botId)?.status  ?? "unknown"; }

  /**
   * Push a plan downgrade to every running bot owned by userId.
   * Called immediately when a subscription expires / is cancelled /
   * payment fails so Pro features stop working without a server restart.
   */
  downgradeUserBots(userId) {
    for (const inst of this.instances.values()) {
      if (inst.userId === userId) {
        inst.updateConfig({ plan_tier: "free" });
      }
    }
    logger.info({ userId }, "[BotManager] downgradeUserBots — plan_tier set to free for all running bots");
  }

  /**
   * Send a message via a bot instance. Options: { persist: boolean }
   * If persist is false, the instance will not write activity/usage to DB.
   */
  async sendMessage(botId, to, text, options = { persist: true }) {
    const inst = this.instances.get(botId);
    if (!inst) throw new Error("Bot instance not found.");
    await inst.sendMessage(to, text, options);
  }

  async getAdminGroups(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return [];
    return inst.getAdminGroups();
  }

  /* ── SSE ──────────────────────────────────────────────────── */

  addSseClient(botId, res) {
    if (!this.sseClients.has(botId)) this.sseClients.set(botId, new Set());
    this.sseClients.get(botId).add(res);
    const qr = this.getQR(botId);
    if (qr) this._sendSse(res, { type: "qr", qrUrl: qr });
    const st = this.getStatus(botId);
    if (st) this._sendSse(res, { type: "status", status: st });
  }

  removeSseClient(botId, res) { this.sseClients.get(botId)?.delete(res); }

  _broadcast(botId, payload) {
    const clients = this.sseClients.get(botId);
    if (clients?.size) for (const res of clients) this._sendSse(res, payload);
  }

  _sendSse(res, payload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      /* Flush for proxied environments (Nginx, Replit, etc.) */
      if (typeof res.flush === "function") res.flush();
    } catch {}
  }

  _closeSseClients(botId) {
    const clients = this.sseClients.get(botId);
    if (clients) {
      for (const res of clients) { try { res.end(); } catch {} }
      this.sseClients.delete(botId);
    }
  }
}

export const botManager = new BotManager();
