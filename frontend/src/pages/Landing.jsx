import { Link } from "react-router-dom";

const FEATURES = [
  { icon: "⚡", title: "Deploy in 60 seconds", desc: "Name your bot, scan the QR code on WhatsApp, and you're live instantly. Zero configuration." },
  { icon: "🔗", title: "Webhook events", desc: "Fire real-time HTTP webhooks to your server for every message, join, or leave event your bots receive." },
  { icon: "🤖", title: "Auto-reply rules", desc: "Set a smart auto-reply message per bot. Perfect for lead capture, support, and out-of-office replies." },
  { icon: "📊", title: "Live dashboard", desc: "Track message counts, bot status, activity logs, and uptime from one unified control panel." },
  { icon: "🔑", title: "API access", desc: "Generate API keys to manage your bots programmatically. Build custom workflows and integrations." },
  { icon: "🛡", title: "Secure by default", desc: "JWT auth, email verification, bcrypt, rate limiting, Helmet headers, and ownership checks throughout." },
  { icon: "📋", title: "Activity feed", desc: "Every deployment, scan, disconnect, and config change is timestamped and logged per bot." },
  { icon: "💳", title: "Simple pricing", desc: "Start free with 2 bots. Upgrade to Pro for 100 bots, priority support, and advanced features." },
];

const TERMINAL_LINES = [
  { ts: "10:42:01", text: "Initialising WaBot deployment...", cls: "" },
  { ts: "10:42:01", text: "Connecting to WhatsApp servers...", cls: "t-acc" },
  { ts: "10:42:02", text: "Generating QR payload...", cls: "" },
  { ts: "10:42:03", text: "✓ QR code ready — scan with WhatsApp", cls: "t-ok" },
  { ts: "10:42:14", text: "✓ Phone paired — session established", cls: "t-ok" },
  { ts: "10:42:14", text: "Bot 'sales-assistant' is now ACTIVE", cls: "t-ok" },
  { ts: "10:42:15", text: "Webhook URL: https://yourapp.com/hook", cls: "t-url" },
  { ts: "10:42:15", text: "Listening for messages...", cls: "t-dim" },
];

export default function Landing() {
  return (
    <div className="landing">
      <nav className="land-nav">
        <div className="land-logo">
          <div className="land-logo-icon">🤖</div>
          WaBot
        </div>
        <div className="land-nav-links">
          <a href="#features" className="land-nav-link">Features</a>
          <a href="#pricing"  className="land-nav-link">Pricing</a>
        </div>
        <div className="land-nav-actions">
          <Link to="/login"  className="btn btn-ghost btn-sm">Sign in</Link>
          <Link to="/signup" className="btn btn-primary btn-sm">Get started free</Link>
        </div>
      </nav>

      <section className="hero-section">
        <div className="hero-eyebrow">
          <span>🚀</span> WhatsApp automation, simplified
        </div>
        <h1 className="hero-h1">
          Deploy WhatsApp bots<br />
          <span className="accent-word">faster than ever.</span>
        </h1>
        <p className="hero-sub">
          WaBot is the all-in-one platform to launch, monitor, and scale your WhatsApp
          bots. Webhooks, auto-replies, and analytics included. Free to start.
        </p>
        <div className="hero-ctas">
          <Link to="/signup" className="btn btn-primary btn-xl">Get started free</Link>
          <a href="#pricing"  className="btn btn-ghost btn-xl">See plans</a>
        </div>

        <div className="terminal">
          <div className="terminal-bar">
            <div className="t-dots">
              <span className="t-dot t-r" /><span className="t-dot t-y" /><span className="t-dot t-g" />
            </div>
            <span className="terminal-title">wabot — deploy</span>
          </div>
          <div className="terminal-body">
            {TERMINAL_LINES.map((l, i) => (
              <div className="t-row" key={i}>
                <span className="t-ts">{l.ts}</span>
                <span className={`t-msg ${l.cls}`}>{l.text}</span>
              </div>
            ))}
            <div className="t-row">
              <span className="t-ts">10:42:16</span>
              <span className="t-msg t-dim">$ <span className="t-cursor" /></span>
            </div>
          </div>
        </div>
      </section>

      <section className="land-section" id="features">
        <div className="land-section-header">
          <div className="section-eyebrow">Features</div>
          <h2 className="section-h2">Everything you need to ship bots</h2>
          <p className="section-p">A complete platform from signup to scale — batteries included.</p>
        </div>
        <div className="features-grid">
          {FEATURES.map((f) => (
            <div className="feature-card" key={f.title}>
              <div className="feature-icon-wrap">{f.icon}</div>
              <div className="feature-title">{f.title}</div>
              <p className="feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="land-section" id="pricing">
        <div className="land-section-header">
          <div className="section-eyebrow">Pricing</div>
          <h2 className="section-h2">Simple, transparent pricing</h2>
          <p className="section-p">Start free. Upgrade when you need more power.</p>
        </div>
        <div className="pricing-grid">
          <div className="pricing-card">
            <div>
              <div className="pricing-name">Free</div>
              <div className="pricing-price">$0</div>
              <p className="pricing-desc" style={{ marginTop: "0.5rem" }}>Everything you need to get started.</p>
            </div>
            <div className="pricing-feats">
              {["Up to 2 bots", "QR-based deployment", "Webhooks per bot", "Activity feed", "API access", "Email support"].map((f) => (
                <div className="pricing-feat" key={f}><span className="pricing-feat-check">✓</span> {f}</div>
              ))}
            </div>
            <Link to="/signup" className="btn btn-secondary w-full">Start for free</Link>
          </div>

          <div className="pricing-card popular">
            <div className="pricing-tier-badge">Most popular</div>
            <div>
              <div className="pricing-name">Pro</div>
              <div className="pricing-price">$19<sub>/mo</sub></div>
              <p className="pricing-desc" style={{ marginTop: "0.5rem" }}>For teams and power users.</p>
            </div>
            <div className="pricing-feats">
              {["Up to 100 bots", "Everything in Free", "Priority support", "Stripe billing portal", "Early access to features"].map((f) => (
                <div className="pricing-feat" key={f}><span className="pricing-feat-check">✓</span> {f}</div>
              ))}
            </div>
            <Link to="/signup" className="btn btn-primary w-full">Get started</Link>
          </div>
        </div>
      </section>

      <footer className="land-footer">
        <div className="land-footer-logo"><span>🤖</span> WaBot</div>
        <span>© {new Date().getFullYear()} WaBot. All rights reserved.</span>
        <span>Built for WhatsApp automation.</span>
      </footer>
    </div>
  );
}
