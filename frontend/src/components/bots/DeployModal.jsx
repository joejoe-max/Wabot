import { useCallback, useEffect, useRef, useState } from "react";
import { Modal }   from "../ui/Modal.jsx";
import { Alert }   from "../ui/Alert.jsx";
import { Spinner } from "../ui/Spinner.jsx";
import { botsApi } from "../../api/bots.js";

const BOT_TYPES = [
  {
    id:    "dm",
    icon:  "💬",
    label: "DM Bot",
    desc:  "Responds to direct (1-on-1) WhatsApp messages. Perfect for customer support, sales, and personal bots."
  },
  {
    id:    "group",
    icon:  "👥",
    label: "Group Bot",
    desc:  "Responds inside WhatsApp group chats. Ideal for community management, announcements, and group commands."
  }
];

const WARNINGS = [
  {
    icon: "⚠️",
    title: "Unofficial automation",
    desc: "WaBot uses the Baileys library which is not officially supported by WhatsApp. Your account may be flagged or banned for using automation."
  },
  {
    icon: "🚫",
    title: "Risk of account ban",
    desc: "WhatsApp actively detects and bans accounts using unofficial clients. Use a dedicated number — never your personal or primary business number."
  },
  {
    icon: "👤",
    title: "You are responsible",
    desc: "You are solely responsible for how this bot is used. WaBot is not liable for bans, data loss, or any consequences of using WhatsApp automation."
  },
  {
    icon: "💼",
    title: "Business use",
    desc: "For official, high-volume WhatsApp business messaging, consider the official WhatsApp Business API (Meta) which is ban-safe and compliant."
  }
];

/* Baileys rotates QR codes roughly every 60 seconds */
const QR_LIFE_S    = 60;
/* First HTTP poll: give the bot ~3 s to start and emit a QR */
const FIRST_POLL_MS = 3_000;
/* Ongoing poll interval as SSE fallback */
const POLL_MS       = 8_000;
/* How long to wait for a scan before the modal gives up */
const TIMEOUT_MS    = 10 * 60_000;

export function DeployModal({ user, onClose, onDeployed }) {
  const [step,         setStep]         = useState("warning");
  const [accepted,     setAccepted]     = useState(false);
  const [name,         setName]         = useState("");
  const [desc,         setDesc]         = useState("");
  const [botType,      setBotType]      = useState("dm");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");
  const [qrUrl,        setQrUrl]        = useState(null);
  const [countdown,    setCountdown]    = useState(QR_LIFE_S);
  const [qrExpired,    setQrExpired]    = useState(false);  /* true when countdown hits 0 */
  const [method, setMethod] = useState("qr"); // qr | code
  const [pairCode, setPairCode] = useState(null);
  const [pairExpiresAt, setPairExpiresAt] = useState(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [claiming, setClaiming] = useState(false);

  const esRef          = useRef(null);
  const timeoutRef     = useRef(null);
  const pollRef        = useRef(null);
  const firstPollRef   = useRef(null);
  const cdRef          = useRef(null);
  const connectedRef   = useRef(false);
  const botIdRef       = useRef(null);

  /* ── cleanup on unmount ──────────────────────────────────────── */
  useEffect(() => () => {
    esRef.current?.close();
    clearTimeout(timeoutRef.current);
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
  }, []);

  /* ── countdown ───────────────────────────────────────────────── */
  const startCountdown = useCallback(() => {
    clearInterval(cdRef.current);
    setCountdown(QR_LIFE_S);
    setQrExpired(false);
    cdRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          setQrExpired(true);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, []);

  /* ── called when any QR url arrives ─────────────────────────── */
  const markQr = useCallback((url) => {
    setQrUrl(url);
    setQrExpired(false);
    startCountdown();
  }, [startCountdown]);

  /* ── called when connected status arrives ────────────────────── */
  const markConnected = useCallback((es) => {
    if (connectedRef.current) return;
    connectedRef.current = true;
    clearTimeout(timeoutRef.current);
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
    // close SSE and notify parent that deployment completed
    try { es?.close(); } catch (e) {}
    // give parent a chance to refresh state, then close this modal
    try { onDeployed(); } catch (e) {}
    try { onClose(); } catch (e) {}
  }, [onDeployed, onClose]);

  /* ── HTTP polling (SSE fallback + initial fetch) ─────────────── */
  const doPoll = useCallback(async () => {
    if (connectedRef.current) return;
    try {
      const data = await botsApi.qr(botIdRef.current);
      if (data?.qrCodeDataUrl) markQr(data.qrCodeDataUrl);
    } catch {
      /* 404 = QR not ready yet — silently ignore */
    }
  }, [markQr]);

  const startPolling = useCallback((botId) => {
    botIdRef.current = botId;
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);

    /* First poll after bot has had time to start */
    firstPollRef.current = setTimeout(doPoll, FIRST_POLL_MS);

    /* Ongoing interval as SSE fallback */
    pollRef.current = setInterval(doPoll, POLL_MS);
  }, [doPoll]);

  /* ── SSE connection ──────────────────────────────────────────── */
  const connectSse = useCallback((botId, onConn) => {
    const token = localStorage.getItem("wabot_token") ?? "";
    const es    = new EventSource(botsApi.eventsUrl(botId, token));
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "qr")     markQr(msg.qrUrl);
        if (msg.type === "pair_code") {
          // pair code may be a string or an object
          if (typeof msg.code === "string") setPairCode(msg.code);
          else if (msg.code && typeof msg.code === "object") {
            setPairCode(msg.code.code ?? null);
            setPairExpiresAt(msg.code.expiresAt ?? null);
          }
        }
        if (msg.type === "status") {
          if (msg.status === "connected") onConn(es);
        }
      } catch {}
    };

    /* SSE errors are non-fatal — EventSource auto-reconnects,
       and the HTTP poll ensures we don't miss QR rotations. */
    es.onerror = () => {};

    /* Overall timeout: 10 min with no successful scan */
    timeoutRef.current = setTimeout(() => {
      if (!connectedRef.current) {
        es.close();
        clearTimeout(firstPollRef.current);
        clearInterval(pollRef.current);
        clearInterval(cdRef.current);
        setError("Connection timed out (10 min). The QR window has closed. Please try deploying again.");
        setStep("form");
      }
    }, TIMEOUT_MS);
  }, [markQr]);

  /* ── Deploy form submit ──────────────────────────────────────── */
  const deploy = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Bot name is required.");
    setError(""); setLoading(true);
    try {
      const data = await botsApi.deploy({ botName: name.trim(), description: desc.trim(), botType, method });
      const botId = data.bot.id;
      // If backend returned a pairing code from deploy, show it immediately
      if (data.pairing?.code) {
        setPairCode(data.pairing.code);
        if (data.pairing.expiresAt) setPairExpiresAt(data.pairing.expiresAt);
        setMethod("code");
      }
      connectedRef.current = false;
      setQrUrl(null);
      setQrExpired(false);
      // Show connection method choice (QR or pairing code)
      setStep("qr");
      // Start SSE for live updates regardless of method
      connectSse(botId, markConnected);
      startPolling(botId);
      // If pairing code chosen, pre-create a pairing code (only if not returned by deploy)
      if (method === "code" && !pairCode) {
        try {
          const resp = await botsApi.createPairingCode(botId, phoneInput);
          setPairCode(resp.code);
          setPairExpiresAt(resp.expiresAt);
        } catch (e) {
          // ignore — user can still use QR
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  /* ── Email gate ──────────────────────────────────────────────── */
  if (!user?.emailVerified && !user?.email_verified) {
    return (
      <Modal onClose={onClose}>
        <div style={{ fontSize: "2rem" }}>📧</div>
        <h3>Verify your email first</h3>
        <p>Check your inbox for the verification link, then come back to deploy bots.</p>
        <button className="btn btn-primary w-full" onClick={onClose}>Got it</button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>

      {/* ── Step 0: Warning ──────────────────────────────────── */}
      {step === "warning" && (
        <>
          <div style={{ fontSize: "2rem" }}>⚠️</div>
          <h3 style={{ color: "var(--warning)" }}>Before you deploy</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: "0.25rem" }}>
            Please read and acknowledge the following before deploying a WhatsApp bot.
          </p>

          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            {WARNINGS.map((w) => (
              <div
                key={w.title}
                style={{
                  background: "var(--warning-bg)",
                  border: "1px solid rgba(245,158,11,0.2)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem 1rem",
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "flex-start"
                }}
              >
                <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>{w.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.8125rem", color: "var(--text)", marginBottom: "0.2rem" }}>
                    {w.title}
                  </div>
                  <div style={{ fontSize: "0.775rem", color: "var(--text2)", lineHeight: 1.5 }}>
                    {w.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <label style={{
            width: "100%",
            display: "flex",
            alignItems: "flex-start",
            gap: "0.75rem",
            padding: "0.875rem",
            background: "var(--bg2)",
            border: `1.5px solid ${accepted ? "var(--accent)" : "var(--border)"}`,
            borderRadius: "var(--radius)",
            cursor: "pointer",
            transition: "border-color 0.14s ease"
          }}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              style={{ marginTop: "2px", accentColor: "var(--accent)", width: "16px", height: "16px", flexShrink: 0 }}
            />
            <span style={{ fontSize: "0.8125rem", color: "var(--text2)", lineHeight: 1.5 }}>
              I understand that WhatsApp automation is unofficial and may result in my account being banned.
              I accept full responsibility for how this bot is used, and I will not use it to send spam.
            </span>
          </label>

          <div style={{ width: "100%", display: "flex", gap: "0.75rem" }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!accepted}
              onClick={() => setStep("form")}
              style={{ flex: 1, touchAction: "manipulation" }}
            >
              I understand — Continue
            </button>
          </div>
        </>
      )}

      {/* ── Step 1: Form ─────────────────────────────────────── */}
      {step === "form" && (
        <>
          <div style={{ fontSize: "2rem" }}>🚀</div>
          <h3>Deploy a new bot</h3>

          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.25rem" }}>
            <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text2)" }}>Bot type</div>
            <div className="deploy-type-grid">
              {BOT_TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setBotType(t.id)}
                  style={{
                    padding: "0.875rem",
                    borderRadius: "var(--radius)",
                    border: `1.5px solid ${botType === t.id ? "var(--accent)" : "var(--border)"}`,
                    background: botType === t.id ? "var(--accent-dim)" : "var(--card)",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.14s ease"
                  }}
                >
                  <div style={{ fontSize: "1.25rem", marginBottom: "0.25rem" }}>{t.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: "0.875rem", color: botType === t.id ? "var(--accent)" : "var(--text)", marginBottom: "0.25rem" }}>{t.label}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text3)", lineHeight: 1.4 }}>{t.desc}</div>
                </button>
              ))}
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text3)", background: "var(--bg)", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
              ⚠ Bot type cannot be changed after deployment.
            </div>
          </div>

          <form onSubmit={deploy} style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {error && <Alert type="error">{error}</Alert>}
            <div className="field">
              <label className="field-label">Bot name *</label>
              <input
                className="input"
                placeholder={botType === "group" ? "e.g. group-helper" : "e.g. support-bot"}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label className="field-label">Description (optional)</label>
              <input className="input" placeholder="What does this bot do?" value={desc}
                onChange={(e) => setDesc(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={loading}>
              {loading ? <><Spinner size="sm" /> Deploying…</> : `Deploy ${botType === "group" ? "Group" : "DM"} Bot`}
            </button>
          </form>
        </>
      )}

      {/* ── Step 2: QR ───────────────────────────────────────── */}
      {step === "qr" && (
        <>
          <div style={{ fontSize: "2rem" }}>📱</div>
          <h3>Connect your number</h3>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button className={method === "qr" ? "btn btn-primary" : "btn btn-ghost"} onClick={() => setMethod("qr")}>QR code</button>
            <button className={method === "code" ? "btn btn-primary" : "btn btn-ghost"} onClick={() => setMethod("code")}>Pairing code (mobile recommended)</button>
          </div>

          {method === "code" && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: "0.9rem", color: "var(--text2)", marginBottom: 8 }}>
                Enter the phone number you will pair from (international format). An 8-digit code will be generated and shown below — open WhatsApp on your phone and enter the code in the pairing flow.
              </div>
              <input className="input" placeholder="+15551234567" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} />
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button className="btn btn-primary" onClick={async () => {
                  if (!botIdRef.current) return;
                  setPairCode(null); setPairExpiresAt(null);
                  try {
                    const resp = await botsApi.createPairingCode(botIdRef.current, phoneInput);
                    setPairCode(resp.code); setPairExpiresAt(resp.expiresAt);
                  } catch (e) { setError(e.message || "Could not create pairing code."); }
                }}>Generate code</button>
                <button className="btn btn-ghost" onClick={() => { setPairCode(null); setPhoneInput(""); }}>Reset</button>
              </div>

              {pairCode && (
                <div className="card" style={{ marginTop: 12, textAlign: "center" }}>
                  <div style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "0.2rem" }}>{pairCode}</div>
                  <div style={{ color: "var(--text3)", marginTop: 6 }}>Expires: {new Date(pairExpiresAt).toLocaleTimeString()}</div>
                  <div style={{ marginTop: 8 }}>
                    <button className="btn btn-primary" onClick={async () => {
                      if (!botIdRef.current || !pairCode) return;
                      setClaiming(true);
                      try {
                        // In a real flow the bot would write session data; here we simulate claim
                        await botsApi.claimPairingCode(botIdRef.current, pairCode, { simulated: true }).catch(() => {});
                        // After claiming, poll bot status via SSE/poll — if connected, markConnected will run
                      } catch (e) { setError(e.message || "Could not claim pairing code."); }
                      setClaiming(false);
                    }}>{claiming ? "Claiming…" : "Mark as paired"}</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {method === "qr" && (
            <>
              <h3 style={{ display: "none" }}>Scan to connect</h3>
            </>
          )}

          {method === "qr" && qrUrl && (
            /* ── QR available ── */
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.625rem", width: "100%" }}>
              <p style={{ fontSize: "0.8125rem", color: "var(--text2)", textAlign: "center", margin: 0 }}>
                Open WhatsApp → <strong>Linked Devices</strong> → <strong>Link a Device</strong>, then scan:
              </p>

              {/* QR image + optional "refreshing" overlay */}
              <div style={{ position: "relative", display: "inline-block" }}>
                <div
                  className="qr-wrap"
                  style={{
                    opacity:    qrExpired ? 0.35 : 1,
                    transition: "opacity 0.4s ease",
                    filter:     qrExpired ? "blur(2px)" : "none",
                  }}
                >
                  <img src={qrUrl} alt="WhatsApp QR code" />
                </div>

                {qrExpired && (
                  <div style={{
                    position:       "absolute",
                    inset:          0,
                    display:        "flex",
                    flexDirection:  "column",
                    alignItems:     "center",
                    justifyContent: "center",
                    gap:            "0.5rem",
                    borderRadius:   "var(--radius)",
                    background:     "rgba(10,10,15,0.55)",
                    backdropFilter: "blur(4px)",
                  }}>
                    <Spinner size="md" />
                    <span style={{ fontSize: "0.75rem", color: "#fff", fontWeight: 600 }}>
                      Refreshing QR…
                    </span>
                  </div>
                )}
              </div>

              {/* Countdown row */}
              <div style={{ fontSize: "0.75rem", color: "var(--text3)", textAlign: "center" }}>
                {qrExpired ? (
                  <span style={{ color: "var(--warning)" }}>
                    ⟳ Waiting for new QR code from WhatsApp…
                  </span>
                ) : (
                  <>
                    Refreshes in{" "}
                    <strong style={{ color: countdown <= 10 ? "var(--warning)" : "var(--text2)" }}>
                      {countdown}s
                    </strong>
                  </>
                )}
                {" "}· window stays open 10 min
              </div>

              {/* Hint */}
              <div style={{
                fontSize: "0.75rem",
                color: "var(--text3)",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "0.5rem 0.75rem",
                width: "100%",
                textAlign: "center"
              }}>
                The QR code rotates every ~60 s. If it expires, a new one loads automatically.
              </div>
            </div>
          )}

          {method === "qr" && !qrUrl && (
            /* ── Waiting for first QR ── */
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.875rem", padding: "1.5rem" }}>
              <Spinner size="lg" />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.875rem", color: "var(--text2)", fontWeight: 600 }}>
                  Generating QR code…
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: "0.25rem" }}>
                  This takes a few seconds. The code will appear here automatically.
                </div>
              </div>
            </div>
          )}

          {error && <Alert type="error">{error}</Alert>}
          <button className="btn btn-secondary w-full" onClick={onClose}>Cancel</button>
        </>
      )}

    </Modal>
  );
}
