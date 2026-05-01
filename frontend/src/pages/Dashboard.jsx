import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

/* ── helpers ──────────────────────────────────────────────────── */
function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ status }) {
  const map = {
    active:           { cls: "badge-active",   label: "Active" },
    connected:        { cls: "badge-active",   label: "Connected" },
    awaiting_qr_scan: { cls: "badge-pending",  label: "Awaiting QR" },
    disconnected:     { cls: "badge-inactive", label: "Disconnected" },
    error:            { cls: "badge-error",    label: "Error" },
  };
  const { cls, label } = map[status] || { cls: "badge-inactive", label: status || "Unknown" };
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ── NAV ──────────────────────────────────────────────────────── */
const NAV = [
  { id: "overview",  icon: "⊞",  label: "Overview"  },
  { id: "bots",      icon: "🤖", label: "My Bots"   },
  { id: "logs",      icon: "📋", label: "Logs"       },
  { id: "apikeys",   icon: "🔑", label: "API Keys"   },
  { id: "billing",   icon: "💳", label: "Billing"    },
  { id: "settings",  icon: "⚙",  label: "Settings"   },
];

/* ── Modals ───────────────────────────────────────────────────── */
function QrModal({ bot, qrUrl, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div style={{ fontSize: "2rem" }}>🤖</div>
        <h3>Connect {bot?.bot_name}</h3>
        <p>Open WhatsApp → Linked Devices → Link a Device, then scan:</p>
        <div className="qr-wrap"><img src={qrUrl} alt="QR code" /></div>
        <p className="text-xs text-muted3">After scanning, the bot status will update to Active.</p>
        <button className="btn btn-secondary w-full" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function DeployModal({ onClose, onDeployed, user }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Bot name is required.");
    setError(""); setLoading(true);
    try {
      const data = await apiFetch("/bots/deploy", {
        method: "POST",
        body: JSON.stringify({ botName: name.trim(), description: desc.trim() }),
      });
      onDeployed(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.emailVerified && !user?.email_verified) {
    return (
      <div className="overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={onClose}>✕</button>
          <div style={{ fontSize: "2rem" }}>📧</div>
          <h3>Verify your email first</h3>
          <p>Check your inbox for the verification link, then come back to deploy bots.</p>
          <button className="btn btn-primary w-full" onClick={onClose}>Got it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div style={{ fontSize: "2rem" }}>🚀</div>
        <h3>Deploy a new bot</h3>
        <p>Give your bot a name. You'll scan a QR code to link it to WhatsApp.</p>
        <form onSubmit={submit} style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="field">
            <label className="field-label">Bot name *</label>
            <input className="input" placeholder="e.g. sales-assistant" value={name}
              onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label className="field-label">Description (optional)</label>
            <input className="input" placeholder="What does this bot do?" value={desc}
              onChange={(e) => setDesc(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={loading}>
            {loading ? <><span className="spinner spinner-sm" /> Deploying…</> : "Deploy bot"}
          </button>
        </form>
      </div>
    </div>
  );
}

function BotConfigModal({ bot, onClose, onSaved }) {
  const [tab, setTab] = useState("info");
  const [form, setForm] = useState({
    bot_name:             bot.bot_name || "",
    description:          bot.description || "",
    webhook_url:          bot.webhook_url || "",
    auto_reply_enabled:   bot.auto_reply_enabled || false,
    auto_reply_message:   bot.auto_reply_message || "",
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState({ text: "", ok: false });
  const [qrUrl, setQrUrl]   = useState(null);
  const [loadingQr, setLoadingQr] = useState(false);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const save = async () => {
    setSaving(true); setMsg({ text: "", ok: false });
    try {
      const data = await apiFetch(`/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      setMsg({ text: "Saved successfully.", ok: true });
      onSaved(data.bot);
    } catch (err) {
      setMsg({ text: err.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  const loadQr = async () => {
    setLoadingQr(true);
    try {
      const d = await apiFetch(`/bots/${bot.id}/qr`);
      setQrUrl(d.qrCodeDataUrl);
    } catch {
      setMsg({ text: "Could not load QR code.", ok: false });
    } finally {
      setLoadingQr(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide" style={{ gap: "1rem" }} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div style={{ width: "100%", textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
            <div className="bot-card-icon">🤖</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "1rem" }}>{bot.bot_name}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text3)", fontFamily: "monospace" }}>ID: {bot.id?.slice(0, 8)}…</div>
            </div>
            <div style={{ marginLeft: "auto" }}><StatusBadge status={bot.status} /></div>
          </div>

          <div className="tab-bar" style={{ marginBottom: "1rem" }}>
            {[["info", "Info"], ["webhook", "Webhook"], ["autoreply", "Auto-reply"], ["qr", "QR Code"]].map(([id, label]) => (
              <button key={id} className={`tab-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {msg.text && <div className={`alert ${msg.ok ? "alert-success" : "alert-error"}`} style={{ marginBottom: "0.75rem" }}>{msg.text}</div>}

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
              <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.8125rem", color: "var(--text3)", padding: "0.5rem 0" }}>
                <span>Created: <strong style={{ color: "var(--text2)" }}>{fmtDate(bot.created_at)}</strong></span>
                <span>Messages: <strong style={{ color: "var(--text2)" }}>{bot.messages_count || 0}</strong></span>
              </div>
            </div>
          )}

          {tab === "webhook" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
              <div className="field">
                <label className="field-label">Webhook URL</label>
                <input className="input" type="url" placeholder="https://yourapp.com/webhook"
                  value={form.webhook_url} onChange={set("webhook_url")} />
                <span className="field-hint">WaBot will POST JSON events here when messages arrive on this bot.</span>
              </div>
              <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem", fontSize: "0.8rem" }}>
                <div style={{ color: "var(--text3)", marginBottom: "0.5rem", fontWeight: 600 }}>Event payload example:</div>
                <pre className="mono" style={{ color: "var(--text2)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify({ event: "message_received", botId: bot.id, from: "+1234567890", body: "Hello!", timestamp: Date.now() }, null, 2)}</pre>
              </div>
            </div>
          )}

          {tab === "autoreply" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
              <div className="toggle-row">
                <div>
                  <div className="toggle-label">Enable auto-reply</div>
                  <div className="toggle-desc">Automatically reply to every incoming message</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={form.auto_reply_enabled} onChange={set("auto_reply_enabled")} />
                  <span className="toggle-track" />
                </label>
              </div>
              {form.auto_reply_enabled && (
                <div className="field">
                  <label className="field-label">Auto-reply message</label>
                  <textarea className="input" rows={4} placeholder="Hi! Thanks for your message. We'll get back to you soon."
                    value={form.auto_reply_message} onChange={set("auto_reply_message")} style={{ resize: "vertical" }} />
                  <span className="field-hint">Sent to every contact that messages this bot.</span>
                </div>
              )}
            </div>
          )}

          {tab === "qr" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem" }}>
              <p style={{ fontSize: "0.875rem", color: "var(--text2)", textAlign: "center" }}>
                Use this QR code to link a WhatsApp number to this bot via Linked Devices.
              </p>
              {qrUrl ? (
                <div className="qr-wrap"><img src={qrUrl} alt="QR code" /></div>
              ) : (
                <button className="btn btn-secondary" onClick={loadQr} disabled={loadingQr}>
                  {loadingQr ? <><span className="spinner spinner-sm" /> Loading…</> : "Load QR Code"}
                </button>
              )}
            </div>
          )}
        </div>

        {tab !== "qr" && (
          <button className="btn btn-primary w-full" onClick={save} disabled={saving}>
            {saving ? <><span className="spinner spinner-sm" /> Saving…</> : "Save changes"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────── */
function Overview({ data, onGoToBots }) {
  const { user, bots, activity, stats } = data;
  const isPro = user?.plan_tier === "paid";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">🤖</div>
          <div className="stat-value">{stats?.totalBots ?? bots.length}</div>
          <div className="stat-label">Total bots</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-value">{stats?.activeBots ?? 0}</div>
          <div className="stat-label">Active now</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">💬</div>
          <div className="stat-value">{stats?.totalMessages ?? 0}</div>
          <div className="stat-label">Messages</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">📦</div>
          <div className="stat-value">{bots.length}/{stats?.planLimit ?? 2}</div>
          <div className="stat-label">Slots used</div>
        </div>
      </div>

      {!user?.email_verified && (
        <div className="alert alert-warning">
          ⚠ Your email isn't verified yet. Check your inbox to unlock bot deployment.
        </div>
      )}

      <div className="card">
        <div className="section-heading" style={{ marginBottom: "1rem" }}>
          <span>Recent Bots</span>
          <button className="btn btn-sm btn-secondary" onClick={onGoToBots}>View all</button>
        </div>
        {bots.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🤖</div>
            <div className="empty-title">No bots yet</div>
            <div className="empty-desc">Deploy your first WhatsApp bot to get started.</div>
            <button className="btn btn-primary btn-sm" style={{ marginTop: "0.5rem" }} onClick={onGoToBots}>Deploy a bot</button>
          </div>
        ) : (
          <div className="activity-list">
            {bots.slice(0, 5).map((b) => (
              <div className="activity-row" key={b.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event">{b.bot_name}</div>
                  {b.description && <div className="activity-detail">{b.description}</div>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <StatusBadge status={b.status} />
                  <div className="activity-time">{timeAgo(b.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {activity.length > 0 && (
        <div className="card">
          <div className="section-heading" style={{ marginBottom: "1rem" }}>Recent Activity</div>
          <div className="activity-list">
            {activity.slice(0, 6).map((a) => (
              <div className="activity-row" key={a.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event">{a.event_type.replace(/_/g, " ")}</div>
                  {a.details && <div className="activity-detail">{a.details}</div>}
                </div>
                <div className="activity-time">{timeAgo(a.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Bots view ────────────────────────────────────────────────── */
function BotsView({ data, onRefresh }) {
  const { user, bots, stats } = data;
  const [showDeploy, setShowDeploy] = useState(false);
  const [qrState,    setQrState]    = useState(null);
  const [configBot,  setConfigBot]  = useState(null);
  const [deleting,   setDeleting]   = useState(null);
  const maxBots = stats?.planLimit ?? (user?.plan_tier === "paid" ? 100 : 2);
  const atLimit = bots.length >= maxBots;

  const handleDeployed = (res) => {
    setShowDeploy(false);
    setQrState({ bot: res.bot, qrUrl: res.qrCodeDataUrl });
    onRefresh();
  };

  const handleDelete = async (botId, e) => {
    e.stopPropagation();
    if (!window.confirm("Delete this bot? This cannot be undone.")) return;
    setDeleting(botId);
    try {
      await apiFetch(`/bots/${botId}`, { method: "DELETE" });
      onRefresh();
    } catch (err) {
      alert(err.message);
    } finally {
      setDeleting(null);
    }
  };

  const handleShowQr = async (bot, e) => {
    e.stopPropagation();
    try {
      const d = await apiFetch(`/bots/${bot.id}/qr`);
      setQrState({ bot, qrUrl: d.qrCodeDataUrl });
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <>
      {showDeploy && <DeployModal user={user} onClose={() => setShowDeploy(false)} onDeployed={handleDeployed} />}
      {qrState    && <QrModal bot={qrState.bot} qrUrl={qrState.qrUrl} onClose={() => setQrState(null)} />}
      {configBot  && <BotConfigModal bot={configBot} onClose={() => setConfigBot(null)} onSaved={(updated) => { setConfigBot(updated); onRefresh(); }} />}

      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <div className="section-heading">
          <span>
            My Bots{" "}
            <span className="badge badge-inactive" style={{ fontSize: "0.7rem" }}>
              {bots.length}/{maxBots}
            </span>
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => setShowDeploy(true)}
            disabled={atLimit} title={atLimit ? "Upgrade to deploy more bots" : undefined}>
            + Deploy bot
          </button>
        </div>

        {atLimit && user?.plan_tier !== "paid" && (
          <div className="alert alert-info">
            You've reached the Free plan limit of {maxBots} bots.{" "}
            <strong style={{ color: "var(--accent)", cursor: "pointer" }}>Upgrade to Pro</strong> for 100 bots.
          </div>
        )}

        {bots.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <div className="empty-icon">🤖</div>
              <div className="empty-title">No bots deployed yet</div>
              <div className="empty-desc">Click "Deploy bot" to launch your first WhatsApp bot.</div>
            </div>
          </div>
        ) : (
          <div className="bots-grid">
            {bots.map((bot) => (
              <div className="bot-card" key={bot.id} onClick={() => setConfigBot(bot)}>
                <div className="bot-card-top">
                  <div className="bot-card-icon">🤖</div>
                  <StatusBadge status={bot.status} />
                </div>
                <div>
                  <div className="bot-card-name">{bot.bot_name}</div>
                  {bot.description && <div className="bot-card-desc" style={{ marginTop: "0.25rem" }}>{bot.description}</div>}
                  <div className="bot-card-meta">Created {timeAgo(bot.created_at)}</div>
                </div>
                <div className="bot-card-stats">
                  <div className="bot-card-stat">Messages: <span>{bot.messages_count || 0}</span></div>
                  {bot.webhook_url && <div className="bot-card-stat">Webhook: <span style={{ color: "var(--success)" }}>✓</span></div>}
                  {bot.auto_reply_enabled && <div className="bot-card-stat">Auto-reply: <span style={{ color: "var(--success)" }}>✓</span></div>}
                </div>
                <div className="bot-card-actions" onClick={(e) => e.stopPropagation()}>
                  {bot.qr_payload && (
                    <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}
                      onClick={(e) => handleShowQr(bot, e)}>
                      QR Code
                    </button>
                  )}
                  <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}
                    onClick={(e) => { e.stopPropagation(); setConfigBot(bot); }}>
                    Configure
                  </button>
                  <button className="btn btn-danger btn-sm"
                    onClick={(e) => handleDelete(bot.id, e)} disabled={deleting === bot.id}>
                    {deleting === bot.id ? <span className="spinner spinner-sm" /> : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ── Logs view ────────────────────────────────────────────────── */
function LogsView({ activity, bots }) {
  const botMap = Object.fromEntries((bots || []).map((b) => [b.id, b.bot_name]));
  const [filter, setFilter] = useState("all");
  const botIds = [...new Set(activity.map((a) => a.bot_id).filter(Boolean))];

  const filtered = filter === "all"
    ? activity
    : activity.filter((a) => a.bot_id === filter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="section-heading">
        <span>Activity Logs</span>
        <select className="input" style={{ width: "auto", padding: "0.375rem 0.75rem", fontSize: "0.8125rem" }}
          value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All bots</option>
          {botIds.map((id) => <option key={id} value={id}>{botMap[id] || id?.slice(0,8)}</option>)}
        </select>
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <div className="empty-title">No logs yet</div>
            <div className="empty-desc">Deploy a bot and activity will appear here.</div>
          </div>
        ) : (
          <div className="activity-list">
            {filtered.map((a) => (
              <div className="activity-row" key={a.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {a.event_type.replace(/_/g, " ")}
                    {a.bot_id && botMap[a.bot_id] && (
                      <span className="badge badge-inactive" style={{ fontSize: "0.65rem" }}>{botMap[a.bot_id]}</span>
                    )}
                  </div>
                  {a.details && <div className="activity-detail">{a.details}</div>}
                </div>
                <div className="activity-time">{timeAgo(a.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── API Keys view ────────────────────────────────────────────── */
function ApiKeysView() {
  const [keys, setKeys]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey]   = useState(null);
  const [name, setName]       = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError]       = useState("");
  const [copied, setCopied]     = useState(false);

  useEffect(() => {
    apiFetch("/auth/apikeys")
      .then((d) => setKeys(d.keys ?? []))
      .catch(() => setKeys([]))
      .finally(() => setLoading(false));
  }, []);

  const createKey = async () => {
    if (!name.trim()) return setError("Key name is required.");
    setError(""); setCreating(true);
    try {
      const d = await apiFetch("/auth/apikeys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setNewKey(d.key);
      setKeys((prev) => [...prev, d.entry]);
      setName("");
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const deleteKey = async (id) => {
    if (!window.confirm("Delete this API key? It will stop working immediately.")) return;
    await apiFetch(`/auth/apikeys/${id}`, { method: "DELETE" }).catch(() => {});
    setKeys((prev) => prev.filter((k) => k.id !== id));
  };

  const copy = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div className="section-heading"><span>API Keys</span></div>

      {newKey && (
        <div className="alert alert-success">
          <div style={{ flex: 1 }}>
            <strong>Key created — copy it now. You won't see it again.</strong>
            <div className="api-key-row" style={{ marginTop: "0.5rem" }}>
              <span className="api-key-value">{newKey}</span>
              <button className="btn btn-sm btn-secondary" onClick={() => copy(newKey)}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "1rem", fontSize: "0.875rem" }}>Create new key</div>
        {error && <div className="alert alert-error" style={{ marginBottom: "0.75rem" }}>{error}</div>}
        <div style={{ display: "flex", gap: "0.625rem" }}>
          <input className="input" placeholder="Key name (e.g. Production)" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createKey()} />
          <button className="btn btn-primary" style={{ whiteSpace: "nowrap" }} onClick={createKey} disabled={creating}>
            {creating ? <span className="spinner spinner-sm" /> : "Generate"}
          </button>
        </div>
        <p className="text-xs text-muted3" style={{ marginTop: "0.5rem" }}>
          Use API keys to authenticate programmatic requests. Include as: <span className="mono">Authorization: Bearer wbk_...</span>
        </p>
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "1rem", fontSize: "0.875rem" }}>
          Your keys ({keys.length}/10)
        </div>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "2rem" }}>
            <span className="spinner" />
          </div>
        ) : keys.length === 0 ? (
          <div className="empty-state" style={{ padding: "2rem" }}>
            <div className="empty-icon">🔑</div>
            <div className="empty-title">No API keys yet</div>
            <div className="empty-desc">Create a key above to start using the WaBot API.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {keys.map((k) => (
              <div key={k.id} className="api-key-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{k.name}</div>
                  <div className="mono text-muted3" style={{ marginTop: "0.125rem" }}>{k.prefix}••••••••••••••••</div>
                </div>
                <div className="text-xs text-muted3" style={{ whiteSpace: "nowrap" }}>Created {timeAgo(k.createdAt)}</div>
                <button className="btn btn-danger btn-sm btn-icon" onClick={() => deleteKey(k.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Billing view ─────────────────────────────────────────────── */
function BillingView({ user, onUpgrade, upgrading }) {
  const isPro = user?.plan_tier === "paid" || user?.planTier === "paid";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div className="section-heading"><span>Billing</span></div>

      <div className="card card-accent">
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ fontSize: "2rem" }}>💳</div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <span style={{ fontWeight: 700 }}>Current plan</span>
              <span className={`badge ${isPro ? "badge-pro" : "badge-free"}`}>{isPro ? "Pro" : "Free"}</span>
            </div>
            <div className="text-sm text-muted">{isPro ? "Up to 100 bots · Priority support" : "Up to 2 bots · Free forever"}</div>
          </div>
          {!isPro && (
            <button className="btn btn-primary" onClick={onUpgrade} disabled={upgrading}>
              {upgrading ? <span className="spinner spinner-sm" /> : "Upgrade to Pro"}
            </button>
          )}
        </div>
      </div>

      {!isPro && (
        <div className="upgrade-banner">
          <div>
            <div style={{ fontWeight: 700, marginBottom: "0.25rem" }}>Unlock Pro — $19/mo</div>
            <div className="text-sm text-muted">100 bot slots, priority support, billing portal, and all future features.</div>
          </div>
          <button className="btn btn-primary" onClick={onUpgrade} disabled={upgrading}>Upgrade now</button>
        </div>
      )}

      <div className="card">
        <div className="section-heading" style={{ marginBottom: "1rem" }}><span>Plan comparison</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: "50%" }}>Feature</th>
                <th style={{ textAlign: "center" }}>Free</th>
                <th style={{ textAlign: "center", color: isPro ? "var(--success)" : "var(--accent)" }}>Pro</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Bots allowed", "2", "100"],
                ["Dashboard access", "✓", "✓"],
                ["QR deployment", "✓", "✓"],
                ["Webhooks per bot", "✓", "✓"],
                ["Auto-reply", "✓", "✓"],
                ["API keys", "✓", "✓"],
                ["Activity logs", "✓", "✓"],
                ["Priority support", "—", "✓"],
                ["Billing portal", "—", "✓"],
              ].map(([label, free, pro]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td style={{ textAlign: "center" }}>{free}</td>
                  <td style={{ textAlign: "center", color: pro === "—" ? "var(--text3)" : "var(--success)" }}>{pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Settings view ────────────────────────────────────────────── */
function SettingsView({ user, onUserUpdated }) {
  const [name, setName]     = useState(user?.full_name || user?.fullName || "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState({ text: "", ok: false });

  const [pwd, setPwd]         = useState({ current: "", next: "", confirm: "" });
  const [savingPwd, setSavingPwd] = useState(false);
  const [msgPwd, setMsgPwd]       = useState({ text: "", ok: false });

  const saveName = async () => {
    if (!name.trim()) return;
    setSaving(true); setMsg({ text: "", ok: false });
    try {
      const updated = await apiFetch("/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ fullName: name }),
      });
      setMsg({ text: "Name updated.", ok: true });
      onUserUpdated(updated);
    } catch (err) {
      setMsg({ text: err.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  const savePwd = async () => {
    if (pwd.next !== pwd.confirm)
      return setMsgPwd({ text: "New passwords don't match.", ok: false });
    setSavingPwd(true); setMsgPwd({ text: "", ok: false });
    try {
      await apiFetch("/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: pwd.current, newPassword: pwd.next }),
      });
      setMsgPwd({ text: "Password changed.", ok: true });
      setPwd({ current: "", next: "", confirm: "" });
    } catch (err) {
      setMsgPwd({ text: err.message, ok: false });
    } finally {
      setSavingPwd(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "520px" }}>
      <div className="section-heading"><span>Account Settings</span></div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "1rem", fontSize: "0.875rem" }}>Profile</div>
        {msg.text && <div className={`alert ${msg.ok ? "alert-success" : "alert-error"}`} style={{ marginBottom: "0.875rem" }}>{msg.text}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <div className="field">
            <label className="field-label">Full name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">Email</label>
            <input className="input" value={user?.email || ""} disabled style={{ opacity: 0.6 }} />
            <span className="field-hint">Email cannot be changed.</span>
          </div>
          <div className="field">
            <label className="field-label">Plan</label>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", paddingTop: "0.25rem" }}>
              <span className={`badge ${(user?.plan_tier || user?.planTier) === "paid" ? "badge-pro" : "badge-free"}`}>
                {(user?.plan_tier || user?.planTier) === "paid" ? "Pro" : "Free"}
              </span>
            </div>
          </div>
          <button className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }}
            onClick={saveName} disabled={saving || !name.trim()}>
            {saving ? <><span className="spinner spinner-sm" /> Saving…</> : "Save name"}
          </button>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "1rem", fontSize: "0.875rem" }}>Change password</div>
        {msgPwd.text && <div className={`alert ${msgPwd.ok ? "alert-success" : "alert-error"}`} style={{ marginBottom: "0.875rem" }}>{msgPwd.text}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <div className="field">
            <label className="field-label">Current password</label>
            <input type="password" className="input" value={pwd.current}
              onChange={(e) => setPwd((p) => ({ ...p, current: e.target.value }))} />
          </div>
          <div className="field">
            <label className="field-label">New password</label>
            <input type="password" className="input" value={pwd.next}
              onChange={(e) => setPwd((p) => ({ ...p, next: e.target.value }))} />
          </div>
          <div className="field">
            <label className="field-label">Confirm new password</label>
            <input type="password" className="input" value={pwd.confirm}
              onChange={(e) => setPwd((p) => ({ ...p, confirm: e.target.value }))} />
          </div>
          <button className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }}
            onClick={savePwd} disabled={savingPwd}>
            {savingPwd ? <><span className="spinner spinner-sm" /> Updating…</> : "Update password"}
          </button>
        </div>
      </div>

      <div className="card" style={{ opacity: 0.7 }}>
        <div style={{ fontWeight: 700, marginBottom: "0.375rem", fontSize: "0.875rem" }}>Member since</div>
        <div className="text-sm text-muted">{fmtDate(user?.created_at || user?.createdAt)}</div>
      </div>
    </div>
  );
}

/* ── Dashboard shell ──────────────────────────────────────────── */
export default function Dashboard() {
  const auth     = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState("overview");
  const [data, setData] = useState({ user: auth.user, bots: [], activity: [], stats: {} });
  const [loading,   setLoading]   = useState(true);
  const [upgrading, setUpgrading] = useState(false);
  const pollRef = useRef(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const d = await apiFetch("/bots/dashboard");
      setData(d);
      if (d.user) {
        auth.patchUser({
          full_name:      d.user.full_name,
          email_verified: d.user.email_verified,
          plan_tier:      d.user.plan_tier,
          email:          d.user.email,
          created_at:     d.user.created_at,
        });
      }
    } catch (err) {
      if (err.status === 401) { auth.logout(); navigate("/login", { replace: true }); }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    pollRef.current = setInterval(fetchDashboard, 30000);
    return () => clearInterval(pollRef.current);
  }, [fetchDashboard]);

  const handleUpgrade = async () => {
    setUpgrading(true);
    try {
      const { url } = await apiFetch("/billing/checkout", { method: "POST" });
      window.location.href = url;
    } catch (err) {
      alert(err.message);
    } finally {
      setUpgrading(false);
    }
  };

  const user = data.user || auth.user || {};
  const initials = ((user.full_name || user.fullName || user.email || "U")[0] || "U").toUpperCase();
  const isPro    = user.plan_tier === "paid" || user.planTier === "paid";
  const isVerified = user.email_verified || user.emailVerified;
  const displayName = user.full_name || user.fullName || user.email || "there";
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <div className="dash-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🤖</div>
          WaBot
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">Menu</div>
          {NAV.map((n) => (
            <button key={n.id}
              className={`sidebar-nav-item ${activeTab === n.id ? "active" : ""}`}
              onClick={() => setActiveTab(n.id)}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="user-pill">
            <div className="user-avatar">{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="user-name truncate">{displayName.split(" ")[0]}</div>
              <div className="user-email truncate">{user.email || ""}</div>
            </div>
            <span className={`badge ${isPro ? "badge-pro" : "badge-free"}`}>{isPro ? "Pro" : "Free"}</span>
          </div>
          <button className="sidebar-nav-item" style={{ marginTop: "0.375rem", color: "var(--error)" }} onClick={auth.logout}>
            <span className="nav-icon">⏎</span> Sign out
          </button>
        </div>
      </aside>

      <main className="dash-main">
        <div className="dash-topbar">
          <div>
            <div style={{ fontWeight: 700, fontSize: "1rem" }}>
              {greeting}, {displayName.split(" ")[0]} 👋
            </div>
            <div className="text-sm text-muted">{NAV.find((n) => n.id === activeTab)?.label}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {!isVerified && (
              <div className="alert alert-warning" style={{ padding: "0.375rem 0.75rem", fontSize: "0.8rem" }}>
                ⚠ Verify your email to deploy bots
              </div>
            )}
            {!isPro && (
              <button className="btn btn-primary btn-sm" onClick={handleUpgrade} disabled={upgrading}>
                {upgrading ? <span className="spinner spinner-sm" /> : "⚡ Upgrade"}
              </button>
            )}
          </div>
        </div>

        <div className="dash-content">
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "4rem" }}>
              <span className="spinner spinner-lg" />
            </div>
          ) : (
            <>
              {activeTab === "overview"  && <Overview  data={data} onGoToBots={() => setActiveTab("bots")} />}
              {activeTab === "bots"      && <BotsView  data={data} onRefresh={fetchDashboard} />}
              {activeTab === "logs"      && <LogsView  activity={data.activity} bots={data.bots} />}
              {activeTab === "apikeys"   && <ApiKeysView />}
              {activeTab === "billing"   && <BillingView user={user} onUpgrade={handleUpgrade} upgrading={upgrading} />}
              {activeTab === "settings"  && <SettingsView user={user} onUserUpdated={(u) => auth.patchUser(u)} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
