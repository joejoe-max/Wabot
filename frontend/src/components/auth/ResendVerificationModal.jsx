import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal.jsx";
import { Alert } from "../ui/Alert.jsx";
import { useVerificationResend } from "../../hooks/useVerificationResend.js";
import { Spinner } from "../ui/Spinner.jsx";

export function ResendVerificationModal({ open, email, onClose, onResent }) {
  const { resend, loading, error } = useVerificationResend();
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    if (!open) {
      setSuccessMsg("");
    }
  }, [open]);

  const normalizedEmail = useMemo(() => String(email ?? "").trim(), [email]);

  const handleResend = async () => {
    setSuccessMsg("");
    try {
      const msg = await resend(normalizedEmail);
      setSuccessMsg(msg ?? "Verification email resent. Please check your inbox.");
      onResent?.();
    } catch {
      /* error is handled by hook state */
    }
  };

  return (
    <Modal onClose={onClose} wide={false}>
      <div style={{ width: "100%" }}>
        <div className="section-heading" style={{ marginBottom: "0.5rem" }}>
          <span>Verify your email</span>
        </div>
        <p style={{ color: "var(--text2)", fontSize: "0.875rem", marginBottom: "1rem", lineHeight: 1.6 }}>
          {normalizedEmail
            ? (
              <>
                We’ll resend a verification email to <strong>{normalizedEmail}</strong>.
              </>
            )
            : "We’ll resend a verification email to the address on your account."}
        </p>

        {successMsg && <Alert type="success">{successMsg}</Alert>}
        {error && <Alert type="error">{error}</Alert>}

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.25rem", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={handleResend} disabled={loading}>
            {loading ? <><Spinner size="sm" /> Resending…</> : "Resend email"}
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            Close
          </button>
        </div>

        <div style={{ marginTop: "0.75rem", fontSize: "0.8rem", color: "var(--text3)", lineHeight: 1.5 }}>
          If you still don’t see the email, check your spam folder or request another resend after a minute.
        </div>
      </div>
    </Modal>
  );
}
