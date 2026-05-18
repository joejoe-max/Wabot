import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client.js";

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess(false);
    setLoading(true);

    try {
      await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSuccess(true);
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
            <div className="auth-title">Reset password</div>
            <div className="auth-subtitle">
              We'll send you a link to reset your password
            </div>
          </div>
        </div>

        <form className="auth-card" onSubmit={handleSubmit} noValidate>
          {error && <div className="alert alert-error">{error}</div>}
          {success && (
            <div className="alert alert-success" style={{ backgroundColor: "#d4edda", borderLeftColor: "#28a745", color: "#155724" }}>
              ✓ Password reset link sent! Check your email (including spam folder).
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              type="email"
              className="input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              disabled={success}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={loading || success}
          >
            {loading ? (
              <>
                <span className="spinner spinner-sm" /> Sending…
              </>
            ) : success ? (
              "Email sent ✓"
            ) : (
              "Send reset link"
            )}
          </button>
        </form>

        <div className="auth-footer">
          Remember your password? <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}