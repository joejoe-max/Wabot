import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

export default function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.email, password: form.password }),
      });
      auth.login(data.token, data.user);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-layout">
      <div className="auth-box">
        <div className="auth-header">
          <Link to="/" className="auth-logo-wrap" title="Home">🤖</Link>
          <div>
            <div className="auth-title">Welcome back</div>
            <div className="auth-subtitle">Sign in to your WaBot account</div>
          </div>
        </div>

        <form className="auth-card" onSubmit={handleSubmit} noValidate>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="field">
            <label className="field-label" htmlFor="email">Email address</label>
            <input id="email" type="email" className="input" placeholder="you@example.com"
              value={form.email} onChange={set("email")} required autoComplete="email" />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="password">Password</label>
            <input id="password" type="password" className="input" placeholder="••••••••"
              value={form.password} onChange={set("password")} required autoComplete="current-password" />
          </div>

          <button type="submit" className="btn btn-primary w-full" disabled={loading} style={{ marginTop: "0.25rem" }}>
            {loading ? <><span className="spinner spinner-sm" /> Signing in…</> : "Sign in"}
          </button>
        </form>

        <div className="auth-footer">
          Don't have an account? <Link to="/signup">Create one free</Link>
        </div>
      </div>
    </div>
  );
}
