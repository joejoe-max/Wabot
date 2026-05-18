/**
 * BotInstance — manages a single WhatsApp bot via @whiskeysockets/baileys.
 *
 * Features:
 *  - Bot type routing: dm | group | all
 *  - All WhatsApp message format extraction
 *  - Default commands (/help /catalog /price /contact /stop /agent /hours /order)
 *  - Group management commands (.help .kick .ban .lock .unlock .promote .demote
 *    .warn .warnings .clearwarn .tagall) — require bot + sender to be admin
 *  - Group moderation: anti-link, anti-spam, anti-vulgar (word filter)
 *  - 3-strike auto-removal system
 *  - First-DM auto-help (send /help menu on first contact)
 *  - Keyword triggers with exact/partial/regex match
 *  - Sales agent: product catalog, greeting, "not available" fallback
 *  - AI integration: OpenAI, Gemini
 *  - Webhook forwarding with HMAC signature
 *  - Auto-reconnect on transient disconnects
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import { Boom }          from "@hapi/boom";
import QRCode            from "qrcode";
import { createSupabaseAuthState, clearSupabaseSession } from "./SupabaseStore.js";
import { MessageQueue }  from "./MessageQueue.js";
import { supabase }      from "../../lib/supabase.js";
import { logger }        from "../../utils/logger.js";
import { env }           from "../../config/env.js";
import { getAiCompletion, decryptApiKey } from "../ai/AiService.js";

const PLAN_MSG_LIMITS = { free: 1_000, paid: 100_000 };

/* ── Default built-in DM commands ───────────────────────────── */
const DEFAULT_COMMANDS = {
  help:    { trigger: "/help",    proOnly: false },
  catalog: { trigger: "/catalog", proOnly: false },
  price:   { trigger: "/price",   proOnly: false },
  contact: { trigger: "/contact", proOnly: false },
  stop:    { trigger: "/stop",    proOnly: false },
  agent:   { trigger: "/agent",   proOnly: false },
  hours:   { trigger: "/hours",   proOnly: false },
  order:   { trigger: "/order",   proOnly: false }
};

/* ── Group management commands (dot-prefix) ─────────────────── */
const GROUP_COMMANDS = [
  ".help", ".kick", ".ban", ".lock", ".unlock",
  ".promote", ".demote", ".warn", ".warnings", ".clearwarn",
  ".tagall", ".rules", ".admins"
];

/* ── Link / invite detection regex ─────────────────────────── */
const LINK_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+|bit\.ly\/[^\s]+)/i;

/* ── Group metadata cache TTL (ms) ─────────────────────────── */
const META_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

/* ── Reconnect / QR lifecycle constants ─────────────────────── */
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_MS      = 2_000;
const RECONNECT_MAX_MS       = 30_000;
const QR_TIMEOUT_MS          = 2 * 60_000; // 2 minutes — then stop to avoid ban

/* ── Normalise device-scoped JID to plain user JID ─────────── */
function normalizeJid(jid = "") {
  return jid.replace(/:\d+@/, "@").toLowerCase();
}

/* ── Extract readable text from any WhatsApp message type ───── */
function extractMessageBody(msg) {
  const m = msg.message;
  if (!m) return { text: "", type: "unknown", extra: {} };

  const inner = m.viewOnceMessage?.message
    ?? m.viewOnceMessageV2?.message
    ?? m.ephemeralMessage?.message
    ?? m;

  if (inner.conversation)
    return { text: inner.conversation.trim(), type: "text", extra: {} };

  if (inner.extendedTextMessage)
    return { text: (inner.extendedTextMessage.text ?? "").trim(), type: "text", extra: {
      quotedMsg:    inner.extendedTextMessage.contextInfo?.quotedMessage ?? null,
      mentionedJid: inner.extendedTextMessage.contextInfo?.mentionedJid ?? [],
      quotedParticipant: inner.extendedTextMessage.contextInfo?.participant ?? null
    }};

  if (inner.imageMessage)
    return { text: (inner.imageMessage.caption ?? "").trim(), type: "image", extra: {
      caption: inner.imageMessage.caption, mimetype: inner.imageMessage.mimetype
    }};

  if (inner.videoMessage)
    return { text: (inner.videoMessage.caption ?? "").trim(), type: "video", extra: {
      caption: inner.videoMessage.caption
    }};

  if (inner.documentMessage)
    return { text: (inner.documentMessage.caption ?? inner.documentMessage.fileName ?? "").trim(), type: "document", extra: {
      fileName: inner.documentMessage.fileName, mimetype: inner.documentMessage.mimetype
    }};

  if (inner.audioMessage)
    return { text: "", type: inner.audioMessage.ptt ? "voice_note" : "audio", extra: {} };

  if (inner.stickerMessage)
    return { text: "", type: "sticker", extra: {} };

  if (inner.locationMessage)
    return { text: "📍 Location shared", type: "location", extra: {
      lat: inner.locationMessage.degreesLatitude,
      lng: inner.locationMessage.degreesLongitude,
      name: inner.locationMessage.name
    }};

  if (inner.contactMessage)
    return { text: inner.contactMessage.displayName ?? "Contact shared", type: "contact", extra: {} };

  if (inner.contactsArrayMessage)
    return { text: `${inner.contactsArrayMessage.contacts?.length ?? 0} contacts shared`, type: "contacts", extra: {} };

  if (inner.reactionMessage)
    return { text: inner.reactionMessage.text ?? "👍", type: "reaction", extra: {} };

  if (inner.listResponseMessage)
    return { text: inner.listResponseMessage.singleSelectReply?.selectedRowId ?? "", type: "list_reply", extra: {
      title: inner.listResponseMessage.title
    }};

  if (inner.buttonsResponseMessage)
    return { text: inner.buttonsResponseMessage.selectedButtonId ?? "", type: "button_reply", extra: {
      displayText: inner.buttonsResponseMessage.selectedDisplayText
    }};

  if (inner.templateButtonReplyMessage)
    return { text: inner.templateButtonReplyMessage.selectedId ?? "", type: "template_reply", extra: {} };

  if (inner.orderMessage)
    return { text: "🛒 Order received", type: "order", extra: {
      itemCount: inner.orderMessage.itemCount
    }};

  if (inner.pollUpdateMessage || inner.pollCreationMessage)
    return { text: "📊 Poll", type: "poll", extra: {} };

  return { text: "", type: "unknown", extra: {} };
}

/* ── Format product catalog as text ─────────────────────────── */
function formatCatalog(products = []) {
  if (!products.length) return null;
  const lines = ["📦 *Our Products:*\n"];
  products.forEach((p, i) => {
    lines.push(`${i + 1}. *${p.name}*`);
    if (p.price) lines.push(`   💰 ₦${p.price}`);
    if (p.description) lines.push(`   ${p.description}`);
  });
  lines.push("\nSend a product name or number to enquire.");
  return lines.join("\n");
}

export class BotInstance {
  constructor(botId, userId, config = {}) {
    this.botId   = botId;
    this.userId  = userId;
    this.config  = {
      plan_tier:               "free",
      bot_type:                "dm",
      keyword_triggers:        [],
      sales_agent_config:      {},
      commands_config:         {},
      ai_config:               {},
      group_management_config: {},
      website_url:             null,
      catalog_unavail_msg:     null,
      ...config
    };
    this.socket  = null;
    this.status  = "connecting";
    this.qrCode  = null;
    this._destroyed           = false;
    this._reconnectTimer      = null;
    this._reconnectAttempts   = 0;
    this._qrTimeoutTimer      = null;
    this._queue               = new MessageQueue(botId);
    this._flushTimer          = null;
    this._logFlushTimer       = null;
    this._usageFlushInFlight  = false;
    this._logFlushInFlight    = false;
    this._onQR     = new Set();
    this._onStatus = new Set();
    this._onPair   = new Set();
    this._pendingUsage = { messagesThisMonth: 0, totalMessages: 0, lastActivity: null };
    this._pendingLogs  = [];
    this._isPairingMode = false; // ✅ Flag to prevent QR from overriding pairing mode

    /* ── Group management in-memory state ─────────────────── */
    // Strike counts for moderation actions (anti-link/spam/vulgar)
    this._strikes       = new Map(); // `${groupJid}:${userJid}` → count
    // Manual warn counts (.warn command)
    this._warnCount     = new Map(); // `${groupJid}:${userJid}` → count
    // Spam tracking: timestamps of recent messages
    this._spamTracker   = new Map(); // `${groupJid}:${userJid}` → [timestamps]
    // Group metadata cache
    this._metaCache     = new Map(); // groupJid → { meta, cachedAt }
    // DM contacts who've already received auto-help
    this._seenDmContacts = new Set();
    // DM contacts who've already received a sales welcome message
    this._welcomedDmContacts = new Set();
  }

  onQR(cb)     { this._onQR.add(cb);     return () => this._onQR.delete(cb); }
  onPairCode(cb) { this._onPair.add(cb); return () => this._onPair.delete(cb); }
  onStatus(cb) { this._onStatus.add(cb); return () => this._onStatus.delete(cb); }
  updateConfig(patch) { this.config = { ...this.config, ...patch }; }

  /* ── Helper: Increment user's monthly counter in DB ───────── */
  async _incrementUserMonthlyCounter() {
    try {
      await supabase.rpc("increment_user_messages", { uid: this.userId });
    } catch (err) {
      // Fallback if RPC doesn't exist
      const { data: user } = await supabase
        .from("users")
        .select("messages_this_month")
        .eq("id", this.userId)
        .single();
      
      if (user) {
        await supabase
          .from("users")
          .update({ messages_this_month: (user.messages_this_month ?? 0) + 1 })
          .eq("id", this.userId);
      }
    }
  }

  /* ── Start / stop ─────────────────────────────────────────── */

  async start() {
    if (this._destroyed) return;
    try {
      if (this.socket) {
        try { this.socket.end(undefined); } catch {}
      }
      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        /* Network issue fetching latest version — fall back to last known good */
        version = [2, 3000, 1035194821];
        logger.warn({ botId: this.botId }, "fetchLatestBaileysVersion failed — using fallback version");
      }
      const { state, saveCreds } = await createSupabaseAuthState(this.botId);

      this.socket = makeWASocket({
        version,
        auth:           state,
        printQRInTerminal: false,
        browser:        ["WaBot", "Chrome", "1.0.0"],
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
      });

      this.socket.ev.on("creds.update", saveCreds);

      this.socket.ev.on("connection.update", (update) =>
        this._onConnectionUpdate(update));

      // expose requestPairingCode if available on socket
      if (this.socket.requestPairingCode) {
        // nothing to do now — method will be called when requested
      }

      this.socket.ev.on("messages.upsert", (upsert) =>
        this._onMessages(upsert));

      this.socket.ev.on("group-participants.update", (update) =>
        this._onGroupParticipants(update));

    } catch (err) {
      logger.error({ err, botId: this.botId }, "BotInstance.start failed");
      if (!this._destroyed) this._scheduleReconnect();
    }
  }

  async stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._qrTimeoutTimer);
    this._queue.destroy();
    await this._flushPendingUsage();
    await this._flushLogs();
    try { this.socket?.end(undefined); } catch {}
    if (this._flushTimer) clearTimeout(this._flushTimer);
    if (this._logFlushTimer) clearTimeout(this._logFlushTimer);
  }

  async sendMessage(to, text, options = { persist: true }) {
    if (!this.socket) throw new Error("Bot is not connected.");
    if (this.status !== "connected") throw new Error("Bot is not connected. Check bot status and try again.");
    const jid = to.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    await this._queue.send(async () => {
      try {
        // Support sending a plain text string or an object describing media
        if (typeof text === "string") {
          await this.socket.sendMessage(jid, { text });
        } else if (text && typeof text === "object" && text.media) {
          const m = text.media;
          // Expect media: { type: 'image'|'video'|'document', url, caption, fileName }
          if (m.type === "image") {
            await this.socket.sendMessage(jid, { image: { url: m.url }, caption: m.caption ?? undefined });
          } else if (m.type === "video") {
            await this.socket.sendMessage(jid, { video: { url: m.url }, caption: m.caption ?? undefined });
          } else if (m.type === "document") {
            await this.socket.sendMessage(jid, { document: { url: m.url }, fileName: m.fileName ?? undefined, mimetype: m.mimetype ?? undefined, caption: m.caption ?? undefined });
          } else {
            throw new Error("Unsupported media type");
          }
        } else {
          throw new Error("Invalid message payload");
        }
      } catch (err) {
        logger.error({ err, botId: this.botId, to }, "sendMessage failed");
        throw err;
      }
    });
    if (options.persist !== false) {
      this._queueUsage({ totalMessages: 1, lastActivity: new Date().toISOString() });
      await this._log("dm_sent", `Message sent to ${to}`);
    }
  }

  /* ── Connection update (FIXED: Pairing mode prevents QR) ──── */

  async _onConnectionUpdate({ connection, lastDisconnect, qr }) {
    // Clear any outstanding pair codes on open
    if (connection === "open") {
      try {
        for (const cb of this._onPair) cb(null);
      } catch {}
    }
    
    // ✅ SKIP QR if we're in pairing mode - this prevents QR from overriding pairing
    if (qr && !this._isPairingMode) {
      try {
        this.qrCode = await QRCode.toDataURL(qr);
        for (const cb of this._onQR) cb(this.qrCode);
        await this._setStatus("awaiting_qr_scan");
        this._startQrTimeout();
      } catch (err) {
        logger.error({ err, botId: this.botId }, "QR generation failed");
      }
    }

    if (connection === "open") {
      this._clearQrTimeout();
      this._reconnectAttempts = 0;
      this.qrCode = null;
      this._isPairingMode = false; // ✅ Reset pairing mode on successful connection
      await this._setStatus("connected");
      await this._log("bot_connected", "WhatsApp connection established");
    }

    if (connection === "close") {
      this._clearQrTimeout();
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : undefined;

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        await clearSupabaseSession(this.botId);
        await this._setStatus("disconnected");
        await this._log("bot_disconnected", "Logged out — QR scan required to reconnect");
        return;
      }

      // Inspect error payload for conflict/device_removed hints (Baileys stream errors)
      try {
        const raw = lastDisconnect?.error ?? null;
        const text = raw ? JSON.stringify(raw) : "";
        if (text.includes("device_removed") || text.includes("conflict") || text.includes("device_revoked")) {
          logger.error({ botId: this.botId, lastDisconnect }, "Detected device_removed/conflict — clearing session");
          await clearSupabaseSession(this.botId);
          await this._setStatus("disconnected");
          await this._log("bot_disconnected", "Session removed by WhatsApp (device removed/conflict) — QR scan required to reconnect");
          return;
        }
      } catch (e) { /* ignore JSON errors */ }

      if (!this._destroyed) {
        this._scheduleReconnect();
      }
    }
  }

  /* ── FIXED: requestPairingCode sets pairing mode and status ── */
  async requestPairingCode(phone) {
    if (!this.socket) throw new Error("Bot socket not started.");
    if (!this.socket.requestPairingCode) throw new Error("Pairing not supported by this Baileys version.");
    
    // ✅ Set pairing mode flag to prevent QR from taking over
    this._isPairingMode = true;
    
    // ✅ Set status to awaiting_pairing
    await this._setStatus("awaiting_pairing");
    
    try {
      const code = await this.socket.requestPairingCode(phone);
      this._lastPairingCode = code; // Store for SSE clients
      for (const cb of this._onPair) cb(code);
      return code;
    } catch (err) {
      this._isPairingMode = false; // Reset on error
      logger.error({ err, botId: this.botId }, "requestPairingCode failed");
      throw err;
    }
  }

  /* ── Exponential backoff reconnect ────────────────────────── */

  _scheduleReconnect() {
    if (this._destroyed) return;
    this._reconnectAttempts++;

    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { botId: this.botId, attempts: this._reconnectAttempts },
        "Max reconnect attempts reached — marking bot as failed"
      );
      this._setStatus("failed").catch(() => {});
      this._log(
        "bot_error",
        `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Open bot settings → QR tab to manually reconnect.`
      ).catch(() => {});
      return;
    }

    const jitter  = Math.random() * 1_000;
    const backoff = RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts - 1);
    const delayMs = Math.min(RECONNECT_MAX_MS, backoff) + jitter;

    logger.info(
      { botId: this.botId, attempt: this._reconnectAttempts, max: MAX_RECONNECT_ATTEMPTS, delayMs: Math.round(delayMs) },
      "Scheduling reconnect with exponential backoff"
    );

    this._setStatus("connecting").catch(() => {});
    this._log(
      "bot_reconnecting",
      `Reconnect attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} — retrying in ${(delayMs / 1000).toFixed(1)}s`
    ).catch(() => {});

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this._destroyed) this.start();
    }, delayMs);
  }

  /* ── QR timeout — halt after 2 min to prevent ban signals ── */

  _startQrTimeout() {
    this._clearQrTimeout();
    this._qrTimeoutTimer = setTimeout(async () => {
      if (this._destroyed || this.status !== "awaiting_qr_scan") return;
      logger.warn({ botId: this.botId }, "QR scan timeout (2 min) — stopping socket");
      try { this.socket?.end(undefined); } catch {}
      await this._setStatus("disconnected").catch(() => {});
      await this._log(
        "bot_qr_timeout",
        "QR code was not scanned within 2 minutes. Open bot settings → QR tab and click Reconnect to try again."
      ).catch(() => {});
    }, QR_TIMEOUT_MS);
  }

  _clearQrTimeout() {
    if (this._qrTimeoutTimer) {
      clearTimeout(this._qrTimeoutTimer);
      this._qrTimeoutTimer = null;
    }
  }

  /* ── Group participant events ─────────────────────────────── */

  async _onGroupParticipants({ id, participants, action }) {
    if (this.config.bot_type === "dm") return;
    const sac = this.config.sales_agent_config ?? {};

    for (const jid of participants) {
      if (action === "add" && sac.group_welcome && this.socket) {
        try {
          await this.socket.sendMessage(id, {
            text: sac.group_welcome.replace("{name}", jid.replace("@s.whatsapp.net", ""))
          });
        } catch {}
      }
    }
  }

  /* ── Message routing ──────────────────────────────────────── */

  async _onMessages({ messages, type }) {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      try {
        await this._handleInbound(msg);
      } catch (err) {
        // Do not let a single message failure crash the instance (e.g. decrypt errors)
        logger.warn({ err, botId: this.botId, msgId: msg.key?.id }, "Failed to process inbound message — skipping");
        continue;
      }
    }
  }

  async _handleInbound(msg) {
    const jid       = msg.key.remoteJid ?? "";
    const isGroup   = jid.endsWith("@g.us");
    const isDM      = jid.endsWith("@s.whatsapp.net");
    const botType   = this.config.bot_type ?? "dm";

    /* ── Route by bot type ─────────────────────────────────── */
    if (botType === "dm"    && !isDM)    return;
    if (botType === "group" && !isGroup) return;

    /* ── Sender JID ────────────────────────────────────────── */
    const senderJid = isGroup
      ? normalizeJid(msg.key.participant ?? "")
      : normalizeJid(jid);

    /* ── Extract message body ──────────────────────────────── */
    const { text: body, type: msgType, extra } = extractMessageBody(msg);

    /* ── Plan message limit check (incoming messages count toward limit) ── */
    const limit = PLAN_MSG_LIMITS[this.config.plan_tier] ?? PLAN_MSG_LIMITS.free;
    
    // Fetch current usage from DB to ensure accuracy across multiple bots
    const { data: user } = await supabase
      .from("users")
      .select("messages_this_month, plan_tier")
      .eq("id", this.userId)
      .single();
    
    const currentUsage = user?.messages_this_month ?? 0;
    
    if (currentUsage >= limit) {
      logger.warn({ botId: this.botId, userId: this.userId, usage: currentUsage, limit }, "Monthly message limit reached — dropping incoming message");
      return; // Silently drop the message, don't process or reply
    }

    /* ── Increment counter for this incoming message (since it will trigger an outgoing reply) ── */
    await this._incrementUserMonthlyCounter();
    this.config.messages_this_month = (this.config.messages_this_month ?? 0) + 1;
    
    this._queueUsage({
      messagesThisMonth: 1,
      totalMessages: 1,
      lastActivity: new Date().toISOString()
    });

    const fromDisplay = isGroup ? jid : jid.replace("@s.whatsapp.net", "");
    await this._log("message_received", `[${msgType}] from ${fromDisplay}`, { from: jid, body: body.slice(0, 200), type: msgType, extra });

    /* ── Webhook (always) ────────────────────────────────────── */
    if (this.config.webhook_url) {
      this._sendWebhook({
        event:    "message_received",
        botId:    this.botId,
        from:     fromDisplay,
        body,
        type:     msgType,
        isGroup,
        extra,
        timestamp: Date.now()
      }).catch(() => {});
    }

    /* For non-text types with no body, skip auto-reply logic */
    if (!body && !["list_reply", "button_reply", "template_reply"].includes(msgType)) return;

    /* ── GROUP FLOW ─────────────────────────────────────────── */
    if (isGroup) {
      /* Check bot is admin — if not, silently skip ALL group handling */
      const botIsAdmin = await this._isBotAdmin(jid);
      if (!botIsAdmin) return;

      /* Group moderation (anti-link / anti-spam / anti-vulgar) */
      const moderated = await this._handleGroupModeration(msg, jid, senderJid, body);
      if (moderated) return;

      /* Group management commands (.kick .ban .help etc.) */
      if (await this._handleGroupCommand(msg, jid, senderJid, body, extra)) return;

      /* Regular features also work in groups */
      if (await this._handleCommand(jid, body)) return;
      if (await this._handleKeywordTrigger(jid, body)) return;
      if (await this._handleSalesAgent(jid, body)) return;
      if (await this._handleAiResponse(jid, body, extra, true)) return;
      return; /* No auto-reply fallback in groups */
    }

    /* ── DM FLOW ────────────────────────────────────────────── */
    await this._handleWelcomeMessage(jid);

    /* First-DM auto-help */
    await this._handleFirstDmHelp(jid);

    if (await this._handleCommand(jid, body)) return;
    if (await this._handleKeywordTrigger(jid, body)) return;
    if (await this._handleSalesAgent(jid, body)) return;
    if (await this._handleAiResponse(jid, body, extra, false)) return;

    /* Standard auto-reply */
    if (this.config.auto_reply_enabled && this.config.auto_reply_message && this.socket) {
      try {
        await this.socket.sendMessage(jid, { text: this.config.auto_reply_message });
        await this._log("auto_reply_sent", `Auto-reply sent to ${fromDisplay}`);
      } catch (err) {
        logger.error({ err, botId: this.botId }, "Auto-reply failed");
      }
    }
  }

  /* ── First-DM auto-help ───────────────────────────────────── */

  async _handleFirstDmHelp(jid) {
    const gmc = this.config.group_management_config ?? {};
    if (!gmc.auto_help_on_first_dm) return;
    if (this._seenDmContacts.has(jid)) return;
    this._seenDmContacts.add(jid);

    /* Build help text (same as /help command) */
    const enabledCmds = Object.entries(DEFAULT_COMMANDS)
      .filter(([k]) => (this.config.commands_config?.[k]?.enabled ?? true))
      .map(([, v]) => v.trigger);

    const helpText = `👋 *Welcome!*\n\nHere are the available commands:\n${enabledCmds.join("\n")}\n\nReply with any command to get started.`;
    try {
      await this.socket?.sendMessage(jid, { text: helpText });
    } catch {}
  }

  async _handleWelcomeMessage(jid) {
    const sac = this.config.sales_agent_config ?? {};
    if (!sac.enabled || !sac.welcome_enabled) return;
    if (!String(sac.greeting ?? "").trim()) return;
    if (this._welcomedDmContacts.has(jid)) return;

    this._welcomedDmContacts.add(jid);
    try {
      await this.socket?.sendMessage(jid, { text: String(sac.greeting).trim() });
      await this._log("welcome_message_sent", `Welcome message sent to ${jid.replace("@s.whatsapp.net", "")}`);
    } catch {}
  }

  /* ── Group: fetch admin groups (used by API route) ─────────── */

  async getAdminGroups() {
    if (!this.socket || this.status !== "connected") return [];
    try {
      const groups  = await this.socket.groupFetchAllParticipating();
      const botJid  = normalizeJid(this.socket.user?.id ?? "");
      return Object.values(groups).filter((g) => {
        const p = g.participants.find((p) =>
          normalizeJid(p.id) === botJid ||
          normalizeJid(p.id).split("@")[0] === botJid.split("@")[0]
        );
        return p?.admin === "admin" || p?.admin === "superadmin";
      });
    } catch { return []; }
  }

  /* ── Group metadata (cached) ─────────────────────────────── */

  async _getGroupMeta(groupJid) {
    const cached = this._metaCache.get(groupJid);
    if (cached && (Date.now() - cached.cachedAt) < META_CACHE_TTL) return cached.meta;
    try {
      const meta = await this.socket.groupMetadata(groupJid);
      this._metaCache.set(groupJid, { meta, cachedAt: Date.now() });
      return meta;
    } catch { return null; }
  }

  async _isBotAdmin(groupJid) {
    const meta   = await this._getGroupMeta(groupJid);
    if (!meta) return false;
    const botJid = normalizeJid(this.socket?.user?.id ?? "");
    return meta.participants.some((p) => {
      const pNorm = normalizeJid(p.id);
      return (pNorm === botJid || pNorm.split("@")[0] === botJid.split("@")[0])
        && (p.admin === "admin" || p.admin === "superadmin");
    });
  }

  async _isSenderAdmin(groupJid, senderJid) {
    const meta  = await this._getGroupMeta(groupJid);
    if (!meta) return false;
    const p = meta.participants.find((p) => normalizeJid(p.id) === senderJid);
    return p?.admin === "admin" || p?.admin === "superadmin";
  }

  /* ── Strike helper ───────────────────────────────────────── */

  _addStrike(groupJid, userJid) {
    const key = `${groupJid}:${userJid}`;
    const n   = (this._strikes.get(key) ?? 0) + 1;
    this._strikes.set(key, n);
    return n;
  }

  _getStrikes(groupJid, userJid) {
    return this._strikes.get(`${groupJid}:${userJid}`) ?? 0;
  }

  _clearStrikes(groupJid, userJid) {
    this._strikes.delete(`${groupJid}:${userJid}`);
  }

  /* ── Group moderation ─────────────────────────────────────── */

  async _handleGroupModeration(msg, groupJid, senderJid, body) {
    const gmc = this.config.group_management_config ?? {};
    const senderIsAdmin = await this._isSenderAdmin(groupJid, senderJid);
    if (senderIsAdmin) return false; /* Admins are exempt from all moderation */

    let violated  = false;
    let reason    = "";

    /* ── Anti-link ─────────────────────────────────────────── */
    if (gmc.anti_link?.enabled && LINK_REGEX.test(body)) {
      violated = true;
      reason   = "anti-link";
      /* Delete the message */
      try { await this.socket?.sendMessage(groupJid, { delete: msg.key }); } catch {}
    }

    /* ── Anti-vulgar ────────────────────────────────────────── */
    if (!violated && gmc.anti_vulgar?.enabled) {
      const words   = Array.isArray(gmc.anti_vulgar.words) ? gmc.anti_vulgar.words : [];
      const bodyLow = body.toLowerCase();
      const found   = words.find((w) => w && bodyLow.includes(String(w).toLowerCase()));
      if (found) {
        violated = true;
        reason   = "anti-vulgar";
        try { await this.socket?.sendMessage(groupJid, { delete: msg.key }); } catch {}
      }
    }

    /* ── Anti-spam ──────────────────────────────────────────── */
    if (!violated && gmc.anti_spam?.enabled) {
      const threshold = gmc.anti_spam.threshold    ?? 5;
      const window    = (gmc.anti_spam.window_seconds ?? 10) * 1000;
      const now       = Date.now();
      const key       = `${groupJid}:${senderJid}`;
      const times     = (this._spamTracker.get(key) ?? []).filter((t) => now - t < window);
      times.push(now);
      this._spamTracker.set(key, times);
      if (times.length >= threshold) {
        violated = true;
        reason   = "anti-spam";
        this._spamTracker.set(key, []); /* Reset after triggering */
      }
    }

    if (!violated) return false;

    /* ── Apply action ───────────────────────────────────────── */
    const action    = gmc[reason.replace("-", "_")]?.action ?? gmc.anti_link?.action ?? "warn";
    const strikes   = this._addStrike(groupJid, senderJid);
    const shortJid  = senderJid.replace("@s.whatsapp.net", "");
    const maxStrikes = 3;

    if (action === "kick" || strikes >= maxStrikes) {
      /* Remove from group */
      try {
        await this.socket?.groupParticipantsUpdate(groupJid, [senderJid], "remove");
        await this.socket?.sendMessage(groupJid, {
          text: `🚫 @${shortJid} has been removed for violating group rules (${reason}).`,
          mentions: [senderJid]
        });
        this._clearStrikes(groupJid, senderJid);
        await this._log("group_moderation", `Removed @${shortJid} — ${reason} (${strikes} strikes)`, { groupJid, senderJid });
      } catch (err) {
        logger.error({ err }, "Group kick failed");
      }
    } else {
      /* Warn */
      try {
        await this.socket?.sendMessage(groupJid, {
          text: `⚠️ @${shortJid}, this message was removed (${reason}). Strike *${strikes}/${maxStrikes}*. You will be removed after ${maxStrikes} strikes.`,
          mentions: [senderJid]
        });
        await this._log("group_moderation", `Warned @${shortJid} — ${reason} strike ${strikes}/${maxStrikes}`, { groupJid, senderJid });
      } catch {}
    }

    return true;
  }

  /* ── Group management commands ────────────────────────────── */

  async _handleGroupCommand(msg, groupJid, senderJid, body, extra = {}) {
    const lower = body.trim().toLowerCase();
    const isGCmd = GROUP_COMMANDS.some((c) => lower === c || lower.startsWith(c + " ") || lower.startsWith(c + "@"));
    if (!isGCmd) return false;

    const parts      = body.trim().split(/\s+/);
    const cmd        = parts[0].toLowerCase();
    const mentioned  = Array.isArray(extra.mentionedJid) ? extra.mentionedJid : [];
    const targetJid  = mentioned[0] ?? extra.quotedParticipant ?? null;
    const shortTarget = targetJid ? targetJid.replace("@s.whatsapp.net", "") : null;

    const senderIsAdmin = await this._isSenderAdmin(groupJid, senderJid);

    /* .help is open to all group members */
    if (cmd === ".help") {
      const gmc = this.config.group_management_config ?? {};
      const lines = [
        "*📋 Group Commands*",
        "",
        "*.help* — Show this list",
        "*.kick @user* — Remove a member (admin)",
        "*.ban @user* — Remove a member (admin)",
        "*.lock* — Lock group (admins only can send)",
        "*.unlock* — Allow all members to send",
        "*.promote @user* — Make someone an admin",
        "*.demote @user* — Remove someone's admin role",
        "*.warn @user [reason]* — Warn a member",
        "*.warnings @user* — Check someone's warnings",
        "*.clearwarn @user* — Clear someone's warnings",
        "*.tagall [msg]* — Mention all members",
        "*.admins* — List group admins",
        "*.rules* — Show group rules",
        "",
        "*🛡 Auto-moderation*",
      ];
      if (gmc.anti_link?.enabled)   lines.push("• Anti-link: ON — links from non-admins are removed");
      if (gmc.anti_spam?.enabled)   lines.push("• Anti-spam: ON — excessive messages trigger a warning");
      if (gmc.anti_vulgar?.enabled) lines.push("• Anti-vulgar: ON — profanity is filtered");
      if (!gmc.anti_link?.enabled && !gmc.anti_spam?.enabled && !gmc.anti_vulgar?.enabled)
        lines.push("• No auto-moderation enabled");
      lines.push("", "3 strikes → automatic removal");

      try {
        await this.socket?.sendMessage(groupJid, { text: lines.join("\n") });
      } catch {}
      return true;
    }

    /* All other commands require sender to be admin */
    if (!senderIsAdmin) {
      try {
        await this.socket?.sendMessage(groupJid, {
          text: `⛔ @${senderJid.replace("@s.whatsapp.net", "")}, only group admins can use that command.`,
          mentions: [senderJid]
        });
      } catch {}
      return true;
    }

    switch (cmd) {
      /* ── .kick / .ban ─────────────────────────────────────── */
      case ".kick":
      case ".ban": {
        if (!targetJid) {
          await this.socket?.sendMessage(groupJid, { text: `❌ Usage: ${cmd} @user` }).catch(() => {});
          return true;
        }
        try {
          await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "remove");
          await this.socket?.sendMessage(groupJid, {
            text: `✅ @${shortTarget} has been removed from the group.`,
            mentions: [targetJid]
          });
          await this._log("group_command", `${cmd}: removed @${shortTarget}`, { groupJid, targetJid });
        } catch (err) {
          await this.socket?.sendMessage(groupJid, { text: `❌ Could not remove @${shortTarget}. Make sure I am an admin.`, mentions: [targetJid] }).catch(() => {});
        }
        break;
      }

      /* ── .lock ─────────────────────────────────────────────── */
      case ".lock": {
        try {
          await this.socket?.groupSettingUpdate(groupJid, "announcement");
          await this.socket?.sendMessage(groupJid, { text: "🔒 Group is now *locked*. Only admins can send messages." });
          await this._log("group_command", "Group locked", { groupJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not lock the group. Ensure I have admin rights." }).catch(() => {});
        }
        break;
      }

      /* ── .unlock ───────────────────────────────────────────── */
      case ".unlock": {
        try {
          await this.socket?.groupSettingUpdate(groupJid, "not_announcement");
          await this.socket?.sendMessage(groupJid, { text: "🔓 Group is now *unlocked*. Everyone can send messages." });
          await this._log("group_command", "Group unlocked", { groupJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not unlock the group." }).catch(() => {});
        }
        break;
      }

      /* ── .promote ──────────────────────────────────────────── */
      case ".promote": {
        if (!targetJid) {
          await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .promote @user" }).catch(() => {});
          return true;
        }
        try {
          await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "promote");
          await this.socket?.sendMessage(groupJid, {
            text: `⬆️ @${shortTarget} has been promoted to admin.`,
            mentions: [targetJid]
          });
          this._metaCache.delete(groupJid); /* Invalidate cache */
          await this._log("group_command", `.promote @${shortTarget}`, { groupJid, targetJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: `❌ Could not promote @${shortTarget}.`, mentions: [targetJid] }).catch(() => {});
        }
        break;
      }

      /* ── .demote ───────────────────────────────────────────── */
      case ".demote": {
        if (!targetJid) {
          await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .demote @user" }).catch(() => {});
          return true;
        }
        try {
          await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "demote");
          await this.socket?.sendMessage(groupJid, {
            text: `⬇️ @${shortTarget} has been demoted from admin.`,
            mentions: [targetJid]
          });
          this._metaCache.delete(groupJid);
          await this._log("group_command", `.demote @${shortTarget}`, { groupJid, targetJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: `❌ Could not demote @${shortTarget}.`, mentions: [targetJid] }).catch(() => {});
        }
        break;
      }

      /* ── .warn ─────────────────────────────────────────────── */
      case ".warn": {
        if (!targetJid) {
          await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .warn @user [reason]" }).catch(() => {});
          return true;
        }
        const reason     = parts.slice(2).join(" ") || "No reason given";
        const wKey       = `${groupJid}:${targetJid}`;
        const warnCount  = (this._warnCount.get(wKey) ?? 0) + 1;
        this._warnCount.set(wKey, warnCount);
        const maxWarns   = 3;
        if (warnCount >= maxWarns) {
          try {
            await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "remove");
            await this.socket?.sendMessage(groupJid, {
              text: `🚫 @${shortTarget} has reached *${maxWarns} warnings* and has been removed.\nReason: ${reason}`,
              mentions: [targetJid]
            });
            this._warnCount.delete(wKey);
            await this._log("group_command", `.warn (removed) @${shortTarget}`, { groupJid, targetJid });
          } catch {
            await this.socket?.sendMessage(groupJid, { text: `❌ Could not remove @${shortTarget} after ${maxWarns} warnings.`, mentions: [targetJid] }).catch(() => {});
          }
        } else {
          await this.socket?.sendMessage(groupJid, {
            text: `⚠️ @${shortTarget} has been warned (*${warnCount}/${maxWarns}*).\nReason: ${reason}`,
            mentions: [targetJid]
          }).catch(() => {});
          await this._log("group_command", `.warn ${warnCount}/${maxWarns} @${shortTarget}`, { groupJid, targetJid });
        }
        break;
      }

      /* ── .warnings ─────────────────────────────────────────── */
      case ".warnings": {
        if (!targetJid) {
          await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .warnings @user" }).catch(() => {});
          return true;
        }
        const wCount = this._warnCount.get(`${groupJid}:${targetJid}`) ?? 0;
        await this.socket?.sendMessage(groupJid, {
          text: `📋 @${shortTarget} has *${wCount}/3* warnings.`,
          mentions: [targetJid]
        }).catch(() => {});
        break;
      }

      /* ── .clearwarn ────────────────────────────────────────── */
      case ".clearwarn": {
        if (!targetJid) {
          await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .clearwarn @user" }).catch(() => {});
          return true;
        }
        this._warnCount.delete(`${groupJid}:${targetJid}`);
        this._clearStrikes(groupJid, targetJid);
        await this.socket?.sendMessage(groupJid, {
          text: `✅ Warnings cleared for @${shortTarget}.`,
          mentions: [targetJid]
        }).catch(() => {});
        await this._log("group_command", `.clearwarn @${shortTarget}`, { groupJid, targetJid });
        break;
      }

      /* ── .tagall ───────────────────────────────────────────── */
      case ".tagall": {
        const customMsg = parts.slice(1).join(" ");
        try {
          const meta     = await this._getGroupMeta(groupJid);
          if (!meta) break;
          const members  = meta.participants.map((p) => p.id);
          const mentions = members.map((m) => `@${m.replace("@s.whatsapp.net", "")}`).join(" ");
          const text     = (customMsg ? `${customMsg}\n\n` : "") + mentions;
          await this.socket?.sendMessage(groupJid, { text, mentions: members });
          await this._log("group_command", `.tagall (${members.length} members)`, { groupJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not fetch group members." }).catch(() => {});
        }
        break;
      }

      /* ── .admins ───────────────────────────────────────────── */
      case ".admins": {
        try {
          const meta   = await this._getGroupMeta(groupJid);
          if (!meta) break;
          const admins = meta.participants.filter((p) => p.admin).map((p) => p.id);
          const mentions = admins.map((m) => `@${m.replace("@s.whatsapp.net", "")}`);
          await this.socket?.sendMessage(groupJid, {
            text: `👑 *Group Admins:*\n${mentions.join("\n")}`,
            mentions: admins
          });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not fetch admin list." }).catch(() => {});
        }
        break;
      }

      /* ── .rules ────────────────────────────────────────────── */
      case ".rules": {
        const gmc   = this.config.group_management_config ?? {};
        const rules = gmc.rules?.trim();
        await this.socket?.sendMessage(groupJid, {
          text: rules || "📜 No group rules have been set yet. Contact an admin."
        }).catch(() => {});
        break;
      }

      default: break;
    }

    return true;
  }

  /* ── DM Commands handler ──────────────────────────────────── */

  async _handleCommand(jid, body) {
    if (!body.startsWith("/")) return false;
    const cmd     = body.split(" ")[0].toLowerCase();
    const cmdKey  = Object.keys(DEFAULT_COMMANDS).find((k) => DEFAULT_COMMANDS[k].trigger === cmd);
    if (!cmdKey) return false;

    const override = this.config.commands_config?.[cmdKey] ?? {};
    if (override.enabled === false) return false;

    const sac      = this.config.sales_agent_config ?? {};
    const products = sac.products ?? [];

    if (override.custom_response) {
      await this.socket?.sendMessage(jid, { text: override.custom_response });
      await this._log("command_handled", `Command ${cmd} → custom response`);
      return true;
    }

    let reply = null;
    switch (cmdKey) {
      case "help": {
        const enabledCmds = Object.entries(DEFAULT_COMMANDS)
          .filter(([k]) => (this.config.commands_config?.[k]?.enabled ?? true))
          .map(([, v]) => v.trigger);
        reply = `*Available commands:*\n${enabledCmds.join("\n")}`;
        break;
      }
      case "catalog":
      case "price": {
        reply = products.length ? formatCatalog(products) : "No catalog available yet.";
        break;
      }
      case "contact":
        reply = "Our team will contact you shortly. Please hold on.";
        break;
      case "stop":
        reply = "You have unsubscribed. Send any message to re-subscribe.";
        break;
      case "agent":
        reply = "Connecting you to a live agent. Please wait…";
        break;
      case "hours":
        reply = "Business hours: Monday–Friday, 9am–6pm.";
        break;
      case "order":
        reply = this.config.website_url
          ? `To place an order, visit: ${this.config.website_url}`
          : "To order, please contact our sales team directly.";
        break;
    }

    if (reply) {
      try {
        await this.socket?.sendMessage(jid, { text: reply });
        await this._log("command_handled", `Command ${cmd}`);
      } catch (err) {
        logger.error({ err }, "Command reply failed");
      }
    }
    return true;
  }

  /* ── Keyword triggers ─────────────────────────────────────── */

  async _handleKeywordTrigger(jid, body) {
    const triggers = Array.isArray(this.config.keyword_triggers) ? this.config.keyword_triggers : [];
    if (triggers.length === 0) return false;

    for (const trigger of triggers) {
      if (!trigger.keyword || !trigger.response) continue;
      if (trigger.enabled === false) continue;

      const cs       = trigger.caseSensitive === true;
      const haystack = cs ? body : body.toLowerCase();
      const needle   = cs ? String(trigger.keyword).trim() : String(trigger.keyword).toLowerCase().trim();
      let matchType  = trigger.matchType ?? (trigger.exact_match === true ? "exact" : "contains");

      let hit = false;
      try {
        switch (matchType) {
          case "exact":       hit = haystack === needle; break;
          case "starts_with": hit = haystack.startsWith(needle); break;
          case "ends_with":   hit = haystack.endsWith(needle); break;
          case "regex": {
            const flags = cs ? "" : "i";
            hit = new RegExp(trigger.keyword, flags).test(body);
            break;
          }
          default:            hit = haystack.includes(needle); break;
        }
      } catch { hit = false; }

      if (hit) {
        try {
          await this.socket?.sendMessage(jid, { text: trigger.response });
          await this._log("keyword_reply_sent", `Keyword trigger matched: "${needle}" (${matchType})`);
        } catch {}
        return true;
      }
    }
    return false;
  }

  /* ── Sales agent ──────────────────────────────────────────── */

  async _handleSalesAgent(jid, body) {
    const sac = this.config.sales_agent_config ?? {};
    if (!sac.enabled) return false;

    const bodyL    = body.toLowerCase();
    const products = sac.products ?? [];

    if (sac.show_catalog_on_keyword) {
      const catalogKw = ["catalog", "products", "price", "menu", "catalogue", "list", "items", "stock", "available"];
      if (catalogKw.some((k) => bodyL.includes(k)) && products.length) {
        const catalog = formatCatalog(products);
        try { await this.socket?.sendMessage(jid, { text: catalog }); } catch {}
        return true;
      }
    }

    if (products.length && body.length > 1) {
      const match = products.find((p) => bodyL.includes(String(p.name).toLowerCase()));
      if (match) {
        const reply = `*${match.name}*\n💰 ₦${match.price || "Contact for price"}\n${match.description || ""}`;
        try { await this.socket?.sendMessage(jid, { text: reply }); } catch {}
        return true;
      }

      const productWords = ["buy", "order", "want", "price of", "how much", "get"];
      if (productWords.some((w) => bodyL.includes(w)) && !match) {
        const msg = this.config.catalog_unavail_msg
          ? this.config.catalog_unavail_msg
          : this.config.website_url
            ? `❌ Product not available. Check our website: ${this.config.website_url}`
            : "❌ Product not available in catalogue. Our seller will be in touch with you shortly.";
        try { await this.socket?.sendMessage(jid, { text: msg }); } catch {}
        return true;
      }
    }

    return false;
  }

  /* ── AI response (Pro only) ───────────────────────────────── */
  /*
   * trigger_mode (ai_config):
   *   "all"     — respond to every message (DM default, group opt-in)
   *   "mention" — respond only when bot is tagged/mentioned (group default)
   *   "keyword" — respond only when body starts with ai_config.trigger_prefix
   *               (default "@bot") — works in both DMs and groups
   *
   * In groups the default is "mention" to prevent flooding.
   * In DMs the default is "all" (preserves existing behaviour).
   */

  async _handleAiResponse(jid, body, extra = {}, isGroup = false) {
    const ai = this.config.ai_config ?? {};
    if (!ai.enabled || !ai.encrypted_key || this.config.plan_tier !== "paid") return false;
    if (!body?.trim()) return false;

    /* ── Per-channel enabled checks ───────────────────────── */
    /* ai.groups_enabled defaults to true (backward compat) unless explicitly false.
       ai.dm_enabled     defaults to true unless explicitly false.             */
    if (isGroup  && ai.groups_enabled === false) return false;
    if (!isGroup && ai.dm_enabled     === false) return false;

    /* ── Per-channel trigger mode ─────────────────────────── */
    /*
     * group_trigger_mode / dm_trigger_mode:
     *   "all"     — respond to every message
     *   "mention" — respond only when bot is @-tagged (group default)
     *   "keyword" — respond only when body starts with trigger_prefix
     *
     * Falls back to legacy trigger_mode, then channel-appropriate default.
     */
    const triggerMode = isGroup
      ? (ai.group_trigger_mode ?? ai.trigger_mode ?? "mention")
      : (ai.dm_trigger_mode    ?? ai.trigger_mode ?? "all");

    if (triggerMode === "mention") {
      const botJid      = normalizeJid(this.socket?.user?.id ?? "");
      const mentioned   = Array.isArray(extra?.mentionedJid) ? extra.mentionedJid : [];
      const botMentioned = mentioned.some((m) => normalizeJid(m) === botJid
        || normalizeJid(m).split("@")[0] === botJid.split("@")[0]);
      if (!botMentioned) return false;
    } else if (triggerMode === "keyword") {
      const prefix = (ai.trigger_prefix ?? "@bot").toLowerCase().trim();
      if (!body.toLowerCase().trimStart().startsWith(prefix)) return false;
      /* Strip the prefix from the message body before sending to AI */
      body = body.slice(body.toLowerCase().indexOf(prefix) + prefix.length).trim();
      if (!body) return false;
    }
    /* "all" mode falls through with no extra check */

    try {
      const apiKey = decryptApiKey(ai.encrypted_key, env.jwtSecret);
      if (!apiKey) return false;

      const sac      = this.config.sales_agent_config ?? {};
      const products = sac.products ?? [];
      const catalog  = products.length
        ? `\n\nProducts:\n${products.map((p) => `- ${p.name}: ₦${p.price || "?"} — ${p.description || ""}`).join("\n")}`
        : "";

      /* Use channel-specific system prompt when provided, fall back to shared prompt */
      const systemPrompt =
        (isGroup ? (ai.group_system_prompt || null) : null)
        ?? ai.system_prompt
        ?? `You are a helpful WhatsApp assistant for a business. Be concise and friendly. Answer in 1-3 sentences maximum.${catalog}`;

      const reply = await getAiCompletion({
        provider:    ai.provider,
        apiKey,
        model:       ai.model,
        systemPrompt,
        userMessage: body
      });

      if (reply) {
        await this.socket?.sendMessage(jid, { text: reply });
        await this._log("ai_reply_sent", `AI (${ai.provider}) replied to ${jid.replace("@s.whatsapp.net", "")}`);
        return true;
      }
    } catch (err) {
      logger.error({ err, botId: this.botId }, "AI response failed — falling through");
    }
    return false;
  }

  /* ── Webhook ──────────────────────────────────────────────── */

  async _sendWebhook(payload) {
    const body    = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "User-Agent": "WaBot-Webhook/2.0" };
    if (this.config.webhook_secret) {
      const { createHmac } = await import("node:crypto");
      headers["X-WaBot-Signature"] = "sha256=" + createHmac("sha256", this.config.webhook_secret).update(body).digest("hex");
    }
    const res = await fetch(this.config.webhook_url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    await this._log("webhook_sent", `Webhook → HTTP ${res.status}`);
  }

  /* ── Helpers ─────────────────────────────────────────────────*/

  _queueUsage(delta = {}) {
    this._pendingUsage.messagesThisMonth += Number(delta.messagesThisMonth ?? 0);
    this._pendingUsage.totalMessages += Number(delta.totalMessages ?? 0);
    this._pendingUsage.lastActivity = delta.lastActivity ?? this._pendingUsage.lastActivity;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushPendingUsage();
    }, 5000);
  }

  async _flushPendingUsage() {
    if (this._usageFlushInFlight) return;
    const pending = this._pendingUsage;
    if (!pending.messagesThisMonth && !pending.totalMessages && !pending.lastActivity) return;

    this._usageFlushInFlight = true;
    this._pendingUsage = { messagesThisMonth: 0, totalMessages: 0, lastActivity: null };

    const patch = {};
    if (pending.messagesThisMonth) patch.messages_this_month = Math.max(0, this.config.messages_this_month ?? 0);
    if (pending.lastActivity) patch.last_activity = pending.lastActivity;

    try {
      if (Object.keys(patch).length > 0) {
        await supabase.from("bots").update(patch).eq("id", this.botId);
      }
      if (pending.totalMessages > 0) {
        try {
          await supabase.rpc("increment_bot_messages_by", {
            bid: this.botId,
            amount: pending.totalMessages
          });
        } catch {
          // Fallback if RPC doesn't exist
          for (let i = 0; i < pending.totalMessages; i += 1) {
            try {
              await supabase.rpc("increment_bot_messages", { bid: this.botId });
            } catch {}
          }
        }
      }
    } catch (err) {
      logger.warn({ botId: this.botId, error: err.message }, "Failed to flush pending usage");
    } finally {
      this._usageFlushInFlight = false;
    }
  }

  _scheduleLogFlush() {
    if (this._pendingLogs.length >= 20) {
      this._flushLogs();
      return;
    }
    if (this._logFlushTimer) return;
    this._logFlushTimer = setTimeout(() => {
      this._logFlushTimer = null;
      this._flushLogs();
    }, 2000);
  }

  async _flushLogs() {
    if (this._logFlushInFlight || this._pendingLogs.length === 0) return;
    this._logFlushInFlight = true;
    const batch = this._pendingLogs.splice(0, this._pendingLogs.length);
    try {
      await supabase.from("bot_activity").insert(batch);
    } catch (err) {
      logger.warn({ botId: this.botId, error: err.message }, "Failed to insert activity logs");
    }
    this._logFlushInFlight = false;
  }

  async _setStatus(status) {
    if (this.status === status) return;
    
    const oldStatus = this.status;
    this.status = status;
    
    // Notify all status listeners
    for (const cb of this._onStatus) {
      try { cb(status); } catch (e) {}
    }
    
    // Update database - use try/catch instead of .catch()
    try {
      await supabase
        .from("bots")
        .update({ 
          status, 
          updated_at: new Date().toISOString() 
        })
        .eq("id", this.botId);
    } catch (err) {
      // Log error but don't crash the bot
      logger.warn({ 
        botId: this.botId, 
        oldStatus, 
        newStatus: status, 
        error: err.message 
      }, "Failed to update bot status in database");
    }
  }

  async _log(eventType, details, metadata = {}) {
    this._pendingLogs.push({
      user_id: this.userId,
      bot_id: this.botId,
      event_type: eventType,
      details,
      metadata
    });
    this._scheduleLogFlush();
  }
            }
