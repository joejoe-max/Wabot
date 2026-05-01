import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client.js";

export default function Signup() {
  const [form, setForm] = useState({ fullName: "", email: "", password: "" });
  const [msg, setMsg] = useState({ text: "", ok: false });
  const [loading, setLoading] = useState(false);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMsg({ text: "", ok: false });
    if (form.password.length < 8)
      return setMsg({ text: "Password must be at least 8 characters.", ok: false });
    setLoading(true);
    try {
      await apiFetch("/auth/signup", { method: "POST", body: JSON.stringify(form) });
      setMsg({ text: "Account created! Check your email to verify before logging in.", ok: true });
    } catch (err) {
      setMsg({ text: err.message, ok: false });
    } finally {
      setLoading(false);
    }
  };

  if (msg.ok) {
    return (
      <div className="auth-layout">
        <div className="auth-box">
          <div className="auth-header">
            <Link to="/" className="auth-logo-wrap">🤖</Link>
            <div>
              <div className="auth-title">Check your email</div>
              <div className="auth-subtitle">We sent a link to <strong>{form.email}</strong></div>
            </div>
          </div>
          <div className="auth-card" style={{ textAlign: "center", gap: "1.25rem" }}>
            <div style={{ fontSize: "2.75rem" }}>📬</div>
            <p className="text-muted text-sm">Click the link in the email to activate your account, then log in and start deploying bots.</p>
            <Link to="/login" className="btn btn-primary w-full">Go to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-layout">
      <div className="auth-box">
        <div className="auth-header">
          <Link to="/" className="auth-logo-wrap" title="Home">🤖</Link>
          <div>
            <div className="auth-title">Create your account</div>
            <div className="auth-subtitle">Free forever. No credit card required.</div>
          </div>
        </div>

        <form className="auth-card" onSubmit={handleSubmit} noValidate>
          {msg.text && <div className={`alert ${msg.ok ? "alert-success" : "alert-error"}`}>{msg.text}</div>}

          <div className="field">
            <label className="field-label" htmlFor="fullName">Full name</label>
            <input id="fullName" type="text" className="input" placeholder="Jane Smith"
              value={form.fullName} onChange={set("fullName")} autoComplete="name" />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="email">Email address</label>
            <input id="email" type="email" className="input" placeholder="you@example.com"
              value={form.email} onChange={set("email")} required autoComplete="email" />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="password">Password</label>
            <input id="password" type="password" className="input" placeholder="Min 8 chars, uppercase + number"
              value={form.password} onChange={set("password")} required autoComplete="new-password" />
            <span className="field-hint">At least 8 characters with uppercase letters and a number.</span>
          </div>

          <button type="submit" className="btn btn-primary w-full" disabled={loading} style={{ marginTop: "0.25rem" }}>
            {loading ? <><span className="spinner spinner-sm" /> Creating account…</> : "Create free account"}
          </button>
        </form>

        <div className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
