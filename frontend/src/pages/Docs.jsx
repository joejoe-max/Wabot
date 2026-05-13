import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BASE } from "../api/client.js";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "auth", label: "Authentication" },
  { id: "limits", label: "Limits" },
  { id: "send", label: "Send message" },
  { id: "presets", label: "OTP / Forms / Welcome" },
  { id: "bots", label: "Bots" },
  { id: "templates", label: "Templates" },
  { id: "webhooks", label: "Webhook test" },
  { id: "errors", label: "Errors" },
];

const RATE_LIMITS = [
  { plan: "Free", calls: "30 calls/min", messages: "1,000 messages/month", keys: "1 API key" },
  { plan: "Pro", calls: "300 calls/min", messages: "100,000 messages/month", keys: "10 API keys" },
];

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: "20px",
      overflow: "hidden",
      background: "#0f172a",
      boxShadow: "0 20px 60px rgba(15, 23, 42, 0.24)"
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.8rem 1rem",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        color: "rgba(255,255,255,0.72)"
      }}>
        <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>Example</span>
        <button className="btn btn-secondary btn-sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: "1rem",
        overflowX: "auto",
        color: "#e2e8f0",
        fontSize: "0.82rem",
        lineHeight: 1.65,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Section({ id, title, children }) {
  return (
    <section id={id} style={{ scrollMarginTop: "7rem" }}>
      <h2 style={{ fontSize: "1.35rem", marginBottom: "0.75rem" }}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", color: "var(--text2)" }}>
        {children}
      </div>
    </section>
  );
}

export default function Docs() {
  const apiBase = useMemo(() => BASE, []);
  const searchBase = apiBase.startsWith("http")
    ? apiBase
    : "Backend URL from `VITE_API_BASE_URL`";

  const snippets = useMemo(() => ({
    curlSend: `curl -X POST "${apiBase}/v1/messages/send" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "message": "Hello from WaBot"
  }'`,
    jsSend: `const response = await fetch("${apiBase}/v1/messages/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer wbk_YOUR_API_KEY",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    bot_id: "your-bot-id",
    to: "2348012345678",
    message: "Order confirmed"
  })
});

const data = await response.json();
console.log(data);`,
    otpSend: `curl -X POST "${apiBase}/v1/messages/otp" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "app_name": "WaBot",
    "code": "482901",
    "expires_in_minutes": 10
  }'`,
    formSend: `curl -X POST "${apiBase}/v1/messages/form-submission" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "form_name": "Lead Capture",
    "fields": {
      "name": "Ada",
      "email": "ada@example.com",
      "plan": "Pro"
    }
  }'`,
    welcomeSend: `curl -X POST "${apiBase}/v1/messages/welcome" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "name": "Ada"
  }'`,
    botsList: `GET ${apiBase}/v1/bots
Authorization: Bearer wbk_YOUR_API_KEY`,
    templateSend: `{
  "bot_id": "your-bot-id",
  "to": "2348012345678",
  "template": "welcome",
  "vars": {
    "name": "Ada",
    "company": "Northwind"
  }
}`,
    webhookTest: `curl -X POST "${apiBase}/v1/webhooks/test" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://your-app.com/webhooks/wabot",
    "secret": "whsec_your_outbound_secret"
  }'`,
  }), [apiBase]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg)"
    }}>
      <div style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        backdropFilter: "blur(18px)",
        background: "rgba(255, 253, 248, 0.88)",
        borderBottom: "1px solid rgba(15, 23, 42, 0.08)"
      }}>
        <div style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "1rem 1.25rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap"
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: "1rem", color: "var(--text)" }}>WaBot API Docs</div>
            <div style={{ fontSize: "0.8rem", color: "var(--text3)" }}>Split deployment ready · Paystack billing · Rate-limited by plan</div>
          </div>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <Link to="/" className="btn btn-ghost btn-sm">Home</Link>
            <Link to="/signup" className="btn btn-primary btn-sm">Get API key</Link>
          </div>
        </div>
      </div>

      <div style={{
        maxWidth: "1200px",
        margin: "0 auto",
        padding: "2rem 1.25rem 4rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem"
      }}>
        <aside className="card">
          <div style={{ fontWeight: 700, marginBottom: "0.9rem" }}>On this page</div>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                style={{
                  color: "var(--text2)",
                  textDecoration: "none",
                  fontSize: "0.9rem",
                  padding: "0.35rem 0.7rem",
                  border: "1px solid var(--border)",
                  borderRadius: "999px"
                }}
              >
                {section.label}
              </a>
            ))}
          </div>
          <div style={{
            marginTop: "1rem",
            paddingTop: "1rem",
            borderTop: "1px solid var(--border)",
            fontSize: "0.82rem",
            color: "var(--text3)"
          }}>
            API base: <code>{searchBase}</code>
          </div>
        </aside>

        <main style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <section className="card" style={{
            padding: "1.5rem",
            background: "var(--card2)",
            color: "var(--text)",
            overflow: "hidden"
          }}>
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.4rem 0.75rem",
              borderRadius: "999px",
              background: "rgba(255,255,255,0.12)",
              fontSize: "0.8rem",
              marginBottom: "1rem"
            }}>
              <span>Developer API</span>
              <span>REST + API keys</span>
            </div>
            <h1 style={{ fontSize: "clamp(2rem, 3vw, 3rem)", lineHeight: 1.05, marginBottom: "0.85rem" }}>
              Ship WhatsApp automation without guessing the backend shape.
            </h1>
            <p style={{ maxWidth: "760px", color: "rgba(255,255,255,0.82)", lineHeight: 1.7 }}>
              Use your dashboard-generated API key to send messages, manage templates, inspect bot activity,
              and test webhooks. Free and Pro plans use the same API surface, with different rate and usage limits.
            </p>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "0.9rem",
              marginTop: "1.25rem"
            }}>
              {[
                { label: "Auth", value: "Bearer JWT or `wbk_` key" },
                { label: "Free", value: "30 req/min" },
                { label: "Pro", value: "300 req/min" },
                { label: "Billing", value: "Paystack · ₦1,500/mo" },
              ].map((item) => (
                <div key={item.label} style={{
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: "18px",
                  padding: "0.9rem",
                  background: "rgba(255,255,255,0.06)"
                }}>
                  <div style={{ fontSize: "0.76rem", color: "rgba(255,255,255,0.72)", marginBottom: "0.3rem" }}>{item.label}</div>
                  <div style={{ fontWeight: 700 }}>{item.value}</div>
                </div>
              ))}
            </div>
          </section>

          <div className="card" style={{ display: "grid", gap: "1.5rem" }}>
            <Section id="overview" title="Overview">
              <p>Base path: <code>{apiBase}/v1</code>. All developer endpoints live under `/api/v1` on the backend.</p>
              <p>Authentication accepts either a dashboard JWT for first-party usage or a generated API key that starts with <code>wbk_</code>.</p>
              <p>The frontend and backend can live on different servers. In production, set <code>VITE_API_BASE_URL</code> to your backend origin. If you omit <code>/api</code>, the frontend adds it automatically.</p>
            </Section>

            <Section id="auth" title="Authentication">
              <p>Header format: <code>Authorization: Bearer wbk_YOUR_API_KEY</code></p>
              <CodeBlock code={`Authorization: Bearer wbk_YOUR_API_KEY\nContent-Type: application/json`} />
              <p>Create, rotate, and revoke API keys from the dashboard under <strong>API Keys</strong>. Free users get 1 key; Pro users get 10.</p>
            </Section>

            <Section id="limits" title="Limits">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.9rem" }}>
                {RATE_LIMITS.map((item) => (
                  <div key={item.plan} style={{ border: "1px solid var(--border)", borderRadius: "18px", padding: "1rem" }}>
                    <div style={{ fontWeight: 800, marginBottom: "0.45rem" }}>{item.plan}</div>
                    <div>{item.calls}</div>
                    <div>{item.messages}</div>
                    <div>{item.keys}</div>
                  </div>
                ))}
              </div>
              <p>Broadcasts, AI configuration, and higher capacity limits require the Pro plan. Monthly message counters reset at the start of the next billing month.</p>
            </Section>

            <Section id="send" title="Send message">
              <p>POST <code>/v1/messages/send</code> sends a single WhatsApp message through one connected bot.</p>
              <CodeBlock code={snippets.curlSend} />
              <CodeBlock code={snippets.jsSend} />
              <p>The send API is intentionally flexible: you can use raw messages, reusable templates, or preset-specific endpoints for OTP, welcome, and form submission flows.</p>
            </Section>

            <Section id="presets" title="OTP / Forms / Welcome">
              <p>Use purpose-built endpoints when you want the API to format the outgoing WhatsApp message for a common workflow.</p>
              <p><code>POST /v1/messages/otp</code> formats one-time password messages with optional expiry information.</p>
              <CodeBlock code={snippets.otpSend} />
              <p><code>POST /v1/messages/form-submission</code> turns a submission object into a readable WhatsApp alert.</p>
              <CodeBlock code={snippets.formSend} />
              <p><code>POST /v1/messages/welcome</code> creates a lightweight welcome or acknowledgment message.</p>
              <CodeBlock code={snippets.welcomeSend} />
            </Section>

            <Section id="bots" title="Bots">
              <p>Use these endpoints to inspect and manage the bot layer behind your API usage.</p>
              <CodeBlock code={snippets.botsList} />
              <p>Useful endpoints:</p>
              <p><code>GET /v1/bots</code>, <code>GET /v1/bots/:id</code>, <code>GET /v1/bots/:id/stats</code>, <code>GET /v1/bots/:id/config</code>, <code>PATCH /v1/bots/:id/config</code></p>
            </Section>

            <Section id="templates" title="Templates">
              <p>Templates let you store reusable content and substitute variables at send time.</p>
              <CodeBlock code={snippets.templateSend} />
              <p>Supported endpoints: <code>GET /v1/templates</code>, <code>POST /v1/templates</code>, <code>PATCH /v1/templates/:id</code>, <code>DELETE /v1/templates/:id</code>.</p>
            </Section>

            <Section id="webhooks" title="Webhook test">
              <p>POST <code>/v1/webhooks/test</code> helps you verify outbound webhook reachability and signing before you trust production traffic.</p>
              <CodeBlock code={snippets.webhookTest} />
            </Section>

            <Section id="errors" title="Errors">
              <div style={{ display: "grid", gap: "0.8rem" }}>
                {[
                  ["401", "Missing, invalid, or expired token/API key."],
                  ["403", "Plan-gated feature such as broadcast or AI config."],
                  ["404", "Bot, template, or subscription resource not found."],
                  ["409", "Bot exists but is not connected yet."],
                  ["429", "Rate limit or monthly usage limit reached."],
                  ["503", "Billing provider is not configured on this backend."],
                ].map(([code, text]) => (
                  <div key={code} style={{
                    display: "grid",
                    gridTemplateColumns: "72px 1fr",
                    gap: "1rem",
                    border: "1px solid var(--border)",
                    borderRadius: "16px",
                    padding: "0.95rem"
                  }}>
                    <code style={{ fontWeight: 700 }}>{code}</code>
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        </main>
      </div>
    </div>
  );
}
