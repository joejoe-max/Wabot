import { useCallback, useEffect, useRef, useState } from "react";
import { Modal }       from "../ui/Modal.jsx";
import { Alert }       from "../ui/Alert.jsx";
import { Spinner }     from "../ui/Spinner.jsx";
import { StatusBadge } from "../ui/Badge.jsx";
import { botsApi }     from "../../api/bots.js";
import { fmtDate }     from "../../utils/format.js";

const AI_PROVIDERS = [
  { id: "openai",  name: "OpenAI",              logo: "🟢", models: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],                                applyUrl: "https://platform.openai.com/api-keys"   },
  { id: "gemini",  name: "Google Gemini",        logo: "🔵", models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],                applyUrl: "https://aistudio.google.com/apikey"     },
];

const DEFAULT_COMMANDS = [
  { key: "help",    trigger: "/help",    desc: "Show list of available commands"              },
  { key: "catalog", trigger: "/catalog", desc: "Display product catalog"                      },
  { key: "price",   trigger: "/price",   desc: "Show pricing information"                     },
  { key: "contact", trigger: "/contact", desc: "Contact / human agent info"                   },
  { key: "stop",    trigger: "/stop",    desc: "Unsubscribe from messages"                    },
  { key: "agent",   trigger: "/agent",   desc: "Connect to a live agent"                      },
  { key: "hours",   trigger: "/hours",   desc: "Business operating hours"                     },
  { key: "order",   trigger: "/order",   desc: "How to place an order"                        },
];

function emptyTrigger() {
  return {
    id:            crypto.randomUUID(),
    keyword:       "",
    response:      "",
    matchType:     "contains",
    caseSensitive: false,
    enabled:       true
  };
}
function emptyProduct()  { return { name: "", price: "", description: "" }; }

function normalizeSalesAgentConfig(config) {
  return {
    enabled: false,
    welcome_enabled: false,
    greeting: "",
    group_welcome: "",
    show_catalog_on_keyword: true,
    products: [],
    ...(typeof config === "object" && config ? config : {})
  };
}

function buildTabs(isPro, botType) {
  const tabs = [
    { id: "info",     label: "Info"         },
    { id: "sales",    label: "Sales Agent"  },
    { id: "commands", label: "Commands"     },
    { id: "webhook",  label: "Webhook"      },
    { id: "autoreply",label: "Auto-reply"  },
    { id: "ai",       label: isPro ? "🤖 AI" : "🔒 AI" },
  ];
  if (botType === "group" || botType === "all") {
    tabs.push({ id: "group", label: "👥 Group" });
  }
  if (botType === "dm" || botType === "all") {
    tabs.push({ id: "dmhelp", label: "👋 DM Help" });
  }
  tabs.push({ id: "qr", label: "QR Code" });
  return tabs;
}

export function BotConfigModal({ bot: initialBot, user, onClose, onSaved }) {
  const isPro = user?.plan_tier === "paid";
  const [bot, setBot]   = useState(initialBot);
  const [tab, setTab]   = useState(initialBot._openQr ? "qr" : "info");
  const [form, setForm] = useState({
    bot_name:            bot.bot_name          ?? "",
    description:         bot.description       ?? "",
    webhook_url:         bot.webhook_url        ?? "",
    webhook_secret:      bot.webhook_secret     ?? "",
    auto_reply_enabled:  bot.auto_reply_enabled ?? false,
    auto_reply_message:  bot.auto_reply_message ?? "",
    website_url:         bot.website_url        ?? "",
    catalog_unavail_msg: bot.catalog_unavail_msg ?? "",
    keyword_triggers:    Array.isArray(bot.keyword_triggers) ? bot.keyword_triggers : [],
    sales_agent_config:  normalizeSalesAgentConfig(bot.sales_agent_config),
    commands_config:     typeof bot.commands_config === "object" && bot.commands_config
      ? bot.commands_config : {},
    ai_config:           typeof bot.ai_config === "object" && bot.ai_config
      ? bot.ai_config : { enabled: false, provider: "openai", model: "gpt-4o-mini", system_prompt: "" },
    group_management_config: typeof bot.group_management_config === "object" && bot.group_management_config
      ? bot.group_management_config
      : {
          anti_link:           { enabled: false, action: "warn" },
          anti_spam:           { enabled: false, threshold: 5, window_seconds: 10, action: "warn" },
          anti_vulgar:         { enabled: false, words: [], action: "warn" },
          auto_help_on_first_dm: false,
          rules:               ""
        }
  });

  /* AI key state — separate from form to handle sensitivity */
  const [aiKeyInput,    setAiKeyInput]    = useState("");
  const [aiKeySensitive,setAiKeySensitive]= useState(form.ai_config.is_sensitive ?? false);
  const [aiKeyVisible,  setAiKeyVisible]  = useState(false);
  const [bulkPaste,     setBulkPaste]     = useState("");
  const [showBulk,      setShowBulk]      = useState(false);

  const [saving,      setSaving]      = useState(false);
  const [msg,         setMsg]         = useState({ text: "", ok: false });
  const [qrUrl,       setQrUrl]       = useState(null);
  const [adminGroups, setAdminGroups] = useState(null);
  const [vulgarInput, setVulgarInput] = useState("");
  const esRef = useRef(null);

  const TABS = buildTabs(isPro, bot.bot_type);

  /* ── Fetch admin groups when Group tab is opened ─────────── */
  useEffect(() => {
    if (tab !== "group") return;
    botsApi.groups(bot.id)
      .then((d) => setAdminGroups(d))
      .catch(() => setAdminGroups({ count: 0, groups: [] }));
  }, [tab, bot.id]);

  /* SSE for QR tab */
  useEffect(() => {
    if (tab !== "qr") { esRef.current?.close(); return; }
    const token = localStorage.getItem("wabot_token") ?? "";
    const url   = botsApi.eventsUrl(bot.id, token);
    const es    = new EventSource(url);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === "qr")     setQrUrl(d.qrUrl);
        if (d.type === "status") setBot((b) => ({ ...b, status: d.status }));
      } catch {}
    };
    return () => es.close();
  }, [tab, bot.id]);

  /* ── Generic setters ─────────────────────────────────────── */
  const set = (k) => (e) =>
    setForm((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const setSac = useCallback((k) => (e) =>
    setForm((p) => ({
      ...p,
      sales_agent_config: {
        ...p.sales_agent_config,
        [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value
      }
    })), []);

  /* ── Keyword triggers ────────────────────────────────────── */
  const addTrigger    = ()       => setForm((p) => ({ ...p, keyword_triggers: [...p.keyword_triggers, emptyTrigger()] }));
  const removeTrigger = (i)      => setForm((p) => ({ ...p, keyword_triggers: p.keyword_triggers.filter((_, x) => x !== i) }));
  const setTrigger    = (i, k, v) =>
    setForm((p) => { const n = [...p.keyword_triggers]; n[i] = { ...n[i], [k]: v }; return { ...p, keyword_triggers: n }; });

  /* ── Products ────────────────────────────────────────────── */
  const addProduct    = ()       =>
    setForm((p) => ({ ...p, sales_agent_config: { ...p.sales_agent_config, products: [...(p.sales_agent_config.products ?? []), emptyProduct()] } }));
  const removeProduct = (i)      =>
    setForm((p) => ({ ...p, sales_agent_config: { ...p.sales_agent_config, products: p.sales_agent_config.products.filter((_, x) => x !== i) } }));
  const setProduct    = (i, k, v) =>
    setForm((p) => {
      const products = [...(p.sales_agent_config.products ?? [])];
      products[i] = { ...products[i], [k]: v };
      return { ...p, sales_agent_config: { ...p.sales_agent_config, products } };
    });

  /* ── Bulk paste parser ───────────────────────────────────── */
  const applyBulkPaste = () => {
    const lines   = bulkPaste.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed  = lines.map((line) => {
      const parts = line.split("|").map((s) => s.trim());
      return {
        name:        parts[0] ?? "",
        price:       parts[1] ?? "",
        description: parts[2] ?? ""
      };
    }).filter((p) => p.name);

    if (parsed.length === 0) return;
    setForm((p) => ({
      ...p,
      sales_agent_config: {
        ...p.sales_agent_config,
        products: [...(p.sales_agent_config.products ?? []), ...parsed]
      }
    }));
    setBulkPaste("");
    setShowBulk(false);
  };

  /* ── Commands config ─────────────────────────────────────── */
  const toggleCommand = (key) =>
    setForm((p) => ({
      ...p,
      commands_config: {
        ...p.commands_config,
        [key]: { ...(p.commands_config[key] ?? {}), enabled: !(p.commands_config[key]?.enabled ?? true) }
      }
    }));
  const setCommandResponse = (key, val) =>
    setForm((p) => ({
      ...p,
      commands_config: {
        ...p.commands_config,
        [key]: { ...(p.commands_config[key] ?? {}), custom_response: val }
      }
    }));

  /* ── AI config ───────────────────────────────────────────── */
  const setAi = (k) => (e) =>
    setForm((p) => ({ ...p, ai_config: { ...p.ai_config, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value } }));

  const setAiVal = (k, v) =>
    setForm((p) => ({ ...p, ai_config: { ...p.ai_config, [k]: v } }));

  const selectedProvider = AI_PROVIDERS.find((p) => p.id === (form.ai_config.provider || "openai")) ?? AI_PROVIDERS[0];

  /* ── Group management config ─────────────────────────────── */
  const setGmc = useCallback((section, key, val) =>
    setForm((p) => ({
      ...p,
      group_management_config: {
        ...p.group_management_config,
        [section]: { ...(p.group_management_config[section] ?? {}), [key]: val }
      }
    })), []);

  const setGmcTop = useCallback((key, val) =>
    setForm((p) => ({
      ...p,
      group_management_config: { ...p.group_management_config, [key]: val }
    })), []);

  const addVulgarWord = () => {
    const w = vulgarInput.trim().toLowerCase();
    if (!w) return;
    const words = Array.isArray(form.group_management_config.anti_vulgar?.words)
      ? form.group_management_config.anti_vulgar.words : [];
    if (!words.includes(w)) setGmc("anti_vulgar", "words", [...words, w]);
    setVulgarInput("");
  };

  const removeVulgarWord = (w) => {
    const words = (form.group_management_config.anti_vulgar?.words ?? []).filter((x) => x !== w);
    setGmc("anti_vulgar", "words", words);
  };

  const gmc = form.group_management_config ?? {};

  /* ── Save ────────────────────────────────────────────────── */
  const save = async () => {
    setSaving(true); setMsg({ text: "", ok: false });
    try {
      const payload = { ...form };

      /* Attach AI key only if user entered a new one */
      if (aiKeyInput.trim()) {
        payload.ai_config = {
          ...form.ai_config,
          api_key:      aiKeyInput.trim(),
          is_sensitive: aiKeySensitive
        };
      }

      const { bot: updated } = await botsApi.patch(bot.id, payload);
      setBot(updated);
      setAiKeyInput("");   /* clear key field after saving */
      setMsg({ text: "Saved successfully.", ok: true });
      onSaved(updated);
    } catch (err) {
      setMsg({ text: err.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  const sac      = form.sales_agent_config;
  const products = sac.products ?? [];

  return (
    <Modal onClose={onClose} wide>
      <div style={{ width: "100%", textAlign: "left" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
          <div className="bot-card-icon">{bot.bot_type === "group" ? "👥" : bot.bot_type === "all" ? "🌐" : "🤖"}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: "1rem" }}>{bot.bot_name}</div>
            <div style={{ fontSize: "0.75rem", color: "var(--text3)", fontFamily: "monospace" }}>
              {bot.id?.slice(0, 8)}… · {bot.bot_type ?? "dm"} bot
            </div>
          </div>
          <StatusBadge status={bot.status} />
        </div>

        {/* Tab bar */}
        <div className="tab-bar" style={{ marginBottom: "1rem" }}>
          {TABS.map(({ id, label }) => (
            <button key={id} className={`tab-btn ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {msg.text && (
          <Alert type={msg.ok ? "success" : "error"} style={{ marginBottom: "0.75rem" }}>{msg.text}</Alert>
        )}

        {/* ── Info ── */}
        {tab === "info" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div className="field">
              <label className="field-label">Bot name</label>
              <input className="input" value={form.bot_name} onChange={set("bot_name")} />
            </div>
            <div className="field">
              <label className="field-label">Description</label>
              <input className="input" placeholder="What does this bot do?" value={form.description} onChange={set("description")} />
            </div>
            <div className="field">
              <label className="field-label">Website URL <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>(used in product-not-found replies)</span></label>
              <input className="input" type="url" placeholder="https://yourstore.com" value={form.website_url} onChange={set("website_url")} />
            </div>
            <div style={{ display: "flex", gap: "1.25rem", fontSize: "0.8125rem", color: "var(--text3)", padding: "0.25rem 0" }}>
              <span>Created: <strong style={{ color: "var(--text2)" }}>{fmtDate(bot.created_at)}</strong></span>
              <span>Messages: <strong style={{ color: "var(--text2)" }}>{(bot.messages_count ?? 0).toLocaleString()}</strong></span>
              <span>Type: <strong style={{ color: "var(--accent)" }}>{bot.bot_type ?? "dm"}</strong></span>
            </div>
          </div>
        )}

        {/* ── Sales Agent ── */}
        {tab === "sales" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.125rem" }}>
            <div className="toggle-row">
              <div>
                <div className="toggle-label">Enable Sales Agent</div>
                <div className="toggle-desc">Welcome message, product catalog, and smart product lookup</div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={!!sac.enabled} onChange={setSac("enabled")} />
                <span className="toggle-track" />
              </label>
            </div>

            {sac.enabled && (<>
              <div className="field">
                <label className="field-label">Welcome message</label>
                <textarea className="input" rows={3}
                  placeholder="Welcome! 👋 Type /catalog to see our products."
                  value={sac.greeting ?? ""} onChange={setSac("greeting")} />
                <span className="field-hint">Used as the first-message welcome text for direct messages.</span>
              </div>

              <div className="toggle-row">
                <div>
                  <div className="toggle-label">Send welcome on first DM</div>
                  <div className="toggle-desc">Greets a person once when they first message the bot</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={!!sac.welcome_enabled} onChange={setSac("welcome_enabled")} />
                  <span className="toggle-track" />
                </label>
              </div>

              <div className="field">
                <label className="field-label">Group welcome message</label>
                <textarea className="input" rows={3}
                  placeholder="Welcome to the group, {name}!"
                  value={sac.group_welcome ?? ""} onChange={setSac("group_welcome")} />
                <span className="field-hint">Optional. For group bots, `{name}` is replaced with the participant number.</span>
              </div>

              <div className="toggle-row">
                <div>
                  <div className="toggle-label">Auto-send catalog on request</div>
                  <div className="toggle-desc">Sends catalog when someone says "catalog", "products", "price", "menu"</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={!!sac.show_catalog_on_keyword} onChange={setSac("show_catalog_on_keyword")} />
                  <span className="toggle-track" />
                </label>
              </div>

              <div className="field">
                <label className="field-label">"Product not available" message</label>
                <input className="input" placeholder={form.website_url ? `Product not available. Check: ${form.website_url}` : "Product not available. Our seller will be in touch shortly."}
                  value={form.catalog_unavail_msg} onChange={set("catalog_unavail_msg")} />
                <span className="field-hint">Leave blank to auto-generate. If you set a Website URL, it'll be included.</span>
              </div>

              {/* Product catalog */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                  <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Product catalog ({products.length})</div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowBulk((v) => !v)}>
                      {showBulk ? "Hide" : "📋 Bulk paste"}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={addProduct}>+ Add</button>
                  </div>
                </div>

                {showBulk && (
                  <div style={{ background: "var(--bg)", border: "1px solid var(--border-accent)", borderRadius: "var(--radius)", padding: "0.875rem", marginBottom: "0.75rem" }}>
                    <div style={{ fontSize: "0.8rem", color: "var(--text2)", marginBottom: "0.5rem" }}>
                      Paste products — one per line. Format: <code style={{ color: "var(--accent)" }}>Name | Price | Description</code>
                    </div>
                    <textarea className="input" rows={5} style={{ fontFamily: "monospace", fontSize: "0.825rem" }}
                      placeholder={"iPhone 15 | 1200000 | Latest Apple smartphone\nSamsung S24 | 950000 | Android flagship\nAirPods Pro | 320000 | Noise cancelling earbuds"}
                      value={bulkPaste} onChange={(e) => setBulkPaste(e.target.value)} />
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                      <button className="btn btn-primary btn-sm" onClick={applyBulkPaste}>Add products</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setBulkPaste(""); setShowBulk(false); }}>Cancel</button>
                    </div>
                  </div>
                )}

                {products.length === 0 && !showBulk && (
                  <div style={{ padding: "1rem", textAlign: "center", color: "var(--text3)", fontSize: "0.875rem", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px dashed var(--border)" }}>
                    No products yet. Use "Bulk paste" to add multiple at once, or "Add" for one at a time.
                  </div>
                )}

                {products.map((p, i) => (
                  <div key={i} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem", marginBottom: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <input className="input" style={{ flex: 2 }} placeholder="Product name" value={p.name} onChange={(e) => setProduct(i, "name", e.target.value)} />
                      <input className="input" style={{ flex: 1 }} placeholder="₦ Price" value={p.price} onChange={(e) => setProduct(i, "price", e.target.value)} />
                      <button className="btn btn-danger btn-icon" onClick={() => removeProduct(i)}>✕</button>
                    </div>
                    <input className="input" placeholder="Short description (optional)" value={p.description} onChange={(e) => setProduct(i, "description", e.target.value)} />
                  </div>
                ))}
              </div>
            </>)}

            {/* Keyword triggers */}
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>Keyword triggers ({form.keyword_triggers.length})</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: "0.1rem" }}>Reply with specific text when a keyword is detected</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={addTrigger}>+ Add</button>
              </div>
              {form.keyword_triggers.length === 0 && (
                <div style={{ padding: "1rem", textAlign: "center", color: "var(--text3)", fontSize: "0.875rem", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px dashed var(--border)" }}>
                  Example: keyword "delivery" → "We deliver within 3–5 business days."
                </div>
              )}
              {form.keyword_triggers.map((t, i) => {
                /* Normalise: support legacy exact_match boolean */
                const matchType = t.matchType ?? (t.exact_match ? "exact" : "contains");
                const enabled   = t.enabled !== false;
                return (
                  <div key={t.id ?? i} style={{ background: "var(--bg)", border: `1px solid ${enabled ? "var(--border)" : "rgba(244,63,94,0.2)"}`, borderRadius: "var(--radius)", padding: "0.875rem", marginBottom: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem", opacity: enabled ? 1 : 0.6 }}>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                      <input className="input" style={{ flex: 2, minWidth: "100px" }} placeholder="Keyword / pattern"
                        value={t.keyword} onChange={(e) => setTrigger(i, "keyword", e.target.value)} />
                      <select className="input" style={{ flex: "0 0 auto", minWidth: "120px" }}
                        value={matchType}
                        onChange={(e) => setTrigger(i, "matchType", e.target.value)}>
                        <option value="contains">Contains</option>
                        <option value="exact">Exact match</option>
                        <option value="starts_with">Starts with</option>
                        <option value="ends_with">Ends with</option>
                        <option value="regex">Regex</option>
                      </select>
                      <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem", color: "var(--text2)", cursor: "pointer", flexShrink: 0 }}
                        title="Toggle this trigger on/off without deleting it">
                        <input type="checkbox" checked={enabled}
                          onChange={(e) => setTrigger(i, "enabled", e.target.checked)} />
                        On
                      </label>
                      <button className="btn btn-danger btn-icon" onClick={() => removeTrigger(i)}>✕</button>
                    </div>
                    <textarea className="input" rows={2} placeholder="Reply message…"
                      value={t.response} onChange={(e) => setTrigger(i, "response", e.target.value)} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Commands ── */}
        {tab === "commands" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ fontSize: "0.875rem", color: "var(--text3)", marginBottom: "0.25rem" }}>
              Default commands are built-in. Toggle any off instantly — no redeployment needed.
              {isPro && " Pro users can also set custom responses."}
              {!isPro && <span style={{ color: "var(--accent)" }}> Custom responses require Pro.</span>}
            </div>
            {DEFAULT_COMMANDS.map((cmd) => {
              const cfg     = form.commands_config[cmd.key] ?? {};
              const enabled = cfg.enabled !== false;
              return (
                <div key={cmd.key} style={{
                  background: "var(--bg)", border: `1px solid ${enabled ? "var(--border)" : "rgba(244,63,94,0.2)"}`,
                  borderRadius: "var(--radius)", padding: "0.875rem",
                  opacity: enabled ? 1 : 0.6
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: isPro && enabled ? "0.625rem" : 0 }}>
                    <code style={{ background: "var(--card2)", padding: "0.25rem 0.5rem", borderRadius: "6px", fontSize: "0.8rem", color: "var(--accent)", flexShrink: 0 }}>{cmd.trigger}</code>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text)" }}>{cmd.desc}</div>
                    </div>
                    <label className="toggle">
                      <input type="checkbox" checked={enabled} onChange={() => toggleCommand(cmd.key)} />
                      <span className="toggle-track" />
                    </label>
                  </div>
                  {isPro && enabled && (
                    <input className="input" style={{ fontSize: "0.825rem" }}
                      placeholder="Custom response (leave blank for default)"
                      value={cfg.custom_response ?? ""}
                      onChange={(e) => setCommandResponse(cmd.key, e.target.value)} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Webhook ── */}
        {tab === "webhook" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div className="field">
              <label className="field-label">Webhook URL</label>
              <input className="input" type="url" placeholder="https://yourapp.com/webhook"
                value={form.webhook_url} onChange={set("webhook_url")} />
              <span className="field-hint">WaBot POSTs JSON to this URL on every incoming message.</span>
            </div>
            <div className="field">
              <label className="field-label">Webhook secret (optional)</label>
              <input className="input" type="password" placeholder="HMAC-SHA256 signing secret"
                value={form.webhook_secret} onChange={set("webhook_secret")} />
              <span className="field-hint">Verify payloads using the X-WaBot-Signature header.</span>
            </div>
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem", fontSize: "0.8rem" }}>
              <div style={{ color: "var(--text3)", marginBottom: "0.5rem", fontWeight: 600 }}>Payload example:</div>
              <pre className="mono" style={{ color: "var(--text2)", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.775rem" }}>
                {JSON.stringify({ event: "message_received", botId: bot.id, from: "+2348012345678", body: "Hello!", type: "text", isGroup: false, timestamp: Date.now() }, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {/* ── Auto-reply ── */}
        {tab === "autoreply" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div className="toggle-row">
              <div>
                <div className="toggle-label">Enable auto-reply</div>
                <div className="toggle-desc">Reply to every message not handled by commands, keyword triggers, or AI</div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={form.auto_reply_enabled} onChange={set("auto_reply_enabled")} />
                <span className="toggle-track" />
              </label>
            </div>
            {form.auto_reply_enabled && (
              <div className="field">
                <label className="field-label">Auto-reply message</label>
                <textarea className="input" rows={4} style={{ resize: "vertical" }}
                  placeholder="Hi! Thanks for reaching out. We'll get back to you soon."
                  value={form.auto_reply_message} onChange={set("auto_reply_message")} />
                <span className="field-hint">Fallback when no other handler matches.</span>
              </div>
            )}
          </div>
        )}

        {/* ── AI ── */}
        {tab === "ai" && !isPro && (
          <div style={{ textAlign: "center", padding: "2rem 1rem" }}>
            <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>🔒</div>
            <h4 style={{ marginBottom: "0.5rem" }}>AI integration is a Pro feature</h4>
            <p style={{ color: "var(--text2)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
              Upgrade to Pro to give your bots an AI brain. Connect OpenAI, Gemini, Claude, Meta Llama, or Replit AI.
            </p>
            <a href="#pricing" className="btn btn-primary">Upgrade to Pro — ₦1,500/mo</a>
          </div>
        )}

        {tab === "ai" && isPro && (() => {
          const botType   = bot.bot_type ?? "dm";
          const hasDm     = botType === "dm"    || botType === "all";
          const hasGroup  = botType === "group"  || botType === "all";
          const dmEnabled     = form.ai_config.dm_enabled     !== false;
          const groupsEnabled = form.ai_config.groups_enabled === true;

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

              {/* Master AI toggle */}
              <div className="toggle-row">
                <div>
                  <div className="toggle-label">Enable AI responses</div>
                  <div className="toggle-desc">Bot uses AI when no keyword trigger or command matches</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={!!form.ai_config.enabled} onChange={setAi("enabled")} />
                  <span className="toggle-track" />
                </label>
              </div>

              {form.ai_config.enabled && (<>

                {/* Provider selection */}
                <div className="field">
                  <label className="field-label">AI Provider</label>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.5rem" }}>
                    {AI_PROVIDERS.map((p) => (
                      <button key={p.id} type="button"
                        onClick={() => setForm((f) => ({ ...f, ai_config: { ...f.ai_config, provider: p.id, model: p.models[0] } }))}
                        style={{
                          padding: "0.625rem 0.5rem",
                          borderRadius: "var(--radius)",
                          border: `1.5px solid ${form.ai_config.provider === p.id ? "var(--accent)" : "var(--border)"}`,
                          background: form.ai_config.provider === p.id ? "var(--accent-dim)" : "var(--bg)",
                          cursor: "pointer", fontSize: "0.8rem", fontWeight: 600,
                          color: form.ai_config.provider === p.id ? "var(--accent)" : "var(--text2)",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: "0.2rem"
                        }}>
                        <span>{p.logo}</span>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{p.name.split(" ")[0]}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Model */}
                <div className="field">
                  <label className="field-label">Model</label>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <select className="input" value={form.ai_config.model || selectedProvider.models[0]}
                      onChange={setAi("model")} style={{ flex: 1 }}>
                      {selectedProvider.models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <a href={selectedProvider.applyUrl} target="_blank" rel="noopener noreferrer"
                      className="btn btn-secondary btn-sm" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
                      Get API key ↗
                    </a>
                  </div>
                </div>

                {/* API Key */}
                <div className="field">
                  <label className="field-label">
                    API Key
                    {form.ai_config.has_key && (
                      <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "var(--success)" }}>✓ Key saved</span>
                    )}
                    {form.ai_config.is_sensitive && form.ai_config.has_key && (
                      <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "var(--warning)" }}>🔒 Sensitive — not viewable</span>
                    )}
                  </label>
                  <div style={{ position: "relative" }}>
                    <input
                      className="input"
                      type={aiKeyVisible ? "text" : "password"}
                      placeholder={form.ai_config.has_key ? "Enter new key to replace…" : `Paste your ${selectedProvider.name} API key…`}
                      value={aiKeyInput}
                      onChange={(e) => setAiKeyInput(e.target.value)}
                      style={{ paddingRight: "3rem" }}
                    />
                    <button type="button"
                      onClick={() => setAiKeyVisible((v) => !v)}
                      style={{ position: "absolute", right: "0.75rem", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text3)", fontSize: "0.875rem" }}>
                      {aiKeyVisible ? "🙈" : "👁"}
                    </button>
                  </div>
                  <span className="field-hint">Key is encrypted and stored securely. Never exposed in API responses.</span>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.375rem", cursor: "pointer", fontSize: "0.875rem" }}>
                    <input type="checkbox" checked={aiKeySensitive} onChange={(e) => setAiKeySensitive(e.target.checked)} />
                    <span style={{ color: "var(--text2)" }}>
                      Mark as <strong>very sensitive</strong> — after saving, the key cannot be viewed again (only replaced)
                    </span>
                  </label>
                </div>

                {/* ── DM channel ─────────────────────────────────── */}
                {hasDm && (
                  <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    <div className="toggle-row" style={{ marginBottom: 0 }}>
                      <div>
                        <div className="toggle-label">💬 AI in Direct Messages</div>
                        <div className="toggle-desc">Reply with AI when someone messages the bot directly</div>
                      </div>
                      <label className="toggle">
                        <input type="checkbox" checked={dmEnabled}
                          onChange={(e) => setAiVal("dm_enabled", e.target.checked)} />
                        <span className="toggle-track" />
                      </label>
                    </div>
                    {dmEnabled && (
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label className="field-label">DM trigger mode</label>
                        <select className="input" value={form.ai_config.dm_trigger_mode ?? "all"}
                          onChange={setAi("dm_trigger_mode")}>
                          <option value="all">All messages — respond to every DM</option>
                          <option value="keyword">Keyword — respond only when DM starts with prefix</option>
                          <option value="mention">Mention — respond only when bot is @-tagged</option>
                        </select>
                        {(form.ai_config.dm_trigger_mode === "keyword") && (
                          <input className="input" style={{ marginTop: "0.4rem" }}
                            placeholder="Trigger prefix (default: @bot)"
                            value={form.ai_config.trigger_prefix ?? ""}
                            onChange={setAi("trigger_prefix")} />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Group channel ───────────────────────────────── */}
                {hasGroup && (
                  <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    <div className="toggle-row" style={{ marginBottom: 0 }}>
                      <div>
                        <div className="toggle-label">👥 AI in Group Chats</div>
                        <div className="toggle-desc">Reply with AI in groups (bot must be admin)</div>
                      </div>
                      <label className="toggle">
                        <input type="checkbox" checked={groupsEnabled}
                          onChange={(e) => setAiVal("groups_enabled", e.target.checked)} />
                        <span className="toggle-track" />
                      </label>
                    </div>
                    {groupsEnabled && (<>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label className="field-label">Group trigger mode</label>
                        <select className="input" value={form.ai_config.group_trigger_mode ?? "mention"}
                          onChange={setAi("group_trigger_mode")}>
                          <option value="mention">Mention — respond only when bot is @-tagged (recommended)</option>
                          <option value="all">All messages — respond to every group message</option>
                          <option value="keyword">Keyword — respond only when message starts with prefix</option>
                        </select>
                        {(form.ai_config.group_trigger_mode === "keyword") && (
                          <input className="input" style={{ marginTop: "0.4rem" }}
                            placeholder="Trigger prefix (default: @bot)"
                            value={form.ai_config.trigger_prefix ?? ""}
                            onChange={setAi("trigger_prefix")} />
                        )}
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <label className="field-label">
                          Group system prompt
                          <span style={{ fontWeight: 400, color: "var(--text3)", marginLeft: "0.4rem", fontSize: "0.75rem" }}>(optional — overrides shared prompt for groups)</span>
                        </label>
                        <textarea className="input" rows={3} style={{ resize: "vertical" }}
                          placeholder="You are a group moderator assistant. Be brief and community-focused…"
                          value={form.ai_config.group_system_prompt ?? ""}
                          onChange={setAi("group_system_prompt")} />
                      </div>
                    </>)}
                  </div>
                )}

                {/* Shared system prompt */}
                <div className="field">
                  <label className="field-label">
                    System prompt
                    {hasGroup && groupsEnabled && (
                      <span style={{ fontWeight: 400, color: "var(--text3)", marginLeft: "0.4rem", fontSize: "0.75rem" }}>(used for DMs; groups use the group prompt above if set)</span>
                    )}
                  </label>
                  <textarea className="input" rows={4} style={{ resize: "vertical" }}
                    placeholder={`You are a helpful WhatsApp assistant for [your business name]. Be friendly and concise. Answer in 1-3 sentences. If asked about products you don't know about, say you'll check and get back to them.`}
                    value={form.ai_config.system_prompt ?? ""}
                    onChange={setAi("system_prompt")} />
                  <span className="field-hint">Instructions for the AI. Include your business name, tone, and what the bot should/shouldn't do.</span>
                </div>

                <div style={{ background: "var(--info-bg)", border: "1px solid var(--border-accent)", borderRadius: "var(--radius)", padding: "0.75rem", fontSize: "0.8rem", color: "var(--text2)" }}>
                  💡 <strong>Priority order:</strong> Commands → Keyword triggers → AI response → Auto-reply fallback
                </div>
              </>)}
            </div>
          );
        })()}

        {/* ── Group Management ── */}
        {tab === "group" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.125rem" }}>

            {/* Admin groups stat */}
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem 1rem", display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <div style={{ fontSize: "1.5rem" }}>👑</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>
                  {adminGroups === null ? "—" : adminGroups.count}
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text3)" }}>
                  Groups where this bot is admin
                  {adminGroups?.groups?.length > 0 && (
                    <span style={{ display: "block", marginTop: "0.2rem" }}>
                      {adminGroups.groups.map((g) => g.subject || g.id).join(", ")}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div style={{ background: "var(--info-bg)", border: "1px solid var(--border-accent)", borderRadius: "var(--radius)", padding: "0.75rem", fontSize: "0.8rem", color: "var(--text2)" }}>
              ℹ️ <strong>Bot must be group admin</strong> for commands and moderation to work. If the bot is not an admin, it will silently ignore all group messages.
            </div>

            {/* Anti-link */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem" }}>
              <div className="toggle-row" style={{ marginBottom: gmc.anti_link?.enabled ? "0.75rem" : 0 }}>
                <div>
                  <div className="toggle-label">🔗 Anti-link</div>
                  <div className="toggle-desc">Delete messages with URLs/links from non-admins</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={!!gmc.anti_link?.enabled}
                    onChange={(e) => setGmc("anti_link", "enabled", e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {gmc.anti_link?.enabled && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="field-label">Action on violation</label>
                  <select className="input" value={gmc.anti_link?.action ?? "warn"}
                    onChange={(e) => setGmc("anti_link", "action", e.target.value)}>
                    <option value="warn">Warn (3 strikes → remove)</option>
                    <option value="kick">Immediately remove</option>
                  </select>
                </div>
              )}
            </div>

            {/* Anti-spam */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem" }}>
              <div className="toggle-row" style={{ marginBottom: gmc.anti_spam?.enabled ? "0.75rem" : 0 }}>
                <div>
                  <div className="toggle-label">🚫 Anti-spam</div>
                  <div className="toggle-desc">Warn or remove members who flood the group with messages</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={!!gmc.anti_spam?.enabled}
                    onChange={(e) => setGmc("anti_spam", "enabled", e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {gmc.anti_spam?.enabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                      <label className="field-label">Messages threshold</label>
                      <input className="input" type="number" min={2} max={50}
                        value={gmc.anti_spam?.threshold ?? 5}
                        onChange={(e) => setGmc("anti_spam", "threshold", Number(e.target.value))} />
                    </div>
                    <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                      <label className="field-label">Within (seconds)</label>
                      <input className="input" type="number" min={3} max={60}
                        value={gmc.anti_spam?.window_seconds ?? 10}
                        onChange={(e) => setGmc("anti_spam", "window_seconds", Number(e.target.value))} />
                    </div>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">Action on violation</label>
                    <select className="input" value={gmc.anti_spam?.action ?? "warn"}
                      onChange={(e) => setGmc("anti_spam", "action", e.target.value)}>
                      <option value="warn">Warn (3 strikes → remove)</option>
                      <option value="kick">Immediately remove</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Anti-vulgar */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem" }}>
              <div className="toggle-row" style={{ marginBottom: gmc.anti_vulgar?.enabled ? "0.75rem" : 0 }}>
                <div>
                  <div className="toggle-label">🤬 Anti-vulgar / Word filter</div>
                  <div className="toggle-desc">Delete messages containing banned words from non-admins</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={!!gmc.anti_vulgar?.enabled}
                    onChange={(e) => setGmc("anti_vulgar", "enabled", e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {gmc.anti_vulgar?.enabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">Action on violation</label>
                    <select className="input" value={gmc.anti_vulgar?.action ?? "warn"}
                      onChange={(e) => setGmc("anti_vulgar", "action", e.target.value)}>
                      <option value="warn">Warn (3 strikes → remove)</option>
                      <option value="kick">Immediately remove</option>
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">Banned words</label>
                    <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
                      <input className="input" placeholder="Type a word and press Add"
                        value={vulgarInput} onChange={(e) => setVulgarInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addVulgarWord())}
                        style={{ flex: 1 }} />
                      <button className="btn btn-secondary btn-sm" onClick={addVulgarWord} type="button">Add</button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                      {(gmc.anti_vulgar?.words ?? []).map((w) => (
                        <span key={w} style={{ background: "rgba(244,63,94,0.12)", border: "1px solid rgba(244,63,94,0.3)", color: "var(--error)", borderRadius: "20px", padding: "0.15rem 0.6rem", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.35rem" }}>
                          {w}
                          <button onClick={() => removeVulgarWord(w)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0, lineHeight: 1 }}>×</button>
                        </span>
                      ))}
                      {(gmc.anti_vulgar?.words ?? []).length === 0 && (
                        <span style={{ color: "var(--text3)", fontSize: "0.8rem" }}>No words added yet</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Group rules */}
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label">Group rules <span style={{ color: "var(--text3)", fontWeight: 400, fontSize: "0.75rem" }}>(shown with .rules command)</span></label>
              <textarea className="input" rows={4} style={{ resize: "vertical" }}
                placeholder={"1. Be respectful to all members.\n2. No spam or excessive self-promotion.\n3. No links without admin approval.\n4. Keep topics relevant to this group."}
                value={gmc.rules ?? ""}
                onChange={(e) => setGmcTop("rules", e.target.value)} />
            </div>

            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem", fontSize: "0.8rem", color: "var(--text2)" }}>
              <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Group commands (non-admins see .help):</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.25rem 1rem", fontFamily: "monospace", fontSize: "0.78rem" }}>
                {[".help",".kick @user",".ban @user",".lock",".unlock",".promote @user",".demote @user",".warn @user",".warnings @user",".clearwarn @user",".tagall [msg]",".admins",".rules"].map((c) => (
                  <span key={c} style={{ color: "var(--accent)" }}>{c}</span>
                ))}
              </div>
              <div style={{ marginTop: "0.5rem", color: "var(--text3)" }}>Only group admins can use moderation commands. 3 auto-moderation strikes = removal.</div>
            </div>
          </div>
        )}

        {/* ── DM Help (auto-help on first DM) ── */}
        {tab === "dmhelp" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.125rem" }}>
            <div className="toggle-row">
              <div>
                <div className="toggle-label">👋 Auto-send /help on first DM</div>
                <div className="toggle-desc">When someone messages this bot for the first time, automatically send the command menu</div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={!!gmc.auto_help_on_first_dm}
                  onChange={(e) => setGmcTop("auto_help_on_first_dm", e.target.checked)} />
                <span className="toggle-track" />
              </label>
            </div>
            {gmc.auto_help_on_first_dm && (
              <div style={{ background: "var(--bg)", border: "1px solid var(--border-accent)", borderRadius: "var(--radius)", padding: "0.875rem", fontSize: "0.8rem" }}>
                <div style={{ fontWeight: 600, color: "var(--text2)", marginBottom: "0.5rem" }}>Preview message sent to new contacts:</div>
                <pre style={{ color: "var(--text3)", fontFamily: "monospace", fontSize: "0.775rem", whiteSpace: "pre-wrap", margin: 0 }}>
{`👋 *Welcome!*

Here are the available commands:
/help
/catalog
/price
/contact
/stop
/agent
/hours
/order

Reply with any command to get started.`}
                </pre>
                <div style={{ marginTop: "0.5rem", color: "var(--text3)" }}>
                  Only enabled commands appear. Each contact only sees this once per bot session.
                </div>
              </div>
            )}
            {!gmc.auto_help_on_first_dm && (
              <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.5rem", textAlign: "center", color: "var(--text3)", fontSize: "0.875rem" }}>
                Enable the toggle above so new customers automatically know what commands are available without having to guess.
              </div>
            )}
          </div>
        )}

        {/* ── QR ── */}
        {tab === "qr" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem" }}>
            {bot.status === "connected" ? (
              <div style={{ textAlign: "center", padding: "1.5rem" }}>
                <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>✅</div>
                <div style={{ fontWeight: 700 }}>Bot is connected</div>
                <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginTop: "0.375rem" }}>
                  This bot is linked to WhatsApp and active.
                </div>
              </div>
            ) : qrUrl ? (
              <>
                <p style={{ fontSize: "0.875rem", color: "var(--text2)", textAlign: "center" }}>
                  Open WhatsApp → Linked Devices → Link a Device, then scan:
                </p>
                <div className="qr-wrap"><img src={qrUrl} alt="WhatsApp QR code" /></div>
                <p style={{ fontSize: "0.75rem", color: "var(--text3)", textAlign: "center" }}>QR refreshes automatically every ~20 s</p>
              </>
            ) : (
              <div style={{ padding: "2rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem" }}>
                <Spinner size="lg" />
                <span style={{ fontSize: "0.8125rem", color: "var(--text2)" }}>Waiting for QR code…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {tab !== "qr" && (
        <button className="btn btn-primary w-full" onClick={save} disabled={saving}>
          {saving ? <><Spinner size="sm" /> Saving…</> : "Save changes"}
        </button>
      )}
    </Modal>
  );
}
