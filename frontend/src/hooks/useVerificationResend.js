import { useCallback, useState } from "react";
import { apiFetch } from "../api/client.js";

export function useVerificationResend() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const resend = useCallback(async (email) => {
    setLoading(true);
    setError("");
    try {
      const normalized = String(email ?? "").trim();
      const data = await apiFetch("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: normalized }),
      });
      return data?.message ?? "Verification email resent.";
    } catch (err) {
      const msg = err?.message ?? "Could not resend verification email.";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { resend, loading, error };
}
