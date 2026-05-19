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
    desc:  "Responds to direct (1-on-1) WhatsApp messages."
  },
  {
    id:    "group",
    icon:  "👥",
    label: "Group Bot",
    desc:  "Responds inside WhatsApp group chats."
  }
];

const WARNINGS = [
  {
    icon: "⚠️",
    title: "Unofficial automation",
    desc: "WaBot uses Baileys which is not officially supported by WhatsApp."
  },
  {
    icon: "🚫",
    title: "Risk of account ban",
    desc: "Use a dedicated number — never your personal or primary business number."
  },
  {
    icon: "👤",
    title: "You are responsible",
    desc: "You are solely responsible for how this bot is used."
  }
];

const QR_LIFE_S    = 60;
const FIRST_POLL_MS = 3_000;
const POLL_MS       = 8_000;
const TIMEOUT_MS    = 10 * 60_000;

export function DeployModal({ user, onClose, onDeployed }) {
  const [step, setStep] = useState("warning");
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [botType, setBotType] = useState("dm");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qrUrl, setQrUrl] = useState(null);
  const [countdown, setCountdown] = useState(QR_LIFE_S);
  const [qrExpired, setQrExpired] = useState(false);
  const [method, setMethod] = useState("qr");
  const [pairCode, setPairCode] = useState(null);
  const [pairExpiresAt, setPairExpiresAt] = useState(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [showMethodSelect, setShowMethodSelect] = useState(false);
  const [connectionStep, setConnectionStep] = useState("waiting"); // waiting, showing

  const esRef = useRef(null);
  const timeoutRef = useRef(null);
  const pollRef = useRef(null);
  const firstPollRef = useRef(null);
  const cdRef = useRef(null);
  const connectedRef = useRef(false);
  const botIdRef = useRef(null);
  const codeReceivedRef = useRef(false);

  useEffect(() => () => {
    esRef.current?.close();
    clearTimeout(timeoutRef.current);
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
  }, []);

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

  const markQr = useCallback((url) => {
    setQrUrl(url);
    setQrExpired(false);
    startCountdown();
  }, [startCountdown]);

  const markConnected = useCallback((es) => {
    if (connectedRef.current) return;
    connectedRef.current = true;
    clearTimeout(timeoutRef.current);
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
    try { es?.close(); } catch (e) {}
    setTimeout(() => {
      try { onDeployed(); } catch (e) {}
      try { onClose(); } catch (e) {}
    }, 1000);
  }, [onDeployed, onClose]);

  const doPoll = useCallback(async () => {
    if (connectedRef.current) return;
    try {
      const data = await botsApi.qr(botIdRef.current);
      if (data?.qrCodeDataUrl) markQr(data.qrCodeDataUrl);
    } catch {}
  }, [markQr]);

  const startPolling = useCallback((botId) => {
    botIdRef.current = botId;
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    firstPollRef.current = setTimeout(doPoll, FIRST_POLL_MS);
    pollRef.current = setInterval(doPoll, POLL_MS);
  }, [doPoll]);

  const connectSse = useCallback((botId, onConn) => {
    const token = localStorage.getItem("wabot_token") ?? "";
    const es = new EventSource(botsApi.eventsUrl(botId, token));
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        console.log("[SSE] Received:", msg); // DEBUG LOG
        
        if (msg.type === "qr") {
          markQr(msg.qrUrl);
        }
        if (msg.type === "pair_code") {
          console.log("[SSE] Pairing code received:", msg.code);
          codeReceivedRef.current = true;
          if (typeof msg.code === "string") {
            setPairCode(msg.code);
          } else if (msg.code && typeof msg.code === "object") {
            setPairCode(msg.code.code ?? null);
            setPairExpiresAt(msg.code.expiresAt ?? null);
          }
          setConnectionStep("showing");
        }
        if (msg.type === "status") {
          if (msg.status === "connected") onConn(es);
        }
      } catch (err) {
        console.error("[SSE] Parse error:", err);
      }
    };

    es.onerror = (err) => {
      console.error("[SSE] Error:", err);
    };

    timeoutRef.current = setTimeout(() => {
      if (!connectedRef.current && !codeReceivedRef.current) {
        es.close();
        clearTimeout(firstPollRef.current);
        clearInterval(pollRef.current);
        clearInterval(cdRef.current);
        setError("Connection timed out (10 min). Please try again.");
        setStep("form");
        setShowMethodSelect(false);
      }
    }, TIMEOUT_MS);
  }, [markQr]);

  const handleFormSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Bot name is required.");
    setError("");
    setShowMethodSelect(true);
  };

  const deployWithMethod = async () => {
    setLoading(true);
    setError("");
    codeReceivedRef.current = false;
    connectedRef.current = false;
    setPairCode(null);
    setConnectionStep("waiting");

    try {
      const data = await botsApi.deploy({
        botName: name.trim(),
        description: desc.trim(),
        botType,
      });
      const botId = data.bot.id;
      botIdRef.current = botId;

      // Move to connecting step — keep modal open to show QR / pairing code
      setStep("connecting");

      // Notify parent so the bot list refreshes (bot is now in DB with "connecting" status)
      try { onDeployed(); } catch (e) {}

      // Open SSE stream to receive QR, pairing-code, and status events
      connectSse(botId, markConnected);

      if (method === "qr") {
        // Also poll HTTP endpoint as a fallback in case SSE is buffered
        startPolling(botId);
      } else if (method === "code") {
        // Ask the backend to request a pairing code — response comes via SSE AND HTTP
        const cleanPhone = phoneInput.replace(/[^0-9]/g, "");
        botsApi.createPairingCode(botId, cleanPhone)
          .then((resp) => {
            if (resp.code) {
              codeReceivedRef.current = true;
              const codeStr = typeof resp.code === "string"
                ? resp.code
                : (resp.code?.code ?? null);
              setPairCode(codeStr);
              setPairExpiresAt(resp.expiresAt ?? null);
              setConnectionStep("showing");
            }
          })
          .catch((err) => {
            setError(err.message || "Could not get pairing code. You can use QR code instead.");
          });
      }

    } catch (err) {
      setError(err.message);
      setShowMethodSelect(true);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.emailVerified && !user?.email_verified) {
    return (
      <Modal onClose={onClose}>
        <div style={{ fontSize: "2rem", textAlign: "center" }}>📧</div>
        <h3 style={{ textAlign: "center" }}>Verify your email first</h3>
        <p style={{ textAlign: "center", fontSize: "0.875rem", color: "var(--text2)" }}>Check your inbox for the verification link.</p>
        <button className="btn btn-primary w-full" onClick={onClose}>Got it</button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ width: "100%" }}>

        {/* Step 0: Warning */}
        {step === "warning" && (
          <div>
            <div style={{ fontSize: "2rem", textAlign: "center" }}>⚠️</div>
            <h3 style={{ color: "var(--warning)", textAlign: "center", marginBottom: "0.5rem" }}>Before you deploy</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem", maxHeight: "280px", overflowY: "auto", marginBottom: "1rem" }}>
              {WARNINGS.map((w) => (
                <div key={w.title} style={{
                  background: "var(--warning-bg)",
                  border: "1px solid rgba(245,158,11,0.2)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem",
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "flex-start"
                }}>
                  <span style={{ fontSize: "1rem", flexShrink: 0 }}>{w.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.8rem", color: "var(--text)", marginBottom: "0.2rem" }}>{w.title}</div>
                    <div style={{ fontSize: "0.73rem", color: "var(--text2)", lineHeight: 1.45 }}>{w.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <label style={{
              width: "100%",
              display: "flex",
              alignItems: "flex-start",
              gap: "0.75rem",
              padding: "0.75rem",
              background: "var(--bg2)",
              border: `1.5px solid ${accepted ? "var(--accent)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
              cursor: "pointer",
              marginBottom: "1rem"
            }}>
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} style={{ marginTop: "2px", flexShrink: 0 }} />
              <span style={{ fontSize: "0.73rem", color: "var(--text2)", lineHeight: 1.4 }}>
                I understand the risks and accept responsibility.
              </span>
            </label>

            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!accepted} onClick={() => setStep("form")} style={{ flex: 1 }}>Continue →</button>
            </div>
          </div>
        )}

        {/* Step 1: Bot Details Form */}
        {step === "form" && !showMethodSelect && (
          <div>
            <div style={{ fontSize: "2rem", textAlign: "center" }}>🚀</div>
            <h3 style={{ textAlign: "center", marginBottom: "1rem" }}>Deploy a new bot</h3>

            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text2)", marginBottom: "0.5rem" }}>Bot type</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {BOT_TYPES.map((t) => (
                  <button key={t.id} type="button" onClick={() => setBotType(t.id)} style={{
                    padding: "0.875rem",
                    borderRadius: "var(--radius)",
                    border: `1.5px solid ${botType === t.id ? "var(--accent)" : "var(--border)"}`,
                    background: botType === t.id ? "var(--accent-dim)" : "var(--card)",
                    cursor: "pointer",
                    textAlign: "center",
                    width: "100%"
                  }}>
                    <div style={{ fontSize: "1.25rem", marginBottom: "0.25rem" }}>{t.icon}</div>
                    <div style={{ fontWeight: 700, fontSize: "0.875rem", color: botType === t.id ? "var(--accent)" : "var(--text)" }}>{t.label}</div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text3)", lineHeight: 1.4 }}>{t.desc}</div>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--text3)", background: "var(--bg)", padding: "0.5rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", marginTop: "0.5rem", textAlign: "center" }}>
                ⚠ Bot type cannot be changed after deployment.
              </div>
            </div>

            <form onSubmit={handleFormSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {error && <Alert type="error">{error}</Alert>}
              <div className="field">
                <label className="field-label">Bot name *</label>
                <input className="input" placeholder={botType === "group" ? "e.g. group-helper" : "e.g. support-bot"} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </div>
              <div className="field">
                <label className="field-label">Description (optional)</label>
                <input className="input" placeholder="What does this bot do?" value={desc} onChange={(e) => setDesc(e.target.value)} />
              </div>
              <button type="submit" className="btn btn-primary w-full">Continue →</button>
            </form>
          </div>
        )}

        {/* Step 1.5: Method Selection */}
        {step === "form" && showMethodSelect && (
          <div>
            <div style={{ fontSize: "2rem", textAlign: "center" }}>🔌</div>
            <h3 style={{ textAlign: "center", marginBottom: "1rem" }}>Choose connection method</h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1rem" }}>
              <button className={method === "qr" ? "btn btn-primary" : "btn btn-secondary"} onClick={() => setMethod("qr")} style={{ width: "100%", padding: "0.875rem" }}>📱 QR Code</button>
              <button className={method === "code" ? "btn btn-primary" : "btn btn-secondary"} onClick={() => setMethod("code")} style={{ width: "100%", padding: "0.875rem" }}>🔢 Pairing Code</button>
            </div>

            {method === "code" && (
              <div style={{ marginBottom: "1rem" }}>
                <label className="field-label">Phone number</label>
                <input className="input" placeholder="e.g., 628123456789" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} />
                <div style={{ fontSize: "0.7rem", color: "var(--text3)", marginTop: "0.25rem" }}>
                  No + sign, no spaces. Just numbers with country code.
                </div>
              </div>
            )}

            {error && <Alert type="error">{error}</Alert>}

            <div style={{ display: "flex", gap: "0.75rem", flexDirection: "column", marginTop: "0.5rem" }}>
              <button className="btn btn-secondary" onClick={() => setShowMethodSelect(false)}>← Back</button>
              <button className="btn btn-primary" onClick={deployWithMethod} disabled={loading || (method === "code" && !phoneInput)} style={{ width: "100%" }}>
                {loading ? <><Spinner size="sm" /> Deploying…</> : `Deploy & Connect`}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Connection Screen */}
        {step === "connecting" && (
          <div>
            <div style={{ fontSize: "2rem", textAlign: "center" }}>{method === "qr" ? "📱" : "🔢"}</div>
            <h3 style={{ textAlign: "center", marginBottom: "1rem" }}>{method === "qr" ? "Scan QR Code" : "Enter Pairing Code"}</h3>

            {method === "code" ? (
              <div style={{ textAlign: "center" }}>
                {pairCode ? (
                  <>
                    <div style={{ 
                      fontSize: "clamp(1.2rem, 7vw, 2rem)", 
                      fontWeight: "bold", 
                      letterSpacing: "0.3rem",
                      background: "linear-gradient(135deg, var(--accent) 0%, #c084fc 100%)",
                      padding: "1rem",
                      borderRadius: "var(--radius-xl)",
                      fontFamily: "monospace",
                      color: "white",
                      wordBreak: "break-all",
                      marginBottom: "1rem"
                    }}>
                      {pairCode}
                    </div>
                    
                    <div style={{ 
                      background: "var(--accent-dim)", 
                      padding: "0.75rem", 
                      borderRadius: "var(--radius)",
                      marginBottom: "1rem",
                      textAlign: "left"
                    }}>
                      <p style={{ fontWeight: "bold", marginBottom: "0.5rem", fontSize: "0.8rem" }}>📋 Instructions:</p>
                      <ol style={{ marginLeft: "1rem", color: "var(--text2)", lineHeight: "1.6", fontSize: "0.7rem" }}>
                        <li>Open WhatsApp on your phone</li>
                        <li>Go to Settings → Linked Devices</li>
                        <li>Tap "Link with phone number"</li>
                        <li>Enter the 8-digit code above</li>
                      </ol>
                    </div>

                    {pairExpiresAt && (
                      <p style={{ fontSize: "0.7rem", color: "var(--text3)" }}>
                        ⏱ Expires: {new Date(pairExpiresAt).toLocaleTimeString()}
                      </p>
                    )}
                  </>
                ) : (
                  <div style={{ padding: "1rem", textAlign: "center" }}>
                    <Spinner size="lg" />
                    <p style={{ marginTop: "0.5rem", color: "var(--text2)", fontSize: "0.8rem" }}>Waiting for pairing code...</p>
                    <p style={{ marginTop: "0.25rem", color: "var(--text3)", fontSize: "0.7rem" }}>This may take a few seconds</p>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ textAlign: "center" }}>
                {qrUrl ? (
                  <>
                    <p style={{ fontSize: "0.7rem", color: "var(--text2)", marginBottom: "0.5rem" }}>
                      Open WhatsApp → Linked Devices → Link a Device
                    </p>
                    <div className="qr-wrap" style={{ display: "inline-block" }}>
                      <img src={qrUrl} alt="QR code" style={{ width: "min(180px, 60vw)", height: "auto" }} />
                    </div>
                    {qrExpired && (
                      <p style={{ fontSize: "0.7rem", color: "var(--warning)", marginTop: "0.5rem" }}>⟳ Refreshing QR...</p>
                    )}
                  </>
                ) : (
                  <div style={{ padding: "1rem", textAlign: "center" }}>
                    <Spinner size="lg" />
                    <p style={{ marginTop: "0.5rem", color: "var(--text2)", fontSize: "0.8rem" }}>Generating QR code...</p>
                  </div>
                )}
              </div>
            )}

            {error && <Alert type="error" style={{ marginTop: "1rem" }}>{error}</Alert>}
            
            <button className="btn btn-secondary w-full" onClick={onClose} style={{ marginTop: "1rem" }}>Cancel</button>
          </div>
        )}

      </div>
    </Modal>
  );
}
